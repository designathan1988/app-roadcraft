# Roadcraft

A 3D isometric road-building and traffic-simulation game that runs in the
browser. Draw a road network onto terrain you can sculpt, and watch a continuous
traffic simulation adapt to every edit.

![A city grid on edited terrain](docs/screenshots/city-on-edited-terrain.jpg)

---

## Quick start

```bash
npm install
npm run dev
```

Open the URL Vite prints. No build step. Every texture is generated
procedurally at start-up; the one downloaded asset is the citizen roster
(80 rigged Microsoft Rocketbox bodies, about 65 MB, fetched as they first
appear) and its motion library (about 4 MB), see [docs/pedestrians.md](docs/pedestrians.md).

Requires Node 22 or newer and a browser with WebGL 2.

---

## Playing

| | |
|---|---|
| **Draw a road** | Pick a class (`1`–`6`). Straight is the default: click a start and an end. The tool resets after placement; click an existing road or node to begin another connected segment. Curve takes a third click for its bend; Free follows a drag. Escape or right-click cancels a pending placement. |
| **Sculpt the land** | `Terrain` (`t`): raise, lower, level or carve a river. The wheel sizes the brush and shift-wheel sets its strength; `1`–`4` pick the operation. Hold the button to keep working one spot. *Level* takes its target height from where the stroke starts, so a drag across a slope brings the whole swept area to that height. Roads already built conform to the new ground immediately. |
| **Build up or down** | Click the road point to build from, aim the next endpoint, then press Page Up/Page Down or the palette `+`/`−` buttons for 1 m steps. The live preview shows the resulting height and grade before the endpoint click. Repeat from an existing point to create ramps, elevated spans, cuttings and tunnels. |
| **Control a junction** | `Control` (`c`): click a junction to cycle automatic → signal → priority → stop → give way → uncontrolled. Shift-click goes back. While the tool is up, every junction shows its current mode. |
| **Adjust** | `Upgrade` (`u`) raises a road's class · `Move` (`m`) drags a node · `Split` (`x`) cuts a road · `Bulldoze` (`b`) removes one · `Inspect` (`i`) opens the panel. |
| **Camera** | Wheel to zoom, middle button to pan while placing a road, `Q`/`E` to rotate in quarter turns, arrow keys to pan. Right-click cancels a pending road; otherwise it pans. |
| **Traffic** | Pause, 1×, 2×, 4×. Sliders set vehicle and pedestrian density; *Demand* sets the overall level. |

Everything is saved to the browser automatically. **Save map** / **Open map**
export and import a `.json` file.

The interface is available in **English** and **Português (Brasil)**, selectable
from the top bar; it defaults to the browser's own language.

---

## Graphics quality

The selector in the top bar offers **Automatic**, **Low**, **Medium**, **High**
and **Ultra**. Automatic starts at High and steps down if the measured frame time
says the machine cannot hold it — and back up if it can. What each tier changes
is a single table in [`src/render/quality.ts`](src/render/quality.ts), described
in [docs/performance.md](docs/performance.md).

---

## What is in the box

| | |
|---|---|
| **Terrain** | A procedurally-relieved heightfield, editable with four brushes, with slope- and height-blended grass, dirt and rock, and rivers that hold water at the level of the channel that carved them. |
| **Roads** | Four classes, adjustable lane counts and direction, straight or curved alignment, four structural levels (at grade, elevated, bridge and tunnel; a map saved with the old *viaduct* loads as elevated), and a cross-section of carriageway, kerb, footway, kerbed central reservation and verge with markings, crossings and stop lines. |
| **Junctions** | Corner radii, trims and mouths solved from the real leg geometry; signal heads, phases, right-of-way and gap acceptance. |
| **Traffic** | Hatchbacks, sedans, SUVs, vans, buses, lorries, motorcycles and bicycles, each to scale and with its own driving behaviour, carrying visible drivers and passengers; pedestrians of every age, build and dress, walking with a real gait. |
| **Drivers** | Each one has their own acceleration, braking, headway and patience, drawn from a single consistent temperament, and a speed that wanders the way nobody's actually holds steady. They overtake what is slower, give way when they have to, read a late amber differently from one another, and look for another way round when they have been stuck long enough. |
| **People** | Parties of friends who keep pace with each other, their own destinations, a place on the footway they hold and shift to pass or to avoid somebody coming the other way, a wait at the kerb, and a pace that varies within one walk as well as between two people. |
| **Simulation** | Car-following, MOBIL lane changing, sidewalks and crossings, congestion-aware routing and a live audit. |
| **Rendering** | One directional key light with real shadows, a gradient sky that doubles as the environment map, ground-truth ambient occlusion, SMAA, filmic tone mapping, and animated water with depth tint and shore foam. |

---

## Documentation

Start with **[AGENTS.md](AGENTS.md)** — it is the map: where every system lives,
what depends on what, and which invariants must not be broken.

| Document | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | The layers, the data flow, the revision gates |
| [docs/folder-structure.md](docs/folder-structure.md) | Every folder and what it is responsible for |
| [docs/terrain.md](docs/terrain.md) | The height field, brushes, rivers, the terrain mesh |
| [docs/road-system.md](docs/road-system.md) | Classes, widths, ribbons, surface bands, markings |
| [docs/elevation.md](docs/elevation.md) | How every road surface gets its height — the keystone |
| [docs/intersections.md](docs/intersections.md) | Junction geometry and how structures connect |
| [docs/mesh-generation.md](docs/mesh-generation.md) | Polygon → triangles, without cracks or explosions |
| [docs/rendering.md](docs/rendering.md) | The scene graph, the rebuild contract, post-processing |
| [docs/materials-textures.md](docs/materials-textures.md) | Procedural texture baking and material set-up |
| [docs/lighting.md](docs/lighting.md) | Sun, sky, shadows, fog, environment |
| [docs/performance.md](docs/performance.md) | Where the time goes and what keeps it bounded |
| [docs/i18n.md](docs/i18n.md) | Adding a string, adding a language |
| [docs/testing.md](docs/testing.md) | What is tested, how, and what to run |
| [CHANGELOG.md](CHANGELOG.md) | What changed in this revision and why |

---

## Commands

```bash
npm run dev              # development server with hot reload
npm run build            # typecheck, then a production bundle in dist/
npm run preview          # serve the production bundle
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm test                 # unit and integration tests
npm run test:coverage    # the same, with coverage thresholds
npm run check            # lint + typecheck + coverage + build
npm run verify:visual    # boot the real app in a browser and measure the scene
npm run verify           # check + verify:visual
npm run screens          # verify:visual, writing docs/screenshots/*.jpg
```

---

## Project layout

```
src/
  core/      pure 2D geometry and numerics — knows nothing about roads
  world/     the document and everything derived from it that is not a picture
  sim/       vehicles, pedestrians, signals, routing
  render/    three.js: the scene, the meshes, the materials, the lighting
  editor/    tools, history, persistence
  ui/        DOM panels, the inspector, the minimap, translations
  view/      the viewport contract shared by the camera and the input layer
  main.ts    wiring, input handling, the frame loop
tests/       vitest suites, mirroring src/
scripts/     verify-visual.mjs — the browser-driven scene check
docs/        the documentation listed above
```

---

## Technology

TypeScript (strict, with `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`), three.js for rendering, `polygon-clipping` for polygon
booleans, `earcut` for triangulation, Vite for the build, Vitest for tests and
Playwright for the browser check. No runtime framework; the only asset
pipeline is the citizen roster's (`scripts/fetch-citizens.py` and the scripts
after it, see AGENTS.md).

## Licence

Private project. The citizen bodies and their animations are Microsoft
Rocketbox, MIT, Copyright (c) 2020 Microsoft
(`public/models/citizens/LICENSE-MICROSOFT.txt`,
`src/render/motion/LICENSE-Microsoft-Rocketbox.txt`); that notice has to ship
with any build.
