import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'docs/screenshots/**',
      // Scratch space for investigation. Never committed, never linted: a
      // throwaway probe must not be able to break `npm run check`.
      'tests/_*/**',
      'scripts/_*/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
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
