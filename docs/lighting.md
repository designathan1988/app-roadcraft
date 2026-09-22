# Lighting

**File:** `src/render/environment.ts`

## The problem this solves

The scene used to be lit by a hemisphere fill at 1.28, an ambient at 0.26 and a
sun almost overhead. Everything was therefore lit from every direction at once,
which is the recipe for a flat image: measured on a hill fourteen units high and
a hundred and fifty across, the shading difference between its slope and the flat
ground beside it was under two percent. The hill was invisible, and the terrain
looked painted rather than modelled.

What is here instead is **one dominant, low, warm key light with real shadows**, a
cool sky fill about a fifth of its strength, and a gradient sky that also serves
as the environment map so metal and water have something to reflect. That ratio
is what makes a slope read as a slope.

## The sun

| | | |
|---|---|---|
| elevation | 38° | low enough that a few degrees of slope changes how much light a face takes, and that everything standing on the ground throws a shadow long enough to read |
| azimuth | 14° | **the one number that decides whether shadows exist at all** |
| intensity | 3.6 | against a 0.34 hemisphere and a 0.07 ambient — roughly six to one |
| colour | warm white | with a cool sky fill, so shadows go blue and sunlight goes gold |

### Why the azimuth matters that much

The camera looks along the +x/+z diagonal. A sun on the **opposite** diagonal
back-lights the scene: every shadow then falls towards the camera and hides
behind the object that cast it.

Measured with the sun at −128°: turning shadows off changed the rendered image by
**0.08 of a luminance level**. The shadow map was correct, fully populated, and
completely invisible. Hours can be lost looking for a bug in the shadow
configuration when the configuration is fine and the geometry of the situation is
not.

Putting the sun a little clockwise of the camera's own bearing throws every
shadow away from the viewer and across the ground, where it does its job: it is
what tells the eye that a pier stands on the terrain and that a viaduct passes
over the road beneath it.

## Shadows

The shadow frustum is **fitted to what the camera can see** and re-fitted only
when the view changes by more than 8%. Too wide and every shadow is a blurred
smear; too narrow and shadows pop in at the edge of the screen; re-fitted every
frame and the shadow map shimmers.

Map resolution is a quality-tier setting (1024 → 4096). At the `low` tier shadows
are off entirely — which is also worth knowing when they seem to have stopped
working: check whether the automatic governor has dropped a tier.

`PCFSoftShadowMap`, a small constant bias and a normal bias of 0.6 world units.

## The sky

A back-side sphere with a gradient from horizon to zenith, a broad glow around
the sun and a tighter core inside it — enough to tell the eye where the light
comes from without drawing a disc. Its fragment shader forces `gl_Position.z` to
`w`, so it always sits at the far plane whatever the camera does.

The same material is rendered once through a `PMREMGenerator` and installed as
`scene.environment`. Water, glass and metal therefore reflect the sky the player
is actually looking at, rather than a flat grey.

## Fog

Linear, tinted between the horizon and the zenith, starting at 2 600 units and
reaching full at 8 200 — well past the play area. Distance dissolves into the
sky rather than into a grey wall, which is what makes the far field read as
distance rather than as haze.

## Tone mapping

ACES filmic at exposure 1.0, applied once by the composer's output pass. Inside a
composer, three renders the scene into a render target with tone mapping
disabled, so there is no double application.
