import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@world': r('./src/world'),
      '@sim': r('./src/sim'),
      '@render': r('./src/render'),
      '@view': r('./src/view'),
      '@editor': r('./src/editor'),
      '@ui': r('./src/ui'),
      '@': r('./src'),
    },
  },
  test: {
    globals: true,
    // Headless by design: no DOM. Anything needing a canvas uses the FakeCtx recorder.
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // Scratch space for investigation, ignored by the runner, the linter and
    // the compiler alike. The pattern used to be `tests/_*/**`, which only
    // matches a folder at the TOP of `tests/` - a probe dropped beside the
    // tests it was probing, `tests/world/_diag.spec.ts`, ran and could break
    // `npm run check`, which is exactly what the invariant promised it could
    // not. Any path segment starting with an underscore is scratch now.
    exclude: ['tests/e2e/**', 'tests/**/_*/**', 'tests/**/_*'],
    // Tests always run with invariant assertions armed.
    env: { SIM_STRICT: '1' },
    // Not a speed limit - the budgets that matter are asserted by the tests
    // that own them. Several suites run minutes of a whole map, traffic and
    // all, and under the full suite with coverage beside them they took up to
    // seven times as long as alone and failed on a clock, not on a defect.
    testTimeout: 180_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // The layers that can be tested headlessly and deterministically: the
      // document, the geometry, the height solver, the mesh builder and the
      // simulation. WebGL, the DOM interface and the viewport seam are covered
      // by `npm run verify:visual`, which drives the real application in a real
      // browser; asking a node test runner to cover them would only measure how
      // much of the renderer can be imported without a GPU.
      include: [
        'src/core/**/*.ts',
        'src/world/**/*.ts',
        'src/sim/**/*.ts',
        'src/editor/**/*.ts',
        'src/render/mesh/**/*.ts',
        'src/ui/i18n/**/*.ts',
      ],
      // Set from the measured value, so they can only ever be raised.
      thresholds: {
        statements: 66,
        branches: 54,
        functions: 70,
        lines: 69,
      },
    },
  },
});
