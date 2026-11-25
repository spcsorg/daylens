# Draws the Store package's logos in appx/ from build/icon.png: python3 app/package/appx.py (needs Pillow).
# Tiles hold the icon at two thirds of their height, as Windows' tile guidance asks; the small logos hold it whole.
from pathlib import Path
from PIL import Image

PKG = Path(__file__).parent
ICON = Image.open(PKG.parents[2] / 'build' / 'icon.png').convert('RGBA')
OUT = PKG / 'appx'


def draw(name, w, h, fill):
    canvas = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    side = round(h * fill)
    canvas.alpha_composite(ICON.resize((side, side), Image.LANCZOS), ((w - side) // 2, (h - side) // 2))
    canvas.save(OUT / name, optimize=True)


for old in OUT.glob('*.png'):
    old.unlink()
for scale in (100, 200, 400):
    k = scale / 100
    draw(f'StoreLogo.scale-{scale}.png', round(50 * k), round(50 * k), 1)
    draw(f'Square44x44Logo.scale-{scale}.png', round(44 * k), round(44 * k), 1)
    draw(f'Square150x150Logo.scale-{scale}.png', round(150 * k), round(150 * k), 2 / 3)
    draw(f'Wide310x150Logo.scale-{scale}.png', round(310 * k), round(150 * k), 2 / 3)
# The taskbar and Start list pick these by pixel size; unplated ones sit on no tile color.
for size in (16, 24, 32, 48, 256):
    draw(f'Square44x44Logo.targetsize-{size}.png', size, size, 1)
    draw(f'Square44x44Logo.targetsize-{size}_altform-unplated.png', size, size, 1)
