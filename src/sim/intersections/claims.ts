import type { ConnectorId } from '@world/lanelets';
import { BODY_CLASSES, HEAVY, type BodyClass, type ConflictIndex, type ConflictPoint } from '@world/conflictPoints';
import type { VehicleId } from '../vehicles/state';

export interface Claim {
  readonly vehicle: VehicleId;
  readonly connector: ConnectorId;
  readonly grantedTick: number;
}

/** Where a claim holder's body is, along the movement it holds. */
export interface HolderState {
  readonly cls: BodyClass;
  /** Body-centre arc position along the claimed connector, from its stop line. */
  readonly centre: number;
}

/** Resolves a claim to its holder's live position; null when it cannot be placed. */
export type LocateHolder = (claim: Claim) => HolderState | null;

/**
 * Whether two movements may hold one conflict zone together right now.
 *
 * True when their body sizes never touch in that zone, or when either body has
 * already driven past its end of the zone. Nothing else about the pair
 * matters: a body that has not reached the zone yet still has all of it ahead.
 */
export function zoneShareable(
  point: ConflictPoint,
  a: { readonly connector: ConnectorId; readonly state: HolderState },
  b: { readonly connector: ConnectorId; readonly state: HolderState },
): boolean {
  if (a.connector === b.connector) return true;
  const onA = point.zone(a.connector, a.state.cls, b.state.cls);
  const onB = point.zone(b.connector, b.state.cls, a.state.cls);
  if (!onA || !onB) return true;
  return a.state.centre > onA.exit || b.state.centre > onB.exit;
}

/**
 * Occupancy of the swept conflict zones inside junctions.
 *
 * There is no `expiresAt` anywhere in this class, and that is deliberate. A
 * claim is released when the vehicle's BODY has left the zone, or when the
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
   * True when every listed zone is free, already held by this vehicle, held by
   * a vehicle on this exact connector, or held by a body that cannot touch
   * this one there any more.
   *
   * A convoy on one connector follows one centreline and is kept apart by car
   * following. A holder on ANOTHER connector blocks only while its body is
   * still inside the part of the zone a body of the applicant's size could
   * reach — a car in the second of two turn lanes does not wait for the car in
   * the first, a bus does.
   */
  available(
    points: readonly number[],
    vehicle: VehicleId,
    connector: ConnectorId,
    cls: BodyClass,
    conflicts: ConflictIndex,
    locate: LocateHolder,
    share?: (point: ConflictPoint, claim: Claim) => boolean,
  ): boolean {
    for (const p of points) {
      const point = conflicts.points[p];
      for (const claim of this.byPoint.get(p) ?? []) {
        if (claim.vehicle === vehicle || claim.connector === connector) continue;
        // A follower the caller has placed behind this holder (a merge).
        if (point && share?.(point, claim)) continue;
        const state = locate(claim);
        if (!point || !state) return false;
        // The applicant has not entered yet, so its whole zone is ahead of it.
        const applicant = { cls, centre: -Infinity };
        if (!zoneShareable(point, { connector: claim.connector, state }, { connector, state: applicant })) {
          return false;
        }
      }
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

  /**
   * Releases zones the vehicle's body has already driven out of.
   *
   * `centre` is the body-centre arc position along `connector`, which keeps
   * growing past the connector's end while the rear is still clearing it. A
   * zone is released once the centre is past the zone exit for this body size
   * against ANY size on the other movement.
   */
  releasePassed(
    vehicle: VehicleId,
    connector: ConnectorId,
    centre: number,
    cls: BodyClass,
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
      if (centre > clearedAt(point, connector, cls)) {
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
    this.releasePassed(vehicle, connector, Infinity, HEAVY, conflicts);
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

/** Body-centre position past which `cls` on `connector` is clear of the zone. */
export function clearedAt(point: ConflictPoint, connector: ConnectorId, cls: BodyClass): number {
  if (point.a !== connector && point.b !== connector) return Infinity;
  let exit = -Infinity;
  for (const theirs of BODY_CLASSES) {
    const zone = point.zone(connector, cls, theirs);
    if (zone) exit = Math.max(exit, zone.exit);
  }
  return exit;
}
