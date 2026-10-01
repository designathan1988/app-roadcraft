"""Template for a GLB asset built by code in Blender (vehicles, props, building parts).

    blender -b --factory-startup -P make_<name>.py -- --out <dir>

Copy this file, keep `reset`, `material`, `export` and the axis rule, replace `build()`.

AXES. Blender is Z-up; the glTF exporter (export_yup=True) maps Blender (x, y, z) -> glTF (x, z, -y).
So in Blender: model the FRONT facing -Y, the LEFT side at +X, the ground at z = 0, in METRES.
After export the front faces +Z, up is +Y, left is +X: what the game expects.
"""
import math
import sys
from pathlib import Path

import bmesh  # type: ignore
import bpy  # type: ignore

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(ARGS[ARGS.index("--out") + 1]) if "--out" in ARGS else Path(".")
NAME = "sedan_template"


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0


_MATS = {}


def material(name, rgb, metallic=0.0, roughness=0.5, alpha=1.0, emissive=None):
    """Named PBR material (the game looks materials up BY NAME: paint, glass, trim, tire, rim, lamp_*...)."""
    if name in _MATS:
        return _MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*rgb, 1.0)
    p.inputs["Metallic"].default_value = metallic
    p.inputs["Roughness"].default_value = roughness
    if alpha < 1.0:
        p.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    if emissive:
        p.inputs["Emission Color"].default_value = (*emissive, 1.0)
        p.inputs["Emission Strength"].default_value = 0.0  # the game switches lamps on
    _MATS[name] = m
    return m


def mesh_from_bmesh(name, bm, mat, parent=None, location=(0, 0, 0)):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = location
    if parent:
        ob.parent = parent
    return ob


def wheel(name, radius, width, x, y, parent):
    """A wheel node whose ORIGIN is the axle centre (the game spins it about its local X)."""
    pivot = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(pivot)
    pivot.location = (x, y, radius)
    pivot.parent = parent
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=20, radius1=radius, radius2=radius, depth=width)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=__import__("mathutils").Matrix.Rotation(math.pi / 2, 3, "Y"))
    mesh_from_bmesh(name + "_tire", bm, material("tire", (0.03, 0.03, 0.03), roughness=0.9), parent=pivot)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=radius * 0.6, radius2=radius * 0.6, depth=width * 1.02)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=__import__("mathutils").Matrix.Rotation(math.pi / 2, 3, "Y"))
    mesh_from_bmesh(name + "_rim", bm, material("rim", (0.6, 0.6, 0.62), metallic=1.0, roughness=0.3), parent=pivot)
    return pivot


def build():
    """REPLACE THIS with the real model. A placeholder sedan-sized block shows the conventions only."""
    L, W, H = 4.70, 1.84, 1.45
    root = bpy.data.objects.new("sedan", None)
    bpy.context.scene.collection.objects.link(root)
    body = bpy.data.objects.new("body", None)
    bpy.context.scene.collection.objects.link(body)
    body.parent = root
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(W, L, H - 0.25), verts=bm.verts)
    bmesh.ops.translate(bm, vec=(0, 0, (H - 0.25) / 2 + 0.25), verts=bm.verts)
    mesh_from_bmesh("body_shell", bm, material("paint", (1, 1, 1), metallic=0.6, roughness=0.35), parent=body)
    # every named material must be USED by a mesh, or the exporter drops it
    parts = {
        "glass": (material("glass", (0.10, 0.13, 0.16), roughness=0.05, alpha=0.85), (W * 0.8, 1.2, 0.35), (0, 0.1, H - 0.2)),
        "trim": (material("trim", (0.04, 0.04, 0.04), roughness=0.8), (W * 0.9, 0.08, 0.1), (0, -L / 2 + 0.04, 0.4)),
        "lamp_head_L": (material("lamp_head", (0.9, 0.9, 0.85), emissive=(1, 1, 0.9)), (0.3, 0.05, 0.1), (0.6, -L / 2 + 0.02, 0.75)),
        "lamp_tail_L": (material("lamp_tail", (0.5, 0.02, 0.02), emissive=(1, 0, 0)), (0.3, 0.05, 0.1), (0.6, L / 2 - 0.02, 0.8)),
    }
    for nm, (mat, size, loc) in parts.items():
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=size, verts=bm.verts)
        mesh_from_bmesh(nm, bm, mat, parent=body, location=loc)
    wb, track, r = 2.80, 1.58, 0.33
    for nm, sx, sy in (("wheel_FL", 1, -1), ("wheel_FR", -1, -1), ("wheel_RL", 1, 1), ("wheel_RR", -1, 1)):
        # front = -Y in Blender; left = +X
        wheel(nm, r, 0.22, sx * (track / 2 - 0.11), sy * wb / 2, root)
    return root


def export(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", export_yup=True, export_apply=True,
        export_cameras=False, export_lights=False, export_draco_mesh_compression_enable=False,
        export_texcoords=True, export_normals=True, export_materials="EXPORT",
    )


reset()
build()
export(OUT / NAME / f"{NAME}.glb")
print("exported", OUT / NAME / f"{NAME}.glb")
