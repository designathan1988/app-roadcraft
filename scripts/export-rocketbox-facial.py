"""Export a small, game-ready subset of an official Rocketbox facial FBX.

Usage: blender -b --factory-startup --python scripts/export-rocketbox-facial.py -- SOURCE.fbx OUTPUT.glb
This is a pilot only: source textures are added after pose and rig parity pass.
"""

import bpy
import sys


EXPRESSION_KEYS = {
    'AU_45_Blink',
    'HB_07_MouthSmile',
    'AK_03_BrowInnerUp',
    'AK_25_JawOpen',
    'AU_61_EyesTurnLeft',
    'AU_62_EyesTurnRight',
    'AA_VI_10_aa',
}


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    if len(args) != 2:
        raise SystemExit('Expected source FBX and output GLB')
    source, output = args
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=source)
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.data.shape_keys]
    if len(meshes) != 1:
        raise RuntimeError(f'Expected one expressive mesh, found {len(meshes)}')
    mesh = meshes[0]
    keys = mesh.data.shape_keys.key_blocks
    if not EXPRESSION_KEYS.issubset({key.name for key in keys}):
        raise RuntimeError('Source is missing selected expressions')
    bpy.ops.object.select_all(action='DESELECT')
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    for key in list(keys)[::-1]:
        if key.name != 'Basis' and key.name not in EXPRESSION_KEYS:
            mesh.shape_key_remove(key)
    for obj in list(bpy.data.objects):
        if obj.type in {'CAMERA', 'LIGHT'} or (obj.type == 'MESH' and obj != mesh):
            bpy.data.objects.remove(obj, do_unlink=True)
    bpy.ops.export_scene.gltf(
        filepath=output, export_format='GLB', export_animations=False,
        export_morph=True, export_morph_normal=False, export_morph_tangent=False,
        export_skins=True,
    )
    print('EXPORTED', output, 'KEYS', [key.name for key in mesh.data.shape_keys.key_blocks])


if __name__ == '__main__':
    main()
