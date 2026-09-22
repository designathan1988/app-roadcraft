"""Pack converted Rocketbox avatars without redundant vertices/material groups.

Outputs remain in the temporary source cache until reviewed and published.
Requires numpy and Pillow. Every source triangle and skin weight is preserved.
"""
from pathlib import Path
import hashlib
import io
import json
import os
import struct

import numpy as np
from PIL import Image

ROOT = Path(os.environ['TEMP']) / 'roadcraft-rocketbox'
OUT = ROOT / 'packed'
OUT.mkdir(exist_ok=True)
MANIFEST = json.loads((ROOT / 'source-manifest.json').read_text())
DTYPE = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
catalog = []

for model in MANIFEST['models']:
    source = ROOT / (model['name'] + '.glb')
    raw = source.read_bytes()
    size = struct.unpack_from('<I', raw, 12)[0]
    document = json.loads(raw[20:20 + size])
    binary = bytearray(raw[28 + size:])

    def read_accessor(index):
        accessor = document['accessors'][index]
        view = document['bufferViews'][accessor['bufferView']]
        assert 'sparse' not in accessor
        components = WIDTH[accessor['type']]
        dtype = np.dtype(DTYPE[accessor['componentType']])
        start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
        stride = view.get('byteStride', components * dtype.itemsize)
        return np.ndarray((accessor['count'], components), dtype=dtype,
                          buffer=binary, offset=start, strides=(stride, dtype.itemsize)).copy()

    def append_accessor(array, template):
        array = np.ascontiguousarray(array)
        payload = array.tobytes()
        start = len(binary)
        binary.extend(payload)
        binary.extend(b'\0' * (-len(binary) % 4))
        document['bufferViews'].append({'buffer': 0, 'byteOffset': start, 'byteLength': len(payload)})
        accessor = {k: v for k, v in template.items() if k not in ('bufferView', 'byteOffset', 'min', 'max')}
        accessor.update(bufferView=len(document['bufferViews']) - 1, count=len(array))
        if template.get('type') == 'VEC3' and template.get('componentType') == 5126:
            accessor.update(min=array.min(axis=0).tolist(), max=array.max(axis=0).tolist())
        document['accessors'].append(accessor)
        return len(document['accessors']) - 1

    before_vertices = after_vertices = before_primitives = after_primitives = 0
    for mesh in document['meshes']:
        primitives = mesh['primitives']
        attributes = primitives[0]['attributes']
        if any(primitive['attributes'] != attributes for primitive in primitives):
            raise RuntimeError(f"Unexpected separate attribute layouts in {model['name']}")
        arrays = {name: read_accessor(index) for name, index in attributes.items()}
        vertices = len(arrays['POSITION'])
        packed = np.concatenate([array.view(np.uint8).reshape(vertices, -1) for array in arrays.values()], axis=1)
        records = np.ascontiguousarray(packed).view(np.dtype((np.void, packed.shape[1]))).reshape(-1)
        _, selected, remap = np.unique(records, return_index=True, return_inverse=True)
        new_attributes = {name: append_accessor(array[selected], document['accessors'][attributes[name]])
                          for name, array in arrays.items()}
        groups = {}
        for primitive in primitives:
            if primitive.get('mode', 4) != 4 or primitive.get('targets'):
                raise RuntimeError('Only triangle geometry without morph targets is supported')
            original = read_accessor(primitive['indices']).reshape(-1)
            groups.setdefault(primitive['material'], []).append(remap[original])
        new_primitives = []
        for material, indices in groups.items():
            merged = np.concatenate(indices).astype(np.uint32).reshape(-1, 1)
            new_primitives.append({'mode': 4, 'attributes': new_attributes, 'material': material,
                                   'indices': append_accessor(merged, {'componentType': 5125, 'type': 'SCALAR'})})
        mesh['primitives'] = new_primitives
        before_vertices += vertices
        after_vertices += len(selected)
        before_primitives += len(primitives)
        after_primitives += len(new_primitives)

    accessors = set()
    for mesh in document['meshes']:
        for primitive in mesh['primitives']:
            accessors.update(primitive['attributes'].values())
            accessors.add(primitive['indices'])
    for skin in document.get('skins', []):
        accessors.add(skin['inverseBindMatrices'])
    for animation in document['animations']:
        for sampler in animation['samplers']:
            accessors.update([sampler['input'], sampler['output']])
    ordered = sorted(accessors)
    accessor_map = {old: new for new, old in enumerate(ordered)}
    for mesh in document['meshes']:
        for primitive in mesh['primitives']:
            primitive['attributes'] = {name: accessor_map[index] for name, index in primitive['attributes'].items()}
            primitive['indices'] = accessor_map[primitive['indices']]
    for skin in document.get('skins', []):
        skin['inverseBindMatrices'] = accessor_map[skin['inverseBindMatrices']]
    for animation in document['animations']:
        for sampler in animation['samplers']:
            sampler.update(input=accessor_map[sampler['input']], output=accessor_map[sampler['output']])
    document['accessors'] = [document['accessors'][index] for index in ordered]
    images = {image['bufferView']: image for image in document.get('images', [])}
    views = sorted({a['bufferView'] for a in document['accessors']} | set(images))
    view_map = {old: new for new, old in enumerate(views)}
    result = bytearray()
    output_views = []
    for index in views:
        view = document['bufferViews'][index].copy()
        start = view.get('byteOffset', 0)
        payload = binary[start:start + view['byteLength']]
        if index in images:
            with Image.open(io.BytesIO(payload)) as image:
                image.thumbnail((512, 512), Image.Resampling.LANCZOS)
                transparent = image.mode == 'RGBA' and image.getextrema()[3][0] < 255
                encoded = io.BytesIO()
                if transparent:
                    image.save(encoded, format='PNG', optimize=True)
                else:
                    image.convert('RGB').save(encoded, format='JPEG', quality=90, optimize=True)
                payload = encoded.getvalue()
                images[index]['mimeType'] = 'image/png' if transparent else 'image/jpeg'
                images[index]['bufferView'] = view_map[index]
        view.update(buffer=0, byteOffset=len(result), byteLength=len(payload))
        result.extend(payload)
        result.extend(b'\0' * (-len(result) % 4))
        output_views.append(view)
    for accessor in document['accessors']:
        accessor['bufferView'] = view_map[accessor['bufferView']]
    document['bufferViews'] = output_views
    document['buffers'] = [{'byteLength': len(result)}]
    encoded = json.dumps(document, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    glb = (struct.pack('<III', 0x46546c67, 2, 28 + len(encoded) + len(result)) +
           struct.pack('<II', len(encoded), 0x4e4f534a) + encoded +
           struct.pack('<II', len(result), 0x004e4942) + result)
    target = OUT / (model['id'] + '.glb')
    target.write_bytes(glb)
    catalog.append({'id': model['id'], 'source': model['name'], 'category': model['category'],
                    'bytes': len(glb), 'sha256': hashlib.sha256(glb).hexdigest(),
                    'verticesBefore': before_vertices, 'vertices': after_vertices,
                    'primitivesBefore': before_primitives, 'primitives': after_primitives,
                    'clips': [clip['name'] for clip in document['animations']]})
    print(f"{model['id']}: {before_vertices}->{after_vertices} vertices, "
          f"{before_primitives}->{after_primitives} groups, {len(glb)//1024} KiB", flush=True)

(OUT / 'catalog.json').write_text(json.dumps({'sourceRevision': MANIFEST['revision'], 'models': catalog}, indent=2) + '\n')
print(f'Packed {len(catalog)} avatars: {sum(model["bytes"] for model in catalog)/1024/1024:.1f} MiB', flush=True)
