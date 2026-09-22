import {
  DT,
  DRIVER_NOISE,
  FLEET_CEILING,
  JAM_GAP,
  NARROW_SCREEN_SHARE,
  TRAFFIC_DENSITY,
} from '../params';
import type { SimWorld } from '../world';
import { ARCHETYPES, type Archetype, archetypeWeights } from './archetypes';
import { makeDriver } from './driver';
import { createVehicle, snapshot } from './state';
import { planFrom } from '../routing/router';

/** Seconds between spawn attempts. */
const SPAWN_INTERVAL = 0.5;

export function resetSpawnClock(w: SimWorld): void {
  w.vehicleSpawnClock = 0;
}

/**
 * Target fleet size, from total road length.
 *
 * The length term is what decides the number. `FLEET_CEILING` is a runaway
 * guard set far above it, not a design target — it used to be a bare 90, and a
 * city nine times larger produced exactly the same fleet because the `min`
 * swallowed it.
 */
export function trafficTarget(w: SimWorld): number {
  let total = 0;
  for (const ribbon of w.net.ribbons.values()) total += ribbon.full.length;
  const narrow = typeof window !== 'undefined' && window.innerWidth < 800;
  const ceiling = narrow ? Math.floor(FLEET_CEILING * NARROW_SCREEN_SHARE) : FLEET_CEILING;
  return Math.min(
    ceiling,
    Math.floor(total * TRAFFIC_DENSITY * w.trafficIntensity * w.demandMultiplier),
  );
}

export function stepDispatch(w: SimWorld, enabled: boolean): void {
  if (!enabled) return;
  w.vehicleSpawnClock += DT;
  if (w.vehicleSpawnClock < SPAWN_INTERVAL) return;
  w.vehicleSpawnClock = 0;

  if (w.vehicles.size >= trafficTarget(w)) return;
  spawnVehicle(w);
}

/**
 * Spawns one vehicle at the quietest available lane entry.
 *
 * Sources are lane entries whose upstream node is a dead end where possible,
 * so traffic appears to arrive from outside the map rather than materialise
 * mid-street.
 */
export function spawnVehicle(w: SimWorld): boolean {
  const candidates: string[] = [];
  for (const lane of w.graph.lanelets.values()) {
    if (lane.kind !== 'link') continue;
    if (lane.length < 30) continue;
    if (w.rt(lane.id).ghost) continue;
    const from = lane.from;
    if (from === undefined) continue;
    if (w.doc.degree(from) === 1) candidates.push(lane.id);
  }

  // Never fall back to an arbitrary internal lane. A closed network with no
  // boundary source simply receives no new traffic until the player connects
  // an entry road; materialising a car halfway along a street is both visually
  // jarring and physically false.
  const pool = candidates;

  if (!pool.length) return false;
  pool.sort();

  const arch = w.rng.spawnVehicles.weighted(archetypeWeights()) as Archetype;

  // Try a handful of entries, least occupied first.
  const ranked = pool
    .map((id) => ({ id, n: w.rt(id).order.length }))
    .sort((a, b) => a.n - b.n || (a.id < b.id ? -1 : 1))
    .slice(0, 12);

  for (const { id } of ranked) {
    const lane = w.lanelet(id);
    if (!lane) continue;
    const tail = w.laneTail(id);
    const needed = arch.length + JAM_GAP;
    if (tail && tail.s - tail.archetype.length < needed) continue;

    // The driver is drawn BEFORE the free-flow speed and from the same stream,
    // so the two are part of one personality rather than two independent rolls.
    const driver = makeDriver(arch, () => w.rng.driver.float());
    const v0 =
      lane.speedLimit *
      arch.speedFactor *
      w.rng.driver.range(DRIVER_NOISE.lo, DRIVER_NOISE.hi) *
      // A pushy driver wants more than the limit and a timid one less, on top
      // of the ordinary spread. Without it every driver in the fleet converges
      // on the same cruise and the only thing distinguishing them is how they
      // got there.
      (1 + driver.aggression * 0.07);

    const palette = arch.palette;
    const color = palette[Math.floor(w.rng.spawnVehicles.float() * palette.length)] as string;

    const vehicle = createVehicle(w.nextVehicleId++, arch, driver, color, id, v0, w.clock.tick);
    vehicle.v = Math.min(v0 * 0.4, lane.speedLimit * 0.4);
    vehicle.prev = snapshot(vehicle);

    w.vehicles.set(vehicle.id, vehicle);
    w.enterLanelet(vehicle, id);
    planFrom(w, vehicle);
    return true;
  }
  return false;
}

/** Removes vehicles that have reached a dead end and stopped there. */
export function stepDespawn(w: SimWorld): void {
  for (const v of w.vehiclesInIdOrder()) {
    const lane = w.lanelet(v.lanelet);
    if (!lane) {
      w.removeVehicle(v);
      continue;
    }
    // The end-of-route obstacle brings a vehicle to rest at its standstill gap,
    // not against the very end of the lane, so the despawn threshold has to
    // allow for that — otherwise cars park just short of a map edge forever and
    // slowly plug the exit stub.
    const atEnd = lane.length - v.s < v.driver.s0 + 2;
    const nowhereToGo = w.graph.exitsOf(v.lanelet).length === 0;
    if (lane.kind === 'link' && atEnd && nowhereToGo) {
      w.removeVehicle(v);
    }
  }
}

export { ARCHETYPES };
