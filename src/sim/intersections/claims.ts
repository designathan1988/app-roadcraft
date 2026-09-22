import type { ConnectorId } from '@world/lanelets';
import type { ConflictIndex } from '@world/conflictPoints';
import type { VehicleId } from '../vehicles/state';

export interface Claim {
  readonly vehicle: VehicleId;
  readonly connector: ConnectorId;
  readonly grantedTick: number;
}

/**
 * Exclusive occupancy of conflict points inside junctions.
 *
 * There is no `expiresAt` anywhere in this class, and that is deliberate. A
 * claim is released when the vehicle's REAR passes the point, or when the
 * vehicle is removed — both driven by the same integrator that moves it. A
 * claim therefore cannot outlive its holder or its holder's motion.
 *
 * The V6 monolith kept timed reservations and, when traffic was paused,
 * actively RENEWED expired ones (`expiresAt = now + 3`), which could block a
 * junction indefinitely (defect 2.7). Here the tick does not advance while
 * paused, so nothing decays and nothing is renewed; there is no timer to renew.
 *
 * Compact links require several future movement needs to be declared at once.
 * Admission checks that maximum-claim chain with the Banker, but this table
 * grants only conflict points for the connector physically being entered.
 * Earlier connectors can remain here while the rear clears them; soft future
 * intentions never appear in this table and therefore cannot block traffic.
 */
export class ClaimTable {
  /** Several vehicles may convoy through the same connector, never a conflict. */
  private readonly byPoint = new Map<number, Claim[]>();
  private readonly byVehicle = new Map<VehicleId, number[]>();

  /** Holder of a conflict point, if any. */
  holder(point: number): Claim | undefined {
    return this.byPoint.get(point)?.[0];
  }

  /** Every current holder, used where a single connector may carry a convoy. */
  holdersAt(point: number): readonly Claim[] {
    return this.byPoint.get(point) ?? [];
  }

  holds(vehicle: VehicleId, point: number): boolean {
    return this.holdersAt(point).some((claim) => claim.vehicle === vehicle);
  }

  points(vehicle: VehicleId): readonly number[] {
    return this.byVehicle.get(vehicle) ?? [];
  }

  /**
   * True when every listed point is free, already held by this vehicle, or is
   * occupied by a vehicle on this exact connector. The last case is a safe
   * convoy: both vehicles follow the same lane centreline and cannot conflict
   * with a movement on another connector while either rear is in the box.
   */
  available(points: readonly number[], vehicle: VehicleId, connector: ConnectorId): boolean {
    for (const p of points) {
      const held = this.byPoint.get(p) ?? [];
      if (held.some((claim) => claim.vehicle !== vehicle && claim.connector !== connector)) return false;
    }
    return true;
  }

  /** Grants the whole set atomically. Callers must check `available` first. */
  grantAll(
    vehicle: VehicleId,
    connector: ConnectorId,
    points: readonly number[],
    tick: number,
  ): void {
    const held = this.byVehicle.get(vehicle) ?? [];
    for (const p of points) {
      const claims = this.byPoint.get(p) ?? [];
      if (!claims.some((claim) => claim.vehicle === vehicle && claim.connector === connector)) {
        claims.push({ vehicle, connector, grantedTick: tick });
        this.byPoint.set(p, claims);
      }
      if (!held.includes(p)) held.push(p);
    }
    this.byVehicle.set(vehicle, held);
  }

  /** Releases points the vehicle's rear has already cleared. */
  releasePassed(
    vehicle: VehicleId,
    connector: ConnectorId,
    rearS: number,
    conflicts: ConflictIndex,
  ): void {
    const held = this.byVehicle.get(vehicle);
    if (!held || !held.length) return;

    const keep: number[] = [];
    for (const p of held) {
      const owners = this.byPoint.get(p) ?? [];
      const owner = owners.find((claim) => claim.vehicle === vehicle && claim.connector === connector);
      // One vehicle may own movements at several junctions. A conflict point
      // can also mention `connector` merely as the *other* movement, so pair
      // membership alone is not proof that this connector acquired it.
      if (owner?.vehicle !== vehicle || owner.connector !== connector) {
        keep.push(p);
        continue;
      }
      const point = conflicts.points[p];
      if (!point) {
        this.dropVehicleAtPoint(vehicle, p);
        continue;
      }
      const s = point.a === connector ? point.sA : point.b === connector ? point.sB : Infinity;
      if (rearS > s) {
        this.dropVehicleAtPoint(vehicle, p);
      } else {
        keep.push(p);
      }
    }
    if (keep.length) this.byVehicle.set(vehicle, keep);
    else this.byVehicle.delete(vehicle);
  }

  /** Releases every point held for one connector, preserving other movements. */
  releaseConnector(
    vehicle: VehicleId,
    connector: ConnectorId,
    conflicts: ConflictIndex,
  ): void {
    this.releasePassed(vehicle, connector, Infinity, conflicts);
  }

  releaseAll(vehicle: VehicleId): void {
    const held = this.byVehicle.get(vehicle);
    if (!held) return;
    for (const p of held) {
      this.dropVehicleAtPoint(vehicle, p);
    }
    this.byVehicle.delete(vehicle);
  }

  /** Drops claims whose conflict point no longer exists after an edit. */
  dropMissing(conflicts: ConflictIndex): void {
    for (const [p, claims] of [...this.byPoint]) {
      const point = conflicts.points[p];
      // Besides existence, verify that the stable resource still belongs to
      // the movement which acquired it.  This makes a stale claim harmless
      // even if a future id allocator regression were to reuse an id.
      for (const claim of claims) {
        if (!point || (point.a !== claim.connector && point.b !== claim.connector)) {
          this.dropVehicleAtPoint(claim.vehicle, p);
        }
      }
    }
  }

  clear(): void {
    this.byPoint.clear();
    this.byVehicle.clear();
  }

  get size(): number {
    return this.byPoint.size;
  }

  get holders(): number {
    return this.byVehicle.size;
  }

  private dropVehicleAtPoint(vehicle: VehicleId, point: number): void {
    const claims = this.byPoint.get(point);
    if (!claims) return;
    const rest = claims.filter((claim) => claim.vehicle !== vehicle);
    if (rest.length) this.byPoint.set(point, rest);
    else this.byPoint.delete(point);
    const held = this.byVehicle.get(vehicle);
    if (held) {
      const remaining = held.filter((id) => id !== point);
      if (remaining.length) this.byVehicle.set(vehicle, remaining);
      else this.byVehicle.delete(vehicle);
    }
  }
}
