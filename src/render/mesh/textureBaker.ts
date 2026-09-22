import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';

/**
 * Procedural texture baking.
 *
 * Every surface in the game is textured from canvases painted here rather than
 * from image files. Three reasons, in order of weight:
 *
 *  1. **They tile seamlessly by construction.** The noise below is periodic, so
 *     a road can repeat its asphalt a thousand times with no visible seam — the
 *     failure a photographic tile always eventually shows.
 *  2. **The normal and roughness maps come from the same height field as the
 *     colour**, so the lighting agrees with what the surface looks like. That
 *     agreement is most of what makes a flat polygon read as a material.
 *  3. Nothing to download, so the first frame is never a grey placeholder.
 *
 * Every texture is cached by key: a rebuild of the road network must not bake a
 * new 512x512 canvas per band per structure, which is what made an edit stutter.
 */

const cache = new Map<string, Texture>();

/** Deterministic 2D value noise with a period, so the result tiles. */
export function makeNoise(seed: number): (x: number, y: number, period: number) => number {
  const hash = (x: number, y: number): number => {
    let h = Math.imul(x | 0, 374_761_393) ^ Math.imul(y | 0, 668_265_263) ^ Math.imul(seed, 2_246_822_519);
    h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
    return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
  };
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  return (x: number, y: number, period: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const wrap = (v: number): number => ((v % period) + period) % period;
    const a = hash(wrap(x0), wrap(y0));
    const b = hash(wrap(x0 + 1), wrap(y0));
    const c = hash(wrap(x0), wrap(y0 + 1));
    const d = hash(wrap(x0 + 1), wrap(y0 + 1));
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

/** Sums octaves of tiling value noise. Returns roughly 0..1. */
export function fbm(
  noise: (x: number, y: number, period: number) => number,
  x: number,
  y: number,
  basePeriod: number,
  octaves: number,
): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let period = basePeriod;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * noise(x * frequency, y * frequency, period);
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
    period *= 2;
  }
  return sum / total;
}

export interface SurfaceBake {
  readonly map: Texture;
  readonly normalMap: Texture;
  readonly roughnessMap: Texture;
}

function texture(canvas: HTMLCanvasElement, srgb: boolean, repeat: number, anisotropy: number): Texture {
  const value = new CanvasTexture(canvas);
  if (srgb) value.colorSpace = SRGBColorSpace;
  value.wrapS = RepeatWrapping;
  value.wrapT = RepeatWrapping;
  value.repeat.set(repeat, repeat);
  value.anisotropy = anisotropy;
  value.needsUpdate = true;
  return value;
}

function canvasOf(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D | null } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return { canvas, ctx: canvas.getContext('2d') };
}

/**
 * Derives a tangent-space normal map from a height field, by central difference.
 *
 * The strength is in texels, so the same number means the same visual relief
 * whatever the resolution.
 */
export function normalMapFrom(height: Float32Array, size: number, strength: number): HTMLCanvasElement {
  const { canvas, ctx } = canvasOf(size);
  if (!ctx) return canvas;
  const image = ctx.createImageData(size, size);
  const at = (x: number, y: number): number =>
    height[((y + size) % size) * size + ((x + size) % size)] as number;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const length = Math.hypot(dx, dy, 1);
      const index = (y * size + x) * 4;
      image.data[index] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      image.data[index + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255);
      image.data[index + 2] = Math.round((1 / length) * 255);
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export function grayscaleCanvas(values: Float32Array, size: number): HTMLCanvasElement {
  const { canvas, ctx } = canvasOf(size);
  if (!ctx) return canvas;
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < values.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, values[i] as number)) * 255);
    image.data[i * 4] = v;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = v;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export interface SurfaceRecipe {
  readonly size: number;
  /** World units covered by one tile of the texture. */
  readonly worldSize: number;
  /**
   * Fills colour (0..1 rgb), height (0..1) and roughness (0..1) for one texel.
   * `u`/`v` are texel coordinates, so a recipe can draw lines as well as noise.
   */
  readonly shade: (
    u: number,
    v: number,
    out: { r: number; g: number; b: number; h: number; rough: number },
  ) => void;
  /** Relief strength of the derived normal map. */
  readonly relief: number;
}

/**
 * Bakes one material's colour, normal and roughness maps in a single sweep.
 *
 * `repeat` is derived from the world size the recipe declares and the world
 * size of the surface it goes on, which is set where the material is used.
 */
export function bakeSurface(key: string, recipe: SurfaceRecipe, anisotropy: number): SurfaceBake {
  const cached = cache.get(`${key}:map`);
  if (cached) {
    return {
      map: cached,
      normalMap: cache.get(`${key}:normal`) as Texture,
      roughnessMap: cache.get(`${key}:rough`) as Texture,
    };
  }

  const size = recipe.size;
  const { canvas, ctx } = canvasOf(size);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const out = { r: 0, g: 0, b: 0, h: 0, rough: 0.9 };

  if (ctx) {
    const image = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        recipe.shade(x, y, out);
        const index = y * size + x;
        image.data[index * 4] = Math.round(Math.min(1, Math.max(0, out.r)) * 255);
        image.data[index * 4 + 1] = Math.round(Math.min(1, Math.max(0, out.g)) * 255);
        image.data[index * 4 + 2] = Math.round(Math.min(1, Math.max(0, out.b)) * 255);
        image.data[index * 4 + 3] = 255;
        height[index] = out.h;
        rough[index] = out.rough;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  const map = texture(canvas, true, 1, anisotropy);
  const normalMap = texture(normalMapFrom(height, size, recipe.relief), false, 1, anisotropy);
  const roughnessMap = texture(grayscaleCanvas(rough, size), false, 1, anisotropy);
  cache.set(`${key}:map`, map);
  cache.set(`${key}:normal`, normalMap);
  cache.set(`${key}:rough`, roughnessMap);
  return { map, normalMap, roughnessMap };
}

export function disposeBakedTextures(): void {
  for (const value of cache.values()) value.dispose();
  cache.clear();
}
