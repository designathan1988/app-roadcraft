import { describe, expect, it } from 'vitest';

import { BUILDER_CATALOG, BUILDER_GALLERIES } from '@ui/builder/catalog';
import { builderIcon } from '@ui/builder/icons';
import { SNAP_MODES } from '@ui/builder/workspace';
import { ELEMENT_KINDS } from '@world/buildings/types';
import { EN } from '../../src/ui/i18n/en';
import { PT_BR } from '../../src/ui/i18n/pt-BR';

/**
 * Every button in the Builder Workspace carries a dictionary key: its label,
 * and the sentence the hint bar shows when it is the active tool. A tool added
 * to the catalogue without both would show a raw key on screen, which is the
 * one failure mode the workspace cannot see for itself.
 */
describe('builder catalogue', () => {
  it('names every category and tool in both dictionaries, with a hint each', () => {
    const problems: string[] = [];
    for (const category of BUILDER_CATALOG) {
      const categoryKey = `builder.category.${category.id}`;
      if (!(categoryKey in EN)) problems.push(`en ${categoryKey}`);
      if (!(categoryKey in PT_BR)) problems.push(`pt ${categoryKey}`);
      for (const tool of category.tools) {
        for (const key of [`builder.tool.${tool.id}`, `hint.builder.${tool.id}`]) {
          if (!(key in EN)) problems.push(`en ${key}`);
          if (!(key in PT_BR)) problems.push(`pt ${key}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('lists each tool in one category only', () => {
    const seen = new Set<string>();
    const repeated: string[] = [];
    for (const category of BUILDER_CATALOG) {
      for (const tool of category.tools) {
        if (seen.has(tool.id)) repeated.push(tool.id);
        seen.add(tool.id);
      }
    }
    expect(repeated).toEqual([]);
  });

  /**
   * The Snap menu showed five raw keys for weeks: it is built from the mode
   * list rather than from the catalogue, so nothing was checking it.
   */
  it('names every snap mode in both dictionaries', () => {
    const problems: string[] = [];
    for (const mode of SNAP_MODES) {
      const key = `builder.snap.${mode}`;
      if (!(key in EN)) problems.push(`en ${key}`);
      if (!(key in PT_BR)) problems.push(`pt ${key}`);
    }
    expect(problems).toEqual([]);
  });

  /**
   * A gallery of identical blank squares names the options without picturing
   * them: every id a button can carry has a glyph of its own.
   */
  it('pictures every button the catalogue or a gallery can show', () => {
    const fallback = builderIcon('__no-such-icon__');
    const ids = new Set<string>();
    for (const category of BUILDER_CATALOG) for (const tool of category.tools) ids.add(tool.id);
    for (const family of Object.values(BUILDER_GALLERIES)) for (const id of family) ids.add(id);
    for (const kind of ELEMENT_KINDS) ids.add(kind);
    const blank = [...ids].filter((id) => builderIcon(id) === fallback);
    expect(blank).toEqual([]);
  });
});
