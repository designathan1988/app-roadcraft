import {
  AmbientLight, Box3, Color, DirectionalLight, HemisphereLight, OrthographicCamera, Scene, SRGBColorSpace,
  Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CITIZEN_ASSET_URLS } from '@render/citizenAssets';

/**
 * THE CONTACT SHEET: every citizen model of the roster, front and profile,
 * with its id, for classifying the roster BY EYE (`citizens.manifest.json`).
 * A development harness module, loaded into the page by
 * `scripts/contact-sheet.mjs`; nothing in the game imports it.
 */
export async function contactSheet(ids: readonly string[] = Object.keys(CITIZEN_ASSET_URLS).sort(), columns = 8):
  Promise<string> {
  const tileW = 220;
  const tileH = 330;
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setSize(tileW, tileH, false);
  const loader = new GLTFLoader();
  const sheet = document.createElement('canvas');
  const rows = Math.ceil(ids.length / columns);
  sheet.width = columns * tileW * 2;
  sheet.height = rows * (tileH + 22);
  const g = sheet.getContext('2d')!;
  g.fillStyle = '#d9dde2';
  g.fillRect(0, 0, sheet.width, sheet.height);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const url = CITIZEN_ASSET_URLS[id];
    if (!url) continue;
    const gltf = await loader.loadAsync(url);
    const scene = new Scene();
    scene.background = new Color(0xeef0f3);
    scene.add(new HemisphereLight(0xffffff, 0x8a8a80, 1.6), new AmbientLight(0xffffff, 0.4));
    const sun = new DirectionalLight(0xffffff, 2.2);
    sun.position.set(2, 4, 5);
    scene.add(sun);
    scene.add(gltf.scene);
    gltf.scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(gltf.scene);
    const size = box.getSize(new Vector3());
    const centre = box.getCenter(new Vector3());
    const half = Math.max(size.y, size.x * tileH / tileW) / 2 * 1.04;
    const camera = new OrthographicCamera(-half * tileW / tileH, half * tileW / tileH, half, -half, 0.01, 50);
    const col = i % columns;
    const row = Math.floor(i / columns);
    for (const [k, angle] of [[0, 0], [1, Math.PI / 2]] as const) {
      camera.position.set(centre.x + Math.sin(angle) * 10, centre.y, centre.z + Math.cos(angle) * 10);
      camera.lookAt(centre);
      renderer.render(scene, camera);
      g.drawImage(renderer.domElement, (col * 2 + k) * tileW, row * (tileH + 22));
    }
    g.fillStyle = '#111';
    g.font = '600 15px Consolas, monospace';
    g.fillText(`${i + 1}. ${id}`, col * 2 * tileW + 6, row * (tileH + 22) + tileH + 16);
    scene.clear();
  }
  renderer.dispose();
  return sheet.toDataURL('image/jpeg', 0.9);
}
