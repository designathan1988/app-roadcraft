import baseJson from '../../../public/models/people/base.json?url';
import baseBin from '../../../public/models/people/base.bin?url';
import macroJson from '../../../public/models/people/targets-macro-pca.json?url';
import macroBin from '../../../public/models/people/targets-macro-pca.bin?url';
import localJson from '../../../public/models/people/targets-local.json?url';
import localBin from '../../../public/models/people/targets-local.bin?url';
import modifiersJson from '../../../public/models/people/modifiers.json?url';
import skeletonJson from '../../../public/models/people/skeleton-game-engine.json?url';
import weightsBin from '../../../public/models/people/weights-game-engine.bin?url';

import type { BaseMeta, PeoplePacks } from './morph';

/**
 * Loads the MakeHuman packs (about 10 MB gzipped) once, when something first
 * needs a person model: the Person Creator, at the moment. Nothing is fetched
 * at boot.
 */

export interface PeopleAssets {
  readonly packs: PeoplePacks;
  /** The game_engine skeleton: names, parents, where each head is read from. */
  readonly skeleton: SkeletonMeta;
  readonly bodyRange: readonly (readonly [number, number])[];
  readonly mesh: {
    readonly vertexCount: number;
    readonly faces: Uint16Array;
    readonly faceGroup: Uint8Array;
    readonly faceGroups: readonly string[];
    readonly vertexGroups: Readonly<Record<string, readonly (readonly [number, number])[]>>;
    readonly joints: Uint8Array;
    readonly weights: Uint16Array;
    readonly boneNames: readonly string[];
  };
}

export interface SkeletonMeta {
  readonly bones: readonly {
    readonly name: string;
    readonly parent: string | null;
    readonly head: { readonly strategy: string; readonly cubeName?: string; readonly vertexIndices?: readonly number[] };
  }[];
  readonly weights: { readonly vertexCount: number; readonly layout: { readonly joints: { readonly byteOffset: number }; readonly weights: { readonly byteOffset: number } } };
}

let loading: Promise<PeopleAssets> | null = null;

export function loadPeopleAssets(): Promise<PeopleAssets> {
  loading ??= (async () => {
    const text = async <T>(url: string): Promise<T> => (await (await fetch(url)).json()) as T;
    const binary = async (url: string): Promise<ArrayBuffer> => (await fetch(url)).arrayBuffer();
    const [base, baseData, macro, macroData, local, localData, modifiers, skeleton, weights] = await Promise.all([
      text<BaseMeta & { faceCount: number }>(baseJson), binary(baseBin),
      text<PeoplePacks['macro']>(macroJson), binary(macroBin),
      text<PeoplePacks['local']>(localJson), binary(localBin),
      text<PeoplePacks['modifiers']>(modifiersJson),
      text<SkeletonMeta>(skeletonJson), binary(weightsBin),
    ]);
    const section = (name: string) => {
      const s = base.sections.find((x) => x.name === name);
      if (!s) throw new Error(`base.json has no ${name}`);
      return s;
    };
    const faces = section('faceVerts');
    const groups = section('faceGroup');
    return {
      packs: { base, baseBin: baseData, macro, macroBin: macroData, local, localBin: localData, modifiers },
      skeleton,
      bodyRange: base.vertexGroups['body'] ?? [[0, base.vertexCount - 1]],
      mesh: {
        vertexCount: base.vertexCount,
        faces: new Uint16Array(baseData, faces.byteOffset, faces.count * 4),
        faceGroup: new Uint8Array(baseData, groups.byteOffset, groups.count),
        faceGroups: base.faceGroups,
        vertexGroups: base.vertexGroups,
        joints: new Uint8Array(weights, skeleton.weights.layout.joints.byteOffset, skeleton.weights.vertexCount * 4),
        weights: new Uint16Array(weights, skeleton.weights.layout.weights.byteOffset, skeleton.weights.vertexCount * 4),
        boneNames: skeleton.bones.map((b) => b.name),
      },
    };
  })();
  return loading;
}
