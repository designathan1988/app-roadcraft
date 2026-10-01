import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  Plane,
  Vector3,
  type Material,
} from 'three';

import type { PersonLook } from '@people/spec';

/**
 * A person as a mesh: the morphed MakeHuman body and the helper shells that
 * morph with it (Person track, first visible step).
 *
 * The base mesh carries, in the same vertex space as the skin, MakeHuman's
 * fitting shells: a close "tights" layer over the whole body, a skirt, a hair
 * shell, the eyes and the eyelashes. They follow every target the body
 * follows, so a garment cut from the tights fits whatever body the sliders
 * make. Until proper garments are imported (proxies, H3) the clothes ARE those
 * shells, cut where a tailor would cut them: at the neck, the waist, along the
 * arm and the leg. The cuts are measured from MakeHuman's joint cubes on the
 * base mesh, so they run along the mesh's own edge loops - straight hems -
 * and, being read once on the base, they stay put on any body.
 *
 * Hair is the scalp, coloured per vertex with a soft hairline; long hair adds
 * the part of the hair shell that stays clear of the face.
 *
 * One geometry for the person, the morphed positions shared, one index group
 * per material. Positions go from the packs' decimetres (+Y up, +Z forward)
 * to metres, feet on y = 0.
 */

export interface PersonMeshData {
  readonly vertexCount: number;
  /** Quads (a, b, c, d), d === c for a triangle. */
  readonly faces: Uint16Array;
  readonly faceGroup: Uint8Array;
  readonly faceGroups: readonly string[];
  readonly vertexGroups: Readonly<Record<string, readonly (readonly [number, number])[]>>;
  readonly joints: Uint8Array;
  readonly weights: Uint16Array;
  readonly boneNames: readonly string[];
}

/** The parts drawn, in material order. */
export const PART_ORDER = ['skin', 'top', 'sleeves', 'bottom', 'shoes', 'hair', 'eyes', 'lashes'] as const;
export type Part = typeof PART_ORDER[number];

type Limb = 'arm' | 'leg' | 'trunk' | 'head';
const LIMBS: Limb[] = ['trunk', 'arm', 'leg', 'head'];

/** Everything about the base mesh the cuts need, measured once. */
export interface Tailoring {
  /** Per tights face: which limb (`LIMBS` index), and how far along it: 0, 1, 2 at its three joints. */
  readonly limb: Uint8Array;
  readonly along: Float32Array;
  /** Per tights face: its height, decimetres, base mesh. */
  readonly height: Float32Array;
  readonly neckY: number;
  readonly waistY: number;
  /** Per vertex: how much of it is hair, 0..1 (scalp of the body). */
  readonly hair: Float32Array;
  /** Hair-shell faces kept for long hair: behind and beside the face. */
  readonly longHair: ReadonlySet<number>;
}

export function tailor(data: PersonMeshData, base: Float32Array): Tailoring {
  const centre = (group: string): [number, number, number] => {
    let x = 0, y = 0, z = 0, n = 0;
    for (const [a, b] of data.vertexGroups[group] ?? []) {
      for (let v = a; v <= b; v++) {
        x += base[v * 3]!;
        y += base[v * 3 + 1]!;
        z += base[v * 3 + 2]!;
        n++;
      }
    }
    return n ? [x / n, y / n, z / n] : [0, 0, 0];
  };
  const chain = (side: 'l' | 'r', joints: readonly string[]) => joints.map((j) => centre(`joint-${side}-${j}`));
  const arms = (['l', 'r'] as const).map((s) => chain(s, ['shoulder', 'elbow', 'hand']));
  const legs = (['l', 'r'] as const).map((s) => chain(s, ['upper-leg', 'knee', 'ankle']));
  const neckY = centre('joint-neck')[1] - 0.25;
  const pelvisY = centre('joint-pelvis')[1];
  // A waistband sits below the navel: 40 % of the way from the hip joints to
  // the lowest spine joint (which is at the bottom of the ribs).
  const waistY = centre('joint-pelvis')[1] + (centre('joint-spine-1')[1] - centre('joint-pelvis')[1]) * WAIST_SHARE;
  const eyes = [centre('joint-l-eye'), centre('joint-r-eye')];
  const eyeY = (eyes[0]![1] + eyes[1]![1]) / 2;
  const eyeZ = (eyes[0]![2] + eyes[1]![2]) / 2;

  /** Where along a joint chain a point projects: 0, 1, 2 at the joints. */
  const alongChain = (p: readonly number[], joints: readonly (readonly number[])[]): { t: number; d: number } => {
    let best = { t: 0, d: Infinity };
    for (let i = 0; i + 1 < joints.length; i++) {
      const a = joints[i]!, b = joints[i + 1]!;
      const ab = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const ap = [p[0]! - a[0]!, p[1]! - a[1]!, p[2]! - a[2]!];
      const len2 = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2 || 1;
      const u = Math.min(1.2, Math.max(-0.4, (ap[0]! * ab[0]! + ap[1]! * ab[1]! + ap[2]! * ab[2]!) / len2));
      const d = Math.hypot(ap[0]! - ab[0]! * u, ap[1]! - ab[1]! * u, ap[2]! - ab[2]! * u);
      if (d < best.d) best = { t: i + u, d };
    }
    return best;
  };

  const faceCount = data.faceGroup.length;
  const limb = new Uint8Array(faceCount);
  const along = new Float32Array(faceCount);
  const height = new Float32Array(faceCount);
  const tights = data.faceGroups.indexOf('helper-tights');
  const hairShell = data.faceGroups.indexOf('helper-hair');
  const boneWeight = new Float64Array(data.boneNames.length);
  const longHair = new Set<number>();
  for (let f = 0; f < faceCount; f++) {
    const g = data.faceGroup[f]!;
    if (g !== tights && g !== hairShell) continue;
    let px = 0, py = 0, pz = 0;
    for (let c = 0; c < 4; c++) {
      const v = data.faces[f * 4 + c]!;
      px += base[v * 3]! / 4;
      py += base[v * 3 + 1]! / 4;
      pz += base[v * 3 + 2]! / 4;
    }
    const p = [px, py, pz];
    if (g === hairShell) {
      // Nothing in front of the ears below the hairline: the face stays clear.
      if (p[2]! < eyeZ - 0.7 || p[1]! > eyeY + 0.55) longHair.add(f);
      continue;
    }
    height[f] = p[1]!;
    // Which limb: the bone weighing most on the face's corners.
    boneWeight.fill(0);
    for (let c = 0; c < 4; c++) {
      const v = data.faces[f * 4 + c]!;
      for (let k = 0; k < 4; k++) {
        const bone = data.joints[v * 4 + k]!;
        boneWeight[bone] = (boneWeight[bone] ?? 0) + data.weights[v * 4 + k]!;
      }
    }
    let best = 0;
    for (let b = 1; b < boneWeight.length; b++) if (boneWeight[b]! > boneWeight[best]!) best = b;
    const name = data.boneNames[best] ?? 'Root';
    // The thigh weighs on the lower belly too: above the hip joints a face is
    // trunk whatever its weights say, or a skirt left the belly bare.
    const kind: Limb = /arm|hand|thumb|index|middle|ring|pinky/.test(name) ? 'arm'
      : /thigh|calf|foot|ball/.test(name) ? (p[1]! > pelvisY ? 'trunk' : 'leg')
      : /head|neck/.test(name) ? 'head' : 'trunk';
    limb[f] = LIMBS.indexOf(kind);
    if (kind === 'arm' || kind === 'leg') {
      const chains = kind === 'arm' ? arms : legs;
      const a = alongChain(p, chains[0]!);
      const b = alongChain(p, chains[1]!);
      along[f] = (a.d <= b.d ? a : b).t;
    }
  }

  // The scalp, per vertex, with a soft hairline: about 6 cm above the eyes at
  // the front, down to the nape at the back, round the ears.
  const hair = new Float32Array(data.vertexCount);
  const headBone = data.boneNames.indexOf('head');
  const neckBone = data.boneNames.indexOf('neck_01');
  const smooth = (e0: number, e1: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  // Only the head: nothing below the jaw, so a hand raised to the face or a
  // shoulder is never painted.
  for (const [a, b] of data.vertexGroups['body'] ?? []) {
    for (let v = a; v <= b; v++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (data.joints[v * 4 + k] === headBone || data.joints[v * 4 + k] === neckBone) w += data.weights[v * 4 + k]! / 65535;
      if (w < 0.2) continue;
      const x = base[v * 3]!, y = base[v * 3 + 1]!, z = base[v * 3 + 2]!;
      // The hairline drops from the forehead to the nape as the head is
      // followed back; the ears stay clear.
      const back = smooth(eyeZ - 0.4, eyeZ - 1.1, z);
      const hairline = eyeY + 0.62 - back * 1.55;
      const earBand = smooth(eyeY - 0.8, eyeY - 0.6, y) * (1 - smooth(eyeY + 0.2, eyeY + 0.35, y));
      const ear = earBand * smooth(0.55, 0.68, Math.abs(x)) * (1 - back * 0.6);
      hair[v] = smooth(hairline - 0.05, hairline + 0.09, y) * (1 - ear);
    }
  }
  return { limb, along, height, neckY, waistY, hair, longHair };
}

/** Which faces a look shows, per part. */
export function facesFor(data: PersonMeshData, look: PersonLook, cut: Tailoring): Map<Part, number[]> {
  const groupIndex = (name: string): number => data.faceGroups.indexOf(name);
  const body = groupIndex('body');
  const tights = groupIndex('helper-tights');
  const skirt = groupIndex('helper-skirt');
  const hairShell = groupIndex('helper-hair');
  const eyes = new Set([groupIndex('helper-l-eye'), groupIndex('helper-r-eye')]);
  const lashes = new Set(data.faceGroups.map((g, i) => (g.includes('eyelashes') ? i : -1)).filter((i) => i >= 0));
  // How far down the arm a sleeve reaches, and down the leg a leg: 1 is the
  // elbow or the knee, 2 the wrist or the ankle.
  // Faces are taken a little past each cut; the clipping planes
  // (`hemPlanes`) make the edge itself, straight across.
  const sleeve = sleeveEnd(look) + HEM_MARGIN;
  const leg = legEnd(look) + HEM_MARGIN;

  const out = new Map<Part, number[]>(PART_ORDER.map((p) => [p, []]));
  const add = (part: Part, f: number): void => {
    out.get(part)!.push(f);
  };
  for (let f = 0; f < data.faceGroup.length; f++) {
    const g = data.faceGroup[f]!;
    if (g === body) add('skin', f);
    else if (g === hairShell) {
      if (look.hairStyle === 'long' && cut.longHair.has(f)) add('hair', f);
    } else if (eyes.has(g)) add('eyes', f);
    else if (lashes.has(g)) add('lashes', f);
    else if (g === skirt) {
      if (look.bottom === 'skirt') add('bottom', f);
    } else if (g === tights) {
      const limb = LIMBS[cut.limb[f]!]!;
      const t = cut.along[f]!;
      if (limb === 'leg') {
        if (t > 1.97) add('shoes', f);
        else if (t <= leg) add('bottom', f);
      } else if (limb === 'arm') {
        // The sleeves are their own material: a plane across an arm, being
        // infinite, would cut the trunk too.
        if (t <= sleeve) add('sleeves', f);
      } else {
        // Trunk and neck together, cut by height alone: the neckline and the
        // waistband run along the mesh's horizontal loops.
        const y = cut.height[f]!;
        if (y < cut.waistY + 0.35) add('bottom', f);
        if (y > cut.waistY - 0.35 && y < cut.neckY + 0.35 && look.top !== 'none') add('top', f);
      }
    }
  }
  return out;
}

/** Where the waistband sits between the hip joints (0) and the lowest spine joint (1). */
const WAIST_SHARE = 0.4;
/** Along-limb margin faces are kept past a cut, so the clipping plane always has cloth to cut. */
const HEM_MARGIN = 0.18;
/** Where a sleeve ends along the arm: 0 shoulder, 1 elbow, 2 wrist. */
function sleeveEnd(look: PersonLook): number {
  return look.top === 'tank' ? -0.05 : look.top === 'tshirt' ? 0.42 : look.top === 'longsleeve' ? 1.9 : -1;
}
/** Where a leg ends along the leg: 0 hip, 1 knee, 2 ankle. */
function legEnd(look: PersonLook): number {
  return look.bottom === 'trousers' ? 1.93 : look.bottom === 'shorts' ? 0.62 : 0.12;
}

/**
 * The hems, as clipping planes in the mesh's metres: the neck and the waist
 * across the trunk, a sleeve's end across each arm, a leg's end across each
 * leg, each plane perpendicular to its limb. Measured on the MORPHED joints,
 * so they move with the body.
 */
function hemPlanes(data: PersonMeshData, metres: Float32Array, look: PersonLook): { top: Plane[]; sleeves: Plane[]; bottom: Plane[] } {
  const centre = (group: string): Vector3 => {
    const c = new Vector3();
    let n = 0;
    for (const [a, b] of data.vertexGroups[group] ?? []) {
      for (let v = a; v <= b; v++) {
        c.x += metres[v * 3]!;
        c.y += metres[v * 3 + 1]!;
        c.z += metres[v * 3 + 2]!;
        n++;
      }
    }
    return n ? c.divideScalar(n) : c;
  };
  /** A plane across a joint chain at `t`, keeping the side towards the root. */
  const across = (joints: readonly string[], t: number): Plane => {
    const points = joints.map(centre);
    const i = Math.min(points.length - 2, Math.max(0, Math.floor(t)));
    const a = points[i]!, b = points[i + 1]!;
    const dir = b.clone().sub(a).normalize();
    const at = a.clone().lerp(b, t - i);
    // `Plane` keeps what is on its positive side: towards the root.
    return new Plane().setFromNormalAndCoplanarPoint(dir.negate(), at);
  };
  const neck = centre('joint-neck').y - 0.025;
  const pelvisY = centre('joint-pelvis').y;
  const waist = pelvisY + (centre('joint-spine-1').y - pelvisY) * WAIST_SHARE;
  const top: Plane[] = [];
  const sleeves: Plane[] = [];
  const bottom: Plane[] = [];
  if (look.top !== 'none') {
    top.push(new Plane(new Vector3(0, -1, 0), neck), new Plane(new Vector3(0, 1, 0), -waist + 0.03));
    const s = sleeveEnd(look);
    for (const side of ['l', 'r']) sleeves.push(across([`joint-${side}-shoulder`, `joint-${side}-elbow`, `joint-${side}-hand`], s));
  }
  bottom.push(new Plane(new Vector3(0, -1, 0), waist));
  if (look.bottom !== 'skirt') {
    const l = legEnd(look);
    for (const side of ['l', 'r']) bottom.push(across([`joint-${side}-upper-leg`, `joint-${side}-knee`, `joint-${side}-ankle`], l));
  }
  return { top, sleeves, bottom };
}

/** Metres, +Y up, feet on the ground, from the packs' decimetres. */
export function toMetres(positions: Float32Array, out: Float32Array, bodyRange: readonly (readonly [number, number])[]): void {
  let lowest = Infinity;
  for (const [a, b] of bodyRange) for (let v = a; v <= b; v++) lowest = Math.min(lowest, positions[v * 3 + 1]!);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i]! / 10;
    out[i + 1] = (positions[i + 1]! - lowest) / 10;
    out[i + 2] = positions[i + 2]! / 10;
  }
}

export interface PersonMesh {
  readonly mesh: Mesh;
  /** New body shape: positions in the packs' frame (decimetres). */
  setShape(positions: Float32Array): void;
  /** New clothes, hair and colours. */
  setLook(look: PersonLook): void;
  dispose(): void;
}

export function createPersonMesh(
  data: PersonMeshData,
  bodyRange: readonly (readonly [number, number])[],
  positions: Float32Array,
  look: PersonLook,
): PersonMesh {
  const geometry = new BufferGeometry();
  const metres = new Float32Array(data.vertexCount * 3);
  toMetres(positions, metres, bodyRange);
  const position = new BufferAttribute(metres, 3);
  geometry.setAttribute('position', position);
  // Vertex colour carries the skin and the hair on the body, and the eye on the
  // eyeballs; the other materials ignore it.
  const colours = new Float32Array(data.vertexCount * 3).fill(1);
  const colour = new BufferAttribute(colours, 3);
  geometry.setAttribute('color', colour);

  const materials = {
    skin: new MeshStandardMaterial({ roughness: 0.62, metalness: 0, vertexColors: true }),
    top: new MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: DoubleSide }),
    sleeves: new MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: DoubleSide }),
    bottom: new MeshStandardMaterial({ roughness: 0.88, metalness: 0, side: DoubleSide }),
    shoes: new MeshStandardMaterial({ roughness: 0.55, metalness: 0 }),
    hair: new MeshStandardMaterial({ roughness: 0.75, metalness: 0, side: DoubleSide }),
    eyes: new MeshStandardMaterial({ roughness: 0.25, metalness: 0, vertexColors: true }),
    lashes: new MeshStandardMaterial({ color: new Color(0x16110e), roughness: 0.9, side: DoubleSide }),
  } satisfies Record<Part, MeshStandardMaterial>;
  const materialList: Material[] = PART_ORDER.map((p) => materials[p]);
  const mesh = new Mesh(geometry, materialList);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const cut = tailor(data, positions);
  const eyeBalls = ['helper-l-eye', 'helper-r-eye'].map((name) => {
    const g = data.faceGroups.indexOf(name);
    const verts = new Set<number>();
    for (let f = 0; f < data.faceGroup.length; f++) {
      if (data.faceGroup[f] !== g) continue;
      for (let c = 0; c < 4; c++) verts.add(data.faces[f * 4 + c]!);
    }
    return [...verts];
  });
  const skinColour = new Color();
  const hairColour = new Color();
  const iris = new Color();
  let current = look;

  const paintColours = (l: PersonLook): void => {
    skinColour.setHex(l.skin);
    hairColour.setHex(l.hair);
    const showHair = l.hairStyle !== 'none';
    for (const [a, b] of bodyRange) {
      for (let v = a; v <= b; v++) {
        const h = showHair ? cut.hair[v]! : 0;
        colours[v * 3] = skinColour.r + (hairColour.r - skinColour.r) * h;
        colours[v * 3 + 1] = skinColour.g + (hairColour.g - skinColour.g) * h;
        colours[v * 3 + 2] = skinColour.b + (hairColour.b - skinColour.b) * h;
      }
    }
    // Eyes: white, the iris on the front of each eyeball, the pupil in its
    // middle - read from how far forward a vertex is on its own eyeball.
    iris.setHex(l.eyes);
    for (const verts of eyeBalls) {
      let front = -Infinity, back = Infinity;
      for (const v of verts) {
        front = Math.max(front, metres[v * 3 + 2]!);
        back = Math.min(back, metres[v * 3 + 2]!);
      }
      const depth = Math.max(1e-6, front - back);
      for (const v of verts) {
        const t = (front - metres[v * 3 + 2]!) / depth;
        const c = t < 0.02 ? [0.05, 0.04, 0.035] : t < 0.07 ? [iris.r, iris.g, iris.b] : [0.93, 0.91, 0.88];
        colours[v * 3] = c[0]!;
        colours[v * 3 + 1] = c[1]!;
        colours[v * 3 + 2] = c[2]!;
      }
    }
    colour.needsUpdate = true;
    materials.top.color.setHex(l.topColour);
    materials.sleeves.color.setHex(l.topColour);
    materials.bottom.color.setHex(l.bottomColour);
    materials.shoes.color.setHex(l.shoes);
    materials.hair.color.setHex(l.hair);
  };

  const rebuildIndex = (l: PersonLook): void => {
    const parts = facesFor(data, l, cut);
    const index: number[] = [];
    geometry.clearGroups();
    PART_ORDER.forEach((part, materialIndex) => {
      const start = index.length;
      for (const f of parts.get(part)!) {
        const a = data.faces[f * 4]!, b = data.faces[f * 4 + 1]!, c = data.faces[f * 4 + 2]!, d = data.faces[f * 4 + 3]!;
        index.push(a, b, c);
        if (d !== c) index.push(a, c, d);
      }
      if (index.length > start) geometry.addGroup(start, index.length - start, materialIndex);
    });
    geometry.setIndex(index);
    geometry.computeVertexNormals();
  };

  // The hems: the preview renderer turns local clipping on.
  const clip = (l: PersonLook): void => {
    const planes = hemPlanes(data, metres, l);
    materials.top.clippingPlanes = planes.top;
    materials.sleeves.clippingPlanes = planes.sleeves;
    materials.bottom.clippingPlanes = planes.bottom;
  };

  rebuildIndex(look);
  paintColours(look);
  clip(look);
  return {
    mesh,
    setShape(next) {
      toMetres(next, metres, bodyRange);
      position.needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      paintColours(current);
      clip(current);
    },
    setLook(l) {
      const reshaped = l.top !== current.top || l.bottom !== current.bottom || l.hairStyle !== current.hairStyle;
      current = l;
      if (reshaped) rebuildIndex(l);
      paintColours(l);
      clip(l);
    },
    dispose() {
      geometry.dispose();
      for (const m of materialList) m.dispose();
    },
  };
}
