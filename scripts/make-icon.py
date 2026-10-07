# Draws the Recap icon: three one-liners on a dark tile, the first one live.
from PIL import Image, ImageDraw
S = 1024
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
tile = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(tile)
pad, radius = 100, 186
for y in range(pad, S - pad):  # soft vertical gradient
    t = (y - pad) / (S - 2 * pad)
    c = tuple(int(a + (b - a) * t) for a, b in zip((46, 46, 50), (24, 24, 27)))
    d.line([(pad, y), (S - pad, y)], fill=c + (255,))
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([pad, pad, S - pad, S - pad], radius=radius, fill=255)
img.paste(tile, (0, 0), mask)
# Marks go on their own layer and are blended, so the fainter rows read as grey.
marks = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(marks)
dx = 24  # centre the group optically
rows = [(392, 700, (76, 194, 126, 255), 240), (512, 620, (255, 255, 255, 96), 150), (632, 540, (255, 255, 255, 96), 110)]
for y, x2, dot, alpha in rows:
    r = 24
    d.ellipse([300 + dx - r, y - r, 300 + dx + r, y + r], fill=dot)
    h = 30
    d.rounded_rectangle([372 + dx, y - h // 2, x2 + dx, y + h // 2], radius=h // 2, fill=(255, 255, 255, alpha))
img = Image.alpha_composite(img, marks)
img.save('assets/icon-1024.png')
