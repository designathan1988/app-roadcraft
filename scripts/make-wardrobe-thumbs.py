"""Writes a small rendered thumbnail, <name>-thumb.webp, for every item the
Person Creator offers (system and curated community items), from the .thumb
image MakeHuman packs ship with each item (a rendering of the item itself),
so the creator's galleries show the hair, garment or lashes - not its flat
texture.

    python scripts/make-wardrobe-thumbs.py
"""
import glob
import json
import os
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'public', 'models', 'people', 'proxies')
SIZE = 160

thumbs = {}
for pack in ('makehuman-system', 'makehuman-community'):
    for path in glob.glob(os.path.join(ROOT, '.cache', pack, 'x', '**', '*.thumb'), recursive=True):
        thumbs.setdefault(os.path.basename(path)[:-6], path)

items = [os.path.basename(p)[:-5] for p in glob.glob(os.path.join(OUT, '*.json'))
         if not os.path.basename(p).startswith(('index', 'community'))]
written = missing = 0
for name in items:
    source = thumbs.get(name)
    if not source:
        missing += 1
        continue
    image = Image.open(source).convert('RGB')
    image.thumbnail((SIZE, SIZE))
    image.save(os.path.join(OUT, f'{name}-thumb.webp'), 'WEBP', quality=80)
    written += 1
print(f'{written} thumbnails, {missing} items without one')
