"""Fetch the pinned Microsoft Rocketbox source files for the city roster.

Run with Python and Pillow. Sources stay in a temporary build directory;
the game consumes converted GLBs, never these FBX/TGA working files.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import os
import urllib.request

from PIL import Image

REPOSITORY = 'microsoft/Microsoft-Rocketbox'
ROOT = Path(os.environ['TEMP']) / 'roadcraft-rocketbox'
ROOT.mkdir(parents=True, exist_ok=True)


def read_json(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Roadcraft-asset-builder'})
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


manifest_path = ROOT / 'source-manifest.json'
if manifest_path.exists():
    manifest = json.loads(manifest_path.read_text())
else:
    revision = read_json(f'https://api.github.com/repos/{REPOSITORY}/commits/master')['sha']
    tree = read_json(f'https://api.github.com/repos/{REPOSITORY}/git/trees/{revision}?recursive=1')['tree']
    # Wardrobe selection: everyday clothes and civilian occupations.
    excluded_wardrobes = {'Female_Adult_06', 'Female_Adult_10', 'Female_Adult_15',
                         'Female_Adult_16', 'Male_Adult_15', 'Male_Adult_19', 'Male_Adult_21',
                         'Female_Child_02', 'Construction_Male_01', 'Sports_Female_01',
                         'Sports_Male_01', 'Medical_Male_05'}
    occupations = ('Business_', 'Construction_', 'Medical_', 'Sports_', 'Chef_',
                   'Delivery_', 'Gardener_', 'Security_', 'Wood_', 'Pilot_')
    service_roles = {'Police_Male_01', 'Police_Male_03', 'Police_Male_06'}
    models = []
    for entry in tree:
        parts = entry['path'].split('/')
        if len(parts) != 6 or parts[:2] != ['Assets', 'Avatars'] or parts[4] != 'Export':
            continue
        category, name, filename = parts[2], parts[3], parts[5]
        if filename != name + '.fbx':
            continue
        if name in excluded_wardrobes:
            continue
        selected = category in ('Adults', 'Children')
        selected |= category == 'Professions' and (name.startswith(occupations) or name in service_roles)
        if not selected:
            continue
        prefix = '/'.join(parts[:4]) + '/'
        files = [e['path'] for e in tree if e['path'].startswith(prefix) and
                 (e['path'] == entry['path'] or ('_color' in e['path'] and e['path'].endswith('.tga')))]
        models.append({'name': name, 'id': name.lower().replace('_adult', ''),
                       'category': category, 'files': files})
    models.sort(key=lambda model: model['name'])
    if len(models) != 80:
        raise RuntimeError(f'Expected 80 source avatars, found {len(models)}')
    manifest = {'repository': REPOSITORY, 'revision': revision, 'models': models}
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')

if manifest.get('schemaVersion', 0) < 4:
    tree = read_json(f"https://api.github.com/repos/{REPOSITORY}/git/trees/{manifest['revision']}?recursive=1")['tree']
    removed = {'Female_Child_02', 'Construction_Male_01', 'Sports_Female_01', 'Sports_Male_01',
               'Medical_Male_05', 'Fire_Female_01', 'Fire_Male_01', 'Fire_Male_02',
               'Police_Female_01', 'Police_Male_02'}
    manifest['models'] = [model for model in manifest['models'] if model['name'] not in removed]
    existing = {model['name'] for model in manifest['models']}
    for entry in tree:
        parts = entry['path'].split('/')
        if len(parts) != 6 or parts[:3] != ['Assets', 'Avatars', 'Professions'] or parts[4] != 'Export':
            continue
        name = parts[3]
        if parts[5] != name + '.fbx' or name in existing:
            continue
        if not (name.startswith('Pilot_') or name in {'Police_Male_01', 'Police_Male_03', 'Police_Male_06'}):
            continue
        prefix = '/'.join(parts[:4]) + '/'
        files = [item['path'] for item in tree if item['path'].startswith(prefix) and
                 (item['path'] == entry['path'] or ('_color' in item['path'] and item['path'].endswith('.tga')))]
        manifest['models'].append({'name': name, 'id': name.lower(), 'category': 'Professions', 'files': files})
    manifest['models'].sort(key=lambda model: model['name'])
    assert len(manifest['models']) == 80
    manifest['schemaVersion'] = 4
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')

if manifest.get('schemaVersion', 0) < 2:
    tree = read_json(f"https://api.github.com/repos/{REPOSITORY}/git/trees/{manifest['revision']}?recursive=1")['tree']
    for model in manifest['models']:
        prefix = f"Assets/Avatars/{model['category']}/{model['name']}/"
        model['files'] = [entry['path'] for entry in tree if entry['path'].startswith(prefix) and
                          (entry['path'].endswith('/Export/' + model['name'] + '.fbx') or
                           ('_color' in entry['path'] and entry['path'].endswith('.tga')))]
    manifest['schemaVersion'] = 2
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')


def fetch(model):
    folder = ROOT / model['name']
    folder.mkdir(exist_ok=True)
    for relative in model['files']:
        target = folder / Path(relative).name
        if not target.exists():
            url = f"https://raw.githubusercontent.com/{REPOSITORY}/{manifest['revision']}/{relative}"
            urllib.request.urlretrieve(url, target)
        if target.suffix == '.tga':
            output = target.with_suffix('.png')
            if not output.exists():
                with Image.open(target) as image:
                    image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
                    image.save(output)
    return model['name']


with ThreadPoolExecutor(max_workers=6) as pool:
    for number, name in enumerate(pool.map(fetch, manifest['models']), start=1):
        print(f'{number:02d}/80 {name}', flush=True)

license_path = ROOT / 'LICENSE.md'
if not license_path.exists():
    urllib.request.urlretrieve(
        f"https://raw.githubusercontent.com/{REPOSITORY}/{manifest['revision']}/LICENSE.md", license_path)
print(f'Source manifest: {manifest_path}', flush=True)
