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
  const g = new Map<number, number>();
  const px = new Map<number, number>();
  const py = new Map<number, number>();
  const came = new Map<number, { from: number; portal: NavPortal }>();
  const open = new Heap();
  g.set(st, 0);
  px.set(st, sx);
  py.set(st, sy);
  open.push(st, Math.hypot(gx - sx, gy - sy));
  const closed = new Set<number>();
  let found = false;
  let expanded = 0;
  while (open.size) {
    const t = open.pop();
    if (t === gt) { found = true; break; }
    if (closed.has(t)) continue;
    closed.add(t);
    if (++expanded > maxNodes) break;
    const tx = px.get(t)!, ty = py.get(t)!, tg = g.get(t)!;
    for (const portal of mesh.portals[t]!) {
      const u = portal.to;
      if (closed.has(u)) continue;
      const near = u === gt ? null : closestOnSegment(portal.lx, portal.ly, portal.rx, portal.ry, tx, ty);
      const mx = near ? near.x : gx;
      const my = near ? near.y : gy;
      const step = Math.hypot(mx - tx, my - ty);
      const ng = tg + step + cost(t, u, step);
      if (ng < (g.get(u) ?? Infinity)) {
        g.set(u, ng);
        px.set(u, mx);
        py.set(u, my);
        came.set(u, { from: t, portal });
        open.push(u, ng + Math.hypot(gx - mx, gy - my));
      }
    }
  }
  if (!found) return null;
  const tris: number[] = [gt];
  const portals: NavPortal[] = [];
  for (let t = gt; t !== st;) {
    const step = came.get(t)!;
    portals.push(step.portal);
    tris.push(step.from);
    t = step.from;
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
export function funnel(sx: number, sy: number, gx: number, gy: number, all: readonly NavPortal[],
  start = 0, max = Infinity): { x: number; y: number; tri: number }[] {
  const out: { x: number; y: number; tri: number }[] = [];
  // The portals from `start` on; corners report indices into `all`.
  const n = all.length - start;
  // A corner is a portal's end, which is a corner of a wall: walking to it
  // exactly is walking into the wall. It is taken a little way in along its
  // portal, into open ground ("corner offset"), so the body rounds it clear.
  const inward = (x: number, y: number, i: number, fromRight: boolean): { x: number; y: number } => {
    const p = all[start + i];
    if (!p) return { x, y };
    const ox = fromRight ? p.lx : p.rx, oy = fromRight ? p.ly : p.ry;
    const len = Math.hypot(ox - x, oy - y);
    if (len < 1e-9) return { x, y };
    const pull = Math.min(CORNER_PULL, len / 2) / len;
    return { x: x + (ox - x) * pull, y: y + (oy - y) * pull };
  };
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
        out.push({ ...inward(lx, ly, li, false), tri: start + li + 1 });
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
        out.push({ ...inward(rx, ry, ri, true), tri: start + ri + 1 });
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
  // Drop corners that coincide.
  return out.filter((c, i) => i === 0 || Math.hypot(c.x - out[i - 1]!.x, c.y - out[i - 1]!.y) > 1e-6);
}

/** A binary min-heap of (item, priority), ties broken by insertion order. */
class Heap {
  private items: number[] = [];
  private keys: number[] = [];
  private order: number[] = [];
  private seq = 0;
  get size(): number { return this.items.length; }
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
  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b]!, this.items[a]!];
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
    [this.order[a], this.order[b]] = [this.order[b]!, this.order[a]!];
  }
}
