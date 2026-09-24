import { Vector2, type Camera, type Object3D, type Scene, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import type { QualityLevel, QualitySettings } from './quality';

/**
 * The post chain: ambient occlusion, then anti-aliasing, then tone mapping.
 *
 * ## Why ambient occlusion earns its cost here
 *
 * Nearly every contact in this scene is a flat surface meeting another flat
 * surface at a small height difference — asphalt to kerb, kerb to footway,
 * footway to verge, a pier standing on the ground, a deck over a road. Direct
 * light cannot describe any of those: the two surfaces face the same way, so
 * they take the same amount of sun and the edge between them vanishes. Ground
 * truth ambient occlusion darkens exactly those creases, and it is the single
 * change that makes the road read as built into the ground rather than printed
 * on it.
 *
 * ## Why SMAA rather than MSAA
 *
 * The composer renders into a float target, where the driver's own multisample
 * resolve is not available in WebGL2 for every format. SMAA runs on the resolved
 * image, costs one pass, and — unlike FXAA — keeps the thin bright lines of lane
 * markings sharp instead of smearing them.
 *
 * At the lowest quality tier the composer is skipped entirely and the scene is
 * drawn straight to the canvas with the driver's own MSAA, which is what keeps a
 * weak GPU playable.
 */

export interface PostChain {
  readonly enabled: boolean;
  render(delta: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  dispose(): void;
}

/** Objects the ambient-occlusion pass leaves out (see `createPostChain`). */
const AO_SKIPPED = ['rigged-citizens', 'grass'];

export function createPostChain(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  quality: QualitySettings,
  level: QualityLevel,
): PostChain {
  if (!quality.postProcessing) {
    return {
      enabled: false,
      render() {
        renderer.render(scene, camera);
      },
      setSize() {
        /* the renderer's own resize is enough */
      },
      dispose() {
        /* nothing owned */
      },
    };
  }

  const size = renderer.getSize(new Vector2());
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);
  composer.addPass(new RenderPass(scene, camera));

  let gtao: GTAOPass | null = null;
  if (quality.ambientOcclusion) {
    gtao = new GTAOPass(scene, camera, size.x, size.y);
    gtao.output = GTAOPass.OUTPUT.Default;
    // Tuned for world units where a kerb is 0.2 high and a pier is 15 tall: the
    // radius has to reach across a kerb without swallowing a whole junction.
    gtao.updateGtaoMaterial({
      radius: level === 'ultra' ? 6 : 4,
      distanceExponent: 1.4,
      thickness: 2.2,
      scale: 1.05,
      samples: level === 'ultra' ? 16 : 8,
      screenSpaceRadius: false,
    });
    gtao.blendIntensity = 0.85;
    // The occlusion pass draws the scene again, every mesh with one override
    // material. That material knows nothing of the citizens' baked skinning
    // (`riggedCitizens.ts`), so they went into it in their bind pose, and the
    // grass tufts are too small to occlude anything: a third of that pass's
    // draw calls for depth that was wrong or worthless. Both sit it out.
    const pass = gtao;
    const draw = pass.render.bind(pass);
    const skipped: Object3D[] = [];
    pass.render = (...args: Parameters<GTAOPass['render']>) => {
      skipped.length = 0;
      for (const name of AO_SKIPPED) {
        const object = scene.getObjectByName(name);
        if (object?.visible) {
          object.visible = false;
          skipped.push(object);
        }
      }
      try {
        draw(...args);
      } finally {
        for (const object of skipped) object.visible = true;
      }
    };
    composer.addPass(gtao);
  }

  if (quality.smaa) composer.addPass(new SMAAPass());
  composer.addPass(new OutputPass());

  return {
    enabled: true,
    render(delta) {
      composer.render(delta);
    },
    setSize(width, height, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      gtao?.setSize(width, height);
    },
    dispose() {
      composer.dispose();
      gtao?.dispose();
    },
  };
}
