import type { CrowdAgent } from '@recast-navigation/core';
import { Matrix4, type Object3D, Vector3 } from 'three';

import { CARRY_AT, GAIT_AT } from '@render/citizenBake';
import type { Body, Layer } from './body';
import type { Nav } from './nav';

/**
 * An agent the player commands, as in The Sims: a queue of interactions,
 * each a list of steps (go there, face that way, play this, do that), run in
 * order, any of them cancelled from the queue. Where to walk comes from
 * Detour (`nav.ts`); the body plays the game's captures (`body.ts`).
 */
export type Step =
  /** Walk to a point; `exact` slides the last centimetres onto it (a seat's spot). */
  | { readonly kind: 'goto'; readonly to: Vector3; readonly exact?: boolean; readonly near?: number }
  /** Turn on the spot to a heading (radians, 0 = +Z), or towards a point. */
  | { readonly kind: 'face'; readonly heading?: number; readonly towards?: () => Vector3 }
  /**
   * Play a clip: once, for `seconds`, or until something else is queued
   * (`hold`). Waits for the clip to be baked first.
   */
  | { readonly kind: 'play'; readonly clip: number; readonly seconds?: number; readonly hold?: boolean; readonly speed?: number }
  /** Something that happens at once (pick the box up, put it down). */
  | { readonly kind: 'do'; readonly run: (agent: Agent) => void }
  /** Wait until `until` says so (a partner arriving). */
  | { readonly kind: 'wait'; readonly until: () => boolean; readonly seconds?: number };

export interface Interaction {
  readonly label: string;
  readonly steps: Step[];
  /** Undoes what is half done (a seat freed, a partner told). */
  readonly cancel?: (agent: Agent) => void;
}

interface Running {
  readonly interaction: Interaction;
  step: number;
  /** Seconds into the step. */
  t: number;
  /** The step has been set going (a move target requested, a clip asked for). */
  started: boolean;
}

const TURN_RATE = 5; // rad/s
const FADE = 0.25; // s
const WALK_FULL = 0.9; // m/s at which the walk is fully blended in
const ARRIVED = 0.12; // m

export class Agent {
  readonly body: Body;
  readonly crowd: CrowdAgent;
  readonly position = new Vector3();
  heading = 0;
  readonly queue: Interaction[] = [];
  private running: Running | null = null;
  /** What the agent holds, drawn between its hands. */
  carrying: Object3D | null = null;
  /** The clip being played by a step, and how much of the body it has. */
  private action: { clip: number; frame: number; speed: number; loop: boolean } | null = null;
  private actionWeight = 0;
  private walkPhase = 0;
  private walkWeight = 0;
  private sliding: Vector3 | null = null;
  private readonly nav: Nav;
  onChange: () => void = () => {};

  constructor(body: Body, nav: Nav, at: Vector3, heading = 0) {
    this.body = body;
    this.nav = nav;
    this.position.copy(at);
    this.heading = heading;
    this.crowd = nav.addAgent(at);
  }

  get name(): string { return this.body.name; }

  /** Adds an interaction at the end of the queue (or replaces the queue, `now`). */
  push(interaction: Interaction, now = false): void {
    if (now) this.clear();
    this.queue.push(interaction);
    this.onChange();
  }

  /** Cancels the interaction at `index` (0 is the one being done). */
  cancel(index: number): void {
    const item = this.queue[index];
    if (!item) return;
    if (index === 0 && this.running?.interaction === item) {
      item.cancel?.(this);
      this.stopStep();
      this.running = null;
    }
    this.queue.splice(index, 1);
    this.onChange();
  }

  clear(): void {
    for (let i = this.queue.length - 1; i >= 0; i--) this.cancel(i);
  }

  get busy(): boolean { return this.queue.length > 0; }

  private stopStep(): void {
    this.crowd.resetMoveTarget();
    this.sliding = null;
    this.action = null;
  }

  update(dt: number): void {
    // ---- the queue
    if (!this.running && this.queue[0]) this.running = { interaction: this.queue[0], step: 0, t: 0, started: false };
    const run = this.running;
    if (run) {
      const step = run.interaction.steps[run.step];
      if (!step) {
        this.queue.shift();
        this.running = null;
        this.onChange();
      } else if (this.advance(step, run, dt)) {
        run.step++;
        run.t = 0;
        run.started = false;
      } else run.t += dt;
    }

    // ---- where the body is: the crowd's agent, or sliding onto a spot
    if (this.sliding) {
      const to = this.sliding;
      const d = to.distanceTo(this.position);
      const stepLen = Math.min(d, 0.9 * dt);
      if (d > 1e-4) this.position.addScaledVector(to.clone().sub(this.position).normalize(), stepLen);
      this.crowd.teleport({ x: this.position.x, y: this.position.y, z: this.position.z });
    } else {
      const p = this.crowd.position();
      this.position.set(p.x, p.y, p.z);
    }
    const vel = this.crowd.velocity();
    const speed = this.sliding ? 0.4 : Math.hypot(vel.x, vel.z);
    if (!this.sliding && speed > 0.15) this.turnTo(Math.atan2(vel.x, vel.z), dt);

    // ---- the body's pose: a step's clip over the walk and the stand
    const playing = this.action !== null;
    this.actionWeight = approach(this.actionWeight, playing ? 1 : 0, dt / FADE);
    const walkTarget = Math.min(1, speed / WALK_FULL);
    this.walkWeight = approach(this.walkWeight, walkTarget, dt / FADE);
    const carrying = this.carrying !== null;
    const walkAt = carrying && this.body.ready(CARRY_AT.walk!) ? CARRY_AT.walk! : GAIT_AT.walk;
    const idleAt = carrying && this.body.ready(CARRY_AT.idle!) ? CARRY_AT.idle! : GAIT_AT.idle;
    if (carrying) { void this.body.want(CARRY_AT.walk!); void this.body.want(CARRY_AT.idle!); }
    const walk = this.body.clips[walkAt]!;
    const idle = this.body.clips[idleAt]!;
    this.walkPhase = (this.walkPhase + (speed * dt) / Math.max(0.2, walk.stride)) % 1;
    this.idleTime += dt;
    const layers: Layer[] = [];
    const base = 1 - this.actionWeight;
    layers.push({ at: walkAt, frame: this.walkPhase * walk.frames, weight: base * this.walkWeight });
    layers.push({ at: idleAt, frame: ((this.idleTime / idle.duration) % 1) * idle.frames, weight: base * (1 - this.walkWeight) });
    if (this.action) {
      const clip = this.body.clips[this.action.clip]!;
      this.action.frame += (dt / clip.duration) * clip.frames * this.action.speed;
      if (this.action.loop) this.action.frame %= clip.frames;
      else this.action.frame = Math.min(this.action.frame, clip.frames);
      layers.push({ at: this.action.clip, frame: this.action.frame, weight: this.actionWeight });
    } else if (this.lastAction && this.actionWeight > 0) {
      layers.push({ at: this.lastAction.clip, frame: this.lastAction.frame, weight: this.actionWeight });
    }
    this.body.pose(layers);

    // ---- placed in the world
    this.body.root.position.copy(this.position);
    this.body.root.rotation.set(0, this.heading, 0);
    this.body.root.updateMatrixWorld(true);
    if (this.carrying) this.placeCarried();
  }

  private idleTime = Math.random() * 10;
  private lastAction: { clip: number; frame: number } | null = null;

  /** One step's progress; true when it is done. */
  private advance(step: Step, run: Running, dt: number): boolean {
    switch (step.kind) {
      case 'goto': {
        const target = this.nav.closest(step.to) ?? step.to;
        const near = step.near ?? ARRIVED;
        if (!run.started) {
          run.started = true;
          this.action = null;
          this.crowd.requestMoveTarget({ x: target.x, y: target.y, z: target.z });
        }
        const d = Math.hypot(target.x - this.position.x, target.z - this.position.z);
        if (step.exact && d < 0.45) {
          this.crowd.resetMoveTarget();
          this.sliding = step.to.clone();
          if (step.to.distanceTo(this.position) < 0.02) { this.sliding = null; return true; }
          return false;
        }
        const v = this.crowd.velocity();
        if (d < Math.max(near, ARRIVED) || (d < near + 0.35 && Math.hypot(v.x, v.z) < 0.05 && run.t > 0.5)) {
          this.crowd.resetMoveTarget();
          return true;
        }
        // Stuck behind something for long: give up on this step.
        return run.t > 40;
      }
      case 'face': {
        const goal = step.towards
          ? (() => { const p = step.towards!(); return Math.atan2(p.x - this.position.x, p.z - this.position.z); })()
          : step.heading ?? this.heading;
        this.turnTo(goal, dt);
        return Math.abs(wrap(goal - this.heading)) < 0.05;
      }
      case 'play': {
        if (!run.started) {
          if (!this.body.ready(step.clip)) { void this.body.want(step.clip); return false; }
          run.started = true;
          this.action = { clip: step.clip, frame: 0, speed: step.speed ?? 1, loop: !!(step.hold || step.seconds) };
        }
        const clip = this.body.clips[step.clip]!;
        const length = clip.duration / (step.speed ?? 1);
        let done: boolean;
        if (step.hold) done = this.queue.length > 1 && run.t > 0.5;
        else if (step.seconds !== undefined) done = run.t >= step.seconds;
        else done = run.t >= length - FADE * 0.5;
        if (done && this.action) {
          this.lastAction = { clip: this.action.clip, frame: this.action.frame };
          // The next step is another clip: no fade back to standing between them.
          const next = run.interaction.steps[run.step + 1];
          if (!next || next.kind !== 'play') this.action = null;
        }
        return done;
      }
      case 'do':
        step.run(this);
        return true;
      case 'wait':
        return step.until() || (step.seconds !== undefined && run.t >= step.seconds);
    }
  }

  private turnTo(goal: number, dt: number): void {
    const diff = wrap(goal - this.heading);
    const stepTurn = Math.sign(diff) * Math.min(Math.abs(diff), TURN_RATE * dt);
    this.heading = wrap(this.heading + stepTurn);
  }

  /** The held thing between the two hands, in the world. */
  private placeCarried(): void {
    const r = this.body.boneAt('Bip01_R_Hand', new Vector3());
    const l = this.body.boneAt('Bip01_L_Hand', new Vector3());
    const mid = r.add(l).multiplyScalar(0.5);
    // The baked bones are in the rig's own frame: the root places it in the world.
    mid.applyMatrix4(this.body.root.matrixWorld);
    const thing = this.carrying!;
    thing.position.copy(mid);
    thing.position.y -= 0.02;
    thing.rotation.set(0, this.heading, 0);
  }

  /** The world matrix of the body, for picking and labels. */
  get matrix(): Matrix4 { return this.body.root.matrixWorld; }
}

function approach(value: number, target: number, rate: number): number {
  return value < target ? Math.min(target, value + rate) : Math.max(target, value - rate);
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
