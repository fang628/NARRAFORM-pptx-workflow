"""Estimate text-like detail height without OCR; never changes source pixels."""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8')
cv2.setNumThreads(1)


def measure(file):
    with Image.open(file) as im:
        im = ImageOps.exif_transpose(im).convert('RGB')
        width, height = im.size
        scale = min(1, 2200/max(width, height))
        if scale < 1:
            im = im.resize((round(width*scale), round(height*scale)))
        gray = cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2GRAY)
    boxes = []
    # Both polarities support dark/light figures. Keep repeated character-sized
    # connected components on a shared baseline, rather than diagram strokes.
    for mode in (cv2.THRESH_BINARY, cv2.THRESH_BINARY_INV):
        _, mask = cv2.threshold(gray, 0, 255, mode | cv2.THRESH_OTSU)
        count, _, stats, centers = cv2.connectedComponentsWithStats(mask, 8)
        rows = {}
        for i in range(1, count):
            x, y, w, h, area = stats[i]
            if not (4 <= h <= min(100, gray.shape[0]*.1) and .12 <= w/h <= 2 and .08 <= area/(w*h) <= .95):
                continue
            key = (round((y+h)/max(3, h*.45)), round(np.log2(h)*3))
            rows.setdefault(key, []).append((int(x), int(y), int(w), int(h)))
        for row in rows.values():
            if len(row) < 5:
                continue
            row.sort()
            typical = np.median([b[3] for b in row])
            neighbors = [b for i, b in enumerate(row) if any(0 <= b[0]-a[0]-a[2] < typical*3 for a in row[max(0, i-2):i]) or
                         any(0 <= a[0]-b[0]-b[2] < typical*3 for a in row[i+1:i+3])]
            if len(neighbors) >= 5:
                boxes.extend(neighbors)
    unique = list(set(boxes))
    label = float(np.percentile([b[3] for b in unique], 30)/scale) if len(unique) >= 10 else None
    return {'width': width, 'height': height, 'detailHeightPx': round(label, 2) if label else None,
            'textLikeComponents': len(unique), 'confidence': 'estimated' if label else 'fallback',
            'method': 'baseline-grouped-connected-components'}


if __name__ == '__main__':
    spec = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    output = []
    for item in spec:
        try:
            output.append({'id': item['id'], **measure(item['file'])})
        except Exception as error:
            output.append({'id': item['id'], 'error': str(error)[:300]})
    print(json.dumps(output, ensure_ascii=False))
