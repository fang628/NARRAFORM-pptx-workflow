"""Local refinement for low-confidence elements (S8).

Compares the assembled render with the approved preview inside each low-confidence element's
bounding box and estimates a small translation via phase correlation. The caller applies the
offset only when the correlation is strong and the shift is small.
"""
import json
import sys

import cv2
import numpy as np

assembled_path, preview_path, spec_path, out_path = sys.argv[1:5]
spec = json.load(open(spec_path, encoding='utf-8'))
page_width = float(spec.get('pageWidth') or 1600)
page_height = float(spec.get('pageHeight') or 900)
assembled = cv2.imread(assembled_path, cv2.IMREAD_GRAYSCALE)
preview = cv2.imread(preview_path, cv2.IMREAD_GRAYSCALE)
if assembled is None or preview is None:
    json.dump({'status': 'unavailable', 'results': []}, open(out_path, 'w', encoding='utf-8'))
    sys.exit(0)
assembled = cv2.resize(assembled, (int(page_width), int(page_height)))
preview = cv2.resize(preview, (int(page_width), int(page_height)))
results = []
for element in spec.get('elements') or []:
    try:
        x = float(element.get('x') or 0); y = float(element.get('y') or 0)
        w = float(element.get('w') or 0); h = float(element.get('h') or 0)
        if w < 12 or h < 12:
            continue
        pad = 6
        x0 = max(0, int(round(x)) - pad); y0 = max(0, int(round(y)) - pad)
        x1 = min(int(page_width), int(round(x + w)) + pad)
        y1 = min(int(page_height), int(round(y + h)) + pad)
        if x1 - x0 < 16 or y1 - y0 < 16:
            continue
        first = assembled[y0:y1, x0:x1].astype(np.float32)
        second = preview[y0:y1, x0:x1].astype(np.float32)
        first -= first.mean(); second -= second.mean()
        (dx, dy), response = cv2.phaseCorrelate(second, first)
        if not np.isfinite(dx) or not np.isfinite(dy):
            continue
        if float(response) < 0.08:
            continue
        if abs(dx) > 12 or abs(dy) > 12:
            continue
        results.append({'key': element.get('key'), 'dx': round(-float(dx), 2),
                        'dy': round(-float(dy), 2), 'response': round(float(response), 3)})
    except Exception:
        continue
json.dump({'status': 'available', 'results': results}, open(out_path, 'w', encoding='utf-8'))
print(json.dumps({'status': 'available', 'refined': len(results)}))
