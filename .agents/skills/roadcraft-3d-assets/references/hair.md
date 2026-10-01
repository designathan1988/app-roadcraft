# Hair (and hats bound to the head)

## Why hair is built this way

- **Bound to `helper-hair`**, the MakeHuman shell round the head and down the back. Bound to the skin,
  hair beside the arm would follow the arm's swing.
- **Solid clumps, not alpha cards.** The game's crowd reads the texture only at VERTICES and drops
  triangles whose vertices are mostly transparent. Thin strand textures on flat cards vanish or show
  holes. Each clump is a tapered elliptical tube; detail comes from the geometry and per-vertex shade.
- **Greyscale texture.** The game dyes it: `colour * (0.45 + 1.1 * luminance)`. Root ~0.30, middle
  ~0.55, tip ~0.70; alpha 1.0 except the last 10% of a clump (down to 0.6). `hair_build.py` paints it.
- **Guides and children.** A third of the clumps are simulated guides (gravity, body collision,
  steering behind the shoulders); the rest follow their three nearest guides. Neighbouring hair flows
  together instead of each clump wandering.
- **A safety pass** enforces the rules on the finished surface (a clump's width can spill past its
  centre line).

## The game's rules (check_hair.py enforces them)

| rule | limit | why |
|---|---|---|
| length | nothing below y = 1.2 dm (waist) | the shell ends at y 2.0; longer hair detaches from the body |
| chest | below y = 6.0: z <= 0.2 and abs(x) <= 1.35 | arms swing and the bust changes with sliders; hair in front would cut through them |
| face | nothing in 6.2 < y < 7.55, z > 0.95, abs(x) < 0.6 | the face stays visible; bangs end above the brows (y >= 7.55) |
| skin | no vertex inside the body, except clump roots buried <= 0.04 dm in the scalp | |
| alpha | every vertex alpha >= 0.5; no triangle dropped by the crowd rule | |
| mhclo | refit error < 0.001 dm; refs only on helper-hair; scale refs 5399/11998, 791/881, 962/5320 | |
| bind | deformation test (smaller head, torso bent 10 deg): no torn edges | |
| budget | <= 16000 triangles (aim 8000-14000) | triangles ~ clumps x (segments-1) x sides x 2 |

## Spec parameters (`assets/hair_styles/*.json`; anything left out takes the default)

| key | default | meaning and typical range |
|---|---|---|
| `name` | - | `hair_<f/m/u>_<style><nn>`, also the folder and file names |
| `seed` | 1 | change it for a variant of the same style |
| `part` | `{"type":"center","x":0}` | `center`, `side` (x = 0.2..0.4, + is her left), `none` (combed back or curly) |
| `length` | back 2.8, side 3.4, front 4.0 | tip height (dm) for roots at the back, sides and front. Shoulder blades 3.8-4.4, mid-back 2.4-3.0, waist 1.3-1.8. Shorter at the front = layered face frame |
| `layers` | 0.10 | tip jitter as a fraction of length: 0.03 blunt cut, 0.2 heavily layered |
| `clumps` | 110 | number of clumps (80-120 loose hair; 45-60 for big curls) |
| `width` | [0.46, 0.16] | clump width at root and tip (dm). Wider = fewer gaps, chunkier |
| `thickness` | 0.035 | clump thickness (dm); 0.08-0.12 for curls |
| `clearance` | 0.05 | innermost layer's gap to the skin (dm) |
| `volume` | 0.12 | extra lift of outer layers (dm): 0.08 sleek, 0.2 full, 0.3+ curly |
| `stiffness` | 0.55 | 0.3 falls at once (sleek), 0.6 holds out before falling (volume) |
| `wave` | amp 0, wavelength 1.2 | loose waves: amp 0.08-0.14, wavelength 1.0-1.6 |
| `curl` | radius 0, period 0.45 | ringlets: radius 0.10-0.15, period 0.6-0.9 |
| `frizz` | 0 | random jitter (dm), 0.01-0.02 at most |
| `bangs` | null | `{"type":"curtain"|"straight","end_y":7.6,"clumps":18}` (end_y >= 7.55) |
| `gather` | null | `ponytail`, `braid`, `halfup` - see below |
| `braids` | null | box braids: `{"count":72,"radius":0.065}` |
| `segments` | 15 | samples per clump: 15 straight, 26 waves, 40 curls (>= 6 per wave or curl period) |
| `root_bias` | 1.5 | > 1 packs segments near the root; use 1.0 with waves or curls |
| `sides` | 4 | cross-section sides (4 is enough at game distance) |
| `shade` | root .30 mid .55 tip .70 jitter .08 | texture luminance profile |

`gather` (all points in dm, base frame):

- ponytail: `{"type":"ponytail","point":[0,8.15,-0.62],"dir":[0,-0.75,-0.65],"end_y":4.3,"scalp_clumps":70,"tail_clumps":40,"tail_width":0.26,"tie_radius":0.16,"stiffness":0.5}`.
  A low ponytail: point y ~ 6.9, z ~ -0.75.
- braid: `{"type":"braid","point":[0,6.65,-0.72],"dir":[0,-1,-0.35],"end_y":3.0,"scalp_clumps":75,"braid_width":0.42,"braid_period":0.55}`
- halfup: `{"type":"halfup","point":[0,7.85,-0.72],"top_y":7.8,"scalp_clumps":40,"bun_radius":0.24}` plus the loose-hair keys for the rest.

## Looking at the previews (do this every round)

1. **3/4 and front:** the face is clear; hair frames it; nothing crosses the eyes; no clump sticks
   out sideways like an antenna.
2. **Back:** the scalp has no bald patches (the scalp is painted hair colour, so a gap reads as a dark
   flat spot); the length is right; the cut line matches the style (blunt, layered, V).
3. **Side:** hair lies on the head and falls BEHIND the shoulders; volume is believable; no hair
   floats far from the head.
4. **Iso (from above, like the game):** the crown is covered; the silhouette reads as the style
   at a glance. If two styles of a batch look alike from here, they are not different enough.

## Symptom -> fix

| you see | change |
|---|---|
| bald gaps on the crown or at the part | `clumps` +20, or `width[0]` +0.06 |
| a helmet: hair stands off the head at ear level | `volume` down to 0.08-0.12, `stiffness` down to 0.35 |
| separate sticks, not locks | `width` up ([0.5, 0.18]), `thickness` down (0.03), more `clumps` |
| waves or curls look zig-zag / angular | `segments` up (>= 6 per wavelength or period), `root_bias` 1.0 |
| curls look like barbed wire | fewer, fatter clumps: `clumps` 45, `width` [0.36,0.18], `thickness` 0.12, `period` 0.8+ |
| bangs stick out | `bangs.end_y` lower (but >= 7.55); fewer bang clumps |
| ponytail sticks straight back | `gather.dir` more downward ([0,-0.75,-0.65]), `gather.stiffness` 0.5 |
| ponytail too thin | `tail_clumps` +10, `tail_width` +0.04 |
| too many triangles | fewer `clumps` or `segments`; `sides` 4 |
| FAIL frontOfChest / faceArea | the generator's safety pass should prevent it; if not, shorten `length.front_y`/`side_y` or narrow `width` |
| FAIL deformation tears | rerun `bind_mhclo.py` with `--coherence 2`; if it persists, the mesh has strands passing INSIDE the shell near the neck: raise `clearance` |

## Hats

Model the hat on base.obj's head (crown above y ~ 8.5, brim around the head at the brow line), bind
with `bind_mhclo.py --kind hat` (binds to helper-hair, z_depth 70), opaque texture, then
`check_hair.py` does not apply: render with `render_previews.py` and look.
