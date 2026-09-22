# Elevation — how every road surface gets its height

**File:** `src/world/elevation.ts` · **Tests:** `tests/world/elevation.spec.ts`

This is the keystone of the renderer. If something on screen has a crack, a
step, a hole or an overlapping plate, start here.

## The constraint that dictates the design

A road is not drawn as one strip per segment. The whole network is clipped into
four band polygons (`world/surfaces.ts`) and each band becomes a single mesh. A
mesh vertex therefore knows only its own `(x, y)` — it has no idea which segment
it came from, or whether it is in the middle of a junction.

So the elevation has to be **a function of position**, and that function has to
be **continuous**. Every defect the old renderer had was a violation of one of
those two words:

| What was done | What it produced |
|---|---|
| pick the *nearest* segment's profile | a step wherever the nearest segment changes — which is the middle of every junction |
| `max(profile, terrain + clearance)` per vertex | the junction copied the terrain while the ribbon stayed flat: a dented bowl |
| a raised deck at the *nearest span's* height | two spans of one chain disagreeing over the junction between them |
| stop at the last road found, fall back to the ground | an 8.8-unit cliff a few tens of units off the kerb |

## What is built

`buildRoadElevation(net, terrainAt)` solves the whole network at once and
returns four queries:

```ts
at(x, y, structures?)      // deck height at a point, optionally one level only
onSegment(segment, x, y)   // the deck a specific agent is riding
nodeHeight(node)           // the one height a node has
frameAt(x, y, structures?) // road-local coordinates, for texture flow
```

`terrainAt` must be the height the terrain is **drawn** at
(`TerrainSurface.renderedHeightAt`), not the analytic field. The difference
between the two is larger than the clearance a road carries, so reading the
field puts the road under the triangles the player can see.

## The solve, step by step

### 1. Stations

Every segment gets a longitudinal profile sampled every `STATION` (4) units, up
to `MAX_STATIONS`. At each station the ground is read at **seven points across
the casing**, and the highest is taken. Reading only the centreline misses the
ridge beside the road; taking the maximum is what keeps the *whole*
cross-section above ground, and it is also what makes a road level across its
width instead of twisted.

### 2. Dilation

Each station is then raised to the highest value within `DILATE` (2) stations of
it. This is what makes the clearance a guarantee rather than a hope: the mesh
draws straight chords between vertices, and a chord is never lower than its
lower end, so clearing a window at both ends clears everything between them.

**This is why the mesh can use large triangles.** The tessellation limit in
`render/roadSurfaces.ts` is not sized against the terrain's curvature; it is
covered by this window.

### 3. Junction plates

The arc length over which each end of a profile is held **flat** comes from
`Network.trims` — the distance the junction builder already cut the segment back
by — plus a small margin. Inside that reach the profile is exactly the node
height.

That is the whole trick for watertight junctions: the junction polygon lies
inside the plate reach of every leg, and every leg is flat at the same node
height over that reach, so whichever leg a query lands on, the answer is the
same number.

### 4. Node heights, solved globally

```
gradeHeight[node] = max( terrain over the junction disc,
                         every leg's ceiling over its plate ) + clearance
```

A node is **aloft** when every road meeting it is raised — the chain runs over
the junction. A node with even one road at grade is a **landing**: everything
meeting there comes down to the grade height. That single rule is what makes a
ramp join a street instead of hanging above it.

### 5. Profiles

**At grade** — a **designed** line, not a draped one.

The profile used to BE the dilated terrain ceiling, which meant the road copied
every hummock the brush left behind: a ribbon rippling along a field, and what a
player meant by a road that is not level. What a road at grade is, in any game
that builds roads, is a smooth alignment through the ground with the ground cut
away above it and filled in under it. Three steps produce it:

1. **A balanced ground line.** The mean of the lateral samples across the
   casing, not their maximum. The maximum is right for a deck that has to fly
   over the ground and wrong for a road built into it: on any side slope it
   perches the carriageway on the high kerb and leaves the low one hanging,
   which reads as a road tilted for no reason. The mean is the level at which
   the cut on one side pays for the fill on the other.
2. **A moving average over `SMOOTH_REACH`** (90 units, about 36 m). Everything
   shorter than the window is earth to be moved; everything longer is landscape
   to be followed.
3. **A two-sided gradient limit.** `slopeLimit`, not `gradeEnvelope`: a designed
   line is allowed to descend, and an envelope that only ever raises would
   quietly fill in every cut it was asked to make.

The junction is then tied in as a fading OFFSET rather than by snapping the
profile to the node — which keeps the crest and the dip the smoothing kept — and
the transition is sized from the correction it carries, so the tie can never add
more than half the gradient budget on top of the line's own slope. Both
anchors read the line at the **plate edge**, because that is where the flat
platform and the sloping road actually meet.

**Raised** — a constant deck with a vertical curve at each end:

```
 deck ─────────────────────────
     ╱                         ╲          ease = t²(3−2t)
 ───╱                           ╲───      ramp = rise / (RAMP_GRADE / CURVE_PEAK)
 plate                        plate
```

`CURVE_PEAK` is 1.5 because a smoothstep's slope peaks at 1.5× its mean: a ramp
sized as `rise / grade` actually climbs at `1.5 × grade`. Sizing it from the peak
is what makes the stated 8% the real 8%.

Where the span cannot hold two ramps at that gradient, the **deck is lowered**
until they fit. Steepening the ramp instead produced a 36% wall of asphalt that
read as a broken connection. This is also what a road designer does.

**Sunken** — `solveSunken`, the exact mirror of the above, for tunnels. Two
differences matter and both are inherent:

* the ground envelope is **not** applied: `ceil` is the floor a road at grade
  must stay above, and a tunnel is defined by going under it;
* the gradient envelope runs the other way. `gradeEnvelope` only ever raises,
  which is right for keeping a road clear of the ground and wrong here — a step
  that is too steep on a descent has to be fixed by *lowering* the higher
  sample, or the fix undoes the tunnel. `descentEnvelope` is that mirror.

The depth is measured against the **lowest** ground on the span, not the
highest. Against the highest, a bore under a hill would be driven far deeper than
it needs to be and its ramps would never fit; against the lowest, the floor is
level with what a cutting at each end can reach and the hill in the middle simply
provides more cover than the minimum.

Written as two functions rather than one with a sign, deliberately: the two
shapes are the same shape with the clearance flipped, and folding them together
made both harder to read than either is alone.

### 6. Convergence

Three passes. A profile pushed up by its grade envelope raises the node it ends
at, which raises every other road meeting there. Every step only ever raises, so
the sequence is monotone and settles.

## The query

```
candidates = spatial grid lookup at (x, y)
dmin       = distance to the nearest candidate
w_i        = exp(−(d_i − dmin) / BLEND_TAU)
authority  = 1 − smoothstep(PROFILE_REACH, PROFILE_FADE, dmin)
h          = authority · (Σ w_i h_i / Σ w_i) + (1 − authority) · ground
```

* Far from a junction the nearest road dominates and the answer is its profile.
* Inside a junction every leg is flat at the node height, so any blend of them
  is that same height.
* `PROFILE_REACH` (60) is past the widest casing (31.5) and past any junction
  ring, so **every vertex of every road surface is decided by the road**, never
  by the ground beside it. There is a test that asserts exactly this.
* Beyond `PROFILE_REACH` the answer eases to the terrain, reaching it at
  `PROFILE_FADE` (110). Without that easing the field had a cliff at the edge of
  the last road it could find.

The result is continuous everywhere, which is the property the mesh needs.

## Constants

| name | value | why |
|---|---|---|
| `STATION` | 4 | profile sampling along a segment |
| `MAX_STATIONS` | 400 | so a 4 km road does not allocate 1000 |
| `PLATE_MARGIN` | 3 | extra reach past the junction trim |
| `LATERAL` | 7 samples | across the casing, at each station |
| `DILATE` | 2 stations | chord protection, ±8 units |
| `GROUND_GRADE` | 0.12 | steepest road at grade |
| `SMOOTH_REACH` | 90 | how far the grade line is averaged |
| `TIE_REACH` | 70 | shortest tie-in to a junction |
| `PLATE_BLEND` | 40 | past a plate, where the ground stops being a ramp's floor |
| `RAMP_RELAX` | 0.8 | the share of a ramp over which the same is true |
| `BATTER` | 2.5 | run per unit of rise on a cut or fill |
| `RAMP_GRADE` | 0.08 | steepest ramp on a structure |
| `CURVE_PEAK` | 1.5 | smoothstep peak-to-mean slope |
| `BLEND_TAU` | 2.5 | softness of the blend between neighbours |
| `PROFILE_REACH` | 60 | inside this, the road decides, alone |
| `PROFILE_FADE` | 110 | outside this, the ground decides, alone |
| `SHAPE_INNER` | 3 | where the batter starts, past the casing |
| `SHAPE_SHOULDER` | 45 | width of an embankment or cutting beside a road at grade |
| `CUT_SHOULDER` | 16 | the same for a tunnel, narrow enough for a portal to close |
| `SHAPE_DROP` | 1.5 | how far below the road surface the shaped ground sits |

## Shaping the ground

`shapeAt(x, y, naturalGround)` is the other half of the field, and the only
caller is `render/terrain.ts`. It answers, for one point of ground, the height
the terrain should be pulled to and how much authority the road has over it.

**Every** structure may shape the ground, and which one does is decided by
authority rather than by distance. "Only roads at grade" was nearly right and
wrong in the one case that matters: a ramp coming off a viaduct *is* a road at
grade by the time it reaches the street, and leaving the ground untouched under
it meant the ramp had a hill in its way — so the solver lifted the junction to
clear the hill, and the street meeting it was left with eight units to climb in
one terrain cell. What decides it is how far the structure stands **above** the
ground: on it, cut and fill; well clear of it, piers and nothing. `solveRaised`
relaxes its own ground floor over the same span, for the same reason: the
junction a ramp lands on is a platform cut into whatever it sits on.

The batter is sized from the earthwork it carries (`BATTER`, a 1:2.5 slope), so
a shallow fill blends out quickly and a deep cut opens out properly instead of
becoming a cliff at a fixed width.

It is what removed the walls beside a road. A road has to sit at one height
across its full width, so where the ground falls away there is a difference to
absorb; absorbing it in the road's own skirt draws a vertical face, and absorbing
it nowhere leaves the road hanging. Absorbing it in the **terrain** is what a
road actually does to a landscape, and it is the only version that looks built.

`SHAPE_DROP` is the number to be careful with. It was the road's ground
clearance — three tenths of a unit — and that is not enough, for three reasons
that compound: the shaper answers for the nearest profile alone while the road
mesh reads the blended field; the terrain is a 16-unit grid whose triangles
interpolate between shaped corners; and the lowest road band is itself only a
tenth of a unit below the deck. Together they left the drawn ground up to seven
tenths of a unit **above** the drawn verge. `npm run verify:visual` counts road
vertices under the terrain and found twenty-one on a flat crossroads. A unit and
a half absorbs all three, and costs nothing visually, because the verge's skirt
is sized from the terrain and simply grows to meet it.

The same function produces tunnels, with no code of its own: it fades its own
weight out as a road goes deeper, so the approach is an open cutting, the ground
closes over the arch, and the bore runs through intact hill. See
[road-system.md](road-system.md) for the constants that place the portal.

## Changing it safely

* Anything you add must stay **continuous**. The test halves the sampling step
  and requires the worst jump to halve with it; a cliff keeps the same jump.
* Anything you add must keep **every band reading the same number**. The bands
  are offsets from `at()`; give one of them its own source and it will step away
  from its neighbours.
* If you enlarge the mesh tessellation limit, enlarge `DILATE` to match. The two
  are a pair: the dilation window must cover the chord length.
* If you change `SHAPE_DROP`, or anything that changes how far the shaped ground
  sits below the road, run `npm run verify:visual`. It is the only thing that
  measures the drawn surfaces against the drawn ground, and the failure it
  catches — a rim of terrain a few tenths of a unit above the verge — is
  invisible in a screenshot and impossible to reason about from the source.
