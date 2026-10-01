# Crowd initial orientation: evidence and acceptance boundary

Research date: 2026-10-01. Engine: `?people=crowd`. This research was completed
after the candidate was authored, but before accepting or committing it. It is
not a claim that research preceded that implementation.

## Observed problem

`zz-codex-city-route-frame.txt` reports 215 solo `walk <0.8 INTENT` backward
ticks. The dedicated `zzSoloIntent.spec.ts` classification, recorded in
`zz-codex-solo-intent.jsonl`, finds all 215 before age one second and all moving
along their desired velocity. None move against it. This distinguishes an
arbitrary initial facing from a route that actually sends a person backwards.

`spawn` consumes a random initial heading before a route and velocity exist.
The old readback gradually turns that invented heading towards navigation.
The candidate initializes an **unpublished** body's heading and previous
heading from its first nonzero Detour velocity. Published idle bodies and
alighting people retain normal turning. Positions, previous positions,
velocities, targets, thresholds and random draws are not changed.

## Search and source review

Queries were reformulated across “steering velocity alignment local space”,
“navigation animation ownership updateRotation”, “fixed timestep previousState
currentState interpolation”, “spawn first physics frame interpolation”, and
“Recast CrowdAgent position desiredVelocity velocity”. Sources below were
opened and the relevant body text/code read, not accepted from snippets alone.
The unversioned Unity mixing-components pages failed to open; the accessible
official Unity 5.3 manual is used and identified as historical documentation.

There are **six independent authoritative origins**: Recast, Reynolds, Unity,
Epic, Glenn Fiedler and Godot. Recast C++, its JS wrapper and maintainer discussion
are conservatively counted as one source family, not three independent votes.
The practitioner forum is additional corroboration rather than another engine
authority.

| Origin and source type | What was read | Relevance and limit |
|---|---|---|
| Recast/Detour, implementation and API | [`dtCrowd.cpp`, integration and collision resolution](https://github.com/recastnavigation/recastnavigation/blob/main/DetourCrowd/Source/DetourCrowd.cpp#L1243-L1325); [`dtCrowdAgent` fields](https://recastnav.com/structdtCrowdAgent.html); [JS `CrowdAgent` API](https://docs.recast-navigation-js.isaacmason.com/classes/index.CrowdAgent.html) | Desired velocity, avoidance-adjusted velocity, acceleration-limited velocity and position are distinct. Collision resolution changes position after integration. Therefore native `velocity()` need not equal final displacement divided by DT. Read the solver; never manufacture movement to match a pose. |
| Craig Reynolds, GDC 1999 paper | [Steering Behaviors for Autonomous Characters, simple vehicle/local-space section](https://www.red3d.com/cwr/steer/gdc99/) | The example attaches a velocity-aligned local frame to the moving model and retains its old orientation at zero velocity. It also identifies limitations of instantaneous alignment. This supports deriving a new pose from motion, not continually snapping an already visible person or importing its vehicle constraints. |
| Unity Technologies, official integration example | [Coupling Animation and Navigation, Unity 5.3](https://docs.unity3d.com/530/Documentation/Manual/nav-CouplingAnimationAndNavigation.html) | The agent-driven example maps simulated displacement into local animation velocities and places the character at the agent position. A later root-motion alternative deliberately trades avoidance for animation. Roadcraft adopts only the one-way, agent-driven interpretation; its root-motion position corrections are prohibited here. |
| Epic Games, official API | [ComputeOrientToMovementRotation](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Engine/UCharacterMovementComponent/ComputeOrientToMovementRotation) | Rotation is a target computed from movement state; Epic's default uses acceleration. This demonstrates that facing policy is separate from raw position integration. It does **not** establish that acceleration is the correct initial-facing signal for Roadcraft. Our trace supports actual motion instead. |
| Glenn Fiedler, practitioner technical article | [Fix Your Timestep!, final interpolation section](https://gafferongames.com/post/fix_your_timestep/) | Rendering blends previous and current simulation states, including orientation. Initializing only current heading would still interpolate from an arbitrary previous heading. The article does not itself prescribe a first-person-pose rule; equal initial orientation endpoints are our inference from the interpolation equation. |
| Godot Engine, official interpolation documentation | [Using physics interpolation, initial placement and moving starts](https://docs.godotengine.org/en/stable/tutorials/physics/interpolation/using_physics_interpolation.html#call-reset-physics-interpolation-when-teleporting-objects) | Initial placement synchronizes previous/current transforms; a moving start then preserves its real first motion. This directly supports distinguishing initialization from ordinary updates. Roadcraft must apply that principle to orientation only: resetting previous X/Y would erase real displacement and corrupt its detectors. |
| Practitioner report, supplementary | [Instantiated object's first physics frame has wrong position, Godot Forum](https://forum.godotengine.org/t/instantiated-objects-first-physics-frame-has-wrong-position/73953) | The author reports an incorrect first synchronized state and fixes setup ordering before scene insertion. This is first-hand evidence of initialization-order symptoms, not evidence of a Roadcraft or Detour synchronization bug. Its engine-specific workaround is not copied. |

The [Recast JS maintainer's crowd discussion](https://github.com/isaac-mason/recast-navigation-js/discussions/433)
also distinguishes the three velocity signals and warns that a velocity request
replaces the move request. This supports read-only diagnostics, not changing
targets or requesting a velocity to make this visual defect disappear.

## Agreement, divergence and local conclusion

The sources agree on separating motion ownership, pose and interpolation state.
They do not agree on a universal facing signal: Reynolds uses velocity, Epic
defaults to acceleration, and Unity offers both navigation-driven and
animation-driven alternatives. None guarantees that initializing Roadcraft's
pose will leave its simulation unchanged. That claim requires local tests.

The trace justifies a narrow initialization fix: a person already travels in
the correct direction before its first visible state. It does not justify
turning every backward-moving person around, deleting backward-motion events,
or copying current positions into previous positions. A person first published
while stationary must not receive a later instantaneous turn on starting.

The candidate currently reads native `velocity()`. Detour's collision code
requires a guard: inspect actual first-tick displacement too, particularly
near walls or another body. The 215-event trace supports the selected birth
case, not an assumption that velocity and displacement always agree.

## Adversarial acceptance checks

1. For a moving first publication, heading and previous heading agree with
   actual initial travel, turnV is zero, and previous X/Y retain the real
   starting position. Inspect intermediate render alpha as well as alpha=1.
2. A body published while idle, a rebound visible body and an alighting person
   do not later take the initialization shortcut. Zero velocity never requires
   normalizing a zero vector.
3. Preserve every RNG consumption. Removing the unused random-heading draw
   would change traits, destinations and the city population sequence.
4. Compare navigation and crossing state before/after, not just headings:
   positions, native velocities, goals, targets, grants, replans and crossing
   occupants. Include traffic: `publish().occupants.forward` still reads visual
   heading and affects vehicle admission; `clearSpot` also uses heading as a
   tie-break. These are pre-existing feedback paths, not fixed by initialization.
5. Run all 19 unchanged scenarios and the same 60-second city probe, then view
   fixed-camera births and starts. An improvement in the backward counter is
   insufficient if another metric or navigation trajectory regresses.
6. Keep photo setup equivalent to tests. An unconditional pre-step `publish`
   in a photo harness consumes this initialization opportunity; either make
   that an explicit zero-time case or align both harnesses' publication order.

Research verdict: the initialization concept is justified for the traced
unpublished moving body, with the boundaries above. This document supplies no
new passing result and does not waive the city, scenario, photo or independent
review gates. The dense-contact velocity/displacement discrepancy is a separate
problem, not a reason to broaden this pose change.
