"""Build the compute-engine sidecar executable for the desktop app.

Produces desktop/src-tauri/binaries/synthea-backend-<rust-target-triple>[.exe]
as required by Tauri's `externalBin`. Run with the Python environment that has
backend/requirements.txt and pyinstaller installed:

    python scripts/build_sidecar.py
"""
import os
import platform
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(ROOT, "backend")
OUT = os.path.join(ROOT, "desktop", "src-tauri", "binaries")


def target_triple() -> str:
    try:
        out = subprocess.check_output(["rustc", "-vV"], text=True)
        for line in out.splitlines():
            if line.startswith("host:"):
                return line.split(":", 1)[1].strip()
    except Exception:
        pass
    m = platform.machine().lower()
    if sys.platform == "win32":
        return "x86_64-pc-windows-msvc"
    if sys.platform == "darwin":
        return ("aarch64" if m in ("arm64", "aarch64") else "x86_64") + "-apple-darwin"
    return "x86_64-unknown-linux-gnu"


def main():
    triple = target_triple()
    args = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
        "--name", "synthea-backend",
        "--distpath", os.path.join(BACKEND, "build", "dist"),
        "--workpath", os.path.join(BACKEND, "build", "work"),
        "--specpath", os.path.join(BACKEND, "build"),
        "--paths", BACKEND,
        "--collect-submodules", "uvicorn",
        "--collect-submodules", "app",
        "--collect-data", "reportlab",
        "--collect-data", "pint",
        "--collect-all", "rdkit",
        "--hidden-import", "sklearn.gaussian_process",
        "--hidden-import", "scipy.optimize",
        "--hidden-import", "pymupdf",
        os.path.join(BACKEND, "synthea_backend.py"),
    ]
    if sys.platform == "win32":
        args.insert(4, "--noconsole")
    subprocess.check_call(args, cwd=BACKEND)
    os.makedirs(OUT, exist_ok=True)
    ext = ".exe" if sys.platform == "win32" else ""
    src = os.path.join(BACKEND, "build", "dist", "synthea-backend" + ext)
    dst = os.path.join(OUT, f"synthea-backend-{triple}{ext}")
    shutil.copy2(src, dst)
    print("sidecar:", dst, os.path.getsize(dst) // (1024 * 1024), "MB")


if __name__ == "__main__":
    main()
