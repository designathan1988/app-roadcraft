# Pedestrians

The city currently uses three reviewed Rocketbox citizens: `female_08`,
`male_03`, and `male_12`. Additional licensed models are staged under
`public/models/citizens/`, but the selection in `src/render/agents.ts` remains
small while movement and crowd performance are validated in the game.

The rigged character meshes and clothing come from the [Microsoft Rocketbox
Avatar Library](https://github.com/microsoft/Microsoft-Rocketbox), licensed
under MIT. The walk, jog and idle clips come from the [Quaternius Universal
Animation Library](https://quaternius.com/packs/universalanimationlibrary.html),
licensed CC0. Their license texts are included beside the GLB files. The
Rocketbox FBX rigs were retargeted to those clips and exported as GLB. No asset
server is contacted at runtime.

`src/render/riggedCitizens.ts` bakes each selected rig's clips into bone
palettes at load time. Visible citizens share instanced meshes and upload only
their current bone row per frame. Each pedestrian's animation phase advances
with its actual travelled distance; idle, walking and jogging blend smoothly.
One texture update range must cover exactly one row: three.js uploads a
`DataTexture` range as a single row, so a range spanning multiple citizens
freezes the animation of repeated models.

`src/sim/peds/sidewalk.ts` builds walk, corner and crossing paths.
`src/sim/peds/crossingFsm.ts` controls walking, queuing and signals.
`src/sim/peds/clearance.ts` checks personal space against pedestrians,
street furniture, user poles and vehicles in world coordinates. A blocked
crossing exit retains its crossing occupancy until the footway clears.
