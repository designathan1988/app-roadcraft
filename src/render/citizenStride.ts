import { Object3D, Quaternion, SkinnedMesh, Vector3 } from 'three';
import { clipTransferFor, type LibraryClip, type NeutralWalk, type WalkAmplitude } from './citizenWalk';

/**
 * Bake-time stride warping. The existing slow capture supplies the timing,
 * foot lifts and weight shifts; its ankle paths are turned around each foot's
 * own mean stance position. Two-bone IK preserves the lengths of the legs and
 * the forward bend of the knees. The torso and the foot's captured orientation
 * are preserved. This creates side/back steps without turning the whole body
 * or adding any displacement to the simulation.
 */
export function directionalWalkFor(rig: Object3D, mesh: SkinnedMesh, clip: LibraryClip,
  amplitude: WalkAmplitude, angle: number): NeutralWalk & { readonly strideScale: number } {
  const walk = clipTransferFor(rig, mesh, clip, amplitude);
  const legs = ['L', 'R'].map(side => {
    const bones = ['Thigh', 'Calf', 'Foot'].map(part => rig.getObjectByName(`Bip01_${side}_${part}`));
    if (bones.some(bone => !bone)) throw new Error(`Citizen has no ${side} leg for stride warping`);
    return { thigh: bones[0]!, calf: bones[1]!, foot: bones[2]!, mean: new Vector3() };
  });
  // Use the source sample count so both feet's centres are independent of
  // the animation phase at which a particular body happens to start walking.
  const samples = clip.source.file.frames.length;
  const feet: Vector3[][] = [];
  for (let i = 0; i < samples; i++) {
    walk.pose(i * clip.duration / samples);
    const positions = legs.map(leg => leg.foot.getWorldPosition(new Vector3()));
    positions.forEach((p, j) => legs[j]!.mean.add(p));
    feet.push(positions);
  }
  for (const leg of legs) leg.mean.multiplyScalar(1 / samples);
  const sin = Math.sin(angle), cos = Math.cos(angle);
  const origins = legs.map(leg => leg.mean.clone());
  let strideScale = 1;
  if (Math.abs(sin) > Math.abs(cos)) {
    walk.pose(0);
    const clearance = soleClearance(rig);
    const hips = Math.abs(legs[0]!.thigh.getWorldPosition(new Vector3()).x - legs[1]!.thigh.getWorldPosition(new Vector3()).x);
    const centre = (origins[0]!.x + origins[1]!.x) / 2;
    // A side step needs room for the following foot. Its support stance is
    // the hip span plus the two inward half-soles, measured on this body.
    // Shorten the cycle to fit that support instead of crossing the ankles.
    const stance = Math.max(origins[0]!.x - origins[1]!.x, hips + clearance);
    legs[0]!.mean.x = centre + stance / 2;
    legs[1]!.mean.x = centre - stance / 2;
    let closing = 0;
    for (const pair of feet) {
      const dx = (pair[1]!.x - origins[1]!.x) - (pair[0]!.x - origins[0]!.x);
      const dz = (pair[1]!.z - origins[1]!.z) - (pair[0]!.z - origins[0]!.z);
      closing = Math.max(closing, dx * cos + dz * sin);
    }
    if (closing > 0) strideScale = Math.min(1, Math.max(0, (stance - clearance) / closing));
  }
  return {
    scale: walk.scale,
    lowestAt: walk.lowestAt,
    strideScale,
    pose(time) {
      walk.pose(time);
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i]!, origin = origins[i]!;
        const at = leg.foot.getWorldPosition(new Vector3());
        const orientation = leg.foot.getWorldQuaternion(new Quaternion());
        const dx = at.x - origin.x, dz = at.z - origin.z;
        const target = new Vector3(leg.mean.x + (dx * cos + dz * sin) * strideScale, at.y,
          leg.mean.z + (-dx * sin + dz * cos) * strideScale);
        reach(leg.thigh, leg.calf, leg.foot, target);
        const parent = leg.foot.parent!.getWorldQuaternion(new Quaternion());
        leg.foot.quaternion.copy(parent.invert().multiply(orientation));
        leg.foot.updateMatrixWorld(true);
      }
    },
  };
}

/** Sum of the inward half-widths of both drawn feet, including shoe meshes. */
function soleClearance(rig: Object3D): number {
  const bounds = [[Infinity, -Infinity], [Infinity, -Infinity]];
  const point = new Vector3();
  rig.traverse(o => {
    if (!(o instanceof SkinnedMesh)) return;
    const skin = o.geometry.attributes['skinIndex'], weight = o.geometry.attributes['skinWeight'];
    if (!skin || !weight) return;
    o.skeleton.update();
    const sides = o.skeleton.bones.map(b => /Bip01_L_(Foot|Toe)/.test(b.name) ? 0 : /Bip01_R_(Foot|Toe)/.test(b.name) ? 1 : -1);
    for (let i = 0; i < skin.count; i++) {
      const shares = [0, 0];
      for (let k = 0; k < 4; k++) {
        const side = sides[skin.getComponent(i, k)] ?? -1;
        if (side >= 0) shares[side]! += weight.getComponent(i, k);
      }
      const side = shares[0]! > 0.5 ? 0 : shares[1]! > 0.5 ? 1 : -1;
      if (side < 0) continue;
      o.getVertexPosition(i, point); o.localToWorld(point);
      bounds[side]![0] = Math.min(bounds[side]![0]!, point.x);
      bounds[side]![1] = Math.max(bounds[side]![1]!, point.x);
    }
  });
  if (bounds.some(b => !b.every(Number.isFinite))) throw new Error('Citizen has no weighted foot surface for lateral stride');
  return bounds.reduce((width, b) => width + (b[1]! - b[0]!) / 2, 0);
}

function aim(bone: Object3D, child: Vector3, target: Vector3): void {
  const origin = bone.getWorldPosition(new Vector3());
  const from = child.clone().sub(origin).normalize(), to = target.clone().sub(origin).normalize();
  const rotation = new Quaternion().setFromUnitVectors(from, to).multiply(bone.getWorldQuaternion(new Quaternion()));
  const parent = bone.parent?.getWorldQuaternion(new Quaternion()) ?? new Quaternion();
  bone.quaternion.copy(parent.invert().multiply(rotation));
  bone.updateMatrixWorld(true);
}

function reach(thigh: Object3D, calf: Object3D, foot: Object3D, target: Vector3): void {
  const hip = thigh.getWorldPosition(new Vector3()), knee = calf.getWorldPosition(new Vector3()), ankle = foot.getWorldPosition(new Vector3());
  const upper = hip.distanceTo(knee), lower = knee.distanceTo(ankle);
  const direction = target.clone().sub(hip);
  const distance = Math.min(upper + lower - 1e-6, Math.max(Math.abs(upper - lower) + 1e-6, direction.length()));
  direction.normalize();
  const bend = new Vector3(0, 0, 1).addScaledVector(direction, -direction.z).normalize();
  const along = (upper * upper + distance * distance - lower * lower) / (2 * distance);
  const across = Math.sqrt(Math.max(0, upper * upper - along * along));
  const joint = hip.clone().addScaledVector(direction, along).addScaledVector(bend, across);
  aim(thigh, knee, joint);
  aim(calf, foot.getWorldPosition(new Vector3()), hip.clone().addScaledVector(direction, distance));
}
