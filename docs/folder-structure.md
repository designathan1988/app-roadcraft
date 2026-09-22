# Folder structure

```
roadcraft/
├── index.html              the shell: panels, buttons, translation keys
├── package.json            scripts and dependencies
├── vite.config.ts          build and dev server, path aliases
├── vitest.config.ts        test runner, coverage scope and thresholds
├── tsconfig.json           strict TypeScript, path aliases
├── eslint.config.js        lint rules and the globals each area may use
│
├── src/
│   ├── main.ts             wiring, input handling, the frame loop
│   │
│   ├── core/               pure 2D geometry and numerics
│   │   ├── vec2.ts         vectors
│   │   ├── scalar.ts       clamping, epsilons, shared tolerances
│   │   ├── aabb.ts         axis-aligned boxes
│   │   ├── polyline.ts     arc-length sampling, frames, closest point
│   │   ├── ring.ts         closed outlines of line and arc edges
│   │   ├── polygon.ts      area, containment, orientation
│   │   ├── offset.ts       polyline offsetting with mitred joins
│   │   ├── fillet.ts       corner arcs between two lines
│   │   ├── intersect.ts    segment and ray intersections
│   │   ├── bezier.ts       quadratic curves and their flattening
│   │   ├── clipper.ts      the clipper2 wrapper: union, difference, intersection
│   │   └── rng.ts          seeded xoshiro128** — the only randomness allowed
│   │
│   ├── world/              the model: the document and what is derived from it
│   │   ├── doc.ts          RoadDoc — nodes, segments, terrain stamps, revisions
│   │   ├── ids.ts          branded NodeId / SegmentId
│   │   ├── units.ts        world units ↔ metres
│   │   ├── roadTypes.ts    classes, widths, lane profiles, surface levels
│   │   ├── structures.ts   at grade / elevated / viaduct / bridge / tunnel
│   │   ├── terrain.ts      base relief, brush stamps, the stamp index
│   │   ├── elevation.ts    ★ the one road height field
│   │   ├── network.ts      ribbons, junctions, trims — the geometry solver
│   │   ├── surfaces.ts     level polygons and the four non-overlapping bands
│   │   ├── geometry.ts     the polyline cache keyed by segment
│   │   ├── markings.ts     centre lines, lane lines, stop bars, crossings
│   │   ├── approach.ts     stop-line and crossing distances at a mouth
│   │   ├── approachGroups.ts  which legs share a signal group
│   │   ├── legAngles.ts    leg ordering and the "impossible junction" rule
│   │   ├── conflictPoints.ts  where two movements cross
│   │   ├── lanelets.ts     the driveable graph
│   │   └── junction/       the junction builder
│   │       ├── build.ts      orchestration and the surface-mode classifier
│   │       ├── legs.ts       per-leg half-widths and directions
│   │       ├── corners.ts    corner radii and setbacks
│   │       ├── trim.ts       how far each leg is cut back
│   │       └── polygon.ts    the closed junction outline per level
│   │
│   ├── sim/                traffic
│   │   ├── world.ts        SimWorld — agents, runtime lane state, indexes
│   │   ├── pipeline.ts     one simulation step, in order
│   │   ├── clock.ts        fixed timestep with an accumulator
│   │   ├── params.ts       every simulation constant
│   │   ├── pose.ts         interpolated world pose of an agent (read by render)
│   │   ├── snapshot.ts     the previous step, for interpolation
│   │   ├── audit.ts        live issue detection
│   │   ├── invariants.ts   assertions armed under SIM_STRICT
│   │   ├── vehicles/       archetypes, IDM, lane changes, spawning, integration
│   │   ├── peds/           sidewalk graph, crossing state machine, spawning
│   │   ├── signals/        plans, the phase FSM, permission, queries
│   │   ├── intersections/  admission, claims, spillback
│   │   └── routing/        the router
│   │
│   ├── render/             three.js — nothing else may import three
│   │   ├── renderer.ts     ★ the scene, the rebuild contract, the draw loop
│   │   ├── isoViewport.ts  the isometric orthographic rig and the Viewport seam
│   │   ├── environment.ts  sun, sky, shadows, fog, environment map
│   │   ├── postprocess.ts  the composer: ambient occlusion, SMAA, output
│   │   ├── quality.ts      the quality tiers and the automatic governor
│   │   ├── materials.ts    every shared material, baked once
│   │   ├── terrain.ts      the terrain mesh, its splat material, water geometry
│   │   ├── water.ts        the water shader: ripples, depth tint, foam, fresnel
│   │   ├── roadSurfaces.ts the four bands per structural level
│   │   ├── markings.ts     painted markings as lit geometry
│   │   ├── structures.ts   piers, pier caps, parapets, tunnel portals
│   │   ├── scenery.ts      lamps, vegetation
│   │   ├── agents.ts       instanced vehicles, riders, pedestrians, dogs
│   │   ├── signals.ts      signal heads
│   │   └── mesh/
│   │       ├── surfaceMesh.ts   ★ polygon → triangles, crack-free
│   │       └── textureBaker.ts  procedural colour / normal / roughness maps
│   │
│   ├── editor/             mutation
│   │   ├── commit.ts       a gesture becomes document changes
│   │   ├── snap.ts         what the pointer is over
│   │   ├── history.ts      undo and redo
│   │   ├── persistence.ts  autosave, import, export
│   │   └── repair.ts       fixing legacy maps on load
│   │
│   ├── ui/                 the DOM
│   │   ├── app.css         the whole interface stylesheet
│   │   ├── inspector.ts    the road and node inspector panel
│   │   ├── minimap.ts      the overview canvas
│   │   ├── labels.ts       model values → text, via i18n
│   │   ├── i18n/           the translation system and its dictionaries
│   │   └── overlay/        the 2D overlay: camera, surface, palette
│   │
│   └── view/
│       └── viewport.ts     the world ↔ screen contract
│
├── tests/                  vitest, mirroring src/
│   ├── core/               geometry and numerics
│   ├── world/              terrain, the elevation field, surface bands
│   ├── render/             the mesh builder and its cost ceilings
│   ├── editor/             splitting, joining, duplicating, history, save/load
│   ├── sim/                end-to-end traffic behaviour
│   └── ui/                 dictionary parity and markup keys
│
├── scripts/
│   └── verify-visual.mjs   boots the real app in a browser and measures it
│
└── docs/                   this documentation, and docs/screenshots/
```

★ marks the three files that carry most of the risk. If something looks wrong on
screen, the answer is almost always in one of them.

## Path aliases

Configured identically in `tsconfig.json`, `vite.config.ts` and
`vitest.config.ts`:

| alias | folder |
|---|---|
| `@core/*` | `src/core/*` |
| `@world/*` | `src/world/*` |
| `@sim/*` | `src/sim/*` |
| `@render/*` | `src/render/*` |
| `@editor/*` | `src/editor/*` |
| `@ui/*` | `src/ui/*` |
| `@view/*` | `src/view/*` |
| `@/*` | `src/*` |

Import across layers only in the direction the architecture allows
(`core → world → sim/render → editor → ui`). The aliases make a violation easy
to see in a diff.
