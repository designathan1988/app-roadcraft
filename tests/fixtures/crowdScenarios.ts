import { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { roadProfile } from '@world/roadTypes';
import { bandMid, sectionOf } from '@world/section';
import { streetFurniture } from '@world/streetFurniture';
import { m } from '@world/units';
import type { Vec2 } from '@core/vec2';
import type { SegmentId } from '@world/ids';

/**
 * PEDESTRIAN SCENARIOS, reproducible: small maps and people placed on them
 * with a start, a goal and a pace, for the crowd engine (`sim/people/crowd.ts`)
 * to be measured on (`tests/sim/people/crowdScenarios.spec.ts`) and looked
 * at in the running game (`.claude/_crowd-scenario.mjs`). The same builder
 * serves both, so what is photographed is what is measured.
 */

export interface ScenarioWalker {
  readonly x: number;
  readonly y: number;
  readonly goal: Vec2;
  readonly pace?: number;
  /** Index (in this list) of the walker it walks with. */
  readonly leader?: number;
}

export interface Scenario {
  readonly name: string;
  readonly doc: RoadDoc;
  /** Seconds to run. */
  readonly seconds: number;
  /** Where to look at it from: the middle of the action. */
  readonly focus: Vec2;
  /** The people, placed once the network is built. */
  readonly walkers: (net: Network) => ScenarioWalker[];
}

const URBAN = 1;
const LOCAL = 0;

/**
 * A point on a road's footway: `along` u from its `a` end, on `side` (+1 the
 * left of a to b), `across` u from the middle of the through zone (+ away
 * from the road).
 */
export function onFootway(net: Network, seg: SegmentId, along: number, side: 1 | -1, across = 0): Vec2 {
  const ribbon = net.ribbons.get(seg)!;
  const segment = net.doc.requireSegment(seg);
  const section = sectionOf(roadProfile(segment.type, segment.lanes, segment.direction), segment.direction);
  const f = ribbon.full.sampleAt(Math.max(0, Math.min(ribbon.full.length, along)));
  const off = bandMid(section.side.through) + across;
  return { x: f.p.x + f.n.x * off * side, y: f.p.y + f.n.y * off * side };
}

function straight(type: number, length = 320): RoadDoc {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -length / 2, y: 0 }), b = doc.addNode({ x: length / 2, y: 0 });
  doc.addSegment(a.id, b.id, type);
  return doc;
}

function crossroads(signal: boolean): RoadDoc {
  const doc = new RoadDoc();
  const c = doc.addNode({ x: 0, y: 0 });
  for (const [x, y] of [[200, 0], [0, 200], [-200, 0], [0, -200]] as const) doc.addSegment(c.id, doc.addNode({ x, y }).id, URBAN);
  if (signal) doc.setNodeControl(c.id, 'signal');
  return doc;
}

/** A road turning sharply at a node: legs `angle` degrees apart. */
function bend(angle: number): RoadDoc {
  const doc = new RoadDoc();
  const c = doc.addNode({ x: 0, y: 0 });
  const r = (angle * Math.PI) / 180;
  const a = doc.addNode({ x: 200, y: 0 }), b = doc.addNode({ x: 200 * Math.cos(r), y: 200 * Math.sin(r) });
  doc.addSegment(a.id, c.id, URBAN);
  doc.addSegment(c.id, b.id, URBAN);
  return doc;
}

/**
 * A straight road with a fence of utility poles across its north footway at
 * x = 0, leaving one opening `opening` u wide (between the poles' surfaces)
 * centred `centre` u from the road's centreline. The poles stand closer than
 * a body anywhere else: the opening is the only way through.
 */
const POLE_R = m(0.18);
function gate(opening: number, centre: number, type = URBAN): RoadDoc {
  const doc = straight(type);
  const lo = centre - opening / 2 - POLE_R, hi = centre + opening / 2 + POLE_R;
  // From the kerb (urban: 11 u from the centreline) to the footway's outer edge (16 u).
  for (let y = lo; y > 10.5; y -= POLE_R * 2 + m(0.04)) doc.addPole({ x: 0, y });
  for (let y = hi; y < 16.6; y += POLE_R * 2 + m(0.04)) doc.addPole({ x: 0, y });
  return doc;
}

/** The one segment of a straight map, and the leg of a crossroads that runs off towards `(dx, dy)`. */
const only = (net: Network): SegmentId => [...net.doc.segments.keys()][0]!;
function leg(net: Network, dx: number, dy: number): SegmentId {
  for (const [id, seg] of net.doc.segments) {
    const n = net.doc.requireNode(seg.b);
    const o = net.doc.requireNode(seg.a);
    const far = Math.hypot(n.x, n.y) > Math.hypot(o.x, o.y) ? n : o;
    if (Math.sign(far.x) === Math.sign(dx) && Math.sign(far.y) === Math.sign(dy)) return id;
  }
  throw new Error('no such leg');
}

/** Small deterministic random numbers for the crowd scenario. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'head-on', doc: straight(URBAN), seconds: 50, focus: { x: 0, y: 0 },
    walkers: (net) => {
      const s = only(net), L = net.ribbons.get(s)!.full.length;
      return [
        { ...onFootway(net, s, L / 2 - m(15), 1), goal: onFootway(net, s, L / 2 + m(15), 1) },
        { ...onFootway(net, s, L / 2 + m(15), 1), goal: onFootway(net, s, L / 2 - m(15), 1) },
      ];
    },
  },
  {
    name: 'bidirectional-10', doc: straight(URBAN), seconds: 70, focus: { x: 0, y: 0 },
    walkers: (net) => {
      const s = only(net), L = net.ribbons.get(s)!.full.length;
      const out: ScenarioWalker[] = [];
      for (let k = 0; k < 5; k++) {
        const lat = (k % 2 ? 1 : -1) * m(0.25);
        out.push({ ...onFootway(net, s, L / 2 - m(15) - k * m(2.5), 1, lat), goal: onFootway(net, s, L / 2 + m(25) + k * m(2), 1) });
        out.push({ ...onFootway(net, s, L / 2 + m(15) + k * m(2.5), 1, -lat), goal: onFootway(net, s, L / 2 - m(25) - k * m(2), 1) });
      }
      return out;
    },
  },
  {
    name: 'overtake', doc: straight(URBAN), seconds: 90, focus: { x: 0, y: 0 },
    walkers: (net) => {
      const s = only(net), L = net.ribbons.get(s)!.full.length;
      return [
        { ...onFootway(net, s, L / 2 - m(12), 1), goal: onFootway(net, s, L / 2 + m(25), 1), pace: m(0.6) },
        { ...onFootway(net, s, L / 2 - m(18), 1), goal: onFootway(net, s, L / 2 + m(30), 1), pace: m(1.6) },
      ];
    },
  },
  {
    name: 'corner-90', doc: crossroads(false), seconds: 50, focus: { x: 20, y: 20 },
    walkers: (net) => {
      const east = leg(net, 1, 0), north = leg(net, 0, 1);
      // From the east leg's footway on the north side, round the corner, up the north leg's east side.
      const e = net.doc.requireSegment(east), nn = net.doc.requireSegment(north);
      const eAtCentre = net.doc.requireNode(e.a).x === 0 ? 0 : net.ribbons.get(east)!.full.length;
      const nAtCentre = net.doc.requireNode(nn.a).y === 0 ? 0 : net.ribbons.get(north)!.full.length;
      const eStart = Math.abs(eAtCentre - m(25)), nGoal = Math.abs(nAtCentre - m(25));
      const sideE: 1 | -1 = onFootway(net, east, eStart, 1).y > 0 ? 1 : -1;
      const sideN: 1 | -1 = onFootway(net, north, nGoal, 1).x > 0 ? 1 : -1;
      return [
        { ...onFootway(net, east, eStart, sideE), goal: onFootway(net, north, nGoal, sideN) },
        { ...onFootway(net, north, nGoal, sideN), goal: onFootway(net, east, eStart, sideE) },
      ];
    },
  },
  {
    name: 'tight-bend', doc: bend(60), seconds: 60, focus: { x: 10, y: 10 },
    walkers: (net) => {
      const [s0, s1] = [...net.doc.segments.keys()] as [SegmentId, SegmentId];
      const L0 = net.ribbons.get(s0)!.full.length;
      // Along both footways, through the sharp turn and back.
      return [
        { ...onFootway(net, s0, L0 - m(20), 1), goal: onFootway(net, s1, m(20), 1) },
        { ...onFootway(net, s0, L0 - m(20), -1), goal: onFootway(net, s1, m(20), -1) },
        { ...onFootway(net, s1, m(20), 1), goal: onFootway(net, s0, L0 - m(20), 1) },
      ];
    },
  },
  {
    name: 'post', doc: straight(URBAN), seconds: 45, focus: { x: 0, y: 0 },
    walkers: (net) => {
      // A lamp column: walking the line it stands on, both ways.
      const lamp = streetFurniture(net).find((i) => i.kind === 'lamp')!;
      const t = { x: lamp.along.x, y: lamp.along.y };
      return [
        { x: lamp.x - t.x * m(10), y: lamp.y - t.y * m(10), goal: { x: lamp.x + t.x * m(10), y: lamp.y + t.y * m(10) } },
        { x: lamp.x + t.x * m(12), y: lamp.y + t.y * m(12), goal: { x: lamp.x - t.x * m(10), y: lamp.y - t.y * m(10) } },
      ];
    },
  },
  {
    name: 'bench', doc: straight(URBAN), seconds: 45, focus: { x: 0, y: 0 },
    walkers: (net) => {
      const bench = streetFurniture(net).find((i) => i.kind === 'bench')!;
      const t = { x: bench.along.x, y: bench.along.y };
      return [
        { x: bench.x - t.x * m(10), y: bench.y - t.y * m(10), goal: { x: bench.x + t.x * m(10), y: bench.y + t.y * m(10) } },
      ];
    },
  },
  {
    name: 'bottleneck', doc: straight(LOCAL), seconds: 80, focus: { x: 0, y: 0 },
    walkers: (net) => {
      const s = only(net), L = net.ribbons.get(s)!.full.length;
      const out: ScenarioWalker[] = [];
      for (let k = 0; k < 6; k++) {
        out.push({ ...onFootway(net, s, L / 2 - m(10) - k * m(1.6), 1), goal: onFootway(net, s, L / 2 + m(22) + k * m(2), 1) });
        out.push({ ...onFootway(net, s, L / 2 + m(10) + k * m(1.6), 1), goal: onFootway(net, s, L / 2 - m(22) - k * m(2), 1) });
      }
      return out;
    },
  },
  {
    // 150 s: the longest trips cross the signalled junction corner to corner
    // over two zebras, 48-80 m with a wait for green at each - traced at
    // 100-120 s, walking at pace throughout. (At 90 s five were still on
    // their way, not stuck.)
    name: 'crowd', doc: crossroads(true), seconds: 150, focus: { x: 0, y: 0 },
    walkers: (net) => {
      const r = rng(7);
      const legs = [...net.doc.segments.keys()];
      const spot = (): Vec2 => {
        const s = legs[Math.floor(r() * legs.length)]!;
        const L = net.ribbons.get(s)!.full.length;
        const centreAtA = Math.hypot(net.doc.requireNode(net.doc.requireSegment(s).a).x, net.doc.requireNode(net.doc.requireSegment(s).a).y) < 1;
        const d = m(12) + r() * m(30);
        return onFootway(net, s, centreAtA ? d : L - d, r() < 0.5 ? 1 : -1, (r() - 0.5) * m(0.4));
      };
      // Nobody placed on top of anybody (the engine's own spawning keeps people apart the same way).
      const out: ScenarioWalker[] = [];
      const clear = (p: Vec2): boolean => out.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > m(1.2));
      while (out.length < 40) {
        const from = spot();
        if (clear(from)) out.push({ ...from, goal: spot() });
      }
      return out;
    },
  },
  {
    name: 'queue', doc: crossroads(true), seconds: 90, focus: { x: 30, y: 25 },
    walkers: (net) => {
      // Eight people on the east leg's north footway, all to the south side across the east leg's zebra.
      const east = leg(net, 1, 0);
      const e = net.doc.requireSegment(east);
      const centreAtA = net.doc.requireNode(e.a).x === 0;
      const L = net.ribbons.get(east)!.full.length;
      const at = (d: number) => (centreAtA ? d : L - d);
      const north: 1 | -1 = onFootway(net, east, at(m(20)), 1).y > 0 ? 1 : -1;
      const out: ScenarioWalker[] = [];
      for (let k = 0; k < 8; k++) out.push({ ...onFootway(net, east, at(m(16) + k * m(1.4)), north, (k % 2 ? 1 : -1) * m(0.2)), goal: onFootway(net, east, at(m(18) + k * m(2)), north === 1 ? -1 : 1) });
      return out;
    },
  },
  {
    name: 'release-both', doc: crossroads(true), seconds: 90, focus: { x: 30, y: 0 },
    walkers: (net) => {
      const east = leg(net, 1, 0);
      const e = net.doc.requireSegment(east);
      const centreAtA = net.doc.requireNode(e.a).x === 0;
      const L = net.ribbons.get(east)!.full.length;
      const at = (d: number) => (centreAtA ? d : L - d);
      const out: ScenarioWalker[] = [];
      for (let k = 0; k < 6; k++) {
        out.push({ ...onFootway(net, east, at(m(16) + k * m(1.4)), 1), goal: onFootway(net, east, at(m(20) + k * m(2)), -1) });
        out.push({ ...onFootway(net, east, at(m(16) + k * m(1.4)), -1), goal: onFootway(net, east, at(m(20) + k * m(2)), 1) });
      }
      return out;
    },
  },
  {
    name: 'group', doc: straight(URBAN), seconds: 50, focus: { x: 0, y: 0 },
    walkers: (net) => {
      const s = only(net), L = net.ribbons.get(s)!.full.length;
      const goal = onFootway(net, s, L / 2 + m(25), 1);
      return [
        { ...onFootway(net, s, L / 2 - m(15), 1), goal },
        { ...onFootway(net, s, L / 2 - m(16), 1, m(0.3)), goal: onFootway(net, s, L / 2 + m(24), 1, m(0.3)), leader: 0 },
        { ...onFootway(net, s, L / 2 - m(16.5), 1, -m(0.3)), goal: onFootway(net, s, L / 2 + m(24), 1, -m(0.3)), leader: 0 },
        // Somebody coming the other way past the group.
        { ...onFootway(net, s, L / 2 + m(20), 1), goal: onFootway(net, s, L / 2 - m(25), 1) },
      ];
    },
  },
  {
    // Fifteen each way on an urban footway, a person every 1.2 m.
    name: 'bidirectional-dense', doc: straight(URBAN), seconds: 90, focus: { x: 0, y: 0 },
    walkers: (net) => {
      const s = only(net), L = net.ribbons.get(s)!.full.length;
      const r = rng(11);
      const out: ScenarioWalker[] = [];
      for (let k = 0; k < 15; k++) {
        out.push({ ...onFootway(net, s, L / 2 - m(10) - k * m(1.2), 1, (r() - 0.5) * m(0.8)), goal: onFootway(net, s, L / 2 + m(30) + k * m(1.2), 1, (r() - 0.5) * m(0.6)) });
        out.push({ ...onFootway(net, s, L / 2 + m(10) + k * m(1.2), 1, (r() - 0.5) * m(0.8)), goal: onFootway(net, s, L / 2 - m(30) - k * m(1.2), 1, (r() - 0.5) * m(0.6)) });
      }
      return out;
    },
  },
  {
    // A slow walker ahead of two on a narrow local footway, and somebody coming the other way.
    name: 'slow-ahead', doc: straight(LOCAL), seconds: 90, focus: { x: 0, y: 0 },
    walkers: (net) => {
      const s = only(net), L = net.ribbons.get(s)!.full.length;
      return [
        { ...onFootway(net, s, L / 2 - m(8), 1), goal: onFootway(net, s, L / 2 + m(30), 1), pace: m(0.5) },
        { ...onFootway(net, s, L / 2 - m(14), 1), goal: onFootway(net, s, L / 2 + m(32), 1) },
        { ...onFootway(net, s, L / 2 - m(17), 1), goal: onFootway(net, s, L / 2 + m(34), 1) },
        { ...onFootway(net, s, L / 2 + m(12), 1), goal: onFootway(net, s, L / 2 - m(30), 1) },
      ];
    },
  },
  {
    // Two walking side by side meet one coming the other way on a local footway.
    name: 'side-by-side', doc: straight(LOCAL), seconds: 50, focus: { x: 0, y: 0 },
    walkers: (net) => {
      const s = only(net), L = net.ribbons.get(s)!.full.length;
      return [
        { ...onFootway(net, s, L / 2 - m(12), 1, -m(0.3)), goal: onFootway(net, s, L / 2 + m(20), 1, -m(0.3)) },
        { ...onFootway(net, s, L / 2 - m(12), 1, m(0.3)), goal: onFootway(net, s, L / 2 + m(20), 1, m(0.3)), leader: 0 },
        { ...onFootway(net, s, L / 2 + m(12), 1), goal: onFootway(net, s, L / 2 - m(20), 1) },
      ];
    },
  },
  {
    // An opening one person wide (0.8 m between poles), three from each side.
    name: 'gap-one', doc: gate(m(0.8), 13.9), seconds: 90, focus: { x: 0, y: 14 },
    walkers: (net) => {
      const out: ScenarioWalker[] = [];
      for (let k = 0; k < 3; k++) {
        out.push({ x: -m(5) - k * m(1.3), y: 14 + (k % 2 ? 1 : -1) * m(0.2), goal: { x: m(12) + k * m(1.5), y: 14 } });
        out.push({ x: m(5) + k * m(1.3), y: 14 - (k % 2 ? 1 : -1) * m(0.2), goal: { x: -m(12) - k * m(1.5), y: 14 } });
      }
      void net;
      return out;
    },
  },
  {
    // An opening two people wide (1.4 m between poles), five from each side.
    name: 'gap-two', doc: gate(m(1.4), 13.9), seconds: 90, focus: { x: 0, y: 14 },
    walkers: (net) => {
      const out: ScenarioWalker[] = [];
      for (let k = 0; k < 5; k++) {
        out.push({ x: -m(5) - k * m(1.2), y: 14 + (k % 2 ? 1 : -1) * m(0.25), goal: { x: m(12) + k * m(1.5), y: 14 + (k % 2 ? 1 : -1) * m(0.25) } });
        out.push({ x: m(5) + k * m(1.2), y: 14 - (k % 2 ? 1 : -1) * m(0.25), goal: { x: -m(12) - k * m(1.5), y: 14 - (k % 2 ? 1 : -1) * m(0.25) } });
      }
      void net;
      return out;
    },
  },
  {
    // Bench, lamp, bin and a pole together, with people both ways past them.
    name: 'obstacles', doc: (() => { const d = straight(URBAN); d.addPole({ x: -36, y: -15.2 }); return d; })(), seconds: 80, focus: { x: -38, y: -13 },
    walkers: (net) => {
      const s = only(net), L = net.ribbons.get(s)!.full.length;
      // The bench and lamp at x = -41/-36 on the south side (side -1 of a to b).
      const at = (x: number): number => x + L / 2;
      const out: ScenarioWalker[] = [];
      for (let k = 0; k < 4; k++) {
        out.push({ ...onFootway(net, s, at(-38) - m(8) - k * m(1.6), -1, (k % 2 ? 1 : -1) * m(0.3)), goal: onFootway(net, s, at(-38) + m(14) + k * m(1.5), -1) });
        out.push({ ...onFootway(net, s, at(-38) + m(8) + k * m(1.6), -1, (k % 2 ? -1 : 1) * m(0.3)), goal: onFootway(net, s, at(-38) - m(14) - k * m(1.5), -1) });
      }
      return out;
    },
  },
  {
    name: 'opposite', doc: straight(URBAN), seconds: 45, focus: { x: 0, y: 0 },
    walkers: (net) => {
      const s = only(net), L = net.ribbons.get(s)!.full.length;
      // Shoulder to shoulder, 0.6 m apart (centres): two bodies of 0.27 m and
      // a hand's breadth, both on walkable ground. (They were 0.5 m apart -
      // inside each other once the body was the drawn one - and the outer
      // one beyond the ground's edge; the crowd pushed them apart at once.)
      return [
        { ...onFootway(net, s, L / 2, 1, -m(0.5)), goal: onFootway(net, s, L / 2 + m(20), 1) },
        { ...onFootway(net, s, L / 2, 1, m(0.1)), goal: onFootway(net, s, L / 2 - m(20), 1) },
      ];
    },
  },
];
