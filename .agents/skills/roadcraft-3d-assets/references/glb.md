# Vehicles, props and building parts (.glb)

Start every model from `assets/blender_glb_template.py`: it resets Blender, uses metres, names
materials, puts wheel pivots on the axles and exports with the right settings. Replace `build()`.

## Axes (the one mistake that costs a round)

In Blender: front toward **-Y**, left side at **+X**, ground at **z = 0**. The exporter turns that into
glTF +Z forward, +Y up. `check_glb.py` proves it from the wheel positions.

## Vehicles

- Sizes: `references/conventions.md` (within 2%; the simulation drives exactly those sizes).
- Origin: on the ground, centred in x, mid-wheelbase in z.
- Nodes (exact names; the game animates them):
  - `body`: the shell.
  - `wheel_FL`, `wheel_FR`, `wheel_RL`, `wheel_RR` (two-wheelers: `wheel_F`, `wheel_R`): pivot at
    the axle centre; spins about local X; the fronts also steer about Y.
  - `door_FL`, `door_FR` (+ `door_RL`, `door_RR`): pivot on the hinge line.
  - `seat_driver`, `seat_1`...: empties at the hip point of each seat.
  - `lamp_head_L/R`, `lamp_tail_L/R`, `lamp_brake_L/R`, `lamp_turn_FL/FR/RL/RR`: small separate meshes.
- Materials (exact names): `paint` (white base colour, the game tints it; metallic 0.6, roughness
  0.35), `glass` (#1a2228, roughness 0.05, alpha 0.85), `trim` (matte black), `chrome`, `tire`
  (#1b1b1b, roughness 0.9), `rim`, `lamp_head`, `lamp_tail`, `lamp_turn` (emission off), `interior`.
  No textures unless needed (512 px max).
- Shape: build the side PROFILE as curves (bonnet, windscreen rake, roof, boot, sills, wheel arches),
  loft cross-sections along it (flat underbody, rounded sill, belt line, tumblehome to the roof),
  then cut the glasshouse as faces of the same surface. Bevel every panel edge. Spend triangles on
  the silhouette, not on bolts.
- Check: `python scripts/check_glb.py <file>.glb --kind sedan`.

## Props (street furniture)

Origin on the ground under the centre; the side people use faces +Z. Descriptive material names
(`metal_dark`, `wood`, `glass`, `concrete`, `paint`). 200-1500 triangles. Typical sizes (metres,
length z / height y / width x): bench 1.8 / 0.9 / 0.6; bin 0.5 / 0.9 / 0.5; bus shelter 3.5 / 2.6 / 1.5;
street lamp 0.4 / 8 / 0.4 (an empty named `light` at the lamp); hydrant 0.3 / 0.75 / 0.3; bollard
0.2 / 0.9 / 0.2.
Check: `python scripts/check_glb.py <file>.glb --kind prop --size <len_z> <height_y> <width_x>`.

## Building parts

The game assembles facades from parts in a COMPONENT frame: X along the facade, Y up, Z out of the
wall, origin at the bottom-centre of the part on the wall plane, metres. Balconies, awnings,
canopies, cornices: 100-1500 triangles each; ask for the exact part list before making many.
