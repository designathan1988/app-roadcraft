import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  FrontSide,
  type Material,
  MeshStandardMaterial,
  PlaneGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { Finish } from '@world/buildings/materials';
import { createFinishMaterials } from './finishes';
import { createFurnitureGeometries, createFurnitureMaterial } from './furnitureKit';
import type { FurnitureKind } from '@world/buildings/interior';

/**
 * Everything the buildings layer draws with, built ONCE per renderer.
 *
 * AGENTS.md: materials and textures are made once and never inside a
 * rebuild, and repeated scene parts are instanced. Each component part here
 * is a unit geometry in a component frame - X along the facade, Y up, Z out
 * of the wall - scaled and turned per instance by `buildingMesh.ts`.
 */

export type PartKind =
  | 'glass'
  | 'frame'
  | 'concrete'
  | 'door'
  | 'shutter'
  | 'railing'
  | 'roofRailing'
  | 'awning'
  | 'column'
  | 'glassDark'
  | 'curtain';

export const PART_KINDS: readonly PartKind[] = [
  'glass',
  'frame',
  'concrete',
  'door',
  'shutter',
  'railing',
  'roofRailing',
  'awning',
  'column',
  'glassDark',
  'curtain',
];

export interface BuildingKit {
  readonly geometry: Readonly<Record<PartKind, BufferGeometry>>;
  readonly material: Readonly<Record<PartKind, Material>>;
  /** The merged shell - walls, plinths, bands, roofs, steps - one material per finish, vertex coloured. */
  readonly shell: Readonly<Record<Finish, MeshStandardMaterial>>;
  /** Ghost materials for the placement / drag preview, tinted by validity. */
  readonly ghostShell: MeshStandardMaterial;
  readonly ghostParts: MeshStandardMaterial;
  /** "Ocultar outros": the same shells, faded, for every building but the edited one. */
  readonly dimShell: Readonly<Record<Finish, MeshStandardMaterial>>;
  readonly dimParts: MeshStandardMaterial;
  /** Parts that cast shadows; the small ones do not, to spare the shadow pass. */
  readonly castsShadow: ReadonlySet<PartKind>;
  /** The furniture models, built the first time an interior is drawn. */
  furniture(): { readonly geometry: Readonly<Record<FurnitureKind, BufferGeometry>>; readonly material: MeshStandardMaterial };
  setGhostValid(valid: boolean): void;
  /** Lights the windows from inside as night falls: 0 by day, 1 at night. */
  setNight(dark: number): void;
  dispose(): void;
}

/** A box of the given size whose centre is at (x, y, z). */
function box(w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry {
  const g = new BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Window frame: outer border, a mullion and a transom, in a unit square. */
function frameGeometry(): BufferGeometry {
  const t = 0.045;
  const parts = [
    box(1, t, 1, 0, 0.5 - t / 2, 0),
    box(1, t, 1, 0, -0.5 + t / 2, 0),
    box(t, 1, 1, 0.5 - t / 2, 0, 0),
    box(t, 1, 1, -0.5 + t / 2, 0, 0),
    box(t * 0.8, 1, 1, 0, 0, 0),
    box(1, t * 0.8, 1, 0, 0.18, 0),
  ];
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

/** A balcony railing: top rail and balusters on three sides, z from 0 (wall) to 1. */
function railingGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [
    box(1, 0.06, 0.05, 0, 0.97, 1),
    box(0.05, 0.06, 1, -0.5, 0.97, 0.5),
    box(0.05, 0.06, 1, 0.5, 0.97, 0.5),
    box(1, 0.04, 0.03, 0, 0.12, 1),
  ];
  for (let i = 0; i <= 10; i++) parts.push(box(0.015, 0.94, 0.015, -0.5 + i / 10, 0.5, 1));
  for (let i = 1; i < 4; i++) {
    parts.push(box(0.015, 0.94, 0.015, -0.5, 0.5, i / 4));
    parts.push(box(0.015, 0.94, 0.015, 0.5, 0.5, i / 4));
  }
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

/** A straight railing along a roof edge, centred at z = 0. */
function roofRailingGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [box(1, 0.06, 0.05, 0, 0.97, 0), box(1, 0.04, 0.03, 0, 0.45, 0)];
  for (let i = 0; i <= 4; i++) parts.push(box(0.02, 0.94, 0.02, -0.5 + i / 4, 0.5, 0));
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

/**
 * A door leaf in the component frame: a slab with two raised panels on each
 * leaf half, a lock rail between them and a handle - not a brown rectangle.
 */
function doorGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [box(1, 1, 0.6, 0, 0, -0.2)];
  for (const x of [-0.24, 0.24]) {
    parts.push(box(0.36, 0.5, 0.35, x, 0.2, 0.25));
    parts.push(box(0.36, 0.3, 0.35, x, -0.3, 0.25));
  }
  // The handle, at hand height, near the lock stile.
  parts.push(box(0.1, 0.035, 1.6, 0.4, -0.04, 0.9));
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}

/** A shop awning: a sloped canvas from the wall (y 0, z 0) down and out, with a valance. */
function awningGeometry(): BufferGeometry {
  const canvas = new BoxGeometry(1, 0.04, 1.08);
  canvas.rotateX(Math.atan2(0.75, 1));
  canvas.translate(0, -0.38, 0.5);
  const valance = box(1, 0.28, 0.025, 0, -0.86, 1.0);
  const merged = mergeGeometries([canvas, valance]) as BufferGeometry;
  canvas.dispose();
  valance.dispose();
  return merged;
}

export function createBuildingKit(): BuildingKit {
  const unitBox = new BoxGeometry(1, 1, 1);
  const glassPlane = new PlaneGeometry(1, 1);
  const geometry: Record<PartKind, BufferGeometry> = {
    glass: glassPlane,
    frame: frameGeometry(),
    concrete: unitBox,
    door: doorGeometry(),
    shutter: unitBox,
    railing: railingGeometry(),
    roofRailing: roofRailingGeometry(),
    awning: awningGeometry(),
    column: new CylinderGeometry(0.5, 0.5, 1, 12),
    glassDark: glassPlane,
    curtain: unitBox,
  };

  const concrete = new MeshStandardMaterial({ color: 0xcfc9bd, roughness: 0.82, metalness: 0 });
  const metal = new MeshStandardMaterial({ color: 0x33373a, roughness: 0.45, metalness: 0.55 });
  const material: Record<PartKind, Material> = {
    // Both sides in the shadow pass: a pane is one-sided, and three draws a
    // front-sided material's BACK faces for shadows, so a pane facing the sun
    // would let it straight through.
    // Light and glossy enough to carry the sky: a dark flat pane reads as a
    // hole painted on the wall, not as glass.
    glass: new MeshStandardMaterial({ color: 0x55707f, roughness: 0.04, metalness: 0.8, envMapIntensity: 2.1, shadowSide: DoubleSide }),
    frame: new MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.55, metalness: 0.05 }),
    concrete,
    door: new MeshStandardMaterial({ color: 0x6b4a33, roughness: 0.55, metalness: 0 }),
    shutter: new MeshStandardMaterial({ color: 0x9aa1a4, roughness: 0.5, metalness: 0.45 }),
    railing: metal,
    roofRailing: metal,
    // The one batch with per-instance colours, and it alone uses this material.
    awning: new MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 }),
    column: concrete,
    // Window variety: a pane that reflects less (a darker room behind it) and
    // a curtain drawn behind the frame - no two rows of windows alike.
    glassDark: new MeshStandardMaterial({ color: 0x33434c, roughness: 0.06, metalness: 0.7, envMapIntensity: 1.6, shadowSide: DoubleSide }),
    curtain: new MeshStandardMaterial({ color: 0xe9e1d2, roughness: 0.95, metalness: 0 }),
  };
  for (const [kind, m] of Object.entries(material)) m.name = `building-part-${kind}`;
  // At night not every window is lit, nor all alike: each pane draws its own
  // lot from where it stands - a third dark, the rest from dim to bright,
  // some cooler (a television) - so a block reads as rooms, not a lamp.
  for (const kind of ['glass', 'glassDark'] as const) {
    const glassy = material[kind] as MeshStandardMaterial;
    glassy.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vRoomLot;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 roomAt = instanceMatrix[3].xyz;
#else
  vec3 roomAt = vec3(0.0);
#endif
  vRoomLot = fract(sin(dot(floor(roomAt * 0.37), vec3(12.9898, 78.233, 37.719))) * 43758.5453);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vRoomLot;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  float roomLit = step(0.34, vRoomLot) * (0.45 + 0.9 * fract(vRoomLot * 7.13));
  vec3 roomTint = mix(vec3(1.0), vec3(0.62, 0.78, 1.15), step(0.9, fract(vRoomLot * 3.71)));
  totalEmissiveRadiance *= roomLit * roomTint;`);
    };
    glassy.customProgramCacheKey = () => `room-lights-${kind}`;
  }
  const shell = createFinishMaterials();
  const ghostShell = new MeshStandardMaterial({
    color: 0x65e5c3,
    emissive: new Color(0x1d5a4a),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    roughness: 0.7,
    side: FrontSide,
  });
  const ghostParts = ghostShell.clone();

  // The faded copies: same colour and maps, a fraction of the presence, and no
  // depth write, so the edited building reads through them.
  const dim = (m: MeshStandardMaterial): MeshStandardMaterial => {
    const faded = m.clone();
    faded.transparent = true;
    faded.opacity = 0.22;
    faded.depthWrite = false;
    faded.color.multiplyScalar(0.75);
    return faded;
  };
  const dimShell = Object.fromEntries(Object.entries(shell).map(([finish, mat]) => [finish, dim(mat)])) as Record<Finish, MeshStandardMaterial>;
  const dimParts = dim(material['concrete'] as MeshStandardMaterial);
  dimParts.opacity = 0.16;

  const unique = new Set<Material>([...Object.values(material), ...Object.values(shell), ...Object.values(dimShell), ghostShell, ghostParts, dimParts]);
  const geometries = new Set<BufferGeometry>(Object.values(geometry));
  let furniture: { geometry: Record<FurnitureKind, BufferGeometry>; material: MeshStandardMaterial } | null = null;

  return {
    geometry,
    material,
    shell,
    ghostShell,
    ghostParts,
    dimShell,
    dimParts,
    // Glass, doors and shutters close the openings for the sun: without them
    // the shadow of every building is a lattice of lit windows.
    castsShadow: new Set<PartKind>(['glass', 'glassDark', 'frame', 'door', 'shutter', 'concrete', 'railing', 'awning', 'column', 'roofRailing']),
    furniture() {
      if (!furniture) {
        furniture = { geometry: createFurnitureGeometries(), material: createFurnitureMaterial() };
        for (const g of Object.values(furniture.geometry)) geometries.add(g);
        unique.add(furniture.material);
      }
      return furniture;
    },
    setNight(dark) {
      // Rooms lit behind the glass: a warm glow, more in the clear glass.
      for (const [kind, k] of [['glass', 0.55], ['glassDark', 0.35]] as const) {
        const mat = material[kind] as MeshStandardMaterial;
        mat.emissive.setHex(0xffc27a);
        mat.emissiveIntensity = dark * k;
      }
    },
    setGhostValid(valid) {
      for (const m of [ghostShell, ghostParts]) {
        m.color.setHex(valid ? 0x65e5c3 : 0xff6f63);
        m.emissive.setHex(valid ? 0x1d5a4a : 0x5a1d1d);
      }
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of unique) m.dispose();
    },
  };
}
