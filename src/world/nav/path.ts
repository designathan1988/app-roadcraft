import { hypot2 } from '@core/scalar';
import { closestOnSegment, type NavMesh, type NavPortal } from './navmesh';

/**
 * A route across the mesh: the triangles it passes through, the portal it
 * leaves each one by, and the corners a person actually walks to (the
 * shortest line through those portals, "string pulling").
 */
export interface NavPath {
  readonly tris: number[];
  /** `portals[i]` leads from `tris[i]` into `tris[i + 1]`. */
  readonly portals: NavPortal[];
  /** Straight-line corners from the start (excluded) to the goal (included). */
  readonly corners: { x: number; y: number; /** index into `tris` of the triangle the corner leads into */ tri: number }[];
}

/**
 * Extra cost of stepping into triangle `to` from `from`, in world units: how
 * the planner is told that a zebra means a wait. Return 0 for none.
 */
export type NavCost = (from: number, to: number, length: number) => number;

/** A mesh's search memory, reused by every search on it (`findPath`). */
interface SearchPool {
  stamp: number;
  readonly g: Float64Array;
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly cameFrom: Int32Array;
  readonly camePortal: Int32Array;
  /** Stamp of the search that last reached / closed each triangle. */
  readonly seen: Uint32Array;
  readonly closed: Uint32Array;
  readonly open: Heap;
}
const POOLS = new WeakMap<NavMesh, SearchPool>();
function poolOf(mesh: NavMesh): SearchPool {
  let pool = POOLS.get(mesh);
  if (!pool) {
    const n = mesh.count;
    pool = {
      stamp: 0, g: new Float64Array(n), px: new Float64Array(n), py: new Float64Array(n),
      cameFrom: new Int32Array(n), camePortal: new Int32Array(n), seen: new Uint32Array(n), closed: new Uint32Array(n),
      open: new Heap(),
    };
    POOLS.set(mesh, pool);
  }
  return pool;
}

/**
 * Route searching allowed per simulation tick, in triangles expanded.
 *
 * Detour bounds the path work of a crowd the same way: its path queue runs at
 * most `MAX_ITERS_PER_UPDATE` search iterations an update, and an agent whose
 * request has not come up yet waits for it (`dtPathQueue::update`). Here a
 * route not wanted at once - a trip starting, a companion re-aiming at its
 * leader - waits for a tick with work left; one search, once begun, is
 * finished. Started all in one tick, a rush hour's trips stopped the frame.
 */
export const PATH_WORK_PER_TICK = 6000;
let workLeft = PATH_WORK_PER_TICK;
function spent(expanded: number): void { workLeft -= expanded; }
/** A new tick: the route searching allowance is full again (`sim/pipeline.ts`). */
export function refillPathWork(): void { workLeft = PATH_WORK_PER_TICK; }
/** Whether route searching this tick has work left for a route that can wait. */
export function pathWorkLeft(): boolean { return workLeft > 0; }

/** Shortest route between two points of the mesh, or null when none joins them. */
export function findPath(mesh: NavMesh, sx: number, sy: number, st: number, gx: number, gy: number, gt: number,
  cost: NavCost = () => 0, maxNodes = 20000): NavPath | null {
  if (st < 0 || gt < 0) return null;
  if (st === gt) return { tris: [st], portals: [], corners: [{ x: gx, y: gy, tri: 0 }] };
  // Ground with no way between: known at once (`NavMesh.piece`).
  if (mesh.piece[st] !== mesh.piece[gt]) return null;
  // A* over triangles; a triangle's position is the point it was entered at:
  // the point of the portal nearest where the walk came from, which keeps
  // costs close to walked distance. (The portal's middle, used before, lay
  // metres off any walked line on the long slivers of a kerb stone: from two
  // neighbouring slivers the "shortest" routes ran opposite ways round, and
  // a body between them turned to and fro.)
  //
  // The search's memory is the mesh's own, kept between searches and cleared
  // by a new stamp, as Detour's node pool is (`dtNodePool::clear`): four maps
  // and an object per triangle visited, made afresh for every route, were
  // garbage the browser stopped the game to collect.
  const pool = poolOf(mesh);
  const stamp = ++pool.stamp;
  const { g, px, py, cameFrom, camePortal, seen, closed, open } = pool;
  open.clear();
  seen[st] = stamp;
  g[st] = 0;
  px[st] = sx;
  py[st] = sy;
  open.push(st, hypot2(gx - sx, gy - sy));
  let found = false;
  let expanded = 0;
  while (open.size) {
    const t = open.pop();
    if (t === gt) { found = true; break; }
    if (closed[t] === stamp) continue;
    closed[t] = stamp;
    if (++expanded > maxNodes) break;
    const tx = px[t]!, ty = py[t]!, tg = g[t]!;
    const out = mesh.portals[t]!;
    for (let k = 0; k < out.length; k++) {
      const portal = out[k]!;
      const u = portal.to;
      if (closed[u] === stamp) continue;
      let mx = gx, my = gy;
      if (u !== gt) {
        const near = closestOnSegment(portal.lx, portal.ly, portal.rx, portal.ry, tx, ty);
        mx = near.x; my = near.y;
      }
      const step = hypot2(mx - tx, my - ty);
      const ng = tg + step + cost(t, u, step);
      if (seen[u] !== stamp || ng < g[u]!) {
        seen[u] = stamp;
        g[u] = ng;
        px[u] = mx;
        py[u] = my;
        cameFrom[u] = t;
        camePortal[u] = k;
        open.push(u, ng + hypot2(gx - mx, gy - my));
      }
    }
  }
  spent(expanded);
  if (!found) return null;
  const tris: number[] = [gt];
  const portals: NavPortal[] = [];
  for (let t = gt; t !== st;) {
    const from = cameFrom[t]!;
    portals.push(mesh.portals[from]![camePortal[t]!]!);
    tris.push(from);
    t = from;
  }
  tris.reverse();
  portals.reverse();
  return { tris, portals, corners: funnel(sx, sy, gx, gy, portals) };
}

/**
 * Two points the funnel treats as one. A walker pressed against a corner of
 * the mesh stands a hair from its vertex; compared exactly, every portal
 * round that vertex looked like a turn of almost nothing either way, and the
 * string was pulled straight through the obstacle behind it.
 */
const same = (ax: number, ay: number, bx: number, by: number): boolean => (ax - bx) ** 2 + (ay - by) ** 2 < 0.05 ** 2;

/** How far a corner is taken in from the wall it rounds, u. */
const CORNER_PULL = 0.08;

const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
  (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);

/**
 * The simple stupid funnel algorithm (Mononen): the taut string from start to
 * goal through the portals. Each corner records the portal index it was
 * pulled round, so the walker knows which triangle it leads into.
 */
/** Scratch for `inward`: the corner pulled a little way in off its portal. */
let inwardX = 0;
let inwardY = 0;
/**
 * A corner is a portal's end, which is a corner of a wall: walking to it
 * exactly is walking into the wall. It is taken a little way in along its
 * portal, into open ground ("corner offset"), so the body rounds it clear.
 *
 * Writes `inwardX`/`inwardY` instead of returning an object, and lives at
 * module scope instead of being a closure rebuilt per call: every walker pulls
 * its string every tick.
 */
function inward(all: readonly NavPortal[], start: number, x: number, y: number, i: number, fromRight: boolean): void {
  const p = all[start + i];
  if (!p) { inwardX = x; inwardY = y; return; }
  const ox = fromRight ? p.lx : p.rx, oy = fromRight ? p.ly : p.ry;
  const len = hypot2(ox - x, oy - y);
  if (len < 1e-9) { inwardX = x; inwardY = y; return; }
  const pull = Math.min(CORNER_PULL, len / 2) / len;
  inwardX = x + (ox - x) * pull;
  inwardY = y + (oy - y) * pull;
}

export function funnel(sx: number, sy: number, gx: number, gy: number, all: readonly NavPortal[],
  start = 0, max = Infinity): { x: number; y: number; tri: number }[] {
  const out: { x: number; y: number; tri: number }[] = [];
  // The portals from `start` on; corners report indices into `all`.
  const n = all.length - start;
  // Portal i as (left, right); the goal as a degenerate last portal. Read in
  // place: every walker pulls its string every tick, and a pair of fresh
  // arrays per portal was most of the funnel's time.
  let ax = sx, ay = sy;
  let lx = gx, ly = gy, rx = gx, ry = gy;
  if (n > 0) { const p0 = all[start]!; lx = p0.lx; ly = p0.ly; rx = p0.rx; ry = p0.ry; }
  let li = 0, ri = 0;
  for (let i = 1; i <= n; i++) {
    let nlx = gx, nly = gy, nrx = gx, nry = gy;
    if (i < n) { const q = all[start + i]!; nlx = q.lx; nly = q.ly; nrx = q.rx; nry = q.ry; }
    // Tighten the right side.
    if (cross(ax, ay, rx, ry, nrx, nry) >= 0) {
      if (same(ax, ay, rx, ry) || cross(ax, ay, lx, ly, nrx, nry) < 0) {
        rx = nrx; ry = nry; ri = i;
      } else {
        // Right crossed over left: the left point is a corner.
        inward(all, start, lx, ly, li, false);
        out.push({ x: inwardX, y: inwardY, tri: start + li + 1 });
        if (out.length >= max) return out;
        ax = lx; ay = ly;
        const restart = li;
        const k = restart + 1 <= n ? restart + 1 : n;
        if (k < n) { const q = all[start + k]!; lx = q.lx; ly = q.ly; rx = q.rx; ry = q.ry; } else { lx = rx = gx; ly = ry = gy; }
        li = ri = restart + 1;
        i = restart + 1;
        continue;
      }
    }
    // Tighten the left side.
    if (cross(ax, ay, lx, ly, nlx, nly) <= 0) {
      if (same(ax, ay, lx, ly) || cross(ax, ay, rx, ry, nlx, nly) > 0) {
        lx = nlx; ly = nly; li = i;
      } else {
        inward(all, start, rx, ry, ri, true);
        out.push({ x: inwardX, y: inwardY, tri: start + ri + 1 });
        if (out.length >= max) return out;
        ax = rx; ay = ry;
        const restart = ri;
        const k = restart + 1 <= n ? restart + 1 : n;
        if (k < n) { const q = all[start + k]!; lx = q.lx; ly = q.ly; rx = q.rx; ry = q.ry; } else { lx = rx = gx; ly = ry = gy; }
        li = ri = restart + 1;
        i = restart + 1;
        continue;
      }
    }
  }
  out.push({ x: gx, y: gy, tri: start + n });
  // Drop corners that coincide, compacting in place: `filter` built a second
  // array every call for a list that is walked once.
  let w = 0;
  let prevX = 0, prevY = 0;
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    const keep = i === 0 || hypot2(c.x - prevX, c.y - prevY) > 1e-6;
    prevX = c.x; prevY = c.y;
    if (keep) out[w++] = c;
  }
  out.length = w;
  return out;
}

/** A binary min-heap of (item, priority), ties broken by insertion order. */
class Heap {
  private items: number[] = [];
  private keys: number[] = [];
  private order: number[] = [];
  private seq = 0;
  get size(): number { return this.items.length; }
  clear(): void { this.items.length = 0; this.keys.length = 0; this.order.length = 0; this.seq = 0; }
  push(item: number, key: number): void {
    this.items.push(item); this.keys.push(key); this.order.push(this.seq++);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): number {
    const top = this.items[0]!;
    const last = this.items.length - 1;
    this.swap(0, last);
    this.items.pop(); this.keys.pop(); this.order.pop();
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < this.items.length && this.less(l, m)) m = l;
      if (r < this.items.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m); i = m;
    }
    return top;
  }
  private less(a: number, b: number): boolean {
    return this.keys[a]! < this.keys[b]! || (this.keys[a] === this.keys[b] && this.order[a]! < this.order[b]!);
  }
  // Swapped through locals: a destructuring swap made two arrays a swap.
  private swap(a: number, b: number): void {
    const item = this.items[a]!; this.items[a] = this.items[b]!; this.items[b] = item;
    const key = this.keys[a]!; this.keys[a] = this.keys[b]!; this.keys[b] = key;
    const order = this.order[a]!; this.order[a] = this.order[b]!; this.order[b] = order;
  }
}
