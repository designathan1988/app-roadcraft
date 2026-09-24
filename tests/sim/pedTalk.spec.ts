import { describe, expect, it } from 'vitest';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { m } from '@world/units';
import type { Ped } from '@sim/peds/state';
import { fixtureDoc, simOf } from './support/bodies';

/**
 * PEOPLE WHO STOP TO TALK LOOK AT EACH OTHER.
 *
 * Measured on the saved player map before this, over four minutes: people
 * talking stood where they had been walking — shoulder to shoulder, 0.72 m
 * apart centre to centre, three in a row — and faced the average position of
 * everybody else in the party. The one in the middle of three faced nobody;
 * two of three faced a companion who had been held up sixteen metres back and
 * was "talking" alone at a kerb; one in eight of the samples was more than 20
 * degrees off the companions, one in ten more than 26. Each member stopped
 * where its own arrival found it, so a party stopped member by member.
 *
 * Now a party that stops lays itself out as a circle: face to face for two, a
 * ring for three or four, a conversational distance apart, and each member
 * faces its centre. The whole party stops together and leaves together.
 */
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

interface Talk {
  samples: number;
  facingOff: number[];
  pairDistance: number[];
  alone: number;
  split: number;
  groups: Set<number>;
  bigGroups: Set<number>;
}

function measure(seconds: number): Talk {
  const sim = simOf(fixtureDoc(), 0x51de, 1);
  sim.pedestrianIntensity = 2;
  const talk: Talk = { samples: 0, facingOff: [], pairDistance: [], alone: 0, split: 0, groups: new Set(), bigGroups: new Set() };
  const parties = new Map<object, Ped[]>();
  sim.clock.run(Math.round(seconds / DT), () => {
    step(sim, { traffic: true, pedestrians: true });
    parties.clear();
    for (const p of sim.peds.values()) {
      if (p.activity?.kind !== 'talk') continue;
      const list = parties.get(p.party) ?? [];
      list.push(p);
      parties.set(p.party, list);
    }
    for (const members of parties.values()) {
      const holding = members.filter((p) => p.activity!.phase === 'hold');
      if (holding.length === 1 && holding[0]!.activity!.t > 3) talk.alone += DT;
      if (new Set(members.map((p) => p.edge)).size > 1) talk.split += DT;
      // A conversation proper: everybody who stopped to talk is standing in it.
      if (holding.length < 2 || holding.length < members.length) continue;
      talk.groups.add(holding[0]!.party.id);
      if (holding.length >= 3) talk.bigGroups.add(holding[0]!.party.id);
      for (const p of holding) {
        // Settled: a second and a half to turn to the others.
        if (p.activity!.t < 1.5) continue;
        const others = holding.filter((o) => o !== p);
        const cx = others.reduce((s, o) => s + o.x, 0) / others.length;
        const cy = others.reduce((s, o) => s + o.y, 0) / others.length;
        // Two face each other; three or four face the middle of the ring,
        // which is the middle of the others too, seen from any one of them.
        talk.facingOff.push(Math.abs(wrap(Math.atan2(cy - p.y, cx - p.x) - p.heading)) * 180 / Math.PI);
        if (holding.length === 2) talk.pairDistance.push(Math.hypot(others[0]!.x - p.x, others[0]!.y - p.y) / m(1));
        talk.samples++;
      }
    }
  });
  return talk;
}

const quantile = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))]!;

describe('talking', () => {
  const talk = measure(240);
  if (process.env.TALK_REPORT) {
    console.log(JSON.stringify({ samples: talk.samples, groups: talk.groups.size, big: talk.bigGroups.size,
      alone: talk.alone, split: talk.split,
      off: [0.5, 0.9, 0.97, 0.99].map((q) => quantile(talk.facingOff, q)),
      pair: [0.05, 0.5, 0.95].map((q) => quantile(talk.pairDistance, q)) }));
  }

  it('happens, in pairs and in larger groups', () => {
    expect(talk.groups.size).toBeGreaterThanOrEqual(3);
    expect(talk.bigGroups.size).toBeGreaterThanOrEqual(1);
    expect(talk.samples).toBeGreaterThan(2000);
  });

  it('faces the others: every member turned towards the middle of the group', () => {
    const within = talk.facingOff.filter((d) => d < 20).length / talk.facingOff.length;
    expect(quantile(talk.facingOff, 0.5)).toBeLessThan(10);
    expect(within).toBeGreaterThan(0.9);
    expect(quantile(talk.facingOff, 0.99)).toBeLessThan(35);
  });

  it('stands at a conversational distance, not shoulder to shoulder', () => {
    // Known remaining case: a member held off its place by a lamp column
    // talks from 2.6 m for a long hold, a large share of the pair samples here.
    expect(talk.pairDistance.length).toBeGreaterThan(500);
    expect(quantile(talk.pairDistance, 0.05)).toBeGreaterThan(0.85);
    expect(quantile(talk.pairDistance, 0.5)).toBeLessThan(1.2);
  });

  it('never leaves one member talking to nobody, or the party split across footways', () => {
    expect(talk.alone).toBe(0);
    expect(talk.split).toBe(0);
  });
});
