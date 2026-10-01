import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Object3D, SkinnedMesh, Vector3 } from 'three';
import { createGait, gaitClipsOf, gaitHeading, gaitPlays, stepGait, SHUFFLE_AMPLITUDE, REST_AMPLITUDE, type GaitPlay } from '@render/citizenGait';
import { clipTransferFor, decodeRocketboxLibrary } from '@render/citizenWalk';
import { directionalWalkFor } from '@render/citizenStride';
import { CROWD } from '@render/citizenCasting';
import { DT } from '@sim/params';
import { personHash, type PedView } from '@sim/people/view';
import { m } from '@world/units';
import { bonePosition, citizenRig } from './support/citizenRig';

const library = decodeRocketboxLibrary(
  JSON.parse(readFileSync('src/render/motion/rocketboxMale.json', 'utf8')),
  JSON.parse(readFileSync('src/render/motion/rocketboxFemale.json', 'utf8')),
);
const clips = gaitClipsOf(library.male, 'male');

function walker(): PedView {
  return { id: 1, x: 0, y: 0, heading: 0, prev: { x: 0, y: 0, heading: 0 }, v: 0, turnV: 0, age: 0,
    ageClass: 'adult', gender: 'm', party: { id: 1, size: 1, archetype: 'solo', hasChild: false }, rank: 0,
    ground: 'footway', segment: undefined, stretch: '', walking: false, kerbWait: 0, waitingFor: null, gesture: null };
}

function playback(vx: number, vy: number, seconds = 4, turn = 0, chosenClips = clips,
  velocityAt?: (time: number) => readonly [number, number]) {
  const ped = walker(), hash = personHash(ped.id), gait = createGait(ped, 0, 0, hash);
  const snapshots: { plays: GaitPlay[]; heading: number }[] = [];
  for (let tick = 0; tick < Math.round(seconds / DT); tick++) {
    const [dx, dy] = velocityAt?.(tick * DT) ?? [vx, vy];
    ped.prev.x = ped.x; ped.prev.y = ped.y; ped.prev.heading = ped.heading;
    ped.x += m(dx) * DT; ped.y += m(dy) * DT; ped.age += DT;
    ped.v = m(Math.hypot(dx, dy)); ped.heading += turn * DT; ped.turnV = turn;
    const before = JSON.stringify(ped);
    stepGait(gait, ped, chosenClips, ped.age, ped.heading, 1, hash);
    expect(JSON.stringify(ped), 'animation must never mutate published body physics').toBe(before);
    const plays: GaitPlay[] = [];
    gaitPlays(gait, chosenClips, plays);
    snapshots.push({ plays, heading: gaitHeading(gait) });
  }
  return { ped, gait, snapshots };
}

describe('animation follows actual displacement', () => {
  it('represents sustained 0.07 m/s motion with progressing short steps after starting from idle', () => {
    const { snapshots } = playback(0.07, 0);
    const last = snapshots.at(-1)!.plays;
    const earlier = snapshots.at(-31)!.plays;
    const shortStep = last.find(p => p.name === 'walkShuffle');
    expect(shortStep, 'a moving body cannot stay on its idle clip').toBeDefined();
    expect(shortStep!.frame).not.toBe(earlier.find(p => p.name === 'walkShuffle')?.frame);
    expect(last.some(p => String(p.name) === 'walkRest' && p.weight > 0), 'short stride must change the pose, not only the cadence').toBe(true);
  });

  it.each([
    [-0.3, 0, 'walkBack'], [0, 0.3, 'walkLeft'], [0, -0.3, 'walkRight'],
  ])('steps in the actual direction (%s,%s) while the torso faces forward', (vx, vy, name) => {
    const { snapshots } = playback(Number(vx), Number(vy));
    const last = snapshots.at(-1)!.plays;
    expect(last.some(p => String(p.name) === name && p.weight > 0.5)).toBe(true);
    expect(last.find(p => String(p.name) === name)!.frame).not.toBe(snapshots.at(-31)!.plays.find(p => String(p.name) === name)?.frame);
  });

  it('keeps a truly stationary body on its idle pose with a stable heading', () => {
    const { snapshots } = playback(0, 0);
    expect(snapshots.every(s => s.plays.every(p => p.name === 'idle'))).toBe(true);
    expect(snapshots.every(s => s.heading === 0)).toBe(true);
  });

  it('steps through a stationary turn without discontinuities or changing the body', () => {
    const { snapshots } = playback(0, 0, 2, 0.6);
    expect(snapshots.at(-1)!.plays.some(p => p.name === 'turnLeft' && p.weight > 0.5)).toBe(true);
    expect(snapshots.at(-1)!.heading).toBeGreaterThan(0.5);
    for (let i = 1; i < snapshots.length; i++) expect(Math.abs(snapshots[i]!.heading - snapshots[i - 1]!.heading)).toBeLessThan(0.08);
  });

  it.each([[0.3, 0.3], [0.3, -0.3], [-0.3, 0.3], [-0.3, -0.3], [2.3, 0.2]])(
    'carries both signed velocity components (%s,%s) with different forward/lateral strides', (vx, vy) => {
      // Different per-body lateral limits are valid clip data. A blend of
      // equal angular weights must not quietly rotate the resulting travel.
      const bodyClips = { ...clips,
        walkLeft: { ...clips.walkLeft, stride: clips.walkLeft.stride * 0.35 },
        walkRight: { ...clips.walkRight, stride: clips.walkRight.stride * 0.6 },
      };
      const { snapshots } = playback(vx, vy, 4, 0, bodyClips);
      let forward = 0, left = 0;
      for (let i = 121; i < snapshots.length; i++) for (const after of snapshots[i]!.plays) {
        const clip = bodyClips[after.name];
        if (!clip.loop || clip.stride === 0) continue;
        const before = snapshots[i - 1]!.plays.find(p => p.name === after.name);
        if (!before) continue;
        const frames = (after.frame - before.frame + clip.frames) % clip.frames;
        const distance = frames / clip.frames * clip.stride * after.weight;
        if (after.name === 'walkLeft') left += distance;
        else if (after.name === 'walkRight') left -= distance;
        else forward += after.name === 'walkBack' ? -distance : distance;
      }
      expect(forward, 'forward/backward foot travel').toBeCloseTo(vx * 119 * DT, 3);
      expect(left, 'left/right foot travel').toBeCloseTo(vy * 119 * DT, 3);
      if (vx > 2) expect(snapshots.at(-1)!.plays.some(p => p.name === 'run' && p.weight > 0.1)).toBe(true);
    },
  );

  it('keeps lateral foot travel during a diagonal deceleration instead of selecting a forward-only stop', () => {
    const { snapshots } = playback(0, 0, 3, 0, clips, time => {
      const speed = Math.max(0.25, 1.2 - Math.max(0, time - 1));
      return [speed * Math.cos(Math.PI / 6), speed * Math.sin(Math.PI / 6)];
    });
    for (const frame of snapshots.slice(60)) {
      expect(frame.plays.some(p => (p.name === 'start' || p.name === 'stop') && p.weight > 0)).toBe(false);
      expect(frame.plays.some(p => p.name === 'walkLeft' && p.weight > 0)).toBe(true);
    }
  });
});

describe('the drawn feet carry the selected stride', () => {
  const model = CROWD.find(p => p.gender === 'm' && p.ageBand === 'adult')!.id;
  async function body() {
    const rig = await citizenRig(model);
    let mesh: SkinnedMesh | undefined;
    rig.traverse(o => { if (o instanceof SkinnedMesh && !mesh) mesh = o; });
    return { rig, mesh: mesh! };
  }
  function footGap(rig: Object3D): number {
    const point = new Vector3();
    let leftEdge = Infinity, rightEdge = -Infinity;
    rig.traverse(o => {
      if (!(o instanceof SkinnedMesh)) return;
      o.skeleton.update();
      const joints = o.geometry.attributes['skinIndex']!, weights = o.geometry.attributes['skinWeight']!;
      for (let v = 0; v < joints.count; v++) {
        let left = 0, right = 0;
        for (let k = 0; k < 4; k++) {
          const name = o.skeleton.bones[joints.getComponent(v, k)]!.name;
          if (/Bip01_L_(Foot|Toe)/.test(name)) left += weights.getComponent(v, k);
          if (/Bip01_R_(Foot|Toe)/.test(name)) right += weights.getComponent(v, k);
        }
        if (left <= 0.5 && right <= 0.5) continue;
        o.getVertexPosition(v, point); o.localToWorld(point);
        if (left > 0.5) leftEdge = Math.min(leftEdge, point.x);
        if (right > 0.5) rightEdge = Math.max(rightEdge, point.x);
      }
    });
    expect(Number.isFinite(leftEdge + rightEdge)).toBe(true);
    return leftEdge - rightEdge;
  }

  it.each([
    [Math.PI, 'z', -1], [Math.PI / 2, 'x', 1], [-Math.PI / 2, 'x', -1],
  ] as const)('the baked direction %s moves actual ankles along %s with preserved leg lengths', async (angle, axis, sign) => {
    const source = await body(), drawn = await body();
    const captured = clipTransferFor(source.rig, source.mesh, library.male.walkSlow, SHUFFLE_AMPLITUDE);
    const warped = directionalWalkFor(drawn.rig, drawn.mesh, library.male.walkSlow, SHUFFLE_AMPLITUDE, angle);
    const pairs: [number, number][] = [];
    for (let frame = 0; frame < 30; frame++) {
      const time = frame / 30 * library.male.walkSlow.duration;
      captured.pose(time); warped.pose(time);
      for (const side of ['L', 'R']) {
        const name = (part: string) => `Bip01_${side}_${part}`;
        const a = bonePosition(source.rig, name('Foot')), b = bonePosition(drawn.rig, name('Foot'));
        pairs.push([a.z, b[axis]]);
        expect(Math.abs(a.y - b.y), 'foot lift is retained').toBeLessThan(0.02);
        for (const [root, end] of [['Thigh', 'Calf'], ['Calf', 'Foot']]) {
          const sourceLength = bonePosition(source.rig, name(root!)).distanceTo(bonePosition(source.rig, name(end!)));
          const drawnLength = bonePosition(drawn.rig, name(root!)).distanceTo(bonePosition(drawn.rig, name(end!)));
          // Imported bind axes contain float32 error. A tenth of a millimetre
          // in world space still forbids visible stretch; the authored local
          // segment lengths must be unchanged exactly.
          expect(Math.abs(drawnLength - sourceLength)).toBeLessThan(0.0001);
          expect(drawn.rig.getObjectByName(name(end!))!.position.toArray()).toEqual(source.rig.getObjectByName(name(end!))!.position.toArray());
        }
      }
      if (axis === 'x') {
        expect(bonePosition(drawn.rig, 'Bip01_L_Foot').x - bonePosition(drawn.rig, 'Bip01_R_Foot').x,
          'a side step must not exchange the left/right foot positions').toBeGreaterThan(0);
        expect(footGap(drawn.rig), 'the drawn foot surfaces must stay separated laterally').toBeGreaterThanOrEqual(-0.00001);
      }
    }
    // Correlation of successive samples avoids different left/right stance
    // centres; these differences measure the direction the feet actually step.
    let agreement = 0, travel = 0;
    for (let i = 2; i < pairs.length; i++) {
      const forward = pairs[i]![0] - pairs[i - 2]![0];
      const directional = pairs[i]![1] - pairs[i - 2]![1];
      agreement += forward * directional * sign;
      travel += Math.abs(directional);
    }
    expect(agreement).toBeGreaterThan(0);
    expect(travel, 'actual bones must move, not merely the clip label').toBeGreaterThan(0.2);
    const left = pairs.filter((_, i) => i % 2 === 0);
    const span = (column: 0 | 1) => Math.max(...left.map(p => p[column])) - Math.min(...left.map(p => p[column]));
    expect(span(1) / span(0), 'stride metadata must describe the actual ankle excursion').toBeCloseTo(warped.strideScale, 2);
    const key = axis === 'z' ? 'walkBack' : sign > 0 ? 'walkLeft' : 'walkRight';
    const chosenClips = { ...clips, [key]: { ...clips[key], stride: clips[key].stride * warped.strideScale } };
    const { snapshots } = playback(axis === 'z' ? -0.3 : 0, axis === 'x' ? sign * 0.3 : 0, 4, 0, chosenClips);
    let carried = 0;
    for (let i = 121; i < snapshots.length; i++) {
      const before = snapshots[i - 1]!.plays.find(p => p.name === key)!;
      const after = snapshots[i]!.plays.find(p => p.name === key)!;
      const clip = chosenClips[key];
      const frames = (after.frame - before.frame + clip.frames) % clip.frames;
      carried += frames / clip.frames * clip.stride * after.weight;
    }
    expect(carried, 'the played feet must cover the 0.3 m/s displacement').toBeCloseTo(119 * DT * 0.3, 3);
  });

  it('0.07 m/s shortens the drawn ankle excursion rather than only slowing the full shuffle', async () => {
    const source = await body(), rest = await body();
    const captured = clipTransferFor(source.rig, source.mesh, library.male.walkSlow, SHUFFLE_AMPLITUDE);
    const neutral = clipTransferFor(rest.rig, rest.mesh, library.male.walkSlow, REST_AMPLITUDE);
    neutral.pose(0);
    const mean = bonePosition(rest.rig, 'Bip01_L_Foot');
    const { snapshots } = playback(0.07, 0);
    const weight = snapshots.at(-1)!.plays.find(p => p.name === 'walkShuffle')!.weight;
    const full: number[] = [], short: number[] = [];
    for (let frame = 0; frame < 30; frame++) {
      captured.pose(frame / 30 * library.male.walkSlow.duration);
      const foot = bonePosition(source.rig, 'Bip01_L_Foot');
      full.push(foot.z);
      // The renderer linearly blends skinning matrices, so the position of
      // an ankle attached to its bone has this same weighted position.
      short.push(foot.z * weight + mean.z * (1 - weight));
    }
    expect(Math.max(...full) - Math.min(...full)).toBeGreaterThan(0.1);
    expect(Math.max(...short) - Math.min(...short)).toBeLessThan((Math.max(...full) - Math.min(...full)) / 2);
  });
});
