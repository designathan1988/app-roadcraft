import { type Vec2, addScaled } from '@core/vec2';
import { m } from '@world/units';
import type { SimWorld } from '../world';
import type { Ped } from './state';
import type { SidewalkEdge } from './sidewalk';

interface Footprint {
  id: number; x: number; y: number; radius: number; cell: string;
  forward?: Vec2; halfLength?: number; halfWidth?: number;
}
const CELL = m(4);
const PERSON = m(0.3);
const cell = (x: number, y: number): string => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;

/** World-space clearance shared across sidewalk edges and crossing nodes. */
export class PedestrianClearance {
  private readonly grid = new Map<string, Footprint[]>();
  private readonly people = new Map<number, Footprint>();
  private scenery: Footprint[] = [];
  private builtRevision = -1;
  private builtDocumentRevision = -1;

  begin(w: SimWorld): void {
    if (this.builtRevision !== w.net.revision || this.builtDocumentRevision !== w.doc.revision) {
      this.buildScenery(w);
      this.builtRevision = w.net.revision;
      this.builtDocumentRevision = w.doc.revision;
    }
    this.grid.clear();
    this.people.clear();
    for (const obstacle of this.scenery) this.insert(obstacle);
    for (const p of w.pedsInIdOrder()) {
      const at = this.at(w, p);
      if (!at) continue;
      const footprint = { id: p.id, x: at.x, y: at.y, radius: PERSON, cell: '' };
      this.people.set(p.id, footprint);
      this.insert(footprint);
    }
    // Vehicles retain their own lane physics, but pedestrians also need their
    // physical footprint while entering a zebra or clearing a junction.
    for (const vehicle of w.vehiclesInIdOrder()) {
      const lane = w.lanelet(vehicle.lanelet);
      if (!lane) continue;
      const frame = lane.centre.sampleAt(vehicle.s);
      const centre = frame.p;
      const archetype = vehicle.archetype;
      const halfLength = archetype.length / 2, halfWidth = archetype.width / 2;
      const radius = Math.hypot(halfLength, halfWidth);
      this.insert({ id: -vehicle.id, x: centre.x, y: centre.y, radius, cell: '',
        forward: frame.t, halfLength, halfWidth });
    }
  }

  at(w: SimWorld, p: Ped): Vec2 | null {
    const edge = w.sidewalks.edges.get(p.edge);
    if (!edge) return null;
    return this.point(w, edge, p.entry, p.s, p.lat);
  }

  point(w: SimWorld, edge: SidewalkEdge, entry: string, s: number, lat: number): Vec2 {
    const frame = w.sidewalks.orientedPath(edge, entry).sampleAt(s);
    return addScaled(frame.p, frame.n, lat);
  }

  /** How far the next step may go before touching a person or object. */
  safeStep(w: SimWorld, p: Ped, edge: SidewalkEdge, target: number): number {
    if (target <= p.s) return p.s;
    const current = this.point(w, edge, p.entry, p.s, p.lat);
    const free = (s: number): boolean => {
      const at = this.point(w, edge, p.entry, s, p.lat);
      return !this.blocker(p.id, at.x, at.y, current);
    };
    if (free(target)) return target;
    let lo = p.s, hi = target;
    for (let i = 0; i < 5; i++) {
      const mid = (lo + hi) / 2;
      if (free(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  canEnter(w: SimWorld, p: Ped, edge: SidewalkEdge, entry: string, lat: number): boolean {
    const current = this.at(w, p);
    if (!current) return false;
    const at = this.point(w, edge, entry, 0, lat);
    return !this.blocker(p.id, at.x, at.y, current);
  }

  canShift(w: SimWorld, p: Ped, edge: SidewalkEdge, lat: number): boolean {
    const current = this.at(w, p);
    if (!current) return false;
    const at = this.point(w, edge, p.entry, p.s, lat);
    return !this.blocker(p.id, at.x, at.y, current);
  }

  /** A stable side to pass an obstruction before walking into it. */
  avoidance(w: SimWorld, p: Ped, edge: SidewalkEdge, target: number): number {
    const frame = w.sidewalks.orientedPath(edge, p.entry).sampleAt(p.s);
    const near = addScaled(frame.p, frame.n, p.lat);
    let best = m(2.6);
    let shift = 0;
    const usable = Math.max(0, edge.halfWidth - m(0.25));
    this.visit(near.x, near.y, m(3.6), other => {
      if (other.id === p.id) return;
      const dx = other.x - near.x, dy = other.y - near.y;
      const ahead = dx * frame.t.x + dy * frame.t.y;
      if (ahead < -m(0.3) || ahead >= best) return;
      const lateral = dx * frame.n.x + dy * frame.n.y + p.lat;
      const separation = (other.halfWidth ?? other.radius) + PERSON + m(0.18);
      if (Math.abs(lateral - target) >= separation) return;
      const left = lateral - separation;
      const right = lateral + separation;
      best = ahead;
      if (right > usable && left >= -usable) shift = left - target;
      else if (left < -usable && right <= usable) shift = right - target;
      else shift = (Math.abs(left - p.lat) < Math.abs(right - p.lat) ? left : right) - target;
    });
    return shift;
  }

  update(w: SimWorld, p: Ped): void {
    const footprint = this.people.get(p.id);
    const at = this.at(w, p);
    if (!footprint || !at) return;
    const bucket = this.grid.get(footprint.cell);
    if (bucket) {
      const i = bucket.indexOf(footprint);
      if (i >= 0) bucket.splice(i, 1);
    }
    footprint.x = at.x; footprint.y = at.y;
    this.insert(footprint);
  }

  private blocker(id: number, x: number, y: number, current: Vec2): boolean {
    let blocked = false;
    this.visit(x, y, m(6.5), other => {
      if (blocked || other.id === id) return;
      const minimum = PERSON + (other.halfLength === undefined ? other.radius : 0);
      const next = this.distance(other, x, y);
      if (next >= minimum) return;
      // An old overlap may be repaired by moving away, never by pushing in.
      const before = this.distance(other, current.x, current.y);
      if (next + 1e-5 < before || before >= minimum) blocked = true;
    });
    return blocked;
  }

  private distance(other: Footprint, x: number, y: number): number {
    const dx = x - other.x, dy = y - other.y;
    if (!other.forward || other.halfLength === undefined || other.halfWidth === undefined) {
      return Math.hypot(dx, dy);
    }
    const along = Math.abs(dx * other.forward.x + dy * other.forward.y) - other.halfLength;
    const across = Math.abs(dx * -other.forward.y + dy * other.forward.x) - other.halfWidth;
    return Math.hypot(Math.max(0, along), Math.max(0, across));
  }

  private visit(x: number, y: number, range: number, call: (item: Footprint) => void): void {
    const minX = Math.floor((x - range) / CELL), maxX = Math.floor((x + range) / CELL);
    const minY = Math.floor((y - range) / CELL), maxY = Math.floor((y + range) / CELL);
    for (let ix = minX; ix <= maxX; ix++) for (let iy = minY; iy <= maxY; iy++) {
      for (const item of this.grid.get(`${ix}:${iy}`) ?? []) call(item);
    }
  }

  private insert(item: Footprint): void {
    item.cell = cell(item.x, item.y);
    const bucket = this.grid.get(item.cell);
    if (bucket) bucket.push(item);
    else this.grid.set(item.cell, [item]);
  }

  private buildScenery(w: SimWorld): void {
    const items: Footprint[] = [];
    let column = 0;
    const add = (x: number, y: number, radius: number): void => {
      items.push({ id: -1_000_000 - items.length, x, y, radius, cell: '' });
    };
    // These are the same positions and dimensions used by buildScenery.
    for (const ribbon of w.net.ribbons.values()) {
      const length = ribbon.full.length;
      const start = Math.min(36, length * 0.24);
      for (let s = start; s < length - start; s += 88) {
        const frame = ribbon.full.sampleAt(s);
        const side = (Math.floor(s / 88) + ribbon.id) % 2 === 0 ? -1 : 1;
        const out = ribbon.road.width / 2 + ribbon.road.sidewalk * 0.95;
        const x = frame.p.x + frame.n.x * out * side;
        const y = frame.p.y + frame.n.y * out * side;
        add(x, y, m(0.13));
        const outward = (metres: number): Vec2 => ({ x: x + frame.n.x * side * m(metres), y: y + frame.n.y * side * m(metres) });
        if (column % 3 === 0) { const at = outward(0.9); add(at.x, at.y, m(0.33)); }
        if (column % 4 === 1) {
          const at = outward(1.1);
          const halfLength = m(0.9), halfWidth = m(0.26);
          items.push({ id: -1_000_000 - items.length, x: at.x, y: at.y,
            radius: Math.hypot(halfLength, halfWidth), cell: '',
            forward: frame.t, halfLength, halfWidth });
        }
        if (column % 7 === 2) { const at = outward(-0.35); add(at.x, at.y, m(0.16)); }
        if (column % 11 === 3) { const at = outward(1); add(at.x, at.y, m(0.33)); }
        column++;
      }
    }
    for (const pole of w.doc.poles.values()) add(pole.x, pole.y, m(0.18));
    this.scenery = items;
  }
}
