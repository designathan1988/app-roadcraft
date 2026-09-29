import { appendFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { fixtureDoc, simOf } from './support/bodies';

const OUT = 'coverage/pedDiag.txt';
writeFileSync(OUT, '');
const say = (...parts: unknown[]): void => {
  appendFileSync(OUT, parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') + '\n');
};

describe('pedestrian population', () => {
  it('counts the crowd over ten minutes', () => {
    const sim = simOf(fixtureDoc(), 0x51de, 2);
    say('start', sim.peds.size, 'goal', sim.pedestrianIntensity);
    for (let t = 0; t < Math.round(600 / DT); t++) {
      step(sim, { traffic: true, pedestrians: true });
      sim.clock.tick++;
      if ((t + 1) % Math.round(60 / DT) === 0) {
        say(`t=${(t * DT).toFixed(0)}s peds=${sim.peds.size} spawned=${sim.pedSpawned ?? '?'}`);
      }
    }
  });
});
