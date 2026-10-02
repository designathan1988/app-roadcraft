import { CanvasTexture, Color, DataTexture, ShaderChunk, SRGBColorSpace, TextureLoader, type BufferGeometry, type MeshStandardMaterial, type Texture } from 'three';
import type { PersonSpec } from '@people/spec';
import { loadProxyItem, proxyUrl, type ProxyItem } from '@people/body/proxy';
import { MAX_TEXTURED, texturedGarments } from './garmentSlots';
import { queueUpload } from '../uploads';
import index from '../../../public/models/people/skins/index.json';
const urls = import.meta.glob('../../../public/models/people/skins/*.webp', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

export interface SkinAppearance { texture: Texture; tint: Color; hair: Color; hairTexture?: Texture; browTexture?: Texture; lashTexture?: Texture; beardTexture?: Texture; garments: (Texture | null)[]; outfitTint: Color | null; beard: number; makeup: number }

/** Existing CC0 skin pack, selected by the authored body; no new asset downloads. */
export async function loadSkinAppearance(person: PersonSpec): Promise<SkinAppearance> {
  const b = person.body;
  const origin = b.african > b.asian && b.african > b.caucasian ? 'african'
    : b.asian > b.caucasian ? 'asian' : 'caucasian';
  const age = b.age > 0.8 ? 'old' : b.age > 0.6 ? 'middleage' : 'young';
  const sex = b.gender < 0.5 ? 'female' : 'male';
  // Each person their own skin among those of their origin, sex and age (the
  // system pack had one per kind, so a street of one face), and a made-up
  // face for the women who wear make-up.
  type Skin = (typeof index.skins)[number] & { makeup?: boolean };
  const skins = index.skins as Skin[];
  const madeUp = sex === 'female' && (person.look.makeup ?? 0) > 0;
  const fits = (s: Skin): boolean => s.origin === origin && s.sex === sex && !!s.makeup === madeUp;
  const pool = skins.filter(s => fits(s) && s.age === age);
  const candidates = pool.length ? pool : skins.filter(fits).length ? skins.filter(fits)
    : skins.filter(s => s.origin === origin && s.sex === sex && !s.makeup);
  const skin = candidates[Math.abs(person.id * 2654435761 >>> 0) % candidates.length] ?? index.skins[0]!;
  const url = urls[`../../../public/models/people/skins/${skin.name}.webp`];
  if (!url) throw new Error(`Missing skin texture: ${skin.name}`);
  const texture = await new TextureLoader().loadAsync(url);
  texture.colorSpace = SRGBColorSpace;
  const average = new Color().setRGB(skin.average[0]! / 255, skin.average[1]! / 255, skin.average[2]! / 255, SRGBColorSpace);
  const desired = new Color(person.look.skin);
  // Match the texture's brightness to the person's skin and only a little of
  // its hue: the texture, chosen by origin, carries a natural hue of its own.
  // Scaling each channel to the target turned a rosy (made-up) texture green.
  const lum = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const bright = lum(desired) / Math.max(0.01, lum(average));
  const hue = 0.3;
  const tint = new Color().setRGB(
    bright + (desired.r / Math.max(0.01, average.r) - bright) * hue,
    bright + (desired.g / Math.max(0.01, average.g) - bright) * hue,
    bright + (desired.b / Math.max(0.01, average.b) - bright) * hue);
  let hairTexture: Texture | undefined;
  const garments = await Promise.all(texturedGarments(person.look).map(async name => {
    if (!name || name === 'none') return null;
    const item = await loadProxyItem(name);
    if (!item.textureFile) return null;
    return paddedGarment(name, item);
  }));
  // Every card item - hair, brows, lashes, a beard - with its own texture,
  // so its strands are drawn per pixel.
  const cardTexture = async (name: string | undefined): Promise<Texture | undefined> => {
    if (!name || name === 'none') return undefined;
    const item = await loadProxyItem(name);
    if (!item.textureFile) return undefined;
    const map = await new TextureLoader().loadAsync(proxyUrl(item.textureFile));
    map.colorSpace = SRGBColorSpace;
    map.flipY = false;
    return map;
  };
  hairTexture = await cardTexture(person.look.hairCut);
  const browTexture = await cardTexture(person.look.brows);
  const lashTexture = await cardTexture(person.look.lashes);
  const beardName = (person.look.extras ?? []).find((e) => /beard|moustache|goatee|stubble|sideburn/i.test(e));
  const beardTexture = await cardTexture(beardName);
  // Sent to the GPU ahead of the first frame this person is drawn in.
  queueUpload(texture, ...garments, hairTexture, browTexture, lashTexture, beardTexture);
  return { texture, tint, hair: new Color(person.look.hair), garments,
    outfitTint: person.look.outfitTint == null ? null : new Color(person.look.outfitTint),
    ...(hairTexture ? { hairTexture } : {}),
    ...(browTexture ? { browTexture } : {}),
    ...(lashTexture ? { lashTexture } : {}),
    ...(beardTexture ? { beardTexture } : {}),
    beard: ['none', 'stubble', 'moustache', 'beard'].indexOf(person.look.beard ?? 'none'), makeup: person.look.makeup ?? 0 };
}

/** Extends the crowd shader after its bone-palette hook, preserving one draw batch. */
export function applySkinAppearance(material: MeshStandardMaterial, geometry: BufferGeometry, skin: SkinAppearance): void {
  if (!geometry.hasAttribute('skinMask')) return;
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  const detail = { value: 1 };
  material.userData['appearanceDetail'] = detail;
  // ONE shader program for every dressed person: the same samplers and the
  // same code whoever wears what, a blank texture where a slot is empty and
  // flags where a card has no texture of its own. Keyed on what each person
  // wore, a new mix of garments compiled a new program the moment its
  // wearer came into view: a 50-200 ms hitch each time.
  const texturedHair = geometry.hasAttribute('hairMask');
  const texturedGarments = geometry.hasAttribute('garmentSlot');
  if (texturedHair) { material.alphaToCoverage = true; material.alphaTest = 0.35; }
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.personSkin = { value: skin.texture };
    shader.uniforms.appearanceDetail = detail;
    shader.uniforms.personSkinTint = { value: skin.tint };
    shader.uniforms.faceOrigin = { value: geometry.userData['faceOrigin'] };
    shader.uniforms.faceScale = { value: geometry.userData['faceScale'] ?? 0.2 };
    shader.uniforms.beardColour = { value: skin.hair };
    shader.uniforms.beardStyle = { value: skin.beard };
    shader.uniforms.makeupAmount = { value: skin.makeup };
    if (texturedGarments) {
      shader.uniforms.outfitDye = { value: skin.outfitTint ?? new Color(0xffffff) };
      shader.uniforms.outfitDyed = { value: skin.outfitTint ? 1 : 0 };
      for (let i = 0; i < GARMENT_SLOTS; i++) shader.uniforms[`garment${i}`] = { value: skin.garments[i] ?? blank() };
    }
    if (texturedHair) {
      shader.uniforms.personHair = { value: skin.hairTexture ?? blank() };
      shader.uniforms.personBrow = { value: skin.browTexture ?? blank() };
      shader.uniforms.personLash = { value: skin.lashTexture ?? blank() };
      shader.uniforms.personBeard = { value: skin.beardTexture ?? blank() };
      shader.uniforms.cardTextures = { value: [skin.hairTexture, skin.browTexture, skin.lashTexture, skin.beardTexture].map((t) => (t ? 1 : 0)) };
    }
    shader.vertexShader = `attribute float skinMask; uniform vec3 faceOrigin; uniform float faceScale; varying float vSkinMask; varying vec2 vSkinUv; varying vec3 vFace;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkinMask = skinMask; vSkinUv = uv; vFace = (position - faceOrigin) / faceScale;');
    shader.fragmentShader = `uniform float appearanceDetail; uniform sampler2D personSkin; uniform vec3 personSkinTint; uniform vec3 beardColour; uniform float beardStyle; uniform float makeupAmount; varying float vSkinMask; varying vec2 vSkinUv; varying vec3 vFace;\n${shader.fragmentShader}`
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (appearanceDetail > 0.5 && vSkinMask > 0.0) {
        vec3 skinColour = texture2D(personSkin, vSkinUv).rgb * personSkinTint;
        float front = smoothstep(-0.12, 0.02, vFace.z);
        float lips = (1.0 - smoothstep(0.65, 1.0, length(vFace.xy / vec2(0.22, 0.045)))) * front;
        float cheeks = exp(-30.0 * (pow(abs(vFace.x) - 0.32, 2.0) + pow(vFace.y - 0.18, 2.0))) * front;
        skinColour = mix(skinColour, skinColour * vec3(1.05, 0.55, 0.6), makeupAmount * max(lips, cheeks * 0.25));
        // Beards are fitted MakeHuman items now (wornItems), not paint: a
        // painted stubble region missed the jaw and lay across the nose as a
        // dark mask.
        diffuseColor.rgb = mix(diffuseColor.rgb, skinColour, vSkinMask);
        }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.5, vSkinMask * appearanceDetail);');
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>',
      ShaderChunk.lights_physical_pars_fragment.replace(
        'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );',
        'reflectedLight.directDiffuse += mix(irradiance, saturate((dot(geometryNormal, directLight.direction) + 0.15) / 1.15) * directLight.color, vSkinMask * appearanceDetail) * BRDF_Lambert(material.diffuseColor);'));
    if (texturedHair) {
      shader.vertexShader = `attribute float hairMask; varying float vHairMask;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHairMask = hairMask;');
      shader.fragmentShader = `uniform sampler2D personHair; uniform sampler2D personBrow; uniform sampler2D personLash; uniform sampler2D personBeard; uniform float cardTextures[4]; varying float vHairMask;\n${shader.fragmentShader}`
        .replace('#include <alphatest_fragment>', `
          // A card: hair (1), brows (2), lashes (3) or a beard (4), each from its
          // own texture. The strands take the person's hair colour, shaded by
          // the texture's own light and dark; where the card fades out its
          // colour stays the hair's, not the texture's white backing (the white
          // fringe round every head of hair).
          if (vHairMask > 0.5 && appearanceDetail > 0.5) {
            vec4 cardTexel = vec4(0.0);
            float slot = floor(vHairMask + 0.5);
            if (slot < 1.5) { cardTexel = cardTextures[0] > 0.5 ? texture2D(personHair, vSkinUv) : vec4(0.5, 0.5, 0.5, 1.0); }
            else if (slot < 2.5) { cardTexel = cardTextures[1] > 0.5 ? texture2D(personBrow, vSkinUv) : vec4(0.5, 0.5, 0.5, 1.0); }
            else if (slot < 3.5) { cardTexel = cardTextures[2] > 0.5 ? texture2D(personLash, vSkinUv) : vec4(0.2, 0.2, 0.2, 1.0); }
            else { cardTexel = cardTextures[3] > 0.5 ? texture2D(personBeard, vSkinUv) : vec4(0.5, 0.5, 0.5, 1.0); }
            float strand = dot(cardTexel.rgb, vec3(0.3, 0.59, 0.11));
            vec3 hairCol = slot > 2.5 && slot < 3.5 ? vec3(0.03) : beardColour * (0.55 + 0.95 * strand);
            diffuseColor.rgb = mix(beardColour * 0.55, hairCol, smoothstep(0.25, 0.75, cardTexel.a));
            diffuseColor.a = cardTexel.a;
          }
          #include <alphatest_fragment>`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (vHairMask > 0.5) roughnessFactor = 0.42;');
    }
    if (texturedGarments) {
      shader.vertexShader = `attribute float garmentSlot; varying float vGarmentSlot;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGarmentSlot = garmentSlot;');
      const uniforms = Array.from({ length: GARMENT_SLOTS }, (_, i) => `uniform sampler2D garment${i};`).join('\n');
      shader.fragmentShader = `uniform vec3 outfitDye; uniform float outfitDyed; varying float vGarmentSlot; ${uniforms}\n${shader.fragmentShader}`;
      const sample = Array.from({ length: GARMENT_SLOTS }, (_, i) => `
        if (appearanceDetail > 0.5 && abs(vGarmentSlot - ${i + 1}.0) < 0.1) {
          vec3 cloth = texture2D(garment${i}, vSkinUv).rgb;
          ${i === 0 ? 'float shade = 0.3 + 1.15 * dot(cloth, vec3(0.3, 0.59, 0.11)); cloth = mix(cloth, min(vec3(1.0), outfitDye * shade), outfitDyed * 0.8);' : ''}
          diffuseColor.rgb = cloth;
        }`).join('\n');
      shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `${sample}\n#include <alphatest_fragment>`);
    }
  };
  material.customProgramCacheKey = () => `${key}-textured-skin-v3-hair${texturedHair}-garments${texturedGarments}`;
}

/** How far each island of a garment's texture is grown into its background, pixels. */
const GARMENT_PAD = 12;
const PADDED = new Map<string, Promise<Texture>>();

/**
 * A garment's texture with every UV island grown outward into the background
 * (texture padding, as every game asset pipeline does). Unpadded, the smaller
 * mip levels mixed each island with the background and with its neighbours
 * on the sheet, and every seam - the shoulder of every shirt - was drawn as a
 * brown line. The islands are the garment's own UV triangles, rasterised.
 */
function paddedGarment(name: string, item: ProxyItem): Promise<Texture> {
  let made = PADDED.get(name);
  if (!made) {
    made = (async () => {
      const url = proxyUrl(item.textureFile!);
      const plain = async (): Promise<Texture> => {
        const map = await new TextureLoader().loadAsync(url);
        map.colorSpace = SRGBColorSpace; map.flipY = false;
        return map;
      };
      const uvs = item.pack.uvs;
      if (!uvs || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return plain();
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const W = bitmap.width, H = bitmap.height;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return plain();
      ctx.drawImage(bitmap, 0, 0);
      const image = ctx.getImageData(0, 0, W, H);
      const px = image.data;
      // The islands: every UV triangle, a little fat so its edge pixels count.
      const inside = new Uint8Array(W * H);
      const idx = item.pack.index;
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const a = idx[i]!, b = idx[i + 1]!, c = idx[i + 2]!;
        const ax = uvs[a * 2]! * W, ay = uvs[a * 2 + 1]! * H;
        const bx = uvs[b * 2]! * W, by = uvs[b * 2 + 1]! * H;
        const cx = uvs[c * 2]! * W, cy = uvs[c * 2 + 1]! * H;
        const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (Math.abs(area) < 1e-9) continue;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)) - 1), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)) + 1);
        const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)) - 1), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)) + 1);
        const slack = 0.75 * Math.abs(area) / Math.max(Math.hypot(bx - ax, by - ay), Math.hypot(cx - bx, cy - by), Math.hypot(ax - cx, ay - cy));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const px0 = x + 0.5, py0 = y + 0.5;
            const w0 = ((bx - px0) * (cy - py0) - (by - py0) * (cx - px0)) / area;
            const w1 = ((cx - px0) * (ay - py0) - (cy - py0) * (ax - px0)) / area;
            const w2 = 1 - w0 - w1;
            const tol = slack / Math.abs(area);
            if (w0 >= -tol && w1 >= -tol && w2 >= -tol) inside[y * W + x] = 1;
          }
        }
      }
      // Grow the islands a ring at a time: each new pixel the mean of its
      // neighbours already inside.
      let ring: number[] = [];
      for (let p = 0; p < W * H; p++) if (inside[p]) ring.push(p);
      for (let step = 0; step < GARMENT_PAD && ring.length; step++) {
        const next: number[] = [];
        for (const p of ring) {
          const x = p % W, y = (p - x) / W;
          for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
            if (q < 0 || inside[q]) continue;
            let r = 0, g = 0, bl = 0, n = 0;
            const qx = q % W, qy = (q - qx) / W;
            for (const o of [qx > 0 ? q - 1 : -1, qx < W - 1 ? q + 1 : -1, qy > 0 ? q - W : -1, qy < H - 1 ? q + W : -1]) {
              if (o < 0 || !inside[o]) continue;
              r += px[o * 4]!; g += px[o * 4 + 1]!; bl += px[o * 4 + 2]!; n++;
            }
            if (!n) continue;
            px[q * 4] = r / n; px[q * 4 + 1] = g / n; px[q * 4 + 2] = bl / n;
            inside[q] = 2;
            next.push(q);
          }
        }
        for (const q of next) inside[q] = 1;
        ring = next;
      }
      ctx.putImageData(image, 0, 0);
      const map = new CanvasTexture(canvas);
      map.colorSpace = SRGBColorSpace;
      map.flipY = false;
      return map;
    })();
    PADDED.set(name, made);
  }
  return made;
}

/** Garment textures a person's shader always has room for (`garmentSlots.ts`): with the skin, the hair cards and the bone palette, within a GPU's sixteen texture units. */
const GARMENT_SLOTS = MAX_TEXTURED;
let blankTexture: DataTexture | null = null;
/** A 1x1 grey texture for an empty slot, shared. */
function blank(): DataTexture {
  if (!blankTexture) {
    blankTexture = new DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    blankTexture.needsUpdate = true;
  }
  return blankTexture;
}
