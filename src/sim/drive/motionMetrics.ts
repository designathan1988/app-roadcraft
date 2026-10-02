import { vehiclePose } from '../pose';
import type { SimWorld } from '../world';
import { m } from '@world/units';

/** Opt-in measurement of the published vehicle poses; never writes simulation state. */
export class VehicleMotionMetrics {
  private last = new Map<number, { x: number; y: number; angle: number; v: number; a: number | null; moving: boolean }>();
  private jerks = new Map<number, number>();
  private hot = new Map<string, number>();
  samples = 0;
  movingSamples = 0;
  emergencyExceeded = 0;
  instantStops = 0;
  positionJumps = 0;
  headingJumps = 0;
  stopGo = 0;
  maxJerk = 0;
  private events: { id: number; age: number; x: number; y: number; before: number; after: number; acceleration: number; obstacles: unknown }[] = [];

  sample(w: SimWorld, dt: number): void {
    const alive = new Set<number>();
    for (const v of w.vehicles.values()) {
      const pose = vehiclePose(w, v, 1);
      if (!pose) continue;
      alive.add(v.id);
      const old = this.last.get(v.id);
      const moving = v.v > m(0.1);
      let a: number | null = null;
      if (old) {
        this.samples++;
        a = (v.v - old.v) / dt;
        let defect = false;
        if (moving || old.moving) {
          this.movingSamples++;
          if (old.a !== null) {
            const jerk = Math.abs(a - old.a) / dt / m(1);
            const bin = Math.ceil(jerk * 10) / 10;
            this.jerks.set(bin, (this.jerks.get(bin) ?? 0) + 1);
            this.maxJerk = Math.max(this.maxJerk, jerk);
          }
        }
        if (-a > v.driver.bEmergency + 1e-5) { this.emergencyExceeded++; defect = true; }
        if (old.v > m(0.1) && v.v === 0) { this.instantStops++; defect = true; }
        // Residual beyond the distance the integrated speed can account for.
        const travelled = Math.hypot(pose.p.x - old.x, pose.p.y - old.y);
        if (travelled > Math.max(v.v, old.v) * dt + m(0.25)) { this.positionJumps++; defect = true; }
        const turn = Math.abs(Math.atan2(Math.sin(pose.angle - old.angle), Math.cos(pose.angle - old.angle)));
        if (turn > 0.2) { this.headingJumps++; defect = true; }
        if (old.moving && !moving) this.stopGo++;
        if (defect) {
          if (this.events.length < 16) this.events.push({ id: v.id, age: v.age, x: pose.p.x, y: pose.p.y,
            before: old.v / m(1), after: v.v / m(1), acceleration: a / m(1),
            obstacles: v.constraints.obstacles.map(o => ({ kind: o.kind, gap: o.gap / m(1), speed: o.speed / m(1) })) });
          const key = `${Math.round(pose.p.x / 25) * 25},${Math.round(pose.p.y / 25) * 25}`;
          this.hot.set(key, (this.hot.get(key) ?? 0) + 1);
        }
      }
      this.last.set(v.id, { x: pose.p.x, y: pose.p.y, angle: pose.angle, v: v.v, a, moving });
    }
    for (const id of this.last.keys()) if (!alive.has(id)) this.last.delete(id);
  }

  result() {
    const bins = [...this.jerks].sort((a, b) => a[0] - b[0]);
    const count = bins.reduce((n, [, c]) => n + c, 0);
    let seen = 0, jerkP95 = 0;
    for (const [j, n] of bins) { seen += n; if (seen >= count * 0.95) { jerkP95 = j; break; } }
    return { samples: this.samples, movingSamples: this.movingSamples, jerkP95, maxJerk: this.maxJerk,
      emergencyExceeded: this.emergencyExceeded, instantStops: this.instantStops,
      positionJumps: this.positionJumps, headingJumps: this.headingJumps, stopGo: this.stopGo,
      hotspots: [...this.hot].sort((a, b) => b[1] - a[1]).slice(0, 8), events: this.events };
  }
}
