#!/usr/bin/env python3
"""Rasterise the Embernest app icon to PNG (192 and 512 px) for the PWA manifest.

One-off tool, run with the managed venv (ComfyUI pulls in Pillow):
  <home>/venv/bin/python python/make_icons.py
Writes src/web/icons/icon-192.png and icon-512.png. Keep the flame outline and
colours in step with src/web/icons/icon.svg.
"""
import math
import os

from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'web', 'icons')
SS = 4  # supersampling factor, for smooth edges after the downscale
GRID = 512  # icon.svg is drawn on a 512 grid
BG_TOP = (36, 26, 22)      # #241a16
BG_BOTTOM = (13, 9, 8)     # #0d0908
FLAME_TOP = (255, 195, 92)   # #ffc35c
FLAME_MID = (255, 122, 24)   # #ff7a18
FLAME_BOTTOM = (232, 89, 12) # #e8590c


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def flame_points():
    """Flame outline in the 48-unit space of the favicon path (same as icon.svg)."""
    pts = [(24.0, 3.0)]

    def cubic(p0, p1, p2, p3, n=24):
        for i in range(1, n + 1):
            t = i / n
            u = 1 - t
            pts.append((
                u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
            ))

    cubic((24, 3), (27, 9), (33, 11), (33, 19))
    for i in range(1, 33):  # the arc: centre (24, 19), radius 9, through the bottom
        a = math.pi * i / 32
        pts.append((24 + 9 * math.cos(a), 19 + 9 * math.sin(a)))
    cubic((15, 19), (15, 15), (17, 13), (19, 10))
    cubic((19, 10), (20, 12), (21, 13), (23, 13))
    cubic((23, 13), (22, 9), (22, 6), (24, 3))
    return pts


def flame_gradient_colour(uy):
    """Colour for a flame height uy in 48-unit space (flame spans y 3..28)."""
    t = min(max((uy - 3) / 25, 0.0), 1.0)
    if t < 0.55:
        return lerp(FLAME_TOP, FLAME_MID, t / 0.55)
    return lerp(FLAME_MID, FLAME_BOTTOM, (t - 0.55) / 0.45)


def render(n):
    size = n * SS
    k = size / GRID

    # Dark rounded square (rx 112 on the 512 grid).
    grad = Image.new('RGBA', (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        gd.line([(0, y), (size, y)], fill=lerp(BG_TOP, BG_BOTTOM, y / (size - 1)) + (255,))
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=112 * k, fill=255)
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    # Flame: translate(96 96) scale(7) in the 512 grid.
    def to_px(p):
        return ((96 + 7 * p[0]) * k, (96 + 7 * p[1]) * k)

    flame_mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(flame_mask).polygon([to_px(p) for p in flame_points()], fill=255)
    fgrad = Image.new('RGBA', (size, size))
    fd = ImageDraw.Draw(fgrad)
    for y in range(size):
        uy = (y / k - 96) / 7
        fd.line([(0, y), (size, y)], fill=flame_gradient_colour(uy) + (255,))
    img.paste(fgrad, (0, 0), flame_mask)

    return img.resize((n, n), Image.Resampling.LANCZOS)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for n in (192, 512):
        path = os.path.join(OUT_DIR, f'icon-{n}.png')
        render(n).save(path, optimize=True)
        print(f'wrote {os.path.normpath(path)}')


if __name__ == '__main__':
    main()
