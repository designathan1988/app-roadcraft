import { Color, ShaderChunk, SRGBColorSpace, TextureLoader, type BufferGeometry, type MeshStandardMaterial, type Texture } from 'three';
import type { PersonSpec } from '@people/spec';
import { loadProxyItem, proxyUrl } from '@people/body/proxy';
import { texturedGarments } from './garmentSlots';
import index from '../../../public/models/people/skins/index.json';
const urls = import.meta.glob('../../../public/models/people/skins/*.webp', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

export interface SkinAppearance { texture: Texture; tint: Color; hair: Color; hairTexture?: Texture; garments: (Texture | null)[]; outfitTint: Color | null; beard: number; makeup: number }

/** Existing CC0 skin pack, selected by the authored body; no new asset downloads. */
export async function loadSkinAppearance(person: PersonSpec): Promise<SkinAppearance> {
  const b = person.body;
  const origin = b.african > b.asian && b.african > b.caucasian ? 'african'
    : b.asian > b.caucasian ? 'asian' : 'caucasian';
  const age = b.age > 0.8 ? 'old' : b.age > 0.6 ? 'middleage' : 'young';
  const sex = b.gender < 0.5 ? 'female' : 'male';
  const candidates = index.skins.filter(s => s.origin === origin && s.sex === sex);
  const skin = candidates.find(s => s.age === age) ?? candidates[0]!;
  const url = urls[`../../../public/models/people/skins/${skin.name}.webp`];
  if (!url) throw new Error(`Missing skin texture: ${skin.name}`);
  const texture = await new TextureLoader().loadAsync(url);
  texture.colorSpace = SRGBColorSpace;
  const average = new Color().setRGB(skin.average[0]! / 255, skin.average[1]! / 255, skin.average[2]! / 255, SRGBColorSpace);
  const desired = new Color(person.look.skin);
  const tint = new Color().setRGB(desired.r / Math.max(0.01, average.r), desired.g / Math.max(0.01, average.g), desired.b / Math.max(0.01, average.b));
  let hairTexture: Texture | undefined;
  const garments = await Promise.all(texturedGarments(person.look).map(async name => {
    if (!name || name === 'none') return null;
    const item = await loadProxyItem(name);
    if (!item.textureFile) return null;
    const map = await new TextureLoader().loadAsync(proxyUrl(item.textureFile));
    map.colorSpace = SRGBColorSpace; map.flipY = false;
    return map;
  }));
  if (person.look.hairCut && person.look.hairCut !== 'none') {
    const hair = await loadProxyItem(person.look.hairCut);
    if (hair.textureFile) {
      hairTexture = await new TextureLoader().loadAsync(proxyUrl(hair.textureFile));
      hairTexture.colorSpace = SRGBColorSpace;
      hairTexture.flipY = false;
    }
  }
  return { texture, tint, hair: new Color(person.look.hair), garments,
    outfitTint: person.look.outfitTint == null ? null : new Color(person.look.outfitTint),
    ...(hairTexture ? { hairTexture } : {}),
    beard: ['none', 'stubble', 'moustache', 'beard'].indexOf(person.look.beard ?? 'none'), makeup: person.look.makeup ?? 0 };
}

/** Extends the crowd shader after its bone-palette hook, preserving one draw batch. */
export function applySkinAppearance(material: MeshStandardMaterial, geometry: BufferGeometry, skin: SkinAppearance): void {
  if (!geometry.hasAttribute('skinMask')) return;
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  const detail = { value: 1 };
  material.userData['appearanceDetail'] = detail;
  const texturedHair = skin.hairTexture && geometry.hasAttribute('hairMask');
  const texturedGarments = geometry.hasAttribute('garmentSlot') && skin.garments.some(Boolean);
  if (texturedHair) { material.alphaToCoverage = true; material.alphaTest = 0.35; }
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.personSkin = { value: skin.texture };
    shader.uniforms.appearanceDetail = detail;
    shader.uniforms.personSkinTint = { value: skin.tint };
    shader.uniforms.faceOrigin = { value: geometry.userData['faceOrigin'] };
    shader.uniforms.faceScale = { value: geometry.userData['faceScale'] ?? 0.2 };
    shader.uniforms.beardColour = { value: skin.hair };
    shader.uniforms.beardStyle = { value: skin.beard };
    shader.uniforms.makeupAmount = { value: skin.makeup };
    if (texturedGarments) {
      shader.uniforms.outfitDye = { value: skin.outfitTint ?? new Color(0xffffff) };
      shader.uniforms.outfitDyed = { value: skin.outfitTint ? 1 : 0 };
      skin.garments.forEach((map, i) => { if (map) shader.uniforms[`garment${i}`] = { value: map }; });
    }
    if (texturedHair) shader.uniforms.personHair = { value: skin.hairTexture };
    shader.vertexShader = `attribute float skinMask; uniform vec3 faceOrigin; uniform float faceScale; varying float vSkinMask; varying vec2 vSkinUv; varying vec3 vFace;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkinMask = skinMask; vSkinUv = uv; vFace = (position - faceOrigin) / faceScale;');
    shader.fragmentShader = `uniform float appearanceDetail; uniform sampler2D personSkin; uniform vec3 personSkinTint; uniform vec3 beardColour; uniform float beardStyle; uniform float makeupAmount; varying float vSkinMask; varying vec2 vSkinUv; varying vec3 vFace;\n${shader.fragmentShader}`
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (appearanceDetail > 0.5 && vSkinMask > 0.0) {
        vec3 skinColour = texture2D(personSkin, vSkinUv).rgb * personSkinTint;
        float front = smoothstep(-0.12, 0.02, vFace.z);
        float lips = (1.0 - smoothstep(0.65, 1.0, length(vFace.xy / vec2(0.22, 0.045)))) * front;
        float cheeks = exp(-30.0 * (pow(abs(vFace.x) - 0.32, 2.0) + pow(vFace.y - 0.18, 2.0))) * front;
        skinColour = mix(skinColour, skinColour * vec3(1.05, 0.55, 0.6), makeupAmount * max(lips, cheeks * 0.25));
        // Beards are fitted MakeHuman items now (wornItems), not paint: a
        // painted stubble region missed the jaw and lay across the nose as a
        // dark mask.
        diffuseColor.rgb = mix(diffuseColor.rgb, skinColour, vSkinMask);
        }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.5, vSkinMask * appearanceDetail);');
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>',
      ShaderChunk.lights_physical_pars_fragment.replace(
        'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );',
        'reflectedLight.directDiffuse += mix(irradiance, saturate((dot(geometryNormal, directLight.direction) + 0.15) / 1.15) * directLight.color, vSkinMask * appearanceDetail) * BRDF_Lambert(material.diffuseColor);'));
    if (texturedHair) {
      shader.vertexShader = `attribute float hairMask; varying float vHairMask;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHairMask = hairMask;');
      shader.fragmentShader = `uniform sampler2D personHair; varying float vHairMask;\n${shader.fragmentShader}`
        .replace('#include <alphatest_fragment>', `
          vec4 hairTexel = texture2D(personHair, vSkinUv);
          diffuseColor.rgb = mix(diffuseColor.rgb, hairTexel.rgb * beardColour * 1.7, vHairMask * appearanceDetail);
          diffuseColor.a *= mix(1.0, hairTexel.a, vHairMask);
          #include <alphatest_fragment>`);
    }
    if (texturedGarments) {
      shader.vertexShader = `attribute float garmentSlot; varying float vGarmentSlot;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGarmentSlot = garmentSlot;');
      const uniforms = skin.garments.map((map, i) => map ? `uniform sampler2D garment${i};` : '').join('\n');
      shader.fragmentShader = `uniform vec3 outfitDye; uniform float outfitDyed; varying float vGarmentSlot; ${uniforms}\n${shader.fragmentShader}`;
      const sample = skin.garments.map((map, i) => !map ? '' : `
        if (appearanceDetail > 0.5 && abs(vGarmentSlot - ${i + 1}.0) < 0.1) {
          vec3 cloth = texture2D(garment${i}, vSkinUv).rgb;
          ${i === 0 ? 'float shade = 0.3 + 1.15 * dot(cloth, vec3(0.3, 0.59, 0.11)); cloth = mix(cloth, min(vec3(1.0), outfitDye * shade), outfitDyed * 0.8);' : ''}
          diffuseColor.rgb = cloth;
        }`).join('\n');
      shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `${sample}\n#include <alphatest_fragment>`);
    }
  };
  material.customProgramCacheKey = () => `${key}-textured-skin-hair${Boolean(texturedHair)}-garments${texturedGarments ? skin.garments.map(Boolean).join('') : ''}`;
}
