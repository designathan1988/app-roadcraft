/* global window, document, atob, btoa, requestAnimationFrame */
/** Convert one pinned Rocketbox source with retargeted Quaternius clips.
 * Working files and motion contact-sheet frames are written to the temp cache.
 * Run fetch-citizens.py first. No city state is read or modified.
 */

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
const base=path.join(process.env.TEMP,'roadcraft-rocketbox');
function findAnimation(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === 'UAL1_Standard.glb') return filename;
    if (entry.isDirectory()) { const found = findAnimation(filename); if (found) return found; }
  }
}
const animationSource = process.env.ROADCRAFT_ANIMATION_SOURCE ?? findAnimation(
  path.join(process.env.TEMP, 'roadcraft-human-assets', 'universal-animation-library'));
if (!animationSource) throw new Error('Set ROADCRAFT_ANIMATION_SOURCE to the licensed UAL1_Standard.glb');
const name=process.argv[2];
if (!name) throw new Error('Usage: node scripts/convert-citizens.mjs Source_Avatar_Name');
const data=fs.readFileSync(path.join(base,name,name+'.fbx')).toString('base64');
const textures=Object.fromEntries(fs.readdirSync(path.join(base,name)).filter(f=>f.endsWith('.png')).map(f=>[f.toLowerCase().replace('.png','.tga'),'data:image/png;base64,'+fs.readFileSync(path.join(base,name,f)).toString('base64')]));
const installedChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executablePath = process.env.CHROME_PATH ?? (fs.existsSync(installedChrome) ? installedChrome : undefined);
const browser=await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless:true });
const page=await browser.newPage({viewport:{width:1200,height:900}});
page.on('pageerror',e=>console.log('ERROR',e.message));
page.on('console',e=>{if(e.type()==='error'||e.type()==='warning')console.log(e.text().slice(0,500));});
await page.route('**/__pedestrian-review',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
await page.route('**/__citizen-motion.glb', route => route.fulfill({
  contentType: 'model/gltf-binary', body: fs.readFileSync(animationSource),
}));
await page.goto(`${process.env.ROADCRAFT_ASSET_DEV_URL ?? 'http://127.0.0.1:5198'}/__pedestrian-review`);
const info=await page.evaluate(async({data,textures})=>{
 const T=await import('/node_modules/.vite/deps/three.js');
 const {FBXLoader}=await import('/node_modules/three/examples/jsm/loaders/FBXLoader.js');
 const manager=new T.LoadingManager();
 const textureReady = new Promise(resolve => { manager.onLoad = resolve; });
 const pixel = document.createElement('canvas'); pixel.width = 1; pixel.height = 1;
 const context = pixel.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, 1, 1);
 const placeholder = pixel.toDataURL();
 const missingColour = [];
 manager.addHandler(/\.tga$/i,new T.TextureLoader(manager));
 manager.setURLModifier(url => {
   if (url.startsWith('data:') || url.startsWith('blob:')) return url;
   const filename = url.split(/[\\/]/).pop().toLowerCase();
   if (!textures[filename] && filename.includes('_color')) missingColour.push(filename);
   return textures[filename] ?? placeholder;
 });
 const rig=new FBXLoader(manager).parse(Uint8Array.from(atob(data),c=>c.charCodeAt(0)).buffer,'');
 await textureReady;
 if (missingColour.length) throw new Error(`Missing colour textures: ${missingColour.join(', ')}`);
 rig.traverse(object => { object.name = object.name.replace(/^Bip\d+/, 'Bip01'); });
 const lights=[];rig.traverse(o=>{if(o.isLight||o.isCamera)lights.push(o)});lights.forEach(o=>o.removeFromParent());
 const meshes=[];rig.traverse(o=>{if(o.isMesh){meshes.push({name:o.name,type:o.type,count:o.geometry.attributes.position.count,materials:(Array.isArray(o.material)?o.material:[o.material]).map(m=>m.name),bones:o.skeleton?.bones.map(b=>b.name)});o.material=(Array.isArray(o.material)?o.material:[o.material]).map(m=>new T.MeshStandardMaterial({map:m.map,color:0xffffff,roughness:.9,side:T.FrontSide,alphaTest:.4}));}});
 document.body.innerHTML='';
 const renderer=new T.WebGLRenderer({antialias:true});renderer.setSize(1200,900);renderer.setClearColor(0x9da6ad);renderer.toneMapping=T.ACESFilmicToneMapping;document.body.append(renderer.domElement);
 const scene=new T.Scene();scene.add(rig);const box=new T.Box3().setFromObject(rig);const size=box.getSize(new T.Vector3());const centre=box.getCenter(new T.Vector3());const camera=new T.PerspectiveCamera(32,1200/900,.01,10000);camera.position.copy(centre).add(new T.Vector3(size.y*.6,size.y*.1,size.y*2));camera.lookAt(centre);scene.add(new T.HemisphereLight(0xffffff,0x66686b,2));const light=new T.DirectionalLight(0xffeadc,2);light.position.copy(centre).add(new T.Vector3(200,400,300));scene.add(light);

 const {GLTFLoader}=await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
 const library=await new GLTFLoader().loadAsync('/__citizen-motion.glb');
 const wanted = new Set(['Idle_Loop', 'Idle_Talking_Loop', 'Walk_Loop', 'Walk_Formal_Loop',
   'Jog_Fwd_Loop', 'Driving_Loop', 'Sitting_Idle_Loop', 'Sitting_Talking_Loop']);
 library.animations = library.animations.filter(clip => wanted.has(clip.name));
 const source=library.scene;
 source.updateMatrixWorld(true);rig.updateMatrixWorld(true);
 const names={Bip01_Pelvis:'pelvis',Bip01_Spine:'spine_01',Bip01_Spine1:'spine_02',Bip01_Spine2:'spine_03',Bip01_Neck:'neck_01',Bip01_Head:'Head'};
 for(const [side,letter] of [['L','l'],['R','r']])for(const [target,origin]of Object.entries({Clavicle:'clavicle',UpperArm:'upperarm',Forearm:'lowerarm',Hand:'hand',Thigh:'thigh',Calf:'calf',Foot:'foot',Toe0:'ball'}))names['Bip01_'+side+'_'+target]=origin+'_'+letter;
 const children={pelvis:'spine_01',spine_01:'spine_02',spine_02:'spine_03',spine_03:'neck_01',neck_01:'Head'};
 for(const side of ['l','r'])for(const [a,b]of Object.entries({upperarm:'lowerarm',lowerarm:'hand',thigh:'calf',calf:'foot',foot:'ball',clavicle:'upperarm'}))children[a+'_'+side]=b+'_'+side;
 const reverse=Object.fromEntries(Object.entries(names).map(([a,b])=>[b,a]));
for(const [side,letter]of [['L','l'],['R','r']])for(const [digit,label]of [['0','thumb'],['1','index'],['2','middle'],['3','ring'],['4','pinky']])for(let joint=0;joint<3;joint++){names['Bip01_'+side+'_Finger'+digit+(joint===0?'':joint)]=label+'_0'+(joint+1)+'_'+letter;}
 children.hand_l='middle_01_l';children.hand_r='middle_01_r';
 for(const side of ['l','r'])for(const label of ['thumb','index','middle','ring','pinky'])for(let i=1;i<3;i++)children[label+'_0'+i+'_'+side]=label+'_0'+(i+1)+'_'+side;
 Object.assign(reverse,Object.fromEntries(Object.entries(names).map(([a,b])=>[b,a])));
 const links=[];
 rig.traverse(b=>{const src=source.getObjectByName(names[b.name]);if(!src)return;const childName=children[names[b.name]],sc=source.getObjectByName(childName),tc=rig.getObjectByName(reverse[childName]);
const align=new T.Quaternion();
if(sc&&tc){const sd=sc.getWorldPosition(new T.Vector3()).sub(src.getWorldPosition(new T.Vector3())).normalize();const td=tc.getWorldPosition(new T.Vector3()).sub(b.getWorldPosition(new T.Vector3())).normalize();align.setFromUnitVectors(td,sd);}
if(names[b.name]==='hand_l'||names[b.name]==='hand_r'){
 const side=names[b.name].slice(-1);
 const basis=(parent,mid,index,pinky)=>{
 const x=mid.getWorldPosition(new T.Vector3()).sub(parent.getWorldPosition(new T.Vector3())).normalize();
 const spread=index.getWorldPosition(new T.Vector3()).sub(pinky.getWorldPosition(new T.Vector3())).normalize();
 const z=new T.Vector3().crossVectors(x,spread).normalize();const y=new T.Vector3().crossVectors(z,x).normalize();
 return new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(x,y,z));};
 const sq=basis(src,source.getObjectByName('middle_01_'+side),source.getObjectByName('index_01_'+side),source.getObjectByName('pinky_01_'+side));
 const tq=basis(b,rig.getObjectByName(reverse['middle_01_'+side]),rig.getObjectByName(reverse['index_01_'+side]),rig.getObjectByName(reverse['pinky_01_'+side]));
 align.copy(sq).multiply(tq.invert());
}
links.push({b,src,rest:b.quaternion.clone(),correction:src.getWorldQuaternion(new T.Quaternion()).invert().multiply(align).multiply(b.getWorldQuaternion(new T.Quaternion()))});});
 const mixer=new T.AnimationMixer(source);mixer.clipAction(library.animations.find(c=>c.name==='Walk_Loop')).play();
 const root=rig.getObjectByName('Bip01'),rootY=root.position.y;
 const pelvis=source.getObjectByName('pelvis'),restHip=pelvis.getWorldPosition(new T.Vector3());
 window.animateAt=time=>{
   mixer.setTime(time);source.updateMatrixWorld(true);
   const hip=pelvis.getWorldPosition(new T.Vector3());root.position.y=rootY+(hip.y-restHip.y)*(rootY/restHip.y);rig.updateMatrixWorld(true);
   for(const {b,src,correction,rest} of links){const q=src.getWorldQuaternion(new T.Quaternion()).multiply(correction);b.quaternion.copy(b.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(q));if(b.name.includes('Finger'))b.quaternion.slerp(rest,.55);b.updateMatrixWorld(true);}
   rig.updateMatrixWorld(true);
 };
 window.animateAt(.15);


 const {GLTFExporter}=await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
 const output=[];
 for(const clip of library.animations){
  mixer.stopAllAction();mixer.clipAction(clip).play();
  const frames=Math.ceil(clip.duration*30),times=[],positions=[],rotations=links.map(()=>[]);
  for(let i=0;i<=frames;i++){
    const t=i*clip.duration/frames;window.animateAt(t);times.push(t);root.position.toArray(positions,positions.length);
    links.forEach(({b},j)=>b.quaternion.toArray(rotations[j],rotations[j].length));
  }
  const tracks=[new T.VectorKeyframeTrack(root.name+'.position',times,positions)];
  links.forEach(({b},j)=>tracks.push(new T.QuaternionKeyframeTrack(b.name+'.quaternion',times,rotations[j])));
  output.push(new T.AnimationClip(clip.name,clip.duration,tracks));
 }
 mixer.stopAllAction();
 rig.scale.setScalar(.01);rig.updateMatrixWorld(true);
 const binary=await new GLTFExporter().parseAsync(rig,{binary:true,animations:output});
 const bytes=new Uint8Array(binary);let encoded='';for(let start=0;start<bytes.length;start+=32768)encoded+=String.fromCharCode(...bytes.subarray(start,start+32768));window.exported=btoa(encoded);
 rig.scale.setScalar(1);mixer.clipAction(library.animations.find(c=>c.name==='Walk_Loop')).play();window.animateAt(.4);

 window.rig=rig;window.scene=scene;window.camera=camera;window.renderer=renderer;
 function draw(){renderer.render(scene,camera);requestAnimationFrame(draw);}draw();
 return {meshes,size:size.toArray(),rotation:rig.rotation.toArray(),children:rig.children.map(c=>({name:c.name,position:c.position.toArray(),rotation:c.rotation.toArray(),scale:c.scale.toArray()}))};
},{data,textures});console.log(name, info.size);fs.writeFileSync(path.join(base,name+'.glb'),Buffer.from(await page.evaluate(()=>window.exported),'base64'));
await page.waitForTimeout(150);
for(const [index,time]of [.05,.25,.5,.75].entries()){await page.evaluate(t=>window.animateAt(t),time);await page.waitForTimeout(100);await page.screenshot({path:path.join(base,name+'-walk-'+index+'.png')});}
await page.screenshot({path:path.join(base,name+'-preview.png')});
await browser.close();
