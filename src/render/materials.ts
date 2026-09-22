import { Color, DoubleSide, FrontSide, MeshStandardMaterial } from 'three';

import { bakeSurface, disposeBakedTextures, fbm, makeNoise, type SurfaceBake } from './mesh/textureBaker';

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
 */

export interface SceneMaterials {
  readonly asphalt: MeshStandardMaterial;
  readonly asphaltRaised: MeshStandardMaterial;
  readonly footway: MeshStandardMaterial;
  readonly kerb: MeshStandardMaterial;
  readonly verge: MeshStandardMaterial;
  readonly deck: MeshStandardMaterial;
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
  dispose(): void;
}

const ASPHALT_TILE = 26;
const FOOTWAY_TILE = 18;
const KERB_TILE = 8;
const VERGE_TILE = 22;
const DECK_TILE = 20;

function asphaltBake(key: string, base: number, anisotropy: number): SurfaceBake {
  const grain = makeNoise(0x51ed);
  const macro = makeNoise(0x9a17);
  const patch = makeNoise(0x2b64);
  const size = 512;
  return bakeSurface(
    key,
    {
      size,
      worldSize: ASPHALT_TILE,
      relief: 1.5,
      shade: (x, y, out) => {
        const u = x / size;
        const v = y / size;
        // Aggregate: high-frequency noise, the thing that reads as chippings.
        const chips = fbm(grain, u * 128, v * 128, 128, 3);
        // Wear and repair patches: slow, wide, low contrast.
        const wear = fbm(macro, u * 6, v * 6, 6, 4);
        const repair = fbm(patch, u * 3 + 11, v * 3 + 7, 3, 2);
        const tone = base + (chips - 0.5) * 0.055 + (wear - 0.5) * 0.028 + (repair > 0.74 ? 0.022 : 0);
        out.r = tone * 1.0;
        out.g = tone * 1.01;
        out.b = tone * 1.05;
        // Only the aggregate is relief. Letting the wide wear patches into the
        // height map turned a smooth carriageway into a field of shallow craters.
        out.h = chips;
        // Polished wheel tracks are smoother than the rest of the lane.
        out.rough = 0.9 - (wear > 0.62 ? 0.09 : 0) - chips * 0.05;
      },
    },
    anisotropy,
  );
}

function footwayBake(anisotropy: number): SurfaceBake {
  const grain = makeNoise(0x77c1);
  const stain = makeNoise(0x1d3f);
  const size = 512;
  const slab = size / 6;
  return bakeSurface(
    'footway',
    {
      size,
      worldSize: FOOTWAY_TILE,
      relief: 3.4,
      shade: (x, y, out) => {
        const u = x / size;
        const v = y / size;
        const speck = fbm(grain, u * 96, v * 96, 96, 3);
        const dirt = fbm(stain, u * 5, v * 5, 5, 3);
        // Slab joints: a dark, recessed line every sixth of the tile.
        const jx = Math.min(x % slab, slab - (x % slab));
        const jy = Math.min(y % slab, slab - (y % slab));
        const joint = Math.min(jx, jy) < 1.5 ? 1 : 0;
        const tone = 0.79 + (speck - 0.5) * 0.09 - (dirt - 0.5) * 0.07 - joint * 0.17;
        out.r = tone;
        out.g = tone * 0.995;
        out.b = tone * 0.955;
        out.h = joint ? 0.1 : 0.55 + speck * 0.45;
        out.rough = 0.9 - speck * 0.08;
      },
    },
    anisotropy,
  );
}

function kerbBake(anisotropy: number): SurfaceBake {
  const grain = makeNoise(0x4aa9);
  const size = 256;
  return bakeSurface(
    'kerb',
    {
      size,
      worldSize: KERB_TILE,
      relief: 2.2,
      shade: (x, y, out) => {
        const u = x / size;
        const v = y / size;
        const speck = fbm(grain, u * 72, v * 72, 72, 3);
        // Precast kerb units, jointed every third of a tile across the run.
        const joint = x % (size / 3) < 1.5 ? 1 : 0;
        const tone = 0.84 + (speck - 0.5) * 0.07 - joint * 0.2;
        out.r = tone;
        out.g = tone * 0.99;
        out.b = tone * 0.96;
        out.h = joint ? 0.05 : 0.6 + speck * 0.4;
        out.rough = 0.86;
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
      relief: 2.0,
      shade: (x, y, out) => {
        const u = x / size;
        const v = y / size;
        const fine = fbm(blades, u * 150, v * 150, 150, 2);
        const clump = fbm(clumps, u * 9, v * 9, 9, 4);
        const dry = clump > 0.62 ? (clump - 0.62) * 2.4 : 0;
        out.r = 0.2 + fine * 0.11 + dry * 0.32;
        out.g = 0.33 + fine * 0.15 + clump * 0.1 + dry * 0.22;
        out.b = 0.13 + fine * 0.07 + dry * 0.09;
        out.h = fine * 0.7 + clump * 0.3;
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

  return {
    asphalt: keep(surface(road, 0xffffff, 1, 0.02, 1, true)),
    asphaltRaised: keep(surface(raised, 0xffffff, 1, 0.02, 0.9, true)),
    footway: keep(surface(footway, 0xffffff, 1, 0, 1)),
    kerb: keep(surface(kerb, 0xffffff, 1, 0, 0.85)),
    verge: keep(surface(verge, 0xffffff, 1, 0, 0.9)),
    deck: keep(surface(deck, 0xffffff, 1, 0.02, 1)),
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
    dispose() {
      for (const material of materials) material.dispose();
      // The baked textures are shared and cached by key, so they are the
      // material set's to release — disposing a material alone leaves every
      // canvas and every GPU texture behind.
      disposeBakedTextures();
    },
  };
}
