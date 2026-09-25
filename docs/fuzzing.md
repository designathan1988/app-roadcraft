# The road fuzzer

`tests/fuzz/` builds road networks with the editor's own commands, checks the
world after every gesture, drives traffic on the result, and turns every
failure into the smallest sequence that still fails.

## What it does

- **Gestures** (`support/ops.ts`): draw (with `findAnchor`/`snapEndpoint`, the
  way `main.ts` resolves a drag), split, join, move node, set class, upgrade,
  lanes 1-8, one-way, structure (ground / elevated / bridge / tunnel), curve,
  bulldoze, remove node, junction control. Draws are biased towards the hard
  cases: out of existing nodes (degree 3-6), across roads at 20-90 degrees,
  contacts just past `MIN_LINK_LENGTH`, near-parallel roads a few units apart.
  Entities are picked by a fraction into the sorted id list, so a sequence
  still means something after the shrinker removes a step.
- **World checks after every gesture** (`support/invariants.ts`): finite
  geometry; no seam in the carriageway along a road or across a junction
  mouth; the deck height continuous along each road and agreed at each node;
  mouth, zebra, stop line and lane end in order; every lane has an exit; the
  largest body stays on asphalt or kerb through every turn; the footway graph
  connected at every junction; `commitDraft` hands back a current network.
- **Traffic checks** (`support/simCheck.ts`): every `sim/invariants.ts` audit
  code at the full level, body overlap (`tests/sim/support/bodies.ts`), pose
  jumps, NaN, vehicles stood still past `10 x WAIT_CEILING`. Bodies on
  different structural levels are not a collision; bodies on roads sharing no
  node are reported apart (`unrelatedBodyOverlap`).
- **Shrinking** (`support/runner.ts`): cut after the failing step, then ddmin
  over the rest, holding the defect category fixed.

## How to run it

```bash
npx vitest run tests/fuzz                                   # smoke gate + regressions (in npm run check)
FUZZ_PROFILE=deep npx vitest run tests/fuzz/fuzz.spec.ts --testTimeout=0
FUZZ_HUNT=1 FUZZ_SEEDS=80 FUZZ_OPS=40 FUZZ_SIM=0 FUZZ_REPORT=hunt.txt npx vitest run tests/fuzz/fuzz.spec.ts --testTimeout=0
FUZZ_HUNT=1 FUZZ_RECORD=1 npx vitest run tests/fuzz/fuzz.spec.ts --testTimeout=0   # also writes one shrunk fixture per category
```

`FUZZ_SEEDS`, `FUZZ_OPS`, `FUZZ_FIRST` and `FUZZ_SIM=0` tune any profile;
`FUZZ_TURN_TOLERANCE` sets how far (world units) a body corner may leave the
kerb. Hunt mode never stops at the first defect: it tallies every one by
category. On Windows, set variables with `$env:NAME='1'` in PowerShell.

## Fixtures

Every shrunk failure lives in `tests/fuzz/fixtures/<name>.json` and
`regressions.spec.ts` replays it for ever. A fixture with `open` is a known
defect that is not fixed: it runs as `it.fails`, so the day it is fixed the
suite says so and the flag must go. An open fixture makes the smoke gate
tolerate its whole category, unless it also sets `gate: true` - then any NEW
instance of that category still fails the gate.

When you fix a defect: record its fixture BEFORE the fix (stash the fix, run
the recorder, unstash), check it fails without the fix and passes with it, and
commit the two together.
