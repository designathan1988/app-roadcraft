# Agency architecture: people, vehicles and the citizens they are

Status: adopted 2026-09-30. This replaces the pedestrian model in `src/sim/peds/*`,
the vehicle decision layers in `src/sim/vehicles/*`, `src/sim/routing/*` and
`src/sim/intersections/admission.ts`, and the Microsoft Rocketbox character
roster. It is delivered side by side behind flags and the old code is deleted
only once the new code beats it on the metrics and the pictures.

The player asked for pedestrians and vehicles with real agency: agents that
choose where to go, take the best route, anticipate what is coming, never move
erratically, and can be extended (a person boards a car, enters a building)
without new collision special cases. And for a Person Creator: any person, any
body, skin, age, hair and clothes, used by the same agents.

## 1. One citizen, three views

A **citizen** is a `PersonSpec` (appearance + traits, ~300 bytes, saved in the
map or derived from a seed) plus an id that never changes. The same id is:

- a **pedestrian agent** in the People engine (walking, waiting, sitting,
  inside a building),
- a **seated occupant or driver** of a vehicle in Drive v2,
- a **rendered body** built from its `PersonSpec` by the Person model.

Traits feed behaviour: age -> walking speed and gait, leg length -> stride,
shoulder width -> body radius and personal space, patience -> crossing gap
acceptance and waiting, sociability -> talking and parties.

## 2. World representation

- **Crossings, single source** (`src/world/crossings.ts`): id, node, segment,
  kerb ends, polygon, refuge, lanes crossed, layer. Markings, furniture,
  navigation and vehicle conflicts all read it.
- **Walkable space** (`src/world/nav/*`): tagged walk polygons per deck
  (footway, kerb ramp, crossing, refuge, entrance apron, access path, stop,
  plaza, lot ground), static obstacles (lamps, benches, bins, trees, poles,
  walls) cut as holes, the result eroded by the body radius
  (`R_NAV = 0.25 m`) and triangulated per 64 u tile (earcut + Lawson flips =
  constrained Delaunay), merged into convex polygons (Hertel-Mehlhorn), with
  portals, gate links (crossings; later doors and barriers) and layer joins.
  Incremental per tile by digest; <= 20 ms per local edit.
  "Never inside an obstacle" is one test: the body centre is on the mesh.
- **Lane graph** (`src/world/lanes/*`): the existing lanelets, turn paths and
  swept conflict zones are kept and enriched: lane kind and allowed classes,
  arrows, lane-change spans, explicit stop lines with per-approach control,
  kerb places (parking, loading, bus stop, drop-off), access points
  (driveways, garages, lot entrances), manoeuvre paths, junction domains.
- **Road model additions** (with the road redesign, Lote R): stable road ids,
  per-direction lane lists (parking, bus, bike), pockets, markings, per-leg
  control, kerb zones, accesses, lots, bus lines, decks. Every addition has a
  derived default, so drawing a road still just works.

## 3. People engine (`src/sim/people/*`, `src/sim/affordances/*`)

- **Navigation**: A* over the navmesh polygons with the funnel algorithm;
  costs: distance, crossing expected wait (from the signal plan), congestion,
  grade; event-driven replanning (stale polygon, off corridor, crossing closed
  past patience, lost reservation, stuck, congestion change).
- **Locomotion**: power-law time-to-collision forces (Karamouzas, Skinner &
  Guy 2014) against the 10 nearest people, nearby walls and vehicles
  predicted 2 s ahead; acceleration, braking and turn-rate limits with start
  and stop hysteresis. Safety does not depend on it: every move goes through
  `moveAlongSurface` (stays on the mesh) and a separation pass keeps bodies
  apart.
- **Affordances (smart objects)**: bench seats, crossing waits and gates,
  building doors, vehicle doors and seats, bus stops, talk circles, kiosks,
  viewpoints. Each publishes slots with an approach point, facing, capacity,
  duration and animation. Reserve -> approach -> face -> act -> release. A new
  behaviour is a new affordance type, a provider and an animation mapping; the
  agent code does not change.
- **Minds**: needs and utility choose a goal; short hand-authored recipes
  (HTN-lite) expand it into tasks (MoveTo, UseAffordance, WaitFor, Follow,
  Transition); intentions persist and change only for a >= 30 % better
  option; parties share a plan; ~4 Hz staggered thinking.
- **Crossing**: a gate with the existing permission rules (signal, flashing
  clearance, uncontrolled gap acceptance, no vehicle body, no vehicle
  reservation); an agent inside the crossing is committed and holds occupancy.

## 4. Drive v2 (`src/sim/drive/*`, `src/sim/negotiation/*`)

- **Strategic**: trips with origin, destination, purpose and time (boundary
  first, then buildings and lots by use and floor area); cost-to-go fields per
  destination zone refreshed round-robin from measured travel times, queue and
  signal delay; movement choice at each link with hysteresis (switch only for
  >= max(5 s, 10 %)).
- **Tactical** (10 Hz, every tick when urgent): lane-selection windows from a
  backward pass over the next links, MOBIL for discretionary changes, merge
  requests and courtesy (zipper emerges), overtaking where markings allow,
  generic stop tasks (drop-off, loading, bus stop, parking) with timeouts.
- **Operational**: IIDM + constant-acceleration heuristic with two leaders;
  a safety bound using the leader's own maximum braking; jerk limits; speed
  never drops to zero in one tick; a producer contract forbids emitting a stop
  the vehicle cannot make; quintic lane changes with dual occupancy;
  heavy-vehicle off-tracking (body track shared with conflict sweeps).
- **Junction negotiation**: the central Banker's arbiter is replaced by a
  reservation board of time windows per conflict area, a thin commit
  registrar per junction domain (commit through to a refuge link with booked
  storage, ordered tickets), pedestrians booked on crosswalks outranking any
  vehicle that can still stop, a short-cycle guard, and a wait-for graph with
  escalating recovery. `ClaimTable` stays as the physical guard.

## 5. People and vehicles together

- **PeopleBridge** mailbox, one writer per direction: vehicles -> people
  (`offerDoor`, `alight`, `invite`), people -> vehicles (`atDoor`,
  `boarded`, `boardAborted`). A person keeps its id aboard. The old "delete
  the pedestrian and fake the walk to the car" goes.
- **CrossingState** per crossing (occupants, waiting, demand, longest wait)
  replaces `pedOccupancy`/`pedWaiting`; **VehicleBodyView** + `predict(t)`
  gives people the vehicles' committed trajectories.

## 6. Person model (`src/world/people/*`, `src/render/people/*`, `scripts/import-makehuman.mjs`)

- **Assets**: MakeHuman hm08 base mesh, modifier targets, the 53-bone
  `game_engine` skeleton with weights, proxies, clothes, hair, eyebrows and
  skins: all CC0 (makehumancommunity.org licence page, 2020 change). Imported
  once at build time from MPFB2 at a pinned commit and packed to binary.
  **No MakeHuman / MPFB2 / makehuman.js code is used** (AGPL/GPL): the morph
  engine, skeleton fitting and clothes fitting are our own TypeScript,
  written from the file formats. Community assets need a per-asset licence
  manifest; CC-BY ones go to the credits.
- **Generation** (Web Worker): macro weights (gender, age, muscle, weight,
  height, proportions, ethnic blend) + local face/body targets -> body;
  skeleton fitted from joint cubes; `.mhclo` clothes and hair fitted by
  barycentric reference + offset, hidden skin deleted; weights transferred;
  merged into one mesh with a texture atlas; LODs with meshoptimizer; cached
  in IndexedDB by spec hash.
- **Crowds**: 32-128 baked prototypes; each copy varies height, skin, hair
  and clothing colours (per-vertex material slot + per-instance palette) and a
  few GPU shape morphs; the existing bone-palette instancing is kept; a
  player-made person gets a prototype of its own. Animation is baked once
  per skeleton layout, not per body.
- **Animation**: the Rocketbox motion clips (MIT, real motion capture) are
  kept and retargeted offline onto `game_engine` (near 1:1 bone map, rest-pose
  correction, pelvis scaled by leg length); gaps (waving, carrying, extra
  locomotion) come from Quaternius CC0 clips; seated driver/passenger/rider
  poses are re-solved by the existing IK. Mixamo and SMPL are not used.
- **Rocketbox characters are removed** (~68 MB of GLB); only the MIT motion
  data and its licence notice stay.
- **Person Creator mode**: body (sex, age, weight, muscle, height,
  proportions, regional sliders), skin (continuous tone, undertone),
  face (head, eyes, nose, mouth, ears, chin, eye colour), hair (style,
  colour, eyebrows, beard), clothes per slot (top, bottom, dress, outer,
  shoes, hat, glasses, bag: item, colour, pattern), traits; live 3D preview
  with idle/walk; presets, per-section randomise and lock, save to the city;
  the population generator mixes player-made people in.

## 7. Delivery

Each step lands on master with the suite green and the pictures looked at.
Flags: `?peds=legacy|people`, `?drive=v1|v2`.

| Track | Steps |
|---|---|
| People | P0 seams (PedView, CrossingState, PeopleIndex, PeopleBridge, engine interface; no behaviour change) -> P1 crossings + navmesh -> P2 planner + locomotion -> P3 affordances -> P4 minds, doors, building occupancy -> P5 vehicle doors and bus stops -> P6 parity and switch -> P7 delete the old model -> P8 authored places |
| Drive | V0 metrics, scenarios, 1200-vehicle bench, RenderableVehicle, digest test -> V1 lane graph -> V2 perception -> V3 operational -> V4 tactical -> V5 strategic -> V6 negotiation -> V7 stop tasks + mailbox -> V8 parking + driveways -> V9 trips from buildings -> V10 buses, deliveries -> V11 off-tracking, decks, node templates -> V12 switch and delete v1 |
| Person | H0 CC0 import script + licence manifest -> H1 morph engine (worker) validated against MPFB2 exports -> H2 skeleton fit + offline clip retarget + IK re-solve -> H3 clothes, hair via mhclo -> H4 crowd prototypes in the citizen renderer -> H5 Person Creator mode (new UI shell) -> H6 traits wiring -> H7 Rocketbox GLBs removed |

Acceptance metrics (asserted in `tests/sim/metrics/*` and scenario specs):
0 people off the mesh or inside an obstacle; no stuck spell > 5 s outside
legitimate waits; strangers never < 0.20 m apart; <= 0.5 abrupt turns per
ped-minute; median route efficiency <= 1.25; 0 signalised entries without
permission; 0 vehicle body overlaps; jerk p95 <= 3 m/s3; 0 emergency brakes;
>= 98 % mandatory lane changes completed; saturation headway 1.8-2.2 s; no
gridlock > 60 s over 20 seeds x 30 min; >= 95 % parked within 3 min; boarding
completes or aborts cleanly 100 %; <= 2.5 ms/tick for 1000 people and
<= 3 ms/tick for 1200 vehicles.
