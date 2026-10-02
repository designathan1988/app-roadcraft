import { Float32BufferAttribute } from 'three';
import { createPersonRig, type PersonRig, type PersonRigInput } from './personRig';

/** Build relative shapes through the same body/proxy fitting and bind-pose transform. */
export async function attachFacialMorphs(input: PersonRigInput, rig: PersonRig,
  shapes: Record<string, Float32Array>): Promise<void> {
  // Gaze rotates the eyeballs around their own centres in the bind mesh.
  for (const [name, angle] of [['lookLeft', 0.25], ['lookRight', -0.25]] as const) {
    const delta = new Float32Array(input.positions.length);
    for (const group of ['helper-l-eye', 'helper-r-eye']) {
      const groupId = input.data.faceGroups.indexOf(group);
      const vertices = new Set<number>();
      for (let f = 0; f < input.data.faceGroup.length; f++) {
        if (input.data.faceGroup[f] !== groupId) continue;
        for (let k = 0; k < 4; k++) vertices.add(input.data.faces[f * 4 + k]!);
      }
      let x = 0, z = 0;
      for (const v of vertices) { x += input.positions[v * 3]!; z += input.positions[v * 3 + 2]!; }
      x /= Math.max(1, vertices.size); z /= Math.max(1, vertices.size);
      for (const v of vertices) {
        const dx = input.positions[v * 3]! - x, dz = input.positions[v * 3 + 2]! - z;
        delta[v * 3] = dx * (Math.cos(angle) - 1) + dz * Math.sin(angle);
        delta[v * 3 + 2] = -dx * Math.sin(angle) + dz * (Math.cos(angle) - 1);
      }
    }
    shapes[name] = delta;
  }
  const base = rig.mesh.geometry.getAttribute('position');
  const attributes: Float32BufferAttribute[] = [];
  for (const [name, deltas] of Object.entries(shapes)) {
    const positions = input.positions.map((value, i) => value + deltas[i]!);
    // A dressed body knows its expressions as moves of its own vertices
    // (`PersonRig.morph`): no second build of the person.
    if (rig.morph) {
      const attribute = new Float32BufferAttribute(rig.morph(positions), 3);
      if (attribute.count !== base.count) throw new Error(`Expression ${name} changes body topology`);
      attribute.name = name;
      attributes.push(attribute);
      continue;
    }
    const target = createPersonRig({ ...input, positions });
    try {
      const moved = target.mesh.geometry.getAttribute('position');
      if (moved.count !== base.count) throw new Error(`Expression ${name} changes body topology: ${base.count} -> ${moved.count}`);
      const relative = new Float32Array(base.count * 3);
      for (let v = 0; v < base.count; v++) {
        relative[v * 3] = moved.getX(v) - base.getX(v);
        relative[v * 3 + 1] = moved.getY(v) - base.getY(v);
        relative[v * 3 + 2] = moved.getZ(v) - base.getZ(v);
      }
      const attribute = new Float32BufferAttribute(relative, 3);
      attribute.name = name;
      attributes.push(attribute);
    } finally {
      target.mesh.geometry.dispose(); target.mesh.skeleton.dispose();
      for (const material of Array.isArray(target.mesh.material) ? target.mesh.material : [target.mesh.material]) material.dispose();
      target.scene.clear();
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  rig.mesh.geometry.morphAttributes.position = attributes;
  rig.mesh.geometry.morphTargetsRelative = true;
  rig.mesh.updateMorphTargets();
}
