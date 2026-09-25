# stabilize/core — session state (source of truth after context compaction)

Only the stabilize session writes this file. Rewrite sections; do not append logs.

## 1. Mission
Close every item 0–11 of the "CONTINUAÇÃO" prompt on branch stabilize/core: sync with master, build an inspection harness, verify and fix slopes/structures, rebuild cars, seated occupants by IK, living pedestrians, open sim bugs, scene defects, incremental rebuild and citizen compression, licences, full validation, git cleanup.

## 2. Permanent rules (literal)
- No intermediate messages, no asking permission, no "next steps"; ONE final report in [F]/[I] format (sections per item 0–11, cause → commit → test tables, NÃO COBERTO section expected empty; include the path of this file and confirm it reflects the final state).
- No subagents. No time estimates. Execute fast and rigorously.
- English in code/identifiers/docs; UI text via i18n (en + pt-BR, live switch); Windows shortcuts.
- Do NOT split `main.ts` this round (the buildings session edits it).
- "I can't see it" is not an excuse: build the harness (item 1).
- Done = automated tests + close-up visual inspection (look at the image before claiming).
- Git: merge master INTO stabilize/core (never touch master directly); at the end merge master again, revalidate; fast-forward master only if master did not change since that merge, else leave the branch ready and say so in one line.
- Never saturate the machine: one heavy job at a time; stop servers and remove temp worktrees I created.
- No Math.random in world/sim; no `three` outside render.

## 3. Items (order and why) — status
0. Sync master into branch. Why first: every commit on the old base multiplies conflicts. — DONE: merge 940a27a + fix 67e8241. Full check running after merge (log scratchpad check5.log); verify:visual still to run.
1. Inspection harness (dev-only free camera, unlimited zoom, frame entity by id, interior mode hiding roof + near door, offscreen hi-res render, test fixture map with slopes/grade change/crossfall/bridge/elevated/tunnel/sloped footway/signalised crossing/acute junction). Why before 2/4/5: nothing there is verifiable without it. — IN PROGRESS.
2. Slopes & structures: wheel–road contact < 2 cm everywhere incl. bridge/elevated/tunnel (height from road surface, never terrain); single-transform test (zero deviation); vertical transition curves at hard grade breaks; peds' feet on sloped footway; fix elevated deck 124 % drop after split (TOP PRIORITY of item), mouth seam after move, lane end inside mouth after joint scaling; remove those 3 it.fails. Why before 3: shares elevation/structure code. — todo
3. Cars rebuilt from scratch by loft (side + plan profiles, rounded edges, cut wheel arches, coherent A/B/C pillars, mirrors attached to doors); types hatch, sedan, wagon, SUV, pickup, van (+bus/truck); keep clearcoat + reflective glass; dims and pivot follow sim; new "no loose part" test (every part within ε of body surface and inside envelope, all types); real interior seat/wheel/dash (IK targets). Defects seen: box silhouette/long flat bonnet, dark rectangle painted on roof, floating mirrors, loose grey piece behind wagon rear wheel and on bonnet, windscreen/roof gap. Why before 4: occupants' IK targets live in the interior. — todo
4. Occupants: typed seat-numbering contract (doorsPerSide × door edges) with test, confirm in harness; seated IK (pelvis on seat, back on backrest, driver hands on wheel, feet on pedals, passengers hands on lap/armrest, anatomical joint limits); capsule interpenetration test (hand vs wheel, arm vs torso, body vs seat/door/body) all types/seats/poses; desynchronised idle (head ahead/mirrors/side, breathing, hand adjust); sim-driven (wheel turns with steer, hands follow via IK, head anticipates turn, slight inertia on braking/accel); same-car occupants follow social group rules. — todo
5. Pedestrians alive: smooth look-at (cars, buildings, other peds, phone); groups turn heads + gesture, stop in inward-facing circle, group speed = slowest, abreast when room/single file when narrow; occasional phone/chat/wave/window-shopping; at crossings look both ways, hurry at end of time; foot-slide test; Inspect card (generated name, destination, group, members, via i18n) + hover highlight + follow camera; skin PBR (not plastic) + hair alpha-test + alpha-to-coverage; PED_AGENT: fix pedFlow freeze, enable agent on footways only, FSM stays for crossings; ped regression tests green. — todo
6. Open sim bugs: pedSignalContradiction first, then pedInRoadStalled, staleClaim (confirmed causes); bus off kerb / bodies touching in sharp turns → redesign where exit lanes start at acute angles; wide legs on short acute links + road drawn over road → editor validation with clear player feedback (i18n); saturated discharge and permissive left. Goal: zero it.fails, fuzz deep with no new violations. — todo
7. Scene defects: grass camouflage macro pattern (lower contrast, longer wavelength multi-octave, break periodicity); asphalt still coarse up close (lower contrast, smaller grain); footway checkerboard (less per-slab tone variation); zebra crossings: lines crossing bars/hatching → bars parallel to traffic, stop line before the crossing with setback, lane lines/dashes end before stop line, no overlaps + test failing on marking overlap; red-and-white ring objects on grass (identify: asset/ped/flower/debug, fix or remove); conifer black cone from above (layered branches, lighter tone, per-vertex variation); concrete gutter as GEOMETRY derived from the kerb polyline (same offset, same junction curves). — todo
8. Performance: incremental rebuild (dirty sets → Network.solve only touched nodes + neighbours → lanelets/conflicts/sidewalks only affected junctions); goal local road edit < 30 ms (now ~356 ms); equivalence tests incremental == full, verified by fuzz. Citizens: KTX2 textures + meshopt/Draco meshes + LODs, cut the 65 MB drastically, measure download + load before/after. GPU animation (VAT/bone texture) if benchmark with hundreds of peds+occupants shows relevant CPU cost. — todo
9. Licences: MIT Microsoft notice shipped in build + credits; fix LICENSE-ANIMATIONS.txt to reflect what ships. — todo
10. Validation: check green with zero it.fails, verify:visual green, fuzz deep no new violations; BEFORE/AFTER screenshots via harness (each car type close in 3 angles; occupants interior mode all seats; wheel + head sequences in a curve; cars on slope/bridge/elevated/tunnel; six group archetypes walking and stopped talking; ped looking both ways at crossing; grass far view; zebra crossings; conifer; gutter at a junction); self-critique of every image against all defect lists; benchmark before/after (ms/tick, road edit, draw CPU, download, load time, FPS PC + mobile presets). — todo
11. Git & cleanup (merge master again, revalidate, ff only if master unchanged; stop servers; remove temp worktrees). — todo

## 4. Acceptance targets
wheel–road contact < 2 cm; single transform deviation 0; local road edit < 30 ms; zero it.fails; citizens download drastically below 65 MB; no loose car parts (ε); capsule interpenetration zero; foot slide below limit; zero marking overlaps.

## 5. Decisions (and why)
- PED_AGENT on footways only, FSM keeps crossings (agent froze a walker in pedFlow; FSM is the safety rule).
- Party archetype is DERIVED from ages (partyArchetype, 7efb403), never re-drawn: RNG consumption must not change.
- Gutter = geometry derived from the kerb polyline, NOT a shader (shader used the road frame and smeared junctions).
- Cars rebuilt by loft, not retouched.
- Windows: part-way pane shortened from top about its bottom edge; fully down not drawn (windowPane, 72f06a8).
- Uniform wardrobes excluded from street crowd (wardrobeOf).

## 6. Confirmed causes and DISCARDED hypotheses (do not repeat)
- Kerb smear at junctions was the road-space gutter shader (vertices on plates took the crossing road's frame) — removed in 1cbaa5e. DISCARDED: "AO causes it" (A/B with AO off identical at radius 1.0), "shadows cause it" (low tier, no shadows: smear remained).
- Dark smooth strip at kerb = painted edge lines #2b2f30/#8f9490 — removed 4234b86.
- Re-drawing party ages broke pedFlow/pedestrians/pedTalk — dropped; ages untouched.
- Hooked turn paths: exit lane starts outside the heading cone; straight nose-to-rear gap guard did NOT fix overlaps (bodies meet side-on) — reverted.
- Detached shadows: bias -0.0005 normalised over 20..3840 depth = 1.9 u — fixed bbe7d65 (world-unit bias via fitDepth).
- White discs over road = lamp lens boxes + pole lamp heads in glow; dotted trace = 1-px wires — bbe7d65. Persistent white circle = road-tool hover ring — e6b1446.
- Dark tree triangles = palette per face — d33da75.
- Vehicles flat on slopes = one centre height + yaw-only frame — 742afbc (unverified on slopes yet: item 2).
- windowsDown never read — 72f06a8.
- verify:visual timeout = port 5199 held by another process (PID 8248); use ROADCRAFT_VISUAL_PORT=5203.
- Browser pane: element names; `npm` sets env NODE=path, don't use NODE as a probe env var (use NID).
- Iso viewport clamps halfHeight to MIN_HALF_HEIGHT=5 (max zoom ~92 at 920 px): need inspector camera.

## 7. Environment
- Branch stabilize/core, worktree C:\Users\jonathanrodriguesti\Desktop\Projetos\road-stabilize. Last commit 67e8241 (master fe11669 merged).
- Dev server entry to add in main tree `.claude/launch.json` when needed: road-stabilize-dev on port 5176 (remove at end). Port 5199 held by another session.
- Screenshots: docs/screenshots/scene-before, scene-after (git-ignored). Bench: docs/audit/bench-before.json, bench-after.json. Capture: scripts/capture-scene.mjs; bench: scripts/bench-sim.mjs; probes: tests/fuzz/_probe (untracked; run with --config tests/fuzz/_probe/vitest.probe.ts).

## 8. Next step
Item 1: create `src/render/inspector.ts` (dev-only offscreen camera: orbit a world point, clipping planes for interior mode, render to WebGLRenderTarget, return PNG dataURL), expose via renderer SceneHandle `inspect` only when `import.meta.env.DEV`; add fixture map `tests/fixtures/inspection.json` built from a script; extend scripts/capture-scene.mjs to use it. Then check5.log result + verify:visual.
