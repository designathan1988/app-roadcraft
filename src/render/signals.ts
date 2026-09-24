import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Scene,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';

import { addScaled, angleOf, perp } from '@core/vec2';
import { crosswalkDistance } from '@world/approach';
import { roadProfile } from '@world/roadTypes';
import type { SimWorld } from '@sim/world';
import type { SegmentId } from '@world/ids';
import { signalStateFor, type SignalState } from '@sim/signals/query';

/**
 * Physical traffic signal heads.
 *
 * ## Why every head is double-sided
 *
 * A real signal aims its lenses at the traffic it controls and shows the
 * approach behind it nothing but a black box. That is correct on a street and
 * wrong in this game: the camera is locked to one isometric diagonal, so at any
 * junction roughly half the heads faced away and the player saw unlit boxes. A
 * player looking at a junction where every visible head was a dark rectangle
 * reported, reasonably, that the signals "have no green or amber light".
 *
 * So each head carries a lens cluster on BOTH faces of its housing. The pair is
 * driven from one state, which is also what a real repeater head does, and it
 * costs three extra discs per head.
 *
 * ## Why a dark lens is still coloured
 *
 * The unlit lenses used to be almost black — 0x42110f against a 0x101410
 * housing — so a head showed one glowing dot and nothing else, and the other
 * two colours were invisible rather than merely off. A real lens is a coloured
 * filter over a dark can: you can see it is red, amber and green from across a
 * junction with the lamp out. The dark materials here keep their hue and a
 * faint emissive floor, so all three lenses read at a glance and the lit one is
 * unmistakably the one that is on.
 *
 * ## The lit lamp
 *
 * Emissive, unlit, and NOT tone mapped. Everything else in the scene goes
 * through ACES, which rolls a bright saturated colour towards white; a signal
 * lamp is one of the few things that must keep its hue at full brightness, the
 * same argument that makes vehicle lamps and street lights basic materials.
 * A larger, dimmer halo disc sits behind the lens so the lamp reads as a source
 * rather than as a painted dot.
 */

/** Metres to world units. The simulation uses 0.4 m per unit. */
const m = (metres: number): number => metres / 0.4;

/**
 * Signal heads are drawn at 1.5 times life size.
 *
 * Deliberately, and it is the only object in the scene that is. A real signal
 * head is 0.6 m across, which against a 46-unit boulevard is four pixels at the
 * zoom the game is played at — correct, and useless: the lamp is the single
 * piece of information the player most needs to read from a junction. Everything
 * else stays to scale, so the head reads as slightly generous rather than as a
 * different world.
 */
const SIGNAL_SCALE = 1.5;
const u = (metres: number): number => m(metres) * SIGNAL_SCALE;

const POST_HEIGHT = u(6.2);
const POST_RADIUS = u(0.11);
const ARM_LENGTH = u(3.5);
const ARM_RADIUS = u(0.08);
const HEAD_HEIGHT = u(1.55);
const HEAD_WIDTH = u(0.62);
const HEAD_DEPTH = u(0.42);
const LAMP_RADIUS = u(0.21);
const VISOR_DEPTH = u(0.2);
const KERB_CLEARANCE = m(0.9);
const HEAD_CENTRE = u(5.5);
/** Vertical spacing between lens centres. */
const LAMP_PITCH = HEAD_HEIGHT * 0.3;

type Lamp = 'red' | 'amber' | 'green';
const LAMPS: readonly Lamp[] = ['red', 'amber', 'green'];
/** Which way each lens cluster looks, along the housing's local Z. */
const FACES = [1, -1] as const;

export interface SignalHeads {
  readonly group: Group;
  sync(world: SimWorld, detailed: boolean): void;
  dispose(): void;
}

/**
 * One kind of part, for every head on the map: a single instanced mesh.
 *
 * A head used to be a dozen meshes of its own - post, arm, housing, three
 * visors, lenses and halos on both faces - and each was drawn once for the
 * picture, once for the shadow map and once more for the ambient-occlusion
 * pass. Forty heads were over a thousand draw calls a frame, more than the
 * whole rest of the scene. Now every post is one draw, every visor another,
 * and so on: nine for the whole map, however many junctions it has.
 */
interface Batch {
  mesh: InstancedMesh;
  /** Write cursor, reset at the top of every sync. */
  n: number;
}

/** Heads the batches are first sized for; they double when a map needs more. */
const INITIAL_HEADS = 64;

/** Builds and updates the physical signal heads used by the Three.js renderer. */
export function createSignalHeads(
  scene: Scene,
  elevationAt: (world: SimWorld, x: number, y: number, segment?: SegmentId) => number = () => 0,
): SignalHeads {
  const group = new Group();
  group.name = 'traffic-signals';
  scene.add(group);

  const postGeometry = new CylinderGeometry(POST_RADIUS, POST_RADIUS, POST_HEIGHT, 8);
  const armGeometry = new CylinderGeometry(ARM_RADIUS, ARM_RADIUS, ARM_LENGTH, 8);
  const housingGeometry = new BoxGeometry(HEAD_WIDTH, HEAD_HEIGHT, HEAD_DEPTH);
  // A flat disc rather than a sphere: a lens is a disc, and an orthographic
  // camera never sees enough of a sphere's curvature to justify the triangles.
  const lensGeometry = new CylinderGeometry(LAMP_RADIUS, LAMP_RADIUS, u(0.06), 12).rotateX(
    Math.PI / 2,
  );
  const haloGeometry = new CylinderGeometry(LAMP_RADIUS * 1.8, LAMP_RADIUS * 1.8, u(0.02), 12)
    .rotateX(Math.PI / 2);
  const visorGeometry = new BoxGeometry(LAMP_RADIUS * 2.5, u(0.06), VISOR_DEPTH);

  const steel = new MeshStandardMaterial({ color: 0x2b302d, roughness: 0.7, metalness: 0.45 });
  const housing = new MeshStandardMaterial({ color: 0x15191a, roughness: 0.78, metalness: 0.1 });
  // Lit lenses keep their hue at full brightness: basic and untone-mapped,
  // white here and coloured per instance.
  const lit = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const LIT: Record<Lamp, Color> = {
    red: new Color(0xff4034),
    amber: new Color(0xffb219),
    green: new Color(0x3bf06a),
  };
  // Off, but still obviously a coloured filter over a dark can. Each colour
  // keeps its own faint emissive floor, so each is its own material.
  const dark: Record<Lamp, MeshStandardMaterial> = {
    red: lensMaterial(0x8d221c, 0x2a0705),
    amber: lensMaterial(0x8a6410, 0x281c04),
    green: lensMaterial(0x1d6b33, 0x07230f),
  };
  const halo = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.28 });
  const HALO: Record<Lamp, Color> = {
    red: new Color(0xff5145),
    amber: new Color(0xffc850),
    green: new Color(0x59ff86),
  };

  let capacity = INITIAL_HEADS;
  const make = (name: string, geometry: BufferGeometry, material: Material, perHead: number,
    shadows: { cast: boolean; receive: boolean }, coloured: boolean): Batch => {
    const mesh = new InstancedMesh(geometry, material, capacity * perHead);
    mesh.name = name;
    mesh.count = 0;
    mesh.castShadow = shadows.cast;
    mesh.receiveShadow = shadows.receive;
    // Rewritten every frame, so a bounding sphere computed once would be wrong.
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    if (coloured) {
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * perHead * 3).fill(1), 3);
      mesh.instanceColor.setUsage(DynamicDrawUsage);
    }
    group.add(mesh);
    return { mesh, n: 0 };
  };
  const solid = { cast: true, receive: true };
  const shading = { cast: true, receive: false };
  const glow = { cast: false, receive: false };
  const specs = () => ({
    posts: make('signal-posts', postGeometry, steel, 1, solid, false),
    arms: make('signal-arms', armGeometry, steel, 1, solid, false),
    boxes: make('signal-boxes', housingGeometry, housing, 1, solid, false),
    visors: make('signal-visors', visorGeometry, housing, LAMPS.length * FACES.length, shading, false),
    lit: make('signal-lamps-lit', lensGeometry, lit, FACES.length, glow, true),
    halos: make('signal-halos', haloGeometry, halo, FACES.length, glow, true),
    red: make('signal-lamps-red', lensGeometry, dark.red, FACES.length, glow, false),
    amber: make('signal-lamps-amber', lensGeometry, dark.amber, FACES.length, glow, false),
    green: make('signal-lamps-green', lensGeometry, dark.green, FACES.length, glow, false),
  });
  let batches = specs();
  const all = (): Batch[] => Object.values(batches);

  const grow = (heads: number): void => {
    for (const batch of all()) {
      group.remove(batch.mesh);
      batch.mesh.dispose();
    }
    while (capacity < heads) capacity *= 2;
    batches = specs();
  };

  // Where each part sits in its head, relative to the foot of the post.
  const at = (x: number, y: number, z: number, rotateZ = 0): Matrix4 =>
    new Matrix4().makeRotationZ(rotateZ).setPosition(x, y, z);
  const POST = at(0, POST_HEIGHT / 2, 0);
  const ARM = at(ARM_LENGTH / 2, POST_HEIGHT - u(0.3), 0, -Math.PI / 2);
  const BOX = at(ARM_LENGTH, HEAD_CENTRE, 0);
  const lens: Record<Lamp, Matrix4[]> = { red: [], amber: [], green: [] };
  const halos: Record<Lamp, Matrix4[]> = { red: [], amber: [], green: [] };
  const visors: Matrix4[] = [];
  LAMPS.forEach((name, index) => {
    const y = HEAD_CENTRE + LAMP_PITCH * (1 - index);
    for (const face of FACES) {
      const z = (HEAD_DEPTH / 2 + u(0.03)) * face;
      halos[name].push(at(ARM_LENGTH, y, z * 0.96));
      lens[name].push(at(ARM_LENGTH, y, z));
      // A hood over each lens. It is what stops three coloured discs on a
      // black slab reading as a decal, and it shades the lens below it.
      visors.push(at(ARM_LENGTH, y + LAMP_RADIUS * 1.15, z + (VISOR_DEPTH / 2) * face));
    }
  });

  const root = new Matrix4();
  const place = new Matrix4();
  const turn = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const foot = new Vector3();
  const one = new Vector3(1, 1, 1);
  const put = (batch: Batch, local: Matrix4, colour?: Color): void => {
    place.multiplyMatrices(root, local);
    batch.mesh.setMatrixAt(batch.n, place);
    if (colour) batch.mesh.setColorAt(batch.n, colour);
    batch.n++;
  };

  /** What each head shows, by `node:segment`, for the verification harness. */
  const shown = new Map<string, SignalState>();
  group.userData.heads = shown;

  return {
    group,
    sync(world, detailed) {
      if (!detailed) {
        group.visible = false;
        return;
      }
      group.visible = true;
      shown.clear();
      type Placed = { x: number; height: number; y: number; yaw: number; state: SignalState; key: string };
      const placed: Placed[] = [];
      for (const node of world.junctionNodesInOrder()) {
        const junction = world.graph.junctions.get(node);
        const controller = world.controller(node);
        if (!junction?.signalised || !controller) continue;
        const nodeRecord = world.doc.node(node);
        if (!nodeRecord) continue;

        for (const segmentId of nodeRecord.incident) {
          const segment = world.doc.segment(segmentId);
          if (!segment) continue;
          const signalGroup = junction.groups.find((candidate) =>
            candidate.segments.includes(segmentId),
          );
          if (!signalGroup) continue;

          const road = roadProfile(segment.type, segment.lanes, segment.direction);
          const mouth = world.net.mouthDistance(segmentId, node);
          const polyline = world.net.polylines.get(world.doc, segmentId);
          // Sample outward from the node to find the kerb position, then reverse
          // that tangent: traffic on this approach travels TOWARD the node.
          // Using the outward tangent put every head on the driver's left.
          const outward = segment.a === node ? polyline : polyline.reversed();
          const distance = Math.min(crosswalkDistance(mouth) + m(2), outward.length * 0.45);
          const frame = outward.sampleAt(distance);
          const travel = { x: -frame.t.x, y: -frame.t.y };
          const left = perp(travel);
          const right = { x: -left.x, y: -left.y };
          const position = addScaled(frame.p, right, road.width / 2 + KERB_CLEARANCE);
          const key = `${node}:${segmentId}`;
          const state = signalStateFor(controller, signalGroup.id);
          placed.push({
            x: position.x,
            height: elevationAt(world, position.x, position.y, segmentId),
            y: position.y,
            // Local +X carries the arm inward over the road. Under the shared
            // world-to-Three mapping, the world heading is also the Three yaw.
            yaw: angleOf({ x: -right.x, y: -right.y }),
            state,
            key,
          });
          shown.set(key, state);
        }
      }

      if (placed.length > capacity) grow(placed.length);
      for (const batch of all()) batch.n = 0;
      let litLenses = 0;
      for (const head of placed) {
        root.compose(foot.set(head.x, head.height, -head.y), turn.setFromAxisAngle(up, head.yaw), one);
        put(batches.posts, POST);
        put(batches.arms, ARM);
        put(batches.boxes, BOX);
        for (const visor of visors) put(batches.visors, visor);
        for (const name of LAMPS) {
          const on = head.state === name;
          for (let face = 0; face < FACES.length; face++) {
            if (on) {
              put(batches.lit, lens[name][face] as Matrix4, LIT[name]);
              put(batches.halos, halos[name][face] as Matrix4, HALO[name]);
              litLenses++;
            } else {
              put(batches[name], lens[name][face] as Matrix4);
            }
          }
        }
      }
      // Only the written prefix of each buffer goes to the GPU.
      for (const batch of all()) {
        const mesh = batch.mesh;
        mesh.count = batch.n;
        mesh.instanceMatrix.clearUpdateRanges();
        if (batch.n > 0) mesh.instanceMatrix.addUpdateRange(0, batch.n * 16);
        mesh.instanceMatrix.needsUpdate = true;
        const colour = mesh.instanceColor;
        if (colour) {
          colour.clearUpdateRanges();
          if (batch.n > 0) colour.addUpdateRange(0, batch.n * 3);
          colour.needsUpdate = true;
        }
      }
      group.userData.lamps = placed.length * LAMPS.length * FACES.length;
      group.userData.litLamps = litLenses;
    },
    dispose() {
      scene.remove(group);
      for (const batch of all()) batch.mesh.dispose();
      group.clear();
      shown.clear();
      for (const geometry of [
        postGeometry,
        armGeometry,
        housingGeometry,
        lensGeometry,
        haloGeometry,
        visorGeometry,
      ]) {
        geometry.dispose();
      }
      const materials: Material[] = [steel, housing, lit, halo, ...Object.values(dark)];
      for (const material of materials) material.dispose();
    },
  };
}

/** An unlit lens: a coloured filter with a faint glow, over a dark can. */
function lensMaterial(color: number, emissive: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity: 1,
    roughness: 0.35,
    metalness: 0,
  });
}
