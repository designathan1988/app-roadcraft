"""Compress textures of a facial Rocketbox GLB without touching its rig or morphs."""

from io import BytesIO
from pathlib import Path
import json
import struct
import sys

from PIL import Image


def load_glb(path: Path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from('<III', data, 0)
    if magic != 0x46546C67 or version != 2 or length != len(data):
        raise ValueError(f'{path} is not a valid GLB 2.0 file')
    json_length, json_type = struct.unpack_from('<II', data, 12)
    if json_type != 0x4E4F534A:
        raise ValueError('Missing JSON chunk')
    document = json.loads(data[20:20 + json_length])
    binary_start = 20 + json_length
    binary_length, binary_type = struct.unpack_from('<II', data, binary_start)
    if binary_type != 0x004E4942:
        raise ValueError('Missing binary chunk')
    return document, data[binary_start + 8:binary_start + 8 + binary_length]


def pack(source: Path, target: Path):
    document, binary = load_glb(source)
    images = {image['bufferView']: image for image in document.get('images', []) if 'bufferView' in image}
    views = document['bufferViews']
    new_views = []
    output = bytearray()
    view_map = {}
    for old_index, view in enumerate(views):
        start = view.get('byteOffset', 0)
        payload = binary[start:start + view['byteLength']]
        image = images.get(old_index)
        if image:
            with Image.open(BytesIO(payload)) as bitmap:
                bitmap.thumbnail((512, 512), Image.Resampling.LANCZOS)
                encoded = BytesIO()
                alpha = bitmap.mode == 'RGBA' and bitmap.getextrema()[3][0] < 255
                if alpha:
                    bitmap.save(encoded, format='PNG', optimize=True)
                    image['mimeType'] = 'image/png'
                else:
                    bitmap.convert('RGB').save(encoded, format='JPEG', quality=88, optimize=True)
                    image['mimeType'] = 'image/jpeg'
                payload = encoded.getvalue()
        view_map[old_index] = len(new_views)
        new_views.append({'buffer': 0, 'byteOffset': len(output), 'byteLength': len(payload)})
        output.extend(payload)
        output.extend(b'\0' * (-len(output) % 4))
    for accessor in document['accessors']:
        if 'bufferView' in accessor:
            accessor['bufferView'] = view_map[accessor['bufferView']]
    for image in document.get('images', []):
        if 'bufferView' in image:
            image['bufferView'] = view_map[image['bufferView']]
    document['bufferViews'] = new_views
    document['buffers'] = [{'byteLength': len(output)}]
    encoded = json.dumps(document, separators=(',', ':')).encode('utf-8')
    encoded += b' ' * (-len(encoded) % 4)
    glb = (
        struct.pack('<III', 0x46546C67, 2, 28 + len(encoded) + len(output))
        + struct.pack('<II', len(encoded), 0x4E4F534A) + encoded
        + struct.pack('<II', len(output), 0x004E4942) + output
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(glb)
    print(f'{source.name}: {source.stat().st_size} -> {target.stat().st_size} bytes')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: pack-facial-pilot.py SOURCE.glb TARGET.glb')
    pack(Path(sys.argv[1]), Path(sys.argv[2]))
