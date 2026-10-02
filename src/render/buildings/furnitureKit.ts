import {
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  MeshStandardMaterial,
  SphereGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { FURNITURE_KINDS, FURNITURE_SIZE, type FurnitureKind } from '@world/buildings/interior';

/**
 * The furniture people use inside buildings, as models: rounded cushions,
 * turned legs, shelves with goods on them, books of every colour, a fridge
 * with its handle, a bed made with pillows and a cover. Each kind is ONE
 * geometry built here once, vertex-coloured, drawn instanced for every
 * piece of that kind in view - a city of rooms costs one draw per kind.
 *
 * Built in metres at the size `FURNITURE_SIZE` gives (across x, up y, deep
 * z), standing on y = 0, its front towards +z; the renderer scales it to the
 * piece and turns it to face where the piece faces.
 */

type RGB = readonly [number, number, number];

const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

const OAK = hex(0x9a6a43);
const WALNUT = hex(0x5e3d26);
const LINEN = hex(0xf2efe8);
const DUVET = hex(0x7d93ad);
const FABRIC = hex(0x6f7f8f);
const CUSHION = hex(0x84929f);
const BLACK = hex(0x1e2125);
const STEEL = hex(0xb3b9bd);
const CHROME = hex(0xd9dde0);
const WHITE = hex(0xf6f6f3);
const CERAMIC = hex(0xeef0ef);
const LEAF = hex(0x4c8a3a);
const LEAF_DARK = hex(0x386d2b);
const POT = hex(0xb4673f);
const RED = hex(0xa22b2b);
const SCREEN = hex(0x0f1418);
const BOARD = hex(0x2c4a3a);
const BOOKS: readonly RGB[] = [hex(0x8b2c2c), hex(0x2c4f8b), hex(0x2e6b3f), hex(0xc49a3c), hex(0x5a3b6b), hex(0xd8d2c0)];
const GOODS: readonly RGB[] = [hex(0xd9483b), hex(0xf2b33d), hex(0x3d8ad9), hex(0x5fb34a), hex(0xe8e3d6), hex(0x8b5a2b)];

/** Paints a geometry one colour (as a vertex attribute) and moves it into place. */
function paint(g: BufferGeometry, c: RGB, x = 0, y = 0, z = 0): BufferGeometry {
  g.translate(x, y, z);
  const n = g.getAttribute('position').count;
  const colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colours.set(c, i * 3);
  g.setAttribute('color', new Float32BufferAttribute(colours, 3));
  return g.index ? g.toNonIndexed() : g;
}

/** A box with rounded edges, its bottom at `y`. */
const rbox = (w: number, h: number, d: number, x: number, y: number, z: number, c: RGB, r = 0.03): BufferGeometry =>
  paint(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3)), c, x, y + h / 2, z);

/** An upright cylinder, its bottom at `y`. */
const cyl = (r: number, h: number, x: number, y: number, z: number, c: RGB, top = r, seg = 12): BufferGeometry =>
  paint(new CylinderGeometry(top, r, h, seg), c, x, y + h / 2, z);

const ball = (r: number, x: number, y: number, z: number, c: RGB): BufferGeometry =>
  paint(new SphereGeometry(r, 10, 8), c, x, y, z);

/** Four legs under a top `w` x `d`, inset `inset`, `h` high. */
function legs(w: number, d: number, h: number, c: RGB, inset = 0.06, r = 0.022): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(cyl(r, h, sx * (w / 2 - inset), 0, sz * (d / 2 - inset), c, r * 0.8, 8));
  return out;
}

function build(kind: FurnitureKind): BufferGeometry[] {
  const [W, D, H] = FURNITURE_SIZE[kind];
  const back = -D / 2;
  switch (kind) {
    case 'bed': case 'singleBed': {
      const frameH = 0.32;
      const out = [
        rbox(W, frameH, D, 0, 0.05, 0, WALNUT, 0.03),
        ...legs(W, D, 0.06, WALNUT, 0.06, 0.03),
        rbox(W - 0.06, 0.2, D - 0.12, 0, frameH, 0.02, LINEN, 0.08),
        rbox(W - 0.04, 0.06, D * 0.62, 0, frameH + 0.19, D * 0.17, DUVET, 0.05),
        rbox(W + 0.04, 0.95, 0.07, 0, 0.05, back + 0.03, WALNUT, 0.03),
      ];
      const pillows = kind === 'bed' ? [-W / 4, W / 4] : [0];
      for (const px of pillows) out.push(rbox(Math.min(0.6, W * 0.42), 0.12, 0.38, px, frameH + 0.2, back + 0.32, LINEN, 0.06));
      return out;
    }
    case 'wardBed':
      return [
        rbox(W, 0.08, D, 0, 0.55, 0, STEEL, 0.02),
        ...legs(W, D, 0.55, STEEL, 0.05, 0.025),
        rbox(W - 0.06, 0.15, D - 0.1, 0, 0.63, 0, LINEN, 0.06),
        rbox(0.6, 0.11, 0.35, 0, 0.77, back + 0.3, LINEN, 0.05),
        rbox(W, 0.6, 0.04, 0, 0.55, back + 0.02, STEEL, 0.02),
        rbox(0.04, 0.3, D * 0.6, -W / 2, 0.72, 0, CHROME, 0.015),
        rbox(0.04, 0.3, D * 0.6, W / 2, 0.72, 0, CHROME, 0.015),
      ];
    case 'sofa': case 'armchair': {
      const arm = 0.18;
      const seats = kind === 'sofa' ? 3 : 1;
      const inner = W - 2 * arm;
      const out = [
        rbox(W, 0.28, D, 0, 0.08, 0, FABRIC, 0.06),
        ...legs(W, D, 0.08, WALNUT, 0.08, 0.025),
        rbox(arm, 0.32, D, -W / 2 + arm / 2, 0.36, 0, FABRIC, 0.08),
        rbox(arm, 0.32, D, W / 2 - arm / 2, 0.36, 0, FABRIC, 0.08),
        rbox(W - 0.04, 0.45, 0.2, 0, 0.36, back + 0.1, FABRIC, 0.08),
      ];
      for (let i = 0; i < seats; i++) {
        const x = -inner / 2 + (inner / seats) * (i + 0.5);
        out.push(rbox(inner / seats - 0.02, 0.14, D - 0.26, x, 0.36, 0.09, CUSHION, 0.06));
        out.push(rbox(inner / seats - 0.04, 0.38, 0.16, x, 0.48, back + 0.24, CUSHION, 0.07));
      }
      return out;
    }
    case 'table':
      return [rbox(W, 0.04, D, 0, H - 0.04, 0, OAK, 0.015), ...legs(W, D, H - 0.04, WALNUT, 0.07, 0.025)];
    case 'altar':
      return [
        rbox(W, H, D, 0, 0, 0, hex(0xe9e2cf), 0.02),
        rbox(W + 0.06, 0.04, D + 0.06, 0, H, 0, LINEN, 0.01),
        rbox(W * 0.5, 0.02, D + 0.08, 0, H - 0.25, 0, RED, 0.005),
        cyl(0.03, 0.3, -W * 0.3, H, 0, hex(0xd7b65a)),
        cyl(0.03, 0.3, W * 0.3, H, 0, hex(0xd7b65a)),
      ];
    case 'desk':
      return [
        rbox(W, 0.035, D, 0, H - 0.035, 0, OAK, 0.01),
        rbox(0.04, H - 0.035, D - 0.04, -W / 2 + 0.03, 0, 0, WALNUT, 0.01),
        rbox(0.4, H - 0.12, D - 0.06, W / 2 - 0.22, 0.05, 0, WALNUT, 0.01),
        rbox(0.5, 0.32, 0.03, 0, H + 0.12, back + 0.15, BLACK, 0.01),
        rbox(0.06, 0.12, 0.06, 0, H, back + 0.15, BLACK, 0.01),
        rbox(0.42, 0.015, 0.14, 0, H, 0.08, hex(0x3a3d40), 0.004),
      ];
    case 'chair':
      return [
        rbox(W, 0.04, D, 0, 0.44, 0, OAK, 0.01),
        ...legs(W, D, 0.44, WALNUT, 0.04, 0.02),
        rbox(0.03, 0.46, 0.03, -W / 2 + 0.04, 0.48, back + 0.03, WALNUT, 0.01),
        rbox(0.03, 0.46, 0.03, W / 2 - 0.04, 0.48, back + 0.03, WALNUT, 0.01),
        rbox(W - 0.06, 0.08, 0.025, 0, 0.82, back + 0.03, OAK, 0.01),
        rbox(W - 0.06, 0.05, 0.025, 0, 0.66, back + 0.03, OAK, 0.01),
      ];
    case 'officeChair': {
      const out = [
        rbox(W - 0.04, 0.08, D - 0.06, 0, 0.44, 0.02, BLACK, 0.035),
        rbox(W - 0.08, 0.5, 0.06, 0, 0.55, back + 0.06, BLACK, 0.03),
        cyl(0.03, 0.4, 0, 0.06, 0, CHROME),
      ];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const leg = rbox(0.04, 0.03, 0.28, 0, 0.04, 0, BLACK, 0.01);
        leg.translate(0, 0, -0.14);
        leg.rotateY(a);
        out.push(leg, ball(0.03, Math.sin(a) * 0.27, 0.03, -Math.cos(a) * 0.27, BLACK));
      }
      return out;
    }
    case 'seat':
      return [
        rbox(W - 0.1, 0.12, D - 0.12, 0, 0.4, 0.04, RED, 0.05),
        rbox(W - 0.1, 0.55, 0.12, 0, 0.42, back + 0.07, RED, 0.06),
        rbox(0.05, 0.62, D, -W / 2 + 0.025, 0, 0, BLACK, 0.015),
        rbox(0.05, 0.62, D, W / 2 - 0.025, 0, 0, BLACK, 0.015),
      ];
    case 'pew':
      return [
        rbox(W, 0.05, D * 0.75, 0, 0.44, 0.06, OAK, 0.015),
        rbox(W, 0.5, 0.05, 0, 0.45, back + 0.05, OAK, 0.015),
        rbox(0.06, H, D, -W / 2 + 0.03, 0, 0, WALNUT, 0.02),
        rbox(0.06, H, D, W / 2 - 0.03, 0, 0, WALNUT, 0.02),
      ];
    case 'shelf': case 'bookshelf': {
      const wood = kind === 'bookshelf' ? WALNUT : hex(0xd8d4cc);
      const out = [
        rbox(W, H, 0.03, 0, 0, back + 0.015, wood, 0.01),
        rbox(0.04, H, D, -W / 2 + 0.02, 0, 0, wood, 0.01),
        rbox(0.04, H, D, W / 2 - 0.02, 0, 0, wood, 0.01),
      ];
      const levels = kind === 'bookshelf' ? 5 : 4;
      for (let k = 0; k <= levels; k++) {
        const y = (k / levels) * (H - 0.04);
        out.push(rbox(W - 0.06, 0.03, D - 0.04, 0, y, 0, wood, 0.005));
        if (k === levels) break;
        const room = H / levels - 0.06;
        let x = -W / 2 + 0.06;
        let i = k * 3;
        while (x < W / 2 - 0.12) {
          const bw = kind === 'bookshelf' ? 0.04 + ((i * 37) % 5) * 0.012 : 0.18 + ((i * 13) % 4) * 0.04;
          const bh = room * (kind === 'bookshelf' ? 0.72 + ((i * 7) % 4) * 0.07 : 0.5 + ((i * 11) % 4) * 0.1);
          const c = (kind === 'bookshelf' ? BOOKS : GOODS)[i % 6]!;
          out.push(rbox(bw - 0.006, bh, D * 0.7, x + bw / 2, y + 0.03, 0.02, c, 0.004));
          x += bw;
          i++;
        }
      }
      return out;
    }
    case 'rack': {
      const out: BufferGeometry[] = [];
      for (const sx of [-1, 0, 1]) for (const sz of [-1, 1]) out.push(rbox(0.06, H, 0.06, sx * (W / 2 - 0.03), 0, sz * (D / 2 - 0.03), hex(0x2f63b0), 0.01));
      for (const y of [0.15, 1.15, 2.15]) {
        out.push(rbox(W, 0.08, 0.05, 0, y, D / 2 - 0.03, hex(0xe0782a), 0.01), rbox(W, 0.08, 0.05, 0, y, -D / 2 + 0.03, hex(0xe0782a), 0.01));
        for (const bx of [-W / 3, 0, W / 3]) out.push(rbox(W / 3 - 0.15, 0.7, D - 0.2, bx, y + 0.08, 0, hex(0xc8a271), 0.02));
      }
      return out;
    }
    case 'counter': case 'barCounter': case 'checkout': {
      const body = kind === 'barCounter' ? WALNUT : kind === 'checkout' ? STEEL : OAK;
      const out = [
        rbox(W, 0.08, D - 0.08, 0, 0, 0.02, BLACK, 0.01),
        rbox(W, H - 0.12, D - 0.04, 0, 0.08, 0, body, 0.02),
        rbox(W + 0.04, 0.04, D + 0.04, 0, H - 0.04, 0, kind === 'barCounter' ? BLACK : hex(0xe6e1d8), 0.01),
      ];
      if (kind === 'barCounter') {
        for (let i = 0; i < 6; i++) out.push(cyl(0.035, 0.28, -W / 2 + 0.4 + i * 0.6, H, back + 0.12, GOODS[i]!, 0.015));
      }
      if (kind === 'checkout') {
        out.push(rbox(W * 0.6, 0.02, D * 0.5, -W * 0.15, H, 0.05, BLACK, 0.005));
        out.push(rbox(0.3, 0.25, 0.3, W / 2 - 0.25, H, 0, hex(0x3a3d40), 0.02));
      }
      return out;
    }
    case 'fridge':
      return [rbox(W, H, D, 0, 0, 0, WHITE, 0.05), rbox(W - 0.02, 0.01, 0.01, 0, H * 0.62, D / 2, hex(0xcfd3d5), 0.003),
        rbox(0.025, 0.35, 0.03, W / 2 - 0.08, H * 0.7, D / 2 + 0.02, CHROME, 0.01), rbox(0.025, 0.5, 0.03, W / 2 - 0.08, H * 0.18, D / 2 + 0.02, CHROME, 0.01)];
    case 'stove': {
      const out = [rbox(W, H - 0.03, D, 0, 0, 0, WHITE, 0.02), rbox(W, 0.03, D, 0, H - 0.03, 0, BLACK, 0.005),
        rbox(W - 0.12, 0.38, 0.01, 0, 0.18, D / 2, BLACK, 0.01), rbox(W - 0.2, 0.02, 0.03, 0, 0.62, D / 2 + 0.02, CHROME, 0.008)];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(cyl(0.08, 0.012, sx * W * 0.22, H, sz * D * 0.22, hex(0x3b3d40), 0.08, 14));
      return out;
    }
    case 'sink':
      return [rbox(W, H - 0.04, D, 0, 0, 0, OAK, 0.02), rbox(W, 0.04, D, 0, H - 0.04, 0, hex(0xd8d3c9), 0.01),
        rbox(W * 0.5, 0.02, D * 0.6, 0, H, 0.02, CHROME, 0.01), cyl(0.015, 0.25, 0, H, back + 0.08, CHROME)];
    case 'toilet':
      return [cyl(0.17, 0.4, 0, 0, 0.08, CERAMIC, 0.2, 16), rbox(0.38, 0.05, 0.46, 0, 0.4, 0.06, WHITE, 0.03),
        rbox(W, 0.38, 0.18, 0, 0.4, back + 0.09, CERAMIC, 0.04)];
    case 'bath':
      return [rbox(W, H, D, 0, 0, 0, CERAMIC, 0.12), rbox(W - 0.12, 0.02, D - 0.14, 0, H - 0.015, 0, hex(0xc7d8de), 0.06),
        cyl(0.015, 0.2, 0, H, back + 0.05, CHROME)];
    case 'wardrobe': case 'locker': {
      const c = kind === 'locker' ? hex(0x5f7d93) : WALNUT;
      return [rbox(W, H, D, 0, 0, 0, c, 0.02), rbox(0.01, H - 0.1, 0.01, 0, 0.05, D / 2, BLACK, 0.003),
        rbox(0.02, 0.18, 0.03, -0.06, H * 0.5, D / 2 + 0.01, CHROME, 0.008), rbox(0.02, 0.18, 0.03, 0.06, H * 0.5, D / 2 + 0.01, CHROME, 0.008)];
    }
    case 'tv':
      return [rbox(W, 0.45, D, 0, 0, 0, WALNUT, 0.02), rbox(W * 0.9, 0.55, 0.05, 0, 0.5, 0, BLACK, 0.015), rbox(W * 0.86, 0.5, 0.01, 0, 0.525, 0.03, SCREEN, 0.004)];
    case 'plant':
      return [cyl(0.17, 0.32, 0, 0, 0, POT, 0.21, 14), ball(0.24, 0, 0.6, 0, LEAF), ball(0.18, 0.12, 0.82, 0.05, LEAF_DARK), ball(0.16, -0.1, 0.78, -0.06, LEAF)];
    case 'bars': {
      const out = [rbox(W, 0.06, D, 0, H - 0.06, 0, BLACK, 0.01), rbox(W, 0.06, D, 0, 1.0, 0, BLACK, 0.01)];
      for (let x = -W / 2 + 0.05; x <= W / 2 - 0.04; x += 0.13) out.push(cyl(0.015, H, x, 0, 0, hex(0x40444a), 0.015, 6));
      return out;
    }
    case 'screen':
      return [rbox(W, H, D, 0, 1.5, 0, BLACK, 0.02), rbox(W - 0.2, H - 0.2, 0.02, 0, 1.6, D / 2, WHITE, 0.005)];
    case 'blackboard':
      return [rbox(W, H, D, 0, 0.9, 0, hex(0x7a5a3a), 0.01), rbox(W - 0.1, H - 0.1, 0.02, 0, 0.95, D / 2, BOARD, 0.005),
        rbox(W - 0.2, 0.03, 0.08, 0, 0.88, D / 2 + 0.03, hex(0x7a5a3a), 0.008)];
    case 'machine':
      return [rbox(W, H * 0.7, D, 0, 0, 0, hex(0x6f8a9a), 0.04), rbox(W * 0.5, H * 0.3, D * 0.4, -W * 0.15, H * 0.7, 0, hex(0x587080), 0.03),
        rbox(0.3, 0.25, 0.03, W * 0.25, H * 0.5, D / 2, SCREEN, 0.01), cyl(0.18, D * 0.9, W * 0.2, H * 0.72, 0, STEEL, 0.18, 14).rotateX(Math.PI / 2)];
    case 'atm':
      return [rbox(W, H, D, 0, 0, 0, hex(0x2c5a8a), 0.04), rbox(W * 0.6, 0.25, 0.02, 0, H * 0.62, D / 2, SCREEN, 0.01), rbox(W * 0.4, 0.04, 0.12, 0, H * 0.45, D / 2, BLACK, 0.01)];
    case 'stage':
      return [rbox(W, H, D, 0, 0, 0, BLACK, 0.02), rbox(0.6, 1.2, 0.5, -W / 2 + 0.4, H, back + 0.4, hex(0x2a2a2a), 0.04), rbox(0.6, 1.2, 0.5, W / 2 - 0.4, H, back + 0.4, hex(0x2a2a2a), 0.04),
        rbox(1.4, 0.8, 0.6, 0, H, 0, hex(0x3a3a46), 0.03)];
    case 'treadmill':
      return [rbox(W, 0.18, D, 0, 0, 0, BLACK, 0.04), rbox(W - 0.14, 0.02, D - 0.3, 0, 0.18, 0.05, hex(0x2e3136), 0.005),
        rbox(0.05, 1.0, 0.05, -W / 2 + 0.05, 0.18, back + 0.15, STEEL, 0.01), rbox(0.05, 1.0, 0.05, W / 2 - 0.05, 0.18, back + 0.15, STEEL, 0.01),
        rbox(W, 0.12, 0.25, 0, 1.15, back + 0.15, BLACK, 0.03)];
    case 'pallet':
      return [rbox(W, 0.14, D, 0, 0, 0, hex(0xb08a5a), 0.01), rbox(W - 0.1, H - 0.18, D - 0.1, 0, 0.14, 0, hex(0xc9a777), 0.03)];
    // Lights: a shade lit warm from inside (the room's light is placed where
    // these are), on a ceiling rose, a pole or a small base.
    case 'ceilingLamp':
      return [cyl(0.05, 0.12, 0, H - 0.12, 0, STEEL, 0.05, 10), cyl(W / 2, 0.2, 0, 0.02, 0, SHADE, W / 2 * 0.55, 20), ball(0.08, 0, 0.05, 0, BULB)];
    case 'floorLamp':
      return [cyl(0.16, 0.03, 0, 0, 0, BLACK, 0.16, 16), cyl(0.018, H - 0.35, 0, 0.03, 0, BLACK, 0.018, 8), cyl(W / 2 * 0.6, 0.32, 0, H - 0.34, 0, SHADE, W / 2, 20)];
    case 'tableLamp':
      return [cyl(0.09, 0.03, 0, 0, 0, OAK, 0.1, 14), cyl(0.02, H - 0.25, 0, 0.03, 0, OAK, 0.02, 8), cyl(W / 2 * 0.65, 0.22, 0, H - 0.24, 0, SHADE, W / 2, 18)];
  }
}

const SHADE = hex(0xfff0d0);
const BULB = hex(0xfffbe8);

/** One geometry per furniture kind, merged, vertex-coloured. */
export function createFurnitureGeometries(): Record<FurnitureKind, BufferGeometry> {
  const out = {} as Record<FurnitureKind, BufferGeometry>;
  for (const kind of FURNITURE_KINDS) {
    const parts = build(kind).map((g) => {
      // Every part with the same attributes, so they merge.
      if (!g.getAttribute('uv')) g.setAttribute('uv', new Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
      return g;
    });
    const merged = mergeGeometries(parts) as BufferGeometry;
    merged.computeBoundingSphere();
    for (const p of parts) p.dispose();
    out[kind] = merged;
  }
  return out;
}

export function createFurnitureMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.68, metalness: 0.04 });
  material.name = 'building-furniture';
  return material;
}
