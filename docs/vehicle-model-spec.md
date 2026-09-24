# Roadcraft — vehicle model specification

This is the brief for anyone (a person or another AI) producing vehicle models
for Roadcraft, and the contract the game's importer will check them against.
Every number below is taken from the game's own data
(`src/sim/vehicles/archetypes.ts`, `src/render/vehicleModels.ts`); a model
that follows it drops into the game without rework.

---

## 1. How the models are seen

* **Camera:** orthographic, fixed elevation of about **48°** above the ground,
  rotating in four 90° steps around the vertical. Every model is seen from above
  and from one of four diagonals — the roof, bonnet, one side and one end are
  what the player sees most. The underside is never seen.
* **Zoom range:** from a whole city (a car is 8–10 pixels long) to a close-up
  where a car fills a third of the screen. At close zoom the **people inside
  are seen through the glass, mostly from above** — the roof and the glass
  must let the cabin read clearly.
* **Rendering:** every class is drawn with GPU instancing — hundreds of copies
  of the same model in one draw call per material. Per copy the game changes
  only the transform, the **paint colour** (see §4.2), the door angles, the
  wheel rotation and steering, and which lamps are lit.
* **Traffic side:** right-hand traffic. The **driver sits on the LEFT**.

## 2. File format and conventions

| Item | Requirement |
|---|---|
| Format | glTF 2.0 binary, **`.glb`**, one file per vehicle class |
| Units | **metres** (1.0 = 1 m) |
| Up axis | **+Y** |
| Forward axis | **+X** is the front of the vehicle |
| Side axis | **+Z** is the vehicle's RIGHT side (kerb side); −Z is the LEFT (driver's) side |
| Origin | on the road surface (Y = 0), under the middle of the body: halfway along the length and across the width |
| Scale / transforms | apply all transforms; the root node has identity rotation and scale 1 |
| Normals | outward, smooth where the surface is curved, split at hard edges |
| Geometry | closed where visible, no holes, no flipped faces, no duplicate or overlapping faces (**no z-fighting**: any two coplanar surfaces at least 2 mm apart) |
| Animations | none in the file — the game animates doors, wheels, steering and people itself |
| Compression | none required (we apply meshopt/quantisation on import) |

## 3. The eight classes and their exact dimensions

All values in metres. `x` is along the vehicle (front positive), `z` across
(right positive), `y` up from the road.

### 3.1 Overall size and wheels

| Class | Length | Width | Height (roof) | Wheel radius | Axle x positions (front first) |
|---|---|---|---|---|---|
| `hatch` (small hatchback) | 3.90 | 1.72 | 1.48 | 0.31 | +1.209, −1.209 |
| `sedan` (saloon) | 4.70 | 1.84 | 1.45 | 0.33 | +1.457, −1.457 |
| `suv` | 4.90 | 1.95 | 1.78 | 0.37 | +1.519, −1.519 |
| `van` (panel van, 2 seats) | 5.60 | 2.00 | 2.35 | 0.35 | +1.736, −1.736 |
| `bus` (low-floor city bus) | 12.00 | 2.55 | 3.20 | 0.50 | +3.36, −2.04, −3.36 |
| `truck` (cab-over box truck) | 9.80 | 2.50 | 3.50 | 0.52 | +3.626, −2.058, −3.332 |
| `motorcycle` | 2.10 | 0.80 | 1.25 | 0.30 | +0.777, −0.777 |
| `bicycle` | 1.80 | 0.60 | 1.10 | 0.34 | +0.666, −0.666 |

The body must fit inside the box length × width × height within ±2 %
(mirrors may exceed the width by up to 0.12 m each side). Wheel centres sit at
`y = wheel radius`, at the axle `x`, and at `z = ±(width/2 − tyre width/2)`.

### 3.2 Seats — where each person sits (hip point)

The **hip point** is where the occupant's pelvis rests on the cushion. The
cabin must give each seat the headroom (hip point to the inside of the roof
lining), legroom (hip point forward to the bulkhead or the seat in front) and
floor height listed.

| Class | Seat | x | z | hip y | floor y | headroom | legroom | posture |
|---|---|---|---|---|---|---|---|---|
| hatch | 0 driver | +0.029 | −0.455 | 0.483 | 0.203 | 0.941 | 1.080 | car |
| hatch | 1 rear left | −0.829 | −0.455 | 0.483 | 0.203 | 0.947 | 0.930 | car |
| hatch | 2 front passenger | +0.029 | +0.455 | 0.483 | 0.203 | 0.941 | 1.080 | car |
| hatch | 3 rear right | −0.829 | +0.455 | 0.483 | 0.203 | 0.947 | 0.930 | car |
| sedan | 0 driver | +0.002 | −0.515 | 0.465 | 0.185 | 0.918 | 1.355 | car |
| sedan | 1 rear left | −1.045 | −0.515 | 0.465 | 0.185 | 0.926 | 1.106 | car |
| sedan | 2 front passenger | +0.002 | +0.515 | 0.465 | 0.185 | 0.918 | 1.355 | car |
| sedan | 3 rear right | −1.045 | +0.515 | 0.465 | 0.185 | 0.926 | 1.106 | car |
| suv | 0 driver | +0.224 | −0.570 | 0.551 | 0.271 | 1.148 | 1.195 | car |
| suv | 1 rear left | −0.854 | −0.570 | 0.551 | 0.271 | 1.168 | 1.150 | car |
| suv | 2 front passenger | +0.224 | +0.570 | 0.551 | 0.271 | 1.148 | 1.195 | car |
| suv | 3 rear right | −0.854 | +0.570 | 0.551 | 0.271 | 1.168 | 1.150 | car |
| van | 0 driver | +0.562 | −0.595 | 0.555 | 0.275 | 1.693 | 1.074 | car |
| van | 1 passenger | +0.562 | +0.595 | 0.555 | 0.275 | 1.693 | 1.074 | car |
| truck | 0 driver | +3.168 | −0.700 | 1.600 | 1.170 | 1.270 | 1.282 | car |
| truck | 1 passenger | +3.168 | +0.700 | 1.600 | 1.170 | 1.270 | 1.282 | car |
| bus | 0 driver | +4.800 | −0.655 | 0.880 | 0.380 | 1.850 | 1.080 | car |
| bus | 1–6 passengers | rows of forward-facing pairs along both sides, x from +3.9 to −4.7, z = ±0.515 (aisle side) and ±0.955 (window side) | | 0.930 | 0.380 | 1.800 | 0.66–0.90 | chair |

*Car* posture: reclined car seat, back 20–25° from vertical, thighs along the
cushion, knees bent about 100–120°, feet forward on the floor (the driver's on
the pedals). *Chair* posture: upright bus seat, back about 10° from vertical,
knees at about 90°, feet flat on the floor in front.

Seat width (the room either side of the seat's centre line) is at least
0.26 m for every seat. The **steering wheel** sits in front of seat 0: about
0.45 m ahead of the hip point and 0.35 m above it, rim diameter 0.36–0.38 m,
its plane tilted about **26° from vertical**, top towards the driver.

### 3.3 Doors

Cars have hinged doors, hinge on the **front** edge, swinging outwards about
a vertical axis. Values: hinge line position and door length (hinge to
trailing edge).

| Class | Door | side | hinge x | hinge z | length | serves seat |
|---|---|---|---|---|---|---|
| hatch | front left / right | −1 / +1 | +0.815 | ∓0.830 | 1.006 | 0 / 2 |
| hatch | rear left / right | −1 / +1 | about −0.19 | ∓0.830 | about 0.85 | 1 / 3 |
| sedan | front left / right | −1 / +1 | +0.936 | ∓0.890 | 1.167 | 0 / 2 |
| suv | front left / right | −1 / +1 | +1.074 | ∓0.945 | 1.070 | 0 / 2 |
| van | cab left / right | −1 / +1 | +1.452 | ∓0.970 | 1.112 | 0 / 1 |
| truck | cab left / right | −1 / +1 | +4.476 | ∓1.220 | 1.704 | 0 / 1 |
| bus | two double plug doors on the RIGHT side (front and middle) | +1 | — | — | — | — |

(Rear doors of the sedan and SUV follow the same pattern: hinge just behind
the B-pillar, trailing edge over the rear wheel arch, which the door's bottom
edge must follow.)

### 3.4 Lamps (centres, metres)

| Class | Headlamps (x, y, ±z) | Tail lamps (x, y, ±z) |
|---|---|---|
| van | +2.785, 0.776, ±0.76 | −2.788, 0.855, ±0.80 |
| truck | +4.91, 0.82, ±0.93 | −4.88, 0.62, ±1.05 |
| cars | at the nose, about 0.62–0.72 up, ±(width/2 − 0.2) | at the tail, about 0.8 up, ±(width/2 − 0.15) |

Indicators: one at each front corner and each rear corner. Number plates:
front and rear, 0.52 × 0.11 m, centred. Bus: a destination blind above the
windscreen.

## 4. Structure of each file

### 4.1 Nodes (names are mandatory; the importer finds parts by name)

```
<class>                    root, identity transform
├── Body_Paint             everything painted in the body colour, doors shut
├── Body_Trim              bumpers, grille, sills, arch liners, mirror housings, black-out pillars
├── Glass                  all fixed glazing (windscreen, rear, fixed side panes)
├── Interior               seats, dashboard, console, carpet, door cards, headrests, parcel shelf
├── SteeringWheel          pivot at the centre of the rim, rim plane per §3.2
├── Door_L0, Door_R0, …    one node per door leaf, pivot ON THE HINGE LINE at road level;
│   ├── Door_L0_Paint      its painted panel
│   ├── Door_L0_Glass      its window
│   └── Door_L0_Card       its inside panel (cabin material)
├── Wheel_F_L, Wheel_F_R, Wheel_R_L, Wheel_R_R (Wheel_R2_* for a third axle)
│                          pivot at the wheel centre, spin axis along Z; tyre + rim + hub
├── Lamp_Head_L/R, Lamp_Tail_L/R, Lamp_Ind_FL/FR/RL/RR, Plate_F, Plate_R
│                          small separate meshes (the game lights them)
├── Seat_0, Seat_1, …      EMPTIES at the hip point of each seat (§3.2), facing +X
│   ├── Seat_0_HandL / HandR   empties: where the hands rest (driver: on the rim at 9 and 3 o'clock)
│   └── Seat_0_FootL / FootR   empties: where the heels rest on the floor / pedals
└── Far                    ONE low-detail opaque mesh for far zoom (§6)
```

Doors must also be modelled so that with every door node removed, the body
shows the door **apertures** cleanly (the opening, the sill, the inside of the
pillars), because the game draws open doors separately.

### 4.2 Materials — at most five per vehicle

| Material name | Used by | Notes |
|---|---|---|
| `Paint` | Body_Paint, Door_*_Paint | base colour **pure white**; the game multiplies it per vehicle by one colour from the class palette. Darker details on painted parts go in **vertex colours** (white = paint, grey/black = darker) |
| `Trim` | Body_Trim, wheels' rims, lamps' housings | dark grey to black, roughness about 0.45 |
| `Glass` | Glass, Door_*_Glass | dark blue-grey tint, **opacity 0.30**, one material for all glazing |
| `Cabin` | Interior, Door_*_Card, SteeringWheel | dark neutral greys, matte (roughness about 0.9); seat fabric slightly lighter than carpet |
| `Rubber` | tyres | near black, roughness about 0.9 |

No textures are needed; if any are used they share one 512 × 512 atlas per
class. Palettes (for reference only — do not bake them in):

| Class | Palette |
|---|---|
| hatch | #e7dfd3 #e06056 #5f8fca #e5b64d #74a36d #3c4147 |
| sedan | #d6d8dc #2f6a86 #b993d1 #cf7b43 #dbe6ec #22262b |
| suv | #3f4a52 #7d8f7a #c0c4c8 #6b4f3a |
| van | #eceae4 #d8d3c6 #9aa7b1 #f0f2f4 |
| bus | #1f5fa8 #c9342d #2e7d5b #e4e7ea #d8a32a |
| truck | #8c9195 #5d6a72 #b4b0a5 #2c4f6b #8f3d34 (box second colour: separate `Body_Accent` node, material `Paint`) |
| motorcycle | #1b1d21 #b02a25 #1d4f86 #d9dde1 #c6761f |
| bicycle | #2f8f7a #c4c8cc #9c3f5e #3b5fa0 #dfc65a |

## 5. People inside

**The strongly preferred delivery is WITHOUT people**, with the `Seat_*`,
`*_Hand*` and `*_Foot*` empties of §4.1 placed exactly. The game seats its own
animated citizens there — 80 different bodies, never the same person twice in
one vehicle, idling, getting in and out through the doors — and the empties
tell it where the hands and feet must go.

If people are nonetheless modelled into the vehicle, they must follow ALL of
these rules, or they cannot be used:

1. **Each occupant is a separate node**, named `Occupant_<seat>_<variant>`
   (for example `Occupant_0_A`, `Occupant_0_B`, …), parented to its `Seat_<n>`
   empty, so the game can show any subset and pick variants per vehicle.
2. **At least 6 variants per seat**, all different people: men and women,
   young and old, several skin tones, hair styles and clothes. No two variants
   of one vehicle may look alike.
3. **Posture** (checked numerically on import):
   * pelvis on the cushion at the hip point (±3 cm), not floating, not sunk in;
   * torso facing +X within ±5°, back against the backrest (20–25° recline for
     *car*, about 10° for *chair*), shoulders level, head upright looking ahead;
   * thighs along the cushion, knees bent 100–120° (*car*) or about 90°
     (*chair*), lower legs down to the floor, **feet on the floor** or pedals;
   * driver: both hands on the steering wheel rim at about 9 and 3 o'clock;
     passengers: hands in the lap or on the armrests;
   * the head at least **5 cm below the roof lining**; the whole body at least
     2 cm clear of the doors, the pillars, the glass, the dashboard and the
     seats in front;
   * **no limb passes through the body or another limb**; no crossed legs
     passing through the seat; arms never through the torso.
4. Anatomy in proportion to a 1.60–1.85 m adult (children: 1.10–1.40 m, only
   on rear seats).
5. Budget: at most **2 500 triangles per occupant**, one material (`People`),
   colours in vertex colours or a 512 × 512 atlas shared by all occupants.
6. Two-wheelers: the rider sits on the saddle, both hands on the grips, both
   feet on the pegs (motorcycle) or pedals (bicycle), leaning with the machine;
   motorcyclists wear a helmet that **encloses the head** (a separate mesh
   fitted to the head, never a sphere through it).

## 6. Level of detail and budgets

| Class | Body_Paint + Trim + Glass + Doors | Interior + SteeringWheel | Far (opaque, merged) |
|---|---|---|---|
| hatch, sedan, suv | ≤ 6 000 triangles | ≤ 3 000 | ≤ 400 |
| van | ≤ 6 000 | ≤ 2 000 | ≤ 400 |
| truck | ≤ 9 000 | ≤ 2 500 | ≤ 600 |
| bus | ≤ 14 000 | ≤ 6 000 | ≤ 800 |
| motorcycle, bicycle | ≤ 3 000 in total | — | ≤ 250 |

`Far` is one mesh with the silhouette, dark glass and wheels, no interior,
material `Paint` with vertex colours; it is what the city view draws.

## 7. Look

* Clean, stylised realism: readable proportions, bevelled edges (2–3 cm), no
  noisy detail smaller than 3 cm. Distinct front and back from above
  (bonnet/boot shapes, lamps, windscreen rake).
* Glass leans inwards towards the roof (tumblehome), so from the 48° camera
  the side glass faces up and the cabin reads through it. A panoramic roof,
  where present, is a separate `Roof_Glass` node.
* Wheel arches follow the wheels with a 3–5 cm gap; tyres visibly rubber, rims
  lighter; nothing floats, nothing clips.
* Interiors finished: seats with headrests, dashboard, console, carpet — they
  are seen from above through the glass.

## 8. Acceptance checklist (what the importer checks)

1. File loads as glTF 2.0; units metres, +Y up, +X forward, origin on the road
   under the body centre.
2. Bounding box within ±2 % of §3.1; wheels at the axle positions and radius.
3. All mandatory nodes present with the right names and pivots (doors on the
   hinge line, wheels at their centres).
4. At most five materials (six with `People`), named as in §4.2; `Paint` base
   colour white.
5. Seat empties within ±2 cm of §3.2; headroom and legroom met.
6. No overlapping coplanar faces; no inverted normals; watertight where seen.
7. Triangle budgets of §6 met, including `Far`.
8. If occupants are included: every rule of §5, checked per variant, with no
   intersections between any occupant and the vehicle or between occupants.

Deliver the eight `.glb` files together with a screenshot of each from above
at 48°, doors shut, and one with every door open.
