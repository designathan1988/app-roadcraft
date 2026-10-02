import {
  AmbientLight, Box3, Color, DirectionalLight, HemisphereLight, OrthographicCamera, Scene, SRGBColorSpace,
  Vector3, WebGLRenderer, MeshStandardMaterial, InstancedMesh, Matrix4,
} from 'three';
import { CROWD } from '@render/citizenCasting';
import { loadPeopleAssets } from '@people/body/assets';
import { Morpher } from '@people/body/morph';
import { loadProxyItem, type ProxyItem } from '@people/body/proxy';
import { wornItems } from '@people/spec';
import { captureBind, captureBindRotations } from '@render/citizenWalk';
import { createPersonRig } from '@render/people/personRig';
import { applySkinAppearance, loadSkinAppearance, type SkinAppearance } from '@render/people/skinAppearance';
import { attachFacialMorphs } from '@render/people/facialMorphs';
import { expressionShapes } from '@people/body/expressions';
import { RIDER_CLIPS } from '@render/riderPoses';

/** The live MakeHuman roster, front and profile, with stable requested ids. */
export async function contactSheet(ids: readonly string[] = CROWD.map(p => p.id), columns = 8, portraits = false): Promise<string> {

  const tileW = 220, tileH = 330;
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setSize(tileW, tileH, false);
  const sheet = document.createElement('canvas');
  sheet.width = columns * tileW * 2;
  sheet.height = Math.ceil(ids.length / columns) * (tileH + 22);
  const g = sheet.getContext('2d')!;
  g.fillStyle = '#d9dde2';
  g.fillRect(0, 0, sheet.width, sheet.height);
  const proxies = new Map<string, ProxyItem>();
  try {
    const assets = await loadPeopleAssets();
    const morpher = new Morpher(assets.packs);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const person = CROWD.find(p => p.id === id)?.person;
      if (!person) throw new Error(`Unknown contact-sheet person: ${id}`);
      for (const name of wornItems(person.look)) {
        if (!proxies.has(name)) proxies.set(name, await loadProxyItem(name));
      }
      const sex = person.body.gender >= 0.5 ? 'male' : 'female';
      const input = {
        data: assets.mesh, skeleton: assets.skeleton, bodyRange: assets.bodyRange,
        positions: morpher.shape(person.body, person.features), look: person.look, proxies,
        capture: captureBind(sex), captureAxes: captureBindRotations(sex), texturedSkin: true,
      };
      const rig = createPersonRig(input);
      // ?pose=<rider clip key>: the person in a seated (or riding) pose, to
      // check what a pose does to the body (e.g. the face in a driver's seat).
      const pose = new URLSearchParams(location.search).get('pose');
      if (pose) RIDER_CLIPS.find(c => c.key === pose)?.pose(rig.scene, Number(new URLSearchParams(location.search).get('poseTime') ?? 0));
      const expression = new URLSearchParams(location.search).get('expression');
      if (new URLSearchParams(location.search).get('expressions') === 'live') {
        await attachFacialMorphs(input, rig, await expressionShapes(person.body));
        if (expression && rig.mesh.morphTargetDictionary?.[expression] !== undefined) {
          rig.mesh.morphTargetInfluences![rig.mesh.morphTargetDictionary[expression]!] = 1;
        }
      }
      let skin: SkinAppearance | null = null;
      try {
        skin = await loadSkinAppearance(person);
        if (skin) applySkinAppearance(rig.mesh.material as MeshStandardMaterial, rig.mesh.geometry, skin);
        const scene = new Scene();
        scene.background = new Color(0xeef0f3);
        scene.add(new HemisphereLight(0xffffff, 0x8a8a80, 1.6), new AmbientLight(0xffffff, 0.4));
        const sun = new DirectionalLight(0xffffff, 2.2);
        sun.position.set(2, 4, 5);
        scene.add(sun, rig.scene);
        rig.scene.updateMatrixWorld(true);
        const box = new Box3().setFromObject(rig.scene);
        const size = box.getSize(new Vector3()), centre = box.getCenter(new Vector3());
        const half = portraits ? Math.max(0.16, size.y * 0.16) : Math.max(size.y, size.x * tileH / tileW) / 2 * 1.04;
        if (portraits) centre.y = box.max.y - size.y * 0.115;
        const camera = new OrthographicCamera(-half * tileW / tileH, half * tileW / tileH, half, -half, 0.01, 50);
        if (i === 0 && new URLSearchParams(location.search).get('benchmark') === '300') {
          const crowd = new InstancedMesh(rig.mesh.geometry, rig.mesh.material, 300);
          const matrix = new Matrix4();
          for (let n = 0; n < 300; n++) crowd.setMatrixAt(n, matrix.makeTranslation((n % 20) * 0.6, 0, Math.floor(n / 20) * 0.8));
          const wide = new OrthographicCamera(-9, 9, 7, -7, 0.01, 100);
          wide.position.set(6, 18, 19); wide.lookAt(6, 0, 6);
          const update: number[] = [], draw: number[] = [];
          rig.scene.visible = false; scene.add(crowd);
          for (let frame = 0; frame < 65; frame++) {
            const start = performance.now();
            for (let n = 0; n < 300; n++) {
              rig.mesh.morphTargetInfluences!.fill(0);
              rig.mesh.morphTargetInfluences![rig.mesh.morphTargetDictionary!['eyeBlinkLeft']!] = Math.max(0, Math.sin(frame * 0.7 + n));
              crowd.setMorphAt(n, rig.mesh);
            }
            crowd.morphTexture!.needsUpdate = true;
            const ready = performance.now();
            renderer.render(scene, wide); renderer.getContext().finish();
            if (frame >= 5) { update.push(ready - start); draw.push(performance.now() - ready); }
            await new Promise<void>(resolve => setTimeout(resolve, 0));
          }
          const p95 = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length * 0.95)]!;
          console.log('EXPRESSION_BENCHMARK ' + JSON.stringify({ people: 300, frames: update.length,
            weightsP95Ms: p95(update), drawSubmissionP95Ms: p95(draw), drawCalls: renderer.info.render.calls,
            triangles: renderer.info.render.triangles, morphCount: rig.mesh.morphTargetInfluences!.length }));
          crowd.dispose(); scene.remove(crowd); rig.scene.visible = true;
          rig.mesh.morphTargetInfluences!.fill(0);
        }
        const col = i % columns, row = Math.floor(i / columns);
        for (const [k, angle] of [[0, 0], [1, Math.PI / 2]] as const) {
          camera.position.set(centre.x + Math.sin(angle) * 10, centre.y, centre.z + Math.cos(angle) * 10);
          camera.lookAt(centre);
          renderer.render(scene, camera);
          g.drawImage(renderer.domElement, (col * 2 + k) * tileW, row * (tileH + 22));
        }
        g.fillStyle = '#111';
        g.font = '600 15px Consolas, monospace';
        g.fillText(`${i + 1}. ${id} · natural`, col * 2 * tileW + 6, row * (tileH + 22) + tileH + 16);
        scene.clear();
      } finally {
        skin?.texture.dispose();
        skin?.hairTexture?.dispose();
        skin?.garments.forEach(map => map?.dispose());
        rig.mesh.geometry.dispose();
        rig.mesh.skeleton.dispose();
        for (const material of Array.isArray(rig.mesh.material) ? rig.mesh.material : [rig.mesh.material]) material.dispose();
      }
    }
    return sheet.toDataURL('image/jpeg', 0.9);
  } finally {
    renderer.dispose();
  }
}
