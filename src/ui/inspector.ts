import type { NodeId, SegmentId } from '@world/ids';
import { movementKey, type JunctionControl, type RoadDoc, type SegmentDirection } from '@world/doc';
import type { Network } from '@world/network';
import type { JunctionTopology } from '@world/lanelets';
import type { CurveShape } from '@core/bezier';
import { LAST_UPGRADE_CLASS, ROAD_TYPES, roadProfile, travelLanes } from '@world/roadTypes';
import { METERS_PER_UNIT, UNITS_PER_METER } from '@world/units';
import type { SimWorld } from '@sim/world';
import { signalStateFor } from '@sim/signals/query';
import { language, plural, t } from './i18n';
import { roadTypeName } from './labels';
import { surfaceMode } from '@world/junction/build';

export interface InspectorSelection {
  readonly segment: SegmentId | null;
  readonly node: NodeId | null;
}

export interface InspectorActions {
  readonly onUpgrade: (id: SegmentId) => void;
  readonly onSetType: (id: SegmentId, type: number) => void;
  readonly onSetLanes?: (id: SegmentId, lanes: number | null) => void;
  readonly onDelete: (id: SegmentId) => void;
  readonly onSetDirection?: (id: SegmentId, direction: SegmentDirection) => void;
  readonly onSetNodeHeight?: (id: NodeId, metres: number) => void;
  readonly onReverseDirection?: (id: SegmentId) => void;
  readonly onSplit?: (id: SegmentId) => void;
  readonly onAddHeightPoint?: (id: SegmentId) => void;
  readonly onDuplicate?: (id: SegmentId) => void;
  readonly onSetControl?: (id: NodeId, control: JunctionControl) => void;
  readonly onSetMovementBlocked?: (node: NodeId, from: SegmentId, to: SegmentId, blocked: boolean) => void;
  readonly onSetCurve?: (id: SegmentId, curve: CurveShape | null) => void;
  readonly onJoin?: (node: NodeId) => void;
  /** Removes a node and the roads that meet at it. Offered only for a node the editor could not have created. */
  readonly onRemoveNode?: (node: NodeId) => void;
}

interface InspectorContext {
  readonly doc: RoadDoc;
  readonly net: Network;
  readonly sim: SimWorld;
  readonly selection: InspectorSelection;
  readonly actions: InspectorActions;
}

let current: InspectorContext | null = null;

/**
 * What the panel's controls were last built for.
 *
 * The panel has two halves that change at very different rates. The controls
 * (selects, sliders, buttons) depend only on the selection, the document and
 * the language; the statistics (vehicles, queue, signal phase) change every
 * tick. Rebuilding everything on the 0.4 s refresh replaced the element under
 * the pointer mid-click, closed an open select and reset the scroll, so the
 * frame loop refused to refresh while the panel held focus - and since a
 * clicked button KEEPS focus, the live numbers froze after the first click.
 * The controls are now rebuilt only when this key changes, and the timer
 * rewrites the statistics block alone.
 */
let builtFor = '';

/**
 * Inspector panel.
 *
 * Reads live simulation state through the same pure queries the renderer uses,
 * so what it reports about a junction is what the vehicles are actually obeying.
 */
export function openInspector(
  doc: RoadDoc,
  net: Network,
  sim: SimWorld,
  selection: InspectorSelection,
  actions: InspectorActions,
): void {
  current = { doc, net, sim, selection, actions };
  builtFor = '';
  renderCurrent();
}

/**
 * Refreshes the open inspector without replacing its selection or actions.
 *
 * Cheap when only the traffic changed: the statistics are rewritten, and only
 * if their text differs, so it is safe to call on a timer while the player is
 * using the panel's controls.
 */
export function refreshInspector(): void {
  if (current) renderCurrent();
}

function renderCurrent(): void {
  const panel = document.getElementById('inspector');
  const body = document.getElementById('inspectorBody');
  if (!panel || !body || !current) return;

  const { doc, net, sim, selection, actions } = current;
  const key = `${selection.segment}|${selection.node}|${doc.revision}|${language()}`;
  const stats = document.getElementById('inspectStats');

  if (key === builtFor && stats && body.contains(stats)) {
    const html =
      selection.segment !== null
        ? segmentStats(doc, net, sim, selection.segment)
        : selection.node !== null
          ? nodeStats(doc, sim, selection.node)
          : null;
    if (html === null) closeInspector();
    else if (stats.innerHTML !== html) stats.innerHTML = html;
    return;
  }

  if (selection.segment !== null) {
    renderSegment(doc, net, sim, body, selection.segment, actions);
  } else if (selection.node !== null) {
    renderNode(doc, net, sim, body, selection.node);
  } else {
    closeInspector();
    return;
  }
  // A renderer closes the panel when its selected entity no longer exists.
  if (!current) return;
  builtFor = key;
  panel.hidden = false;
  panel.setAttribute('aria-hidden', 'false');
  panel.classList.remove('hidden');
  document.getElementById('app')?.classList.add('inspector-open');
}

export function closeInspector(): void {
  current = null;
  builtFor = '';
  const panel = document.getElementById('inspector');
  if (panel) {
    panel.classList.add('hidden');
    panel.hidden = true;
    panel.setAttribute('aria-hidden', 'true');
  }
  document.getElementById('app')?.classList.remove('inspector-open');
}

/** The live numbers for a road, or null when the road no longer exists. */
function segmentStats(doc: RoadDoc, net: Network, sim: SimWorld, id: SegmentId): string | null {
  const seg = doc.segment(id);
  if (!seg) return null;
  const rt = roadProfile(seg.type, seg.lanes, seg.direction);
  const length = net.polylines.get(doc, id).length;

  let occupancy = 0;
  let queued = 0;
  let speedSum = 0;
  let speedCount = 0;
  let capacity = 0;
  for (const lane of sim.graph.lanelets.values()) {
    if (lane.kind === 'link' && lane.segment === id) {
      const runtime = sim.rt(lane.id);
      occupancy += runtime.order.length;
      capacity += Math.max(1, lane.length / 12);
      for (const vehicleId of runtime.order) {
        const vehicle = sim.veh(vehicleId);
        if (!vehicle) continue;
        speedSum += vehicle.v;
        speedCount++;
        if (vehicle.v < 0.6) queued++;
      }
    }
  }

  return grid([
    [t('inspector.length'), `${meters(length)} m`],
    [t('inspector.lanes'), seg.direction === 'both'
      ? t('inspector.lanesTwoWay', { count: rt.lanes, perSide: travelLanes(rt, seg.direction) })
      : t('inspector.lanesOneWay', { count: rt.lanes })],
    [t('inspector.speed'), `${Math.round(rt.speedLimit * METERS_PER_UNIT * 3.6)} km/h`],
    [t('inspector.meanSpeed'), speedCount ? `${Math.round((speedSum / speedCount) * METERS_PER_UNIT * 3.6)} km/h` : '—'],
    [t('inspector.vehicles'), String(occupancy)],
    [t('inspector.queue'), String(queued)],
    [t('inspector.capacity'), t('inspector.capacityValue', { count: Math.round(capacity) })],
    [t('inspector.volume'), String(sim.segmentVolume.get(id) ?? 0)],
  ]);
}

function renderSegment(
  doc: RoadDoc,
  net: Network,
  sim: SimWorld,
  body: HTMLElement,
  id: SegmentId,
  actions: InspectorActions,
): void {
  const seg = doc.segment(id);
  const stats = segmentStats(doc, net, sim, id);
  if (!seg || stats === null) {
    closeInspector();
    return;
  }
  const rt = roadProfile(seg.type, seg.lanes, seg.direction);
  const length = net.polylines.get(doc, id).length;
  setTitle(`${t('inspector.road')} · ${roadTypeName(rt)}`);

  const maxCurve = Math.max(20, Math.min(280, length * 0.65));
  const curveValue = seg.curve?.h ?? 0;
  const curvePosition = seg.curve?.t ?? 0.5;
  // Reversing is meaningful only for a one-way road. On a two-way road the
  // button used to turn it one-way A to B, which is what the direction select
  // is for and not what "reverse" says.
  const oneWay = seg.direction !== 'both';

  body.innerHTML =
    `<div id="inspectStats">${stats}</div>` +
    `<label class="inspect-select">${t('inspector.roadClass')} <select id="inspectClass">${ROAD_TYPES.map((type, index) => `<option value="${index}"${index === seg.type ? ' selected' : ''}>${roadTypeName(type)}</option>`).join('')}</select></label>` +
    `<label class="inspect-select">${t('inspector.direction')} <select id="inspectDirection">${directionOptions(seg.direction)}</select></label>` +
    `<label class="inspect-select">${t('inspector.heightStart')} <input id="inspectHeightStart" type="number" step="0.1" value="${((doc.node(seg.a)?.heightOffset ?? 0) / UNITS_PER_METER).toFixed(1)}" /></label>` +
    `<label class="inspect-select">${t('inspector.heightEnd')} <input id="inspectHeightEnd" type="number" step="0.1" value="${((doc.node(seg.b)?.heightOffset ?? 0) / UNITS_PER_METER).toFixed(1)}" /></label>` +
    `<label class="inspect-select">${t('inspector.laneCount')} <select id="inspectLanes">${laneOptions(seg.direction, seg.lanes, rt.lanes)}</select></label>` +
    `<label class="inspect-range"><span>${t('inspector.curvature')}</span><output id="inspectCurveValue">${curveText(curveValue)}</output><input id="inspectCurve" type="range" min="${-maxCurve}" max="${maxCurve}" step="1" value="${Math.max(-maxCurve, Math.min(maxCurve, curveValue))}" /></label>` +
    `<label class="inspect-range"${seg.curve ? '' : ' data-disabled'}><span>${t('inspector.curvePosition')}</span><output id="inspectCurvePositionValue">${percent(curvePosition)}</output><input id="inspectCurvePosition" type="range" min="0.15" max="0.85" step="0.01" value="${curvePosition}"${seg.curve ? '' : ' disabled'} /></label>` +
    `<div class="inspect-actions">` +
    `<button type="button" id="inspectUpgrade"${seg.type >= LAST_UPGRADE_CLASS ? ' disabled' : ''}>${t('inspector.upgrade')}</button>` +
    (oneWay ? `<button type="button" id="inspectReverse">${t('inspector.reverse')}</button>` : '') +
    `<button type="button" id="inspectDuplicate" title="${t('inspector.duplicateHint')}">${t('inspector.duplicate')}</button>` +
    `<button type="button" id="inspectSplit">${t('inspector.splitMiddle')}</button>` +
    `<button type="button" id="inspectAddHeightPoint">${t('inspector.addHeightPoint')}</button>` +
    `<button type="button" id="inspectDelete" class="danger">${t('inspector.demolish')}</button>` +
    `</div>`;

  const upgrade = document.getElementById('inspectUpgrade') as HTMLButtonElement | null;
  const remove = document.getElementById('inspectDelete') as HTMLButtonElement | null;
  const type = document.getElementById('inspectClass') as HTMLSelectElement | null;
  const direction = document.getElementById('inspectDirection') as HTMLSelectElement | null;
  const heightStart = document.getElementById('inspectHeightStart') as HTMLInputElement | null;
  const heightEnd = document.getElementById('inspectHeightEnd') as HTMLInputElement | null;
  const lanes = document.getElementById('inspectLanes') as HTMLSelectElement | null;
  const reverse = document.getElementById('inspectReverse') as HTMLButtonElement | null;
  const duplicate = document.getElementById('inspectDuplicate') as HTMLButtonElement | null;
  const split = document.getElementById('inspectSplit') as HTMLButtonElement | null;
  const heightPoint = document.getElementById('inspectAddHeightPoint') as HTMLButtonElement | null;
  const curve = document.getElementById('inspectCurve') as HTMLInputElement | null;
  const curveValueOutput = document.getElementById('inspectCurveValue') as HTMLOutputElement | null;
  const curvePositionInput = document.getElementById('inspectCurvePosition') as HTMLInputElement | null;
  const curvePositionOutput = document.getElementById('inspectCurvePositionValue') as HTMLOutputElement | null;
  if (upgrade) upgrade.onclick = () => actions.onUpgrade(id);
  if (type) type.onchange = () => actions.onSetType(id, Number(type.value));
  if (direction) direction.onchange = () => actions.onSetDirection?.(id, direction.value as SegmentDirection);
  if (heightStart) heightStart.onchange = () => actions.onSetNodeHeight?.(seg.a, Number(heightStart.value));
  if (heightEnd) heightEnd.onchange = () => actions.onSetNodeHeight?.(seg.b, Number(heightEnd.value));
  if (lanes) lanes.onchange = () => actions.onSetLanes?.(id, lanes.value === 'default' ? null : Number(lanes.value));
  if (reverse) reverse.onclick = () => actions.onReverseDirection?.(id);
  if (duplicate) duplicate.onclick = () => actions.onDuplicate?.(id);
  if (split) split.onclick = () => actions.onSplit?.(id);
  if (heightPoint) heightPoint.onclick = () => actions.onAddHeightPoint?.(id);
  if (curve) {
    curve.oninput = () => {
      if (curveValueOutput) curveValueOutput.value = curveText(Number(curve.value));
    };
    curve.onchange = () => {
      const h = Number(curve.value);
      actions.onSetCurve?.(id, Math.abs(h) < 0.5 ? null : { t: seg.curve?.t ?? 0.5, h });
    };
  }
  if (curvePositionInput && seg.curve) {
    curvePositionInput.oninput = () => {
      if (curvePositionOutput) curvePositionOutput.value = percent(Number(curvePositionInput.value));
    };
    curvePositionInput.onchange = () => {
      actions.onSetCurve?.(id, { t: Number(curvePositionInput.value), h: seg.curve!.h });
    };
  }
  if (remove) remove.onclick = () => actions.onDelete(id);
}

/** The live numbers for a junction, or null when the node no longer exists. */
function nodeStats(doc: RoadDoc, sim: SimWorld, id: NodeId): string | null {
  const node = doc.node(id);
  if (!node) return null;

  const junction = sim.graph.junctions.get(id);
  const controller = sim.controller(id);
  const control = !junction
    ? t('control.disconnected')
    : junction.signalised
      ? t('control.signal')
      : t(`control.${node.control}`);
  let active = 0;
  let queued = 0;
  let speedSum = 0;
  let speedCount = 0;
  let capacity = 0;
  for (const laneId of junction?.inbound ?? []) {
    const lane = sim.lanelet(laneId);
    if (!lane) continue;
    const runtime = sim.rt(laneId);
    active += runtime.order.length;
    capacity += Math.max(1, lane.length / 12);
    for (const vehicleId of runtime.order) {
      const vehicle = sim.veh(vehicleId);
      if (!vehicle) continue;
      speedSum += vehicle.v;
      speedCount++;
      if (vehicle.v < 0.6) queued++;
    }
  }
  const volume = node.incident.reduce((total, segment) => total + (sim.segmentVolume.get(segment) ?? 0), 0);

  const rows: [string, string][] = [
    [t('inspector.control'), control],
    [t('inspector.connections'), String(node.incident.length)],
    [t('inspector.movements'), String(junction?.connectors.length ?? 0)],
    [t('inspector.vehicles'), String(active)],
    [t('inspector.queue'), String(queued)],
    [t('inspector.meanSpeed'), speedCount ? `${Math.round((speedSum / speedCount) * METERS_PER_UNIT * 3.6)} km/h` : '—'],
    [t('inspector.capacity'), t('inspector.capacityValue', { count: Math.round(capacity) })],
    [t('inspector.volume'), String(volume)],
  ];

  if (controller && junction?.signalised) {
    rows.push([t('inspector.cycle'), `${controller.plan.cycle.toFixed(0)} s`]);
    rows.push([
      t('inspector.phase'),
      `${controller.stageIndex + 1}/${controller.plan.stages.length} · ${phaseLabel(controller.sub)}`,
    ]);
  }

  // Each signal group as a lamp: the colour is read faster than the word, and
  // the word stays for anyone who cannot tell the lamps apart.
  let lamps = '';
  // Lamps only where there are lights: a stop or priority junction has none.
  if (controller && junction?.signalised && junction.groups.length) {
    lamps = `<div class="signal-chips">${junction.groups.map((g) => {
      const state = signalStateFor(controller, g.id);
      return `<span class="signal-chip" data-state="${state}"><i></i>${t('inspector.group', { id: g.id + 1 })} · ${signalLabel(state)}</span>`;
    }).join('')}</div>`;
  }
  return grid(rows) + lamps;
}

function renderNode(
  doc: RoadDoc,
  net: Network,
  sim: SimWorld,
  body: HTMLElement,
  id: NodeId,
): void {
  const node = doc.node(id);
  const stats = nodeStats(doc, sim, id);
  if (!node || stats === null) {
    closeInspector();
    return;
  }
  setTitle(node.smooth ? t('inspector.heightPoint')
    : node.incident.length >= 3 ? t('inspector.junction') : t('inspector.node'));
  if (node.smooth) {
    body.innerHTML =
      `<label class="inspect-select">${t('inspector.heightNode')} <input id="inspectHeightNode" type="number" step="0.1" value="${(node.heightOffset / UNITS_PER_METER).toFixed(1)}" /></label>` +
      `<p class="inspect-note">${t('inspector.heightPointHelp')}</p>`;
    const heightNode = document.getElementById('inspectHeightNode') as HTMLInputElement;
    heightNode.onchange = () => actionsForNode().onSetNodeHeight?.(id, Number(heightNode.value));
    return;
  }
  const junction = sim.graph.junctions.get(id);

  const mouths = node.incident
    .map((seg) => `${meters(net.mouthDistance(seg, id))} m`)
    .join(' · ');

  // The offer is a promise that the two legs read as ONE road, so it is gated on
  // the model's own answer to that question rather than on degree alone.
  // `surfaceMode` is the junction builder's classifier, and it answers 'none'
  // exactly when a degree-2 node of a single class bends less than
  // `CHAIN_BEND_COS` (5 degrees) — a straight-through chain that needs no
  // junction drawn at all. Degree alone offered the merge on the seed's
  // right-angle corners, where accepting it replaced a 620-unit corner path
  // with a 444-unit straight chord: a corner cut, under a label promising
  // alignment.
  const alignedLegs =
    !node.smooth && node.incident.length === 2 && surfaceMode(doc, net.polylines, id) === 'none';
  const joinOffer = alignedLegs
    ? `<div class="inspect-actions"><button type="button" id="inspectJoin">${t('inspector.joinAligned')}</button></div>`
    : '';

  body.innerHTML = `<div id="inspectStats">${stats}</div>` +
    `<label class="inspect-select">${t('inspector.heightNode')} <input id="inspectHeightNode" type="number" step="0.1" value="${(node.heightOffset / UNITS_PER_METER).toFixed(1)}" /></label>` +
    (node.smooth ? `<p class="inspect-note">${t('inspector.heightPointHelp')}</p>`
      : `<label class="inspect-select">${t('inspector.controlSelect')} <select id="inspectControl">${controlOptions(node.control)}</select></label>`) +
    joinOffer +
    (node.smooth ? '' : movementControls(doc, junction, node.blockedMovements) +
      `<p class="inspect-note">${t('inspector.mouths')}: ${mouths || '—'}</p>`);

  const policy = document.getElementById('inspectControl') as HTMLSelectElement | null;
  const heightNode = document.getElementById('inspectHeightNode') as HTMLInputElement | null;
  if (heightNode) heightNode.onchange = () => actionsForNode().onSetNodeHeight?.(id, Number(heightNode.value));
  if (policy) policy.onchange = () => actionsForNode().onSetControl?.(id, policy.value as JunctionControl);
  const join = document.getElementById('inspectJoin') as HTMLButtonElement | null;
  if (join) join.onclick = () => actionsForNode().onJoin?.(id);
  document.querySelectorAll<HTMLInputElement>('[data-movement-from]').forEach((input) => {
    input.onchange = () => actionsForNode().onSetMovementBlocked?.(
      id,
      Number(input.dataset['movementFrom']) as SegmentId,
      Number(input.dataset['movementTo']) as SegmentId,
      !input.checked,
    );
  });
}

/** The compass point a leg runs towards from its junction (north is up the map). */
function compassOf(doc: RoadDoc, nodeId: NodeId, seg: { a: NodeId; b: NodeId }): string {
  const here = doc.node(nodeId);
  const there = doc.node(seg.a === nodeId ? seg.b : seg.a);
  if (!here || !there) return '?';
  // North is +Y, up the map (`world/lanelets.ts`); 0 north, clockwise.
  const angle = Math.atan2(there.x - here.x, there.y - here.y);
  const points = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
  const i = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
  return t(`compass.${points[i]}`);
}

function movementControls(
  doc: RoadDoc,
  junction: JunctionTopology | undefined,
  blocked: readonly string[],
): string {
  const movements = new Map<string, { from: SegmentId; to: SegmentId; label: string }>();
  for (const id of junction?.connectors ?? []) {
    const connector = current?.sim.connector(id);
    if (!connector) continue;
    const key = movementKey(connector.inSegment, connector.outSegment);
    if (movements.has(key)) continue;
    const from = doc.segment(connector.inSegment);
    const to = doc.segment(connector.outSegment);
    if (!from || !to) continue;
    movements.set(key, {
      from: connector.inSegment,
      to: connector.outSegment,
      // By the way each leg points from the junction - north, south-east... -
      // not by class: at a crossroads of two avenues every row read
      // "Avenue -> Avenue (left)" and could not be told apart (P2-42).
      label: t('inspector.movementBy', {
        from: compassOf(doc, connector.node, from),
        to: compassOf(doc, connector.node, to),
        turn: turnLabel(connector.turn),
      }),
    });
  }

  // A blocked movement has no connector left to describe it: the junction
  // builder skips blocked pairs outright (see `world/lanelets.ts`), so
  // `junction.connectors` cannot list them and the row used to vanish the
  // instant it was unchecked — leaving undo as the only way back, and no hint
  // that anything was there. The node's own key list is the surviving record,
  // so it is what gets rendered: the leg numbers the key already encodes, with
  // no turn or class name invented for a connector that no longer exists.
  for (const key of blocked) {
    if (movements.has(key)) continue;
    const [from, to] = key.split('>');
    if (from === undefined || to === undefined) continue;
    const fromId = Number(from);
    const toId = Number(to);
    if (!Number.isFinite(fromId) || !Number.isFinite(toId)) continue;
    movements.set(key, {
      from: fromId as SegmentId,
      to: toId as SegmentId,
      label: t('inspector.blockedMovement', { from, to }),
    });
  }

  if (!movements.size) return '';
  return `<fieldset class="movement-controls"><legend>${t('inspector.allowedMovements')}</legend>${[...movements.entries()].map(([key, movement]) =>
    `<label><input type="checkbox" data-movement-from="${movement.from}" data-movement-to="${movement.to}"${blocked.includes(key) ? '' : ' checked'} />${movement.label}</label>`,
  ).join('')}</fieldset>`;
}

function actionsForNode(): InspectorActions {
  return current?.actions ?? { onUpgrade: () => {}, onSetType: () => {}, onDelete: () => {} };
}

function directionOptions(value: SegmentDirection): string {
  const entries: readonly SegmentDirection[] = ['both', 'aToB', 'bToA'];
  return entries
    .map((id) => `<option value="${id}"${id === value ? ' selected' : ''}>${t(`direction.${id}`)}</option>`)
    .join('');
}

function laneOptions(direction: SegmentDirection, configured: number | null, resolved: number): string {
  const values = direction === 'both' ? [2, 4, 6, 8] : [1, 2, 3, 4, 5, 6, 7, 8];
  const options = [
    `<option value="default"${configured === null ? ' selected' : ''}>${t('inspector.classDefault', { count: resolved })}</option>`,
  ];
  for (const count of values) {
    options.push(
      `<option value="${count}"${configured === count ? ' selected' : ''}>${plural('inspector.laneOption', count)}</option>`,
    );
  }
  return options.join('');
}

function controlOptions(value: JunctionControl): string {
  const entries: readonly JunctionControl[] = ['auto', 'signal', 'priority', 'stop', 'yield', 'none'];
  return entries
    .map((id) => `<option value="${id}"${id === value ? ' selected' : ''}>${t(`control.${id}`)}</option>`)
    .join('');
}

const signalLabel = (value: string): string => t(`signal.${value}`);

const phaseLabel = (value: string): string => t(`phase.${value}`);

const turnLabel = (value: string): string => t(`turn.${value}`);

const meters = (units: number): string => (units * METERS_PER_UNIT).toFixed(1);

/** A curve's bulge: how far the arc leaves the straight line, signed by side. */
const curveText = (units: number): string =>
  Math.abs(units) < 0.5 ? '0 m' : `${units > 0 ? '+' : '−'}${Math.round(Math.abs(units) * METERS_PER_UNIT)} m`;

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/** Names what is selected in the panel's own heading. */
function setTitle(value: string): void {
  const title = document.getElementById('inspectorTitle');
  if (title) title.textContent = value;
}

const card = (label: string, value: string): string =>
  `<div class="inspect-card"><span>${label}</span><strong>${value}</strong></div>`;

const grid = (rows: readonly [string, string][]): string =>
  `<div class="inspect-grid">${rows.map(([k, v]) => card(k, v)).join('')}</div>`;
