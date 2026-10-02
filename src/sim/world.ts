import { Rng } from '@core/rng';
import type { NodeId, SegmentId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { type Connector, type Lanelet, type LaneletId, LaneletGraph } from '@world/lanelets';
import { ConflictIndex, type BodyClass } from '@world/conflictPoints';
import { SimClock } from './clock';
import { ClaimTable } from './intersections/claims';
import type { Vehicle, VehicleId } from './vehicles/state';
import type { Ped, PedId } from './peds/state';
import { type SignalController, type SignalDeps, createController, rebuildController } from './signals/fsm';
import { type CrossingId, makeCrossingId } from './signals/plan';
import type { AuditIssue } from './audit';
import { SidewalkGraph, type SidewalkEdge } from './peds/sidewalk';
import { hasDownstreamStorage } from './intersections/spillback';
import { CrossingSpans } from './intersections/crossingSpans';
import { m } from '@world/units';
import { facadeBays } from '@world/buildings/geometry';
import { ACCESS_COMPONENTS } from '@world/buildings/foundation';
import type { CrossingStates } from './crossings/state';
import { publishCrossingStates, publishPedViews } from './peds/publish';
import type { PedView } from './people/view';
import type { PedestrianEngine } from './people/engine';
import { legacyPedestrians } from './peds/engine';
import { CityLife } from './city/life';
/** The body class a signal plan is protected for: an ordinary car. */const CAR_CLASS: BodyClass = 1;

/** A queue is counted this far back from the stop line. */
const DEMAND_QUEUE_REACH = m(80);
/** Moving vehicles are counted when they will arrive within this, seconds. */
const DEMAND_HORIZON = 12;
/** A head this close, or arriving within the passage time, keeps a green alive. */
const DEMAND_AT_LINE = m(8);
const DEMAND_PASSAGE = 3;
/** Seconds of waiting that double a queued vehicle's weight. */
const DEMAND_WAIT_WEIGHT = 30;

/** Vehicles occupying one lanelet, kept sorted by ascending arc position. */
export interface LaneletRuntime {
  readonly id: LaneletId;
  /** Ascending by `s`; index 0 is nearest the entry, last is nearest the exit. */
  order: VehicleId[];
  /**
   * Vehicles whose body still overlaps this lane while they slide out of it.
   * A lane change moves a vehicle's occupancy to the new lane at once, but its
   * body crosses the gap over the next second; until it has, anyone behind it
   * in the lane it is leaving must still see it. See `Vehicle.shadow`.
   */
  shadows: VehicleId[];
  /** A retired lanelet still carrying agents: no new entries accepted. */
  ghost: boolean;
  /** Tick at which a ghost was created, so it can be force-collected. */
  ghostSince: number;
}

/**
 * Everything the simulation owns.
 *
 * Read-only access to `world` topology, mutable agent state, and the indices
 * that make both cheap. Nothing here imports from `render`, `editor` or `ui`,
 * and a source scan in `tests/arch` enforces it.
 */
export class SimWorld {
  readonly clock = new SimClock();
  readonly graph = new LaneletGraph();
  readonly conflicts = new ConflictIndex();
  readonly sidewalks = new SidewalkGraph();
  readonly claims = new ClaimTable();

  readonly vehicles = new Map<VehicleId, Vehicle>();
  readonly peds = new Map<PedId, Ped>();
  /** What moves the people (`people/engine.ts`); everything else reaches them through it. */
  pedEngine: PedestrianEngine = legacyPedestrians;
  /** Which vehicle model drives: the legacy one, or Drive v2 (`drive/*`) as it replaces it layer by layer. */
  driveModel: 'v1' | 'v2' = 'v1';
  readonly runtime = new Map<LaneletId, LaneletRuntime>();
  readonly controllers = new Map<NodeId, SignalController>();

  /** Pedestrians currently inside each crossing. */
  readonly pedOccupancy = new Map<CrossingId, PedId[]>();
  /**
   * Pedestrians waiting at a kerb for each crossing, by the kerb they stand
   * at (`from` or `to` end of the crossing edge). Rebuilt every tick.
   */
  readonly pedWaiting = new Map<CrossingId, { from: number; to: number }>();
  /**
   * What vehicles, signals and the audit may know about the people at each
   * crossing (`crossings/state.ts`). Published by the pedestrian engine at the
   * end of its stage; the only pedestrian state read outside it.
   */
  readonly crossingStates: CrossingStates = new Map();
  /**
   * Every person as the renderer and the counters see them (`people/view.ts`),
   * in id order, published at the end of each tick. The object for an id lives
   * as long as the person.
   */
  readonly pedViews: PedView[] = [];
  readonly pedViewById = new Map<number, PedView>();
  /** Stretch of each zebra that each movement drives over. */
  readonly crossingSpans = new CrossingSpans();

  /**
   * Tick at which each junction last admitted a vehicle.
   *
   * This is what separates congestion from a wedge. A vehicle waiting its turn
   * at a junction that keeps admitting others is queued, and FIFO priority
   * guarantees its turn arrives. A junction that has admitted nobody for cycles
   * is genuinely stuck.
   */
  readonly lastAdmission = new Map<NodeId, number>();
  /**
   * The lane that last sent a vehicle into each lane two or more lanes merge
   * into, for the zipper (`zipperHolds` in `intersections/admission.ts`).
   */
  readonly mergeTurn = new Map<LaneletId, LaneletId>();
  /** Cumulative link entries since the current simulation session began. */
  readonly segmentVolume = new Map<number, number>();

  readonly rng: {
    readonly spawnVehicles: Rng;
    readonly spawnPeds: Rng;
    readonly driver: Rng;
    readonly route: Rng;
    readonly gap: Rng;
    readonly pedParams: Rng;
    readonly courtesy: Rng;
    readonly signalOffsets: Rng;
    /** The People engine's own stream (`people/people.ts`). */
    readonly people: Rng;
    readonly occupancy: Rng;
  };

  nextVehicleId = 1;
  nextPedId = 1;
  /** Per-world population timers; simulations must never influence each other. */
  vehicleSpawnClock = 0;
  pedSpawnClock = 0;
  /**
   * Traffic waiting to come in at each boundary entry lane: when its next
   * arrival is due, and the arrival times of vehicles held outside the map
   * because the entry was full (`sim/vehicles/spawn.ts`).
   */
  /** Per entry: the next arrival, the rate it was drawn at, and the arrivals waiting outside. */
  readonly entryDemand = new Map<LaneletId, { next: number; rate: number; waiting: number[] }>();
  /** Arrivals turned away because an entry's outside queue was full. */
  entryDemandLost = 0;
  /** Vehicles that reached the boundary exit chosen for their trip. */
  completedTrips = 0;
  /** User-facing density multipliers; topology and physics remain unchanged. */
  trafficIntensity = 1;
  pedestrianIntensity = 1;
  /** Shared demand multiplier for the current simulation period. */
  demandMultiplier = 1;
  /**
   * Traffic from outside: cars at the map's edge entries, people at doors and
   * road ends. Off once the city has residents (`sim/city`): what moves is
   * then their own trips.
   */
  edgeTraffic = true;
  /** The residents' days (`sim/city/life.ts`), stepped by the pipeline. */
  city: CityLife = new CityLife();
  /**
   * Share of the population ceilings this device carries (1, or
   * `NARROW_SCREEN_SHARE` on a narrow screen). SET BY THE COMPOSITION ROOT:
   * the spawners used to read `window.innerWidth` themselves, which put the
   * DOM inside `sim` and made the same seed grow a different city on a phone.
   */
  populationShare = 1;
  /**
   * Where the player is looking, world units, and whether people there are
   * drawn large enough to see how they step round each other. SET BY THE
   * RENDERER each frame; null (tests, harnesses) simulates everybody in full.
   * Out of it, people still follow their routes and keep off walls, but skip
   * negotiating with each other (`sim/people`): nobody can see that, and it
   * was most of a frame's simulation in a town.
   */
  focus: { readonly x: number; readonly y: number; readonly r: number; readonly detail: boolean } | null = null;

  auditEnabled = false;
  auditLevel: 'cheap' | 'full' = 'cheap';
  readonly issues: AuditIssue[] = [];

  /** Topology revision the indices were last built from. */
  topologyRevision = -1;
  /** Revision the vehicle half was last built from (`rebuildVehicleTopology`). */
  vehicleTopologyRevision = -1;
  /** Building revision whose walkable door links are currently attached. */
  buildingAccessRevision = -1;
  /** Utility revision and actual ground-access geometry of the current links. */
  accessUtilityRevision = -1;
  private accessSignature = '';

  constructor(
    readonly doc: RoadDoc,
    readonly net: Network,
    seed = 0x5eed,
  ) {
    const root = new Rng(seed);
    this.rng = {
      spawnVehicles: root.fork('spawnVehicles'),
      spawnPeds: root.fork('spawnPeds'),
      driver: root.fork('driver'),
      route: root.fork('routeChoice'),
      gap: root.fork('gapAcceptance'),
      pedParams: root.fork('pedParams'),
      courtesy: root.fork('courtesy'),
      signalOffsets: root.fork('signalOffsets'),
      occupancy: root.fork('occupancy'),
      people: root.fork('people'),
    };
  }

  /**
   * Forgets every agent and everything learned about the previous map.
   *
   * For loading a DIFFERENT document (open, import, new map). Lanelet and
   * footway ids are built from small integers and coincide between maps, so
   * rebinding after a load kept old vehicles - with their routes, claims and
   * kerb stops - on unrelated roads of the new map, and carried issues,
   * volumes and trip counts across. Undo and redo keep rebinding: they edit
   * the same map. Seeds and settings are kept; the clock is not rewound.
   */
  /**
   * Switches the model that moves the people. Everybody walking is dropped:
   * the two engines share no state, only what they publish.
   */
  usePedestrianEngine(engine: PedestrianEngine): void {
    this.peds.clear();
    this.pedOccupancy.clear();
    this.pedWaiting.clear();
    this.crossingStates.clear();
    this.pedViews.length = 0;
    this.pedViewById.clear();
    this.pedEngine = engine;
    engine.rebind(this);
  }

  reset(): void {
    this.vehicles.clear();
    this.peds.clear();
    this.runtime.clear();
    this.claims.clear();
    this.controllers.clear();
    this.pedOccupancy.clear();
    this.pedWaiting.clear();
    this.crossingStates.clear();
    this.pedViews.length = 0;
    this.pedViewById.clear();
    this.lastAdmission.clear();
    this.mergeTurn.clear();
    this.segmentVolume.clear();
    this.entryDemand.clear();
    this.entryDemandLost = 0;
    this.completedTrips = 0;
    this.vehicleSpawnClock = 0;
    this.pedSpawnClock = 0;
    this.issues.length = 0;
    this.topologyRevision = -1;
    this.vehicleTopologyRevision = -1;
    this.buildingAccessRevision = -1;
    this.accessUtilityRevision = -1;
    this.accessSignature = '';
    this.pedEngine.reset(this);
  }

  // ------------------------------------------------------------- accessors

  lanelet(id: LaneletId): Lanelet | undefined {
    return this.graph.lanelets.get(id);
  }

  requireLanelet(id: LaneletId): Lanelet {
    const l = this.graph.lanelets.get(id);
    if (!l) throw new Error(`SimWorld: unknown lanelet ${id}`);
    return l;
  }

  connector(id: string): Connector | undefined {
    return this.graph.connectors.get(id);
  }

  rt(id: LaneletId): LaneletRuntime {
    let r = this.runtime.get(id);
    if (!r) {
      r = { id, order: [], shadows: [], ghost: false, ghostSince: 0 };
      this.runtime.set(id, r);
    }
    return r;
  }

  veh(id: VehicleId): Vehicle | undefined {
    return this.vehicles.get(id);
  }

  controller(node: NodeId): SignalController | undefined {
    return this.controllers.get(node);
  }

  /** Deterministic iteration order for any pass with cross-agent effects. */
  vehiclesInIdOrder(): Vehicle[] {
    return [...this.vehicles.values()].sort((a, b) => a.id - b.id);
  }

  pedsInIdOrder(): Ped[] {
    return [...this.peds.values()].sort((a, b) => a.id - b.id);
  }

  junctionNodesInOrder(): NodeId[] {
    return [...this.graph.junctions.keys()].sort((a, b) => a - b);
  }

  // -------------------------------------------------------------- topology

  /** Rebuilds every derived index from the current network geometry. */
  rebuildTopology(): void {
    this.rebuildVehicleTopology();
    this.rebuildWalkTopology();
  }

  /**
   * The first half of `rebuildTopology`: lanelets, conflict zones, claims and
   * the signal controllers - what the vehicles run on.
   *
   * The two halves can run in consecutive frames while the simulation is held
   * (`main.ts`), so an edit is never one long stall of both: measured on the
   * player map, the conflict zones and the footway graph each cost up to about
   * 110 ms. The world is not stepped until the second half has run.
   */
  rebuildVehicleTopology(): void {
    this.graph.build(this.doc, this.net);
    this.conflicts.build(this.graph);
    this.claims.dropMissing(this.conflicts);
    this.syncControllers();
    for (const segment of [...this.segmentVolume.keys()]) {
      if (!this.doc.segment(segment as SegmentId)) this.segmentVolume.delete(segment);
    }
    this.vehicleTopologyRevision = this.net.trafficRevision;
  }

  /**
   * The second half: the footway graph and its crossings, and the controllers
   * again, which give crossings their pedestrian phases. Completes the
   * topology for `topologyRevision`.
   */
  rebuildWalkTopology(): void {
    if (this.vehicleTopologyRevision !== this.net.trafficRevision) this.rebuildVehicleTopology();
    this.sidewalks.build(this.doc, this.net, this.graph);
    this.crossingSpans.build(this);
    this.syncControllers();
    this.topologyRevision = this.net.trafficRevision;
    this.buildingAccessRevision = this.doc.buildings.revision;
    this.accessUtilityRevision = this.doc.utilityRevision;
    this.accessSignature = buildingAccessSignature(this.doc);
  }

  /** A building edit changes only door links, leaving road corridors and cars intact. */
  refreshBuildingAccess(): boolean {
    const signature = buildingAccessSignature(this.doc);
    if (signature === this.accessSignature) {
      this.buildingAccessRevision = this.doc.buildings.revision;
      this.accessUtilityRevision = this.doc.utilityRevision;
      return false;
    }
    const old = new Map<PedId, { edge: SidewalkEdge; x: number; y: number; tx: number; ty: number }>();
    const frame = { x: 0, y: 0, tx: 0, ty: 0, nx: 0, ny: 0 };
    for (const ped of this.peds.values()) {
      const edge = this.sidewalks.edges.get(ped.edge);
      if (!edge) continue;
      edge.corridor.place(ped.s, ped.lat, ped.entry !== edge.from, frame);
      old.set(ped.id, { edge, x: frame.x, y: frame.y, tx: frame.tx, ty: frame.ty });
    }
    this.sidewalks.refreshBuildingAccess(this.doc);
    const bySegment = new Map<SegmentId, SidewalkEdge[]>();
    for (const edge of this.sidewalks.edges.values()) {
      if (edge.segment === undefined || (edge.kind !== 'walk' && edge.kind !== 'access')) continue;
      const list = bySegment.get(edge.segment) ?? [];
      list.push(edge);
      bySegment.set(edge.segment, list);
    }
    const bounds = { lo: 0, hi: 0 }, place = { s: 0, lat: 0 };
    for (const ped of this.peds.values()) {
      const previous = old.get(ped.id);
      if (!previous || this.sidewalks.edges.get(previous.edge.id) === previous.edge) continue;
      const candidates = previous.edge.segment === undefined ? [] : bySegment.get(previous.edge.segment) ?? [];
      let nearest: SidewalkEdge | null = null;
      let arc = 0, distance = Infinity;
      for (const edge of candidates) {
        const hit = edge.path.closestPoint({ x: previous.x, y: previous.y });
        if (hit.distance < distance) { nearest = edge; arc = hit.s; distance = hit.distance; }
      }
      if (!nearest) continue;
      const tangent = nearest.path.sampleAt(arc).t;
      const reverse = tangent.x * previous.tx + tangent.y * previous.ty < 0;
      const hint = reverse ? nearest.length - arc : arc;
      nearest.corridor.locate(previous.x, previous.y, reverse, hint, place);
      ped.edge = nearest.id;
      ped.entry = reverse ? nearest.to : nearest.from;
      ped.s = Math.max(0, Math.min(nearest.length, place.s));
      nearest.corridor.bounds(ped.s, reverse, bounds);
      ped.lat = Math.max(bounds.lo, Math.min(bounds.hi, place.lat));
      ped.route = [];
      ped.state = 'Walking';
      ped.occupying = null;
      nearest.corridor.place(ped.s, ped.lat, reverse, frame);
      ped.x = frame.x;
      ped.y = frame.y;
    }
    this.buildingAccessRevision = this.doc.buildings.revision;
    this.accessUtilityRevision = this.doc.utilityRevision;
    this.accessSignature = signature;
    // Relocated walkers change who waits where.
    publishCrossingStates(this);
    publishPedViews(this);
    return true;
  }

  /** Crossing ids at a node, one per incident segment. */
  crossingsAt(node: NodeId): CrossingId[] {
    const n = this.doc.node(node);
    if (!n || n.incident.length < 3) return [];
    return n.incident
      .slice()
      .sort((a, b) => a - b)
      .map((seg) => makeCrossingId(node, seg))
      .filter((id) => this.sidewalks.crossings.has(id));
  }

  /**
   * What the signal controllers read about the world, for one pass over them.
   *
   * Made afresh at the top of every step (`pipeline.ts`), before anything else
   * moves, so answers that only read the world can be kept for the rest of the
   * pass. They are: the controllers asked for the same demand, per stage and
   * per group, over and over, and the reservation question scanned the whole
   * fleet on every one of those asks. Nothing here is keyed on the clock,
   * which does not advance when a test drives `step` directly.
   */
  signalDeps(): SignalDeps {
    const demands = new Map<string, { active: number; score: number }>();
    const demandOf = (node: NodeId, groups: readonly number[], movements?: readonly string[]) => {
      const key = `${node}|${groups.join(',')}|${movements?.join(',') ?? '*'}`;
      let value = demands.get(key);
      if (!value) {
        value = this.signalDemand(node, groups, movements);
        demands.set(key, value);
      }
      return value;
    };
    /** Signal groups some vehicle holding an allocation must acquire next, by node. */
    let reserved: Map<NodeId, Set<number>> | null = null;
    const reservedGroups = (): Map<NodeId, Set<number>> => {
      if (reserved) return reserved;
      reserved = new Map();
      for (const vehicle of this.vehicles.values()) {
        const lane = this.lanelet(vehicle.lanelet);
        const ownsAllocation =
          vehicle.admittedConnector !== null ||
          vehicle.clearingConnectors.length > 0 ||
          lane?.kind === 'connector';
        if (!ownsAllocation) continue;
        // A soft Banker's intent does not occupy its future junctions. Only
        // expedite the movement the physical holder must acquire next;
        // advertising the whole chain starves unrelated stages several nodes
        // before the vehicle can reach them.
        const next = vehicle.reservedConnectors[0];
        if (!next) continue;
        const connector = this.connector(next);
        if (!connector) continue;
        let groups = reserved.get(connector.node);
        if (!groups) {
          groups = new Set();
          reserved.set(connector.node, groups);
        }
        groups.add(connector.group);
      }
      return reserved;
    };
    return {
      tick: () => this.clock.tick,
      connectorsOf: (id: string) => this.graph.connectors.get(id),
      // Conflicts between two CARS. A tail swing only a bus or a truck can
      // make is serialised by the claim table as the bus arrives; letting it
      // split two approaches into separate stages would halve their green for
      // a vehicle that is one in forty.
      conflictsOf: (id: string) => this.conflicts.refs(id)
        .filter((ref) => this.conflicts.points[ref.point]?.zone(id, CAR_CLASS, CAR_CLASS))
        .map((ref) => ref.other),
      pedestriansCrossing: (_node, crossings) =>
        crossings.some((x) => (this.crossingStates.get(x)?.occupants.length ?? 0) > 0),
      demandOn: (node, groups, movements) => demandOf(node, groups, movements).score > 0,
      demand: (node, groups, movements) => demandOf(node, groups, movements),
      pedestrianWait: (_node, crossings) => {
        let longest = 0;
        for (const x of crossings) longest = Math.max(longest, this.crossingStates.get(x)?.longestWait ?? 0);
        return longest;
      },
      pedestrianDemandOn: (_node, crossings) => crossings.some((x) => this.crossingStates.get(x)?.demand ?? false),
      reservationDemandOn: (node, groups) => {
        const here = reservedGroups().get(node);
        return !!here && groups.some((group) => here.has(group));
      },
    };
  }

  /**
   * What a green for these groups would actually serve right now.
   *
   * The detector used to be "is any vehicle anywhere on an approach link",
   * which on a 400-unit block is true almost always: no stage ever gapped out,
   * every stage ran to its target, and every cycle was the same length however
   * light the traffic. This reads the queue the way a loop detector and a
   * driver's eye do:
   *
   *   - `active`: the head of some lane is at the line or will reach it within
   *     the passage time, wants a movement this green serves, and has room to
   *     leave on the far side. While this is zero a green is wasted;
   *   - `score`: queue length, time already waited, and arrivals weighted by how
   *     soon they will be there. Used to pick which stage runs next.
   *
   * Vehicles whose exit is full do not count: a green for them discharges
   * nobody (capacity after the junction).
   */
  signalDemand(node: NodeId, groups: readonly number[], movements?: readonly string[]): { active: number; score: number } {
    const junction = this.graph.junctions.get(node);
    let active = 0;
    let score = 0;
    for (const laneId of junction?.inbound ?? []) {
      const lane = this.graph.lanelets.get(laneId);
      const segment = lane?.segment;
      if (!lane || segment === undefined) continue;
      const group = junction?.groups.find((g) => g.segments.includes(segment));
      if (!group || !groups.includes(group.id)) continue;
      const order = this.rt(laneId).order;
      for (let i = order.length - 1; i >= 0; i--) {
        const v = this.vehicles.get(order[i] as number);
        if (!v) continue;
        const d = lane.length - v.s;
        const arrival = d / Math.max(v.v, 0.5);
        if (d > DEMAND_QUEUE_REACH && arrival > DEMAND_HORIZON) break;
        const next = this.graph.connectors.get(v.route[1] ?? '');
        if (!next || next.fromLane !== laneId) continue;
        if (movements && !movements.includes(next.id)) continue;
        if (i === order.length - 1) {
          if (!hasDownstreamStorage(this, v, next)) break;
          if (d <= DEMAND_AT_LINE || arrival <= DEMAND_PASSAGE) active++;
        }
        score += v.v < 0.5 ? 1 + v.waited / DEMAND_WAIT_WEIGHT : Math.max(0, 1 - arrival / DEMAND_HORIZON);
      }
    }
    return { active, score };
  }

  private syncControllers(): void {
    const deps = this.signalDeps();

    for (const [node, junction] of this.graph.junctions) {
      const crossings = this.crossingsAt(node);
      const existing = this.controllers.get(node);
      if (existing) {
        rebuildController(existing, junction, crossings, deps);
      } else {
        // A deterministic per-node offset so neighbouring junctions do not all
        // switch together.
        const offset = (node * 7.317) % 60;
        this.controllers.set(node, createController(junction, crossings, deps, offset));
      }
    }

    for (const node of [...this.controllers.keys()]) {
      if (!this.graph.junctions.has(node)) {
        this.controllers.delete(node);
      }
    }
  }

  // ----------------------------------------------------------- lane order

  /** Inserts a vehicle into a lanelet's occupancy list, keeping it sorted. */
  enterLanelet(v: Vehicle, id: LaneletId, recordVolume = true): void {
    const rt = this.rt(id);
    if (!rt.order.includes(v.id)) rt.order.push(v.id);
    this.sortLane(rt);
    v.lanelet = id;
    const lane = this.lanelet(id);
    if (recordVolume && lane?.kind === 'link' && lane.segment !== undefined) {
      this.segmentVolume.set(lane.segment, (this.segmentVolume.get(lane.segment) ?? 0) + 1);
    }
  }

  exitLanelet(v: Vehicle, id: LaneletId): void {
    const rt = this.runtime.get(id);
    if (!rt) return;
    const i = rt.order.indexOf(v.id);
    if (i >= 0) rt.order.splice(i, 1);
  }

  sortLane(rt: LaneletRuntime): void {
    rt.order.sort((a, b) => {
      const va = this.vehicles.get(a);
      const vb = this.vehicles.get(b);
      return (va?.s ?? 0) - (vb?.s ?? 0) || a - b;
    });
  }

  /** The vehicle nearest the exit of a lanelet, or undefined. */
  laneHead(id: LaneletId): Vehicle | undefined {
    const order = this.rt(id).order;
    const last = order[order.length - 1];
    return last === undefined ? undefined : this.vehicles.get(last);
  }

  /** The vehicle nearest the entry of a lanelet, or undefined. */
  laneTail(id: LaneletId): Vehicle | undefined {
    const first = this.rt(id).order[0];
    return first === undefined ? undefined : this.vehicles.get(first);
  }

  /** Registers a vehicle's body as still occupying the lane it is leaving. */
  addShadow(v: Vehicle, lanelet: LaneletId, offset: number, clearAt: number): void {
    this.clearShadow(v);
    v.shadow = { lanelet, offset, clearAt };
    const rt = this.rt(lanelet);
    if (!rt.shadows.includes(v.id)) rt.shadows.push(v.id);
  }

  clearShadow(v: Vehicle): void {
    if (!v.shadow) return;
    const rt = this.runtime.get(v.shadow.lanelet);
    if (rt) {
      const i = rt.shadows.indexOf(v.id);
      if (i >= 0) rt.shadows.splice(i, 1);
    }
    v.shadow = null;
  }

  /**
   * Every body in a lane with its front arc position there: the occupants, the
   * vehicles still sliding out of it, projected onto its centreline, and the
   * tails of vehicles whose front has already moved on to the next lanelet.
   */
  bodiesIn(id: LaneletId): { vehicle: Vehicle; s: number }[] {
    const rt = this.rt(id);
    const out: { vehicle: Vehicle; s: number }[] = [];
    for (const vid of rt.order) {
      const v = this.vehicles.get(vid);
      if (v) out.push({ vehicle: v, s: v.s });
    }
    for (const vid of rt.shadows) {
      const v = this.vehicles.get(vid);
      if (v?.shadow?.lanelet === id) out.push({ vehicle: v, s: v.s + v.shadow.offset });
    }
    const lane = this.lanelet(id);
    if (lane) {
      for (const next of this.graph.exitsOf(id)) {
        for (const vid of this.rt(next).order) {
          const v = this.vehicles.get(vid);
          if (v && v.rearPath[0] === id && v.s < v.archetype.length) {
            out.push({ vehicle: v, s: lane.length + v.s });
          }
        }
      }
    }
    return out;
  }

  removeVehicle(v: Vehicle): void {
    this.clearShadow(v);
    this.exitLanelet(v, v.lanelet);
    this.claims.releaseAll(v.id);
    this.vehicles.delete(v.id);
  }

  report(issue: AuditIssue): void {
    this.issues.push(issue);
    if (this.issues.length > 512) this.issues.shift();
  }
}

/** Only ground footprints, doors and poles can change a building's walking links. */
function buildingAccessSignature(doc: RoadDoc): string {
  if (doc.buildings.size === 0) return '';
  const parts = [String(doc.utilityRevision)];
  for (const building of doc.buildings.all()) {
    parts.push(`${building.id}:${building.x}:${building.y}:${building.rotation}`);
    for (const volume of building.volumes) if (volume.base === 0)
      parts.push(`${volume.id}:${volume.x}:${volume.y}:${volume.w}:${volume.d}:${JSON.stringify(volume.outline ?? null)}`);
    for (const bay of facadeBays(building)) {
      if (bay.level !== 0 || !ACCESS_COMPONENTS.has(bay.component)) continue;
      parts.push(`D:${bay.volume}:${bay.side}:${bay.index}:${bay.component}:${bay.x}:${bay.y}:${bay.nx}:${bay.ny}`);
    }
  }
  return parts.join('|');
}
