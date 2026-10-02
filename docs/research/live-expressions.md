# Live facial expressions

Primary sources consulted 2026-10-01:

- [MakeHuman targets](https://static.makehumancommunity.org/assets/creatingassets/maketarget/targets.html):
  targets preserve base vertex numbering and topology.
- [Khronos morph targets](https://github.com/KhronosGroup/glTF-Tutorials/blob/main/gltfTutorial/gltfTutorial_017_SimpleMorphTarget.md):
  relative vertex displacement arrays are blended with animated weights.
- [three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html):
  per-instance morph weights are stored in morphTexture and updated with setMorphAt.

Import a bounded set of existing CC0 units, including ancestry variants; blend
them by the authored body. Fit expression shapes through the same rig/proxy
transform as the neutral body. Build them on asset load, never during draw.
Drive independent per-person weights; upload once after the batch is written.
Keep the stage behind expressions=live until measured and reviewed.
