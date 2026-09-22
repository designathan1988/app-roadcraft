import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * THE LAYER ORDER, ENFORCED.
 *
 * AGENTS.md section 2 states the dependency order and says never to violate
 * it. Nothing checked, and two violations had grown:
 *
 *   - `world/markings.ts` imported its line colours from `ui/overlay/palette`,
 *     a real cycle - `world` to `ui` and `ui` back to `world`;
 *   - `render` reached `ui` through `view`, because the flat camera sat in
 *     `ui/overlay/` while `view/viewport.ts` imported it.
 *
 * Both are fixed. This is what stops them coming back, and what makes the
 * order a rule rather than a paragraph.
 *
 * Each entry lists the layers that one may import, ITSELF INCLUDED. `main.ts`
 * is the composition root and is deliberately absent: wiring every layer
 * together is its whole job.
 *
 * `ui` may read `sim` because the inspector and the minimap display live
 * simulation state. It is a read of a layer below it, not a cycle: nothing in
 * `sim` knows `ui` exists.
 */
const LAYERS = {
  core: ['core'],
  world: ['core', 'world'],
  sim: ['core', 'world', 'sim'],
  view: ['core', 'view'],
  render: ['core', 'world', 'sim', 'view', 'render'],
  editor: ['core', 'world', 'editor'],
  ui: ['core', 'world', 'sim', 'view', 'ui'],
};

const ALL = Object.keys(LAYERS);

/** One ESLint block per layer, banning every alias it may not import. */
const layerRules = Object.entries(LAYERS).map(([layer, allowed]) => ({
  files: [`src/${layer}/**/*.ts`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: ALL.filter((other) => !allowed.includes(other)).map((other) => ({
          group: [`@${other}/*`, `@/${other}/*`],
          message:
            `${layer} may not import ${other}. See the dependency order in ` +
            'AGENTS.md section 2 - if the thing you want is in the wrong ' +
            'layer, move the thing rather than the import.',
        })),
      },
    ],
  },
}));

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'docs/screenshots/**',
      // Scratch space for investigation. Never committed, never linted: a
      // throwaway probe must not be able to break `npm run check`. Matched at
      // ANY depth, because a probe is dropped beside what it probes.
      'tests/**/_*/**',
      'tests/**/_*',
      'scripts/**/_*/**',
      'scripts/**/_*',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...layerRules,
  {
    // Plain Node tooling. `eslint .` reaches it, and without globals every
    // `console` is an error.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    // Browser globals inside `page.evaluate` callbacks, which ESLint sees as
    // Node code even though they are serialised and run in Chromium.
    files: ['scripts/verify-visual.mjs'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        requestAnimationFrame: 'readonly',
        performance: 'readonly',
        Image: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      // TypeScript performs the authoritative project-wide unused check.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      // Canvas fakes and browser diagnostic surfaces intentionally model
      // dynamic platform APIs; explicit any is clearer there than casts piled up.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
