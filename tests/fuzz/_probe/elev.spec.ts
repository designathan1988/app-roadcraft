import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { generate, replay } from '../support/runner';
import { buildRoadElevation } from '@world/elevation';

it('elev', () => {
  const ops = generate(29, 40);
  const out = replay(ops, null, 'elevationStep');
  const { net } = out.state;
  const e = buildRoadElevation(net, () => 0);
  const line = net.ribbons.get(7 as never)!.full;
  const rows: string[] = [];
  for (let s = 0; s <= 12; s += 0.25) { const p = line.sampleAt(s).p; rows.push(`${s.toFixed(2)} ${e.onSegment(7 as never, p.x, p.y).toFixed(3)} at(all) ${e.at(p.x, p.y).toFixed(3)}`); }
  writeFileSync(process.env['OUT']!, rows.join('\n'));
});
