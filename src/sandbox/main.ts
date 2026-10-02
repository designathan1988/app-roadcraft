import {
  ACESFilmicToneMapping, BoxGeometry, Clock, Color, CylinderGeometry, DirectionalLight, HemisphereLight, MOUSE, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, type Object3D, PCFShadowMap, PerspectiveCamera, PlaneGeometry, Raycaster,
  RingGeometry, SRGBColorSpace, Scene, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

import { CROWD } from '@render/citizenCasting';
import { Agent } from './agent';
import { loadBody } from './body';
import { buildNav } from './nav';
import { type MenuItem, type SmartObject, bench, box, fountain, selfMenu, socialMenu } from './objects';

/**
 * The agents' laboratory: an isolated scene to try the agents' new
 * behaviour, one person to command as in The Sims - select, send walking
 * round obstacles, sit, pick things up, act, meet another person.
 */
const canvas = document.getElementById('lab') as HTMLCanvasElement;
const status = document.getElementById('status') as HTMLElement;
const queueBox = document.getElementById('queue') as HTMLElement;
const menuBox = document.getElementById('menu') as HTMLElement;
const roster = document.getElementById('agents') as HTMLElement;

const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;

const scene = new Scene();
scene.background = new Color(0xcfdde6);
const camera = new PerspectiveCamera(40, 1, 0.1, 200);
camera.position.set(9, 10, 12);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.8, 0);
// Left button is the player's (select, command); right turns, middle pans, wheel zooms.
controls.mouseButtons = { LEFT: null, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE } as unknown as typeof controls.mouseButtons;
controls.minDistance = 1.5;
controls.maxDistance = 45;
controls.maxPolarAngle = Math.PI * 0.47;
controls.enableDamping = true;

scene.add(new HemisphereLight(0xdfeeff, 0x6b6250, 1.2));
const sun = new DirectionalLight(0xfff1dc, 2.6);
sun.position.set(8, 14, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 50 });
sun.shadow.bias = -0.0004;
scene.add(sun);

// ---- the level: paving, walls, planters (what is walked round), furniture
const ground = new Mesh(new PlaneGeometry(30, 30), new MeshStandardMaterial({ color: 0xc9c1b2, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const wallMaterial = new MeshStandardMaterial({ color: 0xe7e1d6, roughness: 0.9 });
const planterMaterial = new MeshStandardMaterial({ color: 0x5c7a4b, roughness: 0.9 });
const obstacles: Mesh[] = [];
const wall = (x: number, z: number, w: number, d: number, h = 1.2): void => {
  const m = new Mesh(new BoxGeometry(w, h, d), wallMaterial);
  m.position.set(x, h / 2, z);
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  obstacles.push(m);
};
// A wall with a gap, a corridor and an L: ways round, not through.
wall(-1.5, -3, 7, 0.25);
wall(4.6, -3, 3, 0.25);
wall(-5, 1.5, 0.25, 6);
wall(-3.5, 4.4, 3, 0.25);
wall(5.5, 2.5, 0.25, 5);
for (const [x, z] of [[1.5, 1.5], [-1.5, 6.5], [2.8, -6.5], [-7, -6]] as const) {
  const p = new Mesh(new CylinderGeometry(0.55, 0.6, 0.6, 20), planterMaterial);
  p.position.set(x, 0.3, z);
  p.castShadow = p.receiveShadow = true;
  scene.add(p);
  obstacles.push(p);
}
const things: SmartObject[] = [
  bench(new Vector3(-2.5, 0, -6.5), 0),
  bench(new Vector3(7.5, 0, 6), -Math.PI / 2),
  fountain(new Vector3(-7.5, 0, 3), Math.PI / 2),
  box(new Vector3(2.5, 0, 4.5)),
  box(new Vector3(-8, 0, -1)),
];
for (const t of things) scene.add(t.object);

// ---- markers: who is selected, where they were sent
const ring = new Mesh(new RingGeometry(0.38, 0.48, 40), new MeshBasicMaterial({ color: 0x3fd6a8 }));
ring.rotation.x = -Math.PI / 2;
ring.visible = false;
scene.add(ring);
const target = new Mesh(new RingGeometry(0.12, 0.2, 24), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
target.rotation.x = -Math.PI / 2;
target.visible = false;
scene.add(target);

const agents: Agent[] = [];
const hit = new Map<Object3D, Agent>();
let selected: Agent | null = null;

function resize(): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---- the side panel: the people, and the selected one's queue
function select(agent: Agent | null): void {
  selected = agent;
  ring.visible = !!agent;
  drawPanel();
}

function drawPanel(): void {
  roster.innerHTML = '';
  for (const a of agents) {
    const b = document.createElement('button');
    b.className = `agent${a === selected ? ' on' : ''}`;
    b.textContent = a.name;
    b.onclick = () => select(a);
    roster.appendChild(b);
  }
  queueBox.innerHTML = '';
  if (!selected) { queueBox.innerHTML = '<div class="empty">Selecione alguém.</div>'; return; }
  if (!selected.queue.length) { queueBox.innerHTML = '<div class="empty">Parado. Clique no chão para andar, ou num objeto ou pessoa para agir.</div>'; return; }
  selected.queue.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = `step${i === 0 ? ' now' : ''}`;
    row.textContent = item.label;
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Cancelar';
    const who = selected!;
    x.onclick = () => who.cancel(i);
    row.appendChild(x);
    queueBox.appendChild(row);
  });
}

// ---- the context menu: what is offered here
function openMenu(items: MenuItem[], x: number, y: number, title: string): void {
  if (!items.length) { closeMenu(); return; }
  menuBox.innerHTML = `<div class="title">${title}</div>`;
  for (const item of items) {
    const b = document.createElement('button');
    b.textContent = item.label;
    b.onclick = () => { item.run(); closeMenu(); };
    menuBox.appendChild(b);
  }
  menuBox.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menuBox.style.top = `${Math.min(y, window.innerHeight - 40 * items.length - 40)}px`;
  menuBox.hidden = false;
}
function closeMenu(): void { menuBox.hidden = true; }

// ---- pointing: select, command, open a menu
const ray = new Raycaster();
const pointer = new Vector2();
let downAt: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => { if (e.button === 0) downAt = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 6) return;
  closeMenu();
  const r = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(pointer, camera);
  const proxies = [...hit.keys()];
  const people = ray.intersectObjects(proxies, false)[0];
  if (people) {
    const who = hit.get(people.object)!;
    if (!selected || selected === who) {
      if (selected === who) openMenu(selfMenu(who), e.clientX, e.clientY, who.name);
      else select(who);
    } else {
      openMenu([...socialMenu(selected, who), { label: `Selecionar ${who.name}`, run: () => select(who) }], e.clientX, e.clientY, who.name);
    }
    return;
  }
  const objectHit = ray.intersectObjects(things.map((t) => t.object), true)[0];
  if (objectHit && selected) {
    const owner = things.find((t) => { let o: Object3D | null = objectHit.object; while (o) { if (o === t.object) return true; o = o.parent; } return false; });
    if (owner) { openMenu(owner.menu(selected), e.clientX, e.clientY, owner.name); return; }
  }
  const floor = ray.intersectObject(ground, false)[0];
  if (floor && selected) {
    const to = floor.point.clone().setY(0);
    target.position.copy(to).setY(0.01);
    target.visible = true;
    // A plain click: go there now. Shift: queue it after what is planned.
    selected.push({ label: 'Ir até aqui', steps: [{ kind: 'goto', to }] }, !e.shiftKey);
  }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeMenu(); selected?.clear(); }
});

// ---- the people
async function start(): Promise<void> {
  status.textContent = 'Preparando o laboratório…';
  const nav = await buildNav([ground, ...obstacles, ...things.filter((t) => t.name !== 'Caixa').flatMap((t) => meshesOf(t.object))]);
  const adults = CROWD.filter((m) => m.person && m.ageBand === 'adult');
  const picks = [adults.find((m) => m.gender === 'f'), adults.find((m) => m.gender === 'm')].filter((m) => !!m);
  const spots = [new Vector3(-2, 0, 1.5), new Vector3(3, 0, -0.5)];
  for (let i = 0; i < picks.length; i++) {
    status.textContent = `Preparando ${i + 1} de ${picks.length}…`;
    const body = await loadBody(picks[i]!);
    scene.add(body.root);
    const agent = new Agent(body, nav, spots[i]!, i === 0 ? 0.6 : -2);
    agent.onChange = drawPanel;
    const proxy = new Mesh(new CylinderGeometry(0.38, 0.38, 1.8, 10), new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    proxy.position.y = 0.9;
    body.root.add(proxy);
    hit.set(proxy, agent);
    agents.push(agent);
  }
  select(agents[0] ?? null);
  status.textContent = 'Clique no chão: andar (Shift: depois do que já está na fila) · num objeto ou pessoa: ações · na pessoa selecionada: o que ela pode fazer · botão direito: girar · roda: zoom · Esc: cancelar';
  const clock = new Clock();
  const loop = (): void => {
    const dt = Math.min(0.05, clock.getDelta());
    nav.update(dt);
    for (const a of agents) a.update(dt);
    if (selected) ring.position.copy(selected.position).setY(0.015);
    if (target.visible && selected && !selected.busy) target.visible = false;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  loop();
  (window as unknown as { __lab: unknown }).__lab = { agents, things, select, camera, controls, exportRig };
}

/**
 * A person as a GLB (rest pose, skeleton and skinning, vertex colours) and its
 * skeleton as JSON (bone names, parents, rest positions in metres): what an
 * animation tool needs to make clips for this rig. Written by the dev server.
 */
async function exportRig(index = 0): Promise<{ glb: number; bones: number }> {
  const agent = agents[index]!;
  const glb = await new GLTFExporter().parseAsync(agent.body.root, { binary: true }) as ArrayBuffer;
  const bones = agent.body.mesh.skeleton.bones;
  const p = new Vector3();
  const skeleton = {
    rig: 'Rocketbox Bip01 (as the game uses it)', units: 'metres', up: '+Y', forward: '+Z',
    bones: bones.map((b) => {
      b.getWorldPosition(p);
      return { name: b.name, parent: b.parent && (b.parent as { isBone?: boolean }).isBone ? b.parent.name : null, rest: [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)] };
    }),
  };
  await fetch('/__cook/export/person-rocketbox-rig.glb', { method: 'PUT', body: glb });
  await fetch('/__cook/export/person-rocketbox-skeleton.json', { method: 'PUT', body: JSON.stringify(skeleton, null, 1) });
  return { glb: glb.byteLength, bones: bones.length };
}

function meshesOf(o: Object3D): Mesh[] {
  const out: Mesh[] = [];
  o.updateMatrixWorld(true);
  o.traverse((c) => { if ((c as Mesh).isMesh) out.push(c as Mesh); });
  return out;
}

start().catch((error: unknown) => {
  status.textContent = `Erro: ${String(error)}`;
  console.error(error);
});
