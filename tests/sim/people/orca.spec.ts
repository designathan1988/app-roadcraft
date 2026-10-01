import { describe, expect, it } from 'vitest';
import { keepRight, orcaLine, solveOrca, type OrcaBody, type OrcaLine } from '@sim/people/orca';

const DT = 1 / 60;
const R = 0.27;

/** Bodies walking to goals with ORCA alone, in metres; returns closest approach and who arrived. */
function run(starts: [number, number][], goals: [number, number][], seconds: number) {
  const bodies: OrcaBody[] = starts.map(([x, y]) => ({ x, y, vx: 0, vy: 0, radius: R }));
  let closest = Infinity;
  for (let t = 0; t < seconds / DT; t++) {
    const next = bodies.map((a, i) => {
      const lines: OrcaLine[] = [];
      bodies.forEach((b, j) => { if (j !== i && Math.hypot(b.x - a.x, b.y - a.y) < 3) lines.push(orcaLine(a, b, 1.5, DT, 0.5, { px: 0, py: 0, dx: 0, dy: 0 })); });
      const [gx, gy] = goals[i]!;
      const d = Math.hypot(gx - a.x, gy - a.y);
      const sp = Math.min(1.3, d * 2);
      const [px, py] = keepRight(d > 1e-6 ? (gx - a.x) / d * sp : 0, d > 1e-6 ? (gy - a.y) / d * sp : 0, lines.length > 0);
      return solveOrca(lines, px, py, 1.5, { x: 0, y: 0 });
    });
    bodies.forEach((a, i) => { a.vx = next[i]!.x; a.vy = next[i]!.y; a.x += a.vx * DT; a.y += a.vy * DT; });
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      closest = Math.min(closest, Math.hypot(bodies[i]!.x - bodies[j]!.x, bodies[i]!.y - bodies[j]!.y));
    }
  }
  const arrived = bodies.filter((b, i) => Math.hypot(goals[i]![0] - b.x, goals[i]![1] - b.y) < 0.2).length;
  return { closest, arrived };
}

describe('ORCA', () => {
  it('takes two people walking straight at each other past each other', () => {
    const r = run([[-5, 0], [5, 0]], [[5, 0], [-5, 0]], 15);
    expect(r.arrived).toBe(2);
    expect(r.closest).toBeGreaterThan(2 * R - 0.02);
  });

  it('gets twelve people across a circle to the far side, none locked, none through another', () => {
    const n = 12;
    const at = Array.from({ length: n }, (_, i) => [Math.cos(i / n * 2 * Math.PI) * 4, Math.sin(i / n * 2 * Math.PI) * 4] as [number, number]);
    const r = run(at, at.map(([x, y]) => [-x, -y] as [number, number]), 40);
    expect(r.arrived).toBe(n);
    expect(r.closest).toBeGreaterThan(2 * R - 0.05);
  });

  it('always gives a velocity, even boxed in on every side', () => {
    const a: OrcaBody = { x: 0, y: 0, vx: 0, vy: 0, radius: R };
    const lines = [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]].map(([x, y]) =>
      orcaLine(a, { x: x!, y: y!, vx: 0, vy: 0, radius: R }, 1.5, DT, 0.5, { px: 0, py: 0, dx: 0, dy: 0 }));
    const v = solveOrca(lines, 1, 0, 1.5, { x: 0, y: 0 });
    expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true);
    expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(1.5 + 1e-6);
  });
});
