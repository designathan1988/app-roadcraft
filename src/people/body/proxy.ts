/**
 * A garment, a hairstyle, eyebrows: a MakeHuman proxy fitted to a body.
 *
 * A `.mhclo` file pins every vertex of a separate mesh to the base mesh: to
 * three base vertices with weights (a point on their triangle), plus an
 * offset scaled by how big the body is along each axis, measured between two
 * named base vertices per axis. Whatever the sliders make of the body, the
 * garment follows it - that is its fit. This module reads the packed form the
 * importer writes (`scripts/import-makehuman-proxies.mjs`) and fits it; it is
 * written from the file format, with no MakeHuman or MPFB code.
 */

/** One proxy as packed by the importer. */
export interface ProxyPack {
  readonly name: string;
  readonly kind: 'clothes' | 'hair' | 'eyebrows' | 'eyelashes' | 'shoes' | import('../wardrobe').CommunityKind;
  /** Base-mesh vertices the scale axes are measured between: [x0, x1, y0, y1, z0, z1]. */
  readonly scaleRefs: readonly number[];
  /** The axis lengths on the base mesh itself, decimetres. */
  readonly scaleBase: readonly [number, number, number];
  /** Per proxy vertex: three base vertices. */
  readonly refs: Uint32Array;
  /** Per proxy vertex: three weights. */
  readonly weights: Float32Array;
  /** Per proxy vertex: an offset, in units of the scale axes. */
  readonly offsets: Float32Array;
  /** Triangles. */
  readonly index: Uint32Array;
  /** Base-mesh vertices this proxy hides (the skin under a garment), or empty. */
  readonly deleteVerts: Uint32Array;
  /** Average colour of its texture, 0xRRGGBB, and how tintable it is. */
  readonly colour: number;
  /** Layer order: what is drawn over what. */
  readonly zDepth: number;
  readonly uvs?: Float32Array;
}

/**
 * The proxy's vertices on a body (`base`: the morphed base mesh, decimetres,
 * x y z per vertex). `out` is reused when it is the right size.
 */
export function fitProxy(proxy: ProxyPack, base: Float32Array, out?: Float32Array): Float32Array {
  const n = proxy.refs.length / 3;
  const result = out && out.length === n * 3 ? out : new Float32Array(n * 3);
  const axis = (i: number): number => {
    const a = proxy.scaleRefs[i * 2]!, b = proxy.scaleRefs[i * 2 + 1]!;
    const d = Math.abs(base[a * 3 + i]! - base[b * 3 + i]!);
    return d > 0 ? d / Math.max(1e-6, proxy.scaleBase[i]!) : 1;
  };
  const sx = axis(0), sy = axis(1), sz = axis(2);
  for (let v = 0; v < n; v++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) {
      const r = proxy.refs[v * 3 + k]!;
      const w = proxy.weights[v * 3 + k]!;
      x += w * base[r * 3]!;
      y += w * base[r * 3 + 1]!;
      z += w * base[r * 3 + 2]!;
    }
    result[v * 3] = x + proxy.offsets[v * 3]! * sx;
    result[v * 3 + 1] = y + proxy.offsets[v * 3 + 1]! * sy;
    result[v * 3 + 2] = z + proxy.offsets[v * 3 + 2]! * sz;
  }
  return result;
}

/**
 * Skin weights for a proxy's vertices, from the base mesh's: each takes its
 * three references' influences in proportion to their weights, the four
 * strongest kept. So a sleeve bends with the arm it is pinned to.
 */
export function proxySkin(proxy: ProxyPack, joints: Uint8Array, weights: Uint16Array): { joints: Uint16Array; weights: Float32Array } {
  const n = proxy.refs.length / 3;
  const outJ = new Uint16Array(n * 4);
  const outW = new Float32Array(n * 4);
  const blend = new Map<number, number>();
  for (let v = 0; v < n; v++) {
    blend.clear();
    for (let k = 0; k < 3; k++) {
      const r = proxy.refs[v * 3 + k]!;
      const share = Math.max(0, proxy.weights[v * 3 + k]!);
      for (let j = 0; j < 4; j++) {
        const w = (weights[r * 4 + j]! / 65535) * share;
        if (w > 0) blend.set(joints[r * 4 + j]!, (blend.get(joints[r * 4 + j]!) ?? 0) + w);
      }
    }
    const top = [...blend].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = top.reduce((s, [, w]) => s + w, 0) || 1;
    for (let j = 0; j < 4; j++) {
      outJ[v * 4 + j] = top[j]?.[0] ?? 0;
      outW[v * 4 + j] = (top[j]?.[1] ?? 0) / total;
    }
  }
  return { joints: outJ, weights: outW };
}

// ------------------------------------------------------------------ loading

/** A proxy's `.json` as the importer writes it. */
export interface ProxyMeta {
  readonly name: string;
  readonly kind: ProxyPack['kind'] | 'eyes';
  readonly scaleRefs: number[];
  readonly scaleBase: [number, number, number];
  readonly zDepth: number;
  readonly transparent?: boolean;
  readonly texture?: string | null;
  readonly layout: Record<string, { byteOffset: number; count: number }>;
}

/** The packed proxy from its `.json` and `.bin`. */
export function parseProxy(meta: ProxyMeta, bin: ArrayBuffer): ProxyPack {
  const L = meta.layout;
  const section = <T>(name: string, make: (b: ArrayBuffer, o: number, n: number) => T, empty: T): T =>
    L[name] ? make(bin, L[name]!.byteOffset, L[name]!.count) : empty;
  return {
    name: meta.name,
    kind: meta.kind as ProxyPack['kind'],
    scaleRefs: meta.scaleRefs,
    scaleBase: meta.scaleBase,
    zDepth: meta.zDepth,
    colour: 0xffffff,
    refs: section('refs', (b, o, n) => new Uint32Array(b, o, n), new Uint32Array(0)),
    weights: section('weights', (b, o, n) => new Float32Array(b, o, n), new Float32Array(0)),
    offsets: section('offsets', (b, o, n) => new Float32Array(b, o, n), new Float32Array(0)),
    uvs: section('uvs', (b, o, n) => new Float32Array(b, o, n), new Float32Array(0)),
    index: section('index', (b, o, n) => new Uint32Array(b, o, n), new Uint32Array(0)),
    deleteVerts: section('deleteVerts', (b, o, n) => new Uint32Array(b, o, n), new Uint32Array(0)),
  };
}

/** A texture read back to pixels, small: only sampled once per vertex. */
export interface ProxyTexture {
  readonly width: number;
  readonly height: number;
  /** RGBA, row 0 at the top of the image. */
  readonly data: Uint8ClampedArray;
}

/** A proxy ready to dress somebody: its geometry, and its texture's pixels when it has one. */
export interface ProxyItem {
  readonly pack: ProxyPack;
  readonly texture: ProxyTexture | null;
  /** Its texture has holes (hair strands, lashes): only the solid parts are drawn in the crowd. */
  readonly transparent: boolean;
  /** Its texture's file, for drawing it textured close up (`proxyUrl`), or null. */
  readonly textureFile: string | null;
}

/**
 * The colour of a texture at (u, v), RGBA 0..1; null without a texture. The
 * packs' v runs down the image from its top row (the importer turns the
 * .obj's round: `scripts/import-makehuman-proxies.mjs`).
 */
export function sampleTexture(t: ProxyTexture | null, u: number, v: number): [number, number, number, number] | null {
  if (!t) return null;
  const x = Math.min(t.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * t.width)));
  const y = Math.min(t.height - 1, Math.max(0, Math.floor((v - Math.floor(v)) * t.height)));
  const o = (y * t.width + x) * 4;
  return [t.data[o]! / 255, t.data[o + 1]! / 255, t.data[o + 2]! / 255, t.data[o + 3]! / 255];
}

/** Largest side a proxy's texture is read back at, pixels. */
const SAMPLE_SIZE = 256;

const ITEMS = new Map<string, Promise<ProxyItem>>();

/**
 * One proxy by name, fetched once (`public/models/people/proxies`). In a
 * browser its texture is read back to pixels for the crowd's vertex colours.
 */
export function loadProxyItem(name: string): Promise<ProxyItem> {
  let item = ITEMS.get(name);
  if (!item) {
    item = (async () => {
      const meta = (await (await fetch(proxyUrl(`${name}.json`))).json()) as ProxyMeta;
      const bin = await (await fetch(proxyUrl(`${name}.bin`))).arrayBuffer();
      let texture: ProxyTexture | null = null;
      if (meta.texture && typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
        try {
          // Read back on the CPU, never from the GPU. A plain 2D canvas is
          // GPU-backed, and getImageData on it waits for the GPU to hand the
          // pixels back: with the whole wardrobe loading as the crowd arrives,
          // that readback was 4.8 s of every 8.8 s on the main thread - the
          // game at 6 fps for its first minute. `willReadFrequently` makes the
          // canvas a software one (MDN, getContext), and the downscale is done
          // by createImageBitmap's own resize, off the main thread.
          const full = await createImageBitmap(await (await fetch(proxyUrl(meta.texture))).blob());
          const scale = Math.min(1, SAMPLE_SIZE / Math.max(full.width, full.height));
          const width = Math.max(1, Math.round(full.width * scale)), height = Math.max(1, Math.round(full.height * scale));
          const bitmap = scale < 1
            ? await createImageBitmap(full, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' })
            : full;
          if (bitmap !== full) full.close();
          const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(bitmap, 0, 0);
          texture = { width, height, data: ctx.getImageData(0, 0, width, height).data };
          bitmap.close();
        } catch { texture = null; }
      }
      return { pack: parseProxy(meta, bin), texture, transparent: !!meta.transparent, textureFile: meta.texture ?? null };
    })();
    ITEMS.set(name, item);
    item.catch(() => ITEMS.delete(name));
  }
  return item;
}

/**
 * Every proxy file's URL, by file name: imported, as the other people packs
 * are (`assets.ts`), so the dev server serves them and a build carries them -
 * the project serves no public folder.
 */
const URLS = import.meta.glob('../../../public/models/people/proxies/*.{json,bin,webp}', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

export function proxyUrl(file: string): string {
  const url = URLS[`../../../public/models/people/proxies/${file}`];
  if (!url) throw new Error(`No MakeHuman proxy file ${file}`);
  return url;
}
