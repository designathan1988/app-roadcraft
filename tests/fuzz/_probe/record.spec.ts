import { it } from 'vitest';
import { generate, replay, saveFixture, shrink } from '../support/runner';

it('record', () => {
  const seed = Number(process.env['SEED']); const cat = process.env['CAT']!;
  const sim = process.env['SIMSEC'] ? { seconds: Number(process.env['SIMSEC']), seed: 0x5eed, intensity: 1.5 } : null;
  const ops = generate(seed, Number(process.env['OPS'] ?? 40));
  const minimal = process.env['NOSHRINK'] ? [...ops] : shrink(ops, cat, sim);
  const again = replay(minimal, sim, cat);
  if (!again.defects.length) throw new Error('did not reproduce');
  const path = saveFixture({ name: process.env['NAME']!, category: cat, detail: `${again.defects[0]!.subject} ${again.defects[0]!.detail}`,
    sim: again.step < 0 ? sim : null, ops: minimal, ...(process.env['OPEN'] ? { open: process.env['OPEN'] } : {}), ...(process.env['GATE'] ? { gate: true } : {}) });
  console.log(path, minimal.length);
});
