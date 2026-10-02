"""Paints the MakeHuman logo out of the system casual suits' shirt textures,
filling it from the fabric around it (OpenCV inpainting).

Where each logo sits was read off each texture by eye (512 px textures):
automatic detection mistook sleeves and jeans for logos. Runs on
public/models/people/proxies/<suit>.webp in place; after re-importing the
system pack (scripts/import-makehuman-proxies.mjs), run this again.

    python scripts/remove-shirt-logos.py
"""
import os
import cv2
import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'models', 'people', 'proxies')

# Ellipses round each logo: centre x, centre y, full width, full height (pixels).
LOGOS = {
    'female_casualsuit01': [(407, 118, 96, 84)],
    'female_casualsuit02': [(407, 118, 96, 84)],
    'male_casualsuit02': [(288, 88, 84, 84)],
    'male_casualsuit04': [(285, 85, 88, 88)],
    'male_casualsuit06': [(273, 84, 136, 44), (130, 71, 84, 32)],
}

for name, ellipses in LOGOS.items():
    path = os.path.join(ROOT, f'{name}.webp')
    image = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    bgr = image[:, :, :3]
    region = np.zeros(bgr.shape[:2], np.uint8)
    for cx, cy, w, h in ellipses:
        cv2.ellipse(region, ((cx, cy), (w, h), 0), 255, -1)
    filled = cv2.inpaint(bgr, region, 9, cv2.INPAINT_TELEA)
    if image.shape[2] == 4:
        filled = np.dstack([filled, image[:, :, 3]])
    cv2.imwrite(path, filled, [cv2.IMWRITE_WEBP_QUALITY, 90])
    print(f'{name}: {len(ellipses)} logo region(s) filled')
