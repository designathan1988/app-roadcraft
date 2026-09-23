import { clamp } from '@core/scalar';
import { DT, NARROW_SCREEN_SHARE, PED, PED_CEILING, PED_DENSITY } from '../params';
import type { SimWorld } from '../world';
import { PED_BEHAVIOUR, preferredLateral } from './behaviour';
import type { SidewalkEdge } from './sidewalk';
import { createPed, pedSnapshot, type Ped, type PedParty } from './state';

const SPAWN_INTERVAL = 0.7;
const COLORS = [
  '#e7dfd3',
  '#e06056',
  '#5f8fca',
  '#e5b64d',
  '#74a36d',
  '#b993d1',
  '#d6d8dc',
  '#2f6a86',
  '#cf7b43',
  '#dbe6ec',
];

export function resetPedSpawnClock(w: SimWorld): void {
  w.pedSpawnClock = 0;
}

export function pedTarget(w: SimWorld): number {
  let total = 0;
  for (const ribbon of w.net.ribbons.values()) total += ribbon.full.length;
  // Same defect as the fleet, same shape of fix: the length term decides, and
  // the ceiling is a runaway guard set far above it rather than the number that
  // actually binds.
  const narrow = typeof window !== 'undefined' && window.innerWidth < 800;
  const ceiling = narrow ? Math.floor(PED_CEILING * NARROW_SCREEN_SHARE) : PED_CEILING;
  return Math.min(
    ceiling,
    Math.floor(total * PED_DENSITY * w.pedestrianIntensity * w.demandMultiplier),
  );
}

export function stepPedDispatch(w: SimWorld, enabled: boolean): void {
  if (!enabled) return;
  w.pedSpawnClock += DT;
  if (w.pedSpawnClock < SPAWN_INTERVAL) return;
  w.pedSpawnClock = 0;
  if (w.peds.size >= pedTarget(w)) return;
  spawnPed(w);
}

/**
 * Puts one party on the network.
 *
 * A party is spawned whole or not at all. Assembling one later — finding two
 * strangers already walking and declaring them friends — would need a search
 * over the population every tick to find candidates, and would produce people
 * who suddenly start pacing each other for no reason a player can see.
 */
export function spawnPed(w: SimWorld): boolean {
  const walkEdges = [...w.sidewalks.edges.values()]
    .filter((e) => e.kind === 'walk' && e.length > 12)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!walkEdges.length) return false;

  const headroom = pedTarget(w) - w.peds.size;
  if (headroom <= 0) return false;
  const size = Math.min(headroom, w.rng.spawnPeds.weighted(PED_BEHAVIOUR.partySizes));

  for (let attempt = 0; attempt < 12; attempt++) {
    const edge = walkEdges[Math.floor(w.rng.spawnPeds.float() * walkEdges.length)];
    if (!edge) continue;
    const s = w.rng.spawnPeds.range(0.1, 0.85) * edge.length;
    const tail = Math.max(0, s - (size - 1) * PED_BEHAVIOUR.partyStagger);
    if (!clearOfOthers(w, edge, tail, s)) continue;

    spawnParty(w, edge, s, size);
    return true;
  }
  return false;
}

/**
 * Personal space at spawn, over the span the whole party will occupy.
 *
 * Asked of the occupancy index rather than of the population, because the
 * question is about one footway and the population is the whole city. The
 * index is a tick old, which over a tick is a couple of centimetres of walking
 * — far below the clearance being tested.
 */
function clearOfOthers(w: SimWorld, edge: SidewalkEdge, from: number, to: number): boolean {
  const clearance = PED.jamGap * 2;
  const mid = (from + to) / 2;
  const half = (to - from) / 2;
  return w.sidewalks.occupancy.nearestTo(edge, mid) > clearance + half;
}

function spawnParty(w: SimWorld, edge: SidewalkEdge, head: number, size: number): void {
  // The pace is the slowest member's, so it has to be known before the first
  // member exists. Drawing every speed up front is also what keeps the party
  // consuming one contiguous run of the stream however large it is.
  const speeds: number[] = [];
  let pace = PED.maxSpeed;
  for (let i = 0; i < size; i++) {
    const speed = clamp(
      w.rng.pedParams.normal(PED.meanSpeed, PED.speedSd),
      PED.minSpeed,
      PED.maxSpeed,
    );
    speeds.push(speed);
    if (speed < pace) pace = speed;
  }

  const party: PedParty = { id: w.nextPedId, size, pace };
  const members: Ped[] = [];
  const usable = Math.max(0, edge.halfWidth - PED_BEHAVIOUR.lateralMargin);

  for (let i = 0; i < size; i++) {
    const color = COLORS[Math.floor(w.rng.spawnPeds.float() * COLORS.length)] as string;
    const file = Math.floor(w.rng.pedParams.float() * PED.files);
    const id = w.nextPedId++;
    const ped = createPed({
      id,
      color,
      speed: speeds[i] as number,
      file,
      party,
      rank: i,
      edge: edge.id,
      entry: edge.from,
      s: Math.max(0, head - i * PED_BEHAVIOUR.partyStagger),
      // Starting on the preferred offset rather than on the centreline: a
      // party that spawns in a line and then fans out looks like it was
      // dealt from a deck.
      lat: preferredLateral(id, file, PED.files) * usable,
      tick: w.clock.tick,
    });
    const frame = w.sidewalks.orientedPath(edge, edge.from).sampleAt(ped.s);
    ped.x = frame.p.x + frame.n.x * ped.lat;
    ped.y = frame.p.y + frame.n.y * ped.lat;
    ped.heading = Math.atan2(frame.t.y, frame.t.x);
    ped.prev = pedSnapshot(ped);
    members.push(ped);
    w.peds.set(ped.id, ped);
  }

  for (let i = 0; i < members.length - 1; i++) {
    (members[i] as Ped).trailing = (members[i + 1] as Ped).id;
  }
}
