import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: '.',
  publicDir: 'public',
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
  server: {
    host: '127.0.0.1',
    // `PORT` lets a preview harness hand this server a free port when 5173 is
    // already taken by another project's dev server. Falls back for `npm run dev`.
    port: Number(process.env['PORT'] ?? 5173),
    strictPort: false,
    // Test and coverage artefacts live under the project root. They must not
    // trigger a full application reload while a browser smoke test is running.
    watch: {
      ignored: [
        '**/coverage/**',
        '**/dist/**',
        '**/playwright-report/**',
        '**/test-results/**',
      ],
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
    // three.js is most of the bundle and never changes between releases of the
    // game, so it gets its own chunk: a rebuild of the game invalidates ~280 kB
    // rather than ~920 kB of a returning player's cache. The renderer is not
    // lazy-loaded behind a dynamic import, because there is no frame of this
    // game that does not need it — deferring it would only add a round trip
    // before the first paint.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: (id: string) =>
          id.includes('node_modules/three') ? 'three' : undefined,
      },
    },
  },
});
