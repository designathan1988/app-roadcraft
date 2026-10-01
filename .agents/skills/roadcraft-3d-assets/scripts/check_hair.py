"""Check a hair proxy against every rule the game imposes. Writes <dir>/check.json; exit 1 on any failure.

    python check_hair.py --dir <out>/<name> [--max-tris 16000]

Rules (references/hair.md explains each):
  files        .obj .mhclo .mhmat _diffuse.png present, names match the folder
  mhclo        one verts line per OBJ vertex, refs on helper-hair, weights sum to 1, refit < 0.001 dm
  length       no vertex below y = 1.2 dm
  chest        below y = 6.0: z <= 0.2 (behind the shoulders) and |x| <= 1.35
  face         nothing in 6.2 < y < 7.55, z > 0.95, |x| < 0.6
  skin         no vertex inside the body (except the buried clump roots on the scalp)
  alpha        every vertex alpha >= 0.5; no triangle dropped by the crowd rule (mean alpha < 0.45)
  grey         texture is greyscale (the game dyes it)
  budget       triangles <= --max-tris
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mh import (SCALE_REFS, closest_on_triangles, load_base, nearest_triangle, read_obj, read_png_rgba,  # noqa: E402
                sample_texture, scalp_weight)


def read_mhclo(path: Path):
    refs, w, d, scale, kw = [], [], [], {}, {}
    for line in path.read_text(encoding="utf-8").splitlines():
        p = line.split()
        if not p or p[0].startswith("#"):
            continue
        if p[0] in ("x_scale", "y_scale", "z_scale"):
            scale[p[0][0]] = (int(p[1]), int(p[2]), float(p[3]))
        elif len(p) == 9 and p[0].lstrip("-").isdigit():
            refs.append([int(x) for x in p[:3]]); w.append([float(x) for x in p[3:6]]); d.append([float(x) for x in p[6:9]])
        elif len(p) >= 2:
            kw[p[0]] = p[1]
    return np.array(refs), np.array(w), np.array(d), scale, kw


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, type=Path)
    ap.add_argument("--max-tris", type=int, default=16000)
    a = ap.parse_args()
    d = a.dir
    name = d.name
    fails: list[str] = []
    res: dict = {"name": name}

    files = {k: d / f"{name}{k}" for k in (".obj", ".mhclo", ".mhmat", "_diffuse.png")}
    missing = [str(p.name) for p in files.values() if not p.is_file()]
    if missing:
        print("FAIL: missing", missing)
        return 1

    base = load_base()
    v, uv, tris = read_obj(files[".obj"])
    res.update(vertices=int(len(v)), triangles=int(len(tris)))
    if uv is None:
        fails.append("OBJ has no UVs")

    # mhclo
    refs, w, off, scale, kw = read_mhclo(files[".mhclo"])
    if kw.get("obj_file") != f"{name}.obj" or kw.get("material") != f"{name}.mhmat" or kw.get("name") != name:
        fails.append("mhclo name/obj_file/material do not match the folder name")
    if len(refs) != len(v):
        fails.append(f"mhclo has {len(refs)} verts lines, OBJ has {len(v)} vertices")
    else:
        hh = set(base.verts_of("helper-hair").tolist())
        if not set(refs.ravel().tolist()) <= hh:
            fails.append("mhclo references vertices outside helper-hair")
        if np.abs(w.sum(1) - 1).max() > 1e-3:
            fails.append("mhclo weights do not sum to 1")
        sc = np.array([abs(base.v[scale[k][0], i] - base.v[scale[k][1], i]) / scale[k][2] for i, k in enumerate("xyz")])
        if any((scale[k][0], scale[k][1]) != SCALE_REFS[k] for k in "xyz"):
            fails.append("mhclo scale vertices differ from 5399/11998, 791/881, 962/5320")
        refit = (w[:, :, None] * base.v[refs]).sum(1) + off * sc[None]
        err = float(np.linalg.norm(refit - v, axis=1).max())
        res["maxRefitErrorDm"] = err
        if err >= 1e-3:
            fails.append(f"refit error {err:.4f} dm")

    # shape rules
    below = int((v[:, 1] < 1.2).sum())
    low = v[:, 1] < 6.0
    chest = int((low & ((v[:, 2] > 0.2) | (np.abs(v[:, 0]) > 1.35))).sum())
    face = int(((v[:, 1] > 6.2) & (v[:, 1] < 7.55) & (v[:, 2] > 0.95) & (np.abs(v[:, 0]) < 0.6)).sum())
    btris = base.groups["body"]
    ti, q, _ = nearest_triangle(v, base.v, btris)
    a_, b_, c_ = base.v[btris[ti, 0]], base.v[btris[ti, 1]], base.v[btris[ti, 2]]
    n = np.cross(b_ - a_, c_ - a_)
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    signed = ((v - q) * n).sum(1)
    # clump roots are buried up to 0.03 dm on purpose, on the scalp and at the hairline: not a defect
    on_scalp = (scalp_weight(q) > 0.2) | ((q[:, 1] > 6.3) & (signed > -0.04))
    inside = int(((signed < -0.01) & ~on_scalp).sum())
    res["violations"] = {"belowY1.2": below, "frontOfChest": chest, "faceArea": face, "insideBody": inside}
    for k, c in res["violations"].items():
        if c:
            fails.append(f"{c} vertices break the '{k}' rule")
    res["minDistToBodyDm"] = float(signed[~on_scalp].min()) if (~on_scalp).any() else None

    # texture
    img = read_png_rgba(files["_diffuse.png"])
    t = sample_texture(img, uv if uv is not None else np.zeros((len(v), 2)))
    res["minVertexAlpha"] = float(t[:, 3].min())
    dropped = int((t[tris, 3].mean(1) < 0.45).sum())
    res["crowdDroppedTriangles"] = dropped
    if t[:, 3].min() < 0.5:
        fails.append(f"vertex alpha down to {t[:, 3].min():.2f} (< 0.5)")
    if dropped:
        fails.append(f"{dropped} triangles vanish in the crowd (mean alpha < 0.45)")
    rgb = img[..., :3].astype(int)
    if (np.abs(rgb[..., 0] - rgb[..., 1]).max() > 3) or (np.abs(rgb[..., 1] - rgb[..., 2]).max() > 3):
        fails.append("texture is not greyscale")
    if len(tris) > a.max_tris:
        fails.append(f"{len(tris)} triangles > budget {a.max_tris}")
    mat = files[".mhmat"].read_text(encoding="utf-8")
    if "transparent True" not in mat or "backfaceCull False" not in mat or f"diffuseTexture {name}_diffuse.png" not in mat:
        fails.append("mhmat must say transparent True, backfaceCull False, diffuseTexture <name>_diffuse.png")

    res["fails"] = fails
    res["ok"] = not fails
    (d / "check.json").write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(json.dumps(res, indent=1))
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(main())
