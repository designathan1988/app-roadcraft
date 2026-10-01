import { macroTargetWeights, type MacroDefinition, type MacroParams } from './macro';

/**
 * The MakeHuman base mesh, morphed: the person model's body (Person track H1).
 *
 * A body is the base mesh plus a weighted sum of targets. The macro targets
 * (sex, age, muscle, weight, ethnicity, height, proportions) come from the
 * principal-component pack, so however many of them a person blends, the work
 * is one pass over its 64 basis shapes; the breast macro targets and the 231
 * regional sliders (nose, ears, hands...) come from the sparse regional pack.
 *
 * Pure: it takes the decoded packs and returns positions. Loading the files is
 * `assets.ts`; the renderer turns positions into a mesh.
 */

/** `base.json` (the parts used here). */
export interface BaseMeta {
  readonly vertexCount: number;
  readonly sections: readonly { readonly name: string; readonly type: string; readonly itemSize: number; readonly count: number; readonly byteOffset: number }[];
  readonly faceGroups: readonly string[];
  readonly vertexGroups: Readonly<Record<string, readonly (readonly [number, number])[]>>;
}

/** `targets-macro-pca.json`. */
export interface MacroPcaMeta {
  readonly components: number;
  readonly vertexCount: number;
  readonly layout: {
    readonly basis: { readonly byteOffset: number; readonly count: number; readonly scales: readonly number[] };
    readonly coefficients: { readonly byteOffset: number; readonly count: number };
    readonly residualIndices: { readonly byteOffset: number; readonly count: number };
    readonly residualDeltas: { readonly byteOffset: number; readonly count: number };
  };
  readonly targets: readonly { readonly name: string; readonly row: number; readonly residualStart: number; readonly residualCount: number; readonly residualScale: number }[];
}

/** `targets-local.json`. */
export interface LocalMeta {
  readonly entryCount: number;
  readonly layout: { readonly indices: { readonly byteOffset: number }; readonly deltas: { readonly byteOffset: number } };
  readonly targets: readonly { readonly name: string; readonly group: string; readonly start: number; readonly count: number; readonly scale: number }[];
}

/** One regional slider (`modifiers.json` `.regional[group].categories[]`). */
export interface RegionalCategory {
  readonly name: string;
  readonly has_left_and_right: boolean;
  /** Two-way sliders: the target either way. One-target sliders (`head-oval`) have none. */
  readonly opposites?: Readonly<Record<string, string>>;
  readonly targets?: readonly string[];
}

export interface PeoplePacks {
  readonly base: BaseMeta;
  readonly baseBin: ArrayBuffer;
  readonly macro: MacroPcaMeta;
  readonly macroBin: ArrayBuffer;
  readonly local: LocalMeta;
  readonly localBin: ArrayBuffer;
  readonly modifiers: {
    readonly macro: MacroDefinition;
    readonly regional: Readonly<Record<string, { readonly categories: readonly RegionalCategory[] }>>;
  };
}

/**
 * A regional slider's value, -1..1: negative towards its "decr/down/..."
 * target, positive towards the other. Sided sliders take `l-`/`r-` keys, or
 * the bare name for both sides together.
 */
export type RegionalValues = Readonly<Record<string, number>>;

export class Morpher {
  readonly vertexCount: number;
  /** Base positions, decimetres, the OBJ frame (+Y up, +Z forward). */
  readonly base: Float32Array;
  private readonly basis: Int16Array;
  private readonly coeff: Float32Array;
  private readonly rIdx: Uint16Array;
  private readonly rDelta: Int16Array;
  private readonly lIdx: Uint16Array;
  private readonly lDelta: Int16Array;
  private readonly macroNames: string[];
  private readonly macroRow = new Map<string, MacroPcaMeta['targets'][number]>();
  private readonly localByName = new Map<string, LocalMeta['targets'][number]>();
  /** Every regional slider, by name. */
  readonly sliders = new Map<string, { readonly group: string; readonly category: RegionalCategory }>();

  constructor(private readonly packs: PeoplePacks) {
    const { base, baseBin, macro, macroBin, local, localBin } = packs;
    this.vertexCount = base.vertexCount;
    const positions = base.sections.find((s) => s.name === 'positions');
    if (!positions) throw new Error('base.json has no positions');
    this.base = new Float32Array(baseBin, positions.byteOffset, base.vertexCount * 3);
    const D = macro.vertexCount * 3;
    if (macro.vertexCount !== base.vertexCount) throw new Error('macro pack and base mesh disagree on the vertex count');
    this.basis = new Int16Array(macroBin, macro.layout.basis.byteOffset, macro.components * D);
    this.coeff = new Float32Array(macroBin, macro.layout.coefficients.byteOffset, macro.layout.coefficients.count);
    this.rIdx = new Uint16Array(macroBin, macro.layout.residualIndices.byteOffset, macro.layout.residualIndices.count);
    this.rDelta = new Int16Array(macroBin, macro.layout.residualDeltas.byteOffset, macro.layout.residualDeltas.count * 3);
    this.lIdx = new Uint16Array(localBin, local.layout.indices.byteOffset, local.entryCount);
    this.lDelta = new Int16Array(localBin, local.layout.deltas.byteOffset, local.entryCount * 3);
    this.macroNames = macro.targets.map((t) => t.name);
    for (const t of macro.targets) this.macroRow.set(t.name, t);
    for (const t of local.targets) this.localByName.set(t.name, t);
    for (const [group, { categories }] of Object.entries(packs.modifiers.regional)) {
      for (const category of categories) this.sliders.set(category.name, { group, category });
    }
  }

  /** The breast macro targets live in the regional pack; the rest in the PCA one. */
  private breastNames(): string[] {
    return this.packs.local.targets.filter((t) => t.group === 'breast').map((t) => t.name);
  }

  /**
   * The body for these macro sliders and regional values, as positions in the
   * base frame (decimetres). `out` is reused when given.
   */
  shape(params: MacroParams, regional: RegionalValues = {}, out?: Float32Array): Float32Array {
    const D = this.vertexCount * 3;
    const result = out && out.length === D ? out : new Float32Array(D);
    result.set(this.base);
    const K = this.packs.macro.components;
    const scales = this.packs.macro.layout.basis.scales;

    // Macro: the weights fold into one coefficient per basis shape...
    const weights = macroTargetWeights(this.packs.modifiers.macro, this.macroNames, params);
    const c = new Float64Array(K);
    for (const [name, w] of weights) {
      const t = this.macroRow.get(name);
      if (!t) continue;
      for (let k = 0; k < K; k++) c[k] = (c[k] ?? 0) + w * (this.coeff[t.row * K + k] ?? 0);
    }
    for (let k = 0; k < K; k++) {
      const ck = (c[k] ?? 0) * (scales[k] ?? 0);
      if (ck === 0) continue;
      const offset = k * D;
      for (let j = 0; j < D; j++) result[j] = (result[j] ?? 0) + ck * (this.basis[offset + j] ?? 0);
    }
    // ...and each target's own residual is added at its weight.
    for (const [name, w] of weights) {
      const t = this.macroRow.get(name);
      if (!t) continue;
      const s = w * t.residualScale;
      for (let e = t.residualStart; e < t.residualStart + t.residualCount; e++) {
        const v = (this.rIdx[e] ?? 0) * 3;
        result[v] = (result[v] ?? 0) + s * (this.rDelta[e * 3] ?? 0);
        result[v + 1] = (result[v + 1] ?? 0) + s * (this.rDelta[e * 3 + 1] ?? 0);
        result[v + 2] = (result[v + 2] ?? 0) + s * (this.rDelta[e * 3 + 2] ?? 0);
      }
    }

    // Breast macro targets (sparse, regional pack).
    for (const [name, w] of macroTargetWeights(this.packs.modifiers.macro, this.breastNames(), params)) this.addLocal(result, name, w);

    // Regional sliders.
    for (const [key, value] of Object.entries(regional)) {
      if (!value) continue;
      const side = key.startsWith('l-') ? 'left' : key.startsWith('r-') ? 'right' : null;
      const name = side ? key.slice(2) : key;
      const slider = this.sliders.get(name);
      if (!slider) continue;
      const sign = value < 0 ? 'negative' : 'positive';
      const sides = slider.category.has_left_and_right ? (side ? [side] : ['left', 'right']) : ['unsided'];
      for (const s of sides) {
        // A one-target slider (a head shape) only goes one way, 0..1.
        const target = slider.category.opposites
          ? slider.category.opposites[`${sign}-${s}`]
          : value > 0 ? slider.category.targets?.[0] : undefined;
        if (target) this.addLocal(result, `${slider.group}/${target}`, Math.min(1, Math.abs(value)));
      }
    }
    return result;
  }

  private addLocal(into: Float32Array, name: string, w: number): void {
    const t = this.localByName.get(name);
    if (!t || w === 0) return;
    const s = w * t.scale;
    for (let e = t.start; e < t.start + t.count; e++) {
      const v = (this.lIdx[e] ?? 0) * 3;
      into[v] = (into[v] ?? 0) + s * (this.lDelta[e * 3] ?? 0);
      into[v + 1] = (into[v + 1] ?? 0) + s * (this.lDelta[e * 3 + 1] ?? 0);
      into[v + 2] = (into[v + 2] ?? 0) + s * (this.lDelta[e * 3 + 2] ?? 0);
    }
  }
}

/** Standing height of a body, from its lowest to its highest skin vertex, decimetres. */
export function bodyHeight(positions: Float32Array, bodyRange: readonly (readonly [number, number])[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [a, b] of bodyRange) {
    for (let v = a; v <= b; v++) {
      const y = positions[v * 3 + 1] ?? 0;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
  }
  return hi - lo;
}
