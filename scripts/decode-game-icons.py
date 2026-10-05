"""Decode selected local cooked UE4.26 UI textures; never writes game files.

Only the observed inline, single-slice cooked layout is accepted. The bulk header,
dimensions and payload length must agree before the image decoder is called.
See UEViewer Unreal/UnrealMaterial/UnTexture4.cpp for the cooked platform layout.
"""
import io
import json
import struct
from pathlib import Path
from PIL import Image

BASE = Path(__file__).resolve().parent.parent
plan = json.loads((BASE / '.downloads/game-icon-plan.json').read_text(encoding='utf-8'))
out = Path(plan['output'])
out.mkdir(parents=True, exist_ok=True)


def decode(raw):
    data = Path(raw).read_bytes()
    if len(data) > 32 * 1024 * 1024:
        raise ValueError('texture payload exceeds build limit')
    pos = data.find(b'PF_')
    if pos < 16:
        raise ValueError('no texture platform data')
    w, h, slices, length = struct.unpack_from('<4i', data, pos - 16)
    if not (0 < w <= 4096 and 0 < h <= 4096 and slices == 1 and 4 < length < 32):
        raise ValueError('unsupported texture dimensions or format')
    fmt = data[pos:pos + length - 1].decode('ascii')
    if data[pos + length - 1] != 0:
        raise ValueError('invalid format string')
    cursor = pos + length
    first, count = struct.unpack_from('<2i', data, cursor)
    cursor += 8
    if first < 0 or not 1 <= count <= 16:
        raise ValueError('invalid mip table')
    cooked, flags, elements, size, offset = struct.unpack_from('<4iq', data, cursor)
    cursor += 24
    if cooked != 1 or flags != 72 or elements != size or size < 1:
        raise ValueError(f'unsupported bulk layout {flags}')
    if cursor + size + 12 > len(data):
        raise ValueError('truncated inline mip')
    mw, mh, mz = struct.unpack_from('<3i', data, cursor + size)
    if (mw, mh, mz) != (w, h, 1):
        raise ValueError('mip dimensions differ')
    if offset != Path(raw).with_suffix('.uasset').stat().st_size + cursor:
        raise ValueError('inline payload offset differs')
    sizes = {'PF_DXT1': ((w + 3) // 4) * ((h + 3) // 4) * 8,
             'PF_DXT5': ((w + 3) // 4) * ((h + 3) // 4) * 16,
             'PF_B8G8R8A8': w * h * 4}
    if fmt not in sizes or size != sizes[fmt]:
        raise ValueError(f'unsupported pixel format or payload {fmt}')
    payload = data[cursor:cursor + size]
    if fmt == 'PF_B8G8R8A8':
        return Image.frombytes('RGBA', (w, h), payload, 'raw', 'BGRA'), fmt
    fourcc = b'DXT1' if fmt == 'PF_DXT1' else b'DXT5'
    header = struct.pack('<7I', 124, 0x81007, h, w, size, 0, 1)
    header += bytes(44)
    header += struct.pack('<II4s5I', 32, 4, fourcc, 0, 0, 0, 0, 0)
    header += struct.pack('<5I', 0x1000, 0, 0, 0, 0)
    image = Image.open(io.BytesIO(b'DDS ' + header + payload)).convert('RGBA')
    return image, fmt


complete = set()
report = {'build': plan['build'], 'decoded': [], 'unavailable': []}
(BASE / 'test-results').mkdir(parents=True, exist_ok=True)
for asset in plan['assets']:
    try:
        picture, fmt = decode(asset['raw'])
        original = list(picture.size)
        picture.thumbnail((192, 192), Image.Resampling.LANCZOS)
        picture.save(out / (asset['key'] + '.png'), optimize=True)
        complete.add(asset['key'])
        report['decoded'].append({'source': asset['source'], 'file': asset['key'] + '.png',
                                  'format': fmt, 'originalSize': original, 'size': list(picture.size)})
    except (ValueError, OSError, struct.error) as error:
        report['unavailable'].append({'source': asset['source'], 'reason': str(error)})
entries = {id: key + '.png' for id, key in plan['entries'].items() if key in complete}
index = {'build': plan['build'], 'source': '本机游戏 UI 图像 · 仅供本机个人使用', 'entries': entries}
(BASE / 'src/data/game-images.json').write_text(json.dumps(index, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
report['references'] = len(entries)
(BASE / 'test-results/game-images-build.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Decoded {len(complete)} UI textures / {len(entries)} references; {len(report["unavailable"])} unavailable')
