"""Render a vehicle .glb for review AND test it for holes.

    blender -b --factory-startup -P render_car.py -- --glb <file.glb> --out <prefix> [--paint 2f5596]

Writes <prefix>_sheet.png (front 3/4, side, rear 3/4, front, the game's view from above, top) and runs
the HOLE TEST: the car is drawn flat white on a magenta background from 8 directions; any magenta pixel
that cannot be reached from the image border is background seen THROUGH the car - a hole. Holes are
painted red in <prefix>_holes.png and counted in <prefix>_holes.json.
"""
import json
import math
import sys
from pathlib import Path

import bpy  # type: ignore
import numpy as np
from mathutils import Vector  # type: ignore

A = sys.argv[sys.argv.index("--") + 1:]
glb = A[A.index("--glb") + 1]
prefix = A[A.index("--out") + 1]
paint = A[A.index("--paint") + 1] if "--paint" in A else "2f5596"

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb)
objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
lo = np.min([np.min([o.matrix_world @ Vector(c) for c in o.bound_box], axis=0) for o in objs], axis=0)
hi = np.max([np.max([o.matrix_world @ Vector(c) for c in o.bound_box], axis=0) for o in objs], axis=0)
centre = Vector(((lo + hi) / 2).tolist())
size = float(np.max(hi - lo))
pc = [int(paint[i:i + 2], 16) / 255 for i in (0, 2, 4)]
pc = [c ** 2.2 for c in pc]
for m in bpy.data.materials:
    if m.name == "paint":
        m.diffuse_color = (*pc, 1)
    elif m.use_nodes and m.node_tree.nodes.get("Principled BSDF"):
        c = m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value
        m.diffuse_color = (c[0], c[1], c[2], 1)

sc = bpy.context.scene
sc.render.engine = "BLENDER_WORKBENCH"
sc.view_settings.view_transform = "Standard"
sh = sc.display.shading
sh.background_type = "VIEWPORT"
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
sc.collection.objects.link(cam)
sc.camera = cam
cam.data.type = "ORTHO"
cam.data.clip_end = 500


def shoot(yaw, elev, path, res):
    sc.render.resolution_x, sc.render.resolution_y = res
    cam.data.ortho_scale = size * 1.12
    y, e = math.radians(yaw), math.radians(elev)
    # Blender frame: the car's front is -Y
    d = Vector((math.sin(y) * math.cos(e), -math.cos(y) * math.cos(e), math.sin(e)))
    cam.location = centre + d * size * 4
    cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    im = bpy.data.images.load(path)
    w, h = im.size
    px = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(im)
    return px


VIEWS = {"front34": (35, 12), "side": (90, 0), "rear34": (215, 12), "front": (0, 0), "game": (135, 35), "top": (0, 89)}

# --- review renders
sh.light = "STUDIO"
sh.color_type = "MATERIAL"
sh.show_cavity = True
sh.cavity_type = "BOTH"
sh.background_color = (0.62, 0.62, 0.62)
tiles = []
for name, (yaw, el) in VIEWS.items():
    tiles.append(shoot(yaw, el, f"{prefix}_{name}.png", (720, 480)))
sheet = np.ones((480 * 3, 720 * 2, 4), np.float32)
for i, t in enumerate(tiles):
    r, c = divmod(i, 2)
    sheet[(2 - r) * 480:(3 - r) * 480, c * 720:(c + 1) * 720] = t
img = bpy.data.images.new("sheet", 720 * 2, 480 * 3)
img.pixels = sheet.ravel()
img.filepath_raw = f"{prefix}_sheet.png"
img.file_format = "PNG"
img.save()

# --- hole test: flat white car on magenta
sh.light = "FLAT"
sh.color_type = "SINGLE"
sh.single_color = (1, 1, 1)
sh.show_cavity = False
sh.background_color = (1, 0, 1)
HOLE_VIEWS = {"side_l": (90, 0), "side_r": (270, 0), "front": (0, 0), "rear": (180, 0), "top": (0, 89),
              "game": (135, 35), "front34": (35, 12), "rear34": (215, 12)}
# Blind spot (documented): a see-through gap that joins the open space UNDER the car reaches the image
# border and is not counted. The generator closes every arch with a liner, so its cars have none.
report = {}
strips = []
for name, (yaw, el) in HOLE_VIEWS.items():
    px = shoot(yaw, el, f"{prefix}_h_{name}.png", (640, 640))
    bg = (px[..., 0] > 0.8) & (px[..., 1] < 0.25) & (px[..., 2] > 0.8)
    reach = np.zeros_like(bg)
    reach[0, :], reach[-1, :], reach[:, 0], reach[:, -1] = bg[0, :], bg[-1, :], bg[:, 0], bg[:, -1]
    while True:
        grow = reach.copy()
        grow[1:] |= reach[:-1]
        grow[:-1] |= reach[1:]
        grow[:, 1:] |= reach[:, :-1]
        grow[:, :-1] |= reach[:, 1:]
        grow &= bg
        if (grow == reach).all():
            break
        reach = grow
    holes = bg & ~reach
    report[name] = int(holes.sum())
    vis = np.where(bg[..., None], [0.85, 0.85, 0.85, 1], [0.35, 0.35, 0.35, 1]).astype(np.float32)
    vis[holes] = [1, 0, 0, 1]
    strips.append(vis[::2, ::2])
out = np.concatenate(strips, axis=1)
img = bpy.data.images.new("holes", out.shape[1], out.shape[0])
img.pixels = out.ravel()
img.filepath_raw = f"{prefix}_holes.png"
img.file_format = "PNG"
img.save()
total = sum(report.values())
Path(f"{prefix}_holes.json").write_text(json.dumps({"holePixels": report, "total": total}, indent=1))
print("HOLES", json.dumps(report), "total", total)
