"""Shared helpers: the MakeHuman base mesh, OBJ/PNG writers, nearest-triangle binding.

Pure Python 3.10+ with numpy. No Blender needed. All lengths are DECIMETRES in the
base.obj frame: +Y up, +Z forward (the face looks at +Z), +X is the person's LEFT.
"""
from __future__ import annotations

import os
import struct
import urllib.request
import zlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

MPFB_SHA = "afb9f530a7c2741dedb8df0ebae2e0b183caec21"
BASE_URL = f"https://raw.githubusercontent.com/makehumancommunity/mpfb2/{MPFB_SHA}/src/mpfb/data/3dobjs/base.obj"
SKILL_DIR = Path(__file__).resolve().parent.parent

# Pairs of base vertices whose distance on each axis sizes a proxy (same as MakeHuman's hair).
SCALE_REFS = {"x": (5399, 11998), "y": (791, 881), "z": (962, 5320)}
# Shoes are sized by the foot.
SHOE_SCALE_REFS = {"x": (12839, 12860), "y": (12828, 12888), "z": (11609, 12442)}


def find_base_obj() -> Path:
    """The pinned base.obj: env ROADCRAFT_BASE_OBJ, the repo cache, or a download into the skill cache."""
    env = os.environ.get("ROADCRAFT_BASE_OBJ")
    if env and Path(env).is_file():
        return Path(env)
    here = SKILL_DIR
    for parent in [here, *here.parents]:
        p = parent / ".cache" / "makehuman" / MPFB_SHA / "repo" / "src" / "mpfb" / "data" / "3dobjs" / "base.obj"
        if p.is_file():
            return p
    cache = SKILL_DIR / ".cache" / "base.obj"
    if not cache.is_file():
        cache.parent.mkdir(parents=True, exist_ok=True)
        print(f"downloading {BASE_URL}")
        urllib.request.urlretrieve(BASE_URL, cache)
    return cache


@dataclass
class Base:
    v: np.ndarray                      # (19158, 3) float64, decimetres
    faces: list[list[int]]             # 0-based vertex indices, quads or tris
    face_group: list[str]
    groups: dict[str, np.ndarray] = field(default_factory=dict)  # group -> triangles (n,3)

    def tris(self, *names: str) -> np.ndarray:
        return np.concatenate([self.groups[n] for n in names], axis=0)

    def verts_of(self, *names: str) -> np.ndarray:
        return np.unique(self.tris(*names).ravel())

    def scale_dists(self, refs=SCALE_REFS) -> tuple[float, float, float]:
        out = []
        for axis, (a, b) in zip(range(3), (refs["x"], refs["y"], refs["z"])):
            out.append(abs(float(self.v[a, axis] - self.v[b, axis])))
        return tuple(out)  # type: ignore[return-value]


def load_base(path: Path | None = None) -> Base:
    path = path or find_base_obj()
    v, faces, fg = [], [], []
    group = "?"
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("v "):
                v.append([float(x) for x in line.split()[1:4]])
            elif line.startswith("g "):
                group = line.split()[1]
            elif line.startswith("f "):
                faces.append([int(t.split("/")[0]) - 1 for t in line.split()[1:]])
                fg.append(group)
    base = Base(np.asarray(v, dtype=np.float64), faces, fg)
    if base.v.shape[0] != 19158:
        raise SystemExit(f"{path}: {base.v.shape[0]} vertices, expected 19158 (wrong base.obj)")
    tri: dict[str, list[list[int]]] = {}
    for f, g in zip(faces, fg):
        lst = tri.setdefault(g, [])
        lst.append([f[0], f[1], f[2]])
        if len(f) == 4 and f[3] != f[2]:
            lst.append([f[0], f[2], f[3]])
    base.groups = {g: np.asarray(t, dtype=np.int64) for g, t in tri.items()}
    return base


def vertex_normals(v: np.ndarray, tris: np.ndarray) -> np.ndarray:
    n = np.zeros_like(v)
    fn = np.cross(v[tris[:, 1]] - v[tris[:, 0]], v[tris[:, 2]] - v[tris[:, 0]])
    for k in range(3):
        np.add.at(n, tris[:, k], fn)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    return n / np.maximum(ln, 1e-12)


# ---------------------------------------------------------------- closest point on triangles

def closest_on_triangles(p: np.ndarray, a: np.ndarray, b: np.ndarray, c: np.ndarray):
    """For points p (n,3) against ONE triangle each (a,b,c (n,3)): closest point and barycentrics."""
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = (ab * ap).sum(1), (ac * ap).sum(1)
    bp = p - b
    d3, d4 = (ab * bp).sum(1), (ac * bp).sum(1)
    cp = p - c
    d5, d6 = (ab * cp).sum(1), (ac * cp).sum(1)
    va = d3 * d6 - d5 * d4
    vb = d5 * d2 - d1 * d6
    vc = d1 * d4 - d3 * d2
    n = len(p)
    w = np.zeros((n, 3))
    # interior
    den = va + vb + vc
    den = np.where(np.abs(den) < 1e-18, 1e-18, den)
    w[:, 1], w[:, 2] = vb / den, vc / den
    w[:, 0] = 1 - w[:, 1] - w[:, 2]
    # regions (Ericson, Real-Time Collision Detection 5.1.5)
    m = (d1 <= 0) & (d2 <= 0); w[m] = [1, 0, 0]
    m2 = (d3 >= 0) & (d4 <= d3) & ~m; w[m2] = [0, 1, 0]
    m3 = (d6 >= 0) & (d5 <= d6) & ~m & ~m2; w[m3] = [0, 0, 1]
    done = m | m2 | m3
    e = (vc <= 0) & (d1 >= 0) & (d3 <= 0) & ~done
    t = d1[e] / np.where(np.abs(d1[e] - d3[e]) < 1e-18, 1e-18, d1[e] - d3[e]); w[e] = np.stack([1 - t, t, 0 * t], 1); done |= e
    e = (vb <= 0) & (d2 >= 0) & (d6 <= 0) & ~done
    t = d2[e] / np.where(np.abs(d2[e] - d6[e]) < 1e-18, 1e-18, d2[e] - d6[e]); w[e] = np.stack([1 - t, 0 * t, t], 1); done |= e
    e = (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0) & ~done
    t = (d4[e] - d3[e]) / np.maximum((d4[e] - d3[e]) + (d5[e] - d6[e]), 1e-18); w[e] = np.stack([0 * t, 1 - t, t], 1)
    q = w[:, :1] * a + w[:, 1:2] * b + w[:, 2:3] * c
    return q, w


def nearest_triangle(p: np.ndarray, v: np.ndarray, tris: np.ndarray, chunk: int = 512):
    """Nearest triangle (index), closest point and barycentrics for every point. Brute force, chunked."""
    a, b, c = v[tris[:, 0]], v[tris[:, 1]], v[tris[:, 2]]
    cen = (a + b + c) / 3
    rad = np.maximum.reduce([np.linalg.norm(a - cen, axis=1), np.linalg.norm(b - cen, axis=1), np.linalg.norm(c - cen, axis=1)])
    best = np.zeros(len(p), dtype=np.int64)
    bq = np.zeros_like(p)
    bw = np.zeros((len(p), 3))
    for s in range(0, len(p), chunk):
        pp = p[s:s + chunk]
        # candidate triangles: lower bound of distance via bounding sphere, keep the 24 best
        dc = np.linalg.norm(pp[:, None, :] - cen[None], axis=2) - rad[None]
        k = min(24, len(tris))
        cand = np.argpartition(dc, k - 1, axis=1)[:, :k]
        n = len(pp)
        P = np.repeat(pp, k, axis=0)
        T = cand.ravel()
        q, w = closest_on_triangles(P, a[T], b[T], c[T])
        d = np.linalg.norm(P - q, axis=1).reshape(n, k)
        j = d.argmin(1)
        sel = np.arange(n) * k + j
        best[s:s + chunk] = T[sel]
        bq[s:s + chunk] = q[sel]
        bw[s:s + chunk] = w[sel]
    return best, bq, bw


# ---------------------------------------------------------------- writers

def write_obj(path: Path, v: np.ndarray, uv: np.ndarray | None, tris: np.ndarray, name: str) -> None:
    """One object; faces f v/vt with the same index for position and uv (one uv per vertex)."""
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(f"# {name} - generated, CC0-1.0\n")
        fh.write(f"o {name}\n")
        fh.write("".join(f"v {x:.5f} {y:.5f} {z:.5f}\n" for x, y, z in v))
        if uv is not None:
            fh.write("".join(f"vt {s:.5f} {t:.5f}\n" for s, t in uv))
        if uv is not None:
            fh.write("".join(f"f {a+1}/{a+1} {b+1}/{b+1} {c+1}/{c+1}\n" for a, b, c in tris))
        else:
            fh.write("".join(f"f {a+1} {b+1} {c+1}\n" for a, b, c in tris))


def read_obj(path: Path):
    """Positions, per-position uv (first seen), triangles. Faces may be quads."""
    v, vt, tris = [], [], []
    uv_of: dict[int, int] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            p = line.split()
            if not p:
                continue
            if p[0] == "v":
                v.append([float(x) for x in p[1:4]])
            elif p[0] == "vt":
                vt.append([float(x) for x in p[1:3]])
            elif p[0] == "f":
                idx = []
                for t in p[1:]:
                    s = t.split("/")
                    vi = int(s[0]) - 1
                    if len(s) > 1 and s[1]:
                        uv_of.setdefault(vi, int(s[1]) - 1)
                    idx.append(vi)
                for k in range(1, len(idx) - 1):
                    tris.append([idx[0], idx[k], idx[k + 1]])
    v = np.asarray(v, dtype=np.float64)
    uv = None
    if vt:
        vt_a = np.asarray(vt)
        uv = np.zeros((len(v), 2))
        for vi, ti in uv_of.items():
            uv[vi] = vt_a[ti]
    return v, uv, np.asarray(tris, dtype=np.int64)


def write_png(path: Path, rgba: np.ndarray) -> None:
    """rgba: (h, w, 4) uint8."""
    h, w, ch = rgba.shape
    assert ch == 4 and rgba.dtype == np.uint8
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    Path(path).write_bytes(png)


def read_png_rgba(path: Path) -> np.ndarray:
    """8-bit RGBA/RGB PNG as (h, w, 4) uint8. Uses Pillow when installed, else a slow pure reader."""
    try:
        from PIL import Image  # type: ignore
        return np.asarray(Image.open(path).convert("RGBA"), dtype=np.uint8)
    except ImportError:
        pass
    data = Path(path).read_bytes()
    pos, idat = 8, b""
    w = h = ctype = 0
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if tag == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", body[:10])
            if depth != 8 or ctype not in (2, 6):
                raise SystemExit(f"{path}: only 8-bit RGB/RGBA PNG supported")
        elif tag == b"IDAT":
            idat += body
        pos += 12 + ln
    ch = 4 if ctype == 6 else 3
    raw = zlib.decompress(idat)
    stride = w * ch
    out = np.zeros((h, stride), dtype=np.uint8)
    prev = np.zeros(stride, dtype=np.int32)
    for y in range(h):
        ft = raw[y * (stride + 1)]
        line = np.frombuffer(raw, dtype=np.uint8, count=stride, offset=y * (stride + 1) + 1).astype(np.int32)
        cur = np.zeros(stride, dtype=np.int32)
        if ft == 0:
            cur = line
        elif ft == 2:
            cur = (line + prev) & 255
        else:
            for x in range(stride):
                a = cur[x - ch] if x >= ch else 0
                b = prev[x]
                c = prev[x - ch] if x >= ch else 0
                if ft == 1:
                    pr = a
                elif ft == 3:
                    pr = (a + b) // 2
                else:
                    pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                    pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                cur[x] = (line[x] + pr) & 255
        out[y] = cur
        prev = cur
    img = out.reshape(h, w, ch)
    if ch == 3:
        img = np.concatenate([img, np.full((h, w, 1), 255, np.uint8)], axis=2)
    return img


def sample_texture(img: np.ndarray, uv: np.ndarray) -> np.ndarray:
    """Nearest-pixel sample at uv (OBJ convention: v=0 is the BOTTOM row). Returns (n,4) in 0..1."""
    h, w, _ = img.shape
    x = np.clip((uv[:, 0] * w).astype(int), 0, w - 1)
    y = np.clip(((1 - uv[:, 1]) * h).astype(int), 0, h - 1)
    return img[y, x].astype(np.float64) / 255.0


EYE_Y, EYE_Z = 7.284, 1.245


def _smooth(e0, e1, x):
    t = np.clip((np.asarray(x, dtype=float) - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def scalp_weight(v: np.ndarray) -> np.ndarray:
    """0..1 per vertex: the scalp the game paints in the hair colour (src/render/people/personMesh.ts)."""
    x, y, z = v[:, 0], v[:, 1], v[:, 2]
    back = _smooth(EYE_Z - 0.4, EYE_Z - 1.1, z)
    hairline = EYE_Y + 0.62 - back * 1.55
    ear_band = _smooth(EYE_Y - 0.8, EYE_Y - 0.6, y) * (1 - _smooth(EYE_Y + 0.2, EYE_Y + 0.35, y))
    ear = ear_band * _smooth(0.55, 0.68, np.abs(x)) * (1 - back * 0.6)
    h = _smooth(hairline - 0.05, hairline + 0.09, y) * (1 - ear)
    return h * ((y > EYE_Y - 1.2) & (np.abs(x) < 1.2))


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
