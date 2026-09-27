# Rocketbox customization plan

## Source findings

- The [Microsoft Rocketbox repository](https://github.com/microsoft/Microsoft-Rocketbox)
  ships 115 rigged avatars under MIT. Its README describes a shared animation
  rig and compatible texture elements. The [Microsoft Research overview](https://www.microsoft.com/en-us/research/blog/microsoft-rocketbox-avatar-library-now-available-for-research-and-academic-use/)
  describes head/body combinations and texture or outfit mixing.
- The [technical paper](https://www.frontiersin.org/journals/virtual-reality/articles/10.3389/frvir.2020.561558/full)
  qualifies those possibilities: face and hand UVs are standardized, so face
  textures can be exchanged with image editing and retouching. Garments are
  part of each body mesh. Hair and clothing interchange are limited and need
  compatible geometry and weights. Extreme uniform scaling distorts skin
  weights, texture and proportions. Children must use child bodies.
- The [Headbox toolkit](https://github.com/openVRlab/Headbox) and its
  [paper](https://www.microsoft.com/en-us/research/uploads/prod/2022/05/HeadBox_A_Facial_Blendshape_Animation_Toolkit_for_the_Microsoft_Rocketbox_Library.pdf)
  describe facial bone poses and 15 visemes, 48 FACS controls and 52 ARKit
  blendshapes. The released `Female_Adult_01_facial.fbx` imports with 175
  shape keys in Blender (plus Basis). The packed GLBs currently shipped by
  Roadcraft contain zero morph targets because conversion reads the plain
  `*.fbx` source.

## Pilot and gates

1. Keep the existing Rocketbox rig and actual child models. Prove a small
   appearance pilot on one adult and one child, in isolated close views, before
   touching the street roster.
2. For the child pilot, recolor clothing on a copy of an existing child body
   while preserving skin and hair pixels. Inspect the texture atlas and the
   result in Blender and in the game. A second unique child appearance must
   remain age-appropriate and keep compatible family dress.
3. For the adult pilot, import the official `*_facial.fbx`, retain a selected
   blink, smile, brow and jaw subset, and export glTF with morph targets. Check
   vertex counts, skin weights, bind pose, texture integrity, download size and
   close-view expression. Do not include the separate OpenFace or Oculus
   demo dependencies.
4. Add distinct per-person expression weights to the instanced renderer only
   after the exported pilot is sound. Agent or activity state chooses blink,
   gaze, speaking and smile; rendering never writes simulation state.
5. Swap a clothing or hair mesh only between compatible rigs after checking
   seams, weights and seated and walking poses. A texture recolor is an
   appearance variant; it must not be described as arbitrary garment exchange.
6. Promote the pilots to the runtime roster after `npm run check`, the citizen
   asset validator, production visual captures with build stamp, adult and
   child seat-fit checks, and a performance comparison pass.

The immediate defects remain separate: child casting may never fall back to
scaled adults, rear passengers need their own seated pose, and pedestrian
navigation must pass the simulation regressions.
