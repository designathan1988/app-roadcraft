import type { Material } from 'three';

/**
 * Leaf clumps, drawn in the fragment shader rather than modelled.
 *
 * A crown is a few dozen lumpy triangles per blob - all a thousand-tree map can
 * afford - and lit smoothly that still reads as a faceted solid, the "hard"
 * look of the rest of the scene. Real foliage is a mass of small clumps with
 * dark gaps between them. This modulates the albedo by a 3D noise in the
 * model's OWN space (so the pattern is fixed to the tree and sways with it),
 * at a frequency of a few dozen clumps up the height of the tree: from the map
 * zoom it averages out to the crown's colour; close up it breaks every facet
 * into leaves and shadowed hollows.
 *
 * Bark is left alone, recognised by its colour (dark, and redder than it is
 * green, greener than it is blue), so a trunk keeps its own surface.
 */

const VERTEX = /* glsl */ `
  varying vec3 vFoliagePos;
`;

const FRAGMENT = /* glsl */ `
  varying vec3 vFoliagePos;
  uniform float uFoliageScale;

  float foliageHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float foliageNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(foliageHash(i), foliageHash(i + vec3(1, 0, 0)), f.x),
          mix(foliageHash(i + vec3(0, 1, 0)), foliageHash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(foliageHash(i + vec3(0, 0, 1)), foliageHash(i + vec3(1, 0, 1)), f.x),
          mix(foliageHash(i + vec3(0, 1, 1)), foliageHash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
`;

/** Installs leaf-clump shading. `scale` is clumps per unit of model height. */
export function applyFoliageShading(material: Material, scale: number): void {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms.uFoliageScale = { value: scale };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFoliagePos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         {
           vec3 p = vFoliagePos * uFoliageScale;
           float clump = foliageNoise(p) * 0.65 + foliageNoise(p * 2.7 + 11.0) * 0.35;
           // Hollows between clumps go dark; the tops of clumps catch light.
           float leaf = smoothstep(0.18, 0.82, clump);
           // Bark is dark and brown (red over green over blue); everything
           // else on a plant - leaf, needle, blossom - is foliage.
           vec3 c = diffuseColor.rgb;
           float bark = step(c.b, c.g) * step(c.g, c.r) * (1.0 - smoothstep(0.14, 0.24, max(c.r, max(c.g, c.b))));
           diffuseColor.rgb *= mix(0.62 + leaf * 0.6, 1.0, bark);
         }`,
      );
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}-foliage`;
}
