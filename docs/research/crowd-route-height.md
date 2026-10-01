# Preserve the surface identity of navigation points

Research began before implementation on 2026-10-01; additional API sources were
checked during verification. The defect occurs on the real layered player city,
not in the flat 19-scenario battery.

## Trace and cause

At 59.9833 seconds, walker 212 stands at native height 37.924999 world units.
Its accepted destination has native height 37.924999, but `decide` reconstructs
the destination's height as 30.346444 from its plan coordinates. With that input,
`computePath` fails with status -2147483640 (invalid parameter); with the native
destination height, the same query returns a complete path across the crossing.
The failed lookahead also prevents the crossing-permission decision from seeing
the crossing. The person stays at its closed boundary for 32.65 seconds.

Walker 595 has a second instance of the same loss: its native intermediate target
is at height 0.425 while its body is on the deck at 37.924999. Its intended route
continues on that deck, but `laneTarget` drops the path height before projecting
the lateral point. Detour returns a partial path ending almost at the body.

This is loss of a navigation point's surface identity. Larger searches, different
goals, removing the obstacle or pushing the body would not correct that identity.

## Sources and comparison

1. [recast-navigation-js query source](https://raw.githubusercontent.com/isaac-mason/recast-navigation-js/main/packages/recast-navigation-core/src/nav-mesh-query.ts):
   query inputs and returned points are three-dimensional. `computePath` finds
   start/end polygons using its query extents; a two-dimensional point with an
   invented height is not the same query. Installed source/types were also read.
2. [Detour NavMeshQuery source](https://github.com/recastnavigation/recastnavigation/blob/main/Detour/Source/DetourNavMeshQuery.cpp):
   polygon references and query positions determine the path. Invalid references
   are rejected; retaining a surface point avoids constructing the wrong query.
3. [Unity SamplePosition](https://docs.unity3d.com/ScriptReference/AI.NavMesh.SamplePosition.html):
   nearest-position searches can select another floor and do not account for a
   ceiling as an obstruction. Increasing query extent is not a floor-identity fix.
4. [Godot NavigationServer3D](https://docs.godotengine.org/en/stable/classes/class_navigationserver3d.html):
   closest points, origins, destinations and path arrays use Vector3 positions;
   navigation map/region membership is distinct from proximity in the plane.
5. [Epic ProjectPointToNavigation](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/NavigationSystem/UNavigationSystemV1/ProjectPointToNavigation):
   projection accepts an FVector point and extent and returns an FNavLocation,
   preserving the projected navigation location rather than just its plan position.
6. [Babylon official navigation documentation](https://github.com/BabylonJS/Documentation/blob/master/content/features/featuresDeepDive/crowdNavigation/createNavMesh.md):
   getClosestPoint and computePath pass full Vector3 points; query extent bounds
   the returned solution. The documented example feeds the projected point
   directly into pathfinding. This is the lifecycle Roadcraft had broken.

These are five independent engine origins (Recast and its JS wrapper count as
one). They agree on three-dimensional navigation locations; they differ in how
queries expose polygon/map ownership and failure. None requires changing the
mesh or warping an existing body. Searches were reformulated around partial
paths, stacked floors, nearest-poly extent and preserving projected destinations.

Additional comparisons: the [Godot contributor discussion](https://forum.godotengine.org/t/when-using-a-navagent2d-how-can-i-get-the-closest-point-to-a-specific-navregion2d-that-i-choose-programmatically/79352)
describes nearest-point queries spanning regions and accidentally selecting an
upper floor; it corroborates the ambiguity but is not the diagnosis of our code.
The [Menge paper](https://gamma.cs.unc.edu/Menge/files/mengeCDMain.pdf) explicitly
models goals as two-dimensional regions: that planar representation cannot be
copied unchanged into Roadcraft's stacked decks. The previously read
[Reynolds GDC proceedings](https://www.red3d.com/cwr/steer/gdc99/) inform navigation
versus locomotion ownership, but do not prescribe this point-storage fix; no
claim is made to have watched a talk or implemented either paper's full model.

## Chosen correction

Store each accepted goal and last request as a GroundPoint carrying x, y and h.
Reuse that height in planning and access-change re-requests. Intermediate route
targets interpolate the existing route's height and retain the projected result.
Local requests without an explicit height use the walker's current deck; companion
places use the leader's known deck. Generic world locations still use the existing
initial projection policy. No destinations in plan coordinates, births, geometry,
query extents, radii, timings or solver settings change.

The functional regression follows the real city walker 212 for sixty seconds:
it fails before with a 32.65-second unexplained stop, then passes below five seconds.
The full fixed battery is byte-identical. Full-city metrics and fixed-camera
game images, including the limitations of the first framing, are in step 09.

Remaining limits: not every wait or partial path is a height defect. The city
still contains unexplained stopping and crowd delays; this is not a claim that
all route failures or the complete engine are fixed.
