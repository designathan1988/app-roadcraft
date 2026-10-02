import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, type Object3D, Vector3 } from 'three';

import { LIBRARY_AT } from '@render/citizenBake';
import type { Agent, Interaction, Step } from './agent';

/**
 * Smart objects, as The Sims has them: the object knows what can be done with
 * it and how (where to stand, which way to face, what to play), and offers it
 * to whoever is selected; the agent only queues and carries out the steps.
 * Places are reserved (Unreal's Smart Objects "claim" a slot) so two people
 * never sit on the one seat.
 */
export interface MenuItem {
  readonly label: string;
  readonly run: () => void;
}

export interface SmartObject {
  readonly name: string;
  readonly object: Object3D;
  /** What `agent` can do with it now. */
  menu(agent: Agent): MenuItem[];
}

const wood = new MeshStandardMaterial({ color: 0x8a5a35, roughness: 0.8 });
const metal = new MeshStandardMaterial({ color: 0x3b4145, roughness: 0.5, metalness: 0.6 });
const stone = new MeshStandardMaterial({ color: 0xbfb6a6, roughness: 0.9 });
const card = new MeshStandardMaterial({ color: 0xc69a62, roughness: 0.85 });
const water = new MeshStandardMaterial({ color: 0x3a7fa8, roughness: 0.1, metalness: 0.2 });

const play = (name: keyof typeof LIBRARY_AT, more: Partial<Extract<Step, { kind: 'play' }>> = {}): Step =>
  ({ kind: 'play', clip: LIBRARY_AT[name], ...more });

/** A bench of two seats, its back to `heading` + PI. */
export function bench(at: Vector3, heading: number): SmartObject {
  const group = new Group();
  const seat = new Mesh(new BoxGeometry(1.6, 0.06, 0.45), wood);
  seat.position.set(0, 0.45, 0);
  const back = new Mesh(new BoxGeometry(1.6, 0.45, 0.06), wood);
  back.position.set(0, 0.72, -0.2);
  group.add(seat, back);
  for (const x of [-0.7, 0.7]) {
    const leg = new Mesh(new BoxGeometry(0.06, 0.45, 0.4), metal);
    leg.position.set(x, 0.225, 0);
    group.add(leg);
  }
  group.position.copy(at);
  group.rotation.y = heading;
  group.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  const seats = [-0.4, 0.4];
  const taken = new Map<number, Agent>();
  // Where to stand to sit: in front of the seat, facing out.
  const spot = (i: number): Vector3 => new Vector3(seats[i]!, 0, 0.42).applyAxisAngle(new Vector3(0, 1, 0), heading).add(at);
  return {
    name: 'Banco',
    object: group,
    menu(agent) {
      const free = seats.findIndex((_, i) => !taken.has(i));
      if (free < 0 || [...taken.values()].includes(agent)) return [];
      return [{
        label: 'Sentar',
        run: () => {
          taken.set(free, agent);
          const release = (): void => { if (taken.get(free) === agent) taken.delete(free); };
          agent.push({
            label: 'Sentar no banco',
            steps: [
              { kind: 'goto', to: spot(free), exact: true },
              { kind: 'face', heading },
              play('sitDown'),
              play('sitIdle', { hold: true }),
              play('standUp'),
              { kind: 'do', run: release },
            ],
            cancel: release,
          });
        },
      }];
    },
  };
}

/** A box anybody can pick up, carry and put down somewhere else. */
export function box(at: Vector3): SmartObject {
  const mesh = new Mesh(new BoxGeometry(0.36, 0.28, 0.3), card);
  mesh.position.copy(at).setY(0.14);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  let holder: Agent | null = null;
  const self: SmartObject = {
    name: 'Caixa',
    object: mesh,
    menu(agent) {
      if (holder || agent.carrying) return [];
      return [{
        label: 'Pegar a caixa',
        run: () => {
          holder = agent;
          agent.push({
            label: 'Pegar a caixa',
            steps: [
              { kind: 'goto', to: mesh.position.clone().setY(0), near: 0.55 },
              { kind: 'face', towards: () => mesh.position },
              play('crouchDown'),
              { kind: 'do', run: (a) => { a.carrying = mesh; } },
              play('crouchUp'),
            ],
            cancel: (a) => { if (a.carrying !== mesh) holder = null; },
          });
        },
      }];
    },
  };
  // Put down, from the agent's own menu (`selfMenu`).
  boxes.set(mesh, (agent) => {
    agent.push({
      label: 'Largar a caixa',
      steps: [
        play('crouchDown'),
        {
          kind: 'do',
          run: (a) => {
            const ahead = new Vector3(Math.sin(a.heading), 0, Math.cos(a.heading)).multiplyScalar(0.45);
            mesh.position.copy(a.position).add(ahead).setY(0.14);
            mesh.rotation.set(0, a.heading, 0);
            mesh.scale.set(1, 1, 1);
            a.carrying = null;
            holder = null;
          },
        },
        play('crouchUp'),
      ],
    });
  });
  return self;
}
const boxes = new Map<Object3D, (agent: Agent) => void>();

/** A drinking fountain. */
export function fountain(at: Vector3, heading: number): SmartObject {
  const group = new Group();
  const pillar = new Mesh(new CylinderGeometry(0.18, 0.22, 0.95, 16), stone);
  pillar.position.y = 0.475;
  const bowl = new Mesh(new CylinderGeometry(0.26, 0.2, 0.08, 20), water);
  bowl.position.y = 0.99;
  group.add(pillar, bowl);
  group.position.copy(at);
  group.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  const spot = new Vector3(0, 0, 0.55).applyAxisAngle(new Vector3(0, 1, 0), heading).add(at);
  return {
    name: 'Bebedouro',
    object: group,
    menu: (agent) => [{
      label: 'Beber água',
      run: () => agent.push({
        label: 'Beber água',
        steps: [{ kind: 'goto', to: spot, exact: true }, { kind: 'face', towards: () => at }, play('drink', { seconds: 4 })],
      }),
    }],
  };
}

/** What an agent can do by itself (clicking on it). */
export function selfMenu(agent: Agent): MenuItem[] {
  const items: MenuItem[] = [];
  const one = (label: string, name: keyof typeof LIBRARY_AT, seconds?: number): MenuItem => ({
    label, run: () => agent.push({ label, steps: [play(name, seconds ? { seconds } : {})] }),
  });
  if (agent.carrying) {
    const putDown = boxes.get(agent.carrying);
    if (putDown) items.push({ label: 'Largar a caixa', run: () => putDown(agent) });
  } else {
    items.push(one('Olhar o celular', 'phone', 8), one('Ler', 'read', 8), one('Beber algo', 'drink', 5));
  }
  items.push(one('Acenar', 'wave'), one('Olhar em volta', 'look'), one('Rir', 'laugh'), one('Comemorar', 'cheer', 5), one('Dançar', 'dance', 8));
  if (agent.busy) items.push({ label: 'Cancelar tudo', run: () => agent.clear() });
  return items;
}

/**
 * What one agent can do with another: The Sims 4's multi-actor interactions,
 * each a pair of interactions, one in each queue, that wait for each other
 * at the start (both in place) before the clips play in step.
 */
export function socialMenu(agent: Agent, other: Agent): MenuItem[] {
  if (agent === other) return [];
  const pair = (label: string, mine: Step[], theirs: Step[], distance = 1.1): MenuItem => ({
    label,
    run: () => {
      let here = false;
      let there = false;
      const meet = (): Vector3 => {
        const away = agent.position.clone().sub(other.position).setY(0);
        if (away.lengthSq() < 1e-4) away.set(0, 0, 1);
        return other.position.clone().add(away.normalize().multiplyScalar(distance));
      };
      agent.push({
        label: `${label} com ${other.name}`,
        steps: [
          { kind: 'goto', to: meet(), near: 0.25 },
          { kind: 'face', towards: () => other.position },
          { kind: 'do', run: () => { here = true; } },
          { kind: 'wait', until: () => there, seconds: 20 },
          ...mine,
        ],
      });
      other.push({
        label: `${label} com ${agent.name}`,
        steps: [
          { kind: 'wait', until: () => here, seconds: 30 },
          { kind: 'face', towards: () => agent.position },
          { kind: 'do', run: () => { there = true; } },
          ...theirs,
        ],
      });
    },
  });
  const talk = (n: number, first: 'talk' | 'listen'): Step[] =>
    Array.from({ length: n }, (_, i) => play((i % 2 === 0) === (first === 'talk') ? 'talk' : 'listen', { seconds: 3 }));
  return [
    pair('Conversar', talk(4, 'talk'), talk(4, 'listen')),
    pair('Acenar', [play('wave')], [play('wave')], 2.2),
    pair('Rir junto', [play('laugh')], [play('laugh')]),
    pair('Discutir', [play('argue', { seconds: 6 })], [play('angry', { seconds: 6 })]),
  ];
}

export type { Interaction };
