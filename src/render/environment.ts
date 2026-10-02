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
//
// It was 38 degrees: a shadow 1.28 times as long as what cast it, so a thin
// lamp column or a small figure seen from above threw a long dark shape that
// read as a shadow with nothing casting it. At 47 it is 0.93 times as long,
// and still falls clear of its caster onto the ground.
const SUN_ELEVATION = (47 * Math.PI) / 180;
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
/**
 * Depth offset of the shadow test, WORLD units (4 cm): enough to keep a lit
 * surface out of its own shadow, far too little to part a shadow from its caster.
 */
const SHADOW_BIAS_WORLD = 0.1;
/**
 * Smallest half-width of the shadow frustum, world units (5 m). Follows the
 * closest zoom (`MIN_HALF_HEIGHT` in isoViewport.ts), so a person seen close up
 * still casts a crisp shadow.
 */
const SHADOW_SPAN_MIN = 12;
const WORLD_UP = new Vector3(0, 1, 0);

export interface EnvironmentQuality {
  /** Side of the sun's shadow map. */
  readonly shadowMapSize: number;
  readonly shadows: boolean;
}

export interface SceneEnvironment {
  readonly sun: DirectionalLight;
  readonly skyColor: Color;
  /** Points the shadow frustum at what the camera is looking at. */
  follow(target: Vector3, halfWidth: number, halfHeight: number, view?: Vector3, rise?: number): void;
  setQuality(quality: EnvironmentQuality): void;
  /**
   * The time of day, minutes after midnight: the sun's path, the sky, the
   * light; the moon at night. Returns how dark it is, 0 by day to 1 at night.
   */
  setTimeOfDay(minutes: number): number;
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

const DAY_ZENITH = new Color(0x4d7fc4);
const NIGHT_ZENITH = new Color(0x0b1424);
const DAY_HORIZON = new Color(0xc9dcea);
const DUSK_HORIZON = new Color(0xf0b383);
const NIGHT_HORIZON = new Color(0x1c2638);
const DAY_SUN = new Color(0xfff0d2);
const DUSK_SUN = new Color(0xffa860);
const MOON = new Color(0x9fb4d8);

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
  // Enough for paint, glass and wet or polished surfaces to show the sky.
  scene.environmentIntensity = 0.6;
  probe.geometry.dispose();
  (probe.material as ShaderMaterial).dispose();
  pmrem.dispose();

  // Fog tinted to the horizon, so distance dissolves into the sky rather than
  // into a grey wall. It starts well past the play area.
  scene.fog = new Fog(horizon.clone().lerp(zenith, 0.18).getHex(), 2_600, 8_200);
  scene.background = null;

  // A near-neutral sky fill: the saturated blue it was tinted every shadow
  // blue at close zoom (a parapet's shadow on a roof read as blue paint).
  const hemisphere = new HemisphereLight(0xd3dde6, 0x5c6346, 0.32);
  hemisphere.name = 'sky-fill';
  scene.add(hemisphere);

  const ambient = new AmbientLight(0xdfe9f2, 0.07);
  ambient.name = 'ambient-floor';
  scene.add(ambient);

  const sun = new DirectionalLight(0xfff0cf, 3.6);
  sun.name = 'sun';
  sun.castShadow = quality.shadows;
  sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  // Shadow bias: enough to kill acne on the terrain, not enough to detach a
  // shadow from the thing casting it.
  //
  // normalBias was 0.6 world units. That is 24 cm at this scale, and it is
  // applied along the receiver's normal BEFORE the depth comparison, so every
  // shadow was shifted off its caster - classic peter-panning. On a viaduct
  // it is at its most obvious, because the deck is thin, high above its
  // receiver and casts the longest shadow in the scene: the dark band on the
  // grass detached from the piers holding it up and read as a separate,
  // broken smear. A pier 1.8 units across cast a shadow offset by a third of
  // its own width.
  //
  // And `bias` is in NORMALISED depth, so what it means in the world is the
  // bias times the shadow camera's depth range. It was -0.0005 over a fixed
  // range of 20 to 3840 units: 1.9 units (0.76 m) of offset along the light,
  // which slid every shadow off its caster - a car's shadow drawn apart from
  // the car, a pole's apart from the pole. The range now follows the frustum
  // (`fitDepth`) and the bias is stated in world units, `SHADOW_BIAS_WORLD`.
  sun.shadow.normalBias = 0.05;
  /** Height above the view's ground that the depth range last made room for. */
  let depthRise = 0;
  const fitDepth = (halfSpan: number): void => {
    // Room along the light for everything in the frustum, the tallest roof
    // included: a tower whose top lay nearer the sun than `near` cast nothing.
    const reach = halfSpan * 1.6 + 240 + depthRise;
    sun.shadow.camera.near = Math.max(1, SUN_DISTANCE - reach);
    sun.shadow.camera.far = SUN_DISTANCE + reach;
    sun.shadow.bias = -SHADOW_BIAS_WORLD / (sun.shadow.camera.far - sun.shadow.camera.near);
  };
  fitDepth(SHADOW_SPAN_MIN);
  scene.add(sun, sun.target);

  let span = -1;
  const lightRight = new Vector3();
  const lightUp = new Vector3();
  const snapped = new Vector3();
  const top = new Vector3();
  const offset = new Vector3();
  const centre = new Vector3();

  return {
    sun,
    skyColor: horizon,
    follow(target, halfWidth, halfHeight, view, rise = 0) {
      sky.position.copy(target);
      sky.scale.setScalar(9_000);
      lightRight.crossVectors(WORLD_UP, sunDirection).normalize();
      lightUp.crossVectors(sunDirection, lightRight).normalize();
      // What the camera sees is not a patch of ground but a column: the
      // ground under the middle of the screen AND everything standing on the
      // same line of sight up to the tallest roof. Fitted to the ground alone,
      // a terrace 60 m up at close zoom lay outside the shadow map - drawn in
      // full sun with a tower right beside it. The frustum is centred on the
      // column and widened by its extent in the light's view.
      let du = 0;
      let dv = 0;
      if (view && rise > 0 && view.y < -0.05) {
        top.copy(target).addScaledVector(view, -rise / -view.y);
        offset.subVectors(top, target);
        du = offset.dot(lightRight);
        dv = offset.dot(lightUp);
      }
      centre.copy(target)
        .addScaledVector(lightRight, du / 2)
        .addScaledVector(lightUp, dv / 2);
      // The shadow frustum is fitted to what the camera can see. Too wide and
      // every shadow is a blurred smear; too narrow and shadows pop in at the
      // edge of the screen.
      //
      // The floor used to be 220 units — a frustum 440 units across however
      // far the camera zoomed in. At 2048 texels that is 8 cm a texel, wider
      // than a person's leg, and the filtered shadow of a walking citizen
      // dissolved into smoke. It now follows the view down to close zoom.
      const want = Math.max(SHADOW_SPAN_MIN, Math.max(halfWidth, halfHeight) * 1.25) +
        Math.max(Math.abs(du), Math.abs(dv)) / 2;
      if (Math.abs(want - span) > span * 0.08 || Math.abs(rise - depthRise) > 20) {
        span = want;
        depthRise = rise;
        sun.shadow.camera.left = -span;
        sun.shadow.camera.right = span;
        sun.shadow.camera.top = span;
        sun.shadow.camera.bottom = -span;
        fitDepth(span);
        sun.shadow.camera.updateProjectionMatrix();
      }
      // Snap the frustum to whole shadow texels in light space. Following the
      // view continuously slid every texel under the scene each frame, so
      // small shadows crawled and flickered whenever the camera or the
      // figure moved, and read as visible "only in motion".
      const texel = (2 * span) / sun.shadow.mapSize.x;
      const u = Math.round(centre.dot(lightRight) / texel) * texel;
      const v = Math.round(centre.dot(lightUp) / texel) * texel;
      const w = centre.dot(sunDirection);
      snapped.copy(lightRight).multiplyScalar(u)
        .addScaledVector(lightUp, v)
        .addScaledVector(sunDirection, w);
      sun.position.copy(snapped).addScaledVector(sunDirection, SUN_DISTANCE);
      sun.target.position.copy(snapped);
      sun.target.updateMatrixWorld();
    },
    setTimeOfDay(minutes) {
      const hour = (((minutes / 60) % 24) + 24) % 24;
      // The sun's day: up at six, highest at noon, down at six, crossing the
      // sky from east to west round the bearing that throws shadows well.
      const day = (hour - 6) / 12;
      const height = Math.sin(Math.PI * day);
      // How much daylight: full from a few degrees up, none below the horizon.
      const light = Math.min(1, Math.max(0, (height + 0.1) / 0.25));
      const dark = 1 - light;
      if (height > -0.1) {
        const elevation = Math.max(0.12, height) * (58 * Math.PI) / 180;
        const azimuth = SUN_AZIMUTH + (Math.min(1, Math.max(0, day)) - 0.5) * (110 * Math.PI) / 180;
        sunDirection.set(Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth) * Math.cos(elevation)).normalize();
      } else {
        // The moon: high, cold and faint, from a fixed bearing.
        sunDirection.set(Math.cos(SUN_AZIMUTH + 0.6) * 0.55, 0.83, Math.sin(SUN_AZIMUTH + 0.6) * 0.55).normalize();
      }
      // Low sun is warm and weaker; the moon is blue.
      const warm = Math.max(0, 1 - height * 2.2);
      sun.color.setRGB(1, 0.94 - warm * 0.2, 0.81 - warm * 0.38).lerp(MOON, dark);
      sun.intensity = 3.6 * (0.25 + 0.75 * Math.min(1, height * 2.5 + 0.2)) * light + 0.85 * dark;
      hemisphere.intensity = 0.32 * light + 0.2 * dark;
      ambient.intensity = 0.07 * light + 0.05 * dark;
      zenith.copy(DAY_ZENITH).lerp(NIGHT_ZENITH, dark);
      horizon.copy(DAY_HORIZON).lerp(DUSK_HORIZON, warm * light * 0.7).lerp(NIGHT_HORIZON, dark);
      sunColor.copy(DAY_SUN).lerp(DUSK_SUN, warm).multiplyScalar(light);
      (scene.fog as Fog).color.copy(horizon).lerp(zenith, 0.18);
      scene.environmentIntensity = 0.6 * (0.2 + 0.8 * light);
      return dark;
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
