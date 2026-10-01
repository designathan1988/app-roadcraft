# People assets (MakeHuman CC0 import, step H0)

`scripts/import-makehuman.mjs` fetches MakeHuman asset data from MPFB2 at a
pinned commit and packs it into `public/models/people/`. It is the first step of
the Person track in `docs/design/agency-architecture.md` section 6.

## Source and licence

- Repository: https://github.com/makehumancommunity/mpfb2, directory `src/mpfb/data/`
- **Pinned commit: `afb9f530a7c2741dedb8df0ebae2e0b183caec21`** (master, 2026-09-29,
  "Merge pull request #444"). Constant `MPFB2_SHA` in the script.
- MPFB2's `LICENSE.md` section C puts every asset under CC0 1.0: base mesh and
  proxies, targets and modifiers, textures, clothes, rigs, poses and
  expressions, and JSON mesh data. `base.obj` carries its own CC0 header (the
  script checks it), and `weights.game_engine.json` has `"license": "CC0"` (also
  checked). See also https://static.makehumancommunity.org/about/license.html.
- MPFB2 **code** is GPLv3 (MakeHuman is AGPL). None of it is used or ported:
  the OBJ, target, vertex-group, rig and weight parsers in the script are
  written from the file formats.
- `LICENSES.json` lists every source file used (path, `CC0-1.0`, author, raw URL,
  SHA, output file) and every file in `src/mpfb/data/` that was skipped, with the
  reason. `LICENSE-MakeHuman-CC0.txt` is the notice plus the CC0 legal text.

## Re-running

```
node scripts/import-makehuman.mjs            # downloads what is not cached
node scripts/import-makehuman.mjs --offline  # cache only
npx vitest run tests/world/peopleAssets.spec.ts
```

Downloads go to `.cache/makehuman/<sha>/` (git-ignored): the GitHub tree listing
(one API call) and the raw files, 8 at a time. The first run downloaded
**43.8 MB** (43 819 939 bytes, the `.target.gz` files stay compressed) in 32 s;
a cached run takes about 4 s. The output folder is deleted and rewritten on
every run, so the result is a pure function of the pinned SHA.

## Output (measured)

| File | Bytes | gzip -9 |
|---|---:|---:|
| `base.bin` | 711 736 | 563 091 |
| `base.json` | 28 832 | 9 857 |
| `targets-macro-pca.bin` | 10 541 002 | 8 525 459 |
| `targets-macro-pca.json` | 65 651 | 6 807 |
| `targets-local.bin` | 6 641 856 | 1 511 880 |
| `targets-local.json` | 140 920 | 18 135 |
| `modifiers.json` | 83 066 | 7 173 |
| `skeleton-game-engine.json` | 21 903 | 3 665 |
| `weights-game-engine.bin` | 229 896 | 63 385 |
| `proxies/index.json` | 385 | 289 |
| `LICENSES.json` | 623 428 | 12 561 |
| `LICENSE-MakeHuman-CC0.txt` | 7 580 | 3 016 |
| **total** | **19 096 255** | **10 725 318** |

The macro targets were first packed as plain sparse deltas: 40.9 MB, 83 % of
a 49.5 MB pack. They are now a principal-component pack (below), a quarter of
the size, with every target reproduced within half a millimetre.

All binary data is little-endian. All packs share the hm08 vertex index space
(19 158 vertices), so a target, a weight or a joint-cube reference addresses
the same vertex everywhere.

### `base.bin` + `base.json`

`base.json.sections[]` gives `{ name, type, itemSize, count, byteOffset, byteLength }`
for each section (each starts 4-byte aligned):

| Section | Type | Per item | Count |
|---|---|---|---|
| `positions` | float32 | x, y, z | 19 158 vertices |
| `uvs` | float32 | u, v | 21 334 UV coordinates |
| `faceVerts` | uint16 | 4 vertex indices | 18 304 quads |
| `faceUvs` | uint16 | 4 UV indices | 18 304 |
| `faceGroup` | uint8 | index into `faceGroups` | 18 304 |

- Units: decimetres, +Y up (the raw OBJ frame). The OBJ has only quads; a
  triangle would repeat its last corner.
- UVs have their own index (seams), as in the OBJ; the runtime splits vertices
  where a vertex has several UVs.
- `faceGroups` / `faceGroupCounts`: the OBJ `g` groups (`body`, the `helper-*`
  proxy fitting shells, and the `joint-*` cubes). The game renders `body`;
  the helpers are kept because clothes, hair, eyes, teeth and eyelash proxies
  are fitted to them (H3), the joint cubes because the skeleton is fitted
  from them (H2).
- `vertexGroups`: name -> inclusive `[first, last]` vertex ranges (from
  `basemesh_vertex_groups.json`): `body`, `HelperGeometry`, `JointCubes`,
  `Left`/`Mid`/`Right`, every `helper-*` and `joint-*`.
- `measurementVertices`: the vertex pairs `hm08_config.json` uses for
  dimensions.
- **Genitals**: the `helper-genital` group (200 vertices, 182 faces) is not
  shipped. Its faces are dropped, its vertex positions are zeroed (the slots
  stay so the index space is unchanged; `zeroedVertices` lists them), and no
  target entry or weight references those vertices.

### `targets-macro-pca.bin` + `.json`

All 348 `targets/macrodetails` targets (universal gender/age/muscle/weight,
ethnic african/asian/caucasian, `height/*`, `proportions/*`). They are dense -
each moves about 19 000 vertices - and they are all combinations of a handful
of factors, so they are stored as a basis:

- `components` (64) basis shapes, each a full `vertexCount x 3` delta in int16
  with its own scale (`layout.basis.scales[k]`), laid out component by
  component;
- `coefficients`: float32 `[348][components]`, the target's weight on each
  basis shape (rows in `targets[].row` order);
- a sparse residual per target, `[uint16 vertex][pad][int16 dx, dy, dz]` like
  the regional pack, holding every vertex the basis leaves more than
  `residualTolerance` (0.005 dm = 0.5 mm) off. It is computed against the
  QUANTISED basis, i.e. against what the runtime rebuilds.

Target i = sum_k coefficients[i][k] * basis[k] + residual[i]. A blend of
targets with weights w is sum_k (sum_i w_i coefficients[i][k]) * basis[k] +
sum_i w_i residual[i]: one pass over the basis, whatever the blend.

Measured: the 64 components carry 99.99979 % of the targets' energy; 386 905
residual entries in all; residual quantisation error 3.3e-6 dm. The basis was
found by an uncentred decomposition through the 348 x 348 Gram matrix (Jacobi)
in the importer itself (about 5 s). `tests/world/peopleAssets.spec.ts` rebuilds
sampled targets and compares them with the source files when the importer's
cache is present.

### `targets-local.bin` + `.json`

Layout: `[uint16 vertex index x N][pad to 4 bytes][int16 dx, dy, dz x N]`;
`json.layout` gives the byte offsets and `entryCount` = N. Each entry of
`json.targets[]` is `{ name, group, start, count, scale, maxAbs, maxQuantError }`:
its entries are `[start, start + count)` and a delta is `int16 * scale`
decimetres, with `scale = maxAbs / 32767` per target. Entries whose delta is
zero on all axes are dropped (targets are sparse).

- `targets-local`: 802 regional targets from `arms`, `asym`, `breast`,
  `buttocks`, `cheek`, `chin`, `ears`, `eyebrows`, `eyes`, `feet`, `forehead`,
  `hands`, `head`, `hip`, `legs`, `mouth`, `neck`, `nose`, `pelvis`, `stomach`,
  `torso`: 830 232 entries. Breast size/shape targets are kept (standard body
  shape).
- **Quantisation error** (measured against the parsed source values): at most
  half a step, i.e. relative error <= 1.53e-5 of each target's largest delta.
  Worst absolute error: **2.8e-5 dm = 0.003 mm**. The source files themselves are written with 3
  decimals (1e-3 dm = 0.1 mm), so the packing adds less than a sixth of the
  source's own rounding.
- `modifiers.json`: `macro` is `macrodetails/macro.json` (macro slider ranges),
  `regional` is `targets/target.json` (which targets pair into which slider,
  left/right and opposites) minus the genital and expression categories.

### `skeleton-game-engine.json` + `weights-game-engine.bin`

- `bones[]`: the 53 `game_engine` bones (`Root`, `pelvis`, `spine_01..03`,
  `neck_01`, `head`, clavicles, arms, hands, three joints per finger, thighs,
  calves, feet, balls) with `parent`, `roll`, `connect`, `inheritRotation`,
  `inheritScale`, and for `head` and `tail` the fitting strategy: `CUBE` (mean of
  the joint-cube vertex group `cubeName`) or `MEAN` (mean of `vertexIndices`),
  plus MPFB's `defaultPosition` (metres, Blender frame +Z up) for reference.
- `weights-game-engine.bin`: `[uint8 joint x 4 per vertex][uint16 weight x 4 per vertex]`
  (weights at byte offset `4 * vertexCount`). Each vertex keeps its 4 largest
  influences, renormalised; a weight is `value / 65535` and every weighted
  vertex sums to exactly 65 535 (rounding goes to the dominant joint).
  981 vertices had more than 4 influences and were truncated; the 200
  unweighted vertices are exactly the zeroed genital helper.

### `proxies/index.json`

Empty (`items: []`). **MPFB2 at the pinned commit ships no clothes, hair,
eyebrows, eyelashes or proxy files** (`.mhclo`, `.proxy`, `.mhmat`) in
`src/mpfb/data/`; those come in the separate MakeHuman system asset pack and
are the job of step H3 (with a per-asset licence check, since that pack
mixes CC0 and CC-BY items).

## Skipped (all listed in `LICENSES.json.skipped`)

| What | Why |
|---|---|
| `targets/genitals/*` (6), `textures/mpfb_genitals.jpg`, `helper-genital` | genitals are not shipped |
| `targets/expression/*` (102) | facial expression units are animation data, not body shape; out of H0 scope |
| `targets/_images/*` (217) | slider icons |
| `textures/*.jpg`, `sss.png` (10) | all 2048 x 2048, above the 1024 px limit; the script has no resampler without a new dependency |
| `textures/notfound.thumb` | editor placeholder |
| other rigs and their weights, poses, UV layers, Blender node trees, settings, mirror and face tables (44) | not needed by the game in H0 |

Nothing was skipped for licence reasons: every file in `src/mpfb/data/` is an
asset under MPFB2's CC0 asset licence.

## Open points for H1+

- Size: settled - the macro targets ship as the 10.5 MB principal-component
  pack. The crowd can still use prototypes baked offline; the Person Creator
  loads the packs when it opens.
- Skin textures: the MPFB region masks are 2048 px; a downscale step (or a
  different skin approach) is needed before any texture is shipped.
- Proxies: import clothes/hair/eyebrows/eyelashes from the system asset pack in
  H3 with an own `.mhclo` parser.
