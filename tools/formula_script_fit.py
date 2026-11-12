"""OCR-independent reference fit for formula script corrections.

Input JSON (stdin): [{reference, roi, original, candidate, color, hasTag}], where the two render
PNGs are 1600x900 transparent scene renders of the formula (original literal underscore vs the
proposed subscript form). Reference is the approved preview image.

The decision is local and independent of renderer metrics: the candidate's new below-baseline glyph
components are mapped by normalized horizontal position into the reference formula body, and the
reference must actually carry below-baseline ink at those positions (true subscript), while a
literal-underscore reference carries its ink on the baseline. A whole-formula alignment score is
still reported for review, but a weak aligned proxy is never treated as proof for the original:
only a strong original match (score >= 0.5 and margin >= 0.03 over the candidate) blocks correction.
No OCR, no service, no writes outside caller-provided temporary PNGs.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

SCENE_WIDTH, SCENE_HEIGHT = 1600, 900


def _hex_rgb(value, fallback=(255, 255, 255)):
    text = str(value or '').lstrip('#')
    if len(text) != 6:
        return fallback
    try:
        return tuple(int(text[index:index + 2], 16) for index in (0, 2, 4))
    except ValueError:
        return fallback


def _scene_crop(mask, roi):
    x0 = max(0, int(round(roi['x'])))
    y0 = max(0, int(round(roi['y'])))
    x1 = min(SCENE_WIDTH, int(round(roi['x'] + roi['w'])))
    y1 = min(SCENE_HEIGHT, int(round(roi['y'] + roi['h'])))
    if x1 - x0 < 8 or y1 - y0 < 8:
        raise ValueError('ROI 过小')
    return mask[y0:y1, x0:x1]


def _mask_from_render(path):
    image = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError('无法读取渲染图：' + str(path))
    if image.ndim == 3 and image.shape[2] == 4:
        mask = image[:, :, 3] > 112
        if mask.sum() >= 20:
            return mask.astype(np.uint8)
        gray = image[:, :, :3].max(axis=2)
    elif image.ndim == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image
    threshold = max(8.0, float(np.percentile(gray, 99)) * 0.25)
    return (gray.astype(np.float32) > threshold).astype(np.uint8)


def _reference_mask(path, roi, color, has_tag):
    image = cv2.imread(path)
    if image is None:
        raise ValueError('无法读取参考图：' + str(path))
    scale = image.shape[1] / float(SCENE_WIDTH)
    x0 = max(0, int(round(roi['x'] * scale)))
    y0 = max(0, int(round(roi['y'] * scale)))
    x1 = min(image.shape[1], int(round((roi['x'] + roi['w']) * scale)))
    y1 = min(image.shape[0], int(round((roi['y'] + roi['h']) * scale)))
    if x1 - x0 < 8 or y1 - y0 < 8:
        raise ValueError('参考图 ROI 过小')
    crop = cv2.cvtColor(image[y0:y1, x0:x1], cv2.COLOR_BGR2RGB).astype(np.float32)
    target = np.asarray(_hex_rgb(color), np.float32).reshape(1, 1, 3)
    distance = np.linalg.norm(crop - target, axis=2)
    mask = (distance < 110.0).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    if int(mask.sum()) < 40:
        # Fallback for formula colours close to the page background: local contrast mask.
        gray = cv2.cvtColor(image[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY).astype(np.float32)
        thickness = int(max(1, min(gray.shape) // 10))
        border = np.concatenate([gray[:thickness].ravel(), gray[-thickness:].ravel(),
                                 gray[:, :thickness].ravel(), gray[:, -thickness:].ravel()])
        background = float(np.median(border))
        contrast = np.abs(gray - background)
        threshold = max(18.0, float(np.percentile(contrast, 96)) * 0.4)
        mask = (contrast > threshold).astype(np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    target_width = max(8, int(round(roi['w'])))
    target_height = max(8, int(round(roi['h'])))
    if mask.shape[:2] != (target_height, target_width):
        mask = cv2.resize(mask * 255, (target_width, target_height), interpolation=cv2.INTER_NEAREST) > 127
    mask = mask.astype(np.uint8)
    if has_tag:
        mask = _drop_equation_tag(mask)
    return mask


def _drop_equation_tag(mask):
    """Drop the detached equation-number component at the far right of a tagged formula."""
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    if count <= 1:
        return mask
    height, width = mask.shape[:2]
    areas = [int(stats[index][4]) for index in range(1, count)]
    total = max(1, sum(areas))
    keep = np.zeros_like(mask)
    for index in range(1, count):
        x, y, w, h, area = [int(value) for value in stats[index]]
        center = x + w / 2.0
        tagged_number = center > width * 0.9 and area < total * 0.08 and h <= height * 0.8
        if not tagged_number:
            keep[labels == index] = 1
    return keep if int(keep.sum()) >= 40 else mask


def _bbox(mask):
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    return {'x0': int(xs.min()), 'x1': int(xs.max()), 'y0': int(ys.min()), 'y1': int(ys.max()),
            'w': int(xs.max() - xs.min() + 1), 'h': int(ys.max() - ys.min() + 1), 'count': int(len(xs))}


def _baseline_row(mask):
    rows = mask.sum(axis=1).astype(np.float32)
    if rows.max() <= 0:
        return 0
    # Main math line: the row band carrying the most ink.
    return int(np.argmax(rows))


def _below_baseline_components(candidate, original, baseline):
    extra = cv2.subtract(candidate * 255, cv2.dilate(original * 255, np.ones((3, 3), np.uint8)))
    extra = (extra > 40).astype(np.uint8)
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(extra, 8)
    components = []
    for index in range(1, count):
        x, y, w, h, area = [int(value) for value in stats[index]]
        if area < 8 or w < 1 or h < 1:
            continue
        if y + h - 1 <= baseline + 1:
            continue  # a same-baseline replacement (literal underscore) is not subscript evidence
        components.append({'x0': x, 'x1': x + w - 1, 'y0': y, 'y1': y + h - 1,
                           'cx': float(centroids[index][0]), 'cy': float(centroids[index][1]),
                           'w': w, 'h': h, 'area': area})
    components.sort(key=lambda item: item['cx'])
    return components


def _alignment_score(reference, render):
    height, width = reference.shape[:2]
    reference = reference.astype(np.uint8)
    reference_edge = cv2.Canny(reference * 255, 50, 150) > 0
    if reference_edge.sum() < 20:
        return {'score': 0.0, 'iou': 0.0, 'edgeF1': 0.0, 'scale': 1.0, 'dx': 0, 'dy': 0}
    dilated_reference_edge = cv2.dilate(reference_edge.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    best = None
    for scale in (0.96, 0.98, 1.0, 1.02, 1.04):
        for dy in range(-8, 9, 2):
            for dx in range(-8, 9, 2):
                matrix = np.float32([[scale, 0, (1 - scale) * width / 2.0 + dx],
                                     [0, scale, (1 - scale) * height / 2.0 + dy]])
                warped = cv2.warpAffine(render * 255, matrix, (width, height),
                                        flags=cv2.INTER_NEAREST, borderValue=0) > 127
                if warped.sum() < 20:
                    continue
                warped_edge = cv2.Canny((warped.astype(np.uint8)) * 255, 50, 150) > 0
                intersection = np.logical_and(reference, warped).sum()
                union = np.logical_or(reference, warped).sum()
                iou = float(intersection) / max(1.0, float(union))
                dilated_render_edge = cv2.dilate(warped_edge.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
                recall = float(np.logical_and(reference_edge, dilated_render_edge).sum()) \
                    / max(1.0, float(reference_edge.sum()))
                precision = float(np.logical_and(warped_edge, dilated_reference_edge).sum()) \
                    / max(1.0, float(warped_edge.sum()))
                edge_f1 = 2 * recall * precision / max(1e-6, recall + precision)
                score = 0.45 * iou + 0.55 * edge_f1
                if best is None or score > best['score']:
                    best = {'score': round(score, 4), 'iou': round(iou, 4),
                            'edgeF1': round(edge_f1, 4), 'scale': scale, 'dx': dx, 'dy': dy}
    return best or {'score': 0.0, 'iou': 0.0, 'edgeF1': 0.0, 'scale': 1.0, 'dx': 0, 'dy': 0}


def fit(item):
    roi = item['roi']
    reference = _reference_mask(item['reference'], roi, item.get('color'), item.get('hasTag') is True)
    original = _scene_crop(_mask_from_render(item['original']), roi)
    candidate = _scene_crop(_mask_from_render(item['candidate']), roi)
    reference_box = _bbox(reference)
    candidate_box = _bbox(candidate)
    original_box = _bbox(original)
    scores = {'original': _alignment_score(reference, original),
              'candidate': _alignment_score(reference, candidate)}
    if reference_box is None or candidate_box is None or original_box is None:
        return {'selected': False, 'reason': 'reference-unavailable', 'strongOriginal': False,
            'margin': 0.0, 'edgeGain': 0.0, 'confidence': 0.0, 'scores': scores, 'roi': roi,
            'referenceSubscript': {'components': 0, 'supported': 0, 'ratio': 0.0, 'windows': []}}
    reference_baseline = _baseline_row(reference)
    candidate_baseline = _baseline_row(candidate)
    components = _below_baseline_components(candidate, original, candidate_baseline)
    if not components:
        return {'selected': False, 'reason': 'insufficient-evidence', 'strongOriginal': False,
            'margin': 0.0, 'edgeGain': 0.0, 'confidence': 0.0, 'scores': scores, 'roi': roi,
            'referenceSubscript': {'components': 0, 'supported': 0, 'ratio': 0.0, 'windows': []}}
    reference_height = reference_box['h']
    lower_top = min(reference.shape[0] - 1, reference_baseline + 2)
    lower_bottom = min(reference.shape[0], lower_top + max(4, int(round(reference_height * 0.42))))
    windows, supported = [], 0
    for component in components:
        fraction = (component['cx'] - candidate_box['x0']) / max(1.0, float(candidate_box['w']))
        fraction = min(1.0, max(0.0, fraction))
        center = reference_box['x0'] + fraction * max(1.0, float(reference_box['w']))
        width = max(3.0, reference_box['w'] * (component['w'] / max(1.0, float(candidate_box['w']))) * 1.8)
        x0 = max(0, int(round(center - width / 2.0)))
        x1 = min(reference.shape[1], int(round(center + width / 2.0)) + 1)
        below_ink = int(reference[lower_top:lower_bottom, x0:x1].sum()) if lower_bottom > lower_top else 0
        # Baseline control: a literal underscore carries ink at the main line, not below it.
        baseline_ink = int(reference[max(0, reference_baseline - 1):min(reference.shape[0], reference_baseline + 2),
                                     x0:x1].sum())
        ok = below_ink >= max(6, int(0.35 * component['area'])) and below_ink >= baseline_ink * 0.15
        supported += 1 if ok else 0
        windows.append({'fraction': round(fraction, 4), 'x0': x0, 'x1': x1,
                        'belowInk': below_ink, 'baselineInk': baseline_ink, 'supported': bool(ok)})
    ratio = supported / float(len(components)) if components else 0.0
    original_score = float(scores['original']['score'])
    candidate_score = float(scores['candidate']['score'])
    margin = candidate_score - original_score
    # Weak aligned proxy (both scores low, e.g. a different math renderer in the approved image)
    # must not be treated as proof for the literal original. Only a strong original match blocks.
    strong_original = original_score >= 0.5 and (original_score - candidate_score) >= 0.03
    selected = bool(ratio >= 0.7 and not strong_original)
    if strong_original:
        reason = 'reference-supports-original'
        confidence = round(min(1.0, (original_score - candidate_score) / 0.12), 3)
    elif selected:
        reason = 'reference-subscript-supported'
        confidence = round(min(1.0, ratio), 3)
    else:
        reason = 'insufficient-evidence'
        confidence = round(min(0.6, max(0.0, ratio)), 3)
    return {'selected': selected, 'reason': reason, 'margin': round(margin, 4),
            'strongOriginal': bool(strong_original),
            'edgeGain': round(float(scores['candidate']['edgeF1']) - float(scores['original']['edgeF1']), 4),
            'confidence': confidence, 'scores': scores, 'roi': roi,
            'referenceSubscript': {'components': len(components), 'supported': supported,
                'ratio': round(ratio, 3), 'windows': windows}}


def main():
    try:
        items = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')) if len(sys.argv)>1 else json.loads(sys.stdin.buffer.read().decode('utf-8'))
        if not isinstance(items, list) or len(items) > 64:
            raise ValueError('公式脚本拟合输入无效')
        output=json.dumps([fit(item) for item in items], ensure_ascii=False)
        if len(sys.argv)>2:
            Path(sys.argv[2]).write_text(output,encoding='utf-8')
        else:
            print(output)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
