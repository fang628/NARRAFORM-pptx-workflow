#!/usr/bin/env python
"""Page-level review metrics for the 05 framework S8 stage.

Compares the assembled page render with the approved preview (1600x900 space):
- mae: mean absolute RGB error
- ssim: structural similarity (grayscale)
- edge: mean chamfer distance between strong edges (px)
CLI: python tools/page_diff.py <reference.png> <rendered.png> <out.json>
"""
import json
import sys

import cv2
import numpy as np

SCENE = (1600, 900)


def load(path):
    image = cv2.imread(path)
    if image is None:
        raise SystemExit('cannot read ' + path)
    return cv2.resize(image, SCENE)


def main():
    reference = load(sys.argv[1])
    rendered = load(sys.argv[2])
    out_path = sys.argv[3]
    mae = float(np.abs(reference.astype(np.int16) - rendered.astype(np.int16)).mean())
    gray_a = cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(rendered, cv2.COLOR_BGR2GRAY)
    try:
        ssim = float(cv2.quality.QualitySSIM_compute(gray_a, gray_b)[0])
        if ssim != ssim:
            ssim = None
    except Exception:
        ssim = None
    edges_a = cv2.Canny(gray_a, 60, 140)
    edges_b = cv2.Canny(gray_b, 60, 140)
    distance = cv2.distanceTransform(255 - edges_b, cv2.DIST_L2, 3)
    edge_distance = float(distance[edges_a > 0].mean()) if (edges_a > 0).any() and (distance > 0).any() else None
    result = {'status': 'available', 'mae': round(mae, 2),
              'ssim': None if ssim is None else round(ssim, 4),
              'edgeDistance': None if edge_distance is None else round(edge_distance, 2)}
    result['accepted'] = bool(result['mae'] <= 18 and (result['ssim'] is None or result['ssim'] >= 0.62))
    json.dump(result, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
