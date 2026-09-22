import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CITIZEN_MODELS } from '@render/citizenCatalog';

interface Accessor { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }
interface View { byteOffset?: number; byteLength: number; byteStride?: number }
interface Primitive { attributes: Record<string, number>; indices: number; extras?: { roadcraftLods?: number[] } }
interface Asset {
  bufferViews: View[]; accessors: Accessor[]; meshes: { primitives: Primitive[] }[];
  nodes: { name?: string; mesh?: number; skin?: number }[];
  skins: { joints: number[] }[];
  animations: { name: string; channels: { sampler: number; target: { node: number; path: string } }[];
    samplers: { input: number; output: number }[] }[];
}
const widths: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const root = resolve('public/models/citizens');
const catalog = JSON.parse(readFileSync(resolve(root, 'catalog.json'), 'utf8')) as {
  models: { id: string; sha256: string; vertices: number; verticesBefore: number }[];
};

function read(name: string) {
  const raw = readFileSync(resolve(root, `${name}.glb`));
  expect(raw.readUInt32LE(0)).toBe(0x46546c67);
  expect(raw.readUInt32LE(8)).toBe(raw.length);
  const jsonLength = raw.readUInt32LE(12);
  const data = JSON.parse(raw.subarray(20, 20 + jsonLength).toString()) as Asset;
  const binary = raw.subarray(28 + jsonLength);
  const values = (index: number): number[] => {
    const accessor = data.accessors[index]!;
    const view = data.bufferViews[accessor.bufferView]!;
    const components = widths[accessor.type]!;
    const bytes = accessor.componentType === 5121 ? 1 : accessor.componentType === 5123 ? 2 : 4;
    const stride = view.byteStride ?? components * bytes;
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const result: number[] = [];
    for (let item = 0; item < accessor.count; item++) for (let c = 0; c < components; c++) {
      const offset = start + item * stride + c * bytes;
      result.push(accessor.componentType === 5126 ? binary.readFloatLE(offset)
        : bytes === 1 ? binary.readUInt8(offset) : bytes === 2 ? binary.readUInt16LE(offset) : binary.readUInt32LE(offset));
    }
    return result;
  };
  return { raw, data, binary, values };
}

describe('rigged citizen catalog', () => {
  it('ships 80 distinct source characters, with matching content hashes', () => {
    expect(CITIZEN_MODELS).toHaveLength(80);
    expect(new Set(CITIZEN_MODELS).size).toBe(80);
    expect(new Set(catalog.models.map(model => model.sha256)).size).toBe(80);
    expect(catalog.models.map(model => model.id)).toEqual(CITIZEN_MODELS);
    for (const model of catalog.models) {
      expect(createHash('sha256').update(readFileSync(resolve(root, `${model.id}.glb`))).digest('hex')).toBe(model.sha256);
      expect(model.vertices).toBeLessThan(model.verticesBefore);
    }
  });

  it('keeps finite geometry, valid skin weights and triangle indices for every character', () => {
    for (const name of CITIZEN_MODELS) {
      const { data, binary, values } = read(name);
      for (const view of data.bufferViews) expect((view.byteOffset ?? 0) + view.byteLength, name).toBeLessThanOrEqual(binary.length);
      for (const node of data.nodes.filter(node => node.mesh !== undefined)) expect(node.skin, name).toBeDefined();
      const joints = data.skins[0]!.joints.length;
      for (const mesh of data.meshes) for (const primitive of mesh.primitives) {
        const position = values(primitive.attributes['POSITION']!);
        expect(position.every(Number.isFinite), name).toBe(true);
        const indices = values(primitive.indices);
        expect(indices.length % 3, name).toBe(0);
        expect(Math.max(...indices), name).toBeLessThan(position.length / 3);
        const skin = values(primitive.attributes['JOINTS_0']!);
        expect(Math.max(...skin), name).toBeLessThan(joints);
        const weights = values(primitive.attributes['WEIGHTS_0']!);
        let weightError = 0;
        for (let i = 0; i < weights.length; i += 4) {
          const sum = weights[i]! + weights[i + 1]! + weights[i + 2]! + weights[i + 3]!;
          weightError = Math.max(weightError, Math.abs(sum - 1));
        }
        expect(weightError, name).toBeLessThan(1e-3);
      }
    }
  });

  it('contains actual leg movement in both walk clips for all 80 rigs', () => {
    for (const name of CITIZEN_MODELS) {
      const { data, values } = read(name);
      for (const clipName of ['Walk_Loop', 'Walk_Formal_Loop']) {
        const clip = data.animations.find(clip => clip.name === clipName)!;
        expect(clip, name).toBeDefined();
        for (const leg of ['Bip01_L_Thigh', 'Bip01_R_Thigh']) {
          const bone = data.nodes.findIndex(node => node.name === leg);
          const channel = clip.channels.find(channel => channel.target.node === bone && channel.target.path === 'rotation');
          expect(channel, `${name}:${leg}`).toBeDefined();
          const rotations = values(clip.samplers[channel!.sampler]!.output);
          let largest = 0;
          for (let i = 4; i < rotations.length; i += 4) {
            const dot = rotations[0]! * rotations[i]! + rotations[1]! * rotations[i + 1]! +
              rotations[2]! * rotations[i + 2]! + rotations[3]! * rotations[i + 3]!;
            largest = Math.max(largest, 1 - Math.abs(dot));
          }
          expect(largest, `${name}:${clipName}:${leg}`).toBeGreaterThan(0.01);
        }
      }
    }
  });

  it('provides valid smaller distant meshes without replacing full detail', () => {
    let full = 0, distant = 0;
    for (const name of CITIZEN_MODELS) {
      const { data, values } = read(name);
      for (const mesh of data.meshes) for (const primitive of mesh.primitives) {
        const vertices = data.accessors[primitive.attributes['POSITION']!]!.count;
        const original = values(primitive.indices);
        const lods = primitive.extras?.roadcraftLods;
        expect(lods, name).toHaveLength(2);
        full += original.length;
        for (const index of lods!) {
          const indices = values(index);
          expect(indices.length % 3, name).toBe(0);
          expect(indices.length, name).toBeGreaterThan(0);
          expect(indices.length, name).toBeLessThanOrEqual(original.length);
          expect(Math.max(...indices), name).toBeLessThan(vertices);
        }
        distant += data.accessors[lods![1]!]!.count;
      }
    }
    expect(distant).toBeLessThan(full * 0.2);
  });
});
