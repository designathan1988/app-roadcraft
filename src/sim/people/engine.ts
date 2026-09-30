import type { LaneletId } from '@world/lanelets';
import type { AuditIssue } from '../audit';
import type { SimWorld } from '../world';
import type { PersonAgeClass, PersonGender } from './view';

/**
 * What the simulation asks of whichever model moves its people.
 *
 * The pipeline, the vehicles and the audit talk to pedestrians only through
 * this, `SimWorld.crossingStates` and `SimWorld.pedViews`; the model's own
 * state (edges, crossing state machine, navmesh, minds) stays behind it. The
 * legacy model (`peds/engine.ts`) and the People engine that replaces it
 * (`docs/design/agency-architecture.md` §3) both implement it, chosen by the
 * `?peds=` flag.
 */
export interface PedestrianEngine {
  readonly kind: 'legacy' | 'people';
  /** Start of a tick: remember where everybody is, for the renderer's interpolation. */
  beginTick(w: SimWorld): void;
  /** Stage 2: people arrive (or, `enabled` false, do not). */
  dispatch(w: SimWorld, enabled: boolean): void;
  /** Stage 3: everybody decides and moves; crossing states are published at the end. */
  step(w: SimWorld): void;
  /** After the walkable topology was rebuilt: re-seat everybody on what is left. */
  rebind(w: SimWorld): void;
  /** End of a tick: publish `SimWorld.pedViews`. */
  publish(w: SimWorld): void;
  /** The model's own invariants, for `runAudit`. */
  audit(w: SimWorld, out: AuditIssue[]): void;
  /** Everybody leaves (a new map, an opened file); the engine starts over on the map as it is. */
  reset(w: SimWorld): void;
  readonly bridge: PeopleBridge;
}

/**
 * Somebody passing between a vehicle seat and the footway. They keep their
 * id both ways: the person who gets out is the person who got in.
 */
export interface Boarder {
  readonly seed: number;
  readonly gender: PersonGender;
  readonly ageClass: PersonAgeClass;
  /** Where they stand on the footway (getting out) or come from (getting in), world units. */
  readonly footX: number;
  readonly footY: number;
  /** Heading they face while standing on the footway. */
  readonly footHeading: number;
}

/**
 * What vehicles ask of people at the kerb (§5).
 *
 * For now every call is answered at once, in the same stage, exactly as the
 * kerb-stop code did when it reached into the pedestrian model itself: a
 * person hailed is taken out of the crowd there and then, and one getting out
 * appears on the footway. When people walk to doors themselves (People P5)
 * this becomes a two-way mailbox (offer, arrive at door, boarded, aborted).
 */
export interface PeopleBridge {
  /**
   * The nearest person along the lane, between `s0` and `s1`, who could be
   * picked up there: walking alone on that side's footway, not a child, not
   * busy, not in `exclude`. `s` is where they are along the lane.
   */
  hailable(w: SimWorld, lanelet: LaneletId, s0: number, s1: number,
    exclude?: ReadonlySet<number>): { readonly id: number; readonly s: number } | null;
  /**
   * Takes `id` out of the crowd to walk to a door at `door`, if they are
   * still free and within `reach` of it; null otherwise.
   */
  board(w: SimWorld, id: number, door: { readonly x: number; readonly y: number }, reach: number): Boarder | null;
  /** Somebody getting out, standing where they got out, if there is footway there. */
  alight(w: SimWorld, person: Boarder): void;
  /** Whether anybody other than `except` stands within `radius` of the point. */
  anyoneWithin(w: SimWorld, x: number, y: number, radius: number, except: number | null): boolean;
}
