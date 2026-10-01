"""Render previews of hair/garment proxies on the base body, coloured the way the game's CROWD draws them.

    blender -b --factory-startup -P render_previews.py -- --dir <out>/<name> [--dir ...] [--sheet sheet.png]

Per directory it writes preview_front/back/side/34/iso.png (1024 px, orthographic). The colouring is
the game's (src/render/people/personRig.ts): the texture is read ONLY at each vertex's UV, hair is
dyed (hair colour * (0.45 + 1.1 * luminance)), and triangles whose mean vertex alpha is < 0.45 are
dropped. What you see here is what the player sees in a crowd. --sheet tiles the 3/4 and back views of
every directory into one contact sheet. --colour sets the dye (default brown 5a3a22).
"""
import math
import sys
from pathlib import Path

import bpy  # type: ignore
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mh import find_base_obj, load_base, scalp_weight, read_obj, read_png_rgba, sample_texture, srgb_to_linear  # noqa: E402

SOLID = 0.45


def args():
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    dirs, sheet, colour, body_full = [], None, "5a3a22", False
    i = 0
    while i < len(a):
        if a[i] == "--dir":
            dirs.append(Path(a[i + 1])); i += 2
        elif a[i] == "--sheet":
            sheet = Path(a[i + 1]); i += 2
        elif a[i] == "--colour":
            colour = a[i + 1]; i += 2
        else:
            i += 1
    return dirs, sheet, colour


def mesh_object(name, v, tris, colours):
    me = bpy.data.meshes.new(name)
    # Blender is Z-up: base frame (x, y up, z forward) -> Blender (x, -z, y)
    bv = np.stack([v[:, 0], -v[:, 2], v[:, 1]], 1)
    me.from_pydata(bv.tolist(), [], tris.tolist())
    me.update()
    attr = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    rgba = np.concatenate([colours, np.ones((len(colours), 1))], 1).astype(np.float32)
    attr.data.foreach_set("color", rgba.ravel())
    me.color_attributes.active_color = attr
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def crowd_colours(d: Path, dye):
    name = d.name
    v, uv, tris = read_obj(d / f"{name}.obj")
    tex_path = d / f"{name}_diffuse.png"
    if uv is not None and tex_path.is_file():
        t = sample_texture(read_png_rgba(tex_path), uv)
    else:
        t = np.tile([0.55, 0.55, 0.55, 1.0], (len(v), 1))
    lin = srgb_to_linear(t[:, :3])
    lum = 0.3 * lin[:, 0] + 0.59 * lin[:, 1] + 0.11 * lin[:, 2]
    is_hair = name.startswith("hair") or "hair" in name
    if is_hair:
        col = np.minimum(1, dye[None] * (0.45 + 1.1 * lum)[:, None])
    else:
        col = lin
    keep = t[tris, 3].mean(1) >= SOLID
    return v, tris[keep], col, int((~keep).sum())


def setup_scene():
    sc = bpy.context.scene
    for ob in list(sc.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    sc.render.engine = "BLENDER_WORKBENCH"
    sh = sc.display.shading
    sh.light = "STUDIO"
    sh.color_type = "VERTEX"
    sh.show_cavity = True
    sh.cavity_type = "BOTH"
    sh.show_shadows = False
    sh.show_specular_highlight = False
    sc.render.resolution_x = sc.render.resolution_y = 1024
    sc.render.film_transparent = False
    sc.world = sc.world or bpy.data.worlds.new("w")
    sc.view_settings.view_transform = "Standard"
    sc.display.shading.background_type = "VIEWPORT"
    sc.display.shading.background_color = (0.5, 0.5, 0.5)
    sc.render.image_settings.file_format = "PNG"
    return sc


VIEWS = {
    # name: (yaw degrees around the body, from the front; elevation degrees)
    "front": (0, 0), "back": (180, 0), "side": (90, 0), "34": (40, 8), "iso": (225, 35),
}


def camera(sc, yaw, elev, centre_y=5.6, scale=7.5):
    cam = bpy.data.objects.get("cam")
    if cam is None:
        cd = bpy.data.cameras.new("cam")
        cam = bpy.data.objects.new("cam", cd)
        sc.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = scale
    cam.data.clip_end = 200
    y, e = math.radians(yaw), math.radians(elev)
    target = np.array([0.0, centre_y, 0.3])  # base frame
    eye = target + 40 * np.array([math.sin(y) * math.cos(e), math.sin(e), math.cos(y) * math.cos(e)])
    to_b = lambda p: (float(p[0]), float(-p[2]), float(p[1]))  # noqa: E731
    from mathutils import Vector  # type: ignore
    cam.location = to_b(eye)
    cam.rotation_euler = (Vector(to_b(target)) - Vector(to_b(eye))).to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam


def main():
    dirs, sheet, colour = args()
    dye = srgb_to_linear(np.array([int(colour[i:i + 2], 16) / 255 for i in (0, 2, 4)]))
    base = load_base(find_base_obj())
    btris = base.groups["body"]
    sc = setup_scene()
    shots = []
    for d in dirs:
        setup_scene()
        skin = np.full((len(base.v), 3), 0.62)
        if d.name.startswith("hair"):
            # the game paints the scalp under hair in the hair colour (personRig.ts bodyColour)
            h = np.minimum(1, scalp_weight(base.v) * 1.6)[:, None]
            skin = skin + (dye[None] * 0.8 - skin) * h
        mesh_object("body", base.v, btris, skin)
        v, tris, col, dropped = crowd_colours(d, dye)
        mesh_object("proxy", v, tris, col)
        for view, (yaw, elev) in VIEWS.items():
            camera(sc, yaw, elev)
            path = d / f"preview_{view}.png"
            sc.render.filepath = str(path)
            bpy.ops.render.render(write_still=True)
            if view in ("34", "back"):
                shots.append(path)
        print(f"{d.name}: rendered, {dropped} triangles dropped by the crowd alpha rule")
    if sheet and shots:
        imgs = [bpy.data.images.load(str(p)) for p in shots]
        w, h = imgs[0].size
        cols = 4
        rows = math.ceil(len(imgs) / cols)
        sw, sh_ = 512, 512
        canvas = np.full((rows * sh_, cols * sw, 4), 0.5, np.float32)
        canvas[..., 3] = 1
        for i, im in enumerate(imgs):
            px = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)[::2, ::2]
            r, c = divmod(i, cols)
            y0 = (rows - 1 - r) * sh_
            canvas[y0:y0 + sh_, c * sw:(c + 1) * sw] = px[:sh_, :sw]
        out = bpy.data.images.new("sheet", cols * sw, rows * sh_)
        out.pixels = canvas.ravel()
        out.filepath_raw = str(sheet)
        out.file_format = "PNG"
        out.save()
        print("sheet:", sheet)


main()
