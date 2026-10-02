import { t } from './i18n';

/**
 * The loading screen: the people's bodies built and their motion baked
 * before the game is handed over, not while it runs (that took 4 ms of every
 * frame for minutes after the town opened). Baked once per build and kept
 * (`render/bakeCache.ts`), later starts pass through it in moments.
 */
export async function runLoadingScreen(
  work: (progress: (done: number, total: number) => void) => Promise<void>,
): Promise<void> {
  const root = document.createElement('div');
  root.className = 'loading-screen';
  root.setAttribute('role', 'progressbar');
  root.setAttribute('aria-valuemin', '0');
  root.innerHTML = `
    <div class="loading-card">
      <div class="loading-title"></div>
      <div class="loading-bar"><div class="loading-fill"></div></div>
      <div class="loading-note"></div>
    </div>`;
  const title = root.querySelector('.loading-title') as HTMLElement;
  const fill = root.querySelector('.loading-fill') as HTMLElement;
  const note = root.querySelector('.loading-note') as HTMLElement;
  title.textContent = t('loading.title');
  note.textContent = t('loading.people', { done: 0, total: '…' });
  document.body.appendChild(root);
  const started = performance.now();
  try {
    await work((done, total) => {
      fill.style.width = `${total > 0 ? Math.round((100 * done) / total) : 0}%`;
      root.setAttribute('aria-valuemax', String(total));
      root.setAttribute('aria-valuenow', String(done));
      note.textContent = t('loading.people', { done, total });
    });
  } finally {
    performance.measure('loading-screen', { start: started, end: performance.now() });
    root.classList.add('done');
    setTimeout(() => root.remove(), 300);
  }
}
