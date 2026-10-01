import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CITIES, formatDefects, measureDefects } from '../support/agentDefects';

/**
 * The agents, in every kind of city the player builds, with the engines the
 * game runs: nobody stands frozen on a zebra or a pavement, nobody fidgets,
 * nobody slides, pops or jumps, and no junction locks.
 */
const REPORT = process.env.AGENT_REPORT;
describe('agents in every city', () => {
  for (const city of CITIES) {
    it(city.name, () => {
      const r = measureDefects(city, Number(process.env.AGENT_SECONDS ?? city.seconds ?? 90));
      if (REPORT) appendFileSync(REPORT, formatDefects(r) + '\n');
      expect(r.people).toBeGreaterThan(10);
      // Never stepping backwards nor jumping; sideways faster than a shuffle
      // and side-to-side pops only as the rarest slide along a wall.
      expect({ back: r.back, jump: r.jump }).toEqual({ back: 0, jump: 0 });
      expect(r.side).toBeLessThan(0.1);
      expect(r.flip).toBeLessThan(0.1);
      // Nobody stands frozen: on a zebra (the cars wait for them) or on a
      // pavement, other than waiting at a kerb, sitting or talking.
      expect(r.zebraStand).toBeLessThan(5);
      expect(r.pavementStand).toBeLessThan(4);
      // Standing still means standing still: no head swinging to and fro.
      expect(r.fidgets).toBeLessThan(0.1);
      // Bodies meet (closer than 0.4 m) only for a moment, somebody held up
      // squeezing past - the price of nobody ever being stuck: keeping them
      // apart even then brought back people standing for seconds (measured).
      // Walking through people - the last resort - all but never happens.
      expect(r.overlaps).toBeLessThan(0.5);
      expect(r.ghost).toBeLessThan(0.005);
      expect(r.junction).toBeLessThan(60);
      // No car stands longer than a signal cycle: the longest measured is a
      // five-stage junction's red, 78 s; a frozen car would grow without end.
      expect(r.still).toBeLessThan(100);
    }, 300_000);
  }
});
