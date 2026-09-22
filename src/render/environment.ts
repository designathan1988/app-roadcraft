import {
  AmbientLight,
  BackSide,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type WebGLRenderer,
} from 'three';

/**
 * Sky, sun and atmosphere.
 *
 * The scene used to be lit by a hemisphere fill at 1.28, an ambient at 0.26 and
 * a sun almost overhead. Everything was therefore lit from every direction at
 * once, which is exactly the recipe for a flat image: measured on a hill fourteen
 * units high and a hundred and fifty across, the shading difference between its
 * slope and the flat ground beside it was under two percent — the hill was
 * invisible, and the terrain looked painted rather than modelled.
 *
 * What is here instead is one dominant, low, warm key light with real shadows, a
 * cool sky fill about a fifth of its strength, and a gradient sky that also
 * serves as the environment map so metal and water have something to reflect.
 * That ratio is what makes a slope read as a slope.
 */

/**
 * Sun elevation above the horizon.
 *
 * Low enough that a slope of a few degrees changes how much light it takes, and
 * that everything standing on the ground throws a shadow long enough to read.
 * Much higher and the scene flattens; much lower and shadows stretch until the
 * map is more shadow than ground.
 */
const SUN_ELEVATION = (38 * Math.PI) / 180;
/**
 * Sun bearing — and the one number that decides whether shadows are VISIBLE.
 *
 * The camera looks along the +x/+z diagonal (`isoViewport`, azimuth 45°). A sun
 * on the OPPOSITE diagonal back-lights the scene: every shadow then falls
 * towards the camera and hides behind the object that cast it. Measured with the
 * sun at -128°, turning shadows off changed the rendered image by 0.08 of a
 * luminance level — the shadow map was correct, fully populated, and invisible.
 *
 * Putting the sun a little clockwise of the camera's own bearing throws every
 * shadow away from the viewer and across the ground, where it does its job: it
 * is what tells the eye that a pier stands on the terrain and that a viaduct
 * passes over the road beneath it.
 */
const SUN_AZIMUTH = (14 * Math.PI) / 180;
const SUN_DISTANCE = 1_600;

export interface EnvironmentQuality {
  /** Side of the sun's shadow map. */
  readonly shadowMapSize: number;
  readonly shadows: boolean;
}

export interface SceneEnvironment {
  readonly sun: DirectionalLight;
  readonly skyColor: Color;
  /** Points the shadow frustum at what the camera is looking at. */
  follow(target: Vector3, halfWidth: number, halfHeight: number): void;
  setQuality(quality: EnvironmentQuality): void;
  dispose(): void;
}

const SKY_VERTEX = `
  varying vec3 vSkyDirection;
  void main() {
    vSkyDirection = normalize(position);
    vec4 world = modelMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
    gl_Position.z = gl_Position.w;
  }
`;

const SKY_FRAGMENT = `
  varying vec3 vSkyDirection;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;

  void main() {
    float h = vSkyDirection.y;
    vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.62));
    sky = mix(uGround, sky, smoothstep(-0.12, 0.02, h));
    // A broad, soft glow around the sun, and a tighter core inside it. Enough
    // to tell the eye where the light comes from without drawing a disc.
    float sun = max(dot(normalize(vSkyDirection), uSunDirection), 0.0);
    sky += uSunColor * (pow(sun, 7.0) * 0.28 + pow(sun, 120.0) * 0.9);
    gl_FragColor = vec4(sky, 1.0);
  }
`;

export function createEnvironment(
  scene: Scene,
  renderer: WebGLRenderer,
  quality: EnvironmentQuality,
): SceneEnvironment {
  const zenith = new Color(0x4d7fc4);
  const horizon = new Color(0xc9dcea);
  const groundTint = new Color(0x6f7a68);
  const sunColor = new Color(0xfff0d2);

  const sunDirection = new Vector3(
    Math.cos(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION),
    Math.sin(SUN_ELEVATION),
    Math.sin(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION),
  ).normalize();

  const skyMaterial = new ShaderMaterial({
    uniforms: {
      uZenith: { value: zenith },
      uHorizon: { value: horizon },
      uGround: { value: groundTint },
      uSunDirection: { value: sunDirection },
      uSunColor: { value: sunColor },
    },
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const sky = new Mesh(new SphereGeometry(1, 32, 16), skyMaterial);
  sky.name = 'sky';
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  scene.add(sky);

  // The sky doubles as the environment map, so water, glass and metal reflect
  // the same sky the player sees instead of a flat grey.
  const pmrem = new PMREMGenerator(renderer);
  const probeScene = new Scene();
  const probe = new Mesh(new SphereGeometry(1, 32, 16), skyMaterial.clone());
  probe.frustumCulled = false;
  probeScene.add(probe);
  const envTarget = pmrem.fromScene(probeScene, 0, 0.1, 100);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 0.45;
  probe.geometry.dispose();
  (probe.material as ShaderMaterial).dispose();
  pmrem.dispose();

  // Fog tinted to the horizon, so distance dissolves into the sky rather than
  // into a grey wall. It starts well past the play area.
  scene.fog = new Fog(horizon.clone().lerp(zenith, 0.18).getHex(), 2_600, 8_200);
  scene.background = null;

  const hemisphere = new HemisphereLight(0xbfd8f2, 0x55613f, 0.34);
  hemisphere.name = 'sky-fill';
  scene.add(hemisphere);

  const ambient = new AmbientLight(0xdfe9f2, 0.07);
  ambient.name = 'ambient-floor';
  scene.add(ambient);

  const sun = new DirectionalLight(0xfff0cf, 3.6);
  sun.name = 'sun';
  sun.castShadow = quality.shadows;
  sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.6;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = SUN_DISTANCE * 2.4;
  scene.add(sun, sun.target);

  let span = -1;

  return {
    sun,
    skyColor: horizon,
    follow(target, halfWidth, halfHeight) {
      sky.position.copy(target);
      sky.scale.setScalar(9_000);
      sun.position.copy(target).addScaledVector(sunDirection, SUN_DISTANCE);
      sun.target.position.copy(target);
      sun.target.updateMatrixWorld();
      // The shadow frustum is fitted to what the camera can see. Too wide and
      // every shadow is a blurred smear; too narrow and shadows pop in at the
      // edge of the screen.
      const want = Math.max(220, Math.max(halfWidth, halfHeight) * 1.25);
      if (Math.abs(want - span) > span * 0.08) {
        span = want;
        sun.shadow.camera.left = -span;
        sun.shadow.camera.right = span;
        sun.shadow.camera.top = span;
        sun.shadow.camera.bottom = -span;
        sun.shadow.camera.updateProjectionMatrix();
      }
    },
    setQuality(next) {
      sun.castShadow = next.shadows;
      if (sun.shadow.mapSize.x !== next.shadowMapSize) {
        sun.shadow.mapSize.set(next.shadowMapSize, next.shadowMapSize);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
    },
    dispose() {
      scene.remove(sky, hemisphere, ambient, sun, sun.target);
      sky.geometry.dispose();
      skyMaterial.dispose();
      envTarget.dispose();
      scene.environment = null;
      hemisphere.dispose();
      ambient.dispose();
      sun.dispose();
    },
  };
}
