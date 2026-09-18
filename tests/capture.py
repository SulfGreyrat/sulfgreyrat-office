"""Рендер картинок для README через headless Edge и tests/harness.html.

    python -m http.server 8765 --bind 127.0.0.1   # из корня репозитория
    python tests/capture.py
"""
import base64
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
BASE = "http://127.0.0.1:8765/tests/harness.html?"
DOCS = Path(__file__).resolve().parent.parent / "docs"
PROFILE = Path(__file__).resolve().parent / ".edge-profile"


def edge(args):
    return subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                           f"--user-data-dir={PROFILE}", "--virtual-time-budget=20000", *args],
                          capture_output=True, text=True, encoding="utf-8", errors="replace")


def shot(query, out, w=1280, h=768, crop=None):
    tmp = DOCS / "_tmp.png"
    edge([f"--window-size={w},{h + 200}", f"--screenshot={tmp}", BASE + query + f"&w={w}&h={h}"])
    im = Image.open(tmp).crop(crop or (0, 0, w, h))
    im.save(DOCS / out, optimize=True)
    tmp.unlink()
    print(out, im.size, (DOCS / out).stat().st_size // 1024, "KB")


def gif(query, out, frames, w=1280, h=768, duration=67):
    res = edge(["--dump-dom", BASE + query + f"&w={w}&h={h}&frames={frames}"])
    urls = re.findall(r"data:image/png;base64,([A-Za-z0-9+/=]+)", res.stdout)
    if not urls:
        sys.exit("no frames: " + res.stderr[-400:])
    ims = []
    for u in urls:
        from io import BytesIO
        ims.append(Image.open(BytesIO(base64.b64decode(u))).convert("RGB"))
    pal = ims[len(ims) // 2].quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    q = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in ims]
    q[0].save(DOCS / out, save_all=True, append_images=q[1:], duration=duration, loop=0, optimize=True, disposal=1)
    print(out, len(q), "frames", (DOCS / out).stat().st_size // 1024, "KB")


if __name__ == "__main__":
    shot("s=walk&t=16&hour=13", "office-day.png")
    shot("s=idle&t=8&hour=22", "office-night.png")
    shot("s=mix&t=3&hour=13&hover=developer", "hover-card.png", crop=(40, 280, 700, 580))
    gif("s=gif&t=0.3&hour=13&skip=2", "office.gif", 110, duration=90)
