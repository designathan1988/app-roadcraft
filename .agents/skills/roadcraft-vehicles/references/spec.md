# Car spec reference

Units: metres. Distances `*_d` are measured from the FRONT tip of the car backwards. Heights `*_y` are
above the ground. Anything left out takes the sedan default (`DEFAULT` in `scripts/car_build.py`).

## Game sizes (do not change)

| kind | length | width | height | budget |
|---|---|---|---|---|
| hatch | 3.90 | 1.72 | 1.48 | 6000 |
| sedan | 4.70 | 1.84 | 1.45 | 6000 |
| suv | 4.90 | 1.95 | 1.78 | 6000 |
| van | 5.60 | 2.00 | 2.35 | 6000 |

Width excludes the mirrors (as on a spec sheet). The generator makes the finished car exactly this wide.

## Keys

| key | meaning | typical |
|---|---|---|
| `wheelbase` | front to rear axle | hatch 2.45-2.55, sedan 2.70-2.85, suv 2.80-2.95, van 3.2-3.6 |
| `front_overhang` | front tip to front axle | 0.70-0.95 |
| `wheel.radius` / `width` | tyre | 0.29-0.31 small, 0.32-0.34 sedan, 0.36-0.38 suv |
| `wheel.rim` | rim radius / tyre radius | 0.60-0.70 |
| `wheel.spokes` | number of spokes | 4-7 |
| `clearance` | underbody height | 0.14 car, 0.20-0.24 suv |
| `arch_gap` | tyre to arch | 0.04-0.06 |
| `arch_flare` | how far the arches bulge out | 0-0.04 |
| `profile.nose_y` | top of the nose at the tip | 0.58-0.66 car, 0.80-0.90 suv |
| `profile.hood_front_y` / `hood_rear_y` | bonnet height at its front / at the windscreen base | 0.78/0.98 car |
| `profile.cowl_d` | windscreen base | 1.1 hatch, 1.5 sedan, 0.9 van |
| `profile.roof_front_d` / `roof_rear_d` | where the roof starts / ends | sets windscreen and rear-window rake |
| `profile.deck_d` / `deck_y` | base of the rear window / boot height | sedan: 3.8 / 1.03; hatch: deck_d near length |
| `profile.tail_y` | height of the tail | 0.95-1.05 car |
| `profile.belt_front_y` / `belt_rear_y` | window-sill line (rising = wedge) | 0.98 / 1.04 |
| `profile.front_bottom_y` / `rear_bottom_y` | underside at the very ends | 0.30 / 0.36 |
| `profile.b_pillar_d` | B-pillar position (4 doors) | default: mid roof |
| `plan.corner_front` / `corner_rear` | corner radius seen from above | 0.20-0.35 |
| `plan.taper_front` / `taper_rear` | narrowing towards the ends | 0-0.06 |
| `section.roof_width` | roof width / body width | 0.72-0.80 car, 0.85-0.92 van |
| `section.bulge` | side bulge | 0.015-0.03 |
| `section.shoulder_inset` | step from body side to glass | 0.04-0.07 |
| `pillars.a` / `b` / `c` | pillar widths | 0.08 / 0.10 / 0.12-0.26 |
| `doors` | 2 or 4 (side doors) | |
| `lamps.head` / `tail` | [width, height] | head 0.32-0.40 x 0.11-0.14 |
| `lamps.head_y` / `tail_y` / `head_x` | lamp height / height / lateral position (share of half-width) | |
| `bumpers.height` / `protrude` / `front_y` / `rear_y` / `wrap` | bumper band | 0.20 / 0.04 / 0.40 / 0.45 / 0.42 |
| `grille.width` / `height` | grille | 0.6 x 0.13 |
| `seats.hip_y` / `front_d` / `rear_d` / `x` | seat empties for the people | 0.52 car, 0.70 suv |

## Symptom -> fix

| you see | change |
|---|---|
| looks like a wagon, not an SUV | raise `nose_y`, `hood_*_y`, `belt_*`, `deck_y`; bigger `wheel.radius`; `clearance` 0.22 |
| windscreen too upright / too flat | move `roof_front_d` back (more rake) or forward |
| boot too long / slab-like | `deck_d` later (shorter boot), lower `deck_y`, larger `corner_rear` |
| nose too blunt | lower `nose_y`, larger `corner_front`, more `taper_front` |
| roof too narrow / too wide from the front | `section.roof_width` |
| lamps lost from above | bigger `lamps.head` / `tail`, move `head_x` out |
| wheels look small in the arches | `wheel.radius` up, `arch_gap` down |
| FAIL size | you changed `length`/`width`/`height`: restore the game size for the kind |
| FAIL triangles | fewer `wheel.spokes`; shorter spec values do not matter - report the case |
| FAIL holes / dents / inside-out | the generator was changed: undo the change, or close the new part |
