import {
  CanvasTexture,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  type MeshStandardMaterial,
  type Texture,
} from 'three';

import { Rng } from '@core/rng';
import { makeNoise, fbm, normalMapFrom } from './textureBaker';

/**
 * The close-up detail layer: what a surface looks like at the camera's nearest
 * zoom.
 *
 * ## Why the ground went to mush up close
 *
 * The camera zooms from a whole city down to a view four metres tall — about
 * eighty screen pixels per world unit. The surface textures were baked at 12 to
 * 20 texels per unit, because that is what the play zoom needs and a larger
 * canvas costs startup time. Magnified four to seven times, every noise cell of
 * the asphalt aggregate became a soft blob fifteen pixels across: the "huge
 * grain" a player saw on the road, the footway and the grass alike. A bigger
 * macro texture only moves the problem one zoom step further in.
 *
 * ## What this does instead
 *
 * A second, SMALL texture is baked per material family - stones in a binder for
 * asphalt, pores and sand for concrete, blades for grass - covering only a
 * couple of metres at well over a hundred texels per unit. The shader samples it
 * twice, at two scales and two rotations, and multiplies the two, so the tile
 * has no visible period. It modulates the albedo around 1.0 and adds its own
 * normal on top of the macro normal.
 *
 * It fades in by the pixel FOOTPRINT (`fwidth` of the world position), not by a
 * zoom threshold, so it is exact on any screen: at play zoom it contributes
 * nothing and costs two texture reads; at close zoom it carries all of the
 * fine structure. As it fades in, the macro map is read one or two mip levels
 * softer, which removes the magnified blobs instead of drawing crisp grain on
 * top of them.
 */

export type DetailKind = 'asphalt' | 'concrete' | 'grass' | 'soil';

export interface DetailTextures {
  readonly map: Texture;
  readonly normalMap: Texture;
  /** World units one tile covers. */
  readonly worldSize: number;
}

const SIZE = 512;
const cache = new Map<DetailKind, DetailTextures>();

/** Adds a soft round mark into a wrapped float field. */
function stamp(
  field: Float32Array,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  angle: number,
  value: number,
  mode: 'max' | 'add',
): void {
  const reach = Math.ceil(Math.max(rx, ry)) + 1;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const px = dx + (cx - Math.floor(cx));
      const py = dy + (cy - Math.floor(cy));
      const u = (px * cos + py * sin) / rx;
      const v = (-px * sin + py * cos) / ry;
      const d = u * u + v * v;
      if (d >= 1) continue;
      const x = (((Math.floor(cx) + dx) % SIZE) + SIZE) % SIZE;
      const y = (((Math.floor(cy) + dy) % SIZE) + SIZE) % SIZE;
      const i = y * SIZE + x;
      // A dome, so a stone has a rounded top in the normal map.
      const h = Math.sqrt(1 - d) * value;
      if (mode === 'max') field[i] = Math.max(field[i] as number, h);
      else field[i] = (field[i] as number) + h;
    }
  }
}

/** Draws a thin tapered stroke - one grass blade seen from above. */
function blade(
  field: Float32Array,
  tone: Float32Array,
  x: number,
  y: number,
  angle: number,
  length: number,
  width: number,
  shade: number,
): void {
  const steps = Math.ceil(length);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const half = width * (1 - t * 0.85);
    const cx = x + dx * s;
    const cy = y + dy * s;
    const reach = Math.ceil(half);
    for (let oy = -reach; oy <= reach; oy++) {
      for (let ox = -reach; ox <= reach; ox++) {
        if (ox * ox + oy * oy > half * half + 0.25) continue;
        const px = (((Math.round(cx) + ox) % SIZE) + SIZE) % SIZE;
        const py = (((Math.round(cy) + oy) % SIZE) + SIZE) % SIZE;
        const i = py * SIZE + px;
        // Later blades lie on top of earlier ones, and a blade is higher at
        // its tip than at its root, which is what gives the field depth.
        const h = 0.35 + t * 0.65;
        if (h >= (field[i] as number)) {
          field[i] = h;
          tone[i] = shade * (0.78 + t * 0.34);
        }
      }
    }
  }
}

/**
 * Bakes one detail family. Everything is deterministic and wraps at the edge,
 * so the tile is seamless by construction.
 */
function bake(kind: DetailKind): { albedo: Float32Array; tint: Float32Array[]; height: Float32Array; worldSize: number; relief: number } {
  const n = SIZE * SIZE;
  const height = new Float32Array(n);
  const albedo = new Float32Array(n).fill(1);
  const rng = new Rng(0xde7a11 ^ kind.length * 7919);

  if (kind === 'asphalt') {
    // Aggregate: a dark bitumen binder, packed with stones of 2 to 14 mm in a
    // spread of greys, a few of them pale quartz. At 3.2 units the tile is
    // 1.28 m and a texel is 2.5 mm.
    const binder = makeNoise(0x3a91);
    for (let i = 0; i < n; i++) {
      const x = i % SIZE;
      const y = (i / SIZE) | 0;
      albedo[i] = 0.8 + fbm(binder, (x / SIZE) * 64, (y / SIZE) * 64, 64, 2) * 0.1;
      height[i] = 0.05;
    }
    const stones = new Float32Array(n);
    const stoneTone = new Float32Array(n);
    // A FINE, worn surfacing course: stones mostly 2 to 8 mm, their tones
    // close to the binder's once traffic has dulled them, pale quartz rare.
    // The old spread (tones 0.85 to 2.15 against a binder of 0.62) read as
    // loose gravel at close zoom.
    for (let k = 0; k < 7800; k++) {
      const x = rng.float() * SIZE;
      const y = rng.float() * SIZE;
      const r = 1.0 + rng.float() ** 2.4 * 3.4;
      const tone = rng.float() < 0.03 ? 1.3 + rng.float() * 0.15 : 0.92 + rng.float() * 0.26;
      const rx = r * (0.8 + rng.float() * 0.4);
      const ry = r * (0.7 + rng.float() * 0.3);
      const angle = rng.float() * Math.PI;
      // Paint the tone where this stone is now the highest thing.
      const reach = Math.ceil(Math.max(rx, ry)) + 1;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const u = (dx * cos + dy * sin) / rx;
          const v = (-dx * sin + dy * cos) / ry;
          const d = u * u + v * v;
          if (d >= 1) continue;
          const px = (((Math.floor(x) + dx) % SIZE) + SIZE) % SIZE;
          const py = (((Math.floor(y) + dy) % SIZE) + SIZE) % SIZE;
          const i = py * SIZE + px;
          const h = 0.25 + Math.sqrt(1 - d) * 0.75 * Math.min(1, r / 4);
          if (h > (stones[i] as number)) {
            stones[i] = h;
            stoneTone[i] = tone * (0.86 + Math.sqrt(1 - d) * 0.2);
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if ((stones[i] as number) > 0) {
        albedo[i] = stoneTone[i] as number;
        height[i] = stones[i] as number;
      }
    }
    return { albedo, tint: [], height, worldSize: 3.2, relief: 3.2 };
  }

  if (kind === 'concrete') {
    // Broom-finished concrete: fine sand, the odd exposed pebble, and pin-hole
    // pores that catch dirt. Tile 2.6 units, about a metre.
    const sand = makeNoise(0x1c07);
    const cloud = makeNoise(0x88e1);
    for (let i = 0; i < n; i++) {
      const x = i % SIZE;
      const y = (i / SIZE) | 0;
      const fine = fbm(sand, (x / SIZE) * 180, (y / SIZE) * 180, 180, 2);
      const soft = fbm(cloud, (x / SIZE) * 12, (y / SIZE) * 12, 12, 3);
      albedo[i] = 0.9 + (fine - 0.5) * 0.22 + (soft - 0.5) * 0.12;
      height[i] = 0.5 + (fine - 0.5) * 0.35;
    }
    const pebbles = new Float32Array(n);
    for (let k = 0; k < 900; k++) {
      stamp(pebbles, rng.float() * SIZE, rng.float() * SIZE, 1 + rng.float() * 2.4, 1 + rng.float() * 2, rng.float() * 3, 0.5, 'max');
    }
    for (let k = 0; k < 1400; k++) {
      const x = Math.floor(rng.float() * SIZE);
      const y = Math.floor(rng.float() * SIZE);
      const i = y * SIZE + x;
      albedo[i] = 0.55;
      height[i] = 0.15;
    }
    for (let i = 0; i < n; i++) {
      const p = pebbles[i] as number;
      if (p > 0) {
        albedo[i] = (albedo[i] as number) * (0.92 + p * 0.3);
        height[i] = (height[i] as number) + p * 0.6;
      }
    }
    return { albedo, tint: [], height, worldSize: 2.6, relief: 2.4 };
  }

  if (kind === 'grass') {
    // Blades seen from above, in every direction, darker at the root. The
    // tone is carried per texel so a blade reads as one stroke. Tile 4 units.
    const tone = new Float32Array(n).fill(0.55);
    height.fill(0);
    const soil = makeNoise(0x4411);
    for (let i = 0; i < n; i++) {
      const x = i % SIZE;
      const y = (i / SIZE) | 0;
      tone[i] = 0.38 + fbm(soil, (x / SIZE) * 40, (y / SIZE) * 40, 40, 2) * 0.2;
    }
    for (let k = 0; k < 9000; k++) {
      blade(
        height,
        tone,
        rng.float() * SIZE,
        rng.float() * SIZE,
        rng.float() * Math.PI * 2,
        9 + rng.float() * 22,
        0.9 + rng.float() * 1.1,
        0.85 + rng.float() * 0.5,
      );
    }
    // Carried in the tint channels: blades are yellow-green, the gaps between
    // them are a darker, warmer green-brown.
    const r = new Float32Array(n);
    const g = new Float32Array(n);
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = tone[i] as number;
      const lift = height[i] as number;
      r[i] = t * (0.92 + lift * 0.12);
      g[i] = t * (1.02 + lift * 0.1);
      b[i] = t * (0.82 + lift * 0.02);
      albedo[i] = t;
    }
    return { albedo, tint: [r, g, b], height, worldSize: 4, relief: 3.6 };
  }

  // soil: dirt with crumbs and small stones, for bare ground and rock.
  const crumb = makeNoise(0x9d02);
  for (let i = 0; i < n; i++) {
    const x = i % SIZE;
    const y = (i / SIZE) | 0;
    const fine = fbm(crumb, (x / SIZE) * 120, (y / SIZE) * 120, 120, 3);
    albedo[i] = 0.82 + (fine - 0.5) * 0.4;
    height[i] = fine * 0.6;
  }
  const grit = new Float32Array(n);
  for (let k = 0; k < 1800; k++) {
    stamp(grit, rng.float() * SIZE, rng.float() * SIZE, 1.2 + rng.float() * 3.5, 1 + rng.float() * 3, rng.float() * 3, 1, 'max');
  }
  for (let i = 0; i < n; i++) {
    const p = grit[i] as number;
    if (p > 0) {
      albedo[i] = (albedo[i] as number) * (0.95 + p * 0.35);
      height[i] = (height[i] as number) + p * 0.7;
    }
  }
  return { albedo, tint: [], height, worldSize: 3, relief: 3 };
}

function dataTexture(canvas: HTMLCanvasElement, anisotropy: number): Texture {
  const texture = new CanvasTexture(canvas);
  // Linear DATA: the albedo is a multiplier around 1.0, not a colour, so it
  // must not go through the sRGB decode.
  texture.colorSpace = NoColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The detail textures for one family, baked once and cached.
 *
 * The albedo is stored as a multiplier divided by two (so 0.5 means "unchanged")
 * and normalised to that mean, so a material's overall tone is exactly what its
 * macro texture says it is, at every zoom.
 */
export function detailTextures(kind: DetailKind, anisotropy: number): DetailTextures {
  const cached = cache.get(kind);
  if (cached) return cached;

  const baked = bake(kind);
  const n = SIZE * SIZE;
  const channels = baked.tint.length === 3 ? baked.tint : [baked.albedo, baked.albedo, baked.albedo];
  const means = channels.map((channel) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += channel[i] as number;
    return sum / n;
  });

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const image = ctx.createImageData(SIZE, SIZE);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const value = ((channels[c] as Float32Array)[i] as number) / (means[c] as number);
        image.data[i * 4 + c] = Math.round(Math.min(1, Math.max(0, value * 0.5)) * 255);
      }
      image.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }

  const textures: DetailTextures = {
    map: dataTexture(canvas, anisotropy),
    normalMap: dataTexture(normalMapFrom(baked.height, SIZE, baked.relief), anisotropy),
    worldSize: baked.worldSize,
  };
  cache.set(kind, textures);
  return textures;
}

export function disposeDetailTextures(): void {
  for (const textures of cache.values()) {
    textures.map.dispose();
    textures.normalMap.dispose();
  }
  cache.clear();
}

/** The shared on/off switch, so a low tier pays nothing but a uniform read. */
export const detailSwitch = { value: 1 };

/**
 * GLSL for sampling a detail layer. `detailSample` returns the albedo
 * multiplier in rgb, and `detailNormal` the tangent-space normal, both
 * already combined from two rotated scales.
 */
export const DETAIL_GLSL = /* glsl */ `
  uniform float uDetailOn;
  // World units per pixel below which detail is fully shown, and above which
  // it is gone.
  const float DETAIL_NEAR = 0.045;
  const float DETAIL_FAR = 0.16;
  const mat2 DETAIL_TURN = mat2(0.5403, 0.8415, -0.8415, 0.5403);

  float detailWeight(vec2 worldUv) {
    vec2 footprint = fwidth(worldUv);
    float perPixel = max(footprint.x, footprint.y);
    return uDetailOn * (1.0 - smoothstep(DETAIL_NEAR, DETAIL_FAR, perPixel));
  }
  vec3 detailSample(sampler2D tex, vec2 uv) {
    vec3 a = texture2D(tex, uv).rgb * 2.0;
    vec3 b = texture2D(tex, DETAIL_TURN * uv * 0.4137 + 0.31).rgb * 2.0;
    return a * mix(vec3(1.0), b, 0.55);
  }
  vec3 detailNormal(sampler2D tex, vec2 uv) {
    vec3 a = texture2D(tex, uv).xyz * 2.0 - 1.0;
    vec3 b = texture2D(tex, DETAIL_TURN * uv * 0.4137 + 0.31).xyz * 2.0 - 1.0;
    // The second sample was read through a rotation, so its slope is rotated
    // back into the first one's frame before the two are added.
    b.xy = b.xy * DETAIL_TURN;
    return vec3(a.xy + b.xy * 0.55, a.z);
  }
`;

export interface DetailSpec {
  readonly kind: DetailKind;
  /** World units one tile of the MACRO map covers - how the mesh UVs are scaled. */
  readonly macroTile: number;
  /** How hard the detail albedo modulates, 0..1. */
  readonly albedo: number;
  /** Strength of the detail normal. */
  readonly normal: number;
  /** Mip bias applied to the macro maps at full detail, to soften magnified grain. */
  readonly macroBlur: number;
}

/**
 * Installs the detail layer on a standard material whose UVs are in macro
 * tiles (`world / macroTile`), which is how every road band is built.
 */
export function applyDetail(material: MeshStandardMaterial, spec: DetailSpec, anisotropy: number): void {
  const textures = detailTextures(spec.kind, anisotropy);
  const uniforms = {
    uDetailOn: detailSwitch,
    uDetailMap: { value: textures.map },
    uDetailNormal: { value: textures.normalMap },
    uDetailRepeat: { value: spec.macroTile / textures.worldSize },
    uMacroTile: { value: spec.macroTile },
    uDetailAlbedo: { value: spec.albedo },
    uDetailNormalScale: { value: spec.normal },
    uMacroBlur: { value: spec.macroBlur },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D uDetailMap;
         uniform sampler2D uDetailNormal;
         uniform float uDetailRepeat;
         uniform float uMacroTile;
         uniform float uDetailAlbedo;
         uniform float uDetailNormalScale;
         uniform float uMacroBlur;
         ${DETAIL_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `float detailW = detailWeight(vMapUv * uMacroTile);
         vec2 detailUv = vMapUv * uDetailRepeat;
         vec4 sampledDiffuseColor = texture2D(map, vMapUv, detailW * uMacroBlur);
         vec3 detailAlbedo = detailSample(uDetailMap, detailUv);
         sampledDiffuseColor.rgb *= mix(vec3(1.0), detailAlbedo, detailW * uDetailAlbedo);
         diffuseColor *= sampledDiffuseColor;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 mapN = texture2D(normalMap, vNormalMapUv, detailW * uMacroBlur).xyz * 2.0 - 1.0;
         mapN.xy *= normalScale;
         vec3 fineN = detailNormal(uDetailNormal, detailUv);
         mapN.xy += fineN.xy * uDetailNormalScale * detailW;
         normal = normalize(tbn * mapN);`,
      );
  };
  material.customProgramCacheKey = () => `detail-${spec.kind}`;
}
