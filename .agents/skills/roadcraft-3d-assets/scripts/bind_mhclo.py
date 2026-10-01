"""Bind a proxy mesh (hair, garment, hat, shoes) to the MakeHuman base mesh: writes <name>.mhclo and <name>.mhmat.

    python bind_mhclo.py --obj out/hair_f_long_straight01/hair_f_long_straight01.obj --kind hair

The OBJ must be modelled ON base.obj (decimetres, same frame). Every proxy vertex gets the three
vertices of its nearest base triangle, barycentric weights and an offset in scale units, exactly the
.mhclo format the game's importer (scripts/import-makehuman-proxies.mjs) reads and proxy.ts fits.

Binding targets:
  hair, hat -> faces of "helper-hair" (the shell MakeHuman's own long hair is bound to)
  clothes   -> faces of "body"
  shoes     -> faces of "body", scaled by the foot

Prints and writes <name>.bind.json: max refit error (must be < 0.001 dm) and a deformation test.
Exit code 1 when a check fails.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mh import SCALE_REFS, SHOE_SCALE_REFS, closest_on_triangles, load_base, nearest_triangle, read_obj  # noqa: E402

TARGET = {"hair": ("helper-hair",), "hat": ("helper-hair",), "clothes": ("body",), "shoes": ("body",)}
ZDEPTH = {"hair": 50, "hat": 70, "clothes": 50, "shoes": 5}


def fit(base_v, refs, w, d, scale):
    return (w[:, :, None] * base_v[refs]).sum(1) + d * scale[None]


def axis_scale(base_v, refs_pairs, dists):
    out = []
    for axis, key in enumerate("xyz"):
        a, b = refs_pairs[key]
        out.append(abs(base_v[a, axis] - base_v[b, axis]) / dists[axis])
    return np.array(out)


def deform(base_v: np.ndarray) -> np.ndarray:
    """A plausible different body: head 10% smaller about the head joint, torso below the neck bent 10 deg forward."""
    def smooth(e0, e1, x):
        t = np.clip((x - e0) / (e1 - e0), 0, 1)
        return t * t * (3 - 2 * t)

    v = base_v.copy()
    y = v[:, 1]
    head_c = np.array([0.0, 6.975, 0.161])
    s = 1 - 0.1 * smooth(6.0, 6.8, y)
    v = head_c + (v - head_c) * s[:, None]
    piv = np.array([0.0, 6.0, 0.0])
    a = np.radians(10) * (1 - smooth(5.4, 6.2, y))
    rel = v - piv
    c, si = np.cos(a), np.sin(a)
    v = piv + np.stack([rel[:, 0], c * rel[:, 1] - si * rel[:, 2], si * rel[:, 1] + c * rel[:, 2]], 1)
    return v


def coherent_triangles(pv, tris, base_v, target, coherence: float, k: int = 12, sweeps: int = 8):
    a, b, c = base_v[target[:, 0]], base_v[target[:, 1]], base_v[target[:, 2]]
    cen = (a + b + c) / 3
    n = len(pv)
    # k candidate triangles per vertex and their true distances
    cand = np.zeros((n, k), dtype=np.int64)
    dist = np.zeros((n, k))
    for s in range(0, n, 512):
        pp = pv[s:s + 512]
        dc = np.linalg.norm(pp[:, None, :] - cen[None], axis=2)
        kk = min(4 * k, len(target))
        pre = np.argpartition(dc, kk - 1, axis=1)[:, :kk]
        P = np.repeat(pp, kk, axis=0)
        T = pre.ravel()
        q, _ = closest_on_triangles(P, a[T], b[T], c[T])
        d = np.linalg.norm(P - q, axis=1).reshape(len(pp), kk)
        o = np.argsort(d, axis=1)[:, :k]
        cand[s:s + 512] = np.take_along_axis(pre, o, 1)
        dist[s:s + 512] = np.take_along_axis(d, o, 1)
    choice = np.zeros(n, dtype=np.int64)  # index into the k candidates; start at nearest
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    e = np.unique(np.sort(np.concatenate([e, e[:, ::-1]]), axis=1), axis=0)
    e = np.concatenate([e, e[:, ::-1]])
    deg = np.maximum(np.bincount(e[:, 0], minlength=n), 1)[:, None]
    for _ in range(sweeps):
        chosen = cen[cand[np.arange(n), choice]]
        # pairwise term: mean distance from each candidate to every neighbour's current pick
        pair = np.linalg.norm(cen[cand[e[:, 0]]] - chosen[e[:, 1]][:, None, :], axis=2)
        acc = np.zeros((n, k))
        np.add.at(acc, e[:, 0], pair)
        cost = dist + coherence * acc / deg
        choice = cost.argmin(1)
    return cand[np.arange(n), choice]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--obj", required=True, type=Path)
    ap.add_argument("--kind", required=True, choices=sorted(TARGET))
    ap.add_argument("--name", default=None)
    ap.add_argument("--delete-verts", type=Path, default=None, help="text file of base vertex indices the garment hides")
    ap.add_argument("--transparent", default=None, choices=["True", "False"])
    ap.add_argument("--coherence", type=float, default=1.0, help="weight of agreeing with neighbours when picking triangles (0 = raw nearest)")
    args = ap.parse_args()

    name = args.name or args.obj.stem
    out_dir = args.obj.parent
    base = load_base()
    pv, uv, tris = read_obj(args.obj)
    if uv is None:
        print("OBJ has no vt: the game needs UVs", file=sys.stderr)
        return 1
    target = base.tris(*TARGET[args.kind])
    refs_pairs = SHOE_SCALE_REFS if args.kind == "shoes" else SCALE_REFS
    dists = base.scale_dists(refs_pairs)

    # Choose each vertex's triangle so that NEIGHBOURING vertices pick NEIGHBOURING triangles. Raw
    # nearest-triangle lets the two ends of a short edge latch onto distant parts of the shell (front
    # and back of the neck), and the edge tears when the body changes. Each vertex picks among its
    # nearest candidates, trading distance against agreement with its neighbours' picks (a few ICM
    # sweeps). The offset still makes the fit on the base mesh exact.
    tri_idx = coherent_triangles(pv, tris, base.v, target, args.coherence)
    refs = target[tri_idx]
    _, w = closest_on_triangles(pv, base.v[refs[:, 0]], base.v[refs[:, 1]], base.v[refs[:, 2]])
    w = np.clip(w, 0, 1)
    w /= w.sum(1, keepdims=True)
    q = (w[:, :, None] * base.v[refs]).sum(1)
    scale = axis_scale(base.v, refs_pairs, dists)  # 1,1,1 on the base itself
    d = (pv - q) / scale[None]

    # what the file will hold (5 decimals), refit from it
    w_r, d_r = np.round(w, 5), np.round(d, 5)
    err = np.linalg.norm(fit(base.v, refs, w_r, d_r, scale) - pv, axis=1).max()

    # deformation test
    dv = deform(base.v)
    p2 = fit(dv, refs, w_r, d_r, axis_scale(dv, refs_pairs, dists))
    def edges(p):
        return np.stack([np.linalg.norm(p[tris[:, i]] - p[tris[:, (i + 1) % 3]], axis=1) for i in range(3)], 1)
    e0, e1 = edges(pv), edges(p2)
    # A tear the player can see: an edge that grows by more than 0.08 dm (8 mm) AND to over 2.5x.
    ratio = e1 / np.maximum(e0, 1e-9)
    torn = int(((e1 - e0 > 0.08) & (ratio > 2.5)).sum())
    stretch = float(np.percentile(ratio[e0 > 0.02], 99.9))
    n0 = np.cross(pv[tris[:, 1]] - pv[tris[:, 0]], pv[tris[:, 2]] - pv[tris[:, 0]])
    n1 = np.cross(p2[tris[:, 1]] - p2[tris[:, 0]], p2[tris[:, 2]] - p2[tris[:, 0]])
    flipped = int(((n0 * n1).sum(1) < 0).sum())

    lines = [
        "# license CC0",
        "# generated by the roadcraft-3d-assets skill (bind_mhclo.py)",
        "basemesh hm08",
        f"name {name}",
        f"obj_file {name}.obj",
        f"material {name}.mhmat",
        f"z_depth {ZDEPTH[args.kind]}",
        f"x_scale {refs_pairs['x'][0]} {refs_pairs['x'][1]} {dists[0]:.4f}",
        f"y_scale {refs_pairs['y'][0]} {refs_pairs['y'][1]} {dists[1]:.4f}",
        f"z_scale {refs_pairs['z'][0]} {refs_pairs['z'][1]} {dists[2]:.4f}",
        "verts 0",
    ]
    lines += [
        f"{r[0]} {r[1]} {r[2]} {a[0]:.5f} {a[1]:.5f} {a[2]:.5f} {o[0]:.5f} {o[1]:.5f} {o[2]:.5f}"
        for r, a, o in zip(refs, w_r, d_r)
    ]
    if args.delete_verts:
        ids = sorted({int(x) for x in args.delete_verts.read_text().split()})
        lines.append("delete_verts")
        lines += [" ".join(map(str, ids[i:i + 16])) for i in range(0, len(ids), 16)]
    (out_dir / f"{name}.mhclo").write_text("\n".join(lines) + "\n", encoding="utf-8")

    transparent = args.transparent or ("True" if args.kind == "hair" else "False")
    (out_dir / f"{name}.mhmat").write_text(
        f"# license CC0\nname {name}\ndiffuseColor 1.0 1.0 1.0\ntransparent {transparent}\n"
        f"backfaceCull {'False' if args.kind == 'hair' else 'True'}\ndiffuseTexture {name}_diffuse.png\n",
        encoding="utf-8",
    )

    report = {
        "name": name, "kind": args.kind, "vertices": int(len(pv)), "triangles": int(len(tris)),
        "boundTo": TARGET[args.kind], "scaleDistsDm": [round(x, 4) for x in dists],
        "maxRefitErrorDm": float(err), "deformStretchP999": round(stretch, 3), "deformTornEdges": torn, "deformFlippedTriangles": flipped,
        "maxOffsetDm": float(np.linalg.norm(d, axis=1).max()),
    }
    (out_dir / f"{name}.bind.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps(report, indent=1))
    fails = []
    if err >= 1e-3:
        fails.append(f"refit error {err:.5f} dm >= 0.001")
    if torn:
        fails.append(f"deformation tears {torn} edges (+8 mm and 2.5x): neighbouring vertices are bound to distant triangles")
    if flipped > len(tris) * 0.002:
        fails.append(f"deformation flips {flipped} triangles")
    for f in fails:
        print("FAIL:", f, file=sys.stderr)
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
