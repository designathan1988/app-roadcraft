import { clamp } from '@core/scalar';
import type { NodeId } from '@world/ids';
import type { Connector, JunctionTopology } from '@world/lanelets';
import { PED, SIGNAL } from '../params';

export type GroupId = number;
export type CrossingId = string;

export interface Stage {
  readonly greenGroups: readonly GroupId[];
  /** Crossings showing WALK during this stage. */
  readonly pedWalk: readonly CrossingId[];
  readonly minGreen: number;
  readonly maxGreen: number;
  readonly targetGreen: number;
  readonly amber: number;
  readonly allRed: number;
  readonly exclusivePed: boolean;
  /**
   * Movements green in this stage that no conflicting movement from another
   * approach can meet: they proceed without yielding. Everything else green
   * here is permissive and must find a gap.
   */
  readonly protectedMovements: readonly string[];
  /**
   * When set, this stage exists only to serve these movements — an exclusive
   * stage for turns that are permissive everywhere else — and its demand is
   * counted from them alone.
   */
  readonly demandMovements?: readonly string[];
}

export interface SignalPlan {
  readonly stages: readonly Stage[];
  readonly cycle: number;
  readonly groups: readonly GroupId[];
  readonly crossings: readonly CrossingId[];
}

export class PlanValidationError extends Error {}

/**
 * Builds a fixed-time plan for one junction and validates it before returning.
 *
 * The validation is the antidote to the V6 monolith's worst signal defect. It
 * rebuilt the phase list only when `!ctl.phases || !ctl.cycle`, so when a new
 * road raised the axis count from two to three, the phases still enumerated
 * axes 0 and 1 and every approach on axis 2 was PERMANENTLY RED (defect 3.4).
 * Here total coverage is asserted at every construction, so that state cannot
 * be built at all.
 */
export function buildSignalPlan(
  junction: JunctionTopology,
  crossings: readonly CrossingId[],
  connectorsOf: (id: string) => Connector | undefined,
  conflictsOf?: (id: string) => readonly string[],
): SignalPlan {
  const raw = buildStages(junction, crossings, connectorsOf);
  return validate(annotate(raw, junction, connectorsOf, conflictsOf));
}

/**
 * Marks every stage's protected movements from the real conflict matrix and
 * adds an exclusive stage for any approach whose turns are never protected.
 *
 * "A through movement on green is protected" used to be the whole rule. It is
 * wrong twice over: on a skewed or five-leg junction two green throughs can
 * cross, and a left turn opposite a through is permissive in EVERY stage, so on
 * a busy corridor it only ever moved when the opposing queue happened to be
 * empty — measured, the commonest reason a queue head stood still at green was
 * a permissive left and a protected through blocking each other. Protection is
 * now a property of the stage.
 *
 * It is not symmetric. Taking protection away from a movement merely because
 * SOMETHING conflicting was green made both sides of every opposing pair
 * permissive: on a four-way of avenues the through yielded to the opposing
 * left exactly as the left yielded to it, and 45 % of queue-head time at green
 * was spent standing, most of it a through waiting on a "conflict" it had
 * right of way over. The rule of the road is a hierarchy — a left turn gives
 * way to the opposing through and the opposing right turn, a U-turn to
 * everybody — so a movement is protected unless a conflicting movement from
 * another approach, green alongside it, ranks at least as high. Two equal
 * ranks that cross (two throughs on a skewed junction) both remain permissive.
 */
function annotate(
  plan: SignalPlan,
  junction: JunctionTopology,
  connectorsOf: (id: string) => Connector | undefined,
  conflictsOf?: (id: string) => readonly string[],
): SignalPlan {
  const connectors = junction.connectors
    .map(connectorsOf)
    .filter((c): c is Connector => !!c);
  const protectedIn = (green: readonly GroupId[]): string[] => connectors
    .filter((c) => green.includes(c.group))
    .filter((c) => {
      if (!conflictsOf) return c.turn === 'through';
      return conflictsOf(c.id).every((otherId) => {
        const other = connectorsOf(otherId);
        return !other || other.inSegment === c.inSegment || !green.includes(other.group) ||
          TURN_RANK[other.turn] < TURN_RANK[c.turn];
      });
    })
    .map((c) => c.id);

  const stages: Stage[] = plan.stages.map((s) => ({ ...s, protectedMovements: protectedIn(s.greenGroups) }));

  if (conflictsOf && junction.signalised && junction.groups.length > 1) {
    for (const group of junction.groups) {
      const mine = connectors.filter((c) => c.group === group.id);
      const serving = stages.filter((s) => s.greenGroups.includes(group.id));
      const neverProtected = mine.filter((c) =>
        c.turn !== 'through' && serving.every((s) => !s.protectedMovements.includes(c.id)));
      if (!neverProtected.length) continue;
      const green = [group.id];
      stages.push({
        ...stage({
          green,
          // No WALK: a turn stage is too short for anybody to finish crossing,
          // so its lamp would only ever flash, and listing it here made the
          // signal's pedestrian-priority logic serve walkers with a stage that
          // could never actually release them.
          pedWalk: [],
          target: SIGNAL.exclusiveGreen,
        }),
        // Short: it only serves the turns that could not find a gap, and a
        // long exclusive stage was what stretched cycles past two minutes.
        maxGreen: SIGNAL.exclusiveGreen * EXCLUSIVE_MAX_FACTOR,
        protectedMovements: protectedIn(green),
        demandMovements: neverProtected.map((c) => c.id),
      });
    }
  }

  const cycle = stages.reduce((sum, s) => sum + s.targetGreen + s.amber + s.allRed, 0);
  return { ...plan, stages, cycle };
}

const EXCLUSIVE_MAX_FACTOR = 1.6;

/** Who gives way to whom between two green movements that cross. */
const TURN_RANK: Record<Connector['turn'], number> = { through: 3, right: 2, left: 1, uturn: 0 };

function buildStages(
  junction: JunctionTopology,
  crossings: readonly CrossingId[],
  connectorsOf: (id: string) => Connector | undefined,
): SignalPlan {
  const groups = junction.groups.map((g) => g.id);

  if (!junction.signalised) {
    // Unsignalised junctions hold a permanent green; right of way is resolved
    // by gap acceptance instead.
    return validate({
      stages: [
        stage({
          green: groups,
          pedWalk: crossings,
          target: SIGNAL.uncontrolledGreen,
        }),
      ],
      cycle: SIGNAL.uncontrolledGreen,
      groups,
      crossings,
    });
  }

  if (groups.length <= 1) {
    // A signalised junction still needs a real cycle when all its approaches
    // collapse into one geometry group. Treating it as uncontrolled used to
    // expose every crossing to WALK beside a permanent vehicle green.
    const compatible = crossingsCompatibleWith(
      junction,
      groups,
      crossings,
      connectorsOf,
    );
    const compatibleSet = new Set(compatible);
    const uncovered = crossings.filter((crossing) => !compatibleSet.has(crossing));
    const exclusiveCrossings = groups.length === 0 ? crossings : uncovered;
    const stages: Stage[] = [];

    if (groups.length) {
      stages.push(
        stage({
          green: groups,
          pedWalk: compatible,
          target: SIGNAL.baseGreen,
        }),
      );
    }
    if (exclusiveCrossings.length || groups.length === 0) {
      stages.push(
        stage({
          green: [],
          pedWalk: exclusiveCrossings,
          target: SIGNAL.baseGreen,
          exclusivePed: true,
        }),
      );
    }

    const cycle = stages.reduce((sum, current) =>
      sum + current.targetGreen + current.amber + current.allRed, 0);
    return validate({ stages, cycle, groups, crossings });
  }

  const stages: Stage[] = [];
  const covered = new Set<CrossingId>();
  for (const together of pairOpposingGroups(junction)) {
    const green = clamp(SIGNAL.baseGreen, SIGNAL.minGreen, SIGNAL.maxGreen);
    const walk = crossingsCompatibleWith(junction, together, crossings, connectorsOf);
    for (const crossing of walk) covered.add(crossing);
    stages.push(stage({ green: together, pedWalk: walk, target: green }));
  }

  // A crossing that no vehicle stage can safely share still has to be served,
  // or `validate` rejects the whole plan and the junction runs degraded. It
  // gets a stage of its own with no vehicle green at all.
  //
  // This became reachable when the walk rule started excluding the exit leg of
  // a protected through movement: on a junction where every group has a through
  // movement leaving some leg, that leg is incompatible with every group at
  // once. The single-group path above already did this; the multi-group path
  // silently assumed at least one group would always be compatible.
  const uncovered = crossings.filter((crossing) => !covered.has(crossing));
  if (uncovered.length) {
    stages.push(
      stage({
        green: [],
        pedWalk: uncovered,
        target: SIGNAL.baseGreen,
        exclusivePed: true,
      }),
    );
  }

  const cycle = stages.reduce((s, st) => s + st.targetGreen + st.amber + st.allRed, 0);
  return validate({ stages, cycle, groups, crossings });
}

/**
 * Groups that may take green together, as one entry per stage.
 *
 * Every group used to get a stage of its own. That is safe, and on a four-leg
 * crossroads it is also close to unusable: four stages of 20 s plus 4.4 s of
 * clearance is a 97.6 s cycle, so each approach is green for a fifth of the
 * time and waits out three other stages to get there. A queue that discharges
 * for twenty seconds in every ninety-eight does not look like a working
 * junction to the person watching it.
 *
 * Opposing approaches are paired instead, which is how a real crossroads runs:
 * north and south together, then east and west. Nothing about the safety
 * argument changes, because the protection was never coming from the stage
 * list:
 *
 *   - a THROUGH movement on green is protected, and two opposing through
 *     movements do not cross each other;
 *   - every TURN is `'yield'` in `rightOfWay` even on a full green, so a left
 *     turn across the opposing through still has to find a gap;
 *   - the conflict-point claims table serialises whatever is left.
 *
 * That is the definition of a permissive-left stage, and the pairing simply
 * stops paying for a separate stage to express it.
 *
 * Groups are paired only when their mean approach directions are genuinely
 * opposed, within `OPPOSED_TOLERANCE`. A skewed or five-leg junction keeps
 * whatever groups have no partner in a stage of their own, so the degenerate
 * cases behave exactly as before.
 */
const OPPOSED_TOLERANCE = (35 * Math.PI) / 180;

function pairOpposingGroups(junction: JunctionTopology): GroupId[][] {
  const pending = junction.groups.slice();
  const stages: GroupId[][] = [];

  while (pending.length) {
    const head = pending.shift();
    if (!head) break;

    let bestIndex = -1;
    let bestError = OPPOSED_TOLERANCE;
    for (let i = 0; i < pending.length; i++) {
      const candidate = pending[i];
      if (!candidate) continue;
      // How far from anti-parallel the two mean directions are.
      const delta = Math.abs(
        Math.abs(normaliseAngle(candidate.meanAngle - head.meanAngle)) - Math.PI,
      );
      if (delta < bestError) {
        bestError = delta;
        bestIndex = i;
      }
    }

    if (bestIndex < 0) {
      stages.push([head.id]);
      continue;
    }
    const partner = pending.splice(bestIndex, 1)[0];
    stages.push(partner ? [head.id, partner.id] : [head.id]);
  }

  return stages;
}

/** Wraps an angle into (-PI, PI]. */
const normaliseAngle = (a: number): number => {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x <= -Math.PI) x += 2 * Math.PI;
  return x;
};

interface StageInput {
  readonly green: readonly GroupId[];
  readonly pedWalk: readonly CrossingId[];
  readonly target: number;
  readonly exclusivePed?: boolean;
}

function stage(input: StageInput): Stage {
  return {
    greenGroups: input.green,
    pedWalk: input.pedWalk,
    minGreen: SIGNAL.minGreen,
    maxGreen: SIGNAL.maxGreen,
    targetGreen: input.target,
    amber: SIGNAL.amber,
    allRed: SIGNAL.minAllRed,
    exclusivePed: input.exclusivePed ?? false,
    protectedMovements: [],
  };
}

/**
 * A crossing over leg L may show WALK during a stage if and only if no
 * connector green in that stage DEPARTS from L.
 *
 * The polarity, stated once and unambiguously: the crosswalk over leg L sits on
 * L, in front of L's stop line. Vehicles leaving L drive straight over it, so
 * any green connector with `inSegment === L` forbids WALK. Vehicles turning
 * ONTO L also cross it, but those are turning movements running concurrently
 * with a parallel pedestrian phase — standard practice — and they yield, which
 * the admission pass enforces through crossing occupancy.
 *
 * Deriving this from the green CONNECTOR set rather than from an "axis" is what
 * makes it correct. The V6 monolith's axis formulation could not see turning
 * movements at all, and released pedestrians exactly when the road they were
 * about to cross had a green (defect 4.4) — the inverse of the indicator it
 * drew from a second, contradictory function.
 *
 * This is the single definition in the codebase; the renderer imports the same
 * query, so indicator and permission cannot disagree.
 */
export function crossingsCompatibleWith(
  junction: JunctionTopology,
  greenGroups: readonly GroupId[],
  crossings: readonly CrossingId[],
  connectorsOf: (id: string) => Connector | undefined,
): CrossingId[] {
  const green = junction.connectors
    .map(connectorsOf)
    .filter((c): c is Connector => !!c && greenGroups.includes(c.group));

  return crossings.filter((x) => {
    const segment = crossingSegment(x);
    // The leg being ENTERED is driven over by every green movement using it,
    // turning or not, so it can never carry a walk indicator.
    if (green.some((c) => c.inSegment === segment)) return false;
    // The leg being LEFT is driven over on the way out. A turning movement
    // yields there and may share it — that is what a permissive turn IS. A
    // through movement does not yield, so putting a pedestrian in front of one
    // is a plan that contradicts itself: the lamp says walk, the vehicle has a
    // protected green, and admission then holds the vehicle at its own green
    // until the crossing empties.
    //
    // Measured before this: 693 of 7103 pedestrian blocks on a 4x4 grid stopped
    // a THROUGH movement, and they only exist in stages that serve one approach
    // at a time, where the exit leg has no green movement entering it to
    // suppress the walk.
    return !green.some((c) => c.outSegment === segment && !mustYieldToPeds(c));
  });
}

/**
 * True when this connector must yield to pedestrians already in the crossing
 * over its destination leg. Every turning movement does.
 */
export const mustYieldToPeds = (c: Connector): boolean => c.turn !== 'through';

/** Crossing ids are `${nodeId}:${segmentId}`. */
export const makeCrossingId = (node: NodeId, segment: number): CrossingId =>
  `${node}:${segment}`;

export const crossingSegment = (id: CrossingId): number =>
  Number(id.slice(id.indexOf(':') + 1));

export const crossingNode = (id: CrossingId): number => Number(id.slice(0, id.indexOf(':')));

function validate(plan: SignalPlan): SignalPlan {
  const covered = new Set<GroupId>();
  for (const s of plan.stages) for (const g of s.greenGroups) covered.add(g);

  // I0 - coverage: no group may be left permanently red.
  const missing = plan.groups.filter((g) => !covered.has(g));
  if (missing.length) {
    throw new PlanValidationError(
      `signal plan leaves group(s) permanently red: ${missing.join(', ')}`,
    );
  }

  // I1 - liveness: when vehicle groups exist, at least one stage serves them.
  if (
    plan.groups.length > 0 &&
    !plan.stages.some((s) => !s.exclusivePed && s.greenGroups.length > 0)
  ) {
    throw new PlanValidationError('signal plan has no vehicle stage');
  }

  // I3 - every crossing gets WALK somewhere.
  const walkable = new Set<CrossingId>();
  for (const s of plan.stages) for (const x of s.pedWalk) walkable.add(x);
  const stranded = plan.crossings.filter((x) => !walkable.has(x));
  if (stranded.length) {
    throw new PlanValidationError(`crossing(s) never get WALK: ${stranded.join(', ')}`);
  }

  // I4 - each stage is long enough for the pedestrians it releases.
  for (const s of plan.stages) {
    const available = s.targetGreen + s.amber + s.allRed;
    if (s.pedWalk.length && available < PED.startLag) {
      throw new PlanValidationError('stage too short for pedestrian clearance');
    }
  }

  return Object.freeze({ ...plan, stages: Object.freeze(plan.stages) });
}

/** Fallback plan used when validation fails in a production build. */
export function roundRobinPlan(groups: readonly GroupId[], crossings: readonly CrossingId[]): SignalPlan {
  const stages = groups.map((g) =>
    // The fallback has no connector topology with which to prove that a
    // crossing is compatible. Keep vehicle stages protected and serve all
    // crossings together in a conservative exclusive pedestrian stage.
    stage({ green: [g], pedWalk: [], target: SIGNAL.baseGreen }),
  );
  if (crossings.length || groups.length === 0) {
    stages.push(
      stage({
        green: [],
        pedWalk: crossings,
        target: SIGNAL.baseGreen,
        exclusivePed: true,
      }),
    );
  }
  const cycle = stages.reduce((s, st) => s + st.targetGreen + st.amber + st.allRed, 0);
  return Object.freeze({ stages: Object.freeze(stages), cycle, groups, crossings });
}
