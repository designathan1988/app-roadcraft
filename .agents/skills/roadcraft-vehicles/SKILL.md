---
name: roadcraft-vehicles
description: Make cars for the Roadcraft game (three.js) as .glb - sedans, hatchbacks, SUVs, vans and variants - with a tested generator and automatic checks for holes, dents, inside-out faces and the game's rules. Use whenever asked to create, generate, fix or improve a car or van model for Roadcraft. Never hand-model a car body for this game.
---

# Roadcraft vehicles

**You do not sculpt cars.** A tested generator (`scripts/car_build.py`) builds every car from a short
JSON spec. Its body is one closed surface lofted through cross-sections, so it cannot have holes, open
seams or dents; glass, pillars and shut lines are regions of that surface; doors are cut-outs on hinges;
arches have liners. Your job is to choose numbers, run one command, and look.

Hand-written car geometry is what this skill exists to avoid: the two hand-made sedans that came before it
had 555-617 px of background showing through the arches and door seams, and 10% dented paint.

## Workflow (every car)

1. Start from the closest spec in `assets/cars/` (`sedan_01`, `hatch_01`, `suv_01`, `van_01`). Copy it
   to `incoming/vehicles/specs/<kind>_<nn>.json`, set `name` (= file name) and `kind`.
2. Change numbers only (see `references/spec.md`: every key, its range, and a symptom -> fix table).
   Keep `length`, `width`, `height` at the game's sizes for the kind (the simulation drives exactly those).
3. Run:

       python .agents/skills/roadcraft-vehicles/scripts/make_car.py --out incoming/vehicles <spec.json> [...]

   It builds the .glb, then FAILS it automatically on: wrong size/axes/node or material names, triangle
   budget, inside-out parts, dents, slivers, open seams, and HOLES (background seen through the car).
4. A FAIL names the reason: fix the spec (or the generator, see below) and rerun. Never deliver a FAIL.
5. LOOK, side by side: open `<out>/<name>/<name>_sheet.png` and the approved reference
   `assets/reference/<kind>_01.jpg` together with your image viewer. Answer in writing, in the reply:
   - Is the silhouette clearly the right kind of car from the side AND from above (the game view)?
   - Is anything worse than the reference (proportions, lamps, bumpers, wheels in the arches)?
   - Does `<name>_holes.png` show any red? (red = see-through)
   If anything is worse than the reference, it is not done.
6. Deliver `incoming/vehicles/<name>/` (glb, spec, sheet, holes image, report.json) and one line per car:
   OK, size, triangles, holes px, dents %.

## Changing the generator

If a look cannot be reached with the spec (a pickup bed, a roof rack, a different lamp shape), extend
`car_build.py` - add a part as a CLOSED volume (see `box`, `rounded_box`, `bumper`), parented to `body`,
with one of the game's material names - and rerun `make_car.py` on all four reference specs: they must
all still pass and still look like their references.

## What the checks mean (and their limits)

- **holes**: the car is drawn white on magenta from 8 directions; magenta enclosed by the car is a hole.
  Limit 6 px (anti-aliasing specks are 2-4; a real gap is tens to hundreds). Blind spot: a gap that joins
  the open space under the car is not counted - the generator's arch liners close those.
- **dents**: share of concave folds sharper than 18 deg on paint; limit 6% (smooth generated cars: ~3%).
- **inside-out**: a closed part with negative volume is invisible in the game (it draws front faces only).
- **slivers**: triangles thinner than 1:30; limit 40.
- Budget: 6000 triangles for cars and vans (`check_glb.py`).

## Not covered yet

Buses, trucks, motorcycles and bicycles need their own generators; do not hand-model them - say so.
Everything you write is in English. License of all output: CC0-1.0.
