"""One command per vehicle: build -> GLB rules -> shape checks -> renders + HOLE TEST -> report.

    python make_car.py --out <dir> <spec.json> [<spec.json> ...]

Prints OK or FAIL <reasons> per vehicle and writes <out>/<name>/report.json, <name>_sheet.png
(six views) and <name>_holes.png (red = background seen through the car). Exit code 1 on any FAIL.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOLE_LIMIT = 6      # px over 8 views: a real gap measures tens to hundreds (the Codex sedans: 555-617;
                    # a mirror touching the door at one point: 8); 2-4 px are anti-aliasing specks


def blender() -> str:
    for c in (os.environ.get("BLENDER"), shutil.which("blender")):
        if c and Path(c).is_file():
            return c
    hits = sorted(glob.glob(r"C:\Program Files\Blender Foundation\Blender*\blender.exe"))
    if hits:
        return hits[-1]
    sys.exit("Blender not found: set BLENDER=<path to blender executable>")


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("specs", nargs="+", type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--paint", default="2f5596")
    a = ap.parse_args()
    a.out = a.out.resolve()            # Blender resolves relative paths its own way: give it absolute ones
    a.specs = [p.resolve() for p in a.specs]
    B = blender()
    bad = 0
    for spec in a.specs:
        sp = json.loads(spec.read_text(encoding="utf-8"))
        name, kind = sp["name"], sp.get("kind", "sedan")
        d = a.out / name
        r = run([B, "-b", "--factory-startup", "-P", str(HERE / "car_build.py"), "--", "--spec", str(spec), "--out", str(a.out)])
        glb = d / f"{name}.glb"
        if not glb.is_file() or "Traceback" in r.stdout + r.stderr:
            print(f"FAIL {name}: build failed\n{(r.stdout + r.stderr)[-2500:]}")
            bad += 1
            continue
        fails = []
        r1 = run([sys.executable, str(HERE / "check_glb.py"), str(glb), "--kind", kind])
        g = json.loads(glb.with_suffix(".check.json").read_text())
        fails += g["fails"]
        r2 = run([sys.executable, str(HERE / "check_shape.py"), str(glb), "--json", str(d / "shape.json")])
        sh = json.loads((d / "shape.json").read_text())
        fails += sh["fails"]
        r3 = run([B, "-b", "--factory-startup", "-P", str(HERE / "render_car.py"), "--", "--glb", str(glb),
                  "--out", str(d / name), "--paint", a.paint])
        hj = d / f"{name}_holes.json"
        holes = json.loads(hj.read_text()) if hj.is_file() else {"total": -1}
        if holes["total"] < 0:
            fails.append("render failed: " + (r3.stdout + r3.stderr)[-800:])
        elif holes["total"] > HOLE_LIMIT:
            fails.append(f"HOLES: {holes['total']} px of background seen through the car {holes['holePixels']} - see {name}_holes.png")
        rep = {"name": name, "kind": kind, "size": g.get("sizeXYZ"), "triangles": g.get("triangles"),
               "shape": {k: sh[k] for k in ("insideOut", "dentShare", "slivers", "openPaintEdges")},
               "holes": holes, "fails": fails, "ok": not fails, "license": "CC0-1.0",
               "command": f"python make_car.py --out {a.out} {spec}"}
        (d / "report.json").write_text(json.dumps(rep, indent=1), encoding="utf-8")
        print(("OK   " if not fails else "FAIL ") + f"{name}: {g.get('sizeXYZ')} m, {g.get('triangles')} tris, "
              f"holes {holes['total']} px, dents {sh['dentShare']:.1%}, slivers {sh['slivers']}"
              + ("" if not fails else " | " + " ; ".join(fails)))
        bad += bool(fails)
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
