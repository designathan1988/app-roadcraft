import { execFileSync } from 'node:child_process';
import type { Plugin } from 'vite';

/**
 * WHICH BUILD IS ON THE SCREEN. Branch, short commit and commit date of the
 * checkout the server runs from, plus `dirty` when it has uncommitted edits.
 *
 * A round of fixes once lived on a branch while the player ran master, and
 * every "fixed" was false on their screen. The development server answers
 * `/__build` afresh on every request, so the stamp stays right after a
 * fast-forward without a restart; a production build bakes it in.
 */
export interface BuildStamp {
  readonly branch: string;
  readonly hash: string;
  readonly date: string;
  readonly dirty: boolean;
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export function readBuildStamp(): BuildStamp {
  return {
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown',
    hash: git(['rev-parse', '--short', 'HEAD']) || 'unknown',
    date: git(['log', '-1', '--format=%cI']) || '',
    dirty: git(['status', '--porcelain', '--untracked-files=no']).length > 0,
  };
}

export function buildStampPlugin(): Plugin {
  return {
    name: 'roadcraft-build-stamp',
    config: () => ({ define: { __BUILD_STAMP__: JSON.stringify(readBuildStamp()) } }),
    configureServer(server) {
      server.middlewares.use('/__build', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(readBuildStamp()));
      });
    },
  };
}
