import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { generate } from '../support/runner';
import { applyOp, freshState } from '../support/ops';
import { checkWorld } from '../support/invariants';

it('turn excursion distribution', () => {
  const values: { by: number; turn: string; seed: number; subject: string; detail: string }[] = [];
  for (let seed = 1; seed <= 20; seed++) {
    const ops = generate(seed, 30);
    const state = freshState();
    for (const op of ops) { try { if (!applyOp(state, op)) continue; } catch { break; } }
    let found: ReturnType<typeof checkWorld> = []; try { found = checkWorld(state.doc, state.net); } catch { continue; }
    for (const d of found) {
      if (d.category !== 'turnOffSurface') continue;
      const by = Number(d.detail.split(' ')[1]);
      values.push({ by, turn: d.detail.split(' ')[0]!, seed, subject: d.subject, detail: d.detail });
    }
  }
  values.sort((a, b) => a.by - b.by);
  const q = (f: number) => values[Math.floor(f * (values.length - 1))]?.by;
  const lines = [`n=${values.length} p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)} max=${q(1)}`];
  for (const bucket of [0.25, 0.5, 1, 2, 4, 8]) lines.push(`> ${bucket}: ${values.filter(v => v.by > bucket).length}`);
  const byTurn = new Map<string, number>(); for (const v of values) if (v.by > 1) byTurn.set(v.turn, (byTurn.get(v.turn) ?? 0) + 1);
  lines.push(JSON.stringify([...byTurn]));
  for (const v of values.slice(-8)) lines.push(`seed ${v.seed} ${v.subject} ${v.detail}`);
  writeFileSync(process.env['OUT']!, lines.join('\n') + '\n');
});
