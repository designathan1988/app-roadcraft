# Directional crowd gait: sources, decisions, and measured limits

Research date: 2026-10-01. Scope: the renderer candidate in `codex/crowd-gait`,
based on `2768860`; baseline gait taken from `a3d5c82`. This research does not
change simulation, scenarios, thresholds, or implementation. Integration and
the final physical battery remain the main session's responsibility.

## Questions and search method

The concrete defects were: movement below 0.14 m/s remaining in idle; a shorter
declared stride without a correspondingly shorter drawn pose; forward footwork
during backward/lateral travel; crossed ankles after naively rotating a stride;
and diagonal blends whose speed was correct but whose direction was wrong.
Standing turns and planted-foot sliding are related verification questions.

Queries were reformulated from product recipes to primary mechanisms:

1. `Unity Coupling Animation and Navigation root motion updatePosition`.
2. `Epic stride warping orientation warping`, then `Blend Spaces` and `Motion Matching`.
3. `Clavet Motion Matching Road to Next Gen Animation GDC`, then the Naughty Dog production presentation.
4. `Holden Phase Functioned Neural Networks`, then `Learned Motion Matching` and its author implementation.
5. `Kovar Gleicher footskate cleanup`, refined to `site:cs.wisc.edu Footskate Cleanup` to reach the authors' paper.
6. `navmesh animation start slide synchronization`, examining the original practitioner report rather than a tutorial's retelling.
7. The Microsoft Rocketbox repository and recursive GitHub tree API, checking the actual capture stems used by our extractor.

The sources below represent eight origin groups: Unity, Epic, Microsoft,
Wisconsin's graphics researchers, Holden and collaborators, Ubisoft's Clavet
presentation, Naughty Dog, and an independent practitioner. Multiple pages from
one vendor and Holden's related papers/code are **not** counted as independent
replications. Each mechanism comparison draws on at least five origin groups,
including counterexamples and alternatives; this does not imply that five
sources independently derive our exact blending formula.

## Primary sources read

### S1 — Unity: navigation/animation ownership and directional inputs

[Coupling Animation and Navigation, official versioned manual](https://docs.unity.cn/530/Documentation/Manual/nav-CouplingAnimationAndNavigation.html)
uses local velocity components to drive directional animation and obtains the
transform position from the navigation agent. Its example's movement cutoff is
0.5 m/s, so copying its constants would preserve our slow-slide defect.
[Using NavMesh Agent with Other Components](https://docs.unity.cn/Packages/com.unity.ai.navigation%401.1/manual/MixingComponents.html)
explicitly distinguishes agent-driven from animation-driven motion and warns
against two components moving the same transform.

**Agreement:** one-way information flow and local directional inputs.
**Difference:** our crowd solver owns movement; we neither copy the example
cutoff nor switch to animation-driven displacement. These are Unity APIs,
not APIs available in our Detour/three.js code.

### S2 — Epic: pose adjustment, blend spaces, and motion matching

[Pose Warping](https://dev.epicgames.com/documentation/en-us/unreal-engine/pose-warping-in-unreal-engine)
separates orientation, stride, and slope correction. Its stride operation changes
foot placement; its orientation operation can redirect the lower body while
retaining facing. Reach limits and IK are explicit concerns.
[Blend Spaces](https://dev.epicgames.com/documentation/en-us/unreal-engine/blend-spaces-in-unreal-engine)
describes pose samples over input axes, including speed and direction.
[Motion Matching](https://dev.epicgames.com/documentation/en-us/unreal-engine/motion-matching-in-unreal-engine)
combines trajectory and pose features, including feet; more features increase
cost.

**Agreement:** change the actual pose, distinguish facing from travel, and measure
feet. **Difference:** we bake a small set of IK-adjusted cycles and blend existing
palettes. We have not ported Unreal's runtime warping nodes or Pose Search.
The inverse-stride calculation below is our derivation, not a quoted Epic recipe.

### S3 — Microsoft Rocketbox: actual input data and capture compatibility

[Official repository](https://github.com/microsoft/Microsoft-Rocketbox) documents
the compatible animation release and MIT licensing.
The [recursive tree API](https://api.github.com/repos/microsoft/Microsoft-Rocketbox/git/trees/master?recursive=1)
returned revision `0943055db6ec570bcef9f2c8b41c9e5467c808f9` during this review.
It contains male/female `walk_neutral`, `walk_slow_01`, `turn_left_90`, and
`turn_right_90` FBX captures in the expected motion-extraction directories.

**Agreement:** retain compatible captures and their timing instead of replacing
them with unrelated retargeted motion. Our extractor and local library were
also inspected. Our loaded subset has forward/slow walking and turn clips;
the new side/back cycles are derived poses, not newly acquired side/back mocap.
This review does not claim exhaustive biomechanical coverage of all upstream
animations merely from file names.

### S4 — Kovar, Schreiner, Gleicher: actual footplants and IK limits

[Footskate Cleanup for Motion Capture Editing, authors' paper](https://graphics.cs.wisc.edu/Papers/2002/KSG02/cleanup.pdf),
sections 2 and 4, formulates heel/ball contact constraints and smooth changes
between constrained and unconstrained frames. The full method can modify the
root and allow small changes in leg length. The authors also warn that incorrect
contact labels can create new artifacts. An
[author-group implementation description](https://research.cs.wisc.edu/graphics/Gallery/FootskateSolver/footskate.html)
is available.

**Agreement:** foot positions and continuity are stronger evidence than clip
selection. **Difference:** our bake-time IK preserves local leg lengths and does
not enforce persistent world-space foot contacts. We therefore do not claim
the paper's exact footplant guarantees. Its root-placement stage must not be
copied into Detour body integration.

### S5 — Holden, Komura, Saito: phase as part of locomotion

[Phase-Functioned Neural Networks for Character Control, primary paper](https://theorangeduck.com/media/uploads/other_stuff/phasefunction.pdf)
and the [author's project description](https://theorangeduck.com/page/phase-functioned-neural-networks-character-control)
describe pose generation conditioned on motion phase, controls, previous state,
and environment. Phase is a substantive motion variable, rather than an
arbitrary independent timer for each blended animation.

**Agreement:** coordinated cyclic timing matters. **Difference:** our shared
phase and measured strides are a small deterministic controller, not a PFNN.
No network was trained, and no claims about the paper's terrain adaptation,
runtime performance, or broad motion coverage transfer to our candidate.

### S6 — Holden and collaborators: learned matching and inspectable code

[Learned Motion Matching, author overview](https://theorangeduck.com/page/learned-motion-matching)
and its [paper](https://theorangeduck.com/media/uploads/other_stuff/Learned_Motion_Matching.pdf)
replace stages of motion matching with learned alternatives to reduce its data
and memory dependence. The [author implementation](https://github.com/orangeduck/Motion-Matching)
documents its training inputs and differences from the paper.
The actual [controller source](https://raw.githubusercontent.com/orangeduck/Motion-Matching/main/controller.cpp)
was inspected at `contact_update`, contact IK, synchronization, adjustment, and
clamping. These are distinct mechanisms, not interchangeable fixes.

The author's [Code vs Data Driven Displacement](https://theorangeduck.com/page/code-vs-data-driven-displacement)
explains that exact synchronization can still slide, and demonstrates both
root adjustment and foot-contact correction. **Our choice:** adapt pose to the
solver's displacement. We do not import its simulation-position synchronization
or root clamping, and we have not implemented its contact-locking system.
S5 and S6 are related research, not independent votes for our algorithm.

### S7 — Ubisoft: motion matching as a broader alternative

[Simon Clavet, Motion Matching and The Road to Next-Gen Animation, GDC 2016](https://www.gdcvault.com/play/1022985)
describes selecting recorded frames against both current pose and a desired
future plan, including transitions such as starts, stops, and turns.

**Agreement:** the requested path and current pose both matter; a scalar speed
alone does not specify suitable locomotion. **Difference:** a database-driven
replacement requires motion coverage and a new runtime/data pipeline. It is an
alternative to assess if our bounded correction remains inadequate, not what
has been delivered. The official session overview was read; the full talk was
not watched, so this document makes no claims about uninspected slides or timings.

### S8 — Practitioner report: movement can outrun an animation transition

[Qwertyyy's original synchronization report and replies](https://discussions.unity.com/t/how-to-synchronize-navmesh-agent-movement-and-walk-animation/146723)
reports an NPC already moving while the walking transition is still pending.
Waiting for animation introduced an unwanted delay. Replies discuss interruptible
transitions, layers, and animation-driven movement.

**Agreement:** selecting an idle-to-walk transition is not evidence that visible
footwork is already occurring. **Difference:** we do not delay Detour until
animation catches up, and desired velocity is not a substitute for actual
displacement. This is a firsthand failure report, not a controlled benchmark
or general proof that any reply is correct for Roadcraft.

### S9 — Naughty Dog: production migration is a separate undertaking

[Naughty Dog's official GDC 2021 presentation listing](https://www.naughtydog.com/blog/naughty_dog_at_gdc_2021)
identifies Michal Mach and Maksym Zhuravlov's production account of adopting
motion matching for The Last of Us Part II, including implementation difficulties.

**Relevance:** a high-quality production result does not make a new animation
architecture a drop-in fix for this crowd engine. Only the official overview
was read. The very large presentation download was not fetched, and its internal
technical claims are not used as evidence here.

## Comparison mapped to our mechanisms

| Question | Independent sources compared | Consequence for this candidate |
|---|---|---|
| Why does movement below 0.14 m/s stay visually idle? | S1, S2, S3, S4, S5, S8 | The local gate, not missing navigation progress, suppresses stepping. Retain idle for actual rest; represent small actual displacement with short poses and phase advance. Do not import a tutorial's cutoff. |
| Does a smaller stride number shorten the feet? | S1, S2, S3, S4, S5, S7 | No: metadata alone cannot change a pose. Blend the shuffle toward its mean walking stance and verify real ankle/mesh movement. This is our implementation choice, not a footplant guarantee. |
| Can forward footage represent side/back travel? | S1, S2, S3, S4, S5, S7 | Direction needs pose coverage. Derive bounded side/back cycles with bake-time IK, retain facing, preserve local limb lengths, and check surfaces. Naive rotation crossed ankles and was rejected. |
| Who owns position? | S1, S2, S4, S5/S6, S8 | Available techniques choose different ownership models. Roadcraft's fixed requirement wins: Detour owns world displacement; gait reads it. Root adjustment from another architecture is not automatically compatible. |
| Why do equal diagonal weights fail? | S1, S2, S3, S4, S5, S7 | Blend inputs and real clip travel must agree. Sources motivate directional/pose constraints; the inverse-distance formula below is our independently tested derivation. |
| How should a stationary turn differ from translation? | S1, S2, S3, S4, S5, S7, S8 | Preserve the captured turn phase and smooth visual facing; don't let an unfinished forward stop suppress turn steps. Do not make navigation wait for turning. |
| Does this eliminate all foot sliding? | S1, S2, S3, S4, S5/S6, S7, S8 | No. Data fit, contact constraints, transitions, and geometry remain relevant. Measure signed travel, actual feet, and real scenes separately; never equate an advancing clip with perfect planted contacts. |

## The diagonal correction: our derivation

Let the desired local unit direction be `d=(dF,dL)`. Choose the cardinal clips
with the corresponding signs. Let `SF` and `SL` be their **effective** cycle
distances after body scale, short-step amplitude, and any forward walk/run blend.
With angular weights alone, equal weights produce `(SF/2, SL/2)`, which is not
a 45-degree vector unless the distances match.

Use unnormalised weights `uF=abs(dF)/SF`, `uL=abs(dL)/SL`, then divide both by
`uF+uL`. The resulting signed cycle vector is parallel to `d`. Advance the shared
phase by actual selected pace divided by that vector's length. Running belongs
inside the forward group; adding it afterward would rotate the vector again.
The neutral-pose fraction contributes zero travel but retains its pose weight.

This is implemented in `citizenGait.ts` and checked by signed component tests,
not only a vector-length comparison. Five new regressions failed before the
correction; one measured 0.79572 m forward against 0.595 m required. All four
diagonal quadrants, unequal lateral strides, a run blend, and diagonal braking
now pass. Forward-only start/stop captures are not selected off-axis; the epsilon
only handles numerical zero. Existing crossfades remain finite transitions.

## Chosen approach and rejected alternatives

The candidate keeps `PedView` read-only, uses existing captures, bakes directional
IK once per body, and selects poses/phase at render time. `citizenStride.ts`
derives lateral support from hips and actual soles; the emitted stride metadata
includes the resulting shortening. This avoids adding a second world-space
movement controller or per-frame skeleton solving.

Rejected in this attempt: lowering an idle cutoff without changing pose
amplitude; changing only declared stride; rotating the whole figure to hide
lateral movement; naive lateral warping that crossed ankles; angular weights
that matched scalar speed but not direction; and waiting for visual turns before
moving the body. Motion matching/PFNN/LMM remain alternatives, not rejected as
research methods. They need compatible motion coverage, implementation, and
validation that this attempt does not supply. Persistent contact IK could be
investigated if remaining footplant error warrants it; it must stay in pose
space and must not relocate Detour bodies.

## Local evidence and what it does not prove

The focused regression suite passes 16 tests, including actual rig movement,
local limb-length preservation, side-foot surface separation, short steps,
stationary idle/turns, signed diagonal distance, run mixing, and diagonal braking.
TypeScript and touched-file lint were clean after the implementation correction.

A bounded headless comparison ran all 19 unchanged fixture durations and the
real player city for 60 seconds with traffic. Each old/new pair consumed the
same frozen `PedView`, including read-only nested data. There were 2,146,310
shared samples; execution took 73.83 seconds. A hash identifies each physical
trajectory. No reported metric worsened in any of the 20 cases.

Times below are **person-seconds**, accumulated across people. A dominant static
pose means weight above 0.9 and includes the new `walkRest`; renaming idle cannot
make that measure disappear. The slow band is fixed at 0.03–0.14 m/s.

| Metric | 19 scenarios: old → candidate | City: old → candidate |
|---|---:|---:|
| Slow-band dominant static pose | 155.667 → 9.733 s | 73.933 → 5.117 s |
| Stable translational cycle glide | 111.183 → 11.700 s | 63.867 → 5.467 s |
| Mean stable signed travel error | 0.020746 → 0.003368 m/s | 0.006715 → 0.002349 m/s |
| Mean travel error over all moving samples | 0.077601 → 0.046772 m/s | 0.045866 → 0.037159 m/s |

The comparison uses real sex-specific Rocketbox clip facts and the existing
gait auditor's approximate stature factors (adult/elder 1, child 0.7), not every
runtime model's foot-width calibration. It updates once per `DT` at `alpha=1`.
It measures controller travel metadata, not exact world-space sole locking.
Real-rig and visual checks supply separate geometry evidence. Three city samples
above 4 m/s were excluded equally from both gait metrics; 28 displacements above
3 m/s and 1,176 backward ticks remain in the inherited physical input. Those
physical defects were not repaired by animation.

The old 120-second legacy gait/vehicle auditor was interrupted after three
minutes without a result; it is **not** reported as passing. This bounded Detour
comparison does not silently replace the existing battery's assertions.

Four real fixed-camera sequences were inspected: crowd contact, group startup,
head-on passage, and side-by-side passage. The crowd subject moved at up to
0.04166 m/s in that particular interval; it is not labelled a 0.07 m/s proof.
The group startup segment did not reproduce backward travel. Separately labelled
synthetic renderer previews cover 0.07 m/s, backward, sideways, and two diagonals.
They demonstrate animation, not navigation validity. A synthetic trajectory can
leave the pavement. The side and corrected diagonal previews measured positive
projected sole gaps (4.035 mm; 2.397 mm and 22.450 mm respectively).

Scratch evidence is retained in the worktree: `zz-gait-comparison.jsonl`,
`zz-gait-summary.json`, `tests/render/zzCrowdGaitCompare.spec.ts`, and the
`docs/audit/2026-10-01/gait-preview*` JPEG/JSON sequences. These are distinct from
a claim that every pedestrian defect is resolved or that a new default engine
has been enabled.

## Retrieval limits

The unversioned Unity coupling URL returned 404, so the official versioned manual
was used. Full retrieval of some author/GDC PDFs failed; the Learned Motion
Matching overview, indexed primary introduction, and author code were read
instead. No inaccessible video or slide deck is presented as watched. The
Wisconsin paper's actual constraint/IK sections and the author controller's
contact and synchronization implementations were directly inspected.
