"""Validate a .glb against the game's conventions. Pure Python 3 (json/struct), no dependencies.

    python check_glb.py model.glb --kind sedan        # vehicles: hatch sedan suv van bus truck motorcycle bicycle
    python check_glb.py bench.glb --kind prop --size 1.8 0.9 0.6   # props: expected L(z) H(y) W(x) metres, +-10%

Checks: glTF 2.0 binary; no compression extensions; world bounding box in METRES with the base on y = 0;
the length along Z (the front faces +Z); size within tolerance; triangle budget; for vehicles the node
names (wheel_FL... at the right corners) and material names the game looks up. Writes <model>.check.json.
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from pathlib import Path

VEHICLES = {  # length (z), width (x), height (y) in metres; triangle budget
    "hatch": (3.90, 1.72, 1.48, 6000), "sedan": (4.70, 1.84, 1.45, 6000), "suv": (4.90, 1.95, 1.78, 6000),
    "van": (5.60, 2.00, 2.35, 6000), "bus": (12.0, 2.55, 3.20, 8000), "truck": (9.80, 2.50, 3.50, 8000),
    "motorcycle": (2.10, 0.80, 1.25, 3000), "bicycle": (1.80, 0.60, 1.10, 3000),
}
TWO_WHEEL = {"motorcycle", "bicycle"}
CAR_MATERIALS = {"paint", "glass", "trim", "tire", "rim", "lamp_head", "lamp_tail"}
BANNED_EXT = {"KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"}


def read_glb(path: Path):
    data = path.read_bytes()
    magic, version, length = struct.unpack("<4sII", data[:12])
    if magic != b"glTF" or version != 2:
        raise SystemExit("not a glTF 2.0 binary (.glb)")
    pos, gltf = 12, None
    while pos < len(data):
        ln, typ = struct.unpack("<I4s", data[pos:pos + 8])
        if typ == b"JSON":
            gltf = json.loads(data[pos + 8:pos + 8 + ln].decode("utf-8"))
        pos += 8 + ln
    return gltf


def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def node_matrix(n):
    if "matrix" in n:
        m = n["matrix"]
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    t = n.get("translation", [0, 0, 0])
    x, y, z, w = n.get("rotation", [0, 0, 0, 1])
    s = n.get("scale", [1, 1, 1])
    r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[r[i][0] * s[0], r[i][1] * s[1], r[i][2] * s[2], t[i]] for i in range(3)] + [[0, 0, 0, 1]]


def apply(m, p):
    return [sum(m[i][k] * p[k] for k in range(3)) + m[i][3] for i in range(3)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("glb", type=Path)
    ap.add_argument("--kind", required=True, help="vehicle archetype or 'prop'")
    ap.add_argument("--size", nargs=3, type=float, metavar=("LEN_Z", "HEIGHT_Y", "WIDTH_X"))
    ap.add_argument("--max-tris", type=int, default=None)
    a = ap.parse_args()
    g = read_glb(a.glb)
    fails, res = [], {"file": a.glb.name, "kind": a.kind}

    used = set(g.get("extensionsUsed", []))
    if used & BANNED_EXT:
        fails.append(f"compression extensions {sorted(used & BANNED_EXT)}: export uncompressed")
    if g.get("cameras") or any("KHR_lights_punctual" in n.get("extensions", {}) for n in g.get("nodes", [])):
        fails.append("the file carries cameras or lights: export meshes only")

    nodes = g.get("nodes", [])
    acc = g.get("accessors", [])
    meshes = g.get("meshes", [])
    mats = [m.get("name", "") for m in g.get("materials", [])]
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    tris = 0
    world = {}

    def walk(i, parent):
        nonlocal tris
        n = nodes[i]
        m = mat_mul(parent, node_matrix(n))
        world[n.get("name", f"node{i}")] = apply(m, [0, 0, 0])
        if "mesh" in n:
            for prim in meshes[n["mesh"]]["primitives"]:
                pa = acc[prim["attributes"]["POSITION"]]
                mn, mx = pa.get("min"), pa.get("max")
                if mn is None:
                    fails.append("POSITION accessor without min/max")
                    continue
                for cx in (mn[0], mx[0]):
                    for cy in (mn[1], mx[1]):
                        for cz in (mn[2], mx[2]):
                            p = apply(m, [cx, cy, cz])
                            for k in range(3):
                                lo[k], hi[k] = min(lo[k], p[k]), max(hi[k], p[k])
                count = acc[prim["indices"]]["count"] if "indices" in prim else pa["count"]
                if prim.get("mode", 4) == 4:
                    tris += count // 3
        for c in n.get("children", []):
            walk(c, m)

    ident = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    scene = g.get("scenes", [{}])[g.get("scene", 0)]
    for r in scene.get("nodes", []):
        walk(r, ident)
    size = [hi[k] - lo[k] for k in range(3)]
    res.update(bboxMin=[round(x, 3) for x in lo], bboxMax=[round(x, 3) for x in hi],
               sizeXYZ=[round(x, 3) for x in size], triangles=tris, materials=mats)

    if abs(lo[1]) > 0.02:
        fails.append(f"lowest point y = {lo[1]:.3f} m: the base must sit on y = 0")
    if a.kind in VEHICLES:
        L, W, H, budget = VEHICLES[a.kind]
        want = (W, H, L)
        tol = 0.02
        for k, nm in enumerate("xyz"):
            if abs(size[k] - want[k]) > want[k] * tol + 0.02:
                fails.append(f"size along {nm} = {size[k]:.3f} m, expected {want[k]:.2f} (+-2%)")
        if abs((lo[0] + hi[0]) / 2) > 0.03:
            fails.append("not centred in x")
        names = set(world)
        wheels = ["wheel_F", "wheel_R"] if a.kind in TWO_WHEEL else ["wheel_FL", "wheel_FR", "wheel_RL", "wheel_RR"]
        for w in wheels:
            if w not in names:
                fails.append(f"missing node '{w}'")
        if all(w in names for w in wheels):
            if a.kind in TWO_WHEEL:
                if not world["wheel_F"][2] > world["wheel_R"][2]:
                    fails.append("wheel_F is not ahead (+Z) of wheel_R: the front must face +Z")
            else:
                if not (world["wheel_FL"][2] > 0 > world["wheel_RL"][2]):
                    fails.append("front wheels are not at +Z: the front must face +Z")
                if not (world["wheel_FL"][0] > 0 > world["wheel_FR"][0]):
                    fails.append("wheel_FL must be at +X (the vehicle's left), wheel_FR at -X")
        need = {"tire", "rim"} | (set() if a.kind in TWO_WHEEL else CAR_MATERIALS)
        missing = need - set(mats)
        if missing:
            fails.append(f"missing materials {sorted(missing)}")
        budget = a.max_tris or budget
    else:
        budget = a.max_tris or 1500
        if a.size:
            Lz, Hy, Wx = a.size
            for k, (nm, want) in enumerate(zip("xyz", (Wx, Hy, Lz))):
                if abs(size[k] - want) > want * 0.10 + 0.02:
                    fails.append(f"size along {nm} = {size[k]:.3f} m, expected {want:.2f} (+-10%)")
    if tris > budget:
        fails.append(f"{tris} triangles > budget {budget}")
    res["fails"], res["ok"] = fails, not fails
    out = a.glb.with_suffix(".check.json")
    out.write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(json.dumps(res, indent=1))
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(main())
