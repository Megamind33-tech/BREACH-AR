#!/usr/bin/env python3
"""
BREACH origin marker generator.

Produces a deterministic, feature-dense, non-repetitive, high-contrast
image suited to ARCore image tracking, and a print-ready A4 PDF where the
image is exactly MARKER_WIDTH_CM wide (must match MarkerOrigin.MarkerWidthMetres).

    pip install pillow numpy
    python3 Tools/marker/generate_marker.py
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
MARKER_WIDTH_CM = 18.0
SIZE = 1024
FONT = os.path.join(ROOT, "Assets", "BREACH", "Resources", "Fonts", "BarlowCondensed-SemiBold.ttf")


def build():
    rng = np.random.default_rng(20260927)
    img = Image.new("L", (SIZE, SIZE), 255)
    d = ImageDraw.Draw(img)

    # Irregular angular shards: many corners, no repetition, strong gradients.
    for _ in range(170):
        cx, cy = rng.uniform(60, SIZE - 60, 2)
        r = rng.uniform(18, 95)
        k = int(rng.integers(3, 7))
        angles = np.sort(rng.uniform(0, 2 * np.pi, k))
        pts = [(cx + np.cos(a) * r * rng.uniform(0.5, 1.2), cy + np.sin(a) * r * rng.uniform(0.5, 1.2)) for a in angles]
        d.polygon(pts, fill=int(rng.choice([0, 0, 0, 40, 255, 200])))

    # Asymmetric bold wordmark so orientation is unambiguous.
    try:
        font = ImageFont.truetype(FONT, 150)
        small = ImageFont.truetype(FONT, 54)
    except OSError:
        font = small = ImageFont.load_default()
    d.rectangle([70, 70, 610, 250], fill=0)
    d.text((95, 70), "BREACH", font=font, fill=255)
    d.rectangle([SIZE - 420, SIZE - 150, SIZE - 70, SIZE - 70], fill=255, outline=0, width=8)
    d.text((SIZE - 400, SIZE - 148), "ORIGIN  0,0,0", font=small, fill=0)

    # Orientation notch (top-left only) and a thick frame.
    d.polygon([(0, 0), (160, 0), (0, 160)], fill=0)
    d.rectangle([0, 0, SIZE - 1, SIZE - 1], outline=0, width=28)
    return img.convert("RGB")


def main():
    img = build()
    res_dir = os.path.join(ROOT, "Assets", "BREACH", "Resources", "Markers")
    docs_dir = os.path.join(ROOT, "docs", "marker")
    os.makedirs(res_dir, exist_ok=True)
    os.makedirs(docs_dir, exist_ok=True)

    png = os.path.join(docs_dir, "BREACH_origin_marker.png")
    img.save(png, optimize=True)
    # Unity imports .bytes as a TextAsset: the game decodes it at runtime into a
    # readable texture for the mutable reference library (no importer config needed).
    with open(png, "rb") as f, open(os.path.join(res_dir, "breach_origin_marker.bytes"), "wb") as o:
        o.write(f.read())

    # A4 at 300 dpi with the marker exactly MARKER_WIDTH_CM wide.
    dpi = 300
    a4 = (int(21.0 / 2.54 * dpi), int(29.7 / 2.54 * dpi))
    px = int(MARKER_WIDTH_CM / 2.54 * dpi)
    page = Image.new("RGB", a4, "white")
    page.paste(img.resize((px, px), Image.LANCZOS), ((a4[0] - px) // 2, int(3.0 / 2.54 * dpi)))
    d = ImageDraw.Draw(page)
    try:
        f = ImageFont.truetype(FONT, 48)
    except OSError:
        f = ImageFont.load_default()
    y = int(3.0 / 2.54 * dpi) + px + 80
    for line in (
        f"BREACH AR — WORLD ORIGIN MARKER. Print at 100% scale (no 'fit to page').",
        f"The black square must measure exactly {MARKER_WIDTH_CM:.0f} cm wide.",
        "Lay it flat on the floor or tape it to a wall. Matte paper, no glare.",
    ):
        d.text((int(1.5 / 2.54 * dpi), y), line, font=f, fill=(20, 20, 20))
        y += 70
    page.save(os.path.join(docs_dir, "BREACH_origin_marker_A4.pdf"), resolution=dpi)
    print("marker written:", os.path.abspath(png))


if __name__ == "__main__":
    main()
