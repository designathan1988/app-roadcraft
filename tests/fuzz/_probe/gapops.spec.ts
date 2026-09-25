import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { generate } from '../support/runner';
import { applyOp, freshState } from '../support/ops';
import { checkWorld } from '../support/invariants';

it('which gestures open gaps', () => {
  const cat = process.env['CAT'] ?? 'surfaceGap';
  const byOp = new Map<string, number>(); const examples: string[] = [];
  for (let seed = 1; seed <= 40; seed++) {
    const ops = generate(seed, 40); const state = freshState(); let before = new Set<string>();
    for (let i = 0; i < ops.length; i++) {
      let found: string[] = [];
      try { if (!applyOp(state, ops[i]!)) continue; found = checkWorld(state.doc, state.net).filter(d => d.category === cat).map(d => d.subject); } catch { break; }
      const fresh = found.filter(s => !before.has(s));
      if (fresh.length) { const k = ops[i]!.op; byOp.set(k, (byOp.get(k) ?? 0) + 1); if (examples.length < 10) examples.push(`seed ${seed} op ${i} ${JSON.stringify(ops[i])} -> ${fresh.join(';')}`); }
      before = new Set(found);
    }
  }
  writeFileSync(process.env['OUT']!, JSON.stringify([...byOp]) + '\n' + examples.join('\n') + '\n');
});
