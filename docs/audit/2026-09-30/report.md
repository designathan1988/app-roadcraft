# Roadcraft — Full audit report

**Audited base:** `master` @ `5ffa5a2` (2026-09-29 22:50) · **Date:** 2026-09-30
**Scope:** all of `src/` (~64k lines of TypeScript), `index.html`, `scripts/`, `tests/`, `dist/`, and the game running in the browser (dev server, Chrome).

This is the English version of `relatorio-auditoria.md` (Portuguese, kept out of git), and the **work plan of the fixing stage**. Every item has: location, current behaviour, expected behaviour, likely cause, impact and the fix needed. Each item carries its **status**: `fixed <commit>`, `replaced <commit>` (the subsystem was rebuilt and the defect cannot occur in the new one), or `open`.

---

## 1. Executive summary

- **The base was not green.** Lint and typecheck passed, but the suite had **2 failing tests on master** (pedestrians walking through lamp posts; a pedestrian standing 9.4 s on a footway): 593 passing, 3 known `it.fails`. The suite took **7.6 min**; AGENTS.md said "seconds".
- **Data integrity was risk no. 1.** Player data was lost or changed silently in ordinary flows:
  - the angle of drawn walls/fences/stairs was lost on every road drawn, undo or reload;
  - a malformed file or autosave broke the boot **for good**;
  - `clone()` deleted a visible road when two nodes coincided;
  - undo "repaired" the map and created junctions the player never drew;
  - turn bans vanished when a road was split;
  - the Move tool flattened curves irreversibly.
- **Core interface flows were broken** (reproduced in the browser):
  - the visible undo/redo stayed disabled outside the building editor;
  - the first corner of a drawn building was dropped (a triangle came out);
  - dragging a shape made a diagonal "blade";
  - the road tray (classes, straight/curve/free) did not appear at boot;
  - Move / Split / Upgrade / Junction control existed only on the keyboard (nothing on touch);
  - Esc did not close menus;
  - at 1366×768 and on phones the tray cut off the hint line and the gallery.
- **Simulation:**
  - opening a map reused the previous map's vehicles and pedestrians;
  - orphaned pedestrians were stacked on one spot;
  - vehicles with a destination never changed lane to turn;
  - traffic at 0% "killed" the entries for good;
  - right turns moved one car at a time;
  - the ring-gridlock breaker never acted on a real map;
  - pedestrians could step onto a zebra without permission.
- **Performance and memory:**
  - ~570 MB of JS heap on a 39-road map (citizen animation baked at ~11 MB per body, never freed);
  - every edit rebuilt the whole world (150 ms on a small map; the project target is < 30 ms);
  - a **GPU texture leak** on every quality change;
  - the "Automatic" governor oscillated and made the trees disappear and reappear;
  - O(N) scans per agent per tick in signals, admission and pedestrians.
- **City-builder systems:** roads, terrain, buildings, poles and traffic exist. Economy, budget, zoning, population/residents, services and goals **do not**. Buildings generate no vehicle trips. The "Demand" selector only duplicated the Traffic/People sliders. Product decision taken: **sandbox + metrics** (section 5).

Count: **6 P0 · 49 P1 · 72 P2 · 54 P3** (consolidated items; duplicates across areas were merged).

### Status since the audit (2026-09-30)

| Area | Status |
|---|---|
| P0 (all six) | fixed |
| Data integrity, session, history, gestures (Lots 1–2) | fixed, except the quarantine UI (open) |
| Topology (Lot 3) | P1-13, P1-14, P1-15, P2-28 fixed; the rest open |
| Pedestrians | **replaced**: the People engine (navmesh agents) is live and the default since `7ec1994`; every pedestrian item below is closed by it |
| Vehicles | Drive v2 in progress behind `?drive=v2` (`87cac5d`: adaptive cruise control); vehicle items open |
| UI shell, camera, roads redesign, building mode, person creator | open |

---

## 2. Method and evidence

| Check | Result |
|---|---|
| `eslint .` | ✅ 0 errors |
| `tsc --noEmit` | ✅ 0 errors |
| `vitest run` (4 workers) | ❌ **2 failures**, 593 ok, 3 `it.fails`, 2 skipped — 459 s |
| Game in the browser (dev, Chrome) | straight/curved roads, terrain, bulldoze, poles, buildings (draw, shapes), inspect (road/junction), control, undo/redo, menus, language, quality, reload/persistence, minimap, phone 375×812, landscape 800×360, laptop 1366×768 |
| Runtime measurements | FPS, triangles, GPU textures/geometries, JS heap, rebuild time per edit, quality change |
| Code audit per subsystem | main/editor/persistence · simulation (vehicles, pedestrians, junctions, signals) · render/performance · world/geometry/buildings · UI/i18n/a11y. Findings were read line by line; some were confirmed with probe specs outside the repository, marked **[probe]**. |

**Screenshots** (in this folder):

| File | What it shows |
|---|---|
| `01-boot-empty.png` → `04-road-placed-undo-still-disabled.png` | vegetation reshuffled by the first road; undo grey after building |
| `06-menu-after-escape.png` | menu still open after Esc |
| `07-help-is-builder-only.png` | help for the building editor only, even with the Road tool |
| `08-control-tool-no-button.png` | Control tool active, no button, road tray shown |
| `09-road-shelf-after-second-click.png` | the road tray only opens on the second click |
| `11-english-select-label.png` | "Select" in English in the Portuguese UI |
| `12-phone-375x812.png` | phone: gallery cut off, no hint |
| `13-landscape-800x360.png` | landscape: road types unreachable |
| `14-laptop-1366x768.png` | laptop: hint line cut off |

`log.txt` holds the measurements of the walkthrough.

Evidence legend: **[E2E]** reproduced in the game · **[measured]** number collected at runtime · **[code]** confirmed by reading · **[probe]** confirmed by a throwaway spec.

Priority:
- **P0:** data loss or corruption, crash, lockup, or a red base.
- **P1:** serious bug, broken core flow, serious performance or memory problem.
- **P2:** moderate.
- **P3:** minor, or technical debt.

---

## 3. P0 findings

### P0-01 · The test suite is red on master — `fixed c22cd48`
- **Location:**
  - `tests/sim/pedestrians.spec.ts:335` ("walks around streetlight columns": minimum clearance 0.564 < 0.924 required);
  - `tests/sim/pedFlow.spec.ts:71` ("never leaves a drawn body standing": `longestStuck` 9.4 s > 5 s; 23.5 s standing in 28 episodes; 5 contacts; 152 sharp turns).
- **Current:** `npm run check` fails. Every PR starts from a red base.
- **Expected:** a green suite before any other fix.
- **Cause (confirmed by a tick-by-tick trace, section 8):**
  - (T1) the lamp test measures against a column **the world removes** since `48569a8`. A defect in the test, not the world.
  - (T2) the pedestrian's `stuck` counter locks into a cycle at 1.2 s (escalate → walk at 0.046 u/s → de-escalate), so it never reaches the 3 s release. A real defect, introduced by `c3015f3`/`d6ac0a5`.
- **Impact:** blocks verifying every later fix. Pedestrians visibly stuck by hydrants and posts.
- **Fix:** see section 8; then run the full suite and the pedestrian fuzz.

### P0-02 · The `angle` of drawn elements (walls, fences, stairs, floor) is lost on every road drawn, undo or reload [probe] — `fixed ed734bc`
- **Location:** `src/world/buildings/serialize.ts:228-246` (`migrateElement`); the field is read in `geometry.ts:144-151` and `render/buildings/buildingMesh.ts:941,1303,1357`.
- **Current:** `migrateElement` builds the object from an allow-list and does not copy `angle`.
  - Every `RoadDoc.clone()` goes through it: `commitDraft`/`commitRoadPath` on **every road drawn**, `history.record`, the autosave and import.
  - `BuildingStore.replaceWith` sees the difference and adopts the "unrotated" buildings.
- **Expected:** `angle` survives every cycle. `docs/buildings.md` promises "unknown fields are kept".
- **Cause:** the element migrator does not spread `...raw`, unlike the volume and storey migrators.
- **Impact:** silent loss of authored data; an unrotated element can cut through volumes, roads or neighbours without being re-validated.
- **Fix:** spread `...raw` first and normalise a finite `angle`; a round-trip test for every optional field of `BuildingElement`.

### P0-03 · A malformed map or autosave takes the boot down in a loop; huge ids overwrite entities [probe] — `fixed ed734bc, 21303e8, 194af0c`
- **Location:** `src/editor/persistence.ts:254-317` (`isSerializedDoc`); `src/world/doc.ts:642-729` (`fromJSON`); `src/world/ids.ts:37-41`; `src/main.ts:124-134` (module-level restore, no try/catch); `main.ts:1759-1766` (Open map).
- **Current:**
  - `poles`/`poleSpans` are not validated. `poles: {}` passes validation and `fromJSON` throws "not iterable". At boot this happens at module top level; since the input **was already accepted** it is not quarantined, and **every reload breaks**.
  - `terrain[].level` is not validated: `"high"` gives NaN terrain.
  - No position bound: x = 1e9 is accepted without `clampToMap`, and imported curves skip `fitCurve`.
  - id = 2^53 makes the `IdAllocator` "stop" (`2^53+1 == 2^53`): every `addNode` returns the same id and overwrites the previous one, leaving orphan references. The probe found 2 nodes where 4 were expected.
  - Buildings are migrated but never validated on load (x = 1e12 and `base` 99999 accepted; `levelElevation` loops 99999 times).
  - On Open map, `history.record(doc)` runs **before** an exception, leaving a bogus undo entry and an unhandled promise rejection.
- **Expected:** loading never throws; every field is validated and every invalid document is quarantined, with a message to the player.
- **Cause:** incomplete boundary validation and an unprotected restore.
- **Impact:** the game can become unusable until the player clears `localStorage` by hand.
- **Fix:** validate poles/spans (arrays, unique integer ids, finite x/y, boolean `lamp`, `a !== b`, existing ends) and terrain (finite `level`, `radius ≤ 180`); bound `isId` at `2**31`; clamp positions and `fitCurve` in `fromJSON`; clamp buildings (x/y on the map, `base < MAX_STOREYS`); wrap the boot restore in try/catch (quarantine, empty map, notice); on Open, record history only after success and catch errors.

### P0-04 · `clone()`/snapshot is not an identity: coincident nodes are merged and the road between them is deleted [probe] — `fixed ed734bc`
- **Location:** `doc.ts:646-676` (dedupe by `(x,y,heightOffset)` in `fromJSON`); `doc.ts:681` (segment with `a===b` dropped); `clone()` in `doc.ts:529-548`.
- **Current:** dragging two connected nodes into the same map corner clamps both to (2336,2336); `clone()` returns 2 nodes and 1 segment against 3 and 2 in the live document. On the next road drawn, undo or reload, **a visible road disappears**.
- **Expected:** `clone()` and snapshots are exact structural copies; legacy repair runs only at boot/import.
- **Cause:** legacy repair is built into the cloning path.
- **Impact:** data loss; undo and redo stop being inverses.
- **Fix:** `fromJSON(data, { repair: false })` for `clone()` and history; dedupe only at boot/import; keep `moveNode`/`addNode` from landing exactly on another node (see P1-18).

### P0-05 · The Move tool flattens curves irreversibly (neither undo nor cancel restores them) — `fixed ea12b58`
- **Location:** `doc.ts:322-338,352-362` (`moveNode` → `fitCurve`); `core/bezier.ts:132-145`; `main.ts:963-967` (live drag), `561-567` (`cancelMove`), `1106-1125` (commit).
- **Current:**
  - every `pointermove` mutates the live document; if the node passes a point where the curve would be too tight, `s.curve` is overwritten with a wider curve or `null`, and moving back does not recover it;
  - the undo snapshot is taken **afterwards**, with the curve already flattened;
  - a cancel (Esc not handled; pinch; tool change) or a zero-distance drag leaves the change with no history entry, and the autosave persists it.
- **Expected:** cancelling or returning to the origin restores everything, and undo returns to the state before the drag.
- **Cause:** the preview mutates the real document, and the "before" snapshot is taken too late.
- **Impact:** loss of authored geometry with no way back.
- **Fix:** a snapshot at drag start, used as the history "before" and restored on cancel; or preview on a clone.

### P0-06 · Undo/redo changes the map: legacy repair runs on every history step [code] — `fixed ed734bc, 9180a16`
- **Location:** `editor/history.ts:55-59` (`restoreInto` → `net.rebuild()` + `repairNearConnections`); `editor/repair.ts:21-40`.
- **Current:** if the Move tool left a loose end inside another road, the next undo/redo of **any** step (or a reload) splits the road and merges the node, creating a junction the player never drew. It triggers P1-15 (lost bans) and costs up to 64 network rebuilds.
- **Expected:** undo restores the snapshot exactly.
- **Cause:** the repair was meant for legacy maps but sits on the common restore path.
- **Impact:** history cannot be trusted and the document changes by itself.
- **Fix:** `repairNearConnections` only at boot and import, never in history's `restoreInto`.

### 3.1 Root cause of the 2 failing tests

- **T1** (lamp posts): fix the test to use `streetFurniture()`.
- **T2** (standing pedestrian): fix the `stuck` counter in `crossingFsm.ts:216-241`.

Details in section 8.

---

## 4. P1 findings

### 4.1 Player interface and flows

**P1-01 · The visible Undo/Redo are disabled and stale outside the building editor [E2E][measured] — `fixed ea12b58`**
- **Location:** `src/ui/builder/workspace.ts:191-202, 933-936`; `src/buildingsWiring.ts:712-716, 828-831`; `src/main.ts:1774-1792`.
- **Current:** after building roads the ↶/↷ buttons stay grey (`undoDisabled:true` in `log.txt`); they only "wake up" after Ctrl+Z, a language change or entering the building editor, and after leaving the editor they freeze at the last state.
- **Expected:** the buttons reflect `history.canUndo/canRedo` in every tool.
- **Cause:** two pairs of buttons. `updateHistoryButtons()` updates the hidden legacy pair `#undoAction/#redoAction`; the visible pair is only updated in `workspace.refresh()`, which runs only with the building editor active.
- **Impact:** the player believes nothing can be undone; mouse and touch have no undo.
- **Fix:** `updateHistoryButtons()` also calls `workspace.setHistory(canUndo, canRedo)`; remove the legacy pair and stop routing Ctrl+Z through a click on a hidden element.

**P1-02 · Drawing a building: the first corner clicked is dropped [E2E, reproduced twice][code] — `fixed ea12b58`**
- **Location:** `src/buildingsWiring.ts:764-770`.
- **Current:** in Buildings → Create → Draw, 3 clicks show "2 points"; 4 clicks + Enter make a **triangle**.
- **Cause:** with `toolId === 'sketch'` and no plan, `pointerDown` calls `tool.startPlan('new')` and `tool.pointerMove(...)` and returns without arming the click, so `pointerUp` never calls `click()`.
- **Fix:** after `startPlan`, delegate to `tool.pointerDown(...)`, which arms the click; a "4 clicks = 4 corners" test.

**P1-03 · "Shapes": the dragged rectangle becomes a diagonal blade [E2E][code] — `open` (building-mode redesign, Lot B)**
- **Location:** `src/editor/buildingTool.ts:389-399` (`shapeDragRing`), `402-417` (`updateShapeDrag`).
- **Current:** dragging a rectangle on screen from (520,60) to (620,125) made a 124 × 5 unit volume rotated 45°.
- **Cause:** the rectangle is the min/max of **world coordinates** while the camera has an azimuth (Q/E).
- **Fix:** build the rectangle in the camera frame and apply that angle to the building.

**P1-04 · The Road tool's tray (class, straight/curve/free, height, lanes) does not appear at boot [E2E] — `fixed 83c45b0, 64ecfa1` (the side panel shows the tool in hand's tray, and is put in that mode at boot)**
- **Location:** `workspace.ts` (tier 2 hidden), `main.ts` (`setTool`).
- **Current:** the game opens with the Road tool active but its tray hidden; it opens only on a **second** click of the active tool, while Terrain and Buildings open theirs at once.
- **Fix:** sync the tray at boot and on every `setTool`; a boot capture in `verify-ui`.

**P1-05 · Move, Split, Upgrade and Junction control exist only on the keyboard [E2E][code] — `fixed 83c45b0, ba5d0a8` (buttons in the road panel, each with its key in the tooltip)**
- **Location:** `index.html:84-89`; `main.ts:1270-1281` (shortcuts u, m, x, c).
- **Current:** no button for move, split or control; pressing C highlights nothing and the **road** tray stays open; shortcuts appear nowhere.
- **Fix:** an "Edit road" tool with buttons labelled "Name (Key)", its own tray for Control, correct `aria-pressed`.

**P1-06 · The tray cuts off the hint line and the gallery at 1366×768, on phones and in landscape [E2E][code] — `open` (Lot U)**
- **Location:** `src/ui/builder/workspace.css:141, 159-163, 178-190, 657-672`.
- **Current:** at 1366×768 the hint line disappears with the road tray open; at 375×812 the type gallery is cut off and the lane row unreachable; at 800×360 the road-type gallery does not appear; in the building editor at 657 px tall, tier 3 gets about 0 px.
- **Cause:** `max-height: min(42dvh, 380px)` with `overflow:hidden`; only tier 3 shrinks.
- **Fix:** scrollable tier 2, a fixed footer, tier 3 at least one row, `verify-ui` at five sizes.

**P1-07 · Esc and clicking outside close neither menus nor help; menus are not keyboard-operable [E2E][code] — `open` (Lot U)**
- **Location:** `workspace.ts:243-276`; `buildingTool.ts:1795-1811`; `ui/chrome.ts:115-120`.
- **Current:** Menu, Simulation and "?" stay open after Esc; clicking the canvas closes the menu **and** runs the tool (starts a road); the chips have no `aria-haspopup/aria-expanded`.
- **Fix:** one popover controller: Esc and an outside pointerdown close it and consume the event, focus goes to the first item, ARIA state.

**P1-08 · "Free opening" and the "Fence" tile do nothing [code] — `open` (Lot B)**
- **Location:** `src/ui/builder/catalog.ts:122, 192-208`; `buildingsWiring.ts:196-300, 909` (`READY`).
- **Current:** `runTool('freeOpening')` and `runTool('fence')` have no branch; the buttons look enabled because `READY` derives from the catalogue; a typo item `pillarr`.
- **Fix:** implement or remove; derive `READY` from a table shared with `runTool`.

**P1-09 · Missing i18n keys: the player (or a screen reader) sees the raw key [code] — `fixed d0304f7` (missing keys, translations); dead keys `open`**
- **Location:** `buildingTool.ts:305`; `main.ts:1918,1931`; `src/ui/i18n/en.ts`, `pt-BR.ts`.
- **Current:** `hint.builder.run.stair` missing; the whole `hint.mobile.builder.*` namespace (38 reachable keys) missing and read aloud through `aria-describedby`; 305 of 892 keys unused; pt-BR shows English for Snap/Push-Pull/Inset/Outset.
- **Fix:** a spec collecting literal and dynamic keys from TypeScript that fails on a missing one (`tests/ui/i18nKeys.spec.ts`); delete dead keys; translate the four.

**P1-10 · Icon-only buttons without an accessible name [E2E][code] — `open` (Lot U)**
- **Location:** `main.ts:109`; `workspace.ts:193,199,208,341,366`; `workspace.css:654`.
- **Current:** on first load undo, redo, help, collapse and the inspector toggle have no `title` and no `aria-label`; on phones the Menu/Simulation/Select chips become nameless icons.
- **Fix:** `applyTranslations(root)` at the end of `initBuilderWorkspace`; `data-i18n-label`; `aria-label` on the chips, updated in `relabel()`.

**P1-11 · Opening an invalid file fails silently; the autosave can fail silently [code] — `fixed 21303e8`; quarantine UI `open`**
- **Location:** `persistence.ts:78-85, 219-252`; `main.ts:1759-1766` and every `saveSession*` caller.
- **Current:** cancel, invalid JSON and invalid schema all return `null` and the player sees nothing; a full `localStorage` makes `saveSession` return `false` unnoticed; the quarantine is never shown nor cleared.
- **Fix:** `importFromFile` returns `{ok|cancelled|invalid, reason}`; `hint.openFailed`; a persistent notice when saving fails; UI to export/discard the quarantine.

**P1-12 · Pieces of the save are lost when the tab is discarded; fragile export [code] — `fixed 21303e8`**
- **Location:** `main.ts:2836-2844`; `persistence.ts:215`.
- **Current:** saving only on `beforeunload` and a 700 ms debounce; `URL.revokeObjectURL` right after `a.click()`; the import promise never settles where `cancel` is not fired.
- **Fix:** flush on `visibilitychange→hidden` and `pagehide`; revoke on a timer; a fallback for cancel.

### 4.2 World model, topology and editor

**P1-13 · Turn bans vanish when a road is split, joined or deleted, and can come back on the wrong road [probe] — `fixed 57b9741`**
- **Location:** `editor/commit.ts:586-607, 460-463`; `world/doc.ts:265-272, 301-314, 594-597, 653, 697`; consumer `world/lanelets.ts:364`.
- **Current:** `blockedMovements` keys by segment id; a split (automatic when a new road crosses) makes new ids and does not remap them; remove, join and merge leave dead keys; allocators restart at max+1, so a deleted id can be reused and an old ban applies to a new road.
- **Fix:** remap on split and join, prune on remove and merge, persist `nextIds`, keep `max(peek)` in `replaceWith`.

**P1-14 · After drawing a road the network keeps stale crossing distances [probe] — `fixed 57b9741`**
- **Location:** `world/network.ts:221-236` (`adopt()` does not clear `crossingDistances`/`crossingWalkable`).
- **Current:** a crossing measured 24.2 still reads 24.2 after a highway was connected; a fresh network reads 0.
- **Fix:** clear both caches in `adopt()`; fuzz invariant "live network ≡ `new Network(doc)`".

**P1-15 · The Move tool edits topology with no checks [code][probe] — `fixed d897a99, 64303e8`**
- **Location:** `main.ts:964, 1109-1123`; `doc.ts:322-338`.
- **Current:** dropping a node can make a zero-length segment, land on another node, make one road cross another **without a junction** (vehicles drive through each other), or leave a loose end inside another road.
- **Fix:** merge within `MERGE_EPS`, refuse short chords, split crossings at the same level like `commitDraftInPlace`, straight curves when the chord is under `GEO_EPS`, degenerate legs handled.

**P1-16 · Benches, bins and post boxes sit off the footway, inside buildings [probe] — `open`** (the People engine walks sitters the few steps from the footway to a bench, `39e34f1`; the placement itself is unchanged)
- **Location:** `world/streetFurniture.ts:117-150`; `editor/buildingSnap.ts:84`; `world/buildings/validate.ts:64`.
- **Current:** the furniture line is at `width/2 + sidewalk*0.95` and items are pushed a further 0.9–1.1 m **outward**; 0 of 9 items on the footway; benches fall inside street-front buildings.
- **Fix:** a furniture line at about 0.55·sidewalk; drop items inside building footprints; extend `tests/world/streetFurniture.spec.ts`.

### 4.3 Simulation

**P1-17 · Open map, New map or import keeps the previous map's agents and state [code] — `fixed 521c7e7`**
- **Location:** `main.ts:464-485`; `main.ts:136`; `sim/pipeline.ts:146-220`.
- **Current:** lanelet and footway ids coincide across maps, so vehicles whose id exists in the new map carry on **on an unrelated road** with their old route, destination, claims and stop; issues, trips, demand and volumes persist.
- **Fix:** `SimWorld.reset()` on open, import and new map, before the rebuild.

**P1-18 · Orphaned pedestrians are teleported and stacked on one footway [code] — `fixed 521c7e7`, then `replaced 7ec1994`**
- **Current:** a pedestrian whose edge vanished went to the **first** walk edge of the map at `s=0`, keeping its activity, slot and party links.
- **Now:** the People engine re-seats everyone on the nearest walkable ground after an edit.

**P1-19 · Vehicles with a destination never change lane to turn [code] — `fixed` in Drive v2 (`src/sim/drive/tactical.ts`, tested by `tests/sim/drive/tactical.spec.ts`; `?drive=v1` keeps the old planner)**
- **Location:** `sim/routing/router.ts:30-38, 41, 69`; `routing/destination.ts:60-87, 97-134`.
- **Current:** `planFrom` with a destination clears `desiredLane` and runs Dijkstra only over the exits of the current lane, with no lane-change edges; in the wrong lane a car goes round the block or makes a U-turn.
- **Fix:** sibling-lane edges in routing, reachable exits per carriageway, a test with a destination.

**P1-20 · Traffic at 0% kills the entries for good; raising the slider only works minutes later [code] — `fixed` (each entry keeps the rate its wait was drawn at and rescales it when the rate changes; test `tests/sim/drive/entryRate.spec.ts`)**
- **Location:** `sim/vehicles/spawn.ts:56-58, 76-94`.
- **Fix:** keep the rate per entry and rescale the remaining wait; infinite at 0, redrawn on the first positive value; bound the backlog.

**P1-21 · Right turns and continuations at a two-leg node pass one car at a time [code] — `fixed` by construction (`movement:` tokens are shareable; not reproduced on the test maps, where the deadlock test refused nothing in 120 s; regression test `tests/sim/drive/convoy.spec.ts`)**
- **Location:** `sim/intersections/admission.ts:680-697, 790-795, 834-835`.
- **Cause:** `bankerSafeAfterGrant` sees two owners of `movement:C` and denies; `sharedConvoyResource` only accepts `point:`.
- **Fix:** `sharedConvoyResource` true for `movement:`; a test of two cars turning right on green.

**P1-22 · The ring-gridlock breaker (`cycles.ts`) never acts on a connected city [code] — `fixed` (loops are each link's shortest way round without U-turns, bounded, metered one by one; test `tests/sim/drive/cycles.spec.ts`)**
- **Location:** `sim/intersections/cycles.ts:28, 67-134`.
- **Cause:** maximal strongly connected components: with two-way streets the whole city is one component, larger than `MAX_CYCLE_STORAGE`, and is discarded.
- **Fix:** the shortest cycle per link, bounded, merged where links share a cycle; precomputed per topology.

**P1-23 · A pedestrian steps back onto the same zebra without asking, or is teleported to the other side [code] — `replaced 7ec1994`**
- **Now:** a People-engine walker can only enter a zebra's triangles once granted, and only walks.

**P1-24 · Without buildings, pedestrians pick unreachable goals and never recover [code] — `replaced 7ec1994`**
- **Now:** goals are points of the navmesh, every route is an A* path that exists, and a failed plan picks another goal.

**P1-25 · The pedestrian population only grows; alightings pierce `PED_CEILING` and are invisible [code] — `replaced 7ec1994, eaa3a6c`**
- **Now:** people come and go through doors and the map's edges; the population is held at its target.

**P1-26 · A delivery stop can stand in the lane for ever [code] — `fixed` (a give-up time in every phase but the transfer, a delivery hold that ends with no person; test in `tests/sim/kerbStops.spec.ts`)**
- **Location:** `sim/vehicles/kerbStops.ts:252-259, 277-287, 525-530`.
- **Fix:** give up after `GIVE_UP` in every phase but 'transfer'; `abandon()` when there is no footway; finish 'hold' with no person.

### 4.4 Performance and memory

**P1-27 · ~570 MB of JS heap on a small map: citizen animation baked at ~11 MB per body, never freed, duplicated for children's "looks" [measured][code] — `open` (Person model, H4/H7)**
- **Location:** `render/riggedCitizens.ts:280-306, 343-356, 401-490, 60`; `citizenGait.ts:135`; `citizenCasting.ts:81-86`; `citizenWalk.ts:371-395`.
- **Current:** heap 102 MB empty → 202 MB with 4 roads → **~570 MB steady** with 39 roads and ~60 people; each body bakes ~25 clips as 4×4 matrices (81 bones × 64 B per frame): F ≈ 10.4 MB, M ≈ 11.6 MB, ~67% of it static loops; children's looks reload and rebake the **same GLB** four times; with no eviction ~65 bodies × 11 MB ≈ **700 MB** on a busy map, plus ~3.6 MiB of GPU texture per body.
- **Expected:** a bounded memory budget (a few hundred MB at most) and one batch per GLB.
- **Fix, by gain:** bake clips on demand; batch per `sourceId` with the look as a per-instance attribute; quaternion + translation or half-float palettes; evict batches unused for N minutes; drop the decoded library after baking; a budget checked in `verify-citizens`.

**P1-28 · Every edit rebuilds the whole world: 150 ms measured for one road on a 39-road map [measured][code] — `open` (Lot 7; the pedestrian navmesh rebuild was halved in `35aba8a`)**
- **Location:** render `renderer.ts:322-376`, `roadSurfaces.ts:508-556`, `renderer.ts:473` + `buildings/layer.ts`; simulation `sim/world.ts:232-257`, `world/lanelets.ts:163-172`, `world/conflictPoints.ts:178-239`; editor `doc.ts:557-605` + `history.ts:55-59`.
- **Current:** `rebuildMs` 150 ms (39 segments) and 319 ms on load; FPS dropped from 60 to 41 while editing. Project target: a local edit under 30 ms.
- **Fix:** one Mesh per tile per band kept when its digest matches; tile + digest for vegetation, grass, structures and buildings; simulation topology per dirty node/segment; controllers rebuilt only at changed junctions.

**P1-29 · Undo, redo, import and New map always rebuild roads and traffic, even when only a building, pole or terrain changed [code] — `fixed 9180a16`**
- **Location:** `doc.ts:557-605` (`replaceWith` always bumps `revision`, `trafficRevision` and `utilityRevision`); `history.ts:55-59`; `repair.ts:27-38`; `main.ts:464-485`.
- **Fix:** `replaceWith` compares nodes/segments (structural hash) and poles/spans and bumps only what changed; no second rebuild; no repair in history; `applySnapshot` rebuilds topology only if `trafficRevision` changed.

**P1-30 · GPU resources leak on every quality change [measured][code] — `open` (Lot 7)**
- **Location:** `render/postprocess.ts:118-119, 131-134`; `renderer.ts:381-392`.
- **Current:** with the simulation paused each low↔high cycle leaves **+2 textures**; `EffectComposer.dispose()` does not dispose `SMAAPass`, `OutputPass`, `RenderPass` nor the `GTAOPass` materials; a boot with a saved level builds and throws away a "high" chain.
- **Fix:** `createPostChain` keeps `passes[]` and disposes each (plus the GTAO materials); better, one chain with `pass.enabled`.

**P1-31 · The "Automatic" governor oscillates, makes the trees vanish and come back, and pins 30 Hz screens at Low [E2E][code] — `open` (Lot 7)**
- **Location:** `render/quality.ts:159-190`; `renderer.ts:514-528`; `QUALITY.low.vegetation = 0` (`quality.ts:53`).
- **Current:** vegetation disappeared and came back several times (Low = 0 trees); it steps down past a 29.4 ms median, so at 30 Hz it sinks to Low and never climbs back (< 20 ms needed); CPU cost is ignored when stepping down; on-demand frames count as slow frames; Auto after a manual Ultra starts at Ultra; every level change forces a full rebuild.
- **Fix:** step down only when frame work dominates the interval (or GPU time via `EXT_disjoint_timer_query`); detect the cadence cap; sample only consecutive rAF frames; Auto restarts at High; a level change rebuilds only vegetation, and only if density changed; Low keeps ~25% of the vegetation.

**P1-32 · One failed download hides the citizens for the whole session [code] — `open` (Person model)**
- **Location:** `render/citizenWalk.ts:398-415`; `riggedCitizens.ts:492-503, 598-603, 657-660`.
- **Current:** `library ??= Promise.all(...)` keeps the **rejected** promise: after one transient failure no pedestrian, driver or passenger is drawn until reload, motorcycles ride with no rider; per body, the rejection is kept and never retried; no notice.
- **Fix:** reset on rejection; retry with backoff; keep a failed body out of casting until loaded; a UI notice after N failures; a test with `fetch` failing once.

**P1-33 · The "cheap" audit runs every tick in the shipped game and floods the issue list [code] — `open` (Lot 6)**
- **Location:** `main.ts:138-139`; `sim/pipeline.ts:133-135, 317`; `sim/invariants.ts:18-169`; `sim/world.ts:591-594`; `main.ts:2820-2827`.
- **Current:** per tick it recomputes the signal deps and runs `maxCycle(w)` (O(V·C)) per stopped vehicle; persistent conditions are re-inserted 60×/s into a 512 ring with O(n) `shift()`; `issues` is never cleared; raw codes reach the player untranslated.
- **Fix:** audit once a second; dedupe by (code, subject) with first/last seen; expiry; `maxCycle` once per audit; translate or show in dev only.

**P1-34 · O(N) scans per agent per tick in signals, admission and pedestrians [code] — pedestrian part `replaced 526fb55, 7ec1994` (crossing states are published once per tick); the rest `open` (Drive v2, Lot 6)**
- **Location:** `sim/world.ts:392-416`; `signals/fsm.ts:189-201, 325-330`; `intersections/spillback.ts:44-47`; `admission.ts:549, 751, 813-829`; `cycles.ts:55`.
- **Current:** O(C·S·P) plus O((heads+requests)·N) per tick; e.g. 50 junctions × 4 stages × 1000 pedestrians ≈ 200k iterations per tick.
- **Fix:** one pass per tick building crossing → {demand, longest wait}; a `committedByConnector` index; the Banker's process list built once; lazy `competingDemand`.

**P1-35 · The pedestrian motion solver runs the collision gate on all ~70 candidates [code] — `replaced 7ec1994`**
- **Now:** a People-engine body takes one forward step, checked once against the mesh and its neighbours.

**P1-36 · Every edit and every autosave serialises the whole document several times; the autosave fires on camera moves [code] — `fixed ed734bc, b886d66`**
- **Location:** `main.ts:444-447`; `buildingsWiring.ts:130-133`; `store.ts:93-99`; `persistence.ts:78-92`; camera triggers `main.ts:1126, 1162, 1197`.
- **Current:** each undo/redo allocated ~15 MB transiently (heap 631 → 881 MB over 30 operations); wheel, pan and rotate rewrote the whole document because camera settings shared its key.
- **Fix:** `History.recordSnapshot(before)`; road commits do not clone the building store; settings under their own key; serialise only when a revision changed, on idle.

**P1-37 · Traffic signals recompute world geometry every frame (breaks invariant 4) [code] — `open` (Lot 7)**
- **Location:** `render/signals.ts:248-331`; `world/signalPosts.ts:36-52`.
- **Fix:** cache positions per `net.revision + trafficRevision`, write the static batches once, only the lamps per frame.

**P1-38 · A lost WebGL context is not handled [code] — `open` (Lot 7)**
- **Location:** no `webglcontextlost|contextrestored` in `src/`; `render/environment.ts:160-171` (PMREM generated once).
- **Current:** three restores geometry and data textures but `scene.environment` stays black (car paint, glass, water); the on-demand loop is not restarted; no message.
- **Fix:** pause and warn on loss; on restore regenerate the environment, `shadowMap.needsUpdate`, `requestDraw()`; a test with `WEBGL_lose_context`.

### 4.5 Test-base quality (items that hid the bugs above)

**P1-39 · `clock.tick` does not advance in tests: signal fairness, admission FIFO and watchdogs only run in the game [code] — `fixed ea3178c`**
- **Location:** `sim/clock.ts:46-50, 60-65`; consumers in `admission.ts`, `signals/fsm.ts`, `pipeline.ts`, `invariants.ts`, `crossingFsm.ts`.
- **Fix:** `w.clock.tick++` at the end of `pipeline.step`, `advance/run` counting substeps only; a per-controller clock in seconds.

**P1-40 · The fuzzer and the snap specs test functions the game does not use [code] — `fixed ed734bc`**
- **Location:** `tests/fuzz/support/ops.ts:9-10, 89-92, 117-122`; `tests/editor/snap.spec.ts`; the app uses `snapRoadEndpoint` and `commitRoadPath`.
- **Fix:** the fuzzer drives `commitRoadPath` with heights; the `move` op reconciles like P1-15.

**P1-41 · `verify-ui.mjs` cannot catch the layout defects and photographs the wrong thing [code] — `open` (Lot U)**
- **Location:** `scripts/verify-ui.mjs:16, 75, 88, 95`.
- **Current:** a fixed 1440×900 viewport; menus found by Portuguese text; `.bw-chip:nth-of-type(4)` picks the grid toggle; `opened = … || true` always passes; no road/terrain trays, road inspector, minimap, pt-BR or keyboard focus.
- **Fix:** `data-*` hooks; forced language; a viewport loop; close menus with Esc; cover road, terrain, inspector and phone.

### 4.6 Other P1

**P1-42 · Signal controllers: stale group ids after an edit switch lights without amber [code] — `open`**
- **Location:** `world/approachGroups.ts:74-81`; `signals/fsm.ts:373-406`.
- **Fix:** identify groups by their segment set and adopt a new plan only at the ALL_RED→GREEN boundary.

**P1-43 · Every edit resets every controller in the map, twice [code] — `open`**
- **Location:** `sim/world.ts:236, 252, 471-485`; `fsm.ts:376-403`.
- **Fix:** a plan signature; rebuild only the changed junctions; deferred adoption.

**P1-44 · Junctions without lights run a light cycle; the inspector shows green/amber/red on Stop and Priority [code] — `fixed` (no cycle is stepped without lights; the stall counters and the inspector's lamps ask `signalised`)**
- **Location:** `signals/plan.ts:152-166, 406-418`; `pipeline.ts:85-88`; `ui/inspector.ts:327-331`.
- **Fix:** skip `stepController` and demand when not signalised; guard the inspector.

**P1-45 · Signals never rest on green: they cycle through empty stages [code] — `open`**
- **Location:** `fsm.ts:214, 221, 273, 314`.
- **Current:** with demand on one side only, each 34 s of green costs ~15 s of amber, all-red and empty minimum green; a lone car arriving just after waits ~10 s at an empty junction.
- **Fix:** end green only for competing demand (at max-out too).

**P1-46 · A vehicle whose route ends on a short link stays at the stop line for ever [code] — `fixed` (the route is grown past a short tail in `ensureVehicleRoutes`; test `tests/sim/drive/shortTail.spec.ts`, fails before, passes after, v1 and v2)**
- **Location:** `admission.ts:504-505`; `pipeline.ts:379-382`; `router.ts:91-118`.
- **Fix:** extend the route when the last link is shorter than the vehicle plus margin, or fewer than 2 links remain.

**P1-47 · A vehicle crossing at speed stops instantly (unbounded deceleration) [code] — `fixed` (Drive v2 operational layer c4059dc; obstacle producers: a kerb-stop hold point, the zebra margin and the pedestrian denial only count while the car can stop for them in comfort; measured on the test city, hard brakes 1.03 → 0.078 per vehicle-minute and emergency ticks 0.124 → 0)**
- **Location:** `vehicles/idm.ts:86-91, 114-115`; `integrate.ts:97-113`.
- **Current:** the safe-speed cap zeroes the speed in one tick (12 m/s → 0) at any new obstacle; `safeSpeed` uses the follower's `bEmergency` for the leader.
- **Fix:** a hard-brake metric (in the Drive v2 probe); use the leader's `bEmergency`; obstacle producers respect `canStopComfortably`.

**P1-48 · Vegetation reshuffles entirely when the network's extent changes (first road, extending the grid) [E2E][code] — `open` (Lot 7)**
- **Location:** `render/scenery.ts:433-445`.
- **Fix:** seed per world grid cell, a fixed window on the terrain plate, local exclusion per road; rebuild only touched tiles.

**P1-49 · The first launch can restore an extreme zoom; the camera frames the map ignoring the dock [E2E] — `open` (Lot C)**
- **Location:** `main.ts` (`restoreSettings`, `fitView`).
- **Current:** a session saved at `zoom: 72` opened at 7200%, only grass; Home/fit hides the grid behind the bottom tray.
- **Fix:** clamp the restored zoom; `fitView` uses the visible area (viewport minus dock, bar and minimap).

---

## 5. City-builder systems: what exists, and product decisions

| System | State |
|---|---|
| Road network (classes, lanes, direction, levels, height, curves) | Modelled and simulated |
| Terrain and rivers | Modelled; relief hard to read from the near-top-down camera (P2-40) |
| Traffic (vehicles, pedestrians, signals, crossings) | Simulated; see P1-17 to P1-26 and P1-42 to P1-47 |
| Buildings | Fully authored, validated, rendered and saved. Linked to the simulation only as **pedestrian destinations** (ground-floor doors). No vehicle trips, parking or deliveries; `use`, `spaces`, `cores` and `Entrance.steps` are stored but not simulated |
| Poles, wiring and street furniture | Decorative, and obstacles to pedestrians (P1-16, P2-25) |
| Economy, budget, costs, zoning, population, services, goals, statistics | **Do not exist** |
| "Demand" (Low/Normal/Peak) | Only multiplies the same two quantities as the Traffic/People sliders; no time profile, no O/D matrix |
| `completedTrips`, `entryDemandLost` | Computed, never shown |
| Traffic entries/exits | Any dead end ≥ 30 m, even mid-city (P2-01) |

**Decision taken (2026-09-30): sandbox + metrics.** No economy, budget or zoning; the existing metrics are to be shown (P2-02) and "Demand" given a real time profile or removed.

---

## 6. P2 findings

Format: **ID · title** — location — current → expected · cause · fix — **status**.

### 6.1 Simulation

- **P2-01 · Traffic is born and dies at any dead end** — `spawn.ts:45-53,130-133,183-202`; `destination.ts:53-57` — an unfinished street mid-city spawns and swallows cars though the comment says "only at the map edge" · `world/bounds.ts` is not consulted · count as an entry/exit only near the map boundary or at a marked "external connection" — **open**.
- **P2-02 · Metrics computed and not shown** — `spawn.ts:91,199`, `world.ts` — `completedTrips`, `entryDemandLost` and delay are hidden · show them in the Simulation panel — **fixed** (trips completed, arrivals turned away, mean speed and vehicles queued, in the Simulation menu).
- **P2-03 · People slider/Demand: the population only grows slowly; `populationShare` sampled at boot only** — `peds/spawn.ts:11,38-44`; `main.ts:142` · recompute on resize — pedestrian part **replaced 7ec1994**, resize **open**.
- **P2-04 · Kerb stops: a vehicle stage creates and deletes pedestrians with no cleanup or ceiling** — `kerbStops.ts:574, 609-651` — **replaced ab034a6, 7ec1994** (kerb stops go through the `PeopleBridge`).
- **P2-05 · Stop planning scans the whole city per vehicle per tick** — `kerbStops.ts:221-227, 451-523` · a footway index per segment; replan only on lanelet entry — **open** (Drive v2 stop tasks).
- **P2-06 · A full Dijkstra on every lane change or reconsideration; O(n²) `unshift`; `new Set(visited)` per recursion** — `router.ts:28-42,91-99,158-229`; `integrate.ts:267-268` · push+reverse; cached reverse trees per destination; spread reconsiderations — **open** (Drive v2 strategic layer).
- **P2-07 · A shortened link stacks vehicles at the same `s`** — `pipeline.ts:158` · map `s` proportionally or reproject, and respace by `JAM_GAP` — **open**.
- **P2-08 · Spawning ignores the birth speed (born at ~5 m/s 2 m behind a queue)** — `spawn.ts:146-170` · require `JAM_GAP + v²/2b` or be born at the leader's speed — **fixed** (born at the fastest speed its driver needs no more than comfortable braking for; it was most of the fleet's hard braking).
- **P2-09 · No last-resort recovery for a stuck vehicle** — `pipeline.ts:306-330` · after long immobility outside a red: release reservations → replan → despawn with an issue — **open**.
- **P2-10 · An edit does not reacquire claims for vehicles inside the junction** — `conflictPoints.ts:268-276`; `pipeline.ts:176`; `claims.ts:93-118` · `grantAll` in `rebindVehicles` for the zones still ahead — **open**.
- **P2-11 · One bad pair anywhere vetoes every admission in the map** — `admission.ts:790-795` · check double ownership only on the requester's resources — **fixed** (the double-holding veto only counts resources the grant concerns).
- **P2-12 · A re-edit re-sweeps the conflict zones of every junction** — `conflictPoints.ts:178-239, 425-454` · compare each connector's shape with the previous build by id and reuse the junction when nothing changed — **open**.
- **P2-13 · A pedestrian enters the zebra from up to 1.5 m (or a slot) before the kerb: a teleport** — **replaced 7ec1994** (a body only walks; it waits at a point on the kerb and steps onto the zebra when granted).
- **P2-14 · A pedestrian stands on the zebra up to 7 s after reaching a goal at the kerb** — **replaced 7ec1994**.
- **P2-15 · A pedestrian waits for ever for a refused crossing** — **replaced 7ec1994** (replans when getting nowhere).
- **P2-16 · Signal controllers scan pedestrians (duplicate of P1-34, pedestrian side)** — **replaced 526fb55** (crossing states published once per tick).
- **P2-17 · The crossing-permission check runs up to 4× per pedestrian per tick; `intent.holding` is never read** — **replaced 7ec1994**.
- **P2-18 · The clearance grid is rebuilt from scratch every tick; allocations in the reservation index** — **replaced 7ec1994**.
- **P2-19 · Two pedestrians on one bench seat after an edit** — **replaced 39e34f1** (seats keyed by position and held by one person).
- **P2-20 · Furniture and trees removed when a road is raised, but pedestrians use the old set** — `streetFurniture.ts:108-113`; `doc.ts:405-412` — **open**.
- **P2-21 · "One writer per field" violations** — claims released in stages 0/2/5/6/7; `lastMovedTick` with two writers (`admission.ts:203`, `integrate.ts:132`); `w.rt()` creates a runtime on read paths; a false docstring in `fsm.ts:161-164` · an `admittedTick` field; a non-creating `rt` for reads; fix the header — **open**.

### 6.2 World, geometry and buildings

- **P2-22 · Every road commit and every undo changes every building with elements (`nextElementId` +1 per migration)** [probe] — `serialize.ts:337`; `store.ts:93-99` · `max(raw.nextElementId, maxId+1)` — **fixed 194af0c**.
- **P2-23 · The "road wins" rule ignores ground-floor projections (bay windows up to 2.4 m)** — `editor/buildings.ts:572-592` × `validate.ts:138` · one shared `groundFootprint()` — **open**.
- **P2-24 · Building footprints use raw polygon-clipping (Martinez) with no fallback** — `world/buildings/footprints.ts:41-59` · go through `@core/clipper` and report instead of throwing — **open**.
- **P2-25 · Poles on the carriageway or in buildings, never removed by a new road, duplicated at the map edge** — `editor/poles.ts:180-213`; `doc.ts:164-171` · clamp before planning; skip carriageway and footprints; a "road wins" pass for poles — **open**.
- **P2-26 · Holes in the asphalt on 3–5° bends** — `junction/build.ts:25, 110-111`; `network.ts:612-637` · extend the ends by `SEAM_OVERLAP + hw·tan(β/2)` or lower the tolerance to ~0.5° — **fixed** (each end's overlap covers its bend's wedge; test `tests/world/bendSeam.spec.ts`).
- **P2-27 · The minimum-angle guard was removed, but code and comments still describe it** — `legAngles.ts`, `commit.ts:33`, `junction/build.ts:353-357` · restore the guard or delete the dead code — **open**.
- **P2-28 · Two segments between the same pair of nodes** — `doc.ts:239-263, 301-313` — **fixed 64303e8**.
- **P2-29 · Welding merges rotated buildings that are only near each other and inflates them (AABB swap)** — `editor/buildings.ts:790-830` · a real polygon overlap test — **open** (Lot B).
- **P2-30 · Loaded data is not normalised (a negative speed freezes a "playing" sim; unbounded intensities and volumes)** — `persistence.ts:188-196`; `main.ts:231, 1802`; `sim/clock.ts:44`; `serialize.ts:293` — **fixed 21303e8**.
- **P2-31 · Terrain stamps: the 4096 cap silently erases old sculpting; fast strokes rewrite all 90,601 vertices** — `doc.ts:414-420`; `render/terrain.ts:699-748` · compact stamps into a height layer; warn near the cap; incremental updates — warning **fixed 699f6fe**; compaction and incremental updates **open**.
- **P2-32 · Every terrain stroke and every road rekeys and rebuilds every building** — `renderer.ts:473`; `buildings/layer.ts:112-128,185-196` · re-digest only buildings in the changed region; per-tile assembly — **open** (Lot 7).
- **P2-33 · Flattening from on top of a bridge fills terrain up to the deck** — `main.ts:677, 525-528` · use `scene.terrainHeightAt` — **open**.

### 6.3 Editor, input and gesture state

- **P2-34 · Cancelling a gesture resets different state depending on the path (6 divergent lists)** — Ctrl+Z during a drag kept moving the node of the restored document; a right click cancelled only `roadChain`; `painting` and `shapeDragStart` survived a tool change (hovering **painted faces with no button**); no `blur`/`lostpointercapture` · one `cancelGestures()` — **fixed ea12b58**.
- **P2-35 · A third finger runs the tool (Bulldoze deletes a road)** — `main.ts:707` · `pointers.size >= 2` — **fixed ea12b58**.
- **P2-36 · Letter/digit shortcuts fire with Ctrl/Alt/Meta** — `main.ts:1261-1283` · ignore with modifiers — **open** (Lot U).
- **P2-37 · Keys 1–4 in the editor change a hidden legacy "stage"; 5–6 leave the editor** — `buildingTool.ts:468-475, 1778-1779` — **open** (Lot U).
- **P2-38 · The editor help documents wrong shortcuts; help exists only for buildings** [E2E] — says "R rotates 15° (Shift: 90°)" while the code does the reverse; "Ctrl+G groups" does not exist · per-tool contextual help with every shortcut — **partly fixed 83c45b0** (Bulldoze, Poles and Inspect show a help card with their keys and the camera's in the side panel); the builder's help text is still open.
- **P2-39 · Operation tiles announce the wrong shortcut; shortcuts appear nowhere** — `aria-keyshortcuts` is the first letter of the translated name ("Dividir" = D, the key is X) · a fixed `data-key`; title "Name (K)" — **partly fixed 83c45b0** (the rail's tools carry "Name (K)" and show the key); the road operation tiles are still open.
- **P2-40 · Relief and height are imperceptible; out-of-range values are clamped silently** [E2E] — "Road height" 9999 → 5.7 m with no notice; a junction at +5.7 m looks flat from above · show the limit; relief shading or an optional camera tilt — **partly fixed 603400c** (free camera tilt from 30° to straight down, and free turning); the silent clamp is still open.
- **P2-41 · Bulldoze does not highlight what it will remove on hover** [E2E] — **open** (Lot U).
- **P2-42 · The "Allowed movements" list is unreadable** [E2E] — repeats "Local road — Local road (straight)" · label by leg (N/S/E/W or bearing) and highlight on hover — **open** (Lot U).
- **P2-43 · Control (C) and other tools show the road tray** [E2E] — a tray per tool — **fixed 83c45b0** (each tool fills the side panel with its own tray or help card).
- **P2-44 · A language change leaves parts in the old language** [E2E] — "Select" stays Portuguese; operation titles; lanes; an open menu — **open** (Lot U).
- **P2-45 · The status bar shows raw audit codes to the player** — see P1-33 — **open**.
- **P2-46 · Two hint systems; the one describing the canvas is dead in the editor; hints cut to one line on phones** — one hint source per mode — **open** (Lot U).
- **P2-47 · Feedback is not announced to screen readers; the road inspector floods `aria-live` every 0.4 s** — one `role=status` region for flashes; remove `aria-live` from `#inspector` — **partly fixed 83c45b0** (`aria-live` removed from the inspector); the status region is still open.
- **P2-48 · Unlabelled controls and small touch targets** — collapse 24×20, quick buttons 26, chips 28 · i18n labels; ≥ 24 px always, ~40 px with `(pointer:coarse)` — **open** (Lot U).
- **P2-49 · Actions that need a selection fail silently** — `needsSelection` → disabled, or a notice — **open** (Lot B).
- **P2-50 · Saved templates cannot be deleted; saving fails silently; `window.prompt`** — a delete button with confirmation; thumbnails; an input in the tray — **open** (Lot B).
- **P2-51 · Invisible pause** — the Pause button lives in the hidden legacy bar · a "Paused" badge on the Simulation chip — **open** (Lot U).
- **P2-52 · The editor inspector covers the minimap and the dock** — **open** (Lot U).
- **P2-53 · Remove node in the inspector: wired, never rendered** — **open** (Lot U).
- **P2-54 · The editor's "Frame selection" does nothing** — `host.focus` is a no-op; `deps.focusBuilding` is dead code — **open** (Lot U).
- **P2-55 · Edits that change nothing create an undo step and clear redo** — compare the four revision counters before and after — **open**.
- **P2-56 · Snapping and pole planning computed unused** — `main.ts:760, 976, 984, 1012` — **open**.
- **P2-57 · Status-bar counts update ~1 s late after undo/redo** [E2E] — update in `applySnapshot`/`mutateBuilt` — **open**.

### 6.4 Render and performance

- **P2-58 · A quality-level change forces a full world rebuild** — `renderer.ts:390-392` — **open** (Lot 7).
- **P2-59 · The anisotropy setting never applies (all stay at 8×)** — **open** (Lot 7).
- **P2-60 · Per-agent per-frame allocations (15–25 objects) and a copy/sort of every vehicle, pedestrian and junction per frame** — pedestrian part **replaced 8221067** (the renderer walks the published views, kept in id order); the rest **open**.
- **P2-61 · Bone palettes: one `texSubImage2D` per citizen per frame** — **open** (Lot 7 / H4).
- **P2-62 · Every redraw re-renders the whole 3D scene (shadow + AO + SMAA) even when only the 2D overlay changed** — **open** (Lot 7).
- **P2-63 · A 4× MSAA canvas allocated even at levels using SMAA (~150 MB at 1080p/DPR 1.5)** — **open** (Lot 7).
- **P2-64 · `structures.ts` disposes geometries but not the InstancedMeshes** — **open** (Lot 7).
- **P2-65 · AO sees invisible surfaces (glass, faded/ghost buildings, water; foliage with no wind)** — **open** (Lot 7).
- **P2-66 · Draw-call and triangle statistics wrong (drawCalls = 1)** [measured] — **open** (Lot 7).
- **P2-67 · ~3.8 M texels of procedural textures baked synchronously at boot** — **open** (Lot 7).
- **P2-68 · Triangles per frame: 3.2 M at High and 5.5 M at Ultra on a 39-road map** [measured] — **open** (Lot 7).
- **P2-69 · The Low level still pays for what it does not draw** — **open** (Lot 7).
- **P2-70 · Bundle and `dist`** [measured] — `index-*.js` 1.17 MB (394 KB gzip); ~213 KB of `walk*.json` inlined; `rocketbox*.json` 3.7 MB in base64; 7.7 MB of sourcemaps with source; **30 GLBs never requested by the allow-list (22 MiB) in `dist`** — **open** (Lot 7, H7 removes the Rocketbox GLBs).
- **P2-71 · `devicePixelRatio` and AO resolution** — a monitor or zoom change does not adjust the DPR; AO runs in CSS pixels after the first resize — **open** (Lot 7).

---

## 7. P3 findings (minor, and technical debt) — `open` unless noted

**Architecture**
- `main.ts` at 2992 lines (entry, 10 tool state machines, ~450 lines of overlay, palette DOM, inspector, persistence, debugging); ~12 module-level gesture `let`s were the root cause of P2-34. Proposal: `editor/tools/{road,terrain,pole,move}.ts` with `cancel()`, `ui/overlay/editorOverlay.ts`, `app/session.ts`, `app/debugSurface.ts` (Lot 8).
- Commit/snapshot logic duplicated between `mutateBuilt` and `host.commit`.
- 24 `getElementById(...) as HTML…` casts at boot: one missing id kills startup.
- `workspace.ts` at 1051 lines; `renderTier3` a ~170-line chain.
- Mixed files over 1000 lines: `buildingMesh.ts`, `crossingFsm.ts` (to be deleted with the legacy pedestrian model), `buildingTool.ts`, `elevation.ts`, `agents.ts`, `vehicleModels.ts`, `admission.ts`, `carBody.ts`.
- Five near-identical InstancedMesh builders; three polygon kernels.
- The legacy `.topbar`, `initMoreMenu` and hidden buttons used as "hubs" via `.click()`.
- `buildUtilities` creates 4 materials and 2 geometries per rebuild; `renderer.dispose()` incomplete and never called.

**Dead and inert code**
- `Persistence.save/saveSoon/load/clear`; `commitDraft`/`snapEndpoint` in production; `BuildingWiring.cancelOperation`; `deps.focusBuilding`; `opMove`; `blueprintUse`; `deriveSpaces`; `pedestrianSocial.ts` (test only); unused geometry helpers in `agents.ts`.
- `BuilderState.busy`; the ghost-lanelet mechanism never engages; `rng.signalOffsets` unused; `SignalController.offsetApplied`, `Claim.grantedTick`, `ClaimTable.holder()`, `ConflictIndex.conflict()`.
- Never-read parameters in the legacy pedestrian model (`cohesion*`, `PED.fileSpacing/courtesyYield/accel`, `Ped.color`, `need`) — go with its deletion.
- `ConflictIndex.idByKey`, `lastAdmission` and `mergeTurn` never pruned; 305 dead i18n keys; `as never` casts.

**Small bugs and UX**
- pt-BR decimals with a dot ("12.0 × 9.0 m"), `toFixed(2)` in the inspector; the zoom "%" label varies with window size; the building ghost stays drawn where the pointer left the canvas; a mouse icon in the hint on touch devices; mouse back/forward buttons act as a left click; `arrowPan` does not exclude TEXTAREA/contentEditable; click and curve thresholds use a camera up to 100 ms stale; editor menus open downward off screen; smooth scrolling ignores `prefers-reduced-motion`; unlabelled landmarks; selection state by class only; height ± buttons named by glyph; "About" never shows the Rocketbox (MIT) credits; a legacy collapsed state in `localStorage`; 9.5–11 px type in the dock; no feedback on bulldozing or upgrading a top-class road; `Rng.weighted` can return a zero-weight entry; a hard `w < 1e-4` cut in `elevation.ts:826`; vehicle ids collide with furniture ids after 1e6 vehicles; a seated pedestrian leaves a ghost obstacle and other legacy pedestrian nits (**replaced 7ec1994**); 1200-slot buffers on ~150 rare InstancedMeshes; non-indexed vehicle geometry; `CastingRegistry.beginFrame` O(codes×cast); `pedestrianDetail` does nothing; `window.__roadcraft` (with an unvalidated `loadDoc`) exposed in production.

**Out-of-date documentation**
- AGENTS.md points at a missing `src/ui/buildingCreatorPanel.ts` and says `npm run check` "is fast (seconds)" (7.6 min).
- `docs/buildings.md:225` (`schema: 1`, the code writes 2); element `angle` undocumented.
- `rendering.md` and `performance.md` claims that no longer hold.
- Four fuzz fixtures named `open-*` are no longer open.
- False comments in `pipeline.ts:45-55`, `fsm.ts:33, 161-164`, `world.ts:336-337`.
- The README describes Upgrade/Move/Split/Control buttons that no longer exist, and an "isometric" camera.

---

## 8. Annex — root cause of the 2 red tests (P0-01) — `fixed c22cd48`

**T1 · "walks around streetlight columns": the test measured against a column that does not exist.** It recreated lamp positions from the formula (s = start + k·88; `out = width/2 + sidewalk·0.95`), while since `48569a8` `streetFurniture()` drops items on the approach to crossings. The one test column missing from the world stood on a zebra landing; the 0.564 u minimum came from a pedestrian entering the crossing there, the nearest real furniture being a bin 0.787 m away. **Fix:** measure against `streetFurniture(net).filter(i => i.kind === 'lamp')`.

**T2 · "never leaves a drawn body standing": the `stuck` counter locked into a cycle at the escalation threshold.** `escalated = p.stuck > 1.2 s` had no hysteresis; the first tick of the forward escape moved at `ACCEL·DT` = 0.046 u/s, under the 0.05 u/s standstill threshold (+DT), the next at ~0.09 u/s (−2·DT), de-escalating it; net ≈ 0, so `stuck` sat at ~1.2 and never reached the 3 s release while the walker crept past a hydrant for 9.4 s. **Fix:** count creeping as held for any walker off the kerb and decay only with real progress. (The legacy pedestrian model is no longer the default; the People engine replaced it in `7ec1994`.)

Related defects found then (legacy pedestrian model, **replaced 7ec1994**): the furniture release clause in `PedestrianClearance.blocker` never fired (id sign); `tooCloseToFurniture` ignored the gate's floor. Signal defects (**open**): a pedestrian-only stage never ages; gap-out ignores walkers leaving waiting slots; the `sequential` fallback runs empty exclusive-turn stages (~10.4 s of all-red).

---

## 9. Execution plan

The approved resolution plan (2026-09-30) orders the work in lots: 0 verifiable base → 1 data integrity → 2 session, history and gestures → 3 topology → then the redesigns (C camera, U new UI shell, R roads, B building mode), **A agency** (People engine, Drive v2, Person model), 5 other simulation fixes, 6 simulation performance, 7 render/memory/GPU, 8 architecture, dead code and docs. Every lot ends with its specs green, a fuzz hunt when `world/` or `sim/` changed, and screenshots of every option touched for anything visible (CLAUDE.md).

**Cross-cutting root causes** (fixing the cause removes several symptoms):
1. **Heavy, lossy snapshot/restore** — P0-02, P0-04, P0-06, P1-17, P1-29, P1-36, P2-22 — `fixed`.
2. **Gesture state scattered in module `let`s** — P0-05, P1-02, P1-07, P2-34, P2-35 — mostly `fixed`; P1-07 open.
3. **A global rebuild on every edit** — P1-28, P1-29, P1-31, P1-43, P1-48, P2-12, P2-32, P2-58 — open (Lot 7).
4. **Incomplete boundary validation** — P0-03, P2-30 — `fixed`.
5. **Identity by volatile ids** — P1-13 (`fixed`), P1-17 (`fixed`), P1-42 (open), P2-19 (`replaced`).
6. **Tests that do not exercise the real code** — P1-39, P1-40 `fixed`; P1-41 open; P1-19 `fixed` (Drive v2). Visible motion is now measured on the drawn body (`tests/sim/people/motion.spec.ts`).
7. **Two generations of UI living together** — open (Lot U).
8. **Per-tick and per-frame scans and allocations** — pedestrian side `replaced`; the rest open.
