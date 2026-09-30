import { clamp } from '@core/scalar';
import { DT, MAX_FRAME, MAX_SUBSTEPS } from './params';

/**
 * Fixed-timestep clock with an accumulator.
 *
 * The V6 monolith advanced the simulation by `min(0.04, elapsed)` with no
 * accumulator, so a 200 ms frame advanced it only 40 ms. Because its signal
 * phase was derived from that same clock, traffic lights literally ran slower
 * when the map got busy (defect 5.2).
 *
 * Two rules follow from the design and both matter:
 *
 *   - `speed` multiplies the rate at which wall time is fed into the
 *     accumulator, never `DT`. Changing simulation speed therefore cannot
 *     change physics.
 *   - Time is `tick * DT`, an exact integer multiple. Nothing accumulates
 *     floating-point drift, and while paused the tick does not advance at all,
 *     so nothing can expire or be renewed during a pause. That was the third
 *     limb of the stale-reservation defect (2.7).
 */
export class SimClock {
  /**
   * Written ONLY at the end of `pipeline.step`, so a step driven directly (as
   * every spec does) advances time exactly as the game's `advance` does. It
   * used to move here, in `advance` and `run`, and every behaviour keyed on
   * the clock - signal starvation, admission FIFO, the stall watchdogs -
   * silently never happened in the suite.
   */
  tick = 0;
  paused = false;
  speed = 1;

  private acc = 0;

  get time(): number {
    return this.tick * DT;
  }

  /**
   * Advances by wall-clock seconds, calling `step` once per fixed interval.
   * Returns the interpolation alpha in [0, 1) for rendering.
   */
  advance(wallDelta: number, step: () => void): number {
    if (this.paused) return 1;

    // Clamped at both ends. A long stall must not flood the accumulator, and a
    // clock that jumps BACKWARDS — a resumed tab, a rAF timestamp from a
    // different origin — must not drive the accumulator negative and silently
    // stop the simulation.
    this.acc += clamp(wallDelta, 0, MAX_FRAME) * this.speed;

    let n = 0;
    while (this.acc >= DT && n < MAX_SUBSTEPS) {
      step();
      this.acc -= DT;
      n++;
    }

    // Shed the debt rather than carrying it: catching up over later frames only
    // makes the stall worse.
    if (n === MAX_SUBSTEPS) this.acc = 0;

    return this.acc / DT;
  }

  /** Runs exactly `n` steps, for tests and scenarios. */
  run(n: number, step: () => void): void {
    for (let i = 0; i < n; i++) step();
  }

  /** Seconds elapsed since a recorded tick. */
  since(tick: number): number {
    return (this.tick - tick) * DT;
  }
}
