---
name: roadcraft-3d-assets
description: Make 3D assets BY CODE for the Roadcraft game (three.js) - hair, hats, clothes and shoes for its MakeHuman people (.obj + .mhclo + .mhmat + texture), and vehicles, street props or building parts (.glb). Use when asked to create, generate, model or fix any 3D model, mesh, hairstyle, garment, car or prop for Roadcraft. Not for game code, animation or rigging.
---

# Roadcraft 3D assets

You produce assets with SCRIPTS, check them with SCRIPTS, and look at RENDERS before you deliver.
Never hand-write geometry numbers in a reply; never deliver without passing the checker and looking
at the previews. All the hard parts (scalp sampling, body collision, .mhclo binding, the game's rules,
crowd-accurate renders, GLB axis checks) are already solved in `scripts/`: use them, do not rewrite
them. Everything you write (code, file names, comments) is in English.

## 0. Before anything

1. Read `references/conventions.md` (units, axes, where files go). Then the reference for the job:
   hair or hats -> `references/hair.md`; clothes or shoes -> `references/clothes.md`;
   vehicles, props, building parts -> `references/glb.md`.
2. Check the tools once: `python --version` (3.10+), `python -c "import numpy"`, and Blender
   (`blender --version`, or `C:\Program Files\Blender Foundation\Blender *\blender.exe`; set the
   `BLENDER` environment variable if it is elsewhere). If numpy or Blender is missing, say so and stop.
3. Deliver into `C:\Codex-Shared\Road\incoming\<category>\<name>\` (category: hair, clothes, shoes,
   hats, vehicles, props, building-parts). Never write into `src/` or `public/`.

## 1. Hairstyles: the fast path (no trial and error)

A hairstyle is a small JSON spec. The generator does the geometry; you choose parameters.

1. Start from the closest spec in `assets/hair_styles/` (straight, layered + curtain bangs, waves,
   curly, high ponytail, back braid, half-up bun, box braids). Copy it, rename `name` (and the file)
   to `hair_<f|m|u>_<style><nn>`, change ONE group of parameters at a time (`references/hair.md` has
   every parameter and a symptom -> fix table).
2. Run everything in one command (it builds, binds the .mhclo, checks every rule, renders):

       python .agents/skills/roadcraft-3d-assets/scripts/make_hair.py --out incoming/hair --sheet incoming/hair/<spec>.json [...]

   It prints `OK` or `FAIL <reason>` per style. A FAIL names the rule; fix the spec, rerun.
3. LOOK at `preview_34.png`, `preview_back.png`, `preview_side.png` and `preview_iso.png` of each
   style with your image viewer (and `contact_sheet.png` for the batch; `assets/hair_styles/reference_sheet.jpg` shows the 8 starter styles - the minimum quality bar). The renders use the game's
   own crowd colouring, so they are what the player sees. Judge with the checklist in
   `references/hair.md` ("Looking at the previews"). If something is wrong, use the symptom table.
4. Two or three rounds is normal. If a look cannot be reached with parameters, extend
   `hair_build.py` (a new `gather` type, a new clump shape) instead of fighting it - and keep the
   safety pass and the checker passing.

## 2. Anything else (garments, hats, shoes, vehicles, props)

1. Write `make_<name>.py`, a Blender script run headless, that builds the model from scratch:
   - people items: model ON the MakeHuman base body (load it with `scripts/mh.py`), then bind with
     `scripts/bind_mhclo.py --kind clothes|shoes|hat` (see `references/clothes.md`);
   - GLB items: start from `assets/blender_glb_template.py` (axes, named materials, wheel pivots,
     export settings already right), then check with `scripts/check_glb.py`.
2. Shape quality rules (both kinds): build from curves and profiles (lofts, sweeps, lathes,
   bevels), not stacked boxes; smooth shading on curved parts, sharp on creases; no internal faces,
   no duplicate vertices, no zero-area triangles; spend triangles on the SILHOUETTE - the game
   camera is far away and looks down at about 35 degrees.
3. Render (Workbench, orthographic: front, side, 3/4, and from above at 35 degrees), look, fix.

## 3. Delivery (every asset)

In `incoming/<category>/<name>/`: the asset files, the generating script or spec, the previews,
and `report.json` (`make_hair.py` writes it for hair; for others write: name, triangles,
bounding box, materials, license "CC0-1.0", the exact command, and the checker's output).
In the reply: one line per asset, `OK` with its triangle count, and anything you could not meet.

## Hard rules

- Only original geometry made by your scripts. No downloaded models, no brands or logos, no copies
  of real products. Everything is CC0-1.0. The single exception is MakeHuman's base.obj (CC0), which
  the scripts fetch at a pinned commit.
- Never edit the checkers to make an asset pass. If a rule seems wrong, say so in the reply.
- Do not reorder or weld base.obj vertices; do not change `SCALE_REFS`.
