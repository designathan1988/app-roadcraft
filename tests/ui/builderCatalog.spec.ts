import { describe, expect, it } from 'vitest';

import { BUILDER_CATALOG } from '@editor/builderCatalog';
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
});
