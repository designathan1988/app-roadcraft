import {
  MeshDepthMaterial,
  RGBADepthPacking,
  ShaderChunk,
  Vector2,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from 'three';

/**
 * Wind: the one moving thing in a scene of static props.
 *
 * Trees, bushes and grass bend in the vertex shader, so a thousand trees cost
 * one uniform write a frame and not one matrix. The motion is layered the way
 * real vegetation moves:
 *
 *  - a slow GUST that travels across the map, so neighbouring trees lean
 *    together and a wave of it can be seen crossing a field;
 *  - a SWAY, each plant at its own phase, bending harder towards the top
 *    (displacement grows with the square of height, as a cantilever does);
 *  - a fast FLUTTER of individual leaves and blades, keyed off the vertex
 *    position, which is what reads as foliage rather than as a rigid shape
 *    rocking.
 *
 * Every mesh here is an `InstancedMesh` whose geometry is authored ONE unit
 * tall with its root at the origin, so the local `y` is already "fraction of
 * height" and the instance's Y scale is the height in world units.
 *
 * The same bend is installed on a depth material, so the shadows move with
 * the trees instead of lying still under them.
 */

/** Shared by every material with wind; `renderer.ts` advances the time. */
export const windUniforms = {
  uWindTime: { value: 0 },
  /** Direction the wind blows TOWARDS, in three's XZ plane. */
  uWindDir: { value: new Vector2(0.82, -0.57).normalize() },
};

export interface WindResponse {
  /** Top displacement as a fraction of height, at a full gust. */
  readonly sway: number;
  /** Leaf or blade flutter, as a fraction of height. */
  readonly flutter: number;
}

const WIND_GLSL = /* glsl */ `
  uniform float uWindTime;
  uniform vec2 uWindDir;
  uniform float uWindSway;
  uniform float uWindFlutter;

  vec3 windOffset(vec3 local, mat4 placement) {
    vec3 root = placement[3].xyz;
    float height = length(placement[1].xyz);
    float h = clamp(local.y, 0.0, 1.4);
    float bend = h * h;
    float phase = dot(root.xz, vec2(0.0131, 0.0173));
    // A gust front travelling downwind across the map.
    float front = dot(root.xz, uWindDir) * 0.012 - uWindTime * 0.42;
    float gust = 0.45 + 0.55 * smoothstep(-0.6, 1.0, sin(front) + 0.35 * sin(front * 2.3 + 1.7));
    float sway = 0.45
      + 0.4 * sin(uWindTime * 1.35 + phase * 7.0 + root.x * 0.031)
      + 0.15 * sin(uWindTime * 2.9 + phase * 11.0);
    vec3 dir = vec3(uWindDir.x, 0.0, uWindDir.y);
    vec3 offset = dir * sway * gust * bend * uWindSway * height;
    float leaf = sin(uWindTime * 7.3 + dot(local, vec3(37.0, 19.0, 29.0)) + phase * 17.0);
    float leaf2 = cos(uWindTime * 5.1 + dot(local, vec3(23.0, 41.0, 13.0)));
    offset += vec3(leaf, 0.35 * leaf2, leaf2) * uWindFlutter * h * height * (0.4 + gust);
    // A bent stem is no longer: drop the tip by what it moved sideways, so a
    // tree leans rather than stretches.
    offset.y -= dot(offset.xz, offset.xz) / max(2.0 * height * max(h, 0.2), 0.001);
    return offset;
  }
`;

const PROJECT_WITH_WIND = ShaderChunk.project_vertex.replace(
  'mvPosition = modelViewMatrix * mvPosition;',
  `#ifdef USE_INSTANCING
     mvPosition.xyz += windOffset(transformed, instanceMatrix);
   #endif
   mvPosition = modelViewMatrix * mvPosition;`,
);

function install(shader: WebGLProgramParametersWithUniforms, response: WindResponse): void {
  Object.assign(shader.uniforms, windUniforms, {
    uWindSway: { value: response.sway },
    uWindFlutter: { value: response.flutter },
  });
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${WIND_GLSL}`)
    .replace('#include <project_vertex>', PROJECT_WITH_WIND);
}

/** Makes a material's instances bend in the wind. */
export function applyWind(material: Material, response: WindResponse, key: string): void {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    install(shader, response);
  };
  material.customProgramCacheKey = () => `wind-${key}`;
}

/** The shadow-pass twin of a wind material, for `mesh.customDepthMaterial`. */
export function windDepthMaterial(response: WindResponse, key: string): MeshDepthMaterial {
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  depth.onBeforeCompile = (shader) => install(shader, response);
  depth.customProgramCacheKey = () => `wind-depth-${key}`;
  return depth;
}

/** Advances the wind clock. Called once a frame; costs one uniform write. */
export function advanceWind(seconds: number): void {
  windUniforms.uWindTime.value = seconds;
}
