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
