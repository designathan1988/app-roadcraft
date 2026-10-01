# Conventions: the game's frames, units and file locations

## The game

Roadcraft is a browser city/traffic game in three.js r186. The camera is ORTHOGRAPHIC, far away,
looking down at about 35 degrees; lighting is PBR (`MeshStandardMaterial`). Thousands of people and
vehicles are on screen: silhouettes matter, small details do not, triangle budgets are real.

## Two kinds of asset, two frames

| Kind | Format | Units | Up | Front | Left | Origin |
|---|---|---|---|---|---|---|
| People items (hair, hats, clothes, shoes) | `.obj` + `.mhclo` + `.mhmat` + `_diffuse.png` | DECIMETRES | +Y | +Z (the face) | +X | base.obj's own (body centred, head top y ~ 8.5, feet y ~ -8.2) |
| Vehicles, props, building parts | `.glb` (glTF 2.0 binary) | METRES | +Y | +Z | +X | on the ground (y = 0), centred in x |

glTF's own rule: +Y up, the front of an asset faces +Z, one unit is one metre. Blender is Z-up; its
glTF exporter (`export_yup=True`) maps Blender (x, y, z) to glTF (x, z, -y), so in Blender model the
front facing **-Y**, the left at **+X**, the ground at z = 0.

## The people model

People are the MakeHuman base mesh "hm08" (19158 vertices, CC0), morphed by sliders (sex, age,
weight, height, proportions) and skinned to a game-engine skeleton. A hair or garment is a MakeHuman
PROXY: each of its vertices is pinned to three base-mesh vertices (barycentric weights) plus an offset
scaled by the size of the head (hair) or body. Whatever the sliders do, the proxy follows; that is
why a loose GLB cannot be worn - it must be a proxy.

- base.obj: `https://raw.githubusercontent.com/makehumancommunity/mpfb2/afb9f530a7c2741dedb8df0ebae2e0b183caec21/src/mpfb/data/3dobjs/base.obj`
  (`scripts/mh.py` finds it in the repo cache or downloads it). Vertex ORDER is the index everything uses.
- Groups that matter: `body` (the skin, 13380 vertices), `helper-hair` (428 vertices: a shell around
  the head that runs down the back to y ~ 2.0; ALL hair binds to it, as MakeHuman's own long hair does).
- Landmarks (dm): eyes (+-0.31, 7.28, 1.25); head joint (0, 6.98, 0.16); neck (0, 5.89, 0.07);
  shoulders (+-1.68, 5.25, 0.15); top of head y 8.49.
- The game's importer: `scripts/import-makehuman-proxies.mjs` (repo). Fitting: `src/people/body/proxy.ts`.
  Crowd drawing: `src/render/people/personRig.ts` (texture read per VERTEX only; hair dyed as
  `colour * (0.45 + 1.1 * luminance)`; triangles with mean vertex alpha < 0.45 dropped; the scalp under
  hair painted in the hair colour).

## Vehicles (the simulation's sizes; models must match within 2%)

| id | length (z) | width (x) | height (y) | triangles |
|---|---|---|---|---|
| hatch | 3.90 | 1.72 | 1.48 | <= 6000 |
| sedan | 4.70 | 1.84 | 1.45 | <= 6000 |
| suv | 4.90 | 1.95 | 1.78 | <= 6000 |
| van | 5.60 | 2.00 | 2.35 | <= 6000 |
| bus | 12.00 | 2.55 | 3.20 | <= 8000 |
| truck | 9.80 | 2.50 | 3.50 | <= 8000 |
| motorcycle | 2.10 | 0.80 | 1.25 | <= 3000 |
| bicycle | 1.80 | 0.60 | 1.10 | <= 3000 |

## Where things go

- Work and deliver in `C:\Codex-Shared\Road\incoming\<category>\<name>\`. `incoming/` is git-ignored.
- Never write into `src/` or `public/`: the game team imports from `incoming/` and verifies in the game.
