# Materials and textures

**Files:** `src/render/materials.ts`, `src/render/mesh/textureBaker.ts`

## Everything is baked, nothing is downloaded

Every surface in the game is textured from canvases painted at start-up. Three
reasons, in order of weight:

1. **They tile seamlessly by construction.** The noise is periodic, so a road can
   repeat its asphalt a thousand times with no visible seam — the failure a
   photographic tile always eventually shows.
2. **The normal and roughness maps come from the same height field as the
   colour**, so the lighting agrees with what the surface looks like. That
   agreement is most of what makes a flat polygon read as a material.
3. Nothing to download, so the first frame is never a grey placeholder.

## The baker

`bakeSurface(key, recipe, anisotropy)` sweeps a canvas once and produces three
textures from one pass:

| output | from |
|---|---|
| colour map | the recipe's `r`, `g`, `b` |
| normal map | central difference of the recipe's `h`, with the recipe's `relief` |
| roughness map | the recipe's `rough` |

A recipe declares the **world size one tile covers**. UVs are handed to the mesh
builder in world units and divided by that size, so scale is stated once and can
never drift between a road and the junction it runs into. Texture `repeat` stays
at 1 — the division is in the UV, not in the sampler.

Everything is cached by key. The road network is rebuilt on every edit, and an
earlier version baked a fresh canvas per band per structural level on each of
those rebuilds — a stutter the player felt as a hitch while drawing. Nothing in
this module is rebuilt; the meshes are swapped and the materials stay.

## The recipes

| material | tile | what is in it |
|---|---|---|
| `asphalt` | 26 u | aggregate at high frequency, wide low-contrast wear, occasional repair patches; **only the aggregate drives the relief** |
| `asphaltRaised` | 26 u | the same, lighter — a deck surface weathers differently from a street |
| `footway` | 18 u | speckle, dirt staining, recessed slab joints every sixth of a tile |
| `kerb` | 8 u | speckle and precast unit joints across the run |
| `verge` | 22 u | fine blades, clumps, dry patches |
| `deck` | 20 u | concrete speckle, vertical weathering runs, form-work lines |
| `terrain-grass` | 42 u | blades and clumps, moss in the hollows, dry in the open |
| `terrain-rock` | 58 u | strata, grain, recessed cracks — strong relief |
| `terrain-dirt` | 34 u | grain and patches, warm |

### Why only the aggregate is relief

Letting the wide wear patches into the asphalt height map turned a smooth
carriageway into a field of shallow craters at close zoom: the normal map picked
up four-unit features at full strength and the sun carved them. Wear belongs in
the colour and the roughness, where it reads as a polished wheel track; the
relief belongs to the chippings.

## Materials

All `MeshStandardMaterial`, front-side, with colour, normal and roughness maps and
a modest `envMapIntensity` so the sky contributes without flattening the surface.

Road paint is the exception worth noting: it is **lit**, not unlit. See
[road-system.md](road-system.md#markings).

## Anisotropy

Requested from the quality tier and clamped to what the GPU reports. Ground
textures at a grazing isometric angle are exactly the case anisotropic filtering
exists for; without it the road surface smears into a grey band in the distance.

## Adding a material

1. Write a recipe in `materials.ts` with its `worldSize` and `relief`.
2. Add it to `SceneMaterials` and to `scale`.
3. Pass `materials.scale.yours` to the mesh builder's `uv` function.

Do not create a material anywhere else, and never inside a rebuild.
