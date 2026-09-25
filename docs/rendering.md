# Rendering

**Files:** `src/render/` · Only this folder may import `three`.

## The scene

```
Scene
├── sky                     gradient dome, also the environment map source
├── terrain-backdrop        flat frame beyond the editable plate
├── terrain-ground          the heightfield
├── terrain-water           rivers
├── world
│   ├── road-network        4 bands × structural level, + markings groups
│   ├── road-structure-details   piers, pier caps, parapets, portals
│   └── scenery             lamps, trees, bushes            (instanced)
├── vehicle-*, pedestrian-* instanced, resynced every frame
├── traffic-signals         one group per head
└── sun, sky-fill, ambient-floor
```

## The rebuild contract

Everything derived from the road network or the terrain is rebuilt in **exactly
one place**, `rebuildWorld`, and only when one of the two revisions it watches
has moved. Nothing computes geometry inside `draw`.

That matters because a road rebuild solves the whole elevation field and
re-triangulates every band. Doing it per frame is how earlier versions turned an
edit into a stall.

A terrain edit invalidates the roads too — they are laid *on* the terrain — so
both revisions gate the same rebuild.

Draw order per frame:

1. `terrain.update(doc)` — gated on `terrainRevision`
2. `rebuildWorld(net)` — gated on both revisions
3. visibility from the zoom (props and agents below `detailCutoffZoom`)
4. `agents.sync` and `signals.sync` — every frame, from the simulation
5. `environment.follow` — the sun tracks the camera, the shadow frustum is fitted
6. `post.render(delta)`
7. the quality governor takes one frame-time sample

## The camera

`isoViewport.ts` holds an orthographic camera at 48° elevation and 45° azimuth,
2 400 units back. It implements the `Viewport` seam (`src/view/viewport.ts`), so
the input layer in `main.ts` does world↔screen, pan, zoom and rotate without
knowing what is behind it. Zoom is expressed as pixels per world unit and clamped
to the range the rig can actually represent.

Rotation is in quarter turns. The sun is fixed in **world** space, so rotating
the camera changes which faces are lit — which is correct, and is what makes the
rotation read as moving around a place rather than spinning a picture.

## Post-processing

`postprocess.ts` builds an `EffectComposer` with render → GTAO → SMAA → output.

**Ambient occlusion earns its cost here specifically.** Nearly every contact in
this scene is a flat surface meeting another flat surface at a small height
difference — asphalt to kerb, kerb to footway, footway to verge, a pier standing
on the ground, a deck over a road. Direct light cannot describe any of those: the
two surfaces face the same way, so they take the same amount of sun and the edge
between them vanishes. Ground-truth ambient occlusion darkens exactly those
creases, and it is the single change that makes the road read as built into the
ground rather than printed on it.

**SMAA rather than FXAA** because it keeps the thin bright lines of lane markings
sharp instead of smearing them; **rather than MSAA** because the composer renders
into a float target.

At the `low` tier the composer is skipped entirely and the scene is drawn
straight to the canvas with the driver's own MSAA. That is what keeps a weak
machine playable.

## Instancing

Everything repeated is one draw call per part, whatever the count: lamp columns,
arms and lamps; tree trunks, canopies and bushes; piers, pier caps, parapets and
tunnel portal walls; and the instanced meshes that carry every vehicle and
rider in the world. Pedestrians and occupants are rigged citizens, one
instanced batch per body model (`riggedCitizens.ts`).

Static instanced meshes carry a real bounding sphere so the frustum can reject
them. Agent meshes do not: their instances move every frame, so a sphere computed
once would be wrong, and there are few enough of them that skipping the test is
cheaper than maintaining it.

## Agents

`agents.ts` writes every vehicle and rider, and hands every pedestrian and
occupant to `riggedCitizens.ts`, from the simulation each frame, interpolated between the last two steps by `sim/pose.ts`.

### Grouped by geometry, not by what the part depicts

A bumper, a wing mirror, a bus door and a bicycle fork are all boxes of trim,
so they are all instances of one mesh. That grouping is the performance
argument: a thousand vehicles, each assembled from a dozen or more parts, cost
a draw call per part kind rather than per vehicle, and a new detail costs
instances rather than batches. (Pedestrians were built the same way, from
limb and torso boxes, before the rigged citizens replaced them; the `dog`
trait in `agents.ts` is left from then and nothing draws it.)

Per-instance colour is what makes the sharing possible, so the materials are
left near-white and each instance carries its own paint. A material with a colour
of its own would bias everything sharing it.

Nothing allocates per agent: one `Object3D` composes every matrix, one `Color`
carries every tint, and colour strings coming out of the simulation are resolved
through a cache, because the CSS parser allocates.

### Three detail bands

`sync` takes the renderer's `detailed` flag and the zoom, and folds them into:

| band | vehicles | pedestrians |
|---|---|---|
| far | body and a solid cabin — two writes | not drawn |
| mid | the greenhouse opens: roof on glass, wheels, bumpers, lamps, riders | head, torso, hips, legs |
| near | occupants, mirrors, plates, hubs, pillars, bus doors | full-detail citizen LOD |

The solid cabin at the far band is not laziness. From the mid band up the
greenhouse has to be a roof carried on glass, because nobody can be seen sitting
inside an opaque box; zoomed out, where nobody can see in, one box is both
cheaper and better silhouetted. Riders are the one occupant drawn at the mid
band — a motorcycle with no rider is not a cheaper motorcycle, it is a wrong one.

### Deterministic variation

Whether a car carries a passenger, which of its windows are down, a pedestrian's
age, build and body model — all of it comes
from a hash of the agent's id. Nothing is stored and nothing is drawn from a
random source, because an agent re-rolled each frame strobes and one cached in a
map needs eviction that has to agree with despawn. A hash of the id is stable for
the agent's whole life for free.

The gait is the same idea applied to motion: leg and arm swing come from the
pedestrian's arc position, never from a clock and never from stored state, so a
figure that stops moving stops swinging and one that resumes picks its stride up
where it left it. Amplitude scales with the ratio of current to free speed, which
is what makes someone held at a kerb stand still instead of marching on the spot.

Lamps are unlit materials — they and the signal lenses are the one thing in the
scene that should stay bright inside a shadow.

## Signal heads

One group per approach at a signalised node, built lazily and **removed** when
its junction disappears. Hiding them instead left them in the scene graph for the
rest of the session: every frame traversed them, every rebuild added more, and a
long editing session ended up walking hundreds of invisible objects.

Three things about them are deliberately not realistic, and each one answers a
player who reported that the signals "have no green or amber light":

* **Every head is double-sided.** A real signal aims its lenses at the traffic it
  controls and shows the approach behind it a black box. The camera here is
  locked to one isometric diagonal, so at any junction roughly half the heads
  faced away and the player saw unlit rectangles. Each head now carries a lens
  cluster on both faces, driven from one state — which is also what a real
  repeater head does.
* **An unlit lens is still coloured.** They used to be almost black against an
  almost-black housing, so a head showed one glowing dot and nothing else: the
  other two colours were invisible rather than merely off. A real lens is a
  coloured filter over a dark can, legible across a junction with the lamp out.
* **Heads are drawn at 1.5× life size** — the only object in the scene that is.
  A real head is 0.6 m across, which against a 46-unit boulevard is four pixels
  at the zoom the game is played at: correct, and useless, when the lamp is the
  single piece of information the player most needs from a junction.

The lit lens is an unlit, un-tone-mapped material with a dimmer halo disc behind
it. Everything else goes through ACES, which rolls a bright saturated colour
towards white; a signal lamp has to keep its hue at full brightness.

`scripts/verify-visual.mjs` counts the lamps and how many are lit, on a scenario
that runs the simulation long enough for the controller to cycle.

## Diagnostics

`window.__roadcraft` exposes the document, the network, the simulation, the scene
handle, a `redraw()` and a `runSim(seconds)` that advances the fixed-step clock
directly — the clock refuses to catch up more than `MAX_SUBSTEPS` per frame,
which is right for a game and useless for a harness waiting on a software
rasteriser for a junction to fill. `scene().stats` reports triangles, draw calls, the active
quality tier and a smoothed frame rate. `scripts/verify-visual.mjs` drives all of
it; see [testing.md](testing.md).
