import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Scene,
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

interface Head {
  readonly root: Group;
  /** Both faces' lenses for each colour, driven together. */
  readonly lamps: Record<Lamp, Mesh[]>;
  readonly halos: Record<Lamp, Mesh[]>;
}

export interface SignalHeads {
  readonly group: Group;
  sync(world: SimWorld, detailed: boolean): void;
  dispose(): void;
}

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
  // Lit lenses keep their hue at full brightness: basic and untone-mapped.
  const lit: Record<Lamp, MeshBasicMaterial> = {
    red: new MeshBasicMaterial({ color: 0xff4034, toneMapped: false }),
    amber: new MeshBasicMaterial({ color: 0xffb219, toneMapped: false }),
    green: new MeshBasicMaterial({ color: 0x3bf06a, toneMapped: false }),
  };
  // Off, but still obviously a coloured filter over a dark can.
  const dark: Record<Lamp, MeshStandardMaterial> = {
    red: lensMaterial(0x8d221c, 0x2a0705),
    amber: lensMaterial(0x8a6410, 0x281c04),
    green: lensMaterial(0x1d6b33, 0x07230f),
  };
  const halo: Record<Lamp, MeshBasicMaterial> = {
    red: haloMaterial(0xff5145),
    amber: haloMaterial(0xffc850),
    green: haloMaterial(0x59ff86),
  };

  const heads = new Map<string, Head>();
  const seen = new Set<string>();

  const makeHead = (key: string): Head => {
    const root = new Group();
    root.name = `signal-head-${key}`;

    const post = new Mesh(postGeometry, steel);
    post.name = `signal-post-${key}`;
    post.position.y = POST_HEIGHT / 2;

    const arm = new Mesh(armGeometry, steel);
    arm.name = `signal-arm-${key}`;
    arm.rotation.z = -Math.PI / 2;
    arm.position.set(ARM_LENGTH / 2, POST_HEIGHT - u(0.3), 0);

    const box = new Mesh(housingGeometry, housing);
    box.name = `signal-box-${key}`;
    box.position.set(ARM_LENGTH, HEAD_CENTRE, 0);

    for (const mesh of [post, arm, box]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      root.add(mesh);
    }

    const lamps: Record<Lamp, Mesh[]> = { red: [], amber: [], green: [] };
    const halos: Record<Lamp, Mesh[]> = { red: [], amber: [], green: [] };
    LAMPS.forEach((name, index) => {
      const y = HEAD_CENTRE + LAMP_PITCH * (1 - index);
      for (const face of FACES) {
        const z = (HEAD_DEPTH / 2 + u(0.03)) * face;

        const glow = new Mesh(haloGeometry, halo[name]);
        glow.name = `signal-halo-${name}-${key}`;
        glow.position.set(ARM_LENGTH, y, z * 0.96);
        glow.visible = false;
        root.add(glow);
        halos[name].push(glow);

        const lens = new Mesh(lensGeometry, dark[name]);
        lens.name = `signal-lamp-${name}-${key}`;
        lens.position.set(ARM_LENGTH, y, z);
        root.add(lens);
        lamps[name].push(lens);

        // A hood over each lens. It is what stops three coloured discs on a
        // black slab reading as a decal, and it shades the lens below it.
        const visor = new Mesh(visorGeometry, housing);
        visor.name = `signal-visor-${name}-${key}`;
        visor.position.set(ARM_LENGTH, y + LAMP_RADIUS * 1.15, z + (VISOR_DEPTH / 2) * face);
        visor.castShadow = true;
        root.add(visor);
      }
    });

    group.add(root);
    return { root, lamps, halos };
  };

  return {
    group,
    sync(world, detailed) {
      if (!detailed) {
        if (group.visible) {
          group.visible = false;
          seen.clear();
        }
        return;
      }
      group.visible = true;
      seen.clear();
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
          seen.add(key);
          let head = heads.get(key);
          if (!head) {
            head = makeHead(key);
            heads.set(key, head);
          }

          head.root.visible = true;
          head.root.position.set(
            position.x,
            elevationAt(world, position.x, position.y, segmentId),
            -position.y,
          );
          // Local +X carries the arm inward over the road. Under the shared
          // world-to-Three mapping, the world heading is also the Three yaw.
          head.root.rotation.y = angleOf({ x: -right.x, y: -right.y });
          setLamps(head, signalStateFor(controller, signalGroup.id), lit, dark);
        }
      }

      // A head whose junction is gone is REMOVED, not hidden. Hiding it left it
      // in the scene graph for the rest of the session: every frame traversed
      // it, every rebuild added more, and a long editing session ended up
      // walking hundreds of invisible objects.
      for (const [key, head] of heads) {
        if (seen.has(key)) continue;
        group.remove(head.root);
        head.root.clear();
        heads.delete(key);
      }
    },
    dispose() {
      scene.remove(group);
      group.clear();
      heads.clear();
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
      const materials: Material[] = [
        steel,
        housing,
        ...Object.values(lit),
        ...Object.values(dark),
        ...Object.values(halo),
      ];
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

function haloMaterial(color: number): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.28 });
}

function setLamps(
  head: Head,
  state: SignalState,
  lit: Record<Lamp, MeshBasicMaterial>,
  dark: Record<Lamp, MeshStandardMaterial>,
): void {
  for (const name of LAMPS) {
    const on = state === name;
    for (const lens of head.lamps[name]) {
      lens.material = on ? lit[name] : dark[name];
      lens.userData['active'] = on;
    }
    for (const glow of head.halos[name]) glow.visible = on;
  }
  head.root.userData['state'] = state;
}
