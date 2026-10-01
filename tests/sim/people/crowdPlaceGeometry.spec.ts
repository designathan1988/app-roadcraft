import { expect, it } from 'vitest';
import { AGENT_HEIGHT, AGENT_RADIUS } from '@sim/people/crowdNav';
import { approachClearsPlace, ASK_AT, waitingApproachHasPermission, waitingApproachIsLocal, waitingFootprintsOverlap } from '@sim/people/crowd';

it('does not treat a nearby stopping point as permission for a city-wide detour', () => {
  const kerb = [{ x: 0, y: -1 }, { x: 0, y: 1 }];
  expect(waitingApproachIsLocal([{ x: -3, y: 0 }, { x: -ASK_AT * 10, y: 0 }, { x: -2, y: 0 }], kerb)).toBe(false);
  expect(waitingApproachIsLocal([{ x: -ASK_AT - 2, y: 0 }, { x: -3, y: 0 }, { x: -2, y: 0 }], kerb)).toBe(true);
});

it('does not use an unrelated crossing grant for a waiting approach', () => {
  const crossing = { id: 'closed', a: { x: 0, y: -10 }, b: { x: 0, y: 10 }, half: 1, kerb: 2, h: 0 };
  const path = [{ x: -3, y: 0, h: 0 }, { x: 3, y: 0, h: 0 }];
  expect(waitingApproachHasPermission(path, [crossing], new Set(['elsewhere']))).toBe(false);
  expect(waitingApproachHasPermission(path, [crossing], new Set(['closed']))).toBe(true);
  expect(waitingApproachHasPermission(path.map(p => ({ ...p, h: AGENT_HEIGHT + 1 })), [crossing], new Set())).toBe(true);
});

it('keeps the whole body clear of an ungranted zebra, including lateral edges', () => {
  const crossing = { id: 'closed', a: { x: 0, y: -10 }, b: { x: 0, y: 10 }, half: 1, kerb: 2, h: 0 };
  const near = [{ x: 1 + AGENT_RADIUS / 2, y: -9, h: 0 }, { x: 1 + AGENT_RADIUS / 2, y: 9, h: 0 }];
  expect(waitingApproachHasPermission(near, [crossing], new Set(['elsewhere']))).toBe(false);
  const beyond = near.map(p => ({ ...p, x: 1 + AGENT_RADIUS + 0.1 }));
  expect(waitingApproachHasPermission(beyond, [crossing], new Set())).toBe(true);
  const corner = { x: 1 + AGENT_RADIUS * 0.8, y: 8 + AGENT_RADIUS * 0.8, h: 0 };
  expect(waitingApproachHasPermission([corner, corner], [crossing], new Set())).toBe(true);
});

it('does not consume capacity with a body on a separate deck', () => {
  const lower = { x: 0, y: 0, h: 0 };
  const upper = { x: 0, y: 0, h: AGENT_HEIGHT + 1 };
  expect(waitingFootprintsOverlap(lower, lower)).toBe(true);
  expect(waitingFootprintsOverlap(lower, upper)).toBe(false);
});

it('only blocks an approach when the two bodies overlap vertically', () => {
  const standing = { x: 0, y: 0, h: 0 };
  const lower = [{ x: -3, y: 0, h: 0 }, { x: 3, y: 0, h: 0 }];
  const upper = lower.map(p => ({ ...p, h: AGENT_HEIGHT + 1 }));
  expect(approachClearsPlace(lower, standing)).toBe(false);
  expect(approachClearsPlace(upper, standing)).toBe(true);
});

it('still permits a body already overlapping a reservation to move directly out', () => {
  expect(approachClearsPlace([{ x: 0.5, y: 0, h: 0 }, { x: 3, y: 0, h: 0 }], { x: 0, y: 0, h: 0 })).toBe(true);
});
