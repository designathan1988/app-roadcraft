import type { Camera, Object3D, Scene, Texture, WebGLRenderTarget, WebGLRenderer } from 'three';

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
