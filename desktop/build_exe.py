# ClipForge Desktop EXE build script
# Usage: python build_exe.py

import os
import sys
import subprocess
import shutil

DESKTOP_DIR = os.path.dirname(os.path.abspath(__file__))
MAIN_PY = os.path.join(DESKTOP_DIR, "main.py")
DIST_DIR = os.path.join(DESKTOP_DIR, "dist")
BUILD_DIR = os.path.join(DESKTOP_DIR, "build")

def main():
    if not os.path.isfile(MAIN_PY):
        print(f"main.py not found at {MAIN_PY}")
        sys.exit(1)

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--name", "ClipForge",
        "--windowed",
        "--onefile",
        "--clean",
        "--noconfirm",
        "--distpath", DIST_DIR,
        "--workpath", BUILD_DIR,
        "--specpath", BUILD_DIR,
        "--hidden-import", "customtkinter",
        "--hidden-import", "faster_whisper",
        "--hidden-import", "yt_dlp",
        "--hidden-import", "PIL",
        MAIN_PY,
    ]

    print("Building ClipForge.exe ...")
    proc = subprocess.run(cmd, cwd=DESKTOP_DIR)
    if proc.returncode != 0:
        print("Build failed.")
        sys.exit(proc.returncode)

    out = os.path.join(DIST_DIR, "ClipForge.exe")
    if os.path.isfile(out):
        print(f"Built: {out}")
    else:
        print("Build finished, but ClipForge.exe was not found.")


if __name__ == "__main__":
    main()
