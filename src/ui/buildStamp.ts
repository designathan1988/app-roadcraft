import { onLanguageChange, t } from './i18n';

/**
 * The build stamp: branch, short commit and date of what is running
 * (`build-stamp.ts` at the project root). In development it sits in the
 * corner of the status bar and is re-read from the server every few seconds,
 * so a fast-forward shows up without a reload of the server; in production
 * it is only in the About dialog.
 */
export interface BuildStamp {
  readonly branch: string;
  readonly hash: string;
  readonly date: string;
  readonly dirty: boolean;
}

declare const __BUILD_STAMP__: BuildStamp | undefined;

const BAKED: BuildStamp = typeof __BUILD_STAMP__ !== 'undefined' && __BUILD_STAMP__
  ? __BUILD_STAMP__
  : { branch: 'unknown', hash: 'unknown', date: '', dirty: false };

let stamp: BuildStamp = BAKED;
const listeners = new Set<(value: BuildStamp) => void>();

export const buildStamp = (): BuildStamp => stamp;

export function formatBuildStamp(value: BuildStamp = stamp): string {
  return t('build.stamp', {
    branch: value.branch,
    hash: value.dirty ? `${value.hash}+` : value.hash,
    date: value.date.slice(0, 16).replace('T', ' '),
  });
}

export function onBuildStamp(listener: (value: BuildStamp) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function refresh(): Promise<void> {
  try {
    const response = await fetch('/__build', { cache: 'no-store' });
    if (!response.ok) return;
    const next = (await response.json()) as BuildStamp;
    if (next.hash === stamp.hash && next.branch === stamp.branch && next.dirty === stamp.dirty) return;
    stamp = next;
    for (const listener of listeners) listener(stamp);
  } catch {
    // The server went away; keep the last stamp.
  }
}

/** Shows the stamp in `element` (development builds) and keeps it current. */
export function mountBuildStamp(element: HTMLElement | null): void {
  if (!element) return;
  if (!import.meta.env.DEV) {
    element.hidden = true;
    return;
  }
  const paint = (): void => {
    element.textContent = formatBuildStamp();
    element.title = t('build.label');
  };
  paint();
  onBuildStamp(paint);
  onLanguageChange(paint);
  void refresh();
  window.setInterval(() => void refresh(), 5000);
}
