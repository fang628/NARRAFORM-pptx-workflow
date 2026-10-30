"""Header-only contact sheet and observed PNG colors for native navigation."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw
import cv2
import numpy as np


def palette(image):
    quantized = image.convert('RGB').quantize(colors=96)
    colors = quantized.getpalette()
    return [(count, tuple(colors[index*3:index*3+3])) for count, index in sorted(quantized.getcolors(), reverse=True)]


def navigation_score(header, full_size, layout):
    edges = cv2.Canny(np.array(header.convert('L')), 35, 110)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if h < header.height*.08 or w < header.width*.055 or w/h < 1.8 or h > header.height*.65:
            continue
        vertices = len(cv2.approxPolyDP(contour, cv2.arcLength(contour, True)*.02, True))
        if (layout == 'chevron' and 5 <= vertices <= 7) or (layout == 'bubble' and 4 <= vertices <= 10):
            if not any(abs(x-a)+abs(y-b)+abs(w-c)+abs(h-d)<12 for a,b,c,d in boxes):
                boxes.append((x,y,w,h))
    # A row needs several aligned segments. A lone title/card is not enough to
    # invent a navigation position when the vision service is unavailable.
    rows = []
    for seed in boxes:
        center = seed[1]+seed[3]/2
        aligned = [b for b in boxes if abs(b[1]+b[3]/2-center) <= max(4, seed[3]*.25)
                   and .65 <= b[3]/seed[3] <= 1.5]
        # Edge detection often returns both the inner and outer outline.
        segments = []
        for b in sorted(aligned, key=lambda b: b[2]*b[3], reverse=True):
            if not any(min(b[0]+b[2], a[0]+a[2])-max(b[0], a[0]) > min(b[2], a[2])*.6 for a in segments):
                segments.append(b)
        if len(segments) < 3:
            continue
        left, top = min(b[0] for b in segments), min(b[1] for b in segments)
        right, bottom = max(b[0]+b[2] for b in segments), max(b[1]+b[3] for b in segments)
        if right-left >= full_size[0]*.2:
            rows.append((len(segments), left, top, right-left, bottom-top))
    if not rows:
        return {'score': len(boxes), 'box': None}
    count, x, y, w, h = max(rows, key=lambda r: (r[0], r[3], -r[2]))
    return {'score': count, 'box': [x/full_size[0], y/full_size[1], w/full_size[0], h/full_size[1]]}


def main():
    spec = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    output = Path(sys.argv[2])
    if spec['operation'] == 'montage':
        columns, width, height = 2, 960, 213
        sheet = Image.new('RGB', (columns*width, ((len(spec['pages'])+1)//columns)*height), '#eeeeee')
        draw = ImageDraw.Draw(sheet)
        candidates = []
        for n, page in enumerate(spec['pages']):
            with Image.open(page['file']) as source:
                source = source.convert('RGB')
                header = source.crop((0, 0, source.width, round(source.height*.35)))
                tile = header.resize((width, height-24))
                x, y = n % columns*width, n // columns*height
                sheet.paste(tile, (x, y+24))
                draw.text((x+8, y+5), 'P'+str(page['index']+1), fill='#222222')
                colors = palette(header)
                # A local fallback uses one source page too, never the theme name.
                colorful = [(count, color) for count, color in colors if max(color)-min(color)>30]
                candidates.append({'index': page['index'], **navigation_score(header, source.size, spec.get('layout','chevron')), 'colors': ['%02X%02X%02X' % c for _, c in colors[:96]], 'accent': '%02X%02X%02X' % (colorful[0][1] if colorful else colors[min(1,len(colors)-1)][1])})
        sheet.save(output)
        print(json.dumps({'candidates': candidates}))
    else:
        with Image.open(spec['file']) as source:
            source = source.convert('RGB')
            x, y, w, h = spec.get('box', [0, 0, 1, .18])
            crop = source.crop((round(x*source.width), round(y*source.height), round((x+w)*source.width), round((y+h)*source.height)))
            colors = [c for _, c in palette(crop)]
            snapped = {}
            for key, value in spec['colors'].items():
                target = tuple(int(value[i:i+2],16) for i in (0,2,4))
                color = min(colors, key=lambda c: sum((a-b)**2 for a,b in zip(c,target)))
                snapped[key] = '%02X%02X%02X' % color
            crop.save(output)
            print(json.dumps({'colors': snapped}))


if __name__ == '__main__':
    main()
