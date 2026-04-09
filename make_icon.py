#!/usr/bin/env python3
"""
Generate app icons for all platforms — pure Python stdlib, no pip needed.
  resources/icon.png   Linux  (256x256 RGBA)
  resources/icon.ico   Windows (16/32/48/64/128/256 px multi-res)
  resources/icon.icns  macOS  (16/32/64/128/256/512/1024 px)
Run:  python3 make_icon.py
"""
import struct, zlib, math, os

os.makedirs('resources', exist_ok=True)

def draw_rgba(sz):
    """BESS lightning bolt icon at sz pixels, returns RGBA bytes."""
    half, px = sz // 2, bytearray(sz * sz * 4)
    for y in range(sz):
        for x in range(sz):
            dx, dy = x - half, y - half
            r  = math.sqrt(dx*dx + dy*dy)
            i  = (y * sz + x) * 4
            rg = max(2, sz // 32)
            if r >= half:
                px[i:i+4] = [0, 0, 0, 0]
            elif r >= half - rg:
                px[i:i+4] = [48, 209, 88, 255]
            else:
                px[i:i+4] = [13, 17, 23, 255]
                s = sz / 256
                upper = int(95*s)  <= x <= int(140*s) and int(55*s)  <= y <= int(138*s)
                lower = int(112*s) <= x <= int(158*s) and int(118*s) <= y <= int(200*s)
                join  = int(88*s)  <= x <= int(162*s) and int(118*s) <= y <= int(140*s)
                if upper or lower or join:
                    px[i:i+4] = [48, 209, 88, 255]
    return bytes(px)

def make_png(sz, rgba):
    def chunk(name, data):
        c = name + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    rows = b''.join(b'\x00' + rgba[y*sz*4:(y+1)*sz*4] for y in range(sz))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', sz, sz, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows, 9))
            + chunk(b'IEND', b''))

def make_ico(sizes):
    images = [(sz, make_png(sz, draw_rgba(sz))) for sz in sizes]
    header = struct.pack('<HHH', 0, 1, len(images))
    offset = 6 + 16 * len(images)
    directory = b''
    for sz, png in images:
        w = 0 if sz >= 256 else sz
        h = 0 if sz >= 256 else sz
        directory += struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(png), offset)
        offset += len(png)
    return header + directory + b''.join(p for _, p in images)

def make_icns(sizes):
    ostype = {16:b'icp4', 32:b'icp5', 64:b'icp6',
              128:b'ic07', 256:b'ic08', 512:b'ic09', 1024:b'ic10'}
    body = b''
    for sz in sizes:
        if sz not in ostype:
            continue
        png = make_png(sz, draw_rgba(sz))
        body += ostype[sz] + struct.pack('>I', 8 + len(png)) + png
    return b'icns' + struct.pack('>I', 8 + len(body)) + body

with open('resources/icon.png', 'wb') as f:
    f.write(make_png(256, draw_rgba(256)))
print('  icon.png   (256x256, Linux)')

with open('resources/icon.ico', 'wb') as f:
    f.write(make_ico([256, 128, 64, 48, 32, 16]))
print('  icon.ico   (multi-res, Windows)')

with open('resources/icon.icns', 'wb') as f:
    f.write(make_icns([1024, 512, 256, 128, 64, 32, 16]))
print('  icon.icns  (multi-res, macOS)')
