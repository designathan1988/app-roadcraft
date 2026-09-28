import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface FacialAsset {
  meshes: { extras?: { targetNames?: string[] }; primitives: { targets?: unknown[] }[] }[];
  skins?: { joints: number[] }[];
  animations?: unknown[];
}

const KEYS = [
  'AU_45_Blink', 'HB_07_MouthSmile', 'AK_03_BrowInnerUp', 'AK_25_JawOpen',
  'AU_61_EyesTurnLeft', 'AU_62_EyesTurnRight', 'AA_VI_10_aa',
];

describe('Rocketbox facial pilot', () => {
  it('keeps the official rig and the compact expression set', () => {
    const path = resolve('public/models/citizens/female_01_facial.glb');
    const raw = readFileSync(path);
    expect(raw.length).toBeLessThan(1_500_000);
    expect(raw.readUInt32LE(0)).toBe(0x46546c67);
    const length = raw.readUInt32LE(12);
    const asset = JSON.parse(raw.subarray(20, 20 + length).toString()) as FacialAsset;
    expect(asset.animations).toBeUndefined();
    expect(asset.skins?.[0]?.joints.length).toBeGreaterThanOrEqual(80);
    expect(asset.meshes[0]?.extras?.targetNames).toEqual(KEYS);
    expect(asset.meshes[0]?.primitives[0]?.targets?.[0]).toHaveProperty('POSITION');
    for (const primitive of asset.meshes[0]?.primitives ?? []) {
      expect(primitive.targets).toHaveLength(KEYS.length);
    }
  });
});
