import { m } from '@world/units';
import type { SimWorld } from '../world';
import { releaseCrossing } from './crossingFsm';
import { publishCrossingStates, publishPedViews } from './publish';
import type { Ped } from './state';
import { releaseSlot } from './waitArea';
import { endActivity } from './activities';
import type { SidewalkEdge } from './sidewalk';

/** The pedestrian half of `rebindAgents`, after `SimWorld.rebuildWalkTopology`. */
export function rebindPeds(w: SimWorld): void {
  for (const p of w.pedsInIdOrder()) {
    const edge = w.sidewalks.edges.get(p.edge);
    if (!edge) {
      // A pedestrian whose edge vanished is moved to the NEAREST surviving
      // footway, from where it was standing. It used to take the first walk
      // edge in the map: every orphan of an edit teleported across the city
      // and stacked on one spot at s = 0, still sitting on a demolished bench
      // and holding its kerb slot. Nobody within reach: it leaves cleanly.
      releaseCrossing(w, p);
      releaseSlot(w, p);
      endActivity(w, p);
      if (!relocatePed(w, p)) removePed(w, p);
      continue;
    }
    p.s = Math.min(p.s, edge.length);
    p.route = p.route.filter((id) => w.sidewalks.edges.has(id));
  }

  // `Ped.occupying` is the source of truth. Reconstructing this index avoids a
  // live-but-relocated pedestrian keeping a demolished crossing occupied after
  // undo/redo or any other topology replacement.
  w.pedOccupancy.clear();
  for (const p of w.pedsInIdOrder()) {
    if (!p.occupying) continue;
    if (!w.sidewalks.crossings.has(p.occupying)) {
      p.occupying = null;
      continue;
    }
    const list = w.pedOccupancy.get(p.occupying);
    if (list) list.push(p.id);
    else w.pedOccupancy.set(p.occupying, [p.id]);
  }
  publishCrossingStates(w);
  publishPedViews(w);
}

/** How far an orphaned pedestrian may be carried to a surviving footway. */
const RELOCATE_REACH = m(15);

/**
 * Puts a pedestrian whose footway is gone on the nearest walk edge, at the
 * point closest to where it stood, facing the way it was facing. Returns false
 * when no footway is within reach.
 */
function relocatePed(w: SimWorld, p: Ped): boolean {
  let nearest: SidewalkEdge | null = null;
  let arc = 0;
  let distance = RELOCATE_REACH;
  for (const edge of w.sidewalks.edges.values()) {
    if (edge.kind !== 'walk') continue;
    const hit = edge.path.closestPoint({ x: p.x, y: p.y });
    if (hit.distance < distance) { nearest = edge; arc = hit.s; distance = hit.distance; }
  }
  if (!nearest) return false;
  const tangent = nearest.path.sampleAt(arc).t;
  const reverse = tangent.x * Math.cos(p.heading) + tangent.y * Math.sin(p.heading) < 0;
  const place = { s: 0, lat: 0 };
  const bounds = { lo: 0, hi: 0 };
  const frame = { x: 0, y: 0, tx: 0, ty: 0, nx: 0, ny: 0 };
  nearest.corridor.locate(p.x, p.y, reverse, reverse ? nearest.length - arc : arc, place);
  p.edge = nearest.id;
  p.entry = reverse ? nearest.to : nearest.from;
  p.s = Math.max(0, Math.min(nearest.length, place.s));
  nearest.corridor.bounds(p.s, reverse, bounds);
  p.lat = Math.max(bounds.lo, Math.min(bounds.hi, place.lat));
  nearest.corridor.place(p.s, p.lat, reverse, frame);
  p.x = frame.x;
  p.y = frame.y;
  p.offX = 0;
  p.offY = 0;
  p.state = 'Walking';
  p.route = [];
  p.occupying = null;
  p.pause = 0;
  p.lockedFacing = null;
  p.stuck = 0;
  return true;
}

/**
 * Takes a pedestrian out of the world with everything it holds: a crossing, a
 * kerb slot, an activity (a bench seat), and a companion trailing it.
 */
export function removePed(w: SimWorld, p: Ped): void {
  releaseCrossing(w, p);
  releaseSlot(w, p);
  endActivity(w, p);
  for (const other of w.peds.values()) if (other.trailing === p.id) other.trailing = null;
  w.peds.delete(p.id);
}
