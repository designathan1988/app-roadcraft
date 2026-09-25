import { formatBuildStamp, onBuildStamp } from './buildStamp';
import { onLanguageChange } from './i18n';

/** The About dialog: which build this is, and the credits. */
export function mountAbout(): void {
  const button = document.getElementById('aboutButton');
  const dialog = document.getElementById('aboutDialog') as HTMLDialogElement | null;
  const build = document.getElementById('aboutBuild');
  if (!button || !dialog || !build) return;
  const paint = (): void => {
    build.textContent = formatBuildStamp();
  };
  paint();
  onBuildStamp(paint);
  onLanguageChange(paint);
  button.addEventListener('click', () => {
    paint();
    dialog.showModal();
  });
}
