import type { Vec2 } from '@core/vec2';
import type { CurveShape } from '@core/bezier';
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
// Runtime imports, and safe: `geometry` and `legAngles` take `RoadDoc` as a
// TYPE only, so nothing here is part of a runtime cycle.
import { impossibleAmong, worsensAnyNode } from './legAngles';
import { type RoadStructure, migrateStructure } from './structures';
import { MAX_TERRAIN_STAMPS, type TerrainStamp } from './terrain';
import { clampToMap } from './bounds';
import { BuildingStore } from './buildings/store';
import type { SerializedBuilding } from './buildings/serialize';

/** Legal driving directions, relative to the stored `a -> b` orientation. */
export type SegmentDirection = 'both' | 'aToB' | 'bToA';

/** Explicit junction policy. `auto` retains the class-based default policy. */
export type JunctionControl = 'auto' | 'signal' | 'stop' | 'yield' | 'priority' | 'none';

/** Stable segment-pair key for a movement through a junction. */
export const movementKey = (from: SegmentId, to: SegmentId): string => `${from}>${to}`;

export interface RoadNode {
  readonly id: NodeId;
  x: number;
  y: number;
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
  /** Vertical construction mode. Ground is the legacy/default value. */
  structure: RoadStructure;
}

/**
 * The authoring document: what the user drew, before any derived geometry.
 *
 * Mutations are applied here and mark entities dirty; `GeometryCache.commit()`
 * then rebuilds only what changed. Nothing in this file knows about lanes,
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

  /** Bumped on every structural change; consumers use it to invalidate caches. */
  revision = 0;
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
  addNode(p: Vec2): RoadNode {
    const at = clampToMap(p);
    const id = asNodeId(this.nodeIds.take());
    const n: RoadNode = { id, x: at.x, y: at.y, incident: [], control: 'auto', blockedMovements: [] };
    this.nodes.set(id, n);
    this.markNode(id);
    return n;
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
  ): RoadSegment | null {
    if (a === b) return null;
    if (!this.nodes.has(a) || !this.nodes.has(b)) return null;
    const id = asSegmentId(this.segIds.take());
    const s: RoadSegment = {
      id, a, b, curve, type, dashOrigin, direction,
      lanes: normaliseLaneCount(lanes, direction),
      structure,
    };
    this.segments.set(id, s);
    this.requireNode(a).incident.push(id);
    this.requireNode(b).incident.push(id);
    this.markSegment(id);
    return s;
  }

  removeSegment(id: SegmentId): void {
    const s = this.segments.get(id);
    if (!s) return;
    this.markSegment(id);
    detach(this.nodes.get(s.a), id);
    detach(this.nodes.get(s.b), id);
    this.segments.delete(id);
  }

  removeNode(id: NodeId): void {
    const n = this.nodes.get(id);
    if (!n) return;
    for (const sid of n.incident.slice()) this.removeSegment(sid);
    this.nodes.delete(id);
    this.dirtyNodes.add(id);
    this.revision++;
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

    if (keep.control === 'auto' && remove.control !== 'auto') keep.control = remove.control;
    for (const movement of remove.blockedMovements) {
      if (!keep.blockedMovements.includes(movement)) keep.blockedMovements.push(movement);
    }

    for (const id of remove.incident.slice()) {
      const segment = this.segments.get(id);
      if (!segment) continue;
      const other = segment.a === source ? segment.b : segment.a;
      if (other === target) {
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

  /**
   * Moves a node, and REFUSES a move that closes a junction below the minimum.
   *
   * Returns whether the move was kept. D-020 recorded that this had no guard at
   * all: drawing a road was checked against `MIN_LEG_ANGLE` and then the move
   * tool let the user drag the very same node into a 7-degree hairpin, which is
   * how a map ends up with a shape no drag could have drawn.
   *
   * Both ends matter. Moving a node changes the angles at that node AND at the
   * far end of every road leaving it, because a leg's direction is a property
   * of the pair. Checking only the node under the cursor lets the drag wreck the
   * junction at the other end of the street.
   *
   * The move is applied and then rolled back on refusal rather than being
   * predicted: the angles come from the flattened polyline, and a curve's
   * tangent is not a closed form of the endpoint.
   */
  moveNode(id: NodeId, to: Vec2): boolean {
    const n = this.nodes.get(id);
    if (!n) return false;
    // Dragging a node off the plate is the same offence as building one there,
    // and is caught in the same place.
    const p = clampToMap(to);
    if (n.x === p.x && n.y === p.y) return true;

    const touched: NodeId[] = [id];
    for (const segId of n.incident) {
      const seg = this.segments.get(segId);
      if (seg) touched.push(seg.a === id ? seg.b : seg.a);
    }

    // What these nodes were BEFORE the drag, so the verdict can be about the
    // drag. Refusing on the absolute state instead is a trap that shuts in both
    // directions: a node that is already a hairpin fails the absolute test no
    // matter where it is dragged, so the one gesture that could repair it — pull
    // the legs apart — is the one gesture refused. Measured: a 7-degree node
    // could not be dragged anywhere at all, not even straight into a clean
    // right angle.
    const before = impossibleAmong(this, touched);

    const wasX = n.x;
    const wasY = n.y;
    n.x = p.x;
    n.y = p.y;
    this.markNode(id);

    if (worsensAnyNode(before, impossibleAmong(this, touched))) {
      n.x = wasX;
      n.y = wasY;
      this.markNode(id);
      return false;
    }
    return true;
  }

  setSegmentType(id: SegmentId, type: number): void {
    const s = this.segments.get(id);
    if (!s || s.type === type) return;
    s.type = type;
    this.markSegment(id);
  }

  setSegmentCurve(id: SegmentId, curve: CurveShape | null): void {
    const s = this.segments.get(id);
    if (!s) return;
    s.curve = curve;
    this.markSegment(id);
  }

  setSegmentDirection(id: SegmentId, direction: SegmentDirection): void {
    const s = this.segments.get(id);
    if (!s || s.direction === direction) return;
    s.direction = direction;
    s.lanes = normaliseLaneCount(s.lanes, direction);
    this.markSegment(id);
  }

  setSegmentLanes(id: SegmentId, lanes: number | null): void {
    const s = this.segments.get(id);
    const next = normaliseLaneCount(lanes, s?.direction ?? 'both');
    if (!s || s.lanes === next) return;
    s.lanes = next;
    this.markSegment(id);
  }

  setSegmentStructure(id: SegmentId, structure: RoadStructure): void {
    const segment = this.segments.get(id);
    if (!segment || segment.structure === structure) return;
    segment.structure = structure;
    this.markSegment(id);
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
    if (removed) this.revision++;
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
  markNode(id: NodeId): void {
    // A node may already be dirty when it is edited again before a rebuild.
    // The dirty set is an invalidation *set*, while revision is a mutation
    // clock: every real edit must advance it even when the same id is present.
    this.dirtyNodes.add(id);
    this.revision++;
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
    const copy = RoadDoc.fromJSON(this.toJSON());
    copy.nodeIds = new IdAllocator(this.nodeIds.peek);
    copy.segIds = new IdAllocator(this.segIds.peek);
    copy.poleIds = new IdAllocator(this.poleIds.peek);
    copy.spanIds = new IdAllocator(this.spanIds.peek);
    copy.nextTerrainId = this.nextTerrainId;
    copy.revision = this.revision;
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
  replaceFromJSON(data: SerializedDoc): void {
    const restored = RoadDoc.fromJSON(data);
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

    this.nodes.clear();
    this.segments.clear();
    for (const [id, node] of source.nodes) {
      this.nodes.set(id, {
        id, x: node.x, y: node.y, incident: [...node.incident], control: node.control,
        blockedMovements: [...node.blockedMovements],
      });
    }
    for (const [id, segment] of source.segments) {
      this.segments.set(id, {
        ...segment,
        curve: segment.curve ? { ...segment.curve } : null,
      });
    }
    this.poles.clear();
    this.poleSpans.clear();
    for (const [id, pole] of source.poles) this.poles.set(id, { ...pole });
    this.utilityRevision++;
    for (const [id, span] of source.poleSpans) this.poleSpans.set(id, { ...span });
    // Moves `buildings.revision` only if the buildings differ.
    this.buildings.replaceWith(source.buildings);

    if (landMoved) {
      this.terrainStamps.length = 0;
      this.terrainStamps.push(...source.terrainStamps.map((stamp) => ({ ...stamp })));
    }

    this.nodeIds = new IdAllocator(source.nodeIds.peek);
    this.segIds = new IdAllocator(source.segIds.peek);
    this.poleIds = new IdAllocator(source.poleIds.peek);
    this.spanIds = new IdAllocator(source.spanIds.peek);
    this.nextTerrainId = source.nextTerrainId;
    this.terrainRevision = nextTerrainRevision;
    this.clearDirty();
    for (const id of this.nodes.keys()) this.dirtyNodes.add(id);
    for (const id of this.segments.keys()) this.dirtySegments.add(id);
    this.revision = nextRevision;
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
        id: n.id, x: n.x, y: n.y, control: n.control, blockedMovements: [...n.blockedMovements],
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
      })),
      terrain: this.terrainStamps.map((stamp) => ({ ...stamp })),
      poles: [...this.poles.values()].map((p) => ({ id: p.id, x: p.x, y: p.y, lamp: p.lamp })),
      poleSpans: [...this.poleSpans.values()].map((s) => ({ id: s.id, a: s.a, b: s.b })),
      // Only when there are any, so a map without buildings serialises
      // exactly as it did before buildings existed.
      ...(this.buildings.size > 0 ? { buildings: this.buildings.toJSON() } : {}),
    };
  }

  static fromJSON(data: SerializedDoc): RoadDoc {
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
      const key = coordinateKey(n.x, n.y);
      const existing = nodeAt.get(key);
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
      const node: RoadNode = {
        id, x: n.x, y: n.y, incident: [], control: n.control ?? 'auto',
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
      doc.segments.set(id, {
        id,
        a,
        b,
        type: s.type,
        curve: s.curve ?? null,
        dashOrigin: s.dashOrigin ?? 0,
        direction: s.direction ?? 'both',
        lanes: normaliseLaneCount(s.lanes ?? null, s.direction ?? 'both'),
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
      doc.poles.set(id, { id, x: p.x, y: p.y, lamp: p.lamp ?? false });
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
    // Buildings, if the map has any; each one through `migrateBuilding`.
    if (data.buildings) doc.buildings.load(data.buildings);
    for (const id of doc.nodes.keys()) doc.dirtyNodes.add(id);
    for (const id of doc.segments.keys()) doc.dirtySegments.add(id);
    doc.revision = 1;
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
    id: number; x: number; y: number; control?: JunctionControl; blockedMovements?: readonly string[];
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
  /**
   * Modular buildings (docs/buildings.md). OPTIONAL, for the same reason as
   * the poles: every map saved before buildings existed has no such key.
   */
  readonly buildings?: readonly SerializedBuilding[];
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
