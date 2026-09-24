import { pedHash } from '@sim/peds/behaviour';
import type { Ped } from '@sim/peds/state';
import { m } from '@world/units';

export interface SocialCue {
  readonly gazeYaw: number;
  readonly talkWeight: number;
  readonly holdSide: -1 | 0 | 1;
  readonly holdWeight: number;
}

const NONE: SocialCue = { gazeYaw: 0, talkWeight: 0, holdSide: 0, holdWeight: 0 };

const angleDelta = (from: number, to: number): number =>
  Math.atan2(Math.sin(to - from), Math.cos(to - from));

/** A party member is an id offset from the party's first pedestrian. */
export function socialCue(ped: Ped, members: ReadonlyMap<number, Ped>, time: number): SocialCue {
  if (ped.party.size < 2) return NONE;

  let partner: Ped | undefined;
  let partnerDistance = Infinity;
  for (let rank = 0; rank < ped.party.size; rank++) {
    if (rank === ped.rank) continue;
    const other = members.get(ped.party.id + rank);
    if (!other || other.party !== ped.party || other.edge !== ped.edge || other.entry !== ped.entry) continue;
    const distance = Math.hypot(other.x - ped.x, other.y - ped.y);
    if (distance < partnerDistance && distance < m(2)) {
      partner = other;
      partnerDistance = distance;
    }
  }
  if (!partner) return NONE;

  const pairRank = ped.rank ^ 1;
  const pair = members.get(ped.party.id + pairRank);
  const dx = partner.x - ped.x;
  const dy = partner.y - ped.y;
  const pulse = 0.5 + 0.5 * Math.sin(time * 1.1 + (pedHash(ped.party.id) % 97) * 0.13);
  const conversation = Math.max(0, (pulse - 0.25) / 0.75);
  const proximity = Math.max(0, 1 - partnerDistance / m(2));
  const gaze = angleDelta(ped.heading, Math.atan2(dy, dx));
  const gazeYaw = Math.max(-0.22, Math.min(0.22, gaze)) * conversation * proximity;
  const talkWeight = conversation * proximity *
    (0.7 + 0.3 * Math.sin(time * 2.2 + pedHash(ped.id) % 19));

  if (!pair || pair !== partner || ped.state !== 'Walking' || pair.state !== 'Walking' ||
      ped.v < m(0.3) || pair.v < m(0.3) || ped.pause > 0 || pair.pause > 0 ||
      Math.abs(angleDelta(ped.heading, pair.heading)) > 0.35 ||
      partnerDistance < m(0.28) || partnerDistance > m(1.05)) {
    return { gazeYaw, talkWeight, holdSide: 0, holdWeight: 0 };
  }

  const forward = dx * Math.cos(ped.heading) + dy * Math.sin(ped.heading);
  if (Math.abs(forward) > m(0.55)) return { gazeYaw, talkWeight, holdSide: 0, holdWeight: 0 };
  const lateral = -dx * Math.sin(ped.heading) + dy * Math.cos(ped.heading);
  if (Math.abs(lateral) < m(0.2)) return { gazeYaw, talkWeight, holdSide: 0, holdWeight: 0 };

  const holdSide: -1 | 1 = lateral > 0 ? -1 : 1;
  const holdWeight = Math.min(1,
    Math.max(0, (partnerDistance - m(0.28)) / m(0.12)),
    Math.max(0, (m(1.05) - partnerDistance) / m(0.25)),
    Math.max(0, (m(0.55) - Math.abs(forward)) / m(0.2)),
  );
  return { gazeYaw, talkWeight, holdSide, holdWeight };
}
