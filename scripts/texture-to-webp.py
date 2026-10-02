# Resizes an item's diffuse texture to a square WebP for the game, as the
# MakeHuman importers need it (scripts/import-makehuman-community.mjs): grey
# (luminance, alpha kept) when the game dyes it, and the average colour of its
# opaque pixels. No browser.
#
#   python scripts/texture-to-webp.py <in> <out.webp> <size> <grey 0|1>
# prints {"average": [r, g, b] | null}
import json
import sys

from PIL import Image

src, out, size, grey = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4] == '1'
img = Image.open(src).convert('RGBA').resize((size, size), Image.Resampling.BILINEAR)
r = g = b = n = 0
for pr, pg, pb, pa in img.getdata():
    if pa < 200:
        continue
    r += pr; g += pg; b += pb; n += 1
if grey:
    alpha = img.getchannel('A')
    lum = img.convert('RGB').convert('L')
    img = Image.merge('RGBA', (lum, lum, lum, alpha))
img.save(out, 'WEBP', quality=84)
print(json.dumps({'average': [round(r / n), round(g / n), round(b / n)] if n else None}))
