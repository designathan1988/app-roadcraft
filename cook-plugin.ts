import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * The people cooked ahead (`src/render/people/cookedPerson.ts`).
 *
 * `__PEOPLE_COOK_HASH__` is a fingerprint of everything a body is built from:
 * the people code (its sources, read in full) and the people assets (their
 * names and sizes). The cook (`scripts/cook-people.mjs`) stamps it on what it
 * writes; the game reads a cooked body only under the same fingerprint, and
 * builds it otherwise - a change to how people are built is never served a
 * stale body.
 *
 * Development: `/cooked/...` is served from `cooked/`, and the cook script
 * PUTs its files to `/__cook/...`. Build: `cooked/people` is copied into
 * `dist/cooked/people` when its stamp matches.
 */
const SOURCES = ['src/people', 'src/render/people', 'src/render/citizenCasting.ts'];
const ASSETS = ['public/models/people'];
const DIR = 'cooked';

function walk(root: string, out: string[]): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.statSync(root);
  if (stat.isFile()) { out.push(root); return; }
  for (const name of fs.readdirSync(root).sort()) walk(path.join(root, name), out);
}

export function peopleCookHash(root: string): string {
  const hash = createHash('sha256');
  const sources: string[] = [];
  for (const s of SOURCES) walk(path.join(root, s), sources);
  for (const file of sources) {
    hash.update(path.relative(root, file).replace(/\\/g, '/'));
    // Line endings do not change a body.
    hash.update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  }
  const assets: string[] = [];
  for (const a of ASSETS) walk(path.join(root, a), assets);
  for (const file of assets) hash.update(`${path.relative(root, file).replace(/\\/g, '/')}:${fs.statSync(file).size}`);
  return hash.digest('hex').slice(0, 16);
}

export function cookPlugin(): Plugin {
  let root = process.cwd();
  let outDir = 'dist';
  let hash = '';
  return {
    name: 'roadcraft-cook',
    config(config) {
      root = path.resolve(config.root ?? process.cwd());
      hash = peopleCookHash(root);
      return { define: { __PEOPLE_COOK_HASH__: JSON.stringify(hash) } };
    },
    configResolved(resolved) {
      outDir = path.resolve(resolved.root, resolved.build.outDir);
    },
    configureServer(server) {
      // A change to how people are built changes the fingerprint: the server
      // restarts with the new one, and the cooked bodies no longer match.
      const watched = [...SOURCES, ...ASSETS].map((s) => path.join(root, s));
      server.watcher.on('change', (file) => {
        if (!watched.some((w) => path.resolve(file).startsWith(path.resolve(w)))) return;
        if (peopleCookHash(root) !== hash) void server.restart();
      });
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]!;
        if (req.method === 'PUT' && url.startsWith('/__cook/')) {
          const target = path.join(root, DIR, path.normalize(url.slice('/__cook/'.length)).replace(/^(\.\.[/\\])+/, ''));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => { fs.writeFileSync(target, Buffer.concat(chunks)); res.statusCode = 204; res.end(); });
          return;
        }
        if (req.method === 'GET' && url.startsWith('/cooked/')) {
          const file = path.join(root, DIR, path.normalize(url.slice('/cooked/'.length)).replace(/^(\.\.[/\\])+/, ''));
          if (fs.existsSync(file) && fs.statSync(file).isFile()) {
            res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-cache');
            fs.createReadStream(file).pipe(res);
            return;
          }
          res.statusCode = 404; res.end(); return;
        }
        next();
      });
    },
    closeBundle() {
      const from = path.join(root, DIR, 'people');
      const manifest = path.join(from, 'manifest.json');
      if (!fs.existsSync(manifest)) return;
      const stamp = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { hash?: string }).hash;
      if (stamp !== hash) return;
      const to = path.join(outDir, DIR, 'people');
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) fs.copyFileSync(path.join(from, name), path.join(to, name));
    },
  };
}
