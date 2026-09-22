/**
 * Canvas sizing and device-pixel-ratio handling.
 *
 * The V6 monolith captured `devicePixelRatio` once at module load (defect
 * 5.12). Moving the window to a different-density display, or changing browser
 * zoom, left the backing store at the old scale for the rest of the session.
 * Here it is re-evaluated whenever it actually changes, and because the camera
 * is a transform, a DPR change costs one matrix update and zero geometry.
 */
export const MAX_DPR = 2;

export class CanvasSurface {
  readonly ctx: CanvasRenderingContext2D;
  dpr = 1;
  cssW = 1;
  cssH = 1;

  private ro: ResizeObserver | null = null;
  private stopDprWatch: (() => void) | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly onResize?: () => void,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('CanvasSurface: 2D context unavailable');
    this.ctx = ctx;
    this.resize();
  }

  /** Starts watching for size and pixel-density changes. */
  observe(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.handleChange());
      this.ro.observe(this.canvas);
    }
    window.addEventListener('resize', this.handleChange, { passive: true });
    window.visualViewport?.addEventListener('resize', this.handleChange, { passive: true });
    this.stopDprWatch = watchDpr(() => this.handleChange());
  }

  dispose(): void {
    this.ro?.disconnect();
    this.ro = null;
    window.removeEventListener('resize', this.handleChange);
    window.visualViewport?.removeEventListener('resize', this.handleChange);
    this.stopDprWatch?.();
    this.stopDprWatch = null;
  }

  private handleChange = (): void => {
    if (this.resize()) this.onResize?.();
  };

  /** Returns true when the backing store actually changed. */
  resize(): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || window.innerWidth);
    const cssH = Math.max(1, rect.height || window.innerHeight);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));

    this.dpr = dpr;
    this.cssW = cssW;
    this.cssH = cssH;

    if (this.canvas.width === w && this.canvas.height === h) return false;

    // Assigning width/height resets the entire context state, so anything we
    // rely on has to be reapplied here rather than set once at construction.
    this.canvas.width = w;
    this.canvas.height = h;
    this.applyDefaults();
    return true;
  }

  private applyDefaults(): void {
    this.ctx.lineJoin = 'round';
    this.ctx.lineCap = 'butt';
    this.ctx.imageSmoothingEnabled = true;
  }
}

/**
 * Calls `cb` whenever the device pixel ratio changes.
 *
 * `resize` does not reliably fire for a monitor switch or an OS scaling change,
 * so this arms a one-shot media query at the current ratio and re-arms itself
 * after each hit.
 */
export function watchDpr(cb: (dpr: number) => void): () => void {
  let mq: MediaQueryList | null = null;
  let disposed = false;

  const fire = (): void => {
    if (disposed) return;
    cb(window.devicePixelRatio);
    arm();
  };

  const arm = (): void => {
    if (disposed) return;
    mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener('change', fire, { once: true });
  };

  arm();
  return () => {
    disposed = true;
    mq?.removeEventListener('change', fire);
  };
}
