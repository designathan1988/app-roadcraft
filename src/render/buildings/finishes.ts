import { DoubleSide, MeshStandardMaterial } from 'three';

import { type Finish, FINISHES } from '@world/buildings/materials';
import { m } from '@world/units';
import { type SurfaceRecipe, bakeSurface, fbm, makeNoise } from '../mesh/textureBaker';

/**
 * The building finishes (docs/buildings.md, "Materials"): one material per
 * finish, each with its own baked texture, shared by every building's shell.
 *
 * The textures are NEUTRAL - greys with the finish's pattern and relief - and
 * the shell's vertex colour tints them, so one brick texture makes a red brick
 * wing and a yellow brick one. Shell UVs are in world units on the face's own
 * plane (see `Shell` in `buildingMesh.ts`), so each map is scaled here to the
 * size of its tile, and brick courses run level on every wall. Baked ONCE per
 * renderer and cached by key (AGENTS.md: never inside a rebuild).
 */

type Shade = SurfaceRecipe['shade'];

interface FinishLook {
  readonly size: number;
  /** World units one tile of the texture covers. */
  readonly worldSize: number;
  readonly relief: number;
  readonly metalness: number;
  readonly envMapIntensity: number;
  readonly shade: (size: number) => Shade;
}

/** A small integer hash, stable and tiling: per brick, per board, per tile. */
function cellHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

const grey = (out: { r: number; g: number; b: number }, t: number): void => {
  out.r = t;
  out.g = t;
  out.b = t;
};

/**
 * A running-bond masonry pattern: `rows` courses and `across` units per
 * course in one tile, each course shifted by half a unit. Returns the unit's
 * indices and the distance, in texels, to its nearest joint.
 */
function bond(u: number, v: number, size: number, across: number, rows: number): { col: number; row: number; edge: number } {
  const h = size / rows;
  const w = size / across;
  const row = Math.floor(v / h);
  const shifted = u + (row % 2 === 1 ? w / 2 : 0);
  const col = Math.floor(shifted / w) % across;
  const fu = shifted - Math.floor(shifted / w) * w;
  const fv = v - row * h;
  return { col, row, edge: Math.min(fu, w - fu, fv, h - fv) };
}

const LOOKS: Readonly<Record<Finish, FinishLook>> = {
  plaster: {
    size: 256,
    worldSize: m(4),
    relief: 1.4,
    metalness: 0,
    envMapIntensity: 0.6,
    shade: (size) => {
      const coarse = makeNoise(0x71a3);
      const fine = makeNoise(0x2c5d);
      return (x, y, out) => {
        const n = fbm(coarse, (x / size) * 12, (y / size) * 12, 12, 4);
        const f = fine((x / size) * 96, (y / size) * 96, 96);
        grey(out, 0.9 + (n - 0.5) * 0.09 + (f - 0.5) * 0.035);
        out.h = f * 0.7 + n * 0.3;
        out.rough = 0.93;
      };
    },
  },
  brick: {
    size: 512,
    worldSize: m(2.4),
    relief: 3.2,
    metalness: 0,
    envMapIntensity: 0.5,
    shade: (size) => {
      const grain = makeNoise(0x6b11);
      return (x, y, out) => {
        // 32 courses of 75 mm and ten 240 mm bricks a course in 2.4 m.
        const { col, row, edge } = bond(x, y, size, 10, 32);
        const g = grain((x / size) * 128, (y / size) * 128, 128);
        if (edge < 1.6) {
          grey(out, 0.58 + g * 0.05);
          out.h = 0.1;
          out.rough = 0.97;
          return;
        }
        const tone = 0.78 + cellHash(col, row, 0x3b) * 0.2 + (g - 0.5) * 0.06;
        out.r = tone;
        out.g = tone * 0.98;
        out.b = tone * 0.96;
        out.h = 0.75 + g * 0.2 + Math.min(1, edge / 4) * 0.05;
        out.rough = 0.86;
      };
    },
  },
  stone: {
    size: 512,
    worldSize: m(3.2),
    relief: 4.5,
    metalness: 0,
    envMapIntensity: 0.5,
    shade: (size) => {
      const grain = makeNoise(0x5d07);
      const mottle = makeNoise(0x0e93);
      return (x, y, out) => {
        // Eight 400 mm courses of ashlar, five blocks a course.
        const { col, row, edge } = bond(x, y, size, 5, 8);
        const g = fbm(grain, (x / size) * 48, (y / size) * 48, 48, 3);
        const mo = fbm(mottle, (x / size) * 8, (y / size) * 8, 8, 3);
        if (edge < 2.5) {
          grey(out, 0.5 + g * 0.08);
          out.h = 0;
          out.rough = 0.95;
          return;
        }
        grey(out, 0.7 + cellHash(col, row, 0x51) * 0.2 + (mo - 0.5) * 0.12 + (g - 0.5) * 0.05);
        // A little pillowed: the face bulges away from its joints.
        out.h = Math.min(1, edge / 10) * 0.6 + g * 0.4;
        out.rough = 0.9;
      };
    },
  },
  concrete: {
    size: 256,
    worldSize: m(4.8),
    relief: 1.6,
    metalness: 0,
    envMapIntensity: 0.5,
    shade: (size) => {
      const n1 = makeNoise(0x44c1);
      const n2 = makeNoise(0x1b7e);
      return (x, y, out) => {
        // Four 2.4 m formwork panels a tile, with their tie holes.
        const half = size / 2;
        const fu = x % half;
        const fv = y % half;
        const joint = Math.min(fu, half - fu, fv, half - fv) < 1.2;
        const tie = Math.hypot(((fu + half / 8) % (half / 4)) - half / 8, ((fv + half / 8) % (half / 4)) - half / 8) < 1.6;
        const n = fbm(n1, (x / size) * 10, (y / size) * 10, 10, 4);
        const f = n2((x / size) * 80, (y / size) * 80, 80);
        const panel = cellHash(Math.floor(x / half), Math.floor(y / half), 0x9d) * 0.05;
        grey(out, joint || tie ? 0.68 : 0.82 + panel + (n - 0.5) * 0.06 + (f - 0.5) * 0.025);
        out.h = joint || tie ? 0 : 0.6 + f * 0.2;
        out.rough = 0.9;
      };
    },
  },
  wood: {
    size: 256,
    worldSize: m(2.4),
    relief: 2.4,
    metalness: 0,
    envMapIntensity: 0.4,
    shade: (size) => {
      const grain = makeNoise(0x2fa9);
      return (x, y, out) => {
        // Sixteen 150 mm boards, standing: the grain runs up them.
        const board = size / 16;
        const col = Math.floor(x / board);
        const fu = x - col * board;
        if (Math.min(fu, board - fu) < 0.9) {
          grey(out, 0.35);
          out.h = 0;
          out.rough = 0.95;
          return;
        }
        const g = fbm(grain, (x / size) * 64 + col * 3.7, (y / size) * 6, 6, 4);
        const streak = 0.5 + 0.5 * Math.sin((g * 18 + fu * 0.3) * Math.PI);
        const tone = 0.72 + cellHash(col, 0, 0x7c) * 0.16 + (streak - 0.5) * 0.1;
        out.r = tone;
        out.g = tone * 0.97;
        out.b = tone * 0.93;
        out.h = 0.7 + streak * 0.15;
        out.rough = 0.78;
      };
    },
  },
  metal: {
    size: 256,
    worldSize: m(1.6),
    relief: 5,
    metalness: 0.55,
    envMapIntensity: 1,
    shade: (size) => {
      const n = makeNoise(0x6e2b);
      return (x, y, out) => {
        // Corrugated sheet: eight ribs a tile, 200 mm apart, running up.
        const rib = 0.5 + 0.5 * Math.sin(((x / size) * 8) * Math.PI * 2);
        const w = n((x / size) * 20, (y / size) * 20, 20);
        grey(out, 0.8 + (rib - 0.5) * 0.12 + (w - 0.5) * 0.05);
        out.h = rib;
        out.rough = 0.42 + w * 0.1;
      };
    },
  },
  glass: {
    size: 256,
    worldSize: m(3),
    relief: 2,
    metalness: 0.6,
    envMapIntensity: 1.4,
    shade: (size) => {
      const n = makeNoise(0x39d4);
      return (x, y, out) => {
        // A curtain wall: 1.5 m panes between slim mullions and transoms.
        const pane = size / 2;
        const fu = x % pane;
        const fv = y % pane;
        const frame = Math.min(fu, pane - fu, fv, pane - fv) < 3;
        if (frame) {
          grey(out, 0.85);
          out.h = 1;
          out.rough = 0.45;
          return;
        }
        const tint = cellHash(Math.floor(x / pane), Math.floor(y / pane), 0x12) * 0.08;
        grey(out, 0.5 + tint + (n((x / size) * 6, (y / size) * 6, 6) - 0.5) * 0.06);
        out.h = 0.4;
        out.rough = 0.07;
      };
    },
  },
  tile: {
    size: 256,
    worldSize: m(2),
    relief: 5.5,
    metalness: 0,
    envMapIntensity: 0.5,
    shade: (size) => {
      const grain = makeNoise(0x0bb5);
      return (x, y, out) => {
        // Eight 250 mm courses of ten barrel tiles; each course laps the one
        // below, which throws a line of shade along its edge.
        const course = size / 8;
        const row = Math.floor(y / course);
        const fv = (y - row * course) / course;
        const w = size / 10;
        const shifted = x + (row % 2 === 1 ? w / 2 : 0);
        const col = Math.floor(shifted / w) % 10;
        const fu = (shifted % w) / w;
        const barrel = Math.sin(fu * Math.PI);
        const lap = fv < 0.14 ? 0.55 + fv * 2.5 : 1;
        const g = grain((x / size) * 64, (y / size) * 64, 64);
        grey(out, (0.66 + barrel * 0.2 + cellHash(col, row, 0x2e) * 0.12 + (g - 0.5) * 0.05) * lap);
        out.h = barrel * 0.8 + fv * 0.2;
        out.rough = 0.8;
      };
    },
  },
};

/** One material per finish, textured where a document exists to bake on. */
export function createFinishMaterials(anisotropy = 8): Record<Finish, MeshStandardMaterial> {
  const canBake = typeof document !== 'undefined';
  const out = {} as Record<Finish, MeshStandardMaterial>;
  for (const finish of FINISHES) {
    const look = LOOKS[finish];
    // The shell is not a closed solid (openings, no underside), so it casts
    // from both sides.
    const material = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: look.metalness,
      envMapIntensity: look.envMapIntensity,
      shadowSide: DoubleSide,
    });
    if (canBake) {
      const bake = bakeSurface(
        `building-${finish}`,
        { size: look.size, worldSize: look.worldSize, relief: look.relief, shade: look.shade(look.size) },
        anisotropy,
      );
      const repeat = 1 / look.worldSize;
      for (const map of [bake.map, bake.normalMap, bake.roughnessMap]) map.repeat.set(repeat, repeat);
      material.map = bake.map;
      material.normalMap = bake.normalMap;
      material.roughnessMap = bake.roughnessMap;
    } else {
      material.roughness = 0.9;
    }
    material.name = `building-${finish}`;
    out[finish] = material;
  }
  return out;
}
