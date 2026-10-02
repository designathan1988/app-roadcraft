import type { BufferGeometry, Camera, Light, Mesh, Object3D, Scene, Texture, WebGLRenderTarget, WebGLRenderer } from 'three';

/**
 * Textures waiting to be sent to the GPU ahead of their first use.
 *
 * three.js uploads a texture the first time something using it is drawn, in
 * that frame: each new kind of person brought its skin, its garments and its
 * hair, and the frame it walked into view stalled on their upload. Loaders
 * queue what they make here; the renderer sends one a frame
 * (`renderer.initTexture`) before anybody needs it.
 */
const queue: Texture[] = [];
const sent = new WeakSet<Texture>();

export function queueUpload(...textures: (Texture | null | undefined)[]): void {
  for (const t of textures) if (t && !sent.has(t)) queue.push(t);
}

/** Sends queued textures to the GPU, at most `count` this frame. */
export function drainUploads(renderer: WebGLRenderer, count = 1): void {
  for (let i = 0; i < count && queue.length; i++) {
    const t = queue.shift()!;
    if (sent.has(t)) continue;
    sent.add(t);
    renderer.initTexture(t);
  }
}

/**
 * Objects whose shaders must be compiled before they are first drawn: a
 * loader awaits `compileAhead` before handing an object to the frame, and
 * the renderer compiles each in parallel (`compileAsync`). Drawn first, a new
 * shader stopped that frame for as long as the driver took to build it.
 */
const toCompile: { object: Object3D; done: () => void }[] = [];
/** Whether a renderer is answering (none in tests: nothing is waited for there). */
let compiler = false;

export function compileAhead(object: Object3D): Promise<void> {
  if (!compiler) return Promise.resolve();
  return new Promise((done) => toCompile.push({ object, done }));
}

/** Starts compiling what is waiting; each promise settles when its shaders are ready. */
export function drainCompiles(renderer: WebGLRenderer, camera: Camera, scene: Scene, target: WebGLRenderTarget | null): void {
  compiler = true;
  if (!toCompile.length) return;
  // For the target the scene is really drawn into: its colour space and tone
  // mapping are part of every program. Compiled for the screen, the wrong
  // programs were built and the right one still stalled the first frame.
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  while (toCompile.length) {
    const { object, done } = toCompile.shift()!;
    renderer.compileAsync(object, camera, scene).then(done, done);
  }
  renderer.setRenderTarget(previous);
}

/**
 * Meshes whose geometry must be on the GPU before they are first drawn.
 *
 * three.js sends a geometry's buffers (`WebGLObjects.update`) and builds its
 * morph target texture (`WebGLMorphtargets.update`) the first time the mesh
 * is drawn, in that frame; `compile` builds programs only. A new kind of
 * person walking into view stopped that frame on its body's upload. As the
 * three.js community does it ("render all the different meshes once", one a
 * frame to spread the cost: discourse.threejs.org/t/64940, /t/15549), each
 * waiting mesh is drawn once after the frame, alone - on a layer of its own,
 * into the target the scene is drawn into, under the scene's own lights, so
 * that the program used is the one already built for it - with no instance:
 * the buffers go up, nothing is drawn.
 */
const WARM_LAYER = 31;
const toWarm: { mesh: Mesh; geometries: readonly BufferGeometry[]; done: () => void }[] = [];
let warmer = false;
const lightsOf = new WeakMap<Scene, Light[]>();
export function warmAhead(mesh: Mesh, geometries: readonly BufferGeometry[]): Promise<void> {
  if (!warmer) return Promise.resolve();
  return new Promise((done) => toWarm.push({ mesh, geometries, done }));
}
/** Sends one waiting mesh's geometry to the GPU, after the frame (`renderer.ts`). */
export function drainWarm(renderer: WebGLRenderer, camera: Camera, scene: Scene, target: WebGLRenderTarget | null): void {
  warmer = true;
  const job = toWarm.shift();
  if (!job) return;
  const { mesh, geometries, done } = job;
  let lights = lightsOf.get(scene);
  if (!lights) {
    lights = [];
    scene.traverse((o) => { if ((o as Light).isLight) lights!.push(o as Light); });
    lightsOf.set(scene, lights);
  }
  const mask = camera.layers.mask;
  const visible = mesh.visible;
  const original = mesh.geometry;
  const previous = renderer.getRenderTarget();
  const autoClear = renderer.autoClear;
  // The world's matrices were brought up to date by the frame just drawn.
  const autoUpdate = scene.matrixWorldAutoUpdate;
  try {
    scene.matrixWorldAutoUpdate = false;
    for (const light of lights) light.layers.enable(WARM_LAYER);
    mesh.layers.enable(WARM_LAYER);
    mesh.visible = true;
    camera.layers.set(WARM_LAYER);
    renderer.setRenderTarget(target);
    // The frame in the target has been shown already; nothing is cleared.
    renderer.autoClear = false;
    for (const geometry of geometries) {
      mesh.geometry = geometry;
      renderer.render(scene, camera);
    }
  } finally {
    mesh.geometry = original;
    mesh.visible = visible;
    mesh.layers.disable(WARM_LAYER);
    for (const light of lights) light.layers.disable(WARM_LAYER);
    camera.layers.mask = mask;
    renderer.autoClear = autoClear;
    scene.matrixWorldAutoUpdate = autoUpdate;
    renderer.setRenderTarget(previous);
    done();
  }
}
