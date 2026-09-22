import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EN } from '@ui/i18n/en';
import { PT_BR } from '@ui/i18n/pt-BR';
import { LANGUAGES } from '@ui/i18n';

const placeholders = (value: string): string[] =>
  [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

describe('translation dictionaries', () => {
  it('cover exactly the same keys', () => {
    const missing = Object.keys(EN).filter((key) => !(key in PT_BR));
    const extra = Object.keys(PT_BR).filter((key) => !(key in EN));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('use the same placeholders in every language', () => {
    for (const [key, value] of Object.entries(EN)) {
      expect(placeholders(PT_BR[key] as string), key).toEqual(placeholders(value));
    }
  });

  it('never leave a string empty', () => {
    for (const [key, value] of Object.entries({ ...EN, ...PT_BR })) {
      expect(value.trim().length, key).toBeGreaterThan(0);
    }
  });

  it('list every language that has a dictionary', () => {
    expect(LANGUAGES.map((l) => l.code).sort()).toEqual(['en', 'pt-BR']);
  });
});

describe('markup', () => {
  it('declares only keys the dictionaries define', () => {
    const used = [...html.matchAll(/data-i18n(?:-title|-label|-html)?="([^"]+)"/g)].map(
      (m) => m[1] as string,
    );
    expect(used.length).toBeGreaterThan(30);
    const unknown = [...new Set(used)].filter((key) => !(key in EN));
    expect(unknown).toEqual([]);
  });

  it('opens in English, so the shipped markup matches the reference dictionary', () => {
    expect(html).toMatch(/<html lang="en">/);
  });

  it('leaves no Portuguese text in the shipped markup', () => {
    const body = html.replace(/data-i18n[^=]*="[^"]*"/g, '');
    expect(body).not.toMatch(/[áàãâéêíóôõúçÁÉÍÓÚÃÕÇ]/);
  });
});
