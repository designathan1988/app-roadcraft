import { normalizeRoadSection, sameRoadSection, type RoadSection } from './roadSection';
import type { Vec2 } from '@core/vec2';
import { type CurveShape, fitShapeToRadius } from '@core/bezier';
import {
  type NodeId,
  type PoleId,
  type SegmentId,
  type SpanId,
  IdAllocator,
  asNodeId,
  asPoleId,
  asSegmentId,
  asSpanId,
} from './ids';
import type { UtilityPole, UtilitySpan } from './utilities';
import { type Barrier, type BarrierKind, isBarrierKind } from './barriers';
// Runtime imports, and safe: `geometry` and `legAngles` take `RoadDoc` as a
// TYPE only, so nothing here is part of a runtime cycle.
import { TUNNEL_HEADROOM, type RoadStructure, migrateStructure } from './structures';
import { MAX_TERRAIN_STAMPS, type TerrainStamp } from './terrain';
import { clampToMap } from './bounds';
import { casingHalf, roadProfile } from './roadTypes';
import { BuildingStore } from './buildings/store';
import type { SerializedBuilding } from './buildings/serialize';
import { normalizePerson, type PersonSpec } from '@people/spec';

/** `shape` flattened until no band of a road of this profile folds over (see `RoadDoc.fitCurve`). */
export function fitRoadCurve(
  a: Vec2, b: Vec2, shape: CurveShape | null, type: number,
  lanes: number | null = null, direction: SegmentDirection = 'both', section?: RoadSection,
): CurveShape | null {
  return fitShapeToRadius(a, b, shape, casingHalf(roadProfile(type, lanes, direction, section)));
}

/** Legal driving directions, relative to the stored `a -> b` orientation. */
export type SegmentDirection = 'both' | 'aToB' | 'bToA';

/** Explicit junction policy. `auto` retains the class-based default policy. */
export type JunctionControl = 'auto' | 'signal' | 'stop' | 'yield' | 'priority' | 'none';

/** Stable segment-pair key for a movement through a junction. */
export const movementKey = (from: SegmentId, to: SegmentId): string => `${from}>${to}`;

/** Whether a movement key names segment `id` as its entry or its exit. */
export function movementMentions(key: string, id: SegmentId): boolean {
  const cut = key.indexOf('>');
  const text = String(id);
  return key.slice(0, cut) === text || key.slice(cut + 1) === text;
}

export interface RoadNode {
  readonly id: NodeId;
  x: number;
  y: number;
  /** Authored height above or below the designed ground, in world units. */
  heightOffset: number;
  /** An internal control point of one continuous road gesture. */
  smooth: boolean;
  /**
   * Materialized incidence list.
   *
   * The V6 monolith recomputed this with a linear `filter` over every segment,
   * from inside `nodeDegree`, `intersectionRadius`, `junctionReach`,
   * `crosswalkDistance` and `approachSetback` — roughly six full scans per
   * vehicle per frame (defect 5.7). Here it is maintained on mutation.
   */
  readonly incident: SegmentId[];
  control: JunctionControl;
  blockedMovements: string[];
}

export interface RoadSegment {
  readonly id: SegmentId;
  a: NodeId;
  b: NodeId;
  /** Null means a straight segment; see `CurveShape` for why `h` is absolute. */
  curve: CurveShape | null;
  type: number;
  /**
   * Arc-length offset of this segment's start within the road it was drawn as.
   *
   * Dash phase is anchored to this rather than to a render chain, so splitting
   * a road (which happens automatically whenever one crosses another) leaves
   * every dash boundary at the same world position (defect 1.10).
   */
  dashOrigin: number;
  direction: SegmentDirection;
  /** Optional total travel-lane count; omitted means the class default. */
  lanes: number | null;
  /** Authored cross-section; absent preserves the exact class profile. */
  section?: RoadSection;
  /** Vertical construction mode. Ground is the legacy/default value. */
  structure: RoadStructure;
}

/**
 * The authoring document: what the user drew, before any derived geometry.
 *
 * Mutations are applied here, mark entities dirty and move a revision;
 * `Network.rebuild()` then rebuilds everything derived (the dirty sets are a
 * hook for an incremental rebuild that does not exist yet - see `markNode`). Nothing in this file knows about lanes,
 * vehicles or rendering.
 */
export class RoadDoc {
  readonly nodes = new Map<NodeId, RoadNode>();
  readonly segments = new Map<SegmentId, RoadSegment>();

  /**
   * The overhead utility network: poles and the wire runs between them.
   *
   * A second drawable graph, and deliberately a much simpler one. A pole has
   * no width, so none of the road machinery applies to it - no casing, no
   * junction, no trim, no elevation solve. It stands on whatever the ground
   * under it turns out to be.
   */
  readonly poles = new Map<PoleId, UtilityPole>();
  readonly poleSpans = new Map<SpanId, UtilitySpan>();

  /**
   * Walls, fences and hedges drawn along paths (`barriers.ts`). Like the poles
   * they are not part of the road network and keep their own revision,
   * `barrierRevision`: a fence drawn must not rebuild the roads.
   */
  readonly barriers = new Map<number, Barrier>();
  barrierRevision = 0;
  private barrierIds = new IdAllocator(1);

  private nodeIds = new IdAllocator(1);
  private segIds = new IdAllocator(1);
  private poleIds = new IdAllocator(1);
  private spanIds = new IdAllocator(1);
  private nextTerrainId = 1;

  readonly terrainStamps: TerrainStamp[] = [];

  /**
   * Modular buildings (docs/buildings.md). They keep their OWN revision,
   * `buildings.revision`: a building edit must not move `revision`, which
   * would rebuild the road network and the simulation for nothing.
   */
  readonly buildings = new BuildingStore();

  /**
   * The people made in the Person Creator, saved with the city. Their own
   * revision, `peopleRevision`: a person is not part of any network.
   */
  readonly people: PersonSpec[] = [];
  peopleRevision = 0;

  /** Adds a person, or replaces the one with the same id. */
  savePerson(person: PersonSpec): void {
    const at = this.people.findIndex((p) => p.id === person.id);
    if (at >= 0) this.people[at] = person;
    else this.people.push(person);
    this.peopleRevision++;
  }

  removePerson(id: number): void {
    const at = this.people.findIndex((p) => p.id === id);
    if (at < 0) return;
    this.people.splice(at, 1);
    this.peopleRevision++;
  }

  /** An id no saved person has. */
  nextPersonId(): number {
    return this.people.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  }

  /** Bumped on every structural change; consumers use it to invalidate caches. */
  revision = 0;
  /** Horizontal road and junction topology read by vehicles and pedestrians. */
  trafficRevision = 0;
  terrainRevision = 0;
  /**
   * Bumped by pole and wire edits, which do NOT move `revision`: a pole is
   * not part of the road network, and moving `revision` for one rebuilt the
   * network, the lanelets, the whole simulation topology and every road mesh
   * - about 330 ms per pole on a 180-segment map (tests/bench) - to draw a
   * post. The renderer's utility layer and the pedestrians' obstacles
   * (`sim/peds/clearance.ts`, `waitArea.ts`) watch this instead.
   */
  utilityRevision = 0;

  readonly dirtyNodes = new Set<NodeId>();
  readonly dirtySegments = new Set<SegmentId>();

  node(id: NodeId): RoadNode | undefined {
    return this.nodes.get(id);
  }

  segment(id: SegmentId): RoadSegment | undefined {
    return this.segments.get(id);
  }

  requireNode(id: NodeId): RoadNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`RoadDoc: missing node ${id}`);
    return n;
  }

  requireSegment(id: SegmentId): RoadSegment {
    const s = this.segments.get(id);
    if (!s) throw new Error(`RoadDoc: missing segment ${id}`);
    return s;
  }

  pole(id: PoleId): UtilityPole | undefined {
    return this.poles.get(id);
  }

  addPole(at: { x: number; y: number }, lamp = false): UtilityPole {
    const on = clampToMap(at);
    const id = asPoleId(this.poleIds.take());
    const pole: UtilityPole = { id, x: on.x, y: on.y, lamp };
    this.poles.set(id, pole);
    this.utilityRevision++;
    return pole;
  }

  /** Strings wire between two existing poles. Returns null for a degenerate run. */
  addPoleSpan(a: PoleId, b: PoleId): UtilitySpan | null {
    if (a === b) return null;
    if (!this.poles.has(a) || !this.poles.has(b)) return null;
    for (const existing of this.poleSpans.values()) {
      const same = existing.a === a && existing.b === b;
      const reversed = existing.a === b && existing.b === a;
      if (same || reversed) return existing;
    }
    const id = asSpanId(this.spanIds.take());
    const span: UtilitySpan = { id, a, b };
    this.poleSpans.set(id, span);
    this.utilityRevision++;
    return span;
  }

  /** Draws a barrier along `points` (two or more, on the map). */
  addBarrier(kind: BarrierKind, points: readonly { x: number; y: number }[]): Barrier | null {
    const path = points.map((p) => clampToMap(p));
    if (path.length < 2) return null;
    const barrier: Barrier = { id: this.barrierIds.take(), kind, points: path.map((p) => ({ x: p.x, y: p.y })) };
    this.barriers.set(barrier.id, barrier);
    this.barrierRevision++;
    return barrier;
  }

  removeBarrier(id: number): boolean {
    if (!this.barriers.delete(id)) return false;
    this.barrierRevision++;
    return true;
  }

  /** The barrier whose path passes nearest a point, within `radius`, or null. */
  barrierNear(at: { x: number; y: number }, radius: number): Barrier | null {
    let best: Barrier | null = null;
    let bestD = radius;
    for (const barrier of this.barriers.values()) {
      for (let i = 1; i < barrier.points.length; i++) {
        const a = barrier.points[i - 1]!, b = barrier.points[i]!;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = dx * dx + dy * dy;
        const t = len > 0 ? Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / len)) : 0;
        const d = Math.hypot(a.x + dx * t - at.x, a.y + dy * t - at.y);
        if (d < bestD) { bestD = d; best = barrier; }
      }
    }
    return best;
  }

  /** Removes a pole and every wire that reached it. */
  removePole(id: PoleId): void {
    if (!this.poles.delete(id)) return;
    for (const [spanId, span] of [...this.poleSpans]) {
      if (span.a === id || span.b === id) this.poleSpans.delete(spanId);
    }
    this.utilityRevision++;
  }

  /** The pole nearest a point, within `radius`, or null. */
  poleNear(at: { x: number; y: number }, radius: number): UtilityPole | null {
    let best: UtilityPole | null = null;
    let bestSq = radius * radius;
    for (const pole of this.poles.values()) {
      const dx = pole.x - at.x;
      const dy = pole.y - at.y;
      const d = dx * dx + dy * dy;
      if (d <= bestSq) {
        bestSq = d;
        best = pole;
      }
    }
    return best;
  }

  degree(id: NodeId): number {
    return this.nodes.get(id)?.incident.length ?? 0;
  }

  // ---------------------------------------------------------------- mutation

  /**
   * Adds a node, ON THE MAP.
   *
   * The ground is a finite plate, and every position authored here is clamped
   * to it. Nothing else could enforce it: a node is what a road, its footway,
   * its junction, its lamps, its bins and its lanelets are all derived from,
   * so a node past the rim takes all of them with it — a road hanging over the
   * void, which is what "nothing may leave the map" was reported against.
   */
  addNode(p: Vec2, heightOffset = 0, smooth = false): RoadNode {
    const at = clampToMap(p);
    const id = asNodeId(this.nodeIds.take());
    const n: RoadNode = { id, x: at.x, y: at.y, heightOffset, smooth,
      incident: [], control: 'auto', blockedMovements: [] };
    this.nodes.set(id, n);
    this.markNode(id);
    return n;
  }

  /** Whether a road at `structure` already joins `a` and `b` directly. */
  connects(a: NodeId, b: NodeId, structure: RoadStructure): boolean {
    const node = this.nodes.get(a);
    if (!node) return false;
    return node.incident.some((id) => {
      const s = this.segments.get(id);
      return s !== undefined && s.structure === structure && ((s.a === a && s.b === b) || (s.a === b && s.b === a));
    });
  }

  addSegment(
    a: NodeId,
    b: NodeId,
    type: number,
    curve: CurveShape | null = null,
    dashOrigin = 0,
    direction: SegmentDirection = 'both',
    lanes: number | null = null,
    structure: RoadStructure = 'ground',
    section?: RoadSection,
  ): RoadSegment | null {
    if (a === b) return null;
    if (!this.nodes.has(a) || !this.nodes.has(b)) return null;
    const authoredSection = normalizeRoadSection(section);
    const id = asSegmentId(this.segIds.take());
    const s: RoadSegment = {
      id, a, b, curve, type, dashOrigin, direction,
      lanes: normaliseLaneCount(lanes, direction),
      structure,
      ...(authoredSection ? { section: authoredSection } : {}),
    };
    this.segments.set(id, s);
    this.requireNode(a).incident.push(id);
    this.requireNode(b).incident.push(id);
    this.fitCurve(s);
    this.markSegment(id);
    return s;
  }

  removeSegment(id: SegmentId): void {
    const s = this.segments.get(id);
    if (!s) return;
    this.markSegment(id);
    detach(this.nodes.get(s.a), id);
    detach(this.nodes.get(s.b), id);
    // A turn ban naming a road that is gone bans nothing - until the id is
    // handed out again and it silently bans a movement onto an unrelated road.
    for (const end of [s.a, s.b]) {
      const n = this.nodes.get(end);
      if (!n) continue;
      for (let i = n.blockedMovements.length - 1; i >= 0; i--) {
        if (movementMentions(n.blockedMovements[i] as string, id)) n.blockedMovements.splice(i, 1);
      }
    }
    this.segments.delete(id);
  }

  /**
   * Re-applies the turn bans `saved` at `node` that named segment `from`, naming
   * `to` instead. Splitting a road (which happens whenever a new road crosses
   * it) and joining two replace its segment ids; the player's bans used to be
   * left naming the old id, so they silently stopped applying.
   */
  carryMovements(node: NodeId, saved: readonly string[], from: SegmentId, to: SegmentId): void {
    const n = this.nodes.get(node);
    if (!n) return;
    for (const key of saved) {
      if (!movementMentions(key, from)) continue;
      const [a, b] = key.split('>') as [string, string];
      const moved = `${a === String(from) ? to : a}>${b === String(from) ? to : b}`;
      if (!n.blockedMovements.includes(moved)) n.blockedMovements.push(moved);
    }
    this.dirtyNodes.add(node);
    this.trafficRevision++;
  }

  removeNode(id: NodeId): void {
    const n = this.nodes.get(id);
    if (!n) return;
    for (const sid of n.incident.slice()) this.removeSegment(sid);
    this.nodes.delete(id);
    this.dirtyNodes.add(id);
    this.revision++;
    this.trafficRevision++;
  }

  /**
   * Rewires every segment from `source` into `target`, then removes `source`.
   * Used by legacy-map repair after a visually touching endpoint is projected
   * onto and split into the road it was meant to join.
   */
  mergeNodes(target: NodeId, source: NodeId): boolean {
    if (target === source) return true;
    const keep = this.nodes.get(target);
    const remove = this.nodes.get(source);
    if (!keep || !remove) return false;
    if (Math.abs(keep.heightOffset - remove.heightOffset) > 0.75) return false;

    if (keep.control === 'auto' && remove.control !== 'auto') keep.control = remove.control;
    for (const movement of remove.blockedMovements) {
      if (!keep.blockedMovements.includes(movement)) keep.blockedMovements.push(movement);
    }

    for (const id of remove.incident.slice()) {
      const segment = this.segments.get(id);
      if (!segment) continue;
      const other = segment.a === source ? segment.b : segment.a;
      // A road to the node being kept folds to nothing; a road to a neighbour
      // the kept node already reaches would become a second road between the
      // same two nodes - overlapping ribbons and doubled lanes. Both go.
      if (other === target || this.connects(target, other, segment.structure)) {
        this.removeSegment(id);
        continue;
      }
      if (segment.a === source) segment.a = target;
      if (segment.b === source) segment.b = target;
      detach(remove, id);
      if (!keep.incident.includes(id)) keep.incident.push(id);
      this.markSegment(id);
    }
    this.nodes.delete(source);
    this.dirtyNodes.add(source);
    this.markNode(target);
    return true;
  }

  /** Moves a node freely; junction geometry adapts to the resulting angle. */
  moveNode(id: NodeId, to: Vec2): boolean {
    const n = this.nodes.get(id);
    if (!n) return false;
    // Dragging a node off the plate is the same offence as building one there,
    // and is caught in the same place.
    const p = clampToMap(to);
    if (n.x === p.x && n.y === p.y) return true;

    n.x = p.x;
    n.y = p.y;
    this.markNode(id);
    for (const segId of n.incident) {
      const seg = this.segments.get(segId);
      if (seg) this.fitCurve(seg);
    }
    return true;
  }

  /**
   * A curve is never tighter than its road is wide.
   *
   * Every band of a road is an offset of its centreline, and an offset larger
   * than the radius folds back on itself: the inner kerb crosses over, the
   * junction mouth tears open (`open-mouth-seam-after-move`: an elevated
   * spur dragged to a 16.8-unit bend on a 30-unit-wide casing), and an inner
   * lane that should start past the mouth starts behind it
   * (`open-lane-end-inside-mouth-after-joint-scaling`). So whatever sets a
   * curve, moves an end or widens a road, the bulge is flattened until the
   * tightest bend clears the outermost band.
   */
  private fitCurve(s: RoadSegment): void {
    if (!s.curve) return;
    const a = this.nodes.get(s.a);
    const b = this.nodes.get(s.b);
    if (!a || !b) return;
    const fitted = fitRoadCurve(a, b, s.curve, s.type, s.lanes, s.direction, s.section);
    if (fitted !== s.curve) {
      s.curve = fitted;
      this.markSegment(s.id);
    }
  }

  setSegmentType(id: SegmentId, type: number): void {
    const s = this.segments.get(id);
    if (!s || s.type === type) return;
    s.type = type;
    this.fitCurve(s);
    this.markSegment(id);
  }

  setSegmentCurve(id: SegmentId, curve: CurveShape | null): void {
    const s = this.segments.get(id);
    if (!s) return;
    s.curve = curve;
    this.fitCurve(s);
    this.markSegment(id);
  }

  setSegmentDirection(id: SegmentId, direction: SegmentDirection): void {
    const s = this.segments.get(id);
    if (!s || s.direction === direction) return;
    s.direction = direction;
    s.lanes = normaliseLaneCount(s.lanes, direction);
    this.fitCurve(s);
    this.markSegment(id);
  }

  setSegmentLanes(id: SegmentId, lanes: number | null): void {
    const s = this.segments.get(id);
    const next = normaliseLaneCount(lanes, s?.direction ?? 'both');
    if (!s || s.lanes === next) return;
    s.lanes = next;
    this.fitCurve(s);
    this.markSegment(id);
  }

  /** Changes every section consumer through the existing geometry/topology revision gates. */
  setSegmentSection(id: SegmentId, section?: RoadSection): void {
    const segment = this.segments.get(id);
    const next = normalizeRoadSection(section);
    if (!segment || (section !== undefined && !next) || sameRoadSection(segment.section, next)) return;
    if (next) segment.section = next;
    else delete segment.section;
    this.fitCurve(segment);
    this.markSegment(id);
  }

  setSegmentStructure(id: SegmentId, structure: RoadStructure): void {
    const segment = this.segments.get(id);
    if (!segment || segment.structure === structure) return;
    segment.structure = structure;
    this.markSegment(id);
  }

  setNodeHeightOffset(id: NodeId, heightOffset: number): void {
    const node = this.nodes.get(id);
    if (!node || !Number.isFinite(heightOffset) || node.heightOffset === heightOffset) return;
    const junctionModeChanged = (node.heightOffset < -TUNNEL_HEADROOM) !==
      (heightOffset < -TUNNEL_HEADROOM);
    node.heightOffset = heightOffset;
    this.markNode(id, junctionModeChanged);
  }

  addTerrainStamp(value: Omit<TerrainStamp, 'id'>): TerrainStamp {
    const stamp: TerrainStamp = { ...value, id: this.nextTerrainId++ };
    this.terrainStamps.push(stamp);
    if (this.terrainStamps.length > MAX_TERRAIN_STAMPS) this.terrainStamps.shift();
    this.terrainRevision++;
    return stamp;
  }

  clearTerrain(): void {
    if (this.terrainStamps.length === 0) return;
    this.terrainStamps.length = 0;
    this.terrainRevision++;
  }

  setNodeControl(id: NodeId, control: JunctionControl): void {
    const n = this.nodes.get(id);
    if (!n || n.control === control) return;
    n.control = control;
    this.markNode(id);
  }

  setMovementBlocked(id: NodeId, from: SegmentId, to: SegmentId, blocked: boolean): void {
    const n = this.nodes.get(id);
    if (!n || from === to) return;
    const key = movementKey(from, to);
    const index = n.blockedMovements.indexOf(key);
    if (blocked && index < 0) n.blockedMovements.push(key);
    else if (!blocked && index >= 0) n.blockedMovements.splice(index, 1);
    else return;
    this.markNode(id);
  }

  /** Drops nodes with no incident segment. Returns how many were removed. */
  pruneOrphanNodes(): number {
    let removed = 0;
    for (const [id, n] of this.nodes) {
      if (n.incident.length === 0) {
        this.nodes.delete(id);
        this.dirtyNodes.add(id);
        removed++;
      }
    }
    if (removed) { this.revision++; this.trafficRevision++; }
    return removed;
  }

  // ------------------------------------------------------------ dirty marking

  /**
   * Marking a node dirty also marks every incident segment, and marking a
   * segment dirty marks both of its endpoints.
   *
   * That second edge matters more than it looks: adding a third leg at node A
   * changes the trim of segment S even though S itself did not change, and
   * moving node A changes S's *length*, which changes the trim clamp at node B.
   *
   * Read this next part before relying on any of it.
   *
   * The load-bearing effect of these methods today is `revision++`. Every
   * consumer — `Network`, `LaneletGraph`, `SimWorld`, the renderer's path cache,
   * the minimap — gates on a revision number, and `Network.rebuild()` then
   * rebuilds EVERYTHING unconditionally: it clears the polyline cache outright
   * and never consults `dirtyNodes` or `dirtySegments`. `PolylineCache.invalidate`
   * exists and is never called.
   *
   * So the dirty sets are a correctly-maintained hook for an incremental
   * rebuild that does not exist yet, not a live optimisation. They are kept
   * because getting this closure right is the hard part and it is already done;
   * do not assume they are making anything faster, and do not delete a
   * `markNode`/`markSegment` call on the grounds that "nothing reads it" — the
   * revision bump is what keeps every cache in the engine honest.
   */
  markNode(id: NodeId, traffic = true): void {
    // A node may already be dirty when it is edited again before a rebuild.
    // The dirty set is an invalidation *set*, while revision is a mutation
    // clock: every real edit must advance it even when the same id is present.
    this.dirtyNodes.add(id);
    this.revision++;
    if (traffic) this.trafficRevision++;
    const n = this.nodes.get(id);
    if (!n) return;
    for (const sid of n.incident) {
      if (!this.dirtySegments.has(sid)) {
        this.dirtySegments.add(sid);
        const s = this.segments.get(sid);
        if (s) {
          this.dirtyNodes.add(s.a);
          this.dirtyNodes.add(s.b);
        }
      }
    }
  }

  markSegment(id: SegmentId): void {
    this.dirtySegments.add(id);
    this.revision++;
    this.trafficRevision++;
    const s = this.segments.get(id);
    if (!s) return;
    this.dirtyNodes.add(s.a);
    this.dirtyNodes.add(s.b);
  }

  clearDirty(): void {
    this.dirtyNodes.clear();
    this.dirtySegments.clear();
  }

  /**
   * Makes an independent working copy, including allocator high-water marks.
   *
   * Copying only the serialized ids is insufficient after a high id has been
   * deleted: a speculative edit could otherwise recycle it.  Commits use this
   * clone so a failed operation never mutates the live document.
   */
  clone(): RoadDoc {
    const copy = RoadDoc.fromJSON(this.toJSON(), { repair: false });
    copy.nodeIds = new IdAllocator(this.nodeIds.peek);
    copy.segIds = new IdAllocator(this.segIds.peek);
    copy.poleIds = new IdAllocator(this.poleIds.peek);
    copy.spanIds = new IdAllocator(this.spanIds.peek);
    copy.barrierIds = new IdAllocator(this.barrierIds.peek);
    copy.barrierRevision = this.barrierRevision;
    copy.nextTerrainId = this.nextTerrainId;
    copy.revision = this.revision;
    copy.trafficRevision = this.trafficRevision;
    copy.terrainRevision = this.terrainRevision;
    copy.utilityRevision = this.utilityRevision;
    copy.clearDirty();
    for (const id of this.dirtyNodes) copy.dirtyNodes.add(id);
    for (const id of this.dirtySegments) copy.dirtySegments.add(id);
    copy.terrainStamps.length = 0;
    copy.terrainStamps.push(...this.terrainStamps.map((stamp) => ({ ...stamp })));
    copy.buildings.copyAllocator(this.buildings);
    copy.buildings.revision = this.buildings.revision;
    return copy;
  }

  /** Replaces this instance in place while restoring allocator invariants. */
  replaceFromJSON(data: SerializedDoc, options: { readonly repair?: boolean } = {}): void {
    const restored = RoadDoc.fromJSON(data, options);
    this.replaceWith(restored);
  }

  /** Replaces this instance from another valid document. */
  replaceWith(source: RoadDoc): void {
    const nextRevision = this.revision + 1;
    // The land moves only when its stamps do. Drawing a road replaces the whole
    // document with an edited clone (`commitDraft`), and bumping the terrain
    // revision for it rewrote all 90 601 terrain corners, their normals and
    // the rivers on every road drawn, for ground that had not changed.
    const landMoved = !sameStamps(this.terrainStamps, source.terrainStamps);
    const nextTerrainRevision = landMoved ? this.terrainRevision + 1 : this.terrainRevision;
    // Likewise the roads and the utility network: undoing a storey or a
    // brush dab replaced the whole document and moved both revisions, which
    // rebuilt every road mesh, the lanelets and the simulation topology for a
    // network that had not changed (AGENTS.md: a building edit never moves
    // `doc.revision`).
    const roadsChanged = !sameRoads(this, source);
    const utilitiesChanged = !samePoles(this, source);

    this.nodes.clear();
    this.segments.clear();
    for (const [id, node] of source.nodes) {
      this.nodes.set(id, {
        id, x: node.x, y: node.y, heightOffset: node.heightOffset, smooth: node.smooth,
        incident: [...node.incident], control: node.control,
        blockedMovements: [...node.blockedMovements],
      });
    }
    for (const [id, segment] of source.segments) {
      this.segments.set(id, {
        ...segment,
        curve: segment.curve ? { ...segment.curve } : null,
        ...(segment.section ? { section: { ...segment.section } } : {}),
      });
    }
    this.poles.clear();
    this.poleSpans.clear();
    for (const [id, pole] of source.poles) this.poles.set(id, { ...pole });
    if (utilitiesChanged) this.utilityRevision++;
    for (const [id, span] of source.poleSpans) this.poleSpans.set(id, { ...span });
    if (!sameBarriers(this, source)) {
      this.barriers.clear();
      for (const [id, barrier] of source.barriers) this.barriers.set(id, { ...barrier, points: barrier.points.map((p) => ({ ...p })) });
      this.barrierRevision++;
    }
    // Moves `buildings.revision` only if the buildings differ.
    this.buildings.replaceWith(source.buildings);
    if (JSON.stringify(this.people) !== JSON.stringify(source.people)) {
      this.people.length = 0;
      this.people.push(...source.people.map((p) => JSON.parse(JSON.stringify(p)) as PersonSpec));
      this.peopleRevision++;
    }

    if (landMoved) {
      this.terrainStamps.length = 0;
      this.terrainStamps.push(...source.terrainStamps.map((stamp) => ({ ...stamp })));
    }

    this.nodeIds = new IdAllocator(source.nodeIds.peek);
    this.segIds = new IdAllocator(source.segIds.peek);
    this.poleIds = new IdAllocator(source.poleIds.peek);
    this.spanIds = new IdAllocator(source.spanIds.peek);
    this.barrierIds = new IdAllocator(source.barrierIds.peek);
    this.nextTerrainId = source.nextTerrainId;
    this.terrainRevision = nextTerrainRevision;
    if (!roadsChanged) return;
    this.clearDirty();
    for (const id of this.nodes.keys()) this.dirtyNodes.add(id);
    for (const id of this.segments.keys()) this.dirtySegments.add(id);
    this.revision = nextRevision;
    this.trafficRevision++;
  }

  // ------------------------------------------------------------ serialization

  toJSON(): SerializedDoc {
    return {
      version: 1,
      nodes: [...this.nodes.values()].map((n) => ({
        // Copied, never aliased. `setMovementBlocked` mutates this array in
        // place (`push`/`splice`), so handing out the live reference made every
        // history snapshot taken "before" an edit pick up that edit: the
        // snapshot recorded as the pre-block state already contained the block,
        // and one undo restored it unchanged. `History` promises snapshots hold
        // the document as it was; an alias cannot.
        id: n.id, x: n.x, y: n.y, heightOffset: n.heightOffset, smooth: n.smooth,
        control: n.control, blockedMovements: [...n.blockedMovements],
      })),
      segments: [...this.segments.values()].map((s) => ({
        id: s.id,
        a: s.a,
        b: s.b,
        type: s.type,
        curve: s.curve ? { ...s.curve } : null,
        dashOrigin: s.dashOrigin,
        direction: s.direction,
        lanes: s.lanes,
        structure: s.structure,
        ...(s.section ? { section: { ...s.section } } : {}),
      })),
      terrain: this.terrainStamps.map((stamp) => ({ ...stamp })),
      poles: [...this.poles.values()].map((p) => ({ id: p.id, x: p.x, y: p.y, lamp: p.lamp })),
      poleSpans: [...this.poleSpans.values()].map((s) => ({ id: s.id, a: s.a, b: s.b })),
      // Only when there are any, so a map without them serialises as before.
      ...(this.barriers.size > 0 ? {
        barriers: [...this.barriers.values()].map((b) => ({ id: b.id, kind: b.kind, points: b.points.map((p) => ({ x: p.x, y: p.y })) })),
      } : {}),
      // Only when there are any, so a map without buildings serialises
      // exactly as it did before buildings existed.
      ...(this.buildings.size > 0 ? { buildings: this.buildings.toJSON() } : {}),
      // Likewise the people: only a city that has some carries the key.
      ...(this.people.length > 0 ? { people: this.people.map((p) => JSON.parse(JSON.stringify(p)) as PersonSpec) } : {}),
    };
  }

  /**
   * Builds a document from its serialized form.
   *
   * `repair` (the default) is for data entering the model from outside - an
   * autosave, an imported file: coincident nodes are merged and positions are
   * clamped onto the map. A clone or an undo snapshot is the model's own state
   * and must come back EXACTLY (`repair: false`): merging there deleted a road
   * the player could see the next time they drew, undid or reloaded.
   */
  static fromJSON(data: SerializedDoc, options: { readonly repair?: boolean } = {}): RoadDoc {
    const repair = options.repair ?? true;
    const doc = new RoadDoc();
    const canonicalNode = new Map<number, NodeId>();
    const nodeAt = new Map<string, RoadNode>();
    for (const n of data.nodes) {
      // Maps produced before cross-structure snapping was fixed can contain two
      // endpoint records at the exact same world position.  They render as one
      // junction but remain two disconnected graphs, so raised spans never see
      // the ground road they are meant to ramp into.  New edits cannot create
      // this state; repair it at the serialization boundary where legacy maps
      // enter the model.
      doc.nodeIds.reserve(n.id);
      const heightOffset = Number.isFinite(n.heightOffset) ? (n.heightOffset as number) : 0;
      const key = `${coordinateKey(n.x, n.y)}\u0000${heightOffset}`;
      const existing = repair ? nodeAt.get(key) : undefined;
      if (existing) {
        canonicalNode.set(n.id, existing.id);
        if (existing.control === 'auto' && n.control && n.control !== 'auto') {
          existing.control = n.control;
        }
        for (const movement of n.blockedMovements ?? []) {
          if (!existing.blockedMovements.includes(movement)) existing.blockedMovements.push(movement);
        }
        continue;
      }
      const id = asNodeId(n.id);
      // Nothing may leave the map (`addNode`/`moveNode` clamp); a file can.
      const at = repair ? clampToMap(n) : n;
      const node: RoadNode = {
        id, x: at.x, y: at.y, heightOffset, smooth: n.smooth ?? false,
        incident: [], control: n.control ?? 'auto',
        blockedMovements: n.blockedMovements ? [...n.blockedMovements] : [],
      };
      doc.nodes.set(id, node);
      nodeAt.set(key, node);
      canonicalNode.set(n.id, id);
    }
    for (const s of data.segments) {
      const id = asSegmentId(s.id);
      const a = canonicalNode.get(s.a) ?? asNodeId(s.a);
      const b = canonicalNode.get(s.b) ?? asNodeId(s.b);
      if (!doc.nodes.has(a) || !doc.nodes.has(b) || a === b) continue;
      const section = normalizeRoadSection(s.section);
      doc.segments.set(id, {
        id,
        a,
        b,
        type: s.type,
        curve: s.curve ?? null,
        dashOrigin: s.dashOrigin ?? 0,
        direction: s.direction ?? 'both',
        lanes: normaliseLaneCount(s.lanes ?? null, s.direction ?? 'both'),
        ...(section ? { section } : {}),
        // Through the migration, so a level that has since been merged into
        // another (`viaduct`) loads as the one it became.
        structure: migrateStructure(s.structure) ?? 'ground',
      });
      doc.requireNode(a).incident.push(id);
      doc.requireNode(b).incident.push(id);
      doc.segIds.reserve(s.id);
    }
    for (const stamp of data.terrain ?? []) {
      doc.terrainStamps.push({ ...stamp });
      doc.nextTerrainId = Math.max(doc.nextTerrainId, stamp.id + 1);
    }

    // The utility network, if the map has one. A map saved before poles
    // existed simply has no such key, and must load exactly as it did before.
    for (const p of data.poles ?? []) {
      const id = asPoleId(p.id);
      const at = repair ? clampToMap(p) : p;
      doc.poles.set(id, { id, x: at.x, y: at.y, lamp: p.lamp ?? false });
      doc.poleIds.reserve(p.id);
    }
    for (const s of data.poleSpans ?? []) {
      const a = asPoleId(s.a);
      const b = asPoleId(s.b);
      // A span whose poles did not survive is dropped rather than restored as
      // a wire hanging off nothing.
      if (!doc.poles.has(a) || !doc.poles.has(b)) continue;
      const id = asSpanId(s.id);
      doc.poleSpans.set(id, { id, a, b });
      doc.spanIds.reserve(s.id);
    }
    // Walls, fences and hedges, if the map has any; anything malformed is dropped.
    for (const raw of data.barriers ?? []) {
      if (!isBarrierKind(raw.kind) || !Array.isArray(raw.points)) continue;
      const points = raw.points.filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
        .map((p) => (repair ? clampToMap(p) : { x: p.x, y: p.y }));
      if (points.length < 2) continue;
      doc.barriers.set(raw.id, { id: raw.id, kind: raw.kind, points });
      doc.barrierIds.reserve(raw.id);
    }
    // Buildings, if the map has any; each one through `migrateBuilding`.
    if (data.buildings) doc.buildings.load(data.buildings);
    // People, each brought into range; anything that is not one is dropped.
    const seen = new Set<number>();
    for (const raw of data.people ?? []) {
      const person = normalizePerson(raw);
      if (!person || seen.has(person.id)) continue;
      seen.add(person.id);
      doc.people.push(person);
    }
    for (const id of doc.nodes.keys()) doc.dirtyNodes.add(id);
    for (const id of doc.segments.keys()) doc.dirtySegments.add(id);
    doc.revision = 1;
    doc.trafficRevision = 1;
    doc.terrainRevision = data.terrain?.length ? 1 : 0;
    return doc;
  }
}

/** Exact serialization key; normalises the two JavaScript spellings of zero. */
function coordinateKey(x: number, y: number): string {
  const nx = Object.is(x, -0) ? 0 : x;
  const ny = Object.is(y, -0) ? 0 : y;
  return `${nx}\u0000${ny}`;
}

export interface SerializedDoc {
  readonly version: 1;
  readonly nodes: readonly {
    id: number; x: number; y: number; heightOffset?: number; smooth?: boolean;
    control?: JunctionControl; blockedMovements?: readonly string[];
  }[];
  readonly segments: readonly {
    id: number;
    a: number;
    b: number;
    type: number;
    curve: CurveShape | null;
    dashOrigin?: number;
    direction?: SegmentDirection;
    lanes?: number | null;
    section?: RoadSection;
    /** A current structure id, or a legacy one `migrateStructure` maps. */
    structure?: RoadStructure | 'viaduct';
  }[];
  readonly terrain?: readonly TerrainStamp[];
  /**
   * The utility network. OPTIONAL, and it has to stay that way: every map
   * saved before poles existed has no such key, and loading one must not
   * fail or silently drop the roads around it.
   */
  readonly poles?: readonly { id: number; x: number; y: number; lamp?: boolean }[];
  readonly poleSpans?: readonly { id: number; a: number; b: number }[];
  /** Walls, fences and hedges (`barriers.ts`); OPTIONAL like the poles. */
  readonly barriers?: readonly { id: number; kind: string; points: readonly { x: number; y: number }[] }[];
  /**
   * Modular buildings (docs/buildings.md). OPTIONAL, for the same reason as
   * the poles: every map saved before buildings existed has no such key.
   */
  readonly buildings?: readonly SerializedBuilding[];
  /** People from the Person Creator; OPTIONAL like the buildings. Normalised on load. */
  readonly people?: readonly unknown[];
}

function detach(n: RoadNode | undefined, id: SegmentId): void {
  if (!n) return;
  const i = n.incident.indexOf(id);
  if (i >= 0) n.incident.splice(i, 1);
}

function normaliseLaneCount(lanes: number | null, direction: SegmentDirection): number | null {
  if (lanes === null) return null;
  const value = Math.max(1, Math.min(8, Math.round(lanes)));
  // A two-way road must have an equal number of lanes on both sides.
  return direction === 'both' ? Math.max(2, Math.ceil(value / 2) * 2) : value;
}

/** Whether two stamp lists describe the same land, field for field. */
/** Whether two documents hold the same nodes and segments, field for field. */
function sameRoads(a: RoadDoc, b: RoadDoc): boolean {
  if (a.nodes.size !== b.nodes.size || a.segments.size !== b.segments.size) return false;
  for (const [id, p] of a.nodes) {
    const q = b.nodes.get(id);
    if (!q || p.x !== q.x || p.y !== q.y || p.heightOffset !== q.heightOffset || p.smooth !== q.smooth ||
      p.control !== q.control || !sameList(p.incident, q.incident) || !sameList(p.blockedMovements, q.blockedMovements)) return false;
  }
  for (const [id, p] of a.segments) {
    const q = b.segments.get(id);
    if (!q || p.a !== q.a || p.b !== q.b || p.type !== q.type || p.dashOrigin !== q.dashOrigin ||
      p.direction !== q.direction || p.lanes !== q.lanes || p.structure !== q.structure ||
      !sameRoadSection(p.section, q.section) ||
      (p.curve?.t ?? null) !== (q.curve?.t ?? null) || (p.curve?.h ?? null) !== (q.curve?.h ?? null)) return false;
  }
  return true;
}

/** Whether two documents hold the same poles and spans. */
function samePoles(a: RoadDoc, b: RoadDoc): boolean {
  if (a.poles.size !== b.poles.size || a.poleSpans.size !== b.poleSpans.size) return false;
  for (const [id, p] of a.poles) {
    const q = b.poles.get(id);
    if (!q || p.x !== q.x || p.y !== q.y || p.lamp !== q.lamp) return false;
  }
  for (const [id, p] of a.poleSpans) {
    const q = b.poleSpans.get(id);
    if (!q || p.a !== q.a || p.b !== q.b) return false;
  }
  return true;
}

/** Whether two documents hold the same barriers, point for point. */
function sameBarriers(a: RoadDoc, b: RoadDoc): boolean {
  if (a.barriers.size !== b.barriers.size) return false;
  for (const [id, p] of a.barriers) {
    const q = b.barriers.get(id);
    if (!q || p.kind !== q.kind || p.points.length !== q.points.length) return false;
    for (let i = 0; i < p.points.length; i++) {
      if (p.points[i]!.x !== q.points[i]!.x || p.points[i]!.y !== q.points[i]!.y) return false;
    }
  }
  return true;
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameStamps(a: readonly TerrainStamp[], b: readonly TerrainStamp[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] as TerrainStamp;
    const q = b[i] as TerrainStamp;
    if (p === q) continue;
    const keys = new Set([...Object.keys(p), ...Object.keys(q)]) as Set<keyof TerrainStamp>;
    for (const key of keys) if (p[key] !== q[key]) return false;
  }
  return true;
}
