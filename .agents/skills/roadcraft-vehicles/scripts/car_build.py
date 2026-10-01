"""Build a car from a JSON spec, in Blender, and export it as the game's .glb.

    blender -b --factory-startup -P car_build.py -- --spec <spec.json> --out <dir>

The body is ONE closed surface lofted through cross-sections that all have the same 36 points, so it
cannot have holes, open seams or dents:
  - side profile: roof, windscreen, bonnet, boot as smooth monotone curves through key heights;
  - plan: rounded corners at both ends;
  - section: sill, lower side (with a slight bulge), shoulder, glass leaning in (tumblehome), roof;
  - wheel arches are part of the surface (the underbody rises over each wheel), so there is no cut;
  - glass, pillars, shut lines and the underbody are REGIONS of that surface (materials), never cuts;
  - doors are the door regions copied out onto hinge pivots, edge to edge with the body.
Everything else (bumpers, lamps, grille, mirrors, handles, interior, wheels) are closed volumes.
Frame: game/glTF (x = left, y = up, z = forward, metres); converted to Blender (x, -z, y) on output.
"""
import json
import math
import sys
from pathlib import Path

import bmesh  # type: ignore
import bpy  # type: ignore
import numpy as np
from mathutils import Matrix, Vector  # type: ignore

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    return ARGS[ARGS.index(name) + 1] if name in ARGS else default


# ---------------------------------------------------------------- spec defaults (a sedan)

DEFAULT = {
    "name": "sedan_01", "kind": "sedan",
    "length": 4.70, "width": 1.84, "height": 1.45,
    "wheelbase": 2.75, "front_overhang": 0.95,
    "wheel": {"radius": 0.32, "width": 0.22, "rim": 0.66, "spokes": 5, "inset": 0.03},
    "clearance": 0.16, "arch_gap": 0.05, "arch_flare": 0.02,
    # heights (m) at distances from the FRONT tip (m)
    "profile": {
        "nose_y": 0.62, "hood_front_y": 0.80, "hood_rear_y": 0.98, "cowl_d": 1.55,
        "roof_front_d": 2.25, "roof_rear_d": 3.20, "deck_d": 3.80, "deck_y": 1.03, "tail_y": 0.99,
        "front_bottom_y": 0.30, "rear_bottom_y": 0.36,
        "belt_front_y": 0.98, "belt_rear_y": 1.03,
    },
    "plan": {"corner_front": 0.32, "corner_rear": 0.26, "taper_front": 0.05, "taper_rear": 0.03},
    "section": {"roof_width": 0.74, "shoulder_inset": 0.06, "bulge": 0.025, "sill_inset": 0.03,
                "roof_crown": 0.035, "hood_crown": 0.03},
    "pillars": {"a": 0.08, "b": 0.10, "c": 0.20},
    "doors": 4,
    "lamps": {"head": [0.36, 0.12], "tail": [0.38, 0.13], "head_y": 0.70, "tail_y": 0.80, "head_x": 0.62},
    "bumpers": {"height": 0.20, "protrude": 0.04, "front_y": 0.40, "rear_y": 0.45},
    "grille": {"width": 0.62, "height": 0.13},
    "seats": {"hip_y": 0.52, "front_d": 2.35, "rear_d": 3.15, "x": 0.37},
}


def merge(a, b):
    out = dict(a)
    for k, v in b.items():
        out[k] = merge(a[k], v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return out


def pchip(xs, ys):
    """Monotone cubic interpolation (Fritsch-Carlson): smooth, never overshoots the key heights."""
    xs, ys = np.asarray(xs, float), np.asarray(ys, float)
    h = np.diff(xs)
    d = np.diff(ys) / h
    m = np.zeros_like(ys)
    m[0], m[-1] = d[0], d[-1]
    for i in range(1, len(xs) - 1):
        if d[i - 1] * d[i] <= 0:
            m[i] = 0
        else:
            w1, w2 = 2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])

    def f(x):
        x = np.clip(np.asarray(x, float), xs[0], xs[-1])
        i = np.clip(np.searchsorted(xs, x) - 1, 0, len(xs) - 2)
        t = (x - xs[i]) / h[i]
        h00, h10, h01, h11 = 2 * t**3 - 3 * t**2 + 1, t**3 - 2 * t**2 + t, -2 * t**3 + 3 * t**2, t**3 - t**2
        return h00 * ys[i] + h10 * h[i] * m[i] + h01 * ys[i + 1] + h11 * h[i] * m[i + 1]
    return f


# ---------------------------------------------------------------- body

HALF = 19          # points per half section, bottom centre to top centre
RING = 2 * HALF - 2


class Car:
    def __init__(self, s):
        self.s = s
        L, W = s["length"], s["width"]
        P = s["profile"]
        bp = s["bumpers"]["protrude"]
        self.d0, self.d1 = bp, L - bp                  # body ends (the bumpers make up the length)
        self.L, self.W = L, W
        self.mid_d = s["front_overhang"] + s["wheelbase"] / 2
        self.wf, self.wr = s["front_overhang"], s["front_overhang"] + s["wheelbase"]
        R = s["wheel"]["radius"]
        self.Ra = R + s["arch_gap"]
        d0, d1 = self.d0, self.d1
        H = s["height"]
        self.top = pchip([d0, d0 + 0.14, P["cowl_d"], P["roof_front_d"], P["roof_rear_d"], P["deck_d"], d1 - 0.14, d1],
                         [P["nose_y"], P["hood_front_y"], P["hood_rear_y"], H - s["section"]["roof_crown"],
                          H - s["section"]["roof_crown"], P["deck_y"], P["tail_y"], P["tail_y"] - 0.05])
        self.belt = pchip([d0, P["cowl_d"], P["deck_d"], d1],
                          [P["nose_y"] - 0.02, P["belt_front_y"], P["belt_rear_y"], P["tail_y"] - 0.06])
        self.bot = pchip([d0, d0 + 0.45, d1 - 0.45, d1],
                         [P["front_bottom_y"], s["clearance"], s["clearance"], P["rear_bottom_y"]])

    def plan(self, d):
        pl = self.s["plan"]
        # the plan is narrower than the car by what sits outside it (arch flare + side bulge, or the
        # bumper corners), so the finished car is exactly `width` wide
        sc, bp = self.s["section"], self.s["bumpers"]
        hw = self.W / 2 - max(self.s["arch_flare"] + sc["bulge"] * 0.9, bp["protrude"]) - 0.006
        rf, rr = pl["corner_front"], pl["corner_rear"]
        x = np.full_like(np.asarray(d, float), hw)
        a = d - self.d0
        b = self.d1 - d
        x = np.where(a < rf, hw - rf + np.sqrt(np.clip(rf**2 - (rf - a) ** 2, 0, None)), x)
        x = np.where(b < rr, hw - rr + np.sqrt(np.clip(rr**2 - (rr - b) ** 2, 0, None)), x)
        x -= pl["taper_front"] * np.clip(1 - a / 1.2, 0, 1) + pl["taper_rear"] * np.clip(1 - b / 1.2, 0, 1)
        return np.maximum(x, 0.12)

    def bottom(self, d):
        y = self.bot(d)
        R = self.s["wheel"]["radius"]
        for dw in (self.wf, self.wr):
            u = (d - dw) / self.Ra
            arch = R + self.Ra * np.sqrt(np.clip(1 - u * u, 0, None))
            y = np.where(np.abs(u) < 1, np.maximum(y, arch), y)
        return y

    def flare(self, d):
        f = 0.0
        for dw in (self.wf, self.wr):
            f = f + self.s["arch_flare"] * np.exp(-(((d - dw) / (self.Ra * 1.1)) ** 2) * 2)
        return f

    def section(self, d):
        """HALF points (x >= 0) from the bottom centre to the top centre; returns (HALF, 2)."""
        sc = self.s["section"]
        w = float(self.plan(d)) + float(self.flare(d))
        f = w / (self.W / 2)
        yb, yt = float(self.bottom(d)), float(self.top(d))
        belt = min(float(self.belt(d)), yt - 0.012)
        yt = max(yt, belt + 0.012)
        wb = w - sc["sill_inset"] * f
        wg = w - sc["shoulder_inset"] * f
        hcab = self.s["height"] - belt
        g = np.clip((yt - belt) / max(hcab, 1e-3), 0, 1)
        wt = wg + (sc["roof_width"] * self.W / 2 * f - wg) * g
        rb = min(0.07, (belt - yb) * 0.3)
        rs = min(0.035, (belt - yb) * 0.2)
        rt = min(0.07, max((yt - belt) * 0.45, 0.004))
        crown = sc["roof_crown"] * g + sc["hood_crown"] * (1 - g)
        pts = [(0, yb), (0.5 * (wb - rb), yb), (wb - rb, yb)]
        for a in (-60, -30):
            t = math.radians(a)
            pts.append((wb - rb + rb * math.cos(t), yb + rb + rb * math.sin(t)))
        p5, p8 = np.array([wb, yb + rb]), np.array([w, belt - rs])
        for t in (1 / 3, 2 / 3):
            q = p5 + (p8 - p5) * t
            pts.append((q[0] + sc["bulge"] * f * math.sin(math.pi * t), q[1]))
        pts = [pts[0], pts[1], pts[2], pts[3], pts[4], tuple(p5), pts[5], pts[6], tuple(p8)]
        t = math.radians(45)
        pts.append((w - rs + rs * math.cos(t), belt - rs + rs * math.sin(t)))
        pts.append((w - rs, belt))
        wg = min(wg, w - rs - 0.02)
        pts.append((wg, belt + 0.01))
        top_side = np.array([wt, max(yt - rt, belt + 0.01)])
        base = np.array([wg, belt + 0.01])
        pts.append(tuple(base + (top_side - base) * 0.5))
        pts.append(tuple(top_side))
        pts.append((wt - rt + rt * math.cos(t), yt - rt + rt * math.sin(t)))
        pts.append((wt - rt, yt))
        for k in (0.85, 0.45):
            x = (wt - rt) * k
            pts.append((x, yt + crown * (1 - k * k)))
        pts.append((0, yt + crown))
        pts = np.array(pts)
        # where a band collapses (the glass at the bonnet), its points become EXACTLY one point: the
        # faces between them vanish instead of shading as slivers
        for i in range(1, len(pts)):
            if np.linalg.norm(pts[i] - pts[i - 1]) < 0.015:
                pts[i] = pts[i - 1]
        return pts

    def stations(self):
        s, P, pi = self.s, self.s["profile"], self.s["pillars"]
        d = list(np.arange(self.d0, self.d1, max(0.17, self.L / 28))) + [self.d1]
        for dw in (self.wf, self.wr):
            d += list(dw + self.Ra * np.sin(np.linspace(-math.pi / 2, math.pi / 2, 9)))
            d += [dw - self.Ra - 0.02, dw + self.Ra + 0.02]
        d += [self.d0 + 0.09, self.d1 - 0.09]
        d += [P["cowl_d"], P["roof_front_d"], P["roof_rear_d"], P["deck_d"]]
        self.windows = self._windows()
        for a, b in self.windows:
            d += [a, b]
        protect = []
        for e in self.door_edges():
            protect += [e - 0.006, e + 0.006]
        d = sorted(set(round(x, 4) for x in d if self.d0 <= x <= self.d1))
        out = []
        for x in d:
            if out and x - out[-1] < 0.045 and not any(abs(x - p) < 1e-4 for p in protect):
                continue
            out.append(x)
        out = sorted(set(out + [round(p, 4) for p in protect]))
        # drop any non-protected station closer than 1 cm to a protected one
        out = [x for x in out if any(abs(x - p) < 1e-4 for p in protect) or min([abs(x - p) for p in protect] or [1]) > 0.015]
        return np.array(out)

    def _windows(self):
        P, pi = self.s["profile"], self.s["pillars"]
        a0 = P["cowl_d"] + pi["a"]
        c1 = P["deck_d"] - pi["c"] if self.s["kind"] not in ("hatch", "suv", "van") else P["roof_rear_d"] - pi["c"] * 0.3
        if self.s["doors"] >= 4:
            b = self.b_pillar()
            return [(a0, b - pi["b"] / 2), (b + pi["b"] / 2, c1)]
        return [(a0, c1)]

    def b_pillar(self):
        P = self.s["profile"]
        return P.get("b_pillar_d", (P["roof_front_d"] + P["roof_rear_d"]) / 2 + 0.05)

    def door_edges(self):
        P = self.s["profile"]
        front = max(P["cowl_d"] - 0.02, self.wf + self.Ra + 0.04)
        rear = self.wr - self.Ra - 0.04
        if self.s["doors"] >= 4:
            return [front, self.b_pillar(), rear]
        return [front, min(rear, self.b_pillar() + 0.35)]

    def build(self):
        D = self.stations()
        rings = []
        for d in D:
            h = self.section(d)
            full = np.vstack([h, h[-2:0:-1] * [-1, 1]])     # 36 points, x >= 0 then mirrored
            z = self.mid_d - d
            rings.append(np.column_stack([full[:, 0], full[:, 1], np.full(len(full), z)]))
        rings = np.array(rings)
        self.D = D
        return rings


def segment_of(k):
    """Half-section quad index (0..17) for ring quad k (0..35)."""
    return k if k < HALF - 1 else (RING - 1 - k)


def body_mesh(car):
    rings = car.build()
    m, n = rings.shape[:2]
    V = rings.reshape(-1, 3)
    D = car.D
    P = car.s["profile"]
    wins = car.windows
    edges = car.door_edges()
    doors = list(zip(edges[:-1], edges[1:]))
    faces, mats, owner = [], [], []
    for i in range(m - 1):
        dmid = (D[i] + D[i + 1]) / 2
        cab = (car.top(dmid) - car.belt(dmid)) > 0.18
        for k in range(n):
            a, b = i * n + k, i * n + (k + 1) % n
            f = (a, a + n, b + n, b)                               # outward-facing
            sgm = segment_of(k)
            left = k < HALF - 1
            mat = "paint"
            if sgm <= 1:
                mat = "trim"                                       # underbody, wheel-well roofs
            elif sgm in (11, 12) and cab and any(w0 <= dmid <= w1 for w0, w1 in wins):
                mat = "glass"
            elif sgm in (16, 17) and (P["cowl_d"] <= dmid <= P["roof_front_d"] or P["roof_rear_d"] <= dmid <= P["deck_d"]):
                mat = "glass"
            if 5 <= sgm <= 12 and any(abs(dmid - e) < 0.0061 for e in edges):
                mat = "trim"                                       # shut line: a dark groove, never a gap
            own = None
            if 5 <= sgm <= 12:
                for j, (e0, e1) in enumerate(doors):
                    if e0 + 0.006 <= dmid <= e1 - 0.006:
                        own = ("door", j, "L" if left else "R")
            faces.append(f)
            mats.append(mat)
            owner.append(own)
    # end caps (bumper faces): a fan bulging forwards / backwards
    V = list(V)
    for ring, sign in ((0, 1), (m - 1, -1)):
        ids = [ring * n + k for k in range(n)]
        n_cap = n
        c = np.mean([V[i] for i in ids], axis=0) + np.array([0, 0, 0.015 * sign])
        ci = len(V)
        V.append(c)
        for k in range(n_cap):
            a, b = ids[k], ids[(k + 1) % n_cap]
            faces.append((ci, a, b) if sign > 0 else (ci, b, a))
            mats.append("paint")
            owner.append(None)
    return np.array(V), faces, mats, owner


def inner_shell(car):
    """The cabin interior: the body's sections shrunk inward, closed; seen through the glass."""
    P = car.s["profile"]
    sel = [d for d in car.D if P["cowl_d"] + 0.02 <= d <= P["deck_d"] - 0.02]
    if len(sel) < 2:
        return None
    rings = []
    for d in sel:
        h = car.section(d)
        full = np.vstack([h, h[-2:0:-1] * [-1, 1]])[::3]
        c = full.mean(0)
        rel = full - c
        r = np.linalg.norm(rel, axis=1, keepdims=True)
        full = c + rel * np.clip((r - 0.07) / np.maximum(r, 1e-6), 0.2, 1)
        rings.append(np.column_stack([full[:, 0], full[:, 1], np.full(len(full), car.mid_d - d)]))
    rings = np.array(rings)
    m, n = rings.shape[:2]
    V = list(rings.reshape(-1, 3))
    F = []
    for i in range(m - 1):
        for k in range(n):
            a, b = i * n + k, i * n + (k + 1) % n
            F.append((a, a + n, b + n, b))
    for ring, sign in ((0, 1), (m - 1, -1)):
        ids = [ring * n + k for k in range(n)]
        ci = len(V)
        V.append(np.mean([V[i] for i in ids], axis=0))
        for k in range(n):
            a, b = ids[k], ids[(k + 1) % n]
            F.append((ci, a, b) if sign > 0 else (ci, b, a))
    return np.array(V), F


# ---------------------------------------------------------------- small volumes

def rounded_box(size, p=5.0, nu=8, nv=4):
    """Superellipsoid centred at 0; size = (x, y, z) full extents."""
    e = 2 / p
    sp = lambda x, k: np.sign(x) * np.abs(x) ** k  # noqa: E731
    us = np.linspace(-math.pi, math.pi, nu, endpoint=False)
    vs = np.linspace(-math.pi / 2, math.pi / 2, nv + 1)[1:-1]
    V = []
    for v in vs:
        for u in us:
            V.append([sp(math.cos(v), e) * sp(math.cos(u), e) * size[0] / 2, sp(math.sin(v), e) * size[1] / 2,
                      sp(math.cos(v), e) * sp(math.sin(u), e) * size[2] / 2])
    F = []
    rows = len(vs)
    for i in range(rows - 1):
        for k in range(nu):
            a, b = i * nu + k, i * nu + (k + 1) % nu
            F.append((a, a + nu, b + nu, b))
    bot, top = len(V), len(V) + 1
    V += [[0, -size[1] / 2, 0], [0, size[1] / 2, 0]]
    for k in range(nu):
        F.append((bot, k, (k + 1) % nu))
        a = (rows - 1) * nu
        F.append((top, a + (k + 1) % nu, a + k))
    return np.array(V), F


def box(size):
    """A plain closed cuboid centred at 0 (outward faces)."""
    x, y, z = (np.asarray(size, float) / 2)
    V = np.array([[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]])
    F = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (0, 4, 7, 3)]
    return V, F


def lathe(profile, segs=20):
    """Revolve (r, x) profile points round the X axis. Returns V, F."""
    V, F = [], []
    n = len(profile)
    for s in range(segs):
        a = 2 * math.pi * s / segs
        for r, x in profile:
            V.append([x, r * math.cos(a), r * math.sin(a)])
    for s in range(segs):
        for i in range(n - 1):
            a = s * n + i
            b = ((s + 1) % segs) * n + i
            F.append((a, b, b + 1, a + 1))
    return np.array(V), F


def wheel_parts(w):
    """Tyre and rim of a wheel centred at 0, outer face towards +X. Returns [(V, F, mats)]."""
    R, Wd = w["radius"], w["width"]
    rr = R * w["rim"]
    hw = Wd / 2
    tyre = [(rr, -hw + 0.01), (R - 0.03, -hw), (R, -hw + 0.06), (R, hw - 0.06), (R - 0.03, hw), (rr, hw - 0.01)]
    Vt, Ft = lathe(tyre, 16)
    # rim: an outer dish with spokes (alternating materials) and a closed back, so nothing shows through
    segs = 3 * w["spokes"]
    dish = [(rr, hw - 0.015), (rr * 0.88, hw - 0.04), (rr * 0.3, hw - 0.025), (0.0, hw - 0.005)]
    Vr, Fr = lathe(dish, segs)
    mr = []
    n = len(dish)
    for s in range(segs):
        for i in range(n - 1):
            spoke = (s % 3) == 0
            mr.append("rim" if (i != 1 or spoke) else "trim")
    back = [(0.0, -hw + 0.02), (rr, -hw + 0.02), (rr, hw - 0.015)]
    Vb, Fb = lathe(back, 10)
    return [(Vt, Ft, ["tire"] * len(Ft)), (Vr, Fr, mr), (Vb, Fb, ["trim"] * len(Fb))]


# ---------------------------------------------------------------- Blender output

MATS = {
    "paint": ((1, 1, 1, 1), 0.6, 0.35), "glass": ((0.10, 0.13, 0.16, 0.85), 0.0, 0.05),
    "trim": ((0.02, 0.022, 0.025, 1), 0.0, 0.8), "chrome": ((0.72, 0.75, 0.79, 1), 1.0, 0.15),
    "tire": ((0.011, 0.011, 0.011, 1), 0.0, 0.9), "rim": ((0.55, 0.57, 0.6, 1), 1.0, 0.3),
    "lamp_head": ((0.85, 0.9, 1.0, 1), 0.0, 0.1), "lamp_tail": ((0.5, 0.01, 0.015, 1), 0.0, 0.2),
    "lamp_turn": ((1.0, 0.35, 0.02, 1), 0.0, 0.2), "interior": ((0.035, 0.04, 0.045, 1), 0.0, 0.9),
}


def material(name):
    m = bpy.data.materials.get(name)
    if m:
        return m
    rgba, metal, rough = MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = rgba
    p.inputs["Metallic"].default_value = metal
    p.inputs["Roughness"].default_value = rough
    if rgba[3] < 1:
        p.inputs["Alpha"].default_value = rgba[3]
        m.surface_render_method = "BLENDED"
    if name.startswith("lamp"):
        p.inputs["Emission Color"].default_value = rgba
        p.inputs["Emission Strength"].default_value = 0.0
    m.diffuse_color = rgba if name != "paint" else (0.18, 0.33, 0.58, 1)
    return m


def to_b(p):
    p = np.asarray(p, float)
    return np.stack([p[..., 0], -p[..., 2], p[..., 1]], -1)


WORLD = {}   # object name -> world position (game coords); Blender's matrix_world is stale until an update


def empty(name, loc, parent=None):
    o = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(o)
    loc = np.asarray(loc, float)
    WORLD[o.name] = loc
    rel = loc - (WORLD[parent.name] if parent else 0)
    if parent:
        o.parent = parent
    o.location = Vector(to_b(rel).tolist())
    return o


def mesh(name, V, F, mats, parent=None, origin=(0, 0, 0), sharp_deg=38):
    """Mesh in game coordinates, local to `origin` (game coords), parented."""
    names = sorted(set(mats))
    me = bpy.data.meshes.new(name)
    Vb = to_b(np.asarray(V) - np.asarray(origin))
    me.from_pydata(Vb.tolist(), [], [list(f) for f in F])
    for nm in names:
        me.materials.append(material(nm))
    idx = {nm: i for i, nm in enumerate(names)}
    for poly, m in zip(me.polygons, mats):
        poly.material_index = idx[m]
        poly.use_smooth = True
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-6, edges=bm.edges)
    lim = math.radians(sharp_deg)
    for e in bm.edges:
        if len(e.link_faces) == 2:
            f0, f1 = e.link_faces
            if f0.material_index != f1.material_index or e.calc_face_angle(0) > lim:
                e.smooth = False
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    origin = np.asarray(origin, float)
    WORLD[o.name] = origin
    if parent:
        o.parent = parent
    o.location = Vector(to_b(origin - (WORLD[parent.name] if parent else 0)).tolist())
    return o


def surface_point(V, F, near, direction):
    """The body vertex nearest `near` among those facing `direction`; returns point and normal."""
    V = np.asarray(V)
    n = np.zeros_like(V)
    for f in F:
        p = V[list(f)]
        fn = np.cross(p[1] - p[0], p[2] - p[0])
        for i in f:
            n[i] += fn
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    ok = (n @ np.asarray(direction)) > 0.3
    cand = np.where(ok)[0]
    j = cand[np.argmin(np.linalg.norm(V[cand] - near, axis=1))]
    return V[j], n[j]


def oriented_box(size, center, normal, up=(0, 1, 0), p=5.0):
    V, F = rounded_box(size, p)
    z = np.asarray(normal, float)
    z /= np.linalg.norm(z)
    x = np.cross(np.asarray(up, float), z)
    x /= max(np.linalg.norm(x), 1e-9)
    y = np.cross(z, x)
    M = np.stack([x, y, z], 1)
    return V @ M.T + center, F


def bumper(car, front, y, height, protrude, wrap):
    """A bumper that FOLLOWS the plan round the end of the car: a rounded band swept along the outline
    from `wrap` metres down one side, across the end, to the other side; closed at both ends."""
    d_end = car.d0 if front else car.d1
    sgn = 1 if front else -1
    ds = np.linspace(d_end + wrap * sgn, d_end, 7)
    side = [(float(car.plan(d)) + float(car.flare(d)), car.mid_d - d) for d in ds]
    hw_end = float(car.plan(d_end))
    zc = car.mid_d - d_end
    across = [(x, zc) for x in np.linspace(hw_end * 0.9, -hw_end * 0.9, 7)]
    path = [(x, z) for x, z in side] + across[1:-1] + [(-x, z) for x, z in reversed(side)]
    path = np.array(path)
    # outward normals of the path in plan (x, z)
    tang = np.gradient(path, axis=0)
    nrm = np.stack([tang[:, 1], -tang[:, 0]], 1) * (1 if front else -1)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)
    prof = [(-0.08, -0.5), (protrude * 0.8, -0.5), (protrude, -0.3), (protrude, 0.3), (protrude * 0.8, 0.5), (-0.08, 0.5)]
    V, F = [], []
    for (x, z), (nx, nz) in zip(path, nrm):
        for o, h in prof:
            V.append([x + nx * o, y + h * height, z + nz * o])
    k = len(prof)
    for i in range(len(path) - 1):
        for j in range(k - 1):
            a, b = i * k + j, (i + 1) * k + j
            F.append((a, a + 1, b + 1, b) if front else (a, b, b + 1, a + 1))
    for ring, rev in ((0, front), (len(path) - 1, not front)):
        ids = list(range(ring * k, ring * k + k))
        F.append(tuple(reversed(ids)) if rev else tuple(ids))
    return np.array(V), F


def build(spec):
    s = merge(DEFAULT, spec)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    car = Car(s)
    root = empty(s["kind"], (0, 0, 0))
    body = empty("body", (0, 0, 0), root)
    V, F, M, owner = body_mesh(car)
    keep = [i for i, o in enumerate(owner) if o is None]
    mesh("body_shell", V, [F[i] for i in keep], [M[i] for i in keep], body)
    # doors: their region of the surface, on a hinge at the front edge
    edges = car.door_edges()
    names = ["F", "R"]
    for j in range(len(edges) - 1):
        for side in ("L", "R"):
            ids = [i for i, o in enumerate(owner) if o == ("door", j, side)]
            if not ids:
                continue
            d_h = edges[j] + 0.006
            hx = (car.W / 2) * (1 if side == "L" else -1)
            hinge = np.array([hx, float(car.belt(d_h)) - 0.3, car.mid_d - d_h])
            nm = f"door_{names[j] if j < 2 else str(j)}{side}"
            piv = empty(nm, hinge, root)
            mesh(f"door_geometry_{names[j]}{side}", V, [F[i] for i in ids], [M[i] for i in ids], piv, origin=hinge)
    # interior
    inner = inner_shell(car)
    if inner:
        mesh("interior", inner[0], inner[1], ["interior"] * len(inner[1]), body)
    zf, zr = car.mid_d - car.d0, car.mid_d - car.d1
    lp = s["lamps"]
    for side, sx in (("L", 1), ("R", -1)):
        hx = sx * car.W / 2 * lp["head_x"]
        p, n = surface_point(V, F, np.array([hx, lp["head_y"], zf]), (sx * 0.35, 0, 1))
        bv, bf = oriented_box([lp["head"][0], lp["head"][1], 0.05], p + n * 0.006, n)
        mesh(f"lamp_head_{side}", bv, bf, ["lamp_head"] * len(bf), body)
        p2, n2 = surface_point(V, F, np.array([sx * car.W / 2 * 0.86, lp["head_y"] - 0.02, zf - 0.12]), (sx, 0, 0.6))
        bv, bf = oriented_box([0.10, 0.06, 0.04], p2 + n2 * 0.005, n2)
        mesh(f"lamp_turn_F{side}", bv, bf, ["lamp_turn"] * len(bf), body)
        p3, n3 = surface_point(V, F, np.array([sx * car.W / 2 * 0.70, lp["tail_y"], zr]), (sx * 0.35, 0, -1))
        bv, bf = oriented_box([lp["tail"][0], lp["tail"][1], 0.05], p3 + n3 * 0.006, n3)
        mesh(f"lamp_tail_{side}", bv, bf, ["lamp_tail"] * len(bf), body)
        p4, n4 = surface_point(V, F, np.array([sx * car.W / 2 * 0.40, lp["tail_y"], zr]), (0, 0, -1))
        bv, bf = oriented_box([0.16, 0.07, 0.04], p4 + n4 * 0.005, n4)
        mesh(f"lamp_brake_{side}", bv, bf, ["lamp_tail"] * len(bf), body)
        p5, n5 = surface_point(V, F, np.array([sx * car.W / 2 * 0.86, lp["tail_y"] - 0.1, zr + 0.1]), (sx, 0, -0.6))
        bv, bf = oriented_box([0.09, 0.05, 0.04], p5 + n5 * 0.005, n5)
        mesh(f"lamp_turn_R{side}", bv, bf, ["lamp_turn"] * len(bf), body)
        # mirror on the door at the A-pillar base
        dm = s["profile"]["cowl_d"] + 0.16
        edge = float(car.plan(dm)) + float(car.flare(dm))
        my = float(car.belt(dm)) + 0.07
        bv, bf = rounded_box([0.15, 0.10, 0.09], p=4)
        # an arm that runs INTO the door, so mirror and body never meet at a single point
        av, af = rounded_box([0.16, 0.04, 0.05], p=4, nu=6, nv=3)
        mv = np.vstack([bv + [sx * (edge + 0.10), my, car.mid_d - dm], av + [sx * (edge + 0.0), my - 0.02, car.mid_d - dm]])
        mesh(f"mirror_{side}", mv, bf + [tuple(i + len(bv) for i in f) for f in af], ["paint"] * (len(bf) + len(af)), body)
        # handles
        for e0, e1 in zip(edges[:-1], edges[1:]):
            dh = e1 - 0.16
            hx2 = sx * (float(car.plan(dh)) + float(car.flare(dh)) + 0.004)
            bv, bf = rounded_box([0.02, 0.03, 0.12], p=4, nu=6, nv=3)
            mesh(f"handle_{side}", bv + [hx2, float(car.belt(dh)) - 0.07, car.mid_d - dh], bf, ["chrome"] * len(bf), body)
    # grille, bumpers
    gp, gn = surface_point(V, F, np.array([0, lp["head_y"] - 0.02, zf]), (0, 0, 1))
    bv, bf = oriented_box([s["grille"]["width"], s["grille"]["height"], 0.05], gp + gn * 0.004, gn)
    mesh("grille", bv, bf, ["trim"] * len(bf), body)
    bp = s["bumpers"]
    for nm, front, y in (("bumper_front", True, bp["front_y"]), ("bumper_rear", False, bp["rear_y"])):
        bv, bf = bumper(car, front, y, bp["height"], bp["protrude"], bp.get("wrap", 0.42))
        mesh(nm, bv, bf, ["trim"] * len(bf), body)
    # wheels
    w = s["wheel"]
    for nm, dw, sx in (("FL", car.wf, 1), ("FR", car.wf, -1), ("RL", car.wr, 1), ("RR", car.wr, -1)):
        cx = sx * (car.W / 2 - w["inset"] - w["width"] / 2)
        c = np.array([cx, w["radius"], car.mid_d - dw])
        piv = empty(f"wheel_{nm}", c, root)
        parts = wheel_parts(w)
        allV, allF, allM, off = [], [], [], 0
        for Vp, Fp, Mp in parts:
            Vq = Vp.copy()
            if sx < 0:
                Vq[:, 0] *= -1
                Fp = [tuple(reversed(f)) for f in Fp]
            allV.append(Vq + c)
            allF += [tuple(i + off for i in f) for f in Fp]
            allM += Mp
            off += len(Vq)
        mesh(f"wheel_{nm}_assembly", np.vstack(allV), allF, allM, piv, origin=c)
        # wheel-well liner: a dark wall inboard of the wheel, so nothing is seen THROUGH the arch
        if not s.get("liners", True):
            continue
        lx = cx - sx * (w["width"] / 2 + 0.03)
        # only the arch opening: from just above the sill line up into the arch, never below the body
        y0 = s["clearance"] + 0.02
        y1 = car.Ra + w["radius"] - 0.01
        lv, lf = box([0.03, y1 - y0, 2 * car.Ra])
        mesh(f"liner_{nm}", lv + [lx, (y0 + y1) / 2, car.mid_d - dw], lf, ["trim"] * len(lf), body)
    # seats
    st = s["seats"]
    for nm, x, d in (("seat_driver", st["x"], st["front_d"]), ("seat_1", -st["x"], st["front_d"]),
                     ("seat_2", st["x"], st["rear_d"]), ("seat_3", 0.0, st["rear_d"]), ("seat_4", -st["x"], st["rear_d"])):
        empty(nm, (x, st["hip_y"], car.mid_d - d), root)
    return s, car


def export(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", export_yup=True, export_apply=True,
                              export_cameras=False, export_lights=False, export_materials="EXPORT")


if __name__ == "__main__":
    spec = json.loads(Path(arg("--spec")).read_text(encoding="utf-8"))
    out = Path(arg("--out", "."))
    s, car = build(spec)
    p = out / s["name"] / f"{s['name']}.glb"
    export(p)
    (out / s["name"] / f"{s['name']}.spec.json").write_text(json.dumps(s, indent=1), encoding="utf-8")
    print("exported", p)
