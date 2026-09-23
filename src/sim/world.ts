import { Rng } from '@core/rng';
import type { NodeId, SegmentId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { type Connector, type Lanelet, type LaneletId, LaneletGraph } from '@world/lanelets';
import { ConflictIndex } from '@world/conflictPoints';
import { SimClock } from './clock';
import { ClaimTable } from './intersections/claims';
import type { Vehicle, VehicleId } from './vehicles/state';
import type { Ped, PedId } from './peds/state';
import { type SignalController, type SignalDeps, createController, rebuildController } from './signals/fsm';
import { type CrossingId, makeCrossingId } from './signals/plan';
import type { AuditIssue } from './audit';
import { SidewalkGraph } from './peds/sidewalk';

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
  readonly runtime = new Map<LaneletId, LaneletRuntime>();
  readonly controllers = new Map<NodeId, SignalController>();

  /** Pedestrians currently inside each crossing. */
  readonly pedOccupancy = new Map<CrossingId, PedId[]>();
  /** Pedestrians waiting at a kerb for each crossing, rebuilt every tick. */
  readonly pedWaiting = new Map<CrossingId, number>();

  /**
   * Tick at which each junction last admitted a vehicle.
   *
   * This is what separates congestion from a wedge. A vehicle waiting its turn
   * at a junction that keeps admitting others is queued, and FIFO priority
   * guarantees its turn arrives. A junction that has admitted nobody for cycles
   * is genuinely stuck.
   */
  readonly lastAdmission = new Map<NodeId, number>();
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
  };

  nextVehicleId = 1;
  nextPedId = 1;
  /** Per-world population timers; simulations must never influence each other. */
  vehicleSpawnClock = 0;
  pedSpawnClock = 0;
  /** User-facing density multipliers; topology and physics remain unchanged. */
  trafficIntensity = 1;
  pedestrianIntensity = 1;
  /** Shared demand multiplier for the current simulation period. */
  demandMultiplier = 1;

  auditEnabled = false;
  auditLevel: 'cheap' | 'full' = 'cheap';
  readonly issues: AuditIssue[] = [];

  /** Topology revision the indices were last built from. */
  topologyRevision = -1;

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
    };
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
    this.graph.build(this.doc, this.net);
    this.conflicts.build(this.graph);
    this.sidewalks.build(this.doc, this.net, this.graph);
    this.claims.dropMissing(this.conflicts);
    this.syncControllers();
    for (const segment of [...this.segmentVolume.keys()]) {
      if (!this.doc.segment(segment as SegmentId)) this.segmentVolume.delete(segment);
    }
    this.topologyRevision = this.net.revision;
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

  signalDeps(): SignalDeps {
    return {
      tick: () => this.clock.tick,
      connectorsOf: (id: string) => this.graph.connectors.get(id),
      pedestriansCrossing: (_node, crossings) =>
        crossings.some((x) => (this.pedOccupancy.get(x)?.length ?? 0) > 0),
      demandOn: (node, groups) => {
        const junction = this.graph.junctions.get(node);
        for (const laneId of junction?.inbound ?? []) {
          const lane = this.graph.lanelets.get(laneId);
          const segment = lane?.segment;
          if (segment === undefined) continue;
          const group = junction?.groups.find((g) => g.segments.includes(segment));
          if (!group || !groups.includes(group.id)) continue;
          if (this.rt(laneId).order.length > 0) return true;
        }
        return false;
      },
      pedestrianDemandOn: (node, crossings) => {
        if (!crossings.length) return false;
        for (const ped of this.peds.values()) {
          if (ped.state !== 'ApproachKerb' && ped.state !== 'WaitAtKerb') continue;
          const next = ped.route[0];
          const edge = next ? this.sidewalks.edges.get(next) : undefined;
          if (edge?.kind === 'crossing' && edge.node === node && edge.crossing && crossings.includes(edge.crossing)) {
            return true;
          }
        }
        return false;
      },
      reservationDemandOn: (node, groups) => {
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
          if (connector?.node === node && groups.includes(connector.group)) return true;
        }
        return false;
      },
    };
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
