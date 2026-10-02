import type { RoadType } from '@world/roadTypes';
import { laneWidth } from '@world/roadTypes';
import { ROAD_SECTION_LIMITS, type RoadSection } from '@world/roadSection';
import { METERS_PER_UNIT, UNITS_PER_METER } from '@world/units';
import { t } from './i18n';

/** Editing is opt-in; saved road dimensions remain readable without the flag. */
export const freeRoadsEnabled = (): boolean =>
  new URLSearchParams(location.search).get('roads') === 'free';

/** One change on release, so a drag creates one exact undo step. */
export function mountRoadSectionEditor(
  host: HTMLElement, profile: RoadType, oneWay: boolean, change: (section: RoadSection | undefined) => void,
): void {
  const section: { -readonly [K in keyof RoadSection]: number } = {
    laneWidth: laneWidth(profile), sidewalk: profile.sidewalk, median: profile.median,
    speedKmh: profile.speedLimit * METERS_PER_UNIT * 3.6, priority: profile.priorityRank,
  };
  const panel = document.createElement('fieldset');
  panel.className = 'road-section-editor';
  panel.style.cssText = 'border:1px solid #ffffff24;border-radius:8px;padding:10px;margin:10px 0';
  const legend = document.createElement('legend');
  legend.textContent = t('road.section.title');
  panel.append(legend);
  const diagram = document.createElement('div');
  diagram.style.cssText = 'display:flex;height:44px;gap:2px;margin:4px 0 12px;overflow:hidden;border-radius:4px';
  diagram.setAttribute('aria-label', t('road.section.preview'));
  const draw = (): void => {
    diagram.replaceChildren();
    const band = (width: number, color: string, text: string): void => {
      if (width <= 0) return;
      const node = document.createElement('span');
      node.style.cssText = `flex:${width} 1 0;background:${color};display:grid;place-items:center;color:white;min-width:0;font-size:11px;overflow:hidden`;
      node.textContent = text;
      diagram.append(node);
    };
    band(section.sidewalk, '#77766e', t('road.section.walk'));
    for (let i = 0; i < profile.lanes; i++) {
      if (i === profile.lanes / 2 && !oneWay) band(section.median, '#496447', '');
      band(section.laneWidth, '#363f49', oneWay ? '→' : i < profile.lanes / 2 ? '←' : '→');
    }
    band(section.sidewalk, '#77766e', t('road.section.walk'));
  };
  draw();
  panel.append(diagram);
  const controls: readonly [keyof RoadSection, number, number, string][] = [
    ['laneWidth', 0.1, UNITS_PER_METER, 'm'],
    ['sidewalk', 0.02, UNITS_PER_METER, 'm'],
    ['median', 0.1, UNITS_PER_METER, 'm'],
    ['speedKmh', 5, 1, 'km/h'],
    ['priority', 1, 1, ''],
  ];
  for (const [field, step, scale, unit] of controls) {
    const [min, max] = ROAD_SECTION_LIMITS[field];
    const label = document.createElement('label');
    label.className = 'inspect-range';
    const title = document.createElement('span');
    title.textContent = t(`road.section.${field}`);
    const output = document.createElement('output');
    const input = document.createElement('input');
    input.type = 'range'; input.min = String(min / scale); input.max = String(max / scale); input.step = String(step);
    input.disabled = field === 'median' && oneWay;
    input.value = String(section[field] / scale);
    input.dataset['sectionField'] = field;
    const update = (): void => {
      output.value = `${Number(input.value).toFixed(step < 1 ? 1 : 0)} ${unit}`.trim();
    };
    update();
    input.oninput = () => { section[field] = Number(input.value) * scale; update(); draw(); };
    input.onchange = () => { section[field] = Number(input.value) * scale; change({ ...section }); };
    label.append(title, output, input); panel.append(label);
  }
  const reset = document.createElement('button');
  reset.type = 'button'; reset.textContent = t('road.section.reset');
  reset.onclick = () => change(undefined);
  panel.append(reset);
  host.append(panel);
}
