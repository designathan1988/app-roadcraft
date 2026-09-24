/**
 * Graphics quality tiers.
 *
 * Every expensive feature is named here once, so a tier is a table entry rather
 * than a set of conditionals scattered across the renderer. `auto` starts at
 * `high` and steps down when the measured frame time says the machine cannot
 * hold it — the balance the brief asks for: quality that never costs the frame
 * rate on the machine actually running it.
 */

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  /** Cap on the device pixel ratio the canvas is rendered at. */
  readonly pixelRatio: number;
  readonly shadows: boolean;
  readonly shadowMapSize: number;
  readonly postProcessing: boolean;
  readonly ambientOcclusion: boolean;
  readonly smaa: boolean;
  /** Maximum anisotropic filtering taps requested for ground textures. */
  readonly anisotropy: number;
  /** Draw street furniture, kerb detail, parapets and roadside props. */
  readonly detailProps: boolean;
  /** Scatter vegetation over the terrain. */
  readonly vegetation: number;
  /** Grass clumps (tufts and wildflowers), drawn at close zoom only. */
  readonly grass: number;
  /** The close-zoom texture detail layer (`mesh/detailLayer.ts`). */
  readonly surfaceDetail: boolean;
  /** Zoom below which markings, props and agents stop being drawn. */
  readonly detailCutoffZoom: number;
  /** Crowd detail ceiling: silhouette, wardrobe, or full facial animation. */
  readonly pedestrianDetail: 0 | 1 | 2;
  /**
   * Zoom from which the people inside vehicles are drawn. Below it a seated
   * torso is under two or three pixels behind tinted glass; above twice it
   * every seat is drawn, between the two only the front row.
   */
  readonly occupantZoom: number;
}

export const QUALITY: Readonly<Record<QualityLevel, QualitySettings>> = {
  low: {
    pixelRatio: 1,
    shadows: false,
    shadowMapSize: 1024,
    postProcessing: false,
    ambientOcclusion: false,
    smaa: false,
    anisotropy: 2,
    detailProps: false,
    vegetation: 0,
    grass: 0,
    surfaceDetail: false,
    detailCutoffZoom: 0.5,
    pedestrianDetail: 0,
    occupantZoom: 3,
  },
  medium: {
    pixelRatio: 1.25,
    shadows: true,
    shadowMapSize: 1024,
    postProcessing: false,
    ambientOcclusion: false,
    smaa: false,
    anisotropy: 4,
    detailProps: true,
    vegetation: 600,
    grass: 600,
    surfaceDetail: true,
    detailCutoffZoom: 0.34,
    pedestrianDetail: 1,
    occupantZoom: 2.2,
  },
  high: {
    pixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 2048,
    postProcessing: true,
    ambientOcclusion: true,
    smaa: true,
    anisotropy: 8,
    detailProps: true,
    vegetation: 1_400,
    grass: 1_400,
    surfaceDetail: true,
    detailCutoffZoom: 0.26,
    pedestrianDetail: 2,
    occupantZoom: 1.6,
  },
  ultra: {
    pixelRatio: 2,
    shadows: true,
    shadowMapSize: 4096,
    postProcessing: true,
    ambientOcclusion: true,
    smaa: true,
    anisotropy: 16,
    detailProps: true,
    vegetation: 2_600,
    grass: 2_600,
    surfaceDetail: true,
    detailCutoffZoom: 0.2,
    pedestrianDetail: 2,
    occupantZoom: 1.3,
  },
};

export const QUALITY_LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

export const isQualityLevel = (value: unknown): value is QualityLevel =>
  value === 'low' || value === 'medium' || value === 'high' || value === 'ultra';

/**
 * Watches frame time and reports when the tier should change.
 *
 * Hysteresis on both sides, and a cooldown after every change, because a tier
 * switch itself costs a frame: without them the monitor oscillates between two
 * tiers for ever, which is far worse than sitting on the slower one.
 *
 * DOWN on frame time: a median frame slower than 34 fps. UP on the frame's own
 * CPU cost: under vsync a frame never measures faster than the display, so the
 * old test - a median frame under 9 ms - could never pass on a 60 Hz screen,
 * and one slow stretch (assets arriving, a big edit) left the game on the low
 * tier, grass and shadows gone, for the rest of the session. It climbs back
 * now when frames keep up with the display and the work in them is small, no
 * higher than the tier it started on, and it stops climbing for a while if a
 * climb was undone at once.
 */
export class QualityGovernor {
  private samples: number[] = [];
  private costs: number[] = [];
  private cooldown = 0;
  private clock = 0;
  private lastRaise = -Infinity;
  private holdRaise = 0;
  private readonly ceiling: number;

  constructor(private level: QualityLevel, ceiling: QualityLevel = level) {
    this.ceiling = QUALITY_LEVELS.indexOf(ceiling);
  }

  get current(): QualityLevel {
    return this.level;
  }

  set(level: QualityLevel): void {
    this.level = level;
    this.samples.length = 0;
    this.costs.length = 0;
    this.cooldown = 2.5;
  }

  /**
   * Returns the tier to switch to, or null to stay put. `costMs` is the CPU
   * time the frame's own work took; without it the tier only ever goes down.
   */
  sample(deltaSeconds: number, costMs = Infinity): QualityLevel | null {
    this.clock += deltaSeconds;
    if (this.holdRaise > 0) this.holdRaise -= deltaSeconds;
    if (this.cooldown > 0) {
      this.cooldown -= deltaSeconds;
      return null;
    }
    // A stall from a road rebuild is not a frame rate; it is one bad frame.
    if (deltaSeconds > 0.4) return null;
    this.samples.push(deltaSeconds);
    this.costs.push(costMs);
    if (this.samples.length < 60) return null;
    const median = middle(this.samples);
    const cost = middle(this.costs);
    this.samples.length = 0;
    this.costs.length = 0;
    const index = QUALITY_LEVELS.indexOf(this.level);
    if (median > 1 / 34 && index > 0) {
      // Undone within twenty seconds: this machine cannot hold that tier.
      if (this.clock - this.lastRaise < 20) this.holdRaise = 90;
      return QUALITY_LEVELS[index - 1] as QualityLevel;
    }
    if (index < this.ceiling && this.holdRaise <= 0 && median < 1 / 50 && cost < 7) {
      this.lastRaise = this.clock;
      return QUALITY_LEVELS[index + 1] as QualityLevel;
    }
    return null;
  }
}

function middle(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
}
