"""Build a hairstyle from a JSON style spec: OBJ (decimetres, base.obj frame) + greyscale RGBA texture.

    python hair_build.py --spec ../assets/hair_styles/hair_f_long_straight01.json --out <dir>

Writes <out>/<name>/<name>.obj and <name>_diffuse.png. Then run bind_mhclo.py, check_hair.py and
render_previews.py (see SKILL.md). Every parameter is documented in references/hair.md.

How it works
  1. Roots are sampled on the scalp of base.obj, inside the game's own hairline.
  2. Each root grows a GUIDE: it steps from the scalp with gravity, is pushed out of the body, and
     below the jaw is steered BEHIND the shoulders (the game's rule: no hair in front of the chest).
     Gathered styles (ponytail, braid, half-up) first run along the scalp to a gather point.
  3. Waves, curls and frizz are added across the guide, then the body is pushed out again.
  4. Each guide becomes a solid CLUMP: an elliptical tube that tapers to the tip, with UVs in its own
     atlas cell. The texture is opaque except the last 10% of each clump (alpha down to 0.6), because
     the game's crowd draws hair from per-vertex colour and drops see-through triangles.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mh import load_base, vertex_normals, write_obj, write_png  # noqa: E402

EYE_Y, EYE_Z = 7.284, 1.245
HEAD_C = np.array([0.0, 7.45, 0.45])     # centre of the cranium, for "outward" directions
NECK_Y = 6.3                              # below this, hair must be behind the shoulders

DEFAULTS = {
    "seed": 1,
    "part": {"type": "center", "x": 0.0},           # center | side | none ; side uses x (e.g. 0.35)
    "length": {"back_y": 2.8, "side_y": 3.4, "front_y": 4.0},
    "layers": 0.10,                                  # tip-length jitter, fraction of length
    "clumps": 110,
    "width": [0.36, 0.12],                           # clump width at root, at tip (dm)
    "thickness": 0.05,                               # clump thickness (dm)
    "clearance": 0.05,                               # gap to skin for the innermost layer (dm)
    "volume": 0.12,                                  # extra lift of outer layers near the head (dm)
    "stiffness": 0.55,                               # 0 droops at once, 1 keeps its root direction longer
    "wave": {"amp": 0.0, "wavelength": 1.2},
    "curl": {"radius": 0.0, "period": 0.45},
    "frizz": 0.0,
    "bangs": None,                                   # {"type": "curtain"|"straight", "end_y": 7.65, "clumps": 26}
    "gather": None,                                  # see references/hair.md
    "braids": None,                                  # {"count": 70, "radius": 0.06}: box braids
    "segments": 15,
    "root_bias": 1.5,                                # >1 packs segments near the root; use 1.0 for waves/curls
    "sides": 4,
    "step": 0.10,
    "shade": {"root": 0.30, "mid": 0.55, "tip": 0.70, "jitter": 0.08},
    "texture_size": 1024,
}


def merge(a: dict, b: dict) -> dict:
    out = dict(a)
    for k, v in b.items():
        out[k] = merge(a[k], v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return out


def smooth(e0, e1, x):
    t = np.clip((np.asarray(x, dtype=float) - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def norm(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


# ------------------------------------------------------------------ body model

class Body:
    def __init__(self):
        base = load_base()
        tris = base.groups["body"]
        self.v = base.v
        self.n = vertex_normals(base.v, tris)
        ids = np.unique(tris.ravel())
        # collision set: head, neck, shoulders, back (the arms are outside |x| 1.45 and never reached)
        keep = ids[(base.v[ids, 1] > 0.5) & (np.abs(base.v[ids, 0]) < 1.45)]
        self.cv, self.cn = base.v[keep], self.n[keep]
        # back profile: the most-backward body z per height slice, |x| < 1.35
        ys = np.arange(0.0, 9.01, 0.1)
        bz = []
        for y in ys:
            s = self.cv[(np.abs(self.cv[:, 1] - y) < 0.12) & (np.abs(self.cv[:, 0]) < 1.35)]
            bz.append(s[:, 2].min() if len(s) else 0.0)
        self.back_y, self.back_z = ys, np.array(bz)
        # scalp: the game's hairline (src/render/people/personMesh.ts)
        x, y, z = base.v[ids, 0], base.v[ids, 1], base.v[ids, 2]
        back = smooth(EYE_Z - 0.4, EYE_Z - 1.1, z)
        hairline = EYE_Y + 0.62 - back * 1.55
        ear_band = smooth(EYE_Y - 0.8, EYE_Y - 0.6, y) * (1 - smooth(EYE_Y + 0.2, EYE_Y + 0.35, y))
        ear = ear_band * smooth(0.55, 0.68, np.abs(x)) * (1 - back * 0.6)
        h = smooth(hairline - 0.05, hairline + 0.09, y) * (1 - ear)
        scalp = ids[(h > 0.5) & (y > EYE_Y - 1.2) & (np.abs(x) < 1.2)]
        self.scalp = scalp
        self.sv, self.sn = base.v[scalp], self.n[scalp]

    def back_at(self, y):
        return np.interp(y, self.back_y, self.back_z)

    def push_out(self, p, clear):
        """Move points that are closer than `clear` to the skin (or inside) out along the skin normal."""
        d2 = ((p[:, None, :] - self.cv[None]) ** 2).sum(2)
        j = d2.argmin(1)
        q, n = self.cv[j], self.cn[j]
        depth = ((p - q) * n).sum(1)
        need = depth < clear
        p = p.copy()
        p[need] += n[need] * (clear[need] - depth[need])[:, None]
        return p

    def behind(self, p, clear):
        """Below the jaw: behind the back, inside |x| <= 1.3. Blended in from y 6.6 to 6.0."""
        p = p.copy()
        w = 1 - smooth(6.0, 6.6, p[:, 1])
        zmax = self.back_at(p[:, 1]) - clear
        over = p[:, 2] > zmax
        p[over, 2] = p[over, 2] + (zmax[over] - p[over, 2]) * w[over]
        xl = 1.3
        p[:, 0] = np.where(np.abs(p[:, 0]) > xl, p[:, 0] + (np.sign(p[:, 0]) * xl - p[:, 0]) * w, p[:, 0])
        # the face stays clear: in front of the ears, between the brows and the chin, out to |x| >= 0.62
        face = (p[:, 1] < 7.55) & (p[:, 1] > 6.2) & (p[:, 2] > 0.95) & (np.abs(p[:, 0]) < 0.62)
        sx = np.sign(p[face, 0])
        sx[sx == 0] = 1
        p[face, 0] = sx * 0.62
        return p


# ------------------------------------------------------------------ roots

def sample_roots(body: Body, count: int, rng, region=None):
    """Well-spread scalp vertices (farthest-point sampling over a random pool)."""
    cand = np.arange(len(body.sv))
    if region is not None:
        cand = cand[region(body.sv)]
    if len(cand) == 0:
        return np.zeros((0, 3)), np.zeros((0, 3))
    pool = cand[rng.permutation(len(cand))]
    pick = [pool[0]]
    d = np.linalg.norm(body.sv[pool] - body.sv[pool[0]], axis=1)
    for _ in range(min(count, len(pool)) - 1):
        k = int(d.argmax())
        pick.append(pool[k])
        d = np.minimum(d, np.linalg.norm(body.sv[pool] - body.sv[pool[k]], axis=1))
    pick = np.array(pick)
    return body.sv[pick].copy(), body.sn[pick].copy()


# ------------------------------------------------------------------ guides

def grow(body: Body, roots, normals, d0, tip_y, clear, cfg, max_len=12.0, toward=None):
    """Grow guides from roots. Returns a list of (m,3) polylines. `toward`: gather point to run to first."""
    n = len(roots)
    step = cfg["step"]
    p = roots + normals * clear[:, None]
    d = norm(d0)
    lines = [[r.copy(), q.copy()] for r, q in zip(roots, p)]
    alive = np.ones(n, bool)
    length = np.zeros(n)
    g = np.array([0.0, -1.0, 0.0])
    stiff = cfg["stiffness"]
    for _ in range(int(max_len / step) + 1):
        if not alive.any():
            break
        idx = np.where(alive)[0]
        pd = d[idx]
        if toward is not None:
            pd = norm(pd * 0.5 + norm(toward[idx] - p[idx]) * 0.5)
        else:
            # gravity wins as the strand gets longer; stiffness delays it
            k = (1 - stiff) * 0.35 + 0.05 * (length[idx] > 0.6)
            pd = norm(pd + g * k[:, None])
        np_ = p[idx] + pd * step
        np_ = body.push_out(np_, clear[idx])
        np_ = body.behind(np_, clear[idx])
        d[idx] = norm(np_ - p[idx])
        length[idx] += np.linalg.norm(np_ - p[idx], axis=1)
        p[idx] = np_
        for k_, i in enumerate(idx):
            lines[i].append(np_[k_].copy())
        if toward is not None:
            done = np.linalg.norm(p[idx] - toward[idx], axis=1) < step * 1.5
        else:
            done = (p[idx, 1] <= tip_y[idx]) | (length[idx] >= max_len)
        alive[idx[done]] = False
    # every clump starts just UNDER the skin, so its blunt root end is buried in the scalp
    return [np.vstack([r - nn * 0.03, np.array(l[1:])]) for r, nn, l in zip(roots, normals, lines)]


def resample(line: np.ndarray, m: int, bias: float = 1.6) -> np.ndarray:
    """m points along the line, closer together near the root where the hair bends most."""
    seg = np.linalg.norm(np.diff(line, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    if s[-1] < 1e-6:
        return np.repeat(line[:1], m, axis=0)
    t = np.linspace(0, 1, m) ** bias * s[-1]
    return np.stack([np.interp(t, s, line[:, k]) for k in range(3)], 1)


def frames(line: np.ndarray):
    t = norm(np.gradient(line, axis=0))
    o = line - np.stack([np.zeros(len(line)), line[:, 1], np.full(len(line), HEAD_C[2])], 1)
    o[:, 1] = 0
    # on the head, outward is from the cranium centre; on the back, it is -z
    head = smooth(5.9, 6.6, line[:, 1])[:, None]
    o = norm(norm(line - HEAD_C) * head + np.array([0, 0, -1.0]) * (1 - head))
    o = norm(o - (o * t).sum(1, keepdims=True) * t)
    s = norm(np.cross(t, o))
    return t, o, s


def style_offsets(line, cfg, rng, body: Body, clear):
    """Waves, curls, frizz across the guide; amplitude ramps in over the first fifth."""
    m = len(line)
    if m < 3:
        return line
    t, o, s = frames(line)
    arc = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(line, axis=0), axis=1))])
    ramp = smooth(0.0, max(arc[-1] * 0.2, 0.3), arc)[:, None]
    out = line.copy()
    w = cfg["wave"]
    if w["amp"] > 0:
        ph = rng.uniform(0, 2 * math.pi)
        out += s * (w["amp"] * np.sin(2 * math.pi * arc / w["wavelength"] + ph))[:, None] * ramp
    c = cfg["curl"]
    if c["radius"] > 0:
        ph = rng.uniform(0, 2 * math.pi)
        th = 2 * math.pi * arc / c["period"] + ph
        r = c["radius"] * (0.8 + 0.4 * rng.random())
        out += (s * np.cos(th)[:, None] + o * np.sin(th)[:, None]) * r * ramp
    if cfg["frizz"] > 0:
        out += rng.normal(0, cfg["frizz"], out.shape) * ramp
    out = body.push_out(out, np.full(m, clear))
    out = body.behind(out, np.full(m, clear))
    return out


# ------------------------------------------------------------------ mesh

class Mesh:
    def __init__(self):
        self.v, self.uv, self.f, self.cells = [], [], [], []
        self.root = []          # vertex indices of each clump's first ring (buried in the scalp on purpose)

    def tube(self, line, width, thick, sides, cell, twist=0.0, radial=None):
        """Elliptical tube along `line` (m,3): widths/thicks per ring; tip closed; uv in atlas `cell`."""
        m = len(line)
        if m < 2:
            return
        t, o, s = frames(line)
        base = len(self.v)
        self.root.extend(range(base, base + sides + 1))
        u0, v0, du, dv = cell
        for i in range(m):
            for k in range(sides + 1):
                a = 2 * math.pi * k / sides + twist * i
                rr = 1.0 if radial is None else radial[i]
                p = line[i] + (s[i] * math.cos(a) * width[i] * 0.5 + o[i] * math.sin(a) * thick[i] * 0.5) * rr
                self.v.append(p)
                self.uv.append((u0 + du * k / sides, v0 + dv * (1 - i / (m - 1))))
        for i in range(m - 1):
            for k in range(sides):
                a = base + i * (sides + 1) + k
                b = a + sides + 1
                self.f.append((a, b, a + 1))
                self.f.append((a + 1, b, b + 1))
        # tip: a single vertex the last ring closes onto
        tip = len(self.v)
        self.v.append(line[-1] + t[-1] * min(width[-1], 0.05) * 0.5)
        self.uv.append((u0 + du * 0.5, v0))
        last = base + (m - 1) * (sides + 1)
        for k in range(sides):
            self.f.append((last + k, tip, last + k + 1))
        self.cells.append(cell)


def atlas(n: int, size: int):
    cols = max(1, math.ceil(math.sqrt(n)))
    rows = math.ceil(n / cols)
    m = 4 / size
    cw, ch = 1 / cols, 1 / rows
    return [(c * cw + m, r * ch + m, cw - 2 * m, ch - 2 * m) for r in range(rows) for c in range(cols)][:n]


def paint(cells, shade, size, rng):
    """Greyscale RGBA: per cell, dark root -> light tip, fine strands across u, alpha fading in the last 10%."""
    img = np.zeros((size, size, 4), np.float64)
    img[..., 0:3] = shade["mid"]
    img[..., 3] = 1.0
    for (u0, v0, du, dv) in cells:
        x0, x1 = int(u0 * size), int(math.ceil((u0 + du) * size))
        # OBJ v=0 is the bottom row
        y0, y1 = int((1 - v0 - dv) * size), int(math.ceil((1 - v0) * size))
        h, w = max(1, y1 - y0), max(1, x1 - x0)
        along = np.linspace(0, 1, h)[:, None]           # 0 at the root (top of the cell), 1 at the tip
        across = np.linspace(0, 1, w)[None, :]
        lum = np.interp(along, [0, 0.5, 1], [shade["root"], shade["mid"], shade["tip"]])
        lum = lum + rng.uniform(-shade["jitter"], shade["jitter"])
        freq = rng.uniform(18, 30)
        lum = lum + 0.05 * np.sin(2 * math.pi * freq * across + rng.uniform(0, 6.28)) * np.ones_like(along)
        alpha = 1 - 0.4 * smooth(0.9, 1.0, along) * np.ones_like(across)
        img[y0:y1, x0:x1, 0:3] = np.clip(lum, 0, 1)[..., None]
        img[y0:y1, x0:x1, 3] = alpha
    return (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)


# ------------------------------------------------------------------ styles

def taper(m, w0, w1, pinch=0.0):
    s = np.linspace(0, 1, m)
    w = w0 + (w1 - w0) * s ** 1.2
    if pinch:
        w *= 1 - pinch * smooth(0.85, 1.0, s)
    return w


def loose_roots(body, cfg, rng, count, region=None):
    """Roots and their starting directions: LAID ALONG the scalp, away from the part on top, down at the back."""
    roots, normals = sample_roots(body, count, rng, region)
    part = cfg["part"]
    px = part.get("x", 0.0) if part["type"] != "none" else None
    x, y, z = roots[:, 0], roots[:, 1], roots[:, 2]
    front = smooth(0.6, 1.2, z)                     # 1 at the forehead
    top = smooth(7.6, 8.3, y) * smooth(-0.3, 0.4, z)  # the part only steers the top and front of the head
    want = np.tile(np.array([0.0, -1.0, 0.0]), (len(roots), 1))
    want[:, 2] -= 0.9 * front                       # the front is combed back
    if px is not None:
        side = np.sign(x - px)
        side[side == 0] = 1
        want[:, 0] += side * 1.4 * top
    # project onto the scalp: hair leaves the head almost tangentially
    tang = want - (want * normals).sum(1, keepdims=True) * normals
    d0 = norm(tang) + normals * 0.15
    L = cfg["length"]
    tip = np.interp(z, [-1.0, 0.5, 1.6], [L["back_y"], L["side_y"], L["front_y"]])
    tip = tip - (8.5 - tip) * cfg["layers"] * rng.uniform(-1, 1, len(tip))
    return roots, normals, d0, tip


def safety_pass(body: Body, v: np.ndarray, root: np.ndarray) -> np.ndarray:
    """The game's rules, enforced on the FINISHED surface (a clump's width can spill past its centre line):
    behind the shoulders and inside |x| 1.33 below y 6.0, the face clear, nothing inside the skin."""
    v = v.copy()
    free = np.ones(len(v), bool)
    free[root] = False
    for _ in range(2):
        idx = np.where(free)[0]
        v[idx] = body.push_out(v[idx], np.full(len(idx), 0.012))
        low = v[:, 1] < 6.05
        v[low, 0] = np.clip(v[low, 0], -1.33, 1.33)
        v[low, 2] = np.minimum(v[low, 2], 0.18)
        face = (v[:, 1] > 6.15) & (v[:, 1] < 7.6) & (v[:, 2] > 0.9) & (np.abs(v[:, 0]) < 0.61)
        sx = np.sign(v[face, 0])
        sx[sx == 0] = 1
        v[face, 0] = sx * 0.61
    v[:, 1] = np.maximum(v[:, 1], 1.25)
    return v


def build(cfg: dict, body: Body) -> Mesh:
    rng = np.random.default_rng(cfg["seed"])
    seg, sides = cfg["segments"], cfg["sides"]
    guides, widths, thicks, kinds = [], [], [], []

    gather = cfg["gather"]
    bangs = cfg["bangs"]
    braids = cfg["braids"]
    n = cfg["clumps"]

    def bang_region(v):
        return (v[:, 2] > 0.95) & (np.abs(v[:, 0]) < 0.6) & (v[:, 1] > 7.7)

    def not_bang(v):
        return ~bang_region(v) if bangs else np.ones(len(v), bool)

    loose_region = not_bang
    if gather and gather["type"] == "halfup":
        top_y = gather.get("top_y", 7.95)
        loose_region = lambda v: not_bang(v) & (v[:, 1] < top_y)  # noqa: E731

    if braids:
        # box braids: many thin round tubes from a spread of roots, falling with volume
        roots, normals, d0, tip = loose_roots(body, cfg, rng, braids["count"], loose_region)
        clear = cfg["clearance"] + rng.uniform(0, cfg["volume"], len(roots))
        lines = grow(body, roots, normals, d0, tip, clear, cfg)
        r = braids["radius"]
        for ln in lines:
            ln = resample(ln, seg)
            guides.append(ln)
            widths.append(np.full(seg, 2 * r))
            thicks.append(np.full(seg, 2 * r))
            kinds.append("braid")
    elif not gather or gather["type"] == "halfup":
        # GUIDES are simulated; CHILD clumps follow their three nearest guides, so neighbouring hair
        # flows together instead of every clump wandering on its own.
        n_guides = max(12, n // 3)
        groots, gnormals, gd0, gtip = loose_roots(body, cfg, rng, n_guides, loose_region)
        gclear = np.full(len(groots), cfg["clearance"] + cfg["volume"] * 0.5)
        glines = [resample(l, seg) for l in grow(body, groots, gnormals, gd0, gtip, gclear, cfg)]
        G = np.stack(glines)                        # (g, seg, 3)
        roots, normals, _, _ = loose_roots(body, cfg, rng, n, loose_region)
        layer = rng.random(len(roots))
        clear = cfg["clearance"] + layer * cfg["volume"]
        d = np.linalg.norm(roots[:, None] - groots[None], axis=2)
        near = np.argsort(d, axis=1)[:, :3]
        w = 1 / np.maximum(np.take_along_axis(d, near, 1), 0.05) ** 2
        w /= w.sum(1, keepdims=True)
        shape = (G[near] - G[near][:, :, :1]) * w[:, :, None, None]
        lines = roots[:, None, :] + normals[:, None, :] * clear[:, None, None] + shape.sum(1)
        lines[:, 0] = roots - normals * 0.03          # buried root, as in grow()
        # each child keeps its own length (layers)
        own_tip = np.take_along_axis(gtip[near], np.zeros((len(roots), 1), int), 1)[:, 0]
        own_tip = own_tip - (8.5 - own_tip) * cfg["layers"] * rng.uniform(-1, 1, len(own_tip))
        for ln, c, ty in zip(lines, clear, own_tip):
            ln = body.behind(body.push_out(ln, np.full(len(ln), c)), np.full(len(ln), c))
            below = np.where(ln[:, 1] < ty)[0]
            if len(below) and below[0] > 2:
                ln = ln[:below[0] + 1]
            ln = style_offsets(resample(ln, seg, cfg["root_bias"]), cfg, rng, body, c)
            guides.append(ln)
            widths.append(taper(seg, cfg["width"][0], cfg["width"][1], pinch=0.6))
            thicks.append(taper(seg, cfg["thickness"], cfg["thickness"] * 0.5))
            kinds.append("loose")

    if gather:
        g = np.array(gather["point"], dtype=float)
        if gather["type"] == "halfup":
            region = lambda v: not_bang(v) & (v[:, 1] >= gather.get("top_y", 7.95))  # noqa: E731
        else:
            region = not_bang
        cnt = gather.get("scalp_clumps", 90)
        roots, normals = sample_roots(body, cnt, rng, region)
        clear = np.full(len(roots), cfg["clearance"] * 0.6)
        tw = np.repeat(g[None], len(roots), 0)
        lines = grow(body, roots, normals, norm(g - roots), np.zeros(len(roots)), clear, cfg, max_len=6, toward=tw)
        for ln in lines:
            ln = resample(np.vstack([ln, g]), max(6, seg // 2))
            guides.append(ln)
            widths.append(taper(len(ln), 0.30, 0.10))
            thicks.append(np.full(len(ln), 0.03))
            kinds.append("scalp")
        tdir = norm(np.array(gather.get("dir", [0, -0.4, -1.0]), dtype=float))
        # the tie: a ring round the gather point
        ring_r = gather.get("tie_radius", 0.16)
        a = np.linspace(0, 2 * math.pi, 13)
        o = norm(np.cross(tdir, [1.0, 0, 0]))
        s_ = np.cross(tdir, o)
        ring = g + (np.outer(np.cos(a), o) + np.outer(np.sin(a), s_)) * ring_r
        guides.append(ring)
        widths.append(np.full(13, 0.07))
        thicks.append(np.full(13, 0.07))
        kinds.append("tie")
        if gather["type"] == "ponytail":
            tc = gather.get("tail_clumps", 40)
            disk = rng.normal(0, 1, (tc, 2)) * ring_r * 0.5
            starts = g + tdir * 0.05 + disk[:, :1] * o + disk[:, 1:] * s_
            normals_t = np.repeat(tdir[None], tc, 0)
            tip = np.full(tc, gather.get("end_y", 4.2)) - rng.uniform(0, 0.4, tc)
            clear = cfg["clearance"] + rng.uniform(0, 0.12, tc)
            sub = dict(cfg, stiffness=gather.get("stiffness", 0.75))
            lines = grow(body, starts, normals_t * 0, normals_t + rng.normal(0, 0.15, (tc, 3)), tip, clear, sub)
            for st, ln, c in zip(starts, lines, clear):
                ln = style_offsets(resample(np.vstack([st[None], ln]), seg, cfg["root_bias"]), cfg, rng, body, c)
                guides.append(ln)
                widths.append(taper(seg, gather.get("tail_width", 0.24), 0.07, pinch=0.5))
                thicks.append(taper(seg, 0.06, 0.03))
                kinds.append("tail")
        elif gather["type"] == "braid":
            end_y = gather.get("end_y", 3.2)
            lines = grow(body, g[None], tdir[None] * 0, tdir[None], np.array([end_y]), np.array([cfg["clearance"] + 0.12]),
                         dict(cfg, stiffness=0.7))
            c = resample(lines[0], 60)
            t, o2, s2 = frames(c)
            arc = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(c, axis=0), axis=1))])
            r0 = gather.get("braid_width", 0.42)
            rad = r0 * (1 - 0.45 * arc / arc[-1])
            om = 2 * math.pi / gather.get("braid_period", 0.55)
            for i in range(3):
                ph = 2 * math.pi * i / 3
                line = c + s2 * (rad * 0.5 * np.sin(om * arc + ph))[:, None] + o2 * (rad * 0.18 * np.sin(2 * (om * arc + ph)))[:, None]
                guides.append(line)
                widths.append(rad * 0.62)
                thicks.append(rad * 0.42)
                kinds.append("braid3")
            # a small tuft below the end tie
            tuft_start = c[-1]
            tl = resample(np.vstack([tuft_start, tuft_start + np.array([0, -0.5, -0.05])]), 8)
            for j in range(5):
                off = np.array([rng.normal(0, 0.05), 0, rng.normal(0, 0.03)])
                guides.append(tl + off * np.linspace(0, 1, 8)[:, None] * 3)
                widths.append(taper(8, 0.10, 0.03))
                thicks.append(np.full(8, 0.04))
                kinds.append("tuft")
            a = np.linspace(0, 2 * math.pi, 11)
            tdir2 = norm(c[-1] - c[-2])
            o3 = norm(np.cross(tdir2, [1.0, 0, 0]))
            s3 = np.cross(tdir2, o3)
            guides.append(c[-1] + (np.outer(np.cos(a), o3) + np.outer(np.sin(a), s3)) * rad[-1] * 0.45)
            widths.append(np.full(11, 0.05))
            thicks.append(np.full(11, 0.05))
            kinds.append("tie")
        elif gather["type"] == "halfup":
            # a small bun: a coil of a thick tube round the gather point
            turns, r_out, r_in = 2.3, gather.get("bun_radius", 0.26), 0.06
            k = np.linspace(0, 1, 70)
            ang = 2 * math.pi * turns * k
            r = r_out + (r_in - r_out) * k
            bun = g + np.outer(r * np.cos(ang), o) + np.outer(r * np.sin(ang), s_) + np.outer(k * 0.12, tdir * -1)
            guides.append(bun)
            widths.append(np.full(70, 0.17))
            thicks.append(np.full(70, 0.12))
            kinds.append("bun")

    if bangs:
        cnt = bangs.get("clumps", 26)
        roots, normals = sample_roots(body, cnt, rng, bang_region)
        side = np.sign(roots[:, 0])
        side[side == 0] = 1
        lat = np.zeros_like(roots)
        if bangs["type"] == "curtain":
            lat[:, 0] = side * 0.9
        want = np.array([0, -1.0, 0.35]) + lat
        d0 = norm(want - (want * normals).sum(1, keepdims=True) * normals) + normals * 0.2
        tip = np.full(len(roots), bangs.get("end_y", 7.65))
        if bangs["type"] == "curtain":
            tip = tip - 0.6 * smooth(0.1, 0.5, np.abs(roots[:, 0]))  # longer towards the temples
        clear = np.full(len(roots), cfg["clearance"]) + rng.uniform(0, 0.05, len(roots))
        lines = grow(body, roots, normals, d0, tip, clear, dict(cfg, stiffness=0.45), max_len=2.2)
        for ln, c in zip(lines, clear):
            ln = resample(ln, max(6, seg // 2))
            guides.append(ln)
            widths.append(taper(len(ln), 0.22, 0.08))
            thicks.append(taper(len(ln), 0.05, 0.025))
            kinds.append("bangs")

    mesh = Mesh()
    cells = atlas(len(guides), cfg["texture_size"])
    for ln, w, t, kind, cell in zip(guides, widths, thicks, kinds, cells):
        if kind == "braid":
            # a box braid: three-lobed, twisting surface
            s = np.linspace(0, 1, len(ln))
            radial = 1 + 0.18 * np.abs(np.sin(2 * math.pi * s * np.linalg.norm(np.diff(ln, axis=0), axis=1).sum() / 0.12))
            mesh.tube(ln, w, t, sides, cell, twist=0.6, radial=radial)
        elif kind in ("tie", "bun", "braid3"):
            mesh.tube(ln, w, t, max(sides, 6), cell)
        else:
            mesh.tube(ln, w, t, sides, cell)
    mesh.v = safety_pass(body, np.asarray(mesh.v), np.asarray(mesh.root, dtype=np.int64))
    mesh.texture = paint(cells, cfg["shade"], cfg["texture_size"], rng)
    mesh.kinds = kinds
    return mesh


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()
    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    cfg = merge(DEFAULTS, spec)
    name = cfg["name"]
    body = Body()
    mesh = build(cfg, body)
    out = args.out / name
    out.mkdir(parents=True, exist_ok=True)
    v = np.asarray(mesh.v)
    f = np.asarray(mesh.f, dtype=np.int64)
    # drop degenerate triangles
    area = np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1)
    f = f[area > 1e-9]
    write_obj(out / f"{name}.obj", v, np.asarray(mesh.uv), f, name)
    write_png(out / f"{name}_diffuse.png", mesh.texture)
    (out / f"{name}.spec.json").write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    from collections import Counter
    print(json.dumps({"name": name, "vertices": len(v), "triangles": int(len(f)), "clumps": dict(Counter(mesh.kinds)),
                      "bboxDm": [v.min(0).round(2).tolist(), v.max(0).round(2).tolist()]}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
