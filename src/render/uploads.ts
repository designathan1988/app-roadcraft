import type { Texture, WebGLRenderer } from 'three';

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
