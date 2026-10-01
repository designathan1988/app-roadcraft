"""Shape checks on a .glb that a picture can hide. Pure Python 3 + numpy.

    python check_shape.py <file.glb> [--json out.json]

  inside_out   a closed mesh whose faces point inwards (negative signed volume): the game draws only
               the front of a face, so such a part is INVISIBLE from outside
  dents        on painted surfaces: CONCAVE folds sharper than 18 degrees between neighbouring faces
               (a smooth car body is convex almost everywhere; folds are dents and pinches)
  slivers      triangles thinner than 1:30 (they shade as streaks)
  open_paint   boundary edges on painted meshes that are not shared with anything (a slit you can see
               through), except on door leaves, which are open by design
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

CT = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_glb(path):
    data = Path(path).read_bytes()
    pos, js, bin_ = 12, None, b""
    while pos < len(data):
        ln, typ = struct.unpack("<I4s", data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b"JSON":
            js = json.loads(chunk)
        elif typ == b"BIN\x00":
            bin_ = chunk
        pos += 8 + ln
    return js, bin_


def accessor(js, bin_, i):
    a = js["accessors"][i]
    bv = js["bufferViews"][a["bufferView"]]
    dt = CT[a["componentType"]]
    n = NC[a["type"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride")
    if stride and stride != np.dtype(dt).itemsize * n:
        raw = np.frombuffer(bin_, np.uint8, a["count"] * stride, off).reshape(a["count"], stride)
        return np.frombuffer(raw[:, :np.dtype(dt).itemsize * n].tobytes(), dt).reshape(a["count"], n)
    return np.frombuffer(bin_, dt, a["count"] * n, off).reshape(a["count"], n) if n > 1 else np.frombuffer(bin_, dt, a["count"], off)


def trs(n):
    if "matrix" in n:
        return np.array(n["matrix"]).reshape(4, 4).T
    t = n.get("translation", [0, 0, 0])
    x, y, z, w = n.get("rotation", [0, 0, 0, 1])
    s = n.get("scale", [1, 1, 1])
    R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    M = np.eye(4)
    M[:3, :3] = R * s
    M[:3, 3] = t
    return M


def meshes(js, bin_):
    """(node name, material name, world positions, triangles) per primitive."""
    out = []
    mats = [m.get("name", "") for m in js.get("materials", [])]

    def walk(i, P):
        n = js["nodes"][i]
        M = P @ trs(n)
        if "mesh" in n:
            for prim in js["meshes"][n["mesh"]]["primitives"]:
                v = accessor(js, bin_, prim["attributes"]["POSITION"]).astype(np.float64)
                v = v @ M[:3, :3].T + M[:3, 3]
                idx = accessor(js, bin_, prim["indices"]).astype(np.int64).reshape(-1, 3)
                out.append((n.get("name", ""), mats[prim["material"]] if "material" in prim else "", v, idx))
        for c in n.get("children", []):
            walk(c, M)

    for r in js["scenes"][js.get("scene", 0)]["nodes"]:
        walk(r, np.eye(4))
    return out


def weld(v, tris, eps=1e-4):
    key = np.round(v / eps).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    return inv.ravel()[tris]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("glb")
    ap.add_argument("--json", default=None)
    a = ap.parse_args()
    js, bin_ = read_glb(a.glb)
    prims = meshes(js, bin_)
    # group primitives by node (one object = possibly several materials)
    nodes = {}
    for name, mat, v, t in prims:
        nodes.setdefault(name, []).append((mat, v, t))
    inside_out, dents, slivers, open_paint = [], 0, 0, 0
    global BOUND
    BOUND = {}
    dent_where = []
    paint_edges = 0
    for name, parts in nodes.items():
        V = np.vstack([p[1] for p in parts])
        T, M, off = [], [], 0
        for mat, v, t in parts:
            T.append(t + off)
            M += [mat] * len(t)
            off += len(v)
        T = np.vstack(T)
        M = np.array(M)
        W = weld(V, T)
        # closedness and orientation
        e = np.concatenate([W[:, [0, 1]], W[:, [1, 2]], W[:, [2, 0]]])
        ek = np.sort(e, axis=1)
        uniq, cnt = np.unique(ek, axis=0, return_counts=True)
        closed = (cnt == 2).all()
        vol = np.einsum("ij,ij->i", V[T[:, 0]], np.cross(V[T[:, 1]], V[T[:, 2]])).sum() / 6
        if closed and vol < 0:
            inside_out.append(name)
        # slivers
        a_, b_, c_ = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
        area2 = np.linalg.norm(np.cross(b_ - a_, c_ - a_), axis=1)
        longest = np.max([np.linalg.norm(b_ - a_, axis=1), np.linalg.norm(c_ - b_, axis=1), np.linalg.norm(a_ - c_, axis=1)], axis=0)
        h = area2 / np.maximum(longest, 1e-12)
        sl = (area2 > 1e-10) & (longest > 0.03) & (h < longest / 30)
        slivers += int((sl & (M == "paint")).sum())
        # dents: concave folds between neighbouring PAINT faces
        fn = np.cross(b_ - a_, c_ - a_)
        fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
        cen = (a_ + b_ + c_) / 3
        fid = np.tile(np.arange(len(T)), 3)
        order = np.lexsort((ek[:, 1], ek[:, 0]))
        eks, fis = ek[order], fid[order]
        same = (eks[1:] == eks[:-1]).all(1)
        f1, f2 = fis[:-1][same], fis[1:][same]
        both = (M[f1] == "paint") & (M[f2] == "paint") & (area2[f1] > 1e-8) & (area2[f2] > 1e-8)
        f1, f2 = f1[both], f2[both]
        paint_edges += len(f1)
        cosang = np.clip((fn[f1] * fn[f2]).sum(1), -1, 1)
        ang = np.degrees(np.arccos(cosang))
        concave = ((cen[f2] - cen[f1]) * fn[f1]).sum(1) > 1e-5
        d = concave & (ang > 18)
        dents += int(d.sum())
        if d.any():
            dent_where += [name] * int(d.sum())
        # boundary edges of this object, as world-position keys (matched across objects below)
        bnd = uniq[cnt == 1]
        q = np.round(V / 1e-3).astype(np.int64)
        rep = {}
        flatW, flatT = W.ravel(), T.ravel()
        for wi, vi in zip(flatW, flatT):
            rep.setdefault(wi, vi)
        is_paint_vert = np.zeros(W.max() + 1, bool)
        is_paint_vert[W[M == "paint"].ravel()] = True
        for e0, e1 in bnd:
            k = tuple(sorted([tuple(q[rep[e0]]), tuple(q[rep[e1]])]))
            BOUND.setdefault(k, []).append((name, bool(is_paint_vert[e0] and is_paint_vert[e1])))
    # a paint boundary edge that no other object meets at the same place is a slit you can see through
    open_paint = sum(1 for k, who in BOUND.items() if len(who) == 1 and who[0][1])
    res = {"insideOut": inside_out, "dentEdges": dents, "dentShare": round(dents / max(paint_edges, 1), 4),
           "dentObjects": sorted(set(dent_where)), "slivers": slivers, "openPaintEdges": open_paint}
    fails = []
    if inside_out:
        fails.append(f"inside-out (invisible from outside): {inside_out}")
    if res["dentShare"] > 0.06:
        fails.append(f"{dents} dent edges ({res['dentShare']:.2%} of the paint): concave folds on the body")
    if slivers > 40:
        fails.append(f"{slivers} sliver triangles on the paint")
    if open_paint > 0:
        fails.append(f"{open_paint} open paint edges (slits)")
    res["fails"], res["ok"] = fails, not fails
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(main())
