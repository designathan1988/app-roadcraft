import {
  CircleGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';

import { loadPeopleAssets, type PeopleAssets } from '@people/body/assets';
import { Morpher, bodyHeight } from '@people/body/morph';
import type { PersonLook, PersonSpec } from '@people/spec';
import { createPersonMesh, type PersonMesh } from './personMesh';

/**
 * The Person Creator's 3D preview: one person on a small stage, turned by
 * dragging, looked at closer with the wheel. Its own renderer, drawn only
 * when something changed. The MakeHuman packs load the first time it opens.
 */
export interface PersonPreview {
  /** Opens or closes it; the packs start loading on the first open. */
  setActive(active: boolean): void;
  /** Resolves once the person model is loaded; rejects when it cannot be. */
  readonly ready: Promise<void>;
  /** A new body and look. */
  show(person: PersonSpec): void;
  /** A new look only: clothes, hair, colours. */
  setLook(look: PersonLook): void;
  /** Turns the figure, radians. */
  turn(delta: number): void;
  /** Closer (positive) or further, in steps of the wheel. */
  zoom(delta: number): void;
  /** Standing height of the person shown, metres, once loaded. */
  readonly height: number;
}

export function createPersonPreview(canvas: HTMLCanvasElement): PersonPreview {
  let assets: PeopleAssets | null = null;
  let morpher: Morpher | null = null;
  let body: PersonMesh | null = null;
  let renderer: WebGLRenderer | null = null;
  let active = false;
  let pending: PersonSpec | null = null;
  let height = 0;

  const scene = new Scene();
  scene.background = new Color(0x1d2a2c);
  const camera = new PerspectiveCamera(26, 1, 0.05, 50);
  scene.add(new HemisphereLight(0xdfe9f2, 0x3a3226, 1.15));
  const sun = new DirectionalLight(0xffffff, 2.1);
  sun.position.set(1.6, 3.2, 2.4);
  scene.add(sun);
  const rim = new DirectionalLight(0x9fc7ff, 0.6);
  rim.position.set(-2, 1.5, -2.5);
  scene.add(rim);
  const floor = new Mesh(new CircleGeometry(0.75, 48), new MeshStandardMaterial({ color: 0x2c3b3d, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  let yaw = 0.35;
  let closeness = 0; // 0: the whole body, 1: the face.

  let drawQueued = false;
  const draw = (): void => {
    drawQueued = false;
    if (!renderer || !body || !active) return;
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    const ratio = renderer.getPixelRatio();
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const tall = Math.max(0.5, height);
    const focusY = tall * (0.52 + closeness * 0.42);
    const span = tall * (1 - closeness * 0.84);
    const distance = (span / (2 * Math.tan((camera.fov * Math.PI) / 360))) * 1.12 / Math.min(1, camera.aspect * 1.4);
    camera.position.set(Math.sin(yaw) * distance, focusY + span * 0.04, Math.cos(yaw) * distance);
    camera.lookAt(0, focusY, 0);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };
  const requestDraw = (): void => {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(draw);
  };

  let resolveReady: () => void = () => {};
  let rejectReady: (e: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A rejection nobody awaits is still reported, never thrown at boot.
  ready.catch(() => {});

  const reshape = (person: PersonSpec): void => {
    if (!morpher || !body || !assets) {
      pending = person;
      return;
    }
    const positions = morpher.shape(person.body, person.features);
    body.setShape(positions);
    body.setLook(person.look);
    height = bodyHeight(positions, assets.bodyRange) / 10;
    requestDraw();
  };

  return {
    ready,
    setActive(on) {
      active = on;
      if (!on) return;
      if (!renderer) {
        renderer = new WebGLRenderer({ canvas, antialias: true });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        renderer.outputColorSpace = SRGBColorSpace;
        // The hems of the clothes are clipping planes (`personMesh.ts`).
        renderer.localClippingEnabled = true;
        void loadPeopleAssets().then((loaded) => {
          assets = loaded;
          morpher = new Morpher(loaded.packs);
          const first = pending;
          if (!first) return;
          const positions = morpher.shape(first.body, first.features);
          body = createPersonMesh(loaded.mesh, loaded.bodyRange, positions, first.look);
          scene.add(body.mesh);
          reshape(first);
          resolveReady();
        }).catch((e: unknown) => rejectReady(e));
      }
      requestDraw();
    },
    show(person) {
      pending = person;
      reshape(person);
    },
    setLook(look) {
      if (pending) pending = { ...pending, look };
      body?.setLook(look);
      requestDraw();
    },
    turn(delta) {
      yaw += delta;
      requestDraw();
    },
    zoom(delta) {
      closeness = Math.min(1, Math.max(0, closeness + delta * 0.12));
      requestDraw();
    },
    get height() {
      return height;
    },
  };
}
