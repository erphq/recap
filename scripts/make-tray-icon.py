# Menu bar icon: the app mark as a black template image (macOS tints it).
from PIL import Image, ImageDraw
for scale, name in ((1, 'trayTemplate.png'), (2, 'trayTemplate@2x.png')):
    k = 8  # draw large, then shrink for clean edges
    size = 18 * scale * k
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = scale * k  # one point
    for i, (end, alpha) in enumerate(((15, 255), (13, 150), (10.5, 150))):
        y = (4.5 + i * 4.5) * u
        r = 1.35 * u
        d.ellipse([2.6 * u - r, y - r, 2.6 * u + r, y + r], fill=(0, 0, 0, alpha))
        h = 1.7 * u
        d.rounded_rectangle([6 * u, y - h / 2, end * u, y + h / 2], radius=h / 2, fill=(0, 0, 0, alpha))
    img.resize((18 * scale, 18 * scale), Image.LANCZOS).save(f'assets/{name}')
