import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
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

/** The git binary: on PATH, or where Git for Windows installs it (a server started from a shell without it on PATH once stamped every build "unknown"). */
const GIT_CANDIDATES = ['git', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe'];

function git(args: string[]): string {
  for (const binary of GIT_CANDIDATES) {
    try {
      return execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // Try the next candidate.
    }
  }
  return '';
}

/**
 * Branch and commit read straight from the `.git` files, for when no git
 * binary can be run at all. Handles a linked worktree (`.git` is a file
 * pointing at its gitdir, whose `commondir` holds the refs) and packed refs.
 */
function readGitFiles(start = process.cwd()): { branch: string; hash: string } | null {
  let dir = start;
  for (;;) {
    const dotGit = path.join(dir, '.git');
    if (fs.existsSync(dotGit)) {
      let gitDir = dotGit;
      if (fs.statSync(dotGit).isFile()) {
        const pointer = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotGit, 'utf8'));
        if (!pointer) return null;
        gitDir = path.resolve(dir, pointer[1]!.trim());
      }
      const commonFile = path.join(gitDir, 'commondir');
      const common = fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim()) : gitDir;
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
      if (!ref) return { branch: 'HEAD', hash: head.slice(0, 7) };
      const loose = [path.join(gitDir, ref), path.join(common, ref)].find((file) => fs.existsSync(file));
      let hash = loose ? fs.readFileSync(loose, 'utf8').trim() : '';
      if (!hash) {
        const packed = path.join(common, 'packed-refs');
        const line = fs.existsSync(packed) ? fs.readFileSync(packed, 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`)) : undefined;
        hash = line?.split(' ')[0] ?? '';
      }
      return { branch: ref.replace(/^refs\/heads\//, ''), hash: hash.slice(0, 7) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readBuildStamp(): BuildStamp {
  const files = readGitFiles();
  return {
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || files?.branch || 'unknown',
    hash: git(['rev-parse', '--short', 'HEAD']) || files?.hash || 'unknown',
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
