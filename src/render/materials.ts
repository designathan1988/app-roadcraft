import { Color, DoubleSide, FrontSide, MeshStandardMaterial } from 'three';

import { bakeSurface, disposeBakedTextures, fbm, makeNoise, type SurfaceBake } from './mesh/textureBaker';
import { applyDetail, detailSwitch, disposeDetailTextures } from './mesh/detailLayer';

/**
 * Every material the scene uses, baked once and shared.
 *
 * A material here owns its textures. The road network is rebuilt on every edit,
 * and the previous code baked a fresh 160x160 canvas per band per structure on
 * each of those rebuilds — a stutter the player felt as a hitch while drawing.
 * Nothing in this module is rebuilt; the meshes are swapped and the materials
 * stay.
 *
 * ## Texture scale
 *
 * Each recipe declares the world size one tile covers. UVs are handed to the
 * mesh builder in WORLD UNITS, and the material divides by that world size, so
 * scale is stated once and can never drift between a road and the junction it
 * runs into. One world unit is 0.4 m, so asphalt aggregate at a 12-unit tile is
 * a 4.8 m repeat — close enough to a real surfacing course that the eye reads
 * texture rather than pattern.
 *
 * ## Close zoom
 *
 * The macro textures carry tone, wear, slabs and joints - everything visible
 * from the play zoom. The fine structure a player sees with the camera a few
 * metres off the ground (stones in the asphalt, sand in the concrete, blades in
 * the grass) comes from the detail layer in `mesh/detailLayer.ts`, which fades
 * in by pixel footprint. See that file for why a larger macro texture was not
 * the answer.
 */

export interface SceneMaterials {
  readonly asphalt: MeshStandardMaterial;
  readonly asphaltRaised: MeshStandardMaterial;
  readonly footway: MeshStandardMaterial;
  readonly kerb: MeshStandardMaterial;
  readonly verge: MeshStandardMaterial;
  readonly deck: MeshStandardMaterial;
  /**
   * The deck's concrete again, for the parapets. The same look in its own
   * material, because the parapets are instanced and the deck is not: one
   * material drawn both ways makes three switch its program between the two
   * variants on every frame.
   */
  readonly parapet: MeshStandardMaterial;
  readonly concrete: MeshStandardMaterial;
  readonly steel: MeshStandardMaterial;
  /** World units one tile of each surface covers, for UV generation. */
  readonly scale: {
    readonly asphalt: number;
    readonly footway: number;
    readonly kerb: number;
    readonly verge: number;
    readonly deck: number;
  };
  /** Switches the close-zoom detail layer on every material that has one. */
  setDetail(enabled: boolean): void;
  dispose(): void;
}

const ASPHALT_TILE = 26;
const FOOTWAY_TILE = 18;
const KERB_TILE = 8;
const VERGE_TILE = 22;
const DECK_TILE = 20;

/** A small integer hash, for per-slab variation that is stable and tiles. */
function cellHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

function asphaltBake(key: string, base: number, anisotropy: number): SurfaceBake {
  const grain = makeNoise(0x51ed);
  const macro = makeNoise(0x9a17);
  const patch = makeNoise(0x2b64);
  const oil = makeNoise(0x6d05);
  const size = 512;
  return bakeSurface(
    key,
    {
      size,
      worldSize: ASPHALT_TILE,
      relief: 1.2,
      shade: (x, y, out) => {
        const u = x / size;
        const v = y / size;
        // Aggregate at the macro scale: kept LOW in contrast, because it is
        // what gets magnified at close zoom. The stones themselves are the
        // detail layer's job.
        const chips = fbm(grain, u * 128, v * 128, 128, 3);
        // Wear and repair patches: slow, wide, low contrast.
        const wear = fbm(macro, u * 6, v * 6, 6, 4);
        const repair = fbm(patch, u * 3 + 11, v * 3 + 7, 3, 2);
        // Drip stains down the middle of a lane, where engines stand.
        const stain = fbm(oil, u * 14, v * 3, 14, 3);
        const drip = stain > 0.66 ? (stain - 0.66) * 0.12 : 0;
        const tone =
          base +
          (chips - 0.5) * 0.03 +
          (wear - 0.5) * 0.032 +
          (repair > 0.74 ? 0.018 : 0) -
          drip;
        out.r = tone * 1.0;
        out.g = tone * 1.01;
        out.b = tone * 1.05;
        // Only the aggregate is relief. Letting the wide wear patches into the
        // height map turned a smooth carriageway into a field of shallow craters.
        out.h = chips;
        // Polished wheel tracks are smoother than the rest of the lane.
        out.rough = 0.9 - (wear > 0.62 ? 0.09 : 0) - chips * 0.05 - drip * 2;
      },
    },
    anisotropy,
  );
}

/**
 * The footway: precast concrete slabs, laid in stretcher bond.
 *
 * The previous bake was one flat tone crossed by a hard 1.5-texel line every
 * slab, which read as a grid printed on paper - and, magnified at close zoom,
 * as a blurred grid on paper. What makes a real pavement read is that no two
 * slabs are the same: each was cast on a different day, so each has its own
 * tone and its own weathering; the arrises are chamfered, so a joint is a soft
 * groove with a shadow rather than a line; dirt collects in the joints; and
 * here and there a slab has cracked or been replaced with a newer, paler one.
 */
function footwayBake(anisotropy: number): SurfaceBake {
  const grain = makeNoise(0x77c1);
  const stain = makeNoise(0x1d3f);
  const blot = makeNoise(0x5e2d);
  const crackNoise = makeNoise(0x3c19);
  const size = 1024;
  /** Six slab courses per tile: 18 units / 6 = 3 units = 1.2 m. */
  const slab = size / 6;
  /** Chamfer width in texels. */
  const bevel = 5;
  return bakeSurface(
    'footway',
    {
      size,
      worldSize: FOOTWAY_TILE,
      relief: 4.2,
      shade: (x, y, out) => {
        const u = x / size;
        const v = y / size;
        // Stretcher bond: every other course is shifted by half a slab.
        const row = Math.floor(y / slab);
        const shift = row % 2 === 0 ? 0 : slab / 2;
        const sx = (x + shift) % size;
        const col = Math.floor(sx / slab);
        const jx = Math.min(sx % slab, slab - (sx % slab));
        const jy = Math.min(y % slab, slab - (y % slab));
        const edge = Math.min(jx, jy);
        // 0 in the joint, rising over the chamfer to 1 on the slab face.
        const face = Math.min(1, Math.max(0, (edge - 1.2) / bevel));
        const chamfer = face * face * (3 - 2 * face);

        const slabId = cellHash(col % 6, row, 0x5a1b);
        const replaced = slabId > 0.93;
        const slabTone = (slabId - 0.5) * 0.09 + (replaced ? 0.07 : 0);

        const speck = fbm(grain, u * 160, v * 160, 160, 3);
        const dirt = fbm(stain, u * 5, v * 5, 5, 3);
        const spot = fbm(blot, u * 24, v * 24, 24, 2);
        // Gum and drip marks: small, dark, rare.
        const mark = spot > 0.72 ? (spot - 0.72) * 1.4 : 0;

        // A crack across one slab in twelve, following a wandering line.
        let crack = 0;
        if (slabId < 0.085) {
          const along = (sx % slab) / slab;
          const line = 0.5 + (fbm(crackNoise, along * 6 + col, row * 3.1, 64, 3) - 0.5) * 0.9;
          const d = Math.abs((y % slab) / slab - line) * slab;
          crack = d < 1.1 ? 1 - d / 1.1 : 0;
        }

        // Dirt settles in the joints and down the chamfer.
        const grime = (1 - chamfer) * 0.22;
        const tone =
          0.7 +
          slabTone +
          (speck - 0.5) * 0.05 -
          (dirt - 0.5) * 0.08 -
          mark * 0.25 -
          grime -
          crack * 0.2;
        // Slightly warm, the colour of a limestone aggregate.
        out.r = tone * 1.015;
        out.g = tone * 0.995;
        out.b = tone * 0.955;
        out.h = 0.2 + chamfer * (0.62 + speck * 0.12) - crack * 0.3;
        out.rough = 0.88 - speck * 0.06 + (1 - chamfer) * 0.08;
      },
    },
    anisotropy,
  );
}

/**
 * The kerb: granite, lighter and cooler than the concrete footway so the kerb
 * line reads as its own edge from the play zoom. Speckled, because that is
 * what granite looks like, and jointed about every metre along the run.
 */
function kerbBake(anisotropy: number): SurfaceBake {
  const grain = makeNoise(0x4aa9);
  const flake = makeNoise(0x9131);
  const size = 256;
  const unit = size / 3;
  return bakeSurface(
    'kerb',
    {
      size,
      worldSize: KERB_TILE,
      relief: 2.6,
      shade: (x, y, out) => {
        const u = x / size;
        const v = y / size;
        const speck = fbm(grain, u * 72, v * 72, 72, 3);
        const crystals = fbm(flake, u * 150, v * 150, 150, 1);
        const dark = crystals > 0.68 ? 0.14 : 0;
        const light = crystals < 0.24 ? 0.06 : 0;
        // Units jointed every third of a tile across the run; soft, not a line.
        const j = Math.min(x % unit, unit - (x % unit));
        const joint = j < 2.5 ? 1 - j / 2.5 : 0;
        const stone = cellHash(Math.floor(x / unit), 0, 0x77aa);
        const tone = 0.83 + (stone - 0.5) * 0.06 + (speck - 0.5) * 0.06 - dark + light - joint * 0.24;
        out.r = tone * 0.985;
        out.g = tone * 0.99;
        out.b = tone * 1.0;
        out.h = joint > 0 ? 0.4 * (1 - joint) : 0.6 + speck * 0.3 + light;
        out.rough = 0.8 - light * 0.8;
      },
    },
    anisotropy,
  );
}

function vergeBake(anisotropy: number): SurfaceBake {
  const blades = makeNoise(0x6b21);
  const clumps = makeNoise(0xa30d);
  const size = 512;
  return bakeSurface(
    'verge',
    {
      size,
      worldSize: VERGE_TILE,
      relief: 1.6,
      shade: (x, y, out) => {
        const u = x / size;
        const v = y / size;
        const fine = fbm(blades, u * 150, v * 150, 150, 2);
        const clump = fbm(clumps, u * 9, v * 9, 9, 4);
        const dry = clump > 0.62 ? (clump - 0.62) * 2.4 : 0;
        // The fine term is kept gentle for the same reason as the asphalt's:
        // the blades are the detail layer's.
        //
        // The tone is the terrain grass's (`render/terrain.ts`), a little
        // fresher because a verge is mown. It used to be half as bright again,
        // and every road ran between two stripes of lawn-green paint.
        out.r = 0.16 + fine * 0.05 + dry * 0.3;
        out.g = 0.26 + fine * 0.07 + clump * 0.08 + dry * 0.2;
        out.b = 0.09 + fine * 0.03 + dry * 0.08;
        out.h = fine * 0.5 + clump * 0.5;
        out.rough = 0.98;
      },
    },
    anisotropy,
  );
}

function deckBake(anisotropy: number): SurfaceBake {
  const grain = makeNoise(0xcc41);
  const streak = makeNoise(0x3e90);
  const size = 512;
  return bakeSurface(
    'deck',
    {
      size,
      worldSize: DECK_TILE,
      relief: 2.4,
      shade: (x, y, out) => {
        const u = x / size;
        const v = y / size;
        const speck = fbm(grain, u * 80, v * 80, 80, 3);
        // Vertical weathering runs, the signature of an exposed concrete face.
        const run = fbm(streak, u * 30, v * 2.5, 30, 3);
        const form = y % (size / 4) < 2 ? 1 : 0;
        const tone = 0.66 + (speck - 0.5) * 0.08 - Math.max(0, run - 0.58) * 0.28 - form * 0.09;
        out.r = tone;
        out.g = tone * 0.995;
        out.b = tone * 0.97;
        out.h = form ? 0.2 : 0.5 + speck * 0.5;
        out.rough = 0.9;
      },
    },
    anisotropy,
  );
}

export function createMaterials(anisotropy: number): SceneMaterials {
  const road = asphaltBake('asphalt', 0.215, anisotropy);
  const raised = asphaltBake('asphalt-raised', 0.245, anisotropy);
  const footway = footwayBake(anisotropy);
  const kerb = kerbBake(anisotropy);
  const verge = vergeBake(anisotropy);
  const deck = deckBake(anisotropy);

  const surface = (
    bake: SurfaceBake,
    tint: number,
    roughness: number,
    metalness: number,
    normalScale: number,
    /**
     * Whether the mesh's own `color` attribute multiplies this material.
     *
     * The carriageway needs it: a residential street and a boulevard share a
     * junction and therefore a polygon, so the class colour has to be written
     * per vertex (`asphaltTint` in `roadSurfaces.ts`). That code was already
     * writing the attribute and the mesh builder was already carrying it, but
     * nothing ever turned the flag on, so every class came out the same
     * near-black — which is exactly what a player reported when they asked for
     * residential streets to be greyer.
     */
    vertexColors = false,
  ): MeshStandardMaterial => {
    const material = new MeshStandardMaterial({
      color: new Color(tint),
      map: bake.map,
      normalMap: bake.normalMap,
      roughnessMap: bake.roughnessMap,
      roughness,
      metalness,
      side: FrontSide,
      envMapIntensity: 0.55,
      vertexColors,
    });
    material.normalScale.set(normalScale, normalScale);
    return material;
  };

  const materials: MeshStandardMaterial[] = [];
  const keep = <T extends MeshStandardMaterial>(value: T): T => {
    materials.push(value);
    return value;
  };

  const asphalt = keep(surface(road, 0xffffff, 1, 0.02, 1, true));
  const asphaltRaised = keep(surface(raised, 0xffffff, 1, 0.02, 0.9, true));
  const footwayMaterial = keep(surface(footway, 0xffffff, 1, 0, 1));
  const kerbMaterial = keep(surface(kerb, 0xffffff, 1, 0, 0.85));
  const vergeMaterial = keep(surface(verge, 0xffffff, 1, 0, 0.9));
  const deckMaterial = keep(surface(deck, 0xffffff, 1, 0.02, 1));
  const parapetMaterial = keep(surface(deck, 0xffffff, 1, 0.02, 1));

  // The close-zoom layer. `macroBlur` is how many mip levels softer the macro
  // map is read once the detail is fully in - enough to melt the magnified
  // noise cells, not enough to lose the slab joints.
  applyDetail(asphalt, { kind: 'asphalt', macroTile: ASPHALT_TILE, albedo: 0.9, normal: 1.1, macroBlur: 1.6 }, anisotropy);
  applyDetail(asphaltRaised, { kind: 'asphalt', macroTile: ASPHALT_TILE, albedo: 0.9, normal: 1.1, macroBlur: 1.6 }, anisotropy);
  applyDetail(footwayMaterial, { kind: 'concrete', macroTile: FOOTWAY_TILE, albedo: 0.7, normal: 0.8, macroBlur: 0.6 }, anisotropy);
  applyDetail(kerbMaterial, { kind: 'concrete', macroTile: KERB_TILE, albedo: 0.55, normal: 0.7, macroBlur: 0.8 }, anisotropy);
  applyDetail(vergeMaterial, { kind: 'grass', macroTile: VERGE_TILE, albedo: 1, normal: 1.2, macroBlur: 2 }, anisotropy);
  applyDetail(deckMaterial, { kind: 'concrete', macroTile: DECK_TILE, albedo: 0.6, normal: 0.8, macroBlur: 1 }, anisotropy);
  applyDetail(parapetMaterial, { kind: 'concrete', macroTile: DECK_TILE, albedo: 0.6, normal: 0.8, macroBlur: 1 }, anisotropy);

  return {
    asphalt,
    asphaltRaised,
    footway: footwayMaterial,
    kerb: kerbMaterial,
    verge: vergeMaterial,
    deck: deckMaterial,
    parapet: parapetMaterial,
    concrete: keep(
      new MeshStandardMaterial({
        color: 0x9fa4a2,
        map: deck.map,
        normalMap: deck.normalMap,
        roughnessMap: deck.roughnessMap,
        roughness: 1,
        metalness: 0.02,
        side: FrontSide,
      }),
    ),
    steel: keep(
      new MeshStandardMaterial({
        color: 0x8e979a,
        roughness: 0.42,
        metalness: 0.72,
        side: DoubleSide,
      }),
    ),
    scale: {
      asphalt: ASPHALT_TILE,
      footway: FOOTWAY_TILE,
      kerb: KERB_TILE,
      verge: VERGE_TILE,
      deck: DECK_TILE,
    },
    setDetail(enabled) {
      detailSwitch.value = enabled ? 1 : 0;
    },
    dispose() {
      for (const material of materials) material.dispose();
      // The baked textures are shared and cached by key, so they are the
      // material set's to release — disposing a material alone leaves every
      // canvas and every GPU texture behind.
      disposeBakedTextures();
      disposeDetailTextures();
    },
  };
}
