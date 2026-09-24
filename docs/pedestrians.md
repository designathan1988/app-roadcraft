# Pedestrians

The city uses 80 distinct Rocketbox characters, including adults, children,
casual clothing, business clothing and civilian professions. The roster is
`src/render/citizenCatalog.ts`; source IDs, content hashes and geometry counts
are recorded in `public/models/citizens/catalog.json`.

The rigged character meshes and clothing come from the [Microsoft Rocketbox
Avatar Library](https://github.com/microsoft/Microsoft-Rocketbox), licensed
under MIT. The Rocketbox FBX rigs were retargeted to clips from the [Quaternius
Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html),
licensed CC0, and exported as GLB. Their license texts are included beside the
GLB files and in the shipped JavaScript bundle's scene metadata. No asset
server is contacted at runtime.

The GLBs carry no animation clips. Pedestrians play the Rocketbox captures in
`src/render/motion/` and people in or on vehicles the IK poses in
`src/render/riderPoses.ts`; the retargeted Quaternius clips were never played
and were stripped by `scripts/strip-citizen-animations.mjs`, which roughly
halved the download (see [performance.md](performance.md#loading-the-crowd)).

`src/render/riggedCitizens.ts` requests only models that enter the camera view,
with at most three concurrent loads. It bakes the Rocketbox clips and the rider
poses onto each loaded rig, into bone palettes, once. The dynamic palette begins with 16 rows per model and grows only
when needed. Visible citizens share instanced meshes and upload only
their current bone row per frame. Each pedestrian's animation phase advances
with its actual travelled distance; idle, walking and jogging blend smoothly.
One texture update range must cover exactly one row: three.js uploads a
`DataTexture` range as a single row, so a range spanning multiple citizens
freezes the animation of repeated models.

Full-detail geometry is retained for close views. Two additional index-only
LODs reduce distant triangles while using the same vertices, materials and
skin weights. They are generated offline; the frame loop only selects an
existing geometry. Distant citizens do not render a separate shadow pass.

## Rebuilding assets

1. Run `python scripts/fetch-citizens.py` with Pillow available. It downloads the
   selected source files from a pinned Rocketbox revision into the temporary
   `roadcraft-rocketbox` directory.
2. Start the development server on port 5198 (or set `ROADCRAFT_ASSET_DEV_URL`).
   Set `CHROME_PATH` if an installed Playwright browser is unavailable.
   Set `ROADCRAFT_ANIMATION_SOURCE` to the licensed Quaternius
   `UAL1_Standard.glb`, then run `node scripts/convert-citizens.mjs <source-name>`
   for each source name in that directory's `source-manifest.json`. The clips
   pose each rig (its exported rest pose is the last frame they leave) but are
   not exported.
3. Run `python scripts/pack-citizens.py` with numpy and Pillow. It welds identical
   complete vertices, combines matching material groups and compresses textures.
   It preserves every original high-detail triangle and skin weight.
4. Copy only files listed by the generated `packed/catalog.json` into
   `public/models/citizens/`, including the catalog itself. Regenerate the
   TypeScript roster from those IDs. Do not copy rejected working models.
5. Run `node scripts/citizen-lods.mjs`, then
   `node scripts/strip-citizen-animations.mjs`: it removes clips from a GLB
   exported by an older converter, keeps the catalog's hashes in step, and
   changes nothing on a file that has none. Then run the asset tests, build and
   run `node scripts/verify-citizens.mjs` against the production bundle. The
   latter exercises all 80 models and repeated instances in the actual game.

The build imports the reviewed GLBs through Vite asset URLs. Unreferenced
legacy files under `public/` are not included in the production output.

`src/sim/peds/sidewalk.ts` builds walk, corner and crossing paths.
`src/sim/peds/crossingFsm.ts` controls walking, queuing and signals.
`src/sim/peds/clearance.ts` checks personal space against pedestrians,
street furniture, user poles and vehicles in world coordinates. A blocked
crossing exit retains its crossing occupancy until the footway clears.
