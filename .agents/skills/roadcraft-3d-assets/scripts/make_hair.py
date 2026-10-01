"""One command per hairstyle: build -> bind (.mhclo/.mhmat) -> check -> render previews.

    python make_hair.py --out <dir> <spec.json> [<spec.json> ...] [--sheet] [--no-render]

Exit code 1 if any style fails its checks. Prints one summary line per style. With --sheet, also writes
<out>/contact_sheet.png (3/4 and back views of every style).
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


def find_blender() -> str | None:
    env = os.environ.get("BLENDER")
    if env and Path(env).is_file():
        return env
    on_path = shutil.which("blender")
    if on_path:
        return on_path
    pats = [r"C:\Program Files\Blender Foundation\Blender*\blender.exe",
            "/Applications/Blender.app/Contents/MacOS/Blender", "/usr/bin/blender", "/snap/bin/blender"]
    for p in pats:
        hits = sorted(glob.glob(p))
        if hits:
            return hits[-1]
    return None


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("specs", nargs="+", type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--sheet", action="store_true")
    ap.add_argument("--no-render", action="store_true")
    ap.add_argument("--max-tris", type=int, default=16000)
    a = ap.parse_args()
    py = sys.executable
    bad = 0
    dirs = []
    for spec in a.specs:
        name = json.loads(spec.read_text(encoding="utf-8"))["name"]
        d = a.out / name
        r = run([py, str(HERE / "hair_build.py"), "--spec", str(spec), "--out", str(a.out)])
        if r.returncode:
            print(f"{name}: BUILD FAILED\n{r.stderr}")
            bad += 1
            continue
        r = run([py, str(HERE / "bind_mhclo.py"), "--obj", str(d / f"{name}.obj"), "--kind", "hair"])
        bind = json.loads((d / f"{name}.bind.json").read_text()) if (d / f"{name}.bind.json").is_file() else {}
        bind_fail = r.returncode != 0
        r = run([py, str(HERE / "check_hair.py"), "--dir", str(d), "--max-tris", str(a.max_tris)])
        chk = json.loads((d / "check.json").read_text()) if (d / "check.json").is_file() else {"fails": [r.stderr]}
        fails = list(chk.get("fails", []))
        if bind_fail:
            fails.append(f"bind: torn={bind.get('deformTornEdges')} flipped={bind.get('deformFlippedTriangles')}")
        report = {"name": name, "triangles": chk.get("triangles"), "vertices": chk.get("vertices"),
                  "bind": bind, "check": chk, "ok": not fails, "fails": fails,
                  "command": " ".join(["python", "make_hair.py", "--out", str(a.out), str(spec)])}
        (d / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
        status = "OK  " if not fails else "FAIL"
        print(f"{status} {name}: {chk.get('triangles')} tris, refit {chk.get('maxRefitErrorDm', 0):.1e} dm, "
              f"torn {bind.get('deformTornEdges')}, " + ("; ".join(fails) if fails else "all rules pass"))
        bad += bool(fails)
        dirs.append(d)
    if not a.no_render and dirs:
        blender = find_blender()
        if not blender:
            print("Blender not found: set BLENDER=<path to blender executable> to get previews")
            return 1
        cmd = [blender, "-b", "--factory-startup", "-P", str(HERE / "render_previews.py"), "--"]
        for d in dirs:
            cmd += ["--dir", str(d)]
        if a.sheet:
            cmd += ["--sheet", str(a.out / "contact_sheet.png")]
        r = run(cmd)
        if r.returncode or "Traceback" in r.stdout + r.stderr:
            print("RENDER FAILED\n" + (r.stdout + r.stderr)[-3000:])
            return 1
        print(f"previews written ({len(dirs)} styles)" + (f", sheet {a.out / 'contact_sheet.png'}" if a.sheet else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
