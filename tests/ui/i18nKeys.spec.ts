import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EN } from '@ui/i18n/en';
import { isTerrainMode } from '@world/terrain';

/**
 * Keys the CODE asks for exist.
 *
 * `i18n.spec.ts` checks the markup and that the two dictionaries agree; nothing
 * checked the keys TypeScript builds, which is how the Builder's touch hints
 * and one of its run hints shipped as raw keys (the canvas's
 * aria-describedby read "hint.mobile.builder.select" aloud).
 */
const root = fileURLToPath(new URL('../../src', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') ? [path] : [];
  });
const sources = walk(root).filter((path) => !path.includes(`${join('ui', 'i18n')}`));
const main = readFileSync(join(root, 'main.ts'), 'utf8');

const defined = (key: string): boolean => key in EN || `${key}.one` in EN;

/** Functions whose first argument is a dictionary key. */
const KEY_CALLS = /\b(?:t|plural|flashHint|flash|notify|menuNote)\(\s*'([a-z][\w-]*(?:\.[\w-]+)+)'/g;

describe('keys used in code', () => {
  it('every literal key passed to a translation call is defined', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const path of sources) {
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(KEY_CALLS)) {
        seen++;
        const key = match[1] as string;
        if (!defined(key)) missing.push(`${key} (${path.slice(root.length + 1)})`);
      }
    }
    expect(seen).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });

  it('every tool has its desktop hint, and every terrain brush its own', () => {
    const union = /type Tool =([\s\S]*?);/.exec(main)?.[1] ?? '';
    const tools = [...union.matchAll(/'(\w+)'/g)].map((m) => m[1] as string);
    expect(tools.length).toBeGreaterThan(6);
    const missing: string[] = [];
    for (const tool of tools) {
      // The Builder derives its hint from its own state (buildingsWiring).
      if (tool === 'building' || tool === 'terrain') continue;
      if (!defined(`hint.${tool}`)) missing.push(`hint.${tool}`);
    }
    for (const mode of ['raise', 'lower', 'flatten', 'river']) {
      expect(isTerrainMode(mode)).toBe(true);
      for (const prefix of ['hint', 'hint.mobile']) {
        if (!defined(`${prefix}.terrain.${mode}`)) missing.push(`${prefix}.terrain.${mode}`);
      }
    }
    for (const alignment of ['curve', 'free']) {
      if (!defined(`hint.road.${alignment}`)) missing.push(`hint.road.${alignment}`);
    }
    expect(missing).toEqual([]);
  });

  it('every traced run the Builder can arm has a hint', () => {
    const wiring = readFileSync(join(root, 'buildingsWiring.ts'), 'utf8');
    // The run ids and the element kind each one lays: `id === 'wallRun' ? 'wall' : ...`.
    const choice = /const kind = (id === '\w+Run'[^;]+);/.exec(wiring)?.[1] ?? '';
    const kinds = new Set([...choice.matchAll(/'(\w+)'/g)].map((m) => m[1] as string).filter((k) => !k.endsWith('Run')));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    const missing = [...kinds].filter((kind) => !defined(`hint.builder.run.${kind}`));
    expect(missing).toEqual([]);
  });
});
