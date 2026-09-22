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
  /** Zoom below which markings, props and agents stop being drawn. */
  readonly detailCutoffZoom: number;
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
    detailCutoffZoom: 0.5,
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
    detailCutoffZoom: 0.34,
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
    detailCutoffZoom: 0.26,
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
    detailCutoffZoom: 0.2,
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
 */
export class QualityGovernor {
  private samples: number[] = [];
  private cooldown = 0;

  constructor(private level: QualityLevel) {}

  get current(): QualityLevel {
    return this.level;
  }

  set(level: QualityLevel): void {
    this.level = level;
    this.samples.length = 0;
    this.cooldown = 2.5;
  }

  /** Returns the tier to switch to, or null to stay put. */
  sample(deltaSeconds: number): QualityLevel | null {
    if (this.cooldown > 0) {
      this.cooldown -= deltaSeconds;
      return null;
    }
    // A stall from a road rebuild is not a frame rate; it is one bad frame.
    if (deltaSeconds > 0.4) return null;
    this.samples.push(deltaSeconds);
    if (this.samples.length < 60) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] as number;
    this.samples.length = 0;
    const index = QUALITY_LEVELS.indexOf(this.level);
    if (median > 1 / 34 && index > 0) return QUALITY_LEVELS[index - 1] as QualityLevel;
    if (median < 1 / 110 && index < QUALITY_LEVELS.length - 1) {
      return QUALITY_LEVELS[index + 1] as QualityLevel;
    }
    return null;
  }
}
