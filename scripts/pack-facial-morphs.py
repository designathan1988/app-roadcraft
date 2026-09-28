"""Pack a morph-enabled Rocketbox GLB without changing its rig or expressions."""

from io import BytesIO
from pathlib import Path
import json
import struct
import sys

import numpy as np
from PIL import Image


DTYPE = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


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
    return document, bytearray(data[binary_start + 8:binary_start + 8 + binary_length])


def pack(source: Path, target: Path):
    document, binary = load_glb(source)

    def read_accessor(index):
        accessor = document['accessors'][index]
        view = document['bufferViews'][accessor['bufferView']]
        components = WIDTH[accessor['type']]
        dtype = np.dtype(DTYPE[accessor['componentType']])
        start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
        stride = view.get('byteStride', components * dtype.itemsize)
        return np.ndarray((accessor['count'], components), dtype=dtype, buffer=binary,
                          offset=start, strides=(stride, dtype.itemsize)).copy()

    def append_accessor(array, template):
        array = np.ascontiguousarray(array)
        payload = array.tobytes()
        start = len(binary)
        binary.extend(payload)
        binary.extend(b'\0' * (-len(binary) % 4))
        document['bufferViews'].append({'buffer': 0, 'byteOffset': start, 'byteLength': len(payload)})
        accessor = {key: value for key, value in template.items() if key not in ('bufferView', 'byteOffset', 'min', 'max')}
        accessor.update(bufferView=len(document['bufferViews']) - 1, count=len(array))
        if template.get('type') == 'VEC3' and template.get('componentType') == 5126:
            accessor.update(min=array.min(axis=0).tolist(), max=array.max(axis=0).tolist())
        document['accessors'].append(accessor)
        return len(document['accessors']) - 1

    before = after = 0
    for mesh in document['meshes']:
        primitives = mesh['primitives']
        attributes = primitives[0]['attributes']
        targets = primitives[0].get('targets', [])
        if any(primitive['attributes'] != attributes or primitive.get('targets', []) != targets for primitive in primitives):
            raise ValueError('Facial pilot needs a shared attribute and target layout')
        arrays = {name: read_accessor(index) for name, index in attributes.items()}
        morph = [{name: read_accessor(index) for name, index in target.items()} for target in targets]
        vertices = len(arrays['POSITION'])
        records = list(arrays.values()) + [value for target in morph for value in target.values()]
        packed = np.concatenate([array.view(np.uint8).reshape(vertices, -1) for array in records], axis=1)
        keys = np.ascontiguousarray(packed).view(np.dtype((np.void, packed.shape[1]))).reshape(-1)
        _, selected, remap = np.unique(keys, return_index=True, return_inverse=True)
        packed_attributes = {name: append_accessor(array[selected], document['accessors'][attributes[name]])
                             for name, array in arrays.items()}
        packed_targets = []
        for target_map, original_map in zip(morph, targets):
            packed_targets.append({name: append_accessor(array[selected], document['accessors'][original_map[name]])
                                   for name, array in target_map.items()})
        groups = {}
        for primitive in primitives:
            if primitive.get('mode', 4) != 4:
                raise ValueError('Only triangle geometry is supported')
            groups.setdefault(primitive.get('material'), []).append(remap[read_accessor(primitive['indices']).reshape(-1)])
        mesh['primitives'] = [
            {'mode': 4, 'attributes': packed_attributes, 'material': material,
             'indices': append_accessor(np.concatenate(indices).astype(np.uint32).reshape(-1, 1),
                                        {'componentType': 5125, 'type': 'SCALAR'}),
             **({'targets': packed_targets} if packed_targets else {})}
            for material, indices in groups.items()
        ]
        before += vertices
        after += len(selected)

    accessors = set()
    for mesh in document['meshes']:
        for primitive in mesh['primitives']:
            accessors.update(primitive['attributes'].values())
            accessors.add(primitive['indices'])
            for morph in primitive.get('targets', []):
                accessors.update(morph.values())
    for skin in document.get('skins', []):
        if 'inverseBindMatrices' in skin:
            accessors.add(skin['inverseBindMatrices'])
    ordered = sorted(accessors)
    accessor_map = {old: new for new, old in enumerate(ordered)}
    remapped_targets = set()
    for mesh in document['meshes']:
        for primitive in mesh['primitives']:
            primitive['attributes'] = {name: accessor_map[index] for name, index in primitive['attributes'].items()}
            primitive['indices'] = accessor_map[primitive['indices']]
            for morph in primitive.get('targets', []):
                if id(morph) in remapped_targets:
                    continue
                for name, index in list(morph.items()):
                    morph[name] = accessor_map[index]
                remapped_targets.add(id(morph))
    for skin in document.get('skins', []):
        if 'inverseBindMatrices' in skin:
            skin['inverseBindMatrices'] = accessor_map[skin['inverseBindMatrices']]
    document['accessors'] = [document['accessors'][index] for index in ordered]

    images = {image['bufferView']: image for image in document.get('images', []) if 'bufferView' in image}
    views = sorted({accessor['bufferView'] for accessor in document['accessors'] if 'bufferView' in accessor} | set(images))
    view_map = {old: new for new, old in enumerate(views)}
    output = bytearray()
    new_views = []
    for old_index in views:
        view = document['bufferViews'][old_index]
        payload = binary[view.get('byteOffset', 0):view.get('byteOffset', 0) + view['byteLength']]
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
            image['bufferView'] = view_map[old_index]
        new_views.append({'buffer': 0, 'byteOffset': len(output), 'byteLength': len(payload)})
        output.extend(payload)
        output.extend(b'\0' * (-len(output) % 4))
    for accessor in document['accessors']:
        if 'bufferView' in accessor:
            accessor['bufferView'] = view_map[accessor['bufferView']]
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
    print(f'{source.name}: {before} -> {after} vertices; {source.stat().st_size} -> {target.stat().st_size} bytes')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: pack-facial-morphs.py SOURCE.glb TARGET.glb')
    pack(Path(sys.argv[1]), Path(sys.argv[2]))
