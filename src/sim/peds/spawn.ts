import { clamp } from '@core/scalar';
import { m } from '@world/units';
import { blocksPedestrians, streetFurniture } from '@world/streetFurniture';
import { signalPosts } from '@world/signalPosts';
import { DT, PED, PED_CEILING, PED_DENSITY } from '../params';
import type { SimWorld } from '../world';
import { PED_BEHAVIOUR, pedHash, preferredLateral } from './behaviour';
import type { SidewalkEdge } from './sidewalk';
import { createPed, pedSnapshot, type PartyArchetype, type Ped, type PedAgeClass, type PedParty } from './state';

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

export function pedTarget(w: SimWorld): number {
  let total = 0;
  for (const ribbon of w.net.ribbons.values()) total += ribbon.full.length;
  // Same defect as the fleet, same shape of fix: the length term decides, and
  // the ceiling is a runaway guard set far above it rather than the number that
  // actually binds.
  const ceiling = Math.floor(PED_CEILING * w.populationShare);
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

/** A disc standing in for one piece of street furniture, at a body's own height. */
interface Obstacle { readonly x: number; readonly y: number; readonly r: number }

interface Furniture {
  revision: number;
  utilities: number;
  items: Obstacle[];
}
const FURNITURE = new WeakMap<SimWorld, Furniture>();

/** The street furniture, signal posts and poles a body cannot be placed inside. */
function obstacles(w: SimWorld): Obstacle[] {
  const known = FURNITURE.get(w);
  if (known && known.revision === w.net.trafficRevision && known.utilities === w.doc.utilityRevision) {
    return known.items;
  }
  const items: Obstacle[] = [];
  for (const item of streetFurniture(w.net)) {
    if (!blocksPedestrians(item)) continue;
    if (item.halfLength !== undefined && item.halfWidth !== undefined) {
      // A bench or a post box: its long side as a row of discs, as the waiting
      // areas model it.
      const count = Math.max(1, Math.ceil(item.halfLength / item.halfWidth));
      for (let i = 0; i <= count; i++) {
        const t = -item.halfLength + (2 * item.halfLength * i) / count;
        items.push({ x: item.x + item.along.x * t, y: item.y + item.along.y * t, r: item.halfWidth });
      }
    } else items.push({ x: item.x, y: item.y, r: item.radius });
  }
  for (const post of signalPosts(w.net, w.graph)) items.push({ x: post.x, y: post.y, r: SIGNAL_POST });
  for (const pole of w.doc.poles.values()) items.push({ x: pole.x, y: pole.y, r: POLE });
  const fresh: Furniture = { revision: w.net.trafficRevision, utilities: w.doc.utilityRevision, items };
  FURNITURE.set(w, fresh);
  return items;
}
const SIGNAL_POST = m(0.17);
const POLE = m(0.18);
/** How far a spawned body keeps from the edge of a piece of street furniture. */
const SPAWN_CLEAR = m(0.3);

/**
 * The offset across the footway nearest `wanted` at which a body fits clear of
 * the street furniture standing there, and of the companions already placed.
 *
 * People used to be placed on a preferred line with no thought for what was
 * drawn on it, so somebody was put inside a lamp column or a tree pit and
 * could not walk out again: the clearance gate refuses every step that goes
 * further in, and the column is drawn at the walker's own feet. Measured at
 * the mixed-lanes junction, a body spent 0.3 s of sixty with its centre
 * 0.22 m INSIDE a piece of street furniture.
 */
function clearLateral(w: SimWorld, edge: SidewalkEdge, s: number, wanted: number, usable: number,
  placed: readonly Ped[]): number {
  const frame = w.sidewalks.orientedPath(edge, edge.from).sampleAt(s);
  const items = obstacles(w);
  if (!items.length) return wanted;
  const clear = (lat: number): boolean => {
    const x = frame.p.x + frame.n.x * lat;
    const y = frame.p.y + frame.n.y * lat;
    for (const item of items) if (Math.hypot(item.x - x, item.y - y) < item.r + SPAWN_CLEAR) return false;
    return true;
  };
  // Stepping round the column must not put this one on top of the companion
  // who spawned a moment before it.
  const free = (lat: number): boolean => clear(lat) &&
    placed.every((other) => {
      const x = frame.p.x + frame.n.x * lat;
      const y = frame.p.y + frame.n.y * lat;
      return Math.hypot(other.x - x, other.y - y) >= MEMBER_CLEAR;
    });
  if (free(wanted)) return wanted;
  // A narrow footway can leave no line that both clears the furniture and
  // keeps the party's own spacing. Furniture wins: a body drawn inside a lamp
  // column can never walk out of it, and two companions a step too close
  // together sort themselves out as they walk.
  let clearOnly: number | null = null;
  // Outwards from the line the walker wanted, both sides, the nearer first.
  for (let step = 1; step <= CLEAR_STEPS; step++) {
    for (const side of [1, -1]) {
      const lat = wanted + side * step * CLEAR_STEP;
      if (lat < -usable || lat > usable) continue;
      if (free(lat)) return lat;
      if (clearOnly === null && clear(lat)) clearOnly = lat;
    }
  }
  if (clearOnly !== null) return clearOnly;
  return wanted;
}
/** Room kept between two members of a party at the moment they are placed. */
const MEMBER_CLEAR = PED_BEHAVIOUR.shoulder;
/** How far, in what increments, a spawned body searches sideways for clear footing. */
const CLEAR_STEP = m(0.12);
const CLEAR_STEPS = 14;

/**
 * Age for each member of a new party.
 *
 * Independent rolls alone rarely put a child beside an adult in the same
 * party — with a 9 % child share, a party of two draws one under 3 % of the
 * time — so "a parent out with their children" would barely exist. A small
 * party is instead sometimes DECLARED a family: one adult leading, the rest
 * children, the adult's own pace pulled down to theirs by the ordinary
 * cohesion rule once they are walking (`behaviour.ts`).
 */
function rollAgeClasses(w: SimWorld, size: number): PedAgeClass[] {
  if (size >= 2 && size <= 3 && w.rng.pedParams.bool(PED_BEHAVIOUR.familyChance)) {
    return Array.from({ length: size }, (_, i) => (i === 0 ? 'adult' : 'child'));
  }
  return Array.from({ length: size }, () => {
    const roll = w.rng.pedParams.float();
    if (roll < PED_BEHAVIOUR.childShare) return 'child';
    if (roll < PED_BEHAVIOUR.childShare + PED_BEHAVIOUR.elderShare) return 'elder';
    return 'adult';
  });
}

/**
 * What kind of group a party of these ages is. Read from the ages, never
 * drawn, so no random stream changes: a child with an adult or an elder is a
 * family (a grandparent out with a grandchild too), an adult with an elder
 * is family, elders together are elderly friends, two adults a couple or
 * friends, more adults friends, colleagues or tourists - by the party's own hash.
 */
export function partyArchetype(ages: readonly PedAgeClass[], id: number): PartyArchetype {
  if (ages.length === 1) return 'solo';
  const child = ages.includes('child');
  const adult = ages.includes('adult');
  const elder = ages.includes('elder');
  if (child && (adult || elder)) return 'family';
  if (adult && elder) return 'family';
  if (elder) return 'elders';
  if (child) return 'friends';
  const h = pedHash(id ^ 0x9a47);
  // Adults out together who are not a couple or colleagues: one party in four
  // of those is visitors seeing the town, the rest friends.
  const tourists = ((h >>> 4) & 3) === 0;
  if (ages.length === 2) return (h & 3) < 2 ? 'couple' : tourists ? 'tourists' : 'friends';
  return (h & 7) < 2 ? 'colleagues' : tourists ? 'tourists' : 'friends';
}

/** Free-flow speed for one pedestrian, from the distribution their age draws. */
function rollSpeed(w: SimWorld, ageClass: PedAgeClass): number {
  if (ageClass === 'child') {
    return clamp(
      w.rng.pedParams.normal(PED_BEHAVIOUR.childSpeedMean, PED_BEHAVIOUR.childSpeedSd),
      PED_BEHAVIOUR.childSpeedMin,
      PED.maxSpeed,
    );
  }
  if (ageClass === 'elder') {
    return clamp(
      w.rng.pedParams.normal(PED_BEHAVIOUR.elderSpeedMean, PED_BEHAVIOUR.elderSpeedSd),
      PED_BEHAVIOUR.elderSpeedMin,
      PED_BEHAVIOUR.elderSpeedMax,
    );
  }
  return clamp(w.rng.pedParams.normal(PED.meanSpeed, PED.speedSd), PED.minSpeed, PED.maxSpeed);
}

function spawnParty(w: SimWorld, edge: SidewalkEdge, head: number, size: number): void {
  // The pace is the slowest member's, so it has to be known before the first
  // member exists. Drawing every trait up front is also what keeps the party
  // consuming one contiguous run of each stream however large it is.
  const ageClasses = rollAgeClasses(w, size);
  const archetype = partyArchetype(ageClasses, w.nextPedId);
  const speeds: number[] = [];
  let pace = PED.maxSpeed;
  let hasChild = false;
  for (let i = 0; i < size; i++) {
    const ageClass = ageClasses[i] as PedAgeClass;
    if (ageClass === 'child') hasChild = true;
    const speed = rollSpeed(w, ageClass);
    speeds.push(speed);
    if (speed < pace) pace = speed;
  }

  const party: PedParty = { id: w.nextPedId, size, archetype, pace, hasChild, goal: null, trip: 0 };
  const members: Ped[] = [];
  const usable = Math.max(0, edge.halfWidth - PED_BEHAVIOUR.lateralMargin);
  const spacing = Math.max(PED_BEHAVIOUR.shoulder,
    PED_BEHAVIOUR.abreastSpacing * (hasChild ? PED_BEHAVIOUR.familySpacingFactor : 1));
  const abreast = size > 1 && usable * 2 >= spacing + PED_BEHAVIOUR.shoulder;
  const halfPair = spacing / 2;
  const base = abreast ? clamp(
    preferredLateral(party.id, party.id % PED.files, PED.files) * usable,
    -usable + halfPair, usable - halfPair,
  ) : 0;

  for (let i = 0; i < size; i++) {
    const color = COLORS[Math.floor(w.rng.spawnPeds.float() * COLORS.length)] as string;
    const file = Math.floor(w.rng.pedParams.float() * PED.files);
    const gender = w.rng.pedParams.bool(0.5) ? 'f' : 'm';
    const id = w.nextPedId++;
    const rows = Math.ceil(size / 2);
    const rowShift = (Math.floor(i / 2) - (rows - 1) / 2) *
      PED_BEHAVIOUR.abreastSpacing * 0.48;
    const pairCenter = clamp(base + rowShift, -usable + halfPair, usable - halfPair);
    const s = Math.max(0, head - (abreast ? Math.floor(i / 2) : i) * PED_BEHAVIOUR.partyStagger);
    const ped = createPed({
      id,
      color,
      speed: speeds[i] as number,
      file,
      ageClass: ageClasses[i] as PedAgeClass,
      gender,
      party,
      rank: i,
      edge: edge.id,
      entry: edge.from,
      s,
      // Companions who fit across the footway begin beside each other, with
      // enough room for both bodies. Narrow footways retain single file.
      lat: clearLateral(w, edge, s, clamp(
        abreast ? pairCenter + (i % 2 === 0 ? -halfPair : halfPair)
          : preferredLateral(id, file, PED.files) * usable,
        -usable, usable,
      ), usable, members),
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
