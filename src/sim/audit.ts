/**
 * Invariant checker.
 *
 * The V6 monolith already detected `greenBlocked`, `pedestrianFrozen`,
 * `pedestrianWaitingInRoad` and `staleReservation` — and the symptoms persisted
 * anyway, because the architecture produced those states faster than the
 * band-aids removed them. The difference here is not the detectors; it is that
 * most of these conditions are now unrepresentable, and that this runs in CI.
 */
export type AuditCode =
  // vehicles
  | 'greenBlocked'
  /**
   * Held at a green past what any single interaction explains.
   *
   * Deliberately distinct from `greenBlocked`, which means "green, nothing in
   * the way, still not moving" — a wedge. This one means "green, something IS
   * in the way, and it has not lifted for a long time", which is what a player
   * actually sees and reports. A saturated short-block grid legitimately
   * produces it; a wedge is a different claim and keeps its own code.
   */
  | 'greenHeld'
  | 'redEntry'
  | 'overlap'
  | 'nonMonotoneS'
  | 'routeless'
  | 'spillbackWedge'
  // claims
  | 'staleClaim'
  | 'orphanClaim'
  // signals
  | 'allRedTooLong'
  | 'groupStarved'
  | 'planCoverageGap'
  | 'degradedPlan'
  // pedestrians
  | 'pedFrozen'
  | 'pedInRoadStalled'
  | 'pedOutsideSidewalk'
  | 'pedSignalContradiction'
  // geometry
  | 'shortLink'
  | 'degenerateGeometry';

export interface AuditIssue {
  readonly code: AuditCode;
  readonly tick: number;
  readonly subject: string;
  readonly detail: string;
}

export const issue = (
  code: AuditCode,
  tick: number,
  subject: string | number,
  detail: string,
): AuditIssue => ({ code, tick, subject: String(subject), detail });

/** Counts issues by code, for a compact status readout. */
export function summarize(issues: readonly AuditIssue[]): Map<AuditCode, number> {
  const out = new Map<AuditCode, number>();
  for (const i of issues) out.set(i.code, (out.get(i.code) ?? 0) + 1);
  return out;
}
