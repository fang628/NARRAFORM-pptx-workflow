"""Straight-edge-first shape measurement for 05 reconstruction (geometry only).

Pipeline (no fill/stroke fitting in this tool):
  S1 long-line detection (LSD via native_frame_fit.long_edges)
  S2 line families + cross-occlusion spanning (expected side coverage from edge support + front mask)
  S3 basic shape hypotheses (quad from four side families, native prototypes)
  S4 corner evidence (cut / round) from residual segments around quad corners
  S5 curve evidence (consistent residual curvature) -> customGeometry commands
  S6 native family selection among rect / cutPanel / parallelogram / hexagon / chevron / arrow / freeform
Metrics: edgeSupport, boundaryP95, chamfer, visibleCoverage(occlusion), bridgedFraction, familyScore.

CLI: python tools/shape_measure.py <spec.json> <outdir>
Spec: {"reference":path, "elements":[...], "targetKeys":[...]?, "exclude":[{x,y,w,h}]?, "debug":true?}
"""
import json
import math
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from native_frame_fit import long_edges
from native_line_fit import fit_native_lines

cv2.setNumThreads(1)
VERSION = 1
WIDTH, HEIGHT = 1600, 900
_FIT_LINES = []
_REF_LAB = None
_JUMP_THRESHOLD = 10.0
_SEG_DIST = None
_GRAD_MAG = None
_GRAD_DX = None
_GRAD_DY = None
_GRAD_THRESHOLD = 10.0
_SEG_EDGE = None
_BG = None
_FG_MASK = None
_FG_EDGE = None
_FG_GRAD = None
_SEG_DIST_ENH = None
_SEG_EDGE_ENH = None
_GRAD_MAG_ENH = None
_GRAD_DX_ENH = None
_GRAD_DY_ENH = None
_FG_MASK_ENH = None
_FG_EDGE_ENH = None
_FG_GRAD_ENH = None


# ---------------------------------------------------------------- utilities
def load_ref(path):
    return np.asarray(Image.open(path).convert('RGB').resize((WIDTH, HEIGHT), Image.LANCZOS), np.uint8)


def unit(v):
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-9 else np.array([1.0, 0.0])


def box_of(e):
    return [float(e[k]) for k in ('x', 'y', 'w', 'h')]


def box_polygon(e):
    x, y, w, h = box_of(e)
    return np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], float)


def seed_polygon_of(e):
    geometry = e.get('customGeometry') or {}
    points = geometry.get('points') if isinstance(geometry, dict) else None
    if isinstance(points, list) and len(points) >= 3:
        x, y, w, h = box_of(e)
        normalized = all(isinstance(p, (list, tuple)) and len(p) >= 2 and 0 <= float(p[0]) <= 1 and 0 <= float(p[1]) <= 1 for p in points)
        if normalized:
            return np.array([[x + float(p[0]) * w, y + float(p[1]) * h] for p in points], float)
        return np.array([[float(p[0]), float(p[1])] for p in points], float)
    shape_geometry = e.get('shapeGeometry') or {}
    corners = shape_geometry.get('corners') if isinstance(shape_geometry, dict) else None
    if isinstance(corners, list) and len(corners) == 4:
        x, y, w, h = box_of(e)
        polygon = box_polygon(e)
        out = []
        for i in range(4):
            cur = polygon[i]
            prev = polygon[i - 1]
            nxt = polygon[(i + 1) % 4]
            corner = corners[i] or {'type': 'sharp'}
            kind = corner.get('type')
            if kind == 'cut':
                d1 = float(corner.get('distance', .05)) * min(w, h)
                d2 = d1
                out.append(cur + unit(prev - cur) * d1)
                out.append(cur + unit(nxt - cur) * d2)
            elif kind == 'round':
                r = float(corner.get('radius', .05)) * min(w, h)
                p1 = cur + unit(prev - cur) * r
                p2 = cur + unit(nxt - cur) * r
                for t in np.linspace(0, 1, 4):
                    out.append(p1 * (1 - t) + p2 * t)
            else:
                out.append(cur)
        return np.asarray(out, float)
    return box_polygon(e)


def front_mask_for(elements, target_index, masks, explicit_exclude=()):
    """Pixels of objects drawn after the target (front) + user excludes."""
    front = np.zeros((HEIGHT, WIDTH), np.uint8)
    for e in elements[target_index + 1:]:
        alpha = None
        x, y, w, h = box_of(e)
        if masks:
            alpha = masks.get(e.get('key'))
        if alpha is not None:
            front = np.maximum(front, (alpha > 16).astype(np.uint8))
        else:
            polygon = None
            if str(e.get('type')) in ('shape', 'rect', 'ellipse'):
                try:
                    polygon = seed_polygon_of(e)
                except Exception:
                    polygon = None
            if polygon is not None and len(polygon) >= 3:
                points = np.rint(np.asarray(polygon, float)).astype(np.int32)
                cv2.fillPoly(front, [points], 1)
            else:
                x0, y0 = max(0, int(math.floor(x))), max(0, int(math.floor(y)))
                x1, y1 = min(WIDTH, int(math.ceil(x + w))), min(HEIGHT, int(math.ceil(y + h)))
                if x1 > x0 and y1 > y0:
                    front[y0:y1, x0:x1] = 1
    for b in explicit_exclude:
        x0, y0 = max(0, int(math.floor(b['x']))), max(0, int(math.floor(b['y'])))
        x1, y1 = min(WIDTH, int(math.ceil(b['x'] + b['w']))), min(HEIGHT, int(math.ceil(b['y'] + b['h'])))
        if x1 > x0 and y1 > y0:
            front[y0:y1, x0:x1] = 1
    return front.astype(bool)



def prepare_background_evidence(ref, background):
    """Background-invariant evidence: subtract the registered wordless background so page
    brightness/colour no longer affects edges; union with the raw evidence (never replaces it)."""
    global _BG, _FG_MASK, _FG_EDGE, _FG_GRAD
    if background is None:
        _BG = None; _FG_MASK = None; _FG_EDGE = None; _FG_GRAD = None
        return None
    _BG = background
    diff = np.linalg.norm(cv2.cvtColor(ref, cv2.COLOR_RGB2LAB).astype(np.float32)
                          - cv2.cvtColor(background, cv2.COLOR_RGB2LAB).astype(np.float32), axis=2)
    diff = cv2.GaussianBlur(diff, (3, 3), 0)
    scale = max(6.0, float(np.percentile(diff, 99.0)) * 0.6)
    normalized = np.clip(diff / scale, 0.0, 1.0)
    _FG_MASK = (normalized > 0.16).astype(np.uint8)
    gy, gx = np.gradient(diff)
    magnitude = np.hypot(gx, gy)
    threshold = max(3.0, float(np.percentile(magnitude, 82.0)))
    _FG_GRAD = magnitude.astype(np.float32)
    _FG_EDGE = ((magnitude > threshold) | (_FG_MASK > 0)).astype(np.uint8)
    return {'edgeThreshold': threshold}


def foreground_edges(front):
    if _FG_EDGE is None:
        return None
    edge = _FG_EDGE.copy()
    if front is not None and getattr(front, 'size', 0):
        edge[front.astype(bool)] = 0
    return edge


def foreground_colour(front):
    if _FG_GRAD is None:
        return None, None
    threshold = max(2.0, float(np.percentile(_FG_GRAD, 72.0)))
    edge = (_FG_GRAD > threshold).astype(np.uint8)
    if front is not None and getattr(front, 'size', 0):
        edge[front.astype(bool)] = 0
    dist = cv2.distanceTransform((edge == 0).astype(np.uint8), cv2.DIST_L2, 3)
    return edge, dist


def edge_maps(ref, excluded, weak=False):
    lab = cv2.cvtColor(ref, cv2.COLOR_RGB2LAB)
    edge = np.zeros((HEIGHT, WIDTH), np.uint8)
    low, high = (14, 42) if weak else (30, 90)
    for c in range(3):
        edge |= cv2.Canny(cv2.GaussianBlur(lab[:, :, c], (3, 3), .7), low, high)
    edge[excluded.astype(bool)] = 0
    dist = cv2.distanceTransform((edge == 0).astype(np.uint8), cv2.DIST_L2, 3)
    return edge, dist


# ---------------------------------------------------------------- line families

def color_edge_maps(ref, excluded, threshold=8.5):
    base_edge, base_dist = raw_color_edge_maps(ref, excluded, threshold)
    fg_edge, fg_dist = foreground_colour(excluded)
    if base_dist is None or fg_dist is None:
        return base_edge, base_dist
    combined = np.maximum(base_edge, fg_edge)
    return combined, cv2.distanceTransform((combined == 0).astype(np.uint8), cv2.DIST_L2, 3)


def build_families(lines):
    families = []
    for line in sorted(lines, key=lambda q: -q['length']):
        d = line['b'] - line['a']
        if float(np.linalg.norm(d)) < 1e-6:
            continue
        d = unit(d)
        if d[0] < 0 or (abs(d[0]) < 1e-9 and d[1] < 0):
            d = -d
        angle = math.degrees(math.atan2(d[1], d[0]))
        normal = np.array([-d[1], d[0]])
        offset = float(np.dot(line['a'], normal))
        placed = False
        for f in families:
            if abs(angle - f['angle']) < 2.0 and abs(offset - f['offset']) < 3.0:
                f['lines'].append(line)
                placed = True
                break
        if not placed:
            families.append({'angle': angle, 'offset': offset, 'lines': [line]})
    for f in families:
        points = []
        for line in f['lines']:
            points.extend([line['a'], line['b']])
        points = np.asarray(points, np.float32)
        vx, vy, x, y = cv2.fitLine(points, cv2.DIST_HUBER, 0, .01, .01).ravel()
        d = np.array([vx, vy], float)
        if d[0] < 0 or (abs(d[0]) < 1e-9 and d[1] < 0):
            d = -d
        point = np.array([x, y], float)
        proj = (points - point) @ d
        f['dir'] = d
        f['point'] = point
        f['a'] = point + d * float(proj.min())
        f['b'] = point + d * float(proj.max())
        f['span'] = float(proj.max() - proj.min())
        f['total'] = float(sum(line['length'] for line in f['lines']))
        f['horizontal'] = abs(math.sin(math.radians(f['angle']))) < .12
        f['vertical'] = abs(math.cos(math.radians(f['angle']))) < .12
    return families


def family_pos(f):
    return float(f['point'][1]) if f['horizontal'] else float(f['point'][0])


def intersect_lines(f1, f2):
    p1, d1 = f1['point'], f1['dir']
    p2, d2 = f2['point'], f2['dir']
    den = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(den) < 1e-9:
        return None
    diff = p2 - p1
    t = (diff[0] * d2[1] - diff[1] * d2[0]) / den
    return p1 + d1 * t


def direction_clusters(families, box):
    """Group line families into up to ~4 direction clusters by angle modulo 180."""
    x, y, w, h = box
    diagonal = max(w, h)
    usable = [f for f in families if f['total'] >= max(26.0, diagonal * .16)]
    clusters = []
    for f in sorted(usable, key=lambda q: -q['total']):
        angle = f['angle'] % 180
        placed = False
        for cluster in clusters:
            diff = abs((angle - cluster['angle'] + 90) % 180 - 90)
            if diff < 4.0:
                cluster['families'].append(f)
                cluster['total'] += f['total']
                placed = True
                break
        if not placed:
            clusters.append({'angle': angle, 'families': [f], 'total': f['total']})
    for cluster in clusters:
        total = sum(f['total'] for f in cluster['families'])
        if total <= 0:
            continue
        vx = sum(math.cos(math.radians(f['angle'])) * f['total'] for f in cluster['families']) / total
        vy = sum(math.sin(math.radians(f['angle'])) * f['total'] for f in cluster['families']) / total
        angle = math.degrees(math.atan2(vy, vx)) % 180
        cluster['angle'] = angle
        cluster['dir'] = np.array([math.cos(math.radians(angle)), math.sin(math.radians(angle))])
        cluster['normal'] = np.array([-cluster['dir'][1], cluster['dir'][0]])
    return clusters


def pick_side_families(cluster, target_offset, tol, limit=2):
    items = sorted(cluster['families'], key=lambda f: abs(float(np.dot(f['point'], cluster['normal'])) - target_offset))
    chosen = [f for f in items if abs(float(np.dot(f['point'], cluster['normal'])) - target_offset) <= tol][:limit]
    return chosen


def order_quad(points):
    """Order 4 corners clockwise in image coordinates, starting top-left."""
    points = np.asarray(points, float)
    center = points.mean(axis=0)
    angles = np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0])
    order = np.argsort(angles)
    points = points[order]
    start = int(np.argmin(points[:, 0] + points[:, 1]))
    return np.roll(points, -start, axis=0)


def side_support(points, dist, front):
    a, b = np.asarray(points[0], float), np.asarray(points[1], float)
    n = max(2, int(np.linalg.norm(b - a) / 2.0))
    samples = a[None, :] + (b - a)[None, :] * np.linspace(0, 1, n)[:, None]
    xs = np.clip(np.rint(samples[:, 0]).astype(int), 0, WIDTH - 1)
    ys = np.clip(np.rint(samples[:, 1]).astype(int), 0, HEIGHT - 1)
    visible = ~front[ys, xs]
    if int(visible.sum()) < 6:
        return 0.0, 99.0
    d = dist[ys[visible], xs[visible]]
    return float((d <= 1.6).mean()), float(np.percentile(d, 95))


def refine_quad(quad, dist, front, rounds=2):
    """Slide each fitted side along its normal to the best edge-supported offset."""
    quad = np.asarray(quad, float).copy()
    for _ in range(rounds):
        moved = False
        for i in range(4):
            j = (i + 1) % 4
            a, b = quad[i], quad[j]
            direction = unit(b - a)
            normal = np.array([-direction[1], direction[0]])
            best = None
            for delta in np.arange(-9.0, 9.01, 1.0):
                side = (a + normal * delta, b + normal * delta)
                support, p95 = side_support(side, dist, front)
                score = support - 0.01 * max(0.0, p95 - 1.5)
                if best is None or score > best[0]:
                    best = (score, delta, support, p95)
            if best and abs(best[1]) >= 1.0 and best[2] > 0.35:
                quad[i] = a + normal * best[1]
                quad[j] = b + normal * best[1]
                moved = True
        if not moved:
            break
    return quad


def general_quad_candidates(families, box, limit=24):
    """Quad from two dominant edge directions (handles skewed parallelograms/trapezoids)."""
    x, y, w, h = box
    clusters = direction_clusters(families, box)
    if len(clusters) < 2:
        return []
    pairs = []
    for i in range(len(clusters)):
        for j in range(i + 1, len(clusters)):
            a, b = clusters[i], clusters[j]
            orth = abs(math.sin(math.radians(a['angle'] - b['angle'])))
            if orth < .55 or min(a['total'], b['total']) < 40:
                continue
            pairs.append(((a['total'] + b['total']) * orth, a, b, orth))
    quads = []
    cx, cy = x + w / 2.0, y + h / 2.0
    for _, a, b, _orth in sorted(pairs, key=lambda item: -item[0])[:3]:
        # shallow boxes (bubbles/pills) need a wider band because a 10-20px ROI offset
        # of the input box would otherwise hide the real top/bottom lines
        tol_a = max(12.0, h * (.38 if h <= 150 else .12))
        tol_b = max(12.0, w * (.22 if w <= 150 else .12))

        def side_offsets(cluster, tol_w, tol_h):
            normal = cluster['normal']
            if abs(normal[0]) >= abs(normal[1]):
                lo = float(np.dot(np.array([x, cy]), normal))
                hi = float(np.dot(np.array([x + w, cy]), normal))
            else:
                lo = float(np.dot(np.array([cx, y]), normal))
                hi = float(np.dot(np.array([cx, y + h]), normal))
            return lo, hi

        offset_a_lo, offset_a_hi = side_offsets(a, tol_a, tol_a)
        offset_b_lo, offset_b_hi = side_offsets(b, tol_b, tol_b)
        a_lo = pick_side_families(a, offset_a_lo, tol_a)
        a_hi = pick_side_families(a, offset_a_hi, tol_a)
        b_lo = pick_side_families(b, offset_b_lo, tol_b)
        b_hi = pick_side_families(b, offset_b_hi, tol_b)
        if not (a_lo or a_hi) or not (b_lo or b_hi):
            continue
        a_lo = a_lo or [{'point': np.array([x, cy]), 'dir': a['dir']}]
        a_hi = a_hi or [{'point': np.array([x + w, cy]), 'dir': a['dir']}]
        b_lo = b_lo or [{'point': np.array([cx, y]), 'dir': b['dir']}]
        b_hi = b_hi or [{'point': np.array([cx, y + h]), 'dir': b['dir']}]
        for la in a_lo[:2]:
            for lb in a_hi[:2]:
                for lc in b_lo[:2]:
                    for ld in b_hi[:2]:
                        p1 = intersect_two_lines(la['point'], la['dir'], lc['point'], lc['dir'])
                        p2 = intersect_two_lines(lb['point'], lb['dir'], lc['point'], lc['dir'])
                        p3 = intersect_two_lines(lb['point'], lb['dir'], ld['point'], ld['dir'])
                        p4 = intersect_two_lines(la['point'], la['dir'], ld['point'], ld['dir'])
                        if any(p is None for p in (p1, p2, p3, p4)):
                            continue
                        quad = np.array([p1, p2, p3, p4], float)
                        if not np.all(np.isfinite(quad)):
                            continue
                        quads.append(order_quad(quad))
                        if len(quads) >= limit:
                            return quads
    return quads


import os
ROI_SNAP = str(os.environ.get('ROI_SNAP', '0')).strip().lower() not in ('0', 'false', 'off', 'no')
PANEL_OPT = str(os.environ.get('PANEL_OPT', '1')).strip().lower() not in ('0', 'false', 'off', 'no')
PANEL_MODELS = {'QUAD', 'ROUND-RECT', 'BUBBLE', 'ROUND-QUAD'}


def raw_color_edge_maps(ref, excluded, threshold=8.5):
    """Panel-only colour-step edge channel for faint/gradient borders (Canny misses them)."""
    if ref is None:
        return None, None
    lab = cv2.cvtColor(ref, cv2.COLOR_RGB2LAB).astype(np.float32)
    magnitude = np.zeros((HEIGHT, WIDTH), np.float32)
    for channel in range(3):
        smooth = cv2.GaussianBlur(lab[:, :, channel], (5, 5), 1.2)
        gx = cv2.Sobel(smooth, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(smooth, cv2.CV_32F, 0, 1, ksize=3)
        magnitude = np.maximum(magnitude, cv2.magnitude(gx, gy))
    edge = (magnitude > threshold).astype(np.uint8) * 255
    edge[excluded.astype(bool)] = 0
    dist = cv2.distanceTransform((edge == 0).astype(np.uint8), cv2.DIST_L2, 3)
    return edge, dist


def _polygon_deviation(points, native):
    """Max distance (px) between the measured polygon and the boundary of a native shape
    description (rect/roundRect/pill/parallelogram are all reconstructible from the same
    corner/bounds parameters used by panel_polygon)."""
    geometry = native.get('shapeGeometry') or {}
    bounds = native.get('bounds')
    corners = geometry.get('corners') or []
    if not bounds:
        return 1e9
    if len(corners) < 4:
        corners = [{'type': 'sharp'}] * 4
    box = [bounds['x'], bounds['y'], bounds['w'], bounds['h']]
    try:
        polygon = panel_polygon([box[0], box[1], box[0] + box[2], box[1] + box[3]], corners)
    except Exception:
        return 1e9
    contour = np.asarray(polygon, np.float32).reshape(-1, 1, 2)
    worst = 0.0
    for point in np.asarray(points, float):
        worst = max(worst, abs(cv2.pointPolygonTest(contour, (float(point[0]), float(point[1])), True)))
    return worst


def snap_native_from_polygon(points, corners, box, tolerance=None):
    """Prefer a STANDARD PPT shape over customGeometry whenever the measured outline is
    within a small tolerance of it. A tiny notch or one odd corner must not turn a
    rectangle/rounded rectangle into a freeform shape: reconstruction only needs
    parameters, not custom geometry."""
    points = np.asarray(points, float)
    if points.ndim != 2 or len(points) < 3:
        return None
    lo = points.min(axis=0)
    hi = points.max(axis=0)
    bw, bh = float(hi[0] - lo[0]), float(hi[1] - lo[1])
    if bw < 6 or bh < 6:
        return None
    if tolerance is None:
        tolerance = max(2.2, 0.007 * max(bw, bh))
    short = max(1.0, min(bw, bh))
    bounds = {'x': round(float(lo[0]), 2), 'y': round(float(lo[1]), 2), 'w': round(bw, 2), 'h': round(bh, 2)}
    corner_specs = [dict(corner) for corner in (corners or []) if isinstance(corner, dict)]
    radii = [float(c.get('radius') or 0.0) for c in corner_specs if str(c.get('type')) == 'round']
    cuts = [c.get('cut') for c in corner_specs if str(c.get('type')) == 'cut']
    result = None

    rect_native = {'type': 'shape', 'shape': 'rect', 'bounds': bounds,
                   'shapeGeometry': {'version': 2, 'corners': [{'type': 'sharp'}] * 4}}
    deviation = _polygon_deviation(points, rect_native)
    if deviation <= tolerance:
        result = (deviation, 'rect-sharp', rect_native)

    if result is None and radii:
        radius = float(np.median(radii))
        if radius >= 0.06 * short:
            ratio = max(0.02, min(0.5, radius / short))
            specs = [{'type': 'round', 'radius': round(ratio, 4)}] * 4
            rounded = {'type': 'shape', 'shape': 'roundRect', 'bounds': bounds,
                       'shapeGeometry': {'version': 2, 'corners': specs}}
            deviation = _polygon_deviation(points, rounded)
            if deviation <= tolerance:
                result = (deviation, 'pill' if ratio >= 0.42 else 'roundRect', rounded)

    if result is None and cuts:
        first = cuts[0]
        if isinstance(first, (list, tuple)) and len(first) == 2:
            cut = [float(np.median([c[0] for c in cuts])), float(np.median([c[1] for c in cuts]))]
        else:
            cut = float(np.median([float(c) for c in cuts]))
        specs = [{'type': 'cut', 'cut': cut} if str(c.get('type')) == 'cut' else {'type': 'sharp'}
                 for c in corner_specs]
        if len(specs) == 4:
            cut_native = {'type': 'shape', 'shape': 'rect', 'bounds': bounds,
                          'shapeGeometry': {'version': 2, 'corners': specs}}
            deviation = _polygon_deviation(points, cut_native)
            if deviation <= tolerance:
                result = (deviation, 'cutPanel', cut_native)

    if result is None and len(points) == 4 and len(corner_specs) == 4 and all(
            str(c.get('type')) == 'sharp' for c in corner_specs):
        top_left, top_right = points[0], points[1]
        bottom_right, bottom_left = points[2], points[3]
        horizontal_ok = (abs(top_left[1] - top_right[1]) <= tolerance
                         and abs(bottom_left[1] - bottom_right[1]) <= tolerance)
        shift = ((float(top_left[0] - bottom_left[0])) + (float(top_right[0] - bottom_right[0]))) / 2.0
        if horizontal_ok and abs(shift) >= 2.0:
            para = {'type': 'shape', 'shape': 'parallelogram', 'bounds': bounds,
                    'shapeGeometry': {'version': 2, 'corners': [{'type': 'sharp'}] * 4,
                                      'headDepth': round(min(.45, abs(shift) / max(1.0, bw)), 4),
                                      'slantSign': 1 if shift > 0 else -1}}
            deviation = _polygon_deviation(points, para)
            if deviation <= tolerance:
                result = (deviation, 'parallelogram-sharp', para)

    if result is None:
        return None
    deviation, kind, native = result
    return {'kind': kind, 'native': native, 'deviation': round(float(deviation), 3)}


def native_geometry(kind, points, corners, box):
    """POST-FIT decision: convert the fitted outline into standard PPT shape parameters.

    The fitting stage only measures the outline (edges/colour profiles/slant/radii); this
    function then decides the native family and emits its parameters (bounds, corner
    radius, headDepth/slantSign, corner cuts). Custom geometry is the last resort for
    outlines that are not within tolerance of any standard shape."""
    x, y, w, h = box
    points = np.asarray(points, float)
    low = points.min(axis=0)
    high = points.max(axis=0)
    bounds = {'x': round(float(low[0]), 2), 'y': round(float(low[1]), 2),
              'w': round(float(high[0] - low[0]), 2), 'h': round(float(high[1] - low[1]), 2)}
    if kind in ('rect-sharp', 'rectPanel', 'seed-box'):
        return {'type': 'rect', 'shape': 'rect', 'bounds': bounds,
                'shapeGeometry': {'version': 2, 'corners': [{'type': 'sharp'}] * 4}}
    if kind in ('cutPanel', 'roundPanel') and corners:
        top = points[1] - points[0]
        bottom = points[3] - points[2]
        skew = float(top[0] - bottom[0]) / max(1e-6, w)
        if abs(skew) > .06:
            snap_hit = snap_native_from_polygon(points, corners, box)
            if snap_hit is not None:
                return snap_hit['native']
            lo = points.min(axis=0)
            hi = points.max(axis=0)
            size = np.maximum(1e-6, hi - lo)
            normalized = [[float((p[0] - lo[0]) / size[0]), float((p[1] - lo[1]) / size[1])] for p in points]
            return {'type': 'shape', 'shape': 'freeform',
                    'bounds': {'x': round(float(lo[0]), 2), 'y': round(float(lo[1]), 2), 'w': round(float(size[0]), 2), 'h': round(float(size[1]), 2)},
                    'customGeometry': {'points': [[round(px, 4), round(py, 4)] for px, py in normalized], 'closed': True}}
        return {'type': 'shape', 'shape': 'rect', 'bounds': bounds,
                'shapeGeometry': {'version': 2, 'corners': [
                    {k: v for k, v in corner.items() if k in ('type', 'cut', 'radius')} for corner in corners]}}
    if kind in ('parallelogram', 'parallelogram-sharp') and len(points) == 4:
        span = float(points[:, 0].max() - points[:, 0].min())
        shift = ((float(points[0][0] - points[3][0])) + (float(points[1][0] - points[2][0]))) / 2.0
        if abs(shift) > max(2.0, span * .01):
            return {'type': 'shape', 'shape': 'parallelogram', 'bounds': bounds,
                    'shapeGeometry': {'version': 2, 'headDepth': round(min(.45, abs(shift) / max(1e-6, span)), 4),
                                      'slantSign': 1 if shift > 0 else -1}}
        return {'type': 'rect', 'shape': 'rect', 'shapeGeometry': {'version': 2, 'corners': [{'type': 'sharp'}] * 4}}
    if kind in ('hexagon', 'chevron', 'trapezoid', 'rightArrow', 'triangle'):
        return {'type': 'shape', 'shape': kind, 'bounds': bounds}
    snap = snap_native_from_polygon(points, corners, box)
    if snap is not None:
        return snap['native']
    lo = points.min(axis=0)
    hi = points.max(axis=0)
    size = np.maximum(1e-6, hi - lo)
    normalized = [[float((p[0] - lo[0]) / size[0]), float((p[1] - lo[1]) / size[1])] for p in points]
    return {'type': 'shape', 'shape': 'freeform',
            'bounds': {'x': round(float(lo[0]), 2), 'y': round(float(lo[1]), 2), 'w': round(float(size[0]), 2), 'h': round(float(size[1]), 2)},
            'customGeometry': {'points': [[round(px, 4), round(py, 4)] for px, py in normalized], 'closed': True}}


def side_candidates(families, box, tol_ratio=.08, min_span_ratio=.38, limit=3):
    x, y, w, h = box
    tol = max(9.0, min(w, h) * tol_ratio)
    tops, bottoms, lefts, rights = [], [], [], []
    for f in families:
        if f['horizontal']:
            pos = family_pos(f)
            overlap = max(0.0, min(f['b'][0], x + w) - max(f['a'][0], x))
            if overlap < w * min_span_ratio and f['span'] < w * min_span_ratio:
                continue
            if abs(pos - y) <= tol:
                tops.append(f)
            if abs(pos - (y + h)) <= tol:
                bottoms.append(f)
        if f['vertical']:
            pos = family_pos(f)
            overlap = max(0.0, min(f['b'][1], y + h) - max(f['a'][1], y))
            if overlap < h * min_span_ratio and f['span'] < h * min_span_ratio:
                continue
            if abs(pos - x) <= tol:
                lefts.append(f)
            if abs(pos - (x + w)) <= tol:
                rights.append(f)

    def rank(items, pos):
        return sorted(items, key=lambda f: (abs(family_pos(f) - pos), -f['total']))[:limit]

    return {'top': rank(tops, y), 'bottom': rank(bottoms, y + h), 'left': rank(lefts, x), 'right': rank(rights, x + w)}


def intersect_two_lines(p1, d1, p2, d2):
    den = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(den) < 1e-9:
        return None
    diff = p2 - p1
    t = (diff[0] * d2[1] - diff[1] * d2[0]) / den
    return p1 + d1 * t


def synthetic_side(box, side):
    x, y, w, h = box
    if side == 'top':
        return {'point': np.array([x + w / 2.0, y]), 'dir': np.array([1.0, 0.0]), 'horizontal': True, 'vertical': False, 'span': w, 'total': w, 'lines': []}
    if side == 'bottom':
        return {'point': np.array([x + w / 2.0, y + h]), 'dir': np.array([1.0, 0.0]), 'horizontal': True, 'vertical': False, 'span': w, 'total': w, 'lines': []}
    if side == 'left':
        return {'point': np.array([x, y + h / 2.0]), 'dir': np.array([0.0, 1.0]), 'horizontal': False, 'vertical': True, 'span': h, 'total': h, 'lines': []}
    return {'point': np.array([x + w, y + h / 2.0]), 'dir': np.array([0.0, 1.0]), 'horizontal': False, 'vertical': True, 'span': h, 'total': h, 'lines': []}


def quad_candidates(sides, box, limit=24):
    choices = {}
    for side in ('top', 'bottom', 'left', 'right'):
        items = sides.get(side) or []
        choices[side] = (items[:2] if items else []) + [synthetic_side(box, side)]
    quads = []
    for top in choices['top']:
        for bottom in choices['bottom']:
            for left in choices['left']:
                for right in choices['right']:
                    tl = intersect_two_lines(top['point'], top['dir'], left['point'], left['dir'])
                    tr = intersect_two_lines(top['point'], top['dir'], right['point'], right['dir'])
                    br = intersect_two_lines(bottom['point'], bottom['dir'], right['point'], right['dir'])
                    bl = intersect_two_lines(bottom['point'], bottom['dir'], left['point'], left['dir'])
                    if any(p is None for p in (tl, tr, br, bl)):
                        continue
                    quad = np.array([tl, tr, br, bl], float)
                    if not np.all(np.isfinite(quad)):
                        continue
                    quads.append(quad)
                    if len(quads) >= limit:
                        return quads
    return quads


def quad_score(quad, box, dist, front):
    metrics = boundary_metrics(quad, dist, front)
    x, y, w, h = box
    area = 0.5 * abs(np.dot(quad[:, 0], np.roll(quad[:, 1], 1)) - np.dot(quad[:, 1], np.roll(quad[:, 0], 1)))
    if area < w * h * .35 or area > w * h * 2.2:
        return -1e9
    return metrics['edgeSupport'] - 0.0004 * max(0.0, metrics['boundaryP95'] - 1.2)


def fit_circle_lsq(points):
    x = points[:, 0].astype(float)
    y = points[:, 1].astype(float)
    matrix = np.column_stack([2.0 * x, 2.0 * y, np.ones_like(x)])
    rhs = x * x + y * y
    try:
        solution, *_ = np.linalg.lstsq(matrix, rhs, rcond=None)
    except Exception:
        return None
    cx, cy = float(solution[0]), float(solution[1])
    value = float(solution[2]) + cx * cx + cy * cy
    if value <= 0:
        return None
    return cx, cy, math.sqrt(value)


def refine_quad_subpixel(quad, edge, dist, front, iterations=2):
    """Re-fit each side to the actual edge pixels near it (least-squares line) and
    rebuild corners from adjacent line intersections: sub-pixel edges instead of the
    integer-pixel quad from the coarse search."""
    quad = np.asarray(quad, float).copy()
    for _ in range(iterations):
        sides = []
        for i in range(4):
            a = quad[i]
            b = quad[(i + 1) % 4]
            direction = unit(b - a)
            normal = np.array([-direction[1], direction[0]])
            length = float(np.linalg.norm(b - a))
            points = []
            steps = max(8, int(length / 2.5))
            for t in np.linspace(0.03, 0.97, steps):
                base = a + (b - a) * t
                for offset in np.arange(-5.0, 5.01, 1.0):
                    probe = base + normal * offset
                    xi = int(round(probe[0]))
                    yi = int(round(probe[1]))
                    if not (0 <= xi < WIDTH and 0 <= yi < HEIGHT):
                        continue
                    if edge[yi, xi] and not front[yi, xi]:
                        points.append([xi, yi])
            if len(points) >= 24:
                pts = np.asarray(points, np.float32)
                vx, vy, px, py = cv2.fitLine(pts, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
                line_dir = np.array([float(vx), float(vy)], float)
                sides.append((np.array([float(px), float(py)]), line_dir))
            else:
                sides.append((a, direction))
        rebuilt = []
        for i in range(4):
            p1 = quad[i]
            point1, dir1 = sides[(i - 1) % 4]
            point2, dir2 = sides[i]
            corner = intersect_two_lines(point1, dir1, point2, dir2)
            rebuilt.append(corner if corner is not None else p1)
        quad = np.asarray(rebuilt, float)
    return quad


def detect_corner(quad, corner_index, lines, edge, dist, front, box):
    x, y, w, h = box
    corner = quad[corner_index]
    prev = quad[corner_index - 1]
    nxt = quad[(corner_index + 1) % 4]
    prev_dir = unit(prev - corner)
    next_dir = unit(nxt - corner)
    radius = max(10.0, min(60.0, min(w, h) * 0.25))
    best = {'type': 'sharp', 'confidence': 0.0}
    side_angles = [math.degrees(math.atan2(abs(d[1]), abs(d[0]))) for d in (prev_dir, next_dir)]

    for line in lines:
        mid = (line['a'] + line['b']) / 2.0
        if float(np.linalg.norm(mid - corner)) > radius * 1.9:
            continue
        line_dir = unit(line['b'] - line['a'])
        line_angle = math.degrees(math.atan2(abs(line_dir[1]), abs(line_dir[0])))
        if min(abs(line_angle - a) for a in side_angles) < 12:
            continue
        p1 = intersect_two_lines(corner, prev_dir, line['a'], line_dir)
        p2 = intersect_two_lines(corner, next_dir, line['a'], line_dir)
        if p1 is None or p2 is None:
            continue
        cut1 = float(np.linalg.norm(p1 - corner))
        cut2 = float(np.linalg.norm(p2 - corner))
        prev_len = float(np.linalg.norm(prev - corner))
        next_len = float(np.linalg.norm(nxt - corner))
        # Thin bands can have bevels that run through most of a short side; the
        # longer side still bounds the cut so a false diagonal cannot consume it.
        short = min(w, h)
        limit1 = max(6.0, prev_len * 0.45, short * 0.70)
        limit2 = max(6.0, next_len * 0.45, short * 0.70)
        if not (3.0 <= cut1 <= limit1 and 3.0 <= cut2 <= limit2):
            continue
        chord = p2 - p1
        chord_len = float(np.linalg.norm(chord))
        if chord_len < 5:
            continue
        chord_mid = (p1 + p2) / 2.0
        if float(np.linalg.norm(mid - chord_mid)) > max(7.0, chord_len * .45):
            continue
        if abs(float(np.dot(line_dir, unit(chord)))) < .75:
            continue
        ts = np.linspace(.1, .9, 9)
        samples = line['a'][None, :] + (line['b'] - line['a'])[None, :] * ts[:, None]
        xs = np.clip(np.rint(samples[:, 0]).astype(int), 0, WIDTH - 1)
        ys = np.clip(np.rint(samples[:, 1]).astype(int), 0, HEIGHT - 1)
        visible = ~front[ys, xs]
        if int(visible.sum()) < 4:
            continue
        # LSD segments can sit 1-2px off the Canny ridge on glowed bevels; allow a
        # slightly wider ridge tolerance but still require most of the segment to lie on it.
        support = float((dist[ys[visible], xs[visible]] <= 2.6).mean())
        if support < .5:
            continue
        conf = min(1.0, .3 + support * .5 + min(1.0, line['length'] / max(12.0, chord_len)) * .15)
        if conf > best.get('confidence', 0):
            best = {
                'type': 'cut',
                'confidence': round(conf, 3),
                'cut': [round(cut1 / max(1e-6, float(np.linalg.norm(prev - corner))), 4),
                        round(cut2 / max(1e-6, float(np.linalg.norm(nxt - corner))), 4)],
                'segmentLength': round(float(line['length']), 1),
                'support': round(support, 3),
            }

    round_candidate = None
    if True:
        prev_len = float(np.linalg.norm(prev - corner))
        next_len = float(np.linalg.norm(nxt - corner))
        side_ref = max(1.0, min(prev_len, next_len))
        span = max(radius * 1.6, min(side_ref * 0.75, 80.0), 22.0)
        x0, x1 = max(0, int(corner[0] - span)), min(WIDTH, int(corner[0] + span) + 1)
        y0, y1 = max(0, int(corner[1] - span)), min(HEIGHT, int(corner[1] + span) + 1)
        ys, xs = np.nonzero(edge[y0:y1, x0:x1])
        if len(xs) >= 16:
            ys = ys + y0
            xs = xs + x0
            visible = ~front[ys, xs]
            ys, xs = ys[visible], xs[visible]
            pts = np.column_stack([xs, ys]).astype(np.float32)
            # keep only points away from the two straight sides (the arc region only)
            p_side1 = np.abs((pts[:, 0] - corner[0]) * prev_dir[1] - (pts[:, 1] - corner[1]) * prev_dir[0])
            p_side2 = np.abs((pts[:, 0] - corner[0]) * next_dir[1] - (pts[:, 1] - corner[1]) * next_dir[0])
            arc_pts = pts[(p_side1 > 1.8) & (p_side2 > 1.8)]
            if len(arc_pts) >= 10:
                rough_center, rough_radius = cv2.minEnclosingCircle(arc_pts)
                rough_center = np.asarray(rough_center, float)
                angles_all = np.arctan2(arc_pts[:, 1] - rough_center[1], arc_pts[:, 0] - rough_center[0])
                radii_all = np.linalg.norm(arc_pts - rough_center, axis=1)
                bins = ((angles_all + math.pi) / (2 * math.pi) * 24).astype(int) % 24
                outer = []
                for bin_index in range(24):
                    mask = bins == bin_index
                    if not mask.any():
                        continue
                    index = np.argmax(radii_all[mask])
                    outer.append(arc_pts[mask][index])
                outer = np.asarray(outer, np.float32)
                fitted = fit_circle_lsq(outer if len(outer) >= 8 else arc_pts)
                if fitted is not None:
                    cx, cy, r = fitted
                    center = np.array([cx, cy], float)
                    corner_offset = float(np.linalg.norm(corner - center))
                    ring_pts = outer if len(outer) >= 8 else arc_pts
                    radii = np.linalg.norm(ring_pts - center, axis=1)
                    residual = float(np.median(np.abs(radii - r)))
                    angles = np.degrees(np.arctan2(ring_pts[:, 1] - cy, ring_pts[:, 0] - cx))
                    span_angle = float(np.max(angles) - np.min(angles))
                    if (3.0 <= r <= side_ref * .58
                            and abs(corner_offset - r * math.sqrt(2)) <= max(2.5, r * .5)
                            and residual <= 1.8 and span_angle >= 35):
                        round_candidate = {
                            'type': 'round',
                            'confidence': round(min(1.0, .45 + span_angle / 360 + (1.5 - residual) * .15), 3),
                            'radius': round(r / side_ref, 4),
                            'residual': round(residual, 3),
                        }
    if round_candidate is not None:
        if best['type'] != 'cut':
            best = round_candidate
        else:
            # A capsule end can also be read as a short 45-degree chamfer; a clean arc
            # (tight circle residual, large radius share) is the better explanation.
            small_radius = round_candidate['radius'] >= 0.18
            clean_arc = round_candidate.get('residual', 9.0) <= 1.6
            if small_radius and clean_arc and round_candidate['confidence'] >= best.get('confidence', 0) - 0.12:
                best = {key: value for key, value in round_candidate.items() if key != 'residual'}
    return best


# ---------------------------------------------------------------- metrics
def sample_polygon(points, spacing=1.4):
    points = np.asarray(points, float)
    samples = []
    for i in range(len(points)):
        a, b = points[i], points[(i + 1) % len(points)]
        length = float(np.linalg.norm(b - a))
        steps = max(2, int(math.ceil(length / spacing)))
        for t in np.linspace(0, 1, steps, endpoint=False):
            samples.append(a * (1 - t) + b * t)
    return np.asarray(samples)


def subpixel_dist(dist, samples):
    """Bilinear sample of the edge-distance field so boundary fitting/measurement is
    not quantized to whole pixels (edges are usually between pixels)."""
    map_x = np.asarray(samples[:, 0], np.float32).reshape(1, -1)
    map_y = np.asarray(samples[:, 1], np.float32).reshape(1, -1)
    values = cv2.remap(dist.astype(np.float32), map_x, map_y, cv2.INTER_LINEAR,
                       borderMode=cv2.BORDER_REPLICATE)
    return values.ravel()


def oriented_support(points, edge, front, tolerance_deg=16.0):
    """Fraction of boundary samples that sit on an edge whose gradient is perpendicular
    to the local tangent (edge direction ~ tangent). Proximity alone is not ownership."""
    points = np.asarray(points, float)
    samples = sample_polygon(points, spacing=4.0)
    if len(samples) < 24:
        return 0.0
    gx = cv2.Sobel(edge.astype(np.float32), cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(edge.astype(np.float32), cv2.CV_32F, 0, 1, ksize=3)
    direction = np.zeros_like(edge, np.float32)
    good = 0
    total = 0
    for index in range(len(samples)):
        px, py = samples[index]
        prev_point = samples[index - 1]
        next_point = samples[(index + 1) % len(samples)]
        tangent = unit(next_point - prev_point)
        if not (2 <= px < WIDTH - 2 and 2 <= py < HEIGHT - 2):
            continue
        total += 1
        xi, yi = int(round(px)), int(round(py))
        best = None
        for dy in range(-3, 4):
            for dx in range(-3, 4):
                ex, ey = xi + dx, yi + dy
                if not (0 <= ex < WIDTH and 0 <= ey < HEIGHT) or front[ey, ex] or not edge[ey, ex]:
                    continue
                magnitude = float(abs(gx[ey, ex]) + abs(gy[ey, ex]))
                if magnitude < 1e-3:
                    continue
                distance = dx * dx + dy * dy
                score = magnitude / (1.0 + distance)
                if best is None or score > best[0]:
                    best = (score, ex, ey)
        if best is None:
            continue
        _score, ex, ey = best
        # gradient is perpendicular to the edge; edge direction = gradient rotated 90°
        gxv, gyv = gx[ey, ex], gy[ey, ex]
        edge_direction = unit(np.array([-gyv, gxv]))
        cosine = abs(float(np.dot(edge_direction, tangent)))
        threshold = math.cos(math.radians(tolerance_deg))
        if cosine >= threshold:
            good += 1
    return round(good / max(1, total), 4)


def boundary_metrics(points, dist, front, spacing=1.4, edge=None):
    samples = sample_polygon(points, spacing=spacing)
    xs = np.clip(np.rint(samples[:, 0]).astype(int), 0, WIDTH - 1)
    ys = np.clip(np.rint(samples[:, 1]).astype(int), 0, HEIGHT - 1)
    occluded = front[ys, xs]
    d = subpixel_dist(dist, samples)
    visible = ~occluded
    if int(visible.sum()) < 24:
        return {'edgeSupport': 0.0, 'boundaryP95': 99.0, 'chamfer': 99.0, 'visibleCoverage': 0.0, 'samples': int(visible.sum()), 'supportLength': 0.0}
    support = float((d[visible] <= 1.6).mean())
    p95 = float(np.percentile(d[visible], 95))
    chamfer = float(d[visible].mean())
    result = {
        'edgeSupport': round(support, 4),
        'boundaryP95': round(p95, 3),
        'chamfer': round(chamfer, 3),
        'visibleCoverage': round(float(visible.mean()), 4),
        'samples': int(visible.sum()),
        'supportLength': round(float(support * visible.sum()), 1),
    }
    if edge is not None:
        oriented = oriented_support(points, edge, front)
        result['orientedSupport'] = oriented
        result['contourSupport'] = round(0.55 * support + 0.45 * oriented, 4)
    return result


def family_score(metrics, complexity):
    # Evidence dominates; complexity is only a small tie-breaker so a more complex
    # shape must earn its extra corners through better boundary support.
    support = metrics.get('contourSupport', metrics['edgeSupport'])
    return (support - 0.0018 * max(0.0, metrics['boundaryP95'] - 1.2)
            - 0.004 * metrics['chamfer'] - 0.008 * complexity)


def corner_polygon(quad, corners):
    out = []
    for i in range(4):
        cur = quad[i]
        prev = quad[i - 1]
        nxt = quad[(i + 1) % 4]
        info = corners[i]
        if info['type'] == 'cut':
            d1 = float(info['cut'][0]) * float(np.linalg.norm(prev - cur))
            d2 = float(info['cut'][1]) * float(np.linalg.norm(nxt - cur))
            out.append(cur + unit(prev - cur) * d1)
            out.append(cur + unit(nxt - cur) * d2)
        elif info['type'] == 'round':
            r = float(info['radius']) * min(float(np.linalg.norm(prev - cur)), float(np.linalg.norm(nxt - cur)))
            p1 = cur + unit(prev - cur) * r
            p2 = cur + unit(nxt - cur) * r
            # Sample the actual quarter arc (chord would flatten the corner by ~0.3r).
            center = p1 + unit(nxt - cur) * r
            start_angle = math.atan2(p1[1] - center[1], p1[0] - center[0])
            end_angle = math.atan2(p2[1] - center[1], p2[0] - center[0])
            delta = end_angle - start_angle
            while delta > math.pi:
                delta -= 2 * math.pi
            while delta < -math.pi:
                delta += 2 * math.pi
            for t in np.linspace(0, 1, 9):
                angle = start_angle + delta * t
                out.append(center + r * np.array([math.cos(angle), math.sin(angle)]))
        else:
            out.append(cur)
    return np.asarray(out, float)


def residual_curve_check(points, dist, front, box):
    """S5: if straight+corner residual stays high with coherent direction, flag curve."""
    samples = sample_polygon(points)
    xs = np.clip(np.rint(samples[:, 0]).astype(int), 0, WIDTH - 1)
    ys = np.clip(np.rint(samples[:, 1]).astype(int), 0, HEIGHT - 1)
    visible = ~front[ys, xs]
    if int(visible.sum()) < 60:
        return None
    d = dist[ys[visible], xs[visible]]
    bad = d > 1.5
    ratio = float(bad.mean())
    if ratio < .06:
        return None
    # coherent runs of residual (three consecutive samples over threshold)
    runs, run = 0, 0
    for flag in bad:
        if flag:
            run += 1
        else:
            if run >= 3:
                runs += 1
            run = 0
    if run >= 3:
        runs += 1
    if runs < 2:
        return None
    return {'residualRatio': round(ratio, 3), 'runs': runs}


# ---------------------------------------------------------------- native prototypes
def prototype_polygon(name, box, params=None):
    x, y, w, h = box
    params = params or {}
    if name == 'hexagon':
        a = float(params.get('headDepth', .25))
        points = [[a, 0], [1 - a, 0], [1, .5], [1 - a, 1], [a, 1], [0, .5]]
    elif name == 'chevron':
        n = float(params.get('notchDepth', .25))
        points = [[0, 0], [1 - n, 0], [1, .5], [1 - n, 1], [0, 1], [n, .5]]
    elif name == 'parallelogram':
        a = float(params.get('headDepth', .15))
        sign = 1 if params.get('slantSign', 1) >= 0 else -1
        points = [[a, 0], [1, 0], [1 - a, 1], [0, 1]] if sign > 0 else [[0, 0], [1 - a, 0], [1, 1], [a, 1]]
    elif name == 'trapezoid':
        a = float(params.get('headDepth', .2))
        points = [[a, 0], [1 - a, 0], [1, 1], [0, 1]]
    elif name == 'rightArrow':
        hd = float(params.get('headDepth', .2))
        points = [[0, .25], [1 - hd, .25], [1 - hd, 0], [1, .5], [1 - hd, 1], [1 - hd, .75], [0, .75]]
    elif name == 'triangle':
        points = [[.5, 0], [1, 1], [0, 1]]
    else:
        return None
    return np.asarray([[x + p[0] * w, y + p[1] * h] for p in points], float)


# ---------------------------------------------------------------- candidate evaluation
# Per-fitting-model profiles: each family gets its own candidate set, score weights and
# acceptance gates instead of one global threshold. (Wired into fit_element ranking.)
CLASS_PROFILES = {
    'QUAD': {'edge': .45, 'oriented': .40, 'error': 1.4, 'p95Max': 3.0, 'supportMin': .80,
             'allowLanes': ('quad', 'cut', 'round-minor'), 'fallback': 'seed-box'},
    'ROUND-QUAD': {'edge': .35, 'oriented': .35, 'error': 1.6, 'p95Max': 2.5, 'supportMin': .85,
                   'allowLanes': ('quad', 'radius'), 'fallback': 'roundPanel'},
    'ELLIPSE': {'edge': .35, 'oriented': .45, 'error': 1.2, 'p95Max': 2.0, 'supportMin': .90,
                'allowLanes': ('ellipse',), 'fallback': 'reject'},
    'RING': {'edge': .35, 'oriented': .45, 'error': 1.2, 'p95Max': 2.0, 'supportMin': .90,
             'allowLanes': ('ellipse', 'hole'), 'fallback': 'reject'},
    'PRESET-POLY': {'edge': .40, 'oriented': .35, 'error': 1.4, 'p95Max': 3.0, 'supportMin': .80,
                    'allowLanes': ('prototype', 'quad'), 'fallback': 'quad'},
    'LINE': {'edge': .45, 'oriented': .40, 'error': .8, 'p95Max': 1.5, 'supportMin': .85,
             'allowLanes': ('line',), 'fallback': 'reject'},
    'OPEN-PATH': {'edge': .35, 'oriented': .35, 'error': 1.2, 'p95Max': 2.5, 'supportMin': .80,
                  'allowLanes': ('path', 'polyline', 'curve'), 'fallback': 'keep'},
    'FREEFORM-CURVE': {'edge': .25, 'oriented': .25, 'error': 1.2, 'p95Max': 2.5, 'supportMin': .75,
                       'allowLanes': ('contour', 'curve'), 'fallback': 'keep'},
    'EFFECT': {'allowLanes': (), 'fallback': 'keep'},
    'ASSET': {'allowLanes': (), 'fallback': 'keep'},
    'TEXT': {'allowLanes': (), 'fallback': 'keep'},
    'COMPOSITE': {'allowLanes': (), 'fallback': 'keep'},
}
COMPLEXITY = {'box': 0, 'seed-box': 0, 'rectPanel': 0, 'rect-sharp': 1, 'parallelogram': 2, 'parallelogram-sharp': 2, 'cutPanel': 3, 'roundPanel': 3, 'trapezoid': 2, 'hexagon': 3, 'chevron': 3, 'rightArrow': 4, 'triangle': 3, 'freeform': 6, 'freeform-curve': 6}


def family_edge_ends(families, box, y_center, side='right', tol=5.0):
    """Endpoints of all nearby horizontal edge families that fall inside a card's
    x-range. Used to pin the panel's top/bottom-right corner to where its edge ends."""
    x, y, w, h = box
    ends = []
    for family in families:
        if not family['horizontal'] or abs(family_pos(family) - y_center) > tol:
            continue
        for line in family.get('lines') or []:
            for point in (line['a'], line['b']):
                if not (x - 10 <= point[0] <= x + w + 26):
                    continue
                ends.append(float(point[0]))
    if not ends:
        return None
    return max(ends) if side == 'right' else min(ends)


def anchor_quad_to_edges(quad, families, box):
    """Rebuild a quad with its right corners pinned to where the panel's horizontal
    edges actually end. Stops a panel from borrowing the neighbour's border line."""
    quad = np.asarray(quad, float)
    x, y, w, h = box
    horizontals = [f for f in families if f['horizontal']]
    if not horizontals:
        return None
    top_y = float(quad[0][1])
    bottom_y = float(quad[2][1])
    if min(abs(family_pos(f) - top_y) for f in horizontals) > max(9.0, h * .05):
        return None
    if min(abs(family_pos(f) - bottom_y) for f in horizontals) > max(9.0, h * .05):
        return None
    right_top = family_edge_ends(horizontals, box, top_y, 'right', tol=max(5.0, h * .02))
    right_bottom = family_edge_ends(horizontals, box, bottom_y, 'right', tol=max(5.0, h * .02))
    if right_top is None:
        return None
    if abs(right_top - quad[1][0]) > 42:
        return None
    top_left = float(quad[0][0])
    top_right = float(right_top)
    bottom_right = float(quad[2][0] + (top_right - quad[1][0]))
    if right_bottom is not None and abs(right_bottom - bottom_right) < 24:
        bottom_right = float(right_bottom)
    shift_right = bottom_right - top_right
    return np.array([[top_left, top_y], [top_right, top_y],
                     [bottom_right, bottom_y], [top_left + shift_right, bottom_y]], float)


def probe_box(e, dx, dy, dw, dh):
    probe = dict(e)
    x = max(0.0, float(e['x']) + dx)
    y = max(0.0, float(e['y']) + dy)
    probe['x'] = x
    probe['y'] = y
    probe['w'] = min(float(WIDTH) - x, max(8.0, float(e['w']) + dw))
    probe['h'] = min(float(HEIGHT) - y, max(8.0, float(e['h']) + dh))
    return probe


_LAB_CACHE = {}
_REF = None


def get_lab(ref):
    key = id(ref)
    if key not in _LAB_CACHE:
        _LAB_CACHE[key] = cv2.cvtColor(ref, cv2.COLOR_RGB2LAB).astype(np.float32)
    return _LAB_CACHE[key]


def estimate_appearance(e, ref, front, box, dist):
    if ref is None:
        ref = _REF
    """Infer fill/stroke/edge character of an element, either from declared attributes
    (LLM proposal or element fields) or from the image itself. This selects the fitting
    strategy: crisp bordered shapes use edge/line fitting, gradient/borderless shapes
    use fill-contrast boundary fitting."""
    x, y, w, h = box
    declared_gradient = bool(e.get('hasGradient') or e.get('gradient'))
    declared_appearance = e.get('appearance') or {}
    declared_fill_kind = declared_appearance.get('fillKind') or e.get('fillKind')
    declared_stroke_kind = declared_appearance.get('strokeKind') or e.get('strokeKind')
    declared_edge_kind = declared_appearance.get('edgeKind') or e.get('edgeKind')
    stroke_width = float(e.get('strokeWidth') or 0)
    if declared_stroke_kind in ('stroke', 'noStroke', 'glowOnly'):
        declared_stroke = declared_stroke_kind == 'stroke' and stroke_width >= 0.5
    else:
        declared_stroke = e.get('hasStroke')
        if declared_stroke is None:
            declared_stroke = stroke_width >= 0.5
    lab = get_lab(ref)
    ix0 = max(0, int(x + w * 0.25))
    ix1 = min(WIDTH, int(x + w * 0.75) + 1)
    iy0 = max(0, int(y + h * 0.25))
    iy1 = min(HEIGHT, int(y + h * 0.75) + 1)
    interior_gradient = 0.0
    if ix1 > ix0 and iy1 > iy0:
        patch = lab[iy0:iy1, ix0:ix1]
        mask = ~front[iy0:iy1, ix0:ix1]
        if int(mask.sum()) > 40:
            pixels = patch[mask]
            luminance = pixels[:, 0]
            interior_gradient = float(np.std(luminance))
    # edge visibility: how much of the input box boundary has an image edge nearby
    ring = np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], float)
    ring_metrics = boundary_metrics(ring, dist, front)
    edge_visibility = ring_metrics['edgeSupport']
    has_gradient = bool(declared_gradient or declared_fill_kind == 'gradient' or interior_gradient >= 7.0)
    explicit_no_stroke = declared_stroke_kind in ('noStroke', 'glowOnly')
    borderless = (explicit_no_stroke
                  or declared_edge_kind in ('faint', 'softGlow')
                  or edge_visibility < 0.35)
    return {
        'hasGradient': has_gradient,
        'hasStroke': bool(declared_stroke),
        'interiorGradient': round(interior_gradient, 2),
        'edgeVisibility': round(edge_visibility, 3),
        'borderless': borderless,
        'strategy': ('fill-contrast' if borderless else 'edge-line')
                    if not has_gradient else ('fill-contrast+gradient' if borderless else 'edge-line+gradient'),
    }


def fit_fill_contour(e, front, dist, box):
    """Fill-contrast boundary lane: model the interior vs surrounding colours, segment the
    element region, then fit a polygon/ellipse to the region contour. Works for borderless
    / translucent / gradient panels where edge maps are too weak for line fitting."""
    x, y, w, h = box
    pad = max(8.0, 0.18 * max(w, h))
    x0 = max(0, int(x - pad))
    y0 = max(0, int(y - pad))
    x1 = min(WIDTH, int(math.ceil(x + w + pad)))
    y1 = min(HEIGHT, int(math.ceil(y + h + pad)))
    if x1 - x0 < 12 or y1 - y0 < 12:
        return None
    lab = get_lab(_REF)
    roi = lab[y0:y1, x0:x1]
    roi_front = front[y0:y1, x0:x1]
    # interior colour model: central 50% of the input box
    ix0 = max(0, int(x + w * 0.25) - x0)
    ix1 = min(roi.shape[1], int(x + w * 0.75) + 1 - x0)
    iy0 = max(0, int(y + h * 0.25) - y0)
    iy1 = min(roi.shape[0], int(y + h * 0.75) + 1 - y0)
    inner_mask = np.zeros(roi.shape[:2], bool)
    if ix1 > ix0 and iy1 > iy0:
        inner_mask[iy0:iy1, ix0:ix1] = True
    inner_mask &= ~roi_front
    if int(inner_mask.sum()) < 60:
        return None
    inner_mean = np.median(roi[inner_mask], axis=0)
    # surrounding colour model: ring well outside the input box
    ring_mask = np.zeros(roi.shape[:2], bool)
    ox0 = max(0, int(x - pad * 0.8) - x0)
    ox1 = min(roi.shape[1], int(x + w + pad * 0.8) + 1 - x0)
    oy0 = max(0, int(y - pad * 0.8) - y0)
    oy1 = min(roi.shape[0], int(y + h + pad * 0.8) + 1 - y0)
    ring_mask[oy0:oy1, ox0:ox1] = True
    box_mask = np.zeros(roi.shape[:2], bool)
    bx0 = max(0, int(x) - x0)
    bx1 = min(roi.shape[1], int(x + w) + 1 - x0)
    by0 = max(0, int(y) - y0)
    by1 = min(roi.shape[0], int(y + h) + 1 - y0)
    box_mask[by0:by1, bx0:bx1] = True
    ring_mask &= ~box_mask
    ring_mask &= ~roi_front
    if int(ring_mask.sum()) < 60:
        return None
    outer_mean = np.median(roi[ring_mask], axis=0)
    d_inner = np.linalg.norm(roi - inner_mean[None, None, :], axis=2)
    d_outer = np.linalg.norm(roi - outer_mean[None, None, :], axis=2)
    fg = (d_inner < d_outer) & (d_inner < 34.0) & (~roi_front)
    fg = fg.astype(np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    contours = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]
    if not contours:
        return None
    center = (int(x + w / 2.0) - x0, int(y + h / 2.0) - y0)
    chosen = None
    for contour in contours:
        if cv2.pointPolygonTest(contour, center, False) >= 0:
            chosen = contour
            break
    if chosen is None:
        chosen = max(contours, key=cv2.contourArea)
    area = abs(cv2.contourArea(chosen))
    if area < w * h * 0.35:
        return None
    approx = cv2.approxPolyDP(chosen, 1.6, True)[:, 0, :].astype(float) + np.array([x0, y0])
    if len(approx) < 3 or len(approx) > 24:
        return None
    candidates = []
    # ellipse alternative for round bubbles
    if len(chosen) >= 5:
        (ecx, ecy), (d1, d2), angle = cv2.fitEllipse(chosen)
        ellipse_cx, ellipse_cy = ecx + x0, ecy + y0
        ellipse_rx, ellipse_ry = float(d1) / 2.0, float(d2) / 2.0
        if ellipse_rx >= 3 and ellipse_ry >= 3:
            aspect = min(ellipse_rx, ellipse_ry) / max(ellipse_rx, ellipse_ry)
            if aspect >= 0.82:
                angles = np.linspace(0, 2 * math.pi, 72, endpoint=False)
                rotation = math.radians(angle)
                ex = ellipse_rx * np.cos(angles)
                ey = ellipse_ry * np.sin(angles)
                points = np.column_stack([
                    ellipse_cx + ex * math.cos(rotation) - ey * math.sin(rotation),
                    ellipse_cy + ex * math.sin(rotation) + ey * math.cos(rotation)])
                is_circle = abs(ellipse_rx - ellipse_ry) / max(ellipse_rx, ellipse_ry) <= 0.08
                radius = (ellipse_rx + ellipse_ry) / 2.0
                native = {'type': 'ellipse', 'shape': 'ellipse', 'circle': bool(is_circle),
                          'bounds': {'x': round(ellipse_cx - ellipse_rx, 2), 'y': round(ellipse_cy - ellipse_ry, 2),
                                     'w': round(2 * ellipse_rx, 2), 'h': round(2 * ellipse_ry, 2)},
                          'rx': round(ellipse_rx, 2), 'ry': round(ellipse_ry, 2),
                          'rotation': round(angle, 2)}
                candidates.append({'kind': 'circle' if is_circle else 'ellipse', 'points': points,
                                   'native': native, 'complexity': 2})
    # polygon alternative (panels / cards / bubbles)
    hull = cv2.convexHull(chosen)[:, 0, :].astype(float) + np.array([x0, y0])
    candidates.append({'kind': 'fill-panel', 'points': hull, 'native': None, 'complexity': 2})
    results = []
    for candidate in candidates:
        points = np.asarray(candidate['points'], float)
        # fill-boundary evidence: colour difference across the boundary normal
        samples = sample_polygon(points, spacing=2.0)
        if len(samples) < 30:
            continue
        normal_evidence = 0.0
        checks = 0
        for index in range(0, len(samples), 2):
            px, py = samples[index]
            if not (2 <= px < WIDTH - 2 and 2 <= py < HEIGHT - 2):
                continue
            # local boundary normal from neighbouring samples
            prev = samples[index - 1]
            nxt = samples[(index + 1) % len(samples)]
            tangent = unit(nxt - prev)
            normal = np.array([-tangent[1], tangent[0]])
            xa, ya = int(round(px + normal[0] * 3)), int(round(py + normal[1] * 3))
            xb, yb = int(round(px - normal[0] * 3)), int(round(py - normal[1] * 3))
            if not (0 <= xa < WIDTH and 0 <= ya < HEIGHT and 0 <= xb < WIDTH and 0 <= yb < HEIGHT):
                continue
            delta = float(np.linalg.norm(lab[ya, xa] - lab[yb, xb]))
            checks += 1
            if delta >= 6.0:
                normal_evidence += 1
        if checks < 15:
            continue
        fill_support = normal_evidence / float(checks)
        edge_metrics = boundary_metrics(points, dist, front)
        metrics = dict(edge_metrics)
        metrics['fillSupport'] = round(fill_support, 4)
        results.append(dict(candidate, metrics=metrics))
    return results if results else None


_ASSET_TYPES = {'svg', 'image', 'cutout', 'crop', 'generate', 'ai-cutout', 'asset'}
_ASSET_CLASSES = {'icon', 'svg', 'cutout', 'ai-cutout', 'aiimage', 'illustration', 'asset',
                  'photo', 'image', 'glyph', 'logo'}


def element_is_asset(e):
    """SVG / AI-cutout / image assets are inserted as original media: ignore them as
    shape-fitting targets and never use their pixels as boundary evidence."""
    if e.get('fitIgnore') is True:
        return True
    supplied_class = str(e.get('classHint') or e.get('elementClass') or e.get('class') or '').lower()
    if supplied_class in _ASSET_CLASSES:
        return True
    element_type = str(e.get('type') or '').lower()
    if element_type in _ASSET_TYPES:
        return True
    klass = str(e.get('classHint') or e.get('shape') or e.get('role') or '').lower()
    if klass in _ASSET_CLASSES:
        return True
    if e.get('assetId') or e.get('materialId'):
        return True
    return str(e.get('source') or '').lower() in ('svg', 'ai-cutout', 'cutout')


def filter_asset_lines(lines, asset_boxes, margin=4.0):
    """Drop line segments whose midpoint falls inside an asset bbox (icons/cutouts), so a
    round bubble is not fitted to the contour of a nearby AI icon."""
    if not asset_boxes:
        return lines
    kept = []
    for line in lines:
        mid = (line['a'] + line['b']) / 2.0
        inside = False
        for x, y, w, h in asset_boxes:
            if x - margin <= mid[0] <= x + w + margin and y - margin <= mid[1] <= y + h + margin:
                inside = True
                break
        if not inside:
            kept.append(line)
    return kept


def quad_is_sane(quad, box):
    """Reject collapsed/exploded quads after sub-pixel side sliding (each side moves on
    its own, so without this check a weak ROI can collapse the quad onto one edge)."""
    quad = np.asarray(quad, float)
    x, y, w, h = box
    area = 0.5 * abs(np.dot(quad[:, 0], np.roll(quad[:, 1], 1)) - np.dot(quad[:, 1], np.roll(quad[:, 0], 1)))
    if not np.all(np.isfinite(quad)):
        return False
    if area < w * h * 0.45 or area > w * h * 2.2:
        return False
    sides = [float(np.linalg.norm(quad[(i + 1) % 4] - quad[i])) for i in range(4)]
    return min(sides) >= max(6.0, min(w, h) * 0.30)


def _variant_admissible(variant, e, panel_model):
    """A probe variant may not be accepted when it is just a shifted seed box (R1 bug) and,
    for panel models, must stay inside the audit-box tolerance (no drift)."""
    chosen = variant.get('chosen') or {}
    kind = str(chosen.get('kind') or '')
    if str(chosen.get('extra', {}).get('fallback') or '') == 'profile-gate':
        return False
    if panel_model:
        if kind == 'fill-panel':
            return False
        points = np.asarray(chosen.get('points') or [], float)
        if points.ndim != 2 or len(points) < 3:
            return False
        x, y, w, h = box_of(e)
        lo = points.min(axis=0)
        hi = points.max(axis=0)
        # ROI is only a hint now: the fitted box may sit anywhere on the page. The audit
        # size stays as a soft prior (very generous bounds) to reject absurd outliers.
        if lo[0] < -8 or lo[1] < -8 or hi[0] > WIDTH + 8 or hi[1] > HEIGHT + 8:
            return False
        area_ratio = (hi[0] - lo[0]) * (hi[1] - lo[1]) / max(1.0, w * h)
        if area_ratio < 0.15 or area_ratio > 4.0:
            return False
        return True
    if kind == 'seed-box':
        # a probe whose chosen result is its own seed box is a pure drift artefact: reject.
        probe_seed = np.asarray((variant.get('seed') or {}).get('points') or [], float)
        points = np.asarray(chosen.get('points') or [], float)
        if probe_seed.shape == points.shape and probe_seed.size:
            return not bool(np.allclose(probe_seed, points, atol=0.6))
    return True


def improve_fit(e, item, index, elements, families, lines, edge, dist, front, ref, excluded):
    """Second pass for weak/offset ROIs: expand the search window and retry with
    normal and low-contrast edge maps, keeping the original seed baseline.

    R1 structural fix: panel-class elements are never re-fitted on shifted/expanded probe
    boxes (that is what moved panel outlines onto neighbouring text). Only the weak edge map
    is retried on the identical ROI, and every accepted variant must pass containment."""
    metrics = item['chosen']['metrics']
    if (metrics['boundaryP95'] <= 12.0 and metrics['edgeSupport'] >= 0.72
            and not e.get('_mergeFamily')):
        return item
    model = str(item.get('model') or '')
    panel_model = model in PANEL_MODELS and not e.get("_mergeFamily")
    w, h = float(e['w']), float(e['h'])
    candidates = []
    layouts = []
    if panel_model and (metrics['boundaryP95'] > 5.0 or metrics['edgeSupport'] < 0.65):
        # a slightly offset/narrow ROI: retry with small shifts and a modest outward expansion
        step_x = max(4.0, min(0.08 * w, 24.0))
        step_y = max(4.0, min(0.08 * h, 24.0))
        layouts.append(('panel-shift-up', 0.0, -step_y, 0.0, 0.0))
        layouts.append(('panel-shift-down', 0.0, step_y, 0.0, 0.0))
        layouts.append(('panel-shift-left', -step_x, 0.0, 0.0, 0.0))
        layouts.append(('panel-shift-right', step_x, 0.0, 0.0, 0.0))
        layouts.append(('panel-expand', -step_x, -step_y, 2 * step_x, 2 * step_y))
    if not panel_model:
        layouts.append(('symmetric', -0.22 * w, -0.22 * h, 0.44 * w, 0.44 * h))
        if metrics['boundaryP95'] > 8.0:
            layouts.append(('shift-up', 0.0, -0.26 * h, 0.0, 0.0))
            layouts.append(('shift-down', 0.0, 0.26 * h, 0.0, 0.0))
            layouts.append(('shift-left', -0.26 * w, 0.0, 0.0, 0.0))
        # expand towards the side where the fitted shape drifted away from the ROI center
        chosen_points = np.asarray(item['chosen']['points'], float)
        center_x = float(chosen_points[:, 0].mean())
        center_y = float(chosen_points[:, 1].mean())
        roi_center_x = float(e['x']) + w / 2.0
        roi_center_y = float(e['y']) + h / 2.0
        if abs(center_x - roi_center_x) >= abs(center_y - roi_center_y):
            if center_x >= roi_center_x:
                layouts.append(('expand-left', -0.45 * w, -0.12 * h, 0.45 * w, 0.24 * h))
            else:
                layouts.append(('expand-right', 0.0, -0.12 * h, 0.45 * w, 0.24 * h))
        else:
            if center_y >= roi_center_y:
                layouts.append(('expand-up', -0.12 * w, -0.45 * h, 0.24 * w, 0.45 * h))
            else:
                layouts.append(('expand-down', -0.12 * w, 0.0, 0.24 * w, 0.45 * h))
    for name, dx, dy, dw, dh in layouts:
        probe = probe_box(e, dx, dy, dw, dh)
        probe['_panelOptDone'] = True
        variant = fit_element(probe, index, elements, families, lines, edge, dist, front)
        if variant is not None and _variant_admissible(variant, e, panel_model):
            candidates.append((name, variant))
    if metrics['edgeSupport'] < 0.45:
        weak_edge, weak_dist = edge_maps(ref, excluded, weak=True)
        probe = probe_box(e, 0.0, 0.0, 0.0, 0.0)
        probe['_panelOptDone'] = True
        variant = fit_element(probe, index, elements, families, lines, weak_edge, weak_dist, front)
        if variant is not None and _variant_admissible(variant, e, panel_model):
            candidates.append(('weak-base', variant))
    best = item
    best_metrics = metrics
    best_name = None
    for name, variant in candidates:
        variant_metrics = variant['chosen']['metrics']
        if (variant_metrics['boundaryP95'] < best_metrics['boundaryP95'] - 1.5
                and variant_metrics['edgeSupport'] >= best_metrics['edgeSupport'] - 0.06):
            best = variant
            best_metrics = variant_metrics
            best_name = name
    if best_metrics['boundaryP95'] > 30.0:
        weak_edge, weak_dist = edge_maps(ref, excluded, weak=True)
        rescue_layouts = [('weak-base', 0.0, 0.0, 0.0, 0.0)]
        if not panel_model:
            rescue_layouts += [('weak-symmetric', -0.22 * w, -0.22 * h, 0.44 * w, 0.44 * h),
                               ('weak-up', -0.12 * w, -0.45 * h, 0.24 * w, 0.45 * h),
                               ('weak-down', -0.12 * w, 0.0, 0.24 * w, 0.45 * h)]
        rescue = []
        for name, dx, dy, dw, dh in rescue_layouts:
            probe = probe_box(e, dx, dy, dw, dh)
            probe['_panelOptDone'] = True
            variant = fit_element(probe, index, elements, families, lines, weak_edge, weak_dist, front)
            if variant is not None and _variant_admissible(variant, e, panel_model):
                rescue.append((name, variant))
        for name, variant in rescue:
            variant_metrics = variant['chosen']['metrics']
            if (variant_metrics['boundaryP95'] < best_metrics['boundaryP95'] - 1.5
                    and variant_metrics['edgeSupport'] >= best_metrics['edgeSupport'] - 0.06):
                best = variant
                best_metrics = variant_metrics
                best_name = name
    if best is not item:
        best['seed'] = item['seed']
        best['roi'] = item['roi']
        best['expanded'] = {'variant': best_name, 'originalSeed': item['seed'], 'originalRoi': item['roi']}
    return best


def side_support_subpixel(a, b, dist, front, tolerance=1.2):
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    length = float(np.linalg.norm(b - a))
    steps = max(3, int(length / 1.5))
    samples = a[None, :] + (b - a)[None, :] * np.linspace(0, 1, steps)[:, None]
    xs = np.clip(np.rint(samples[:, 0]).astype(int), 0, WIDTH - 1)
    ys = np.clip(np.rint(samples[:, 1]).astype(int), 0, HEIGHT - 1)
    visible = ~front[ys, xs]
    if int(visible.sum()) < 6:
        return 0.0, 99.0
    d = subpixel_dist(dist, samples[visible])
    return float((d <= tolerance).mean()), float(np.percentile(d, 95))


def refine_quad_offsets_subpixel(quad, dist, front, rounds=2):
    """Slide each side with sub-pixel offsets (0.5px steps) against the bilinear edge
    distance field; the coarse candidate search only ever moves in whole pixels."""
    quad = np.asarray(quad, float).copy()
    for _ in range(rounds):
        moved = False
        for i in range(4):
            j = (i + 1) % 4
            a, b = quad[i], quad[j]
            direction = unit(b - a)
            normal = np.array([-direction[1], direction[0]])
            best = None
            for delta in np.arange(-6.0, 6.01, 0.5):
                support, p95 = side_support_subpixel(a + normal * delta, b + normal * delta, dist, front)
                score = support - 0.01 * max(0.0, p95 - 1.0)
                if best is None or score > best[0]:
                    best = (score, float(delta), support)
            if best and abs(best[1]) >= 0.25 and best[2] > 0.35:
                quad[i] = a + normal * best[1]
                quad[j] = b + normal * best[1]
                moved = True
        if not moved:
            break
    return quad


def optimize_corner_radii(quad, dist, front, box, edge=None, min_gain=0.0025):
    """Measurement-driven rounded-corner fitting: try per-corner radii against the real
    edge field instead of relying on geometric arc detection (small radii are fragile).
    Corners with direct edge evidence are kept sharp so the search stays cheap."""
    quad = np.asarray(quad, float)

    def evaluate(candidate_corners, spacing=1.4):
        polygon = corner_polygon(quad, candidate_corners)
        metrics = boundary_metrics(polygon, dist, front, spacing=spacing)
        score = (metrics['edgeSupport'] - 0.0016 * max(0.0, metrics['boundaryP95'] - 1.2)
                 - 0.02 * metrics['chamfer'])
        return score, metrics, polygon

    corners = [{'type': 'sharp'} for _ in range(4)]
    best_score, best_metrics, best_polygon = evaluate(corners)
    if edge is None:
        return list(corners), best_polygon, best_metrics, best_score

    corner_evidence = []
    for i in range(4):
        cx, cy = int(round(quad[i][0])), int(round(quad[i][1]))
        found = False
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                x = cx + dx
                y_index = cy + dy
                if 0 <= x < WIDTH and 0 <= y_index < HEIGHT and edge[y_index, x] and not front[y_index, x]:
                    found = True
                    break
            if found:
                break
        corner_evidence.append(found)
    if all(corner_evidence):
        return list(corners), best_polygon, best_metrics, best_score

    best_corners = [dict(corner) for corner in corners]
    for i in range(4):
        if corner_evidence[i]:
            continue
        adjacent = min(float(np.linalg.norm(quad[i - 1] - quad[i])),
                       float(np.linalg.norm(quad[(i + 1) % 4] - quad[i])))
        max_radius = adjacent * 0.5
        if max_radius < 4.0:
            continue
        step = max(2.0, max_radius / 12.0)
        candidates = np.arange(4.0, max_radius + 0.1, step)
        local_best = None
        for radius_px in candidates:
            candidate = [dict(corner) for corner in best_corners]
            candidate[i] = {'type': 'round', 'radius': round(float(radius_px) / adjacent, 4)}
            score, metrics, polygon = evaluate(candidate, spacing=2.2)
            if local_best is None or score > local_best[0]:
                local_best = (score, candidate, metrics, polygon, float(radius_px))
        if local_best is None:
            continue
        # fine search around the coarse winner with full-resolution metrics
        coarse_radius = local_best[4]
        for radius_px in np.arange(max(3.0, coarse_radius - step), coarse_radius + step + 0.01, 0.75):
            candidate = [dict(corner) for corner in best_corners]
            candidate[i] = {'type': 'round', 'radius': round(float(radius_px) / adjacent, 4)}
            score, metrics, polygon = evaluate(candidate)
            if score > local_best[0]:
                local_best = (score, candidate, metrics, polygon, float(radius_px))
        if local_best[0] > best_score + min_gain:
            best_score, best_corners, best_metrics, best_polygon = (
                local_best[0], local_best[1], local_best[2], local_best[3])
    return best_corners, best_polygon, best_metrics, best_score


def fit_ellipse_candidate(e, edge, dist, front, box):
    """Fit circles/ellipses (badge dots, round bubbles) by iteratively fitting an ellipse
    to the edge points on its own ring. Angles/axes are refined from real edge pixels."""
    x, y, w, h = box
    cx, cy = x + w / 2.0, y + h / 2.0
    half_w, half_h = w / 2.0, h / 2.0
    pad = max(6, int(0.25 * max(w, h)))
    x0 = max(0, int(x - pad))
    y0 = max(0, int(y - pad))
    x1 = min(WIDTH, int(math.ceil(x + w + pad)))
    y1 = min(HEIGHT, int(math.ceil(y + h + pad)))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    ys, xs = np.nonzero(edge[y0:y1, x0:x1])
    if len(xs) < 12:
        return None
    ys = ys + y0
    xs = xs + x0
    visible = ~front[ys, xs]
    ys, xs = ys[visible], xs[visible]
    if len(xs) < 12:
        return None
    pts = np.column_stack([xs, ys]).astype(np.float32)
    angle = 0.0
    for _ in range(3):
        norm = np.sqrt(((pts[:, 0] - cx) / max(2.0, half_w)) ** 2
                       + ((pts[:, 1] - cy) / max(2.0, half_h)) ** 2)
        ring = pts[np.abs(norm - 1.0) < 0.22]
        if len(ring) < 8:
            break
        try:
            (ecx, ecy), (d1, d2), eang = cv2.fitEllipse(ring)
        except Exception:
            break
        new_half_w, new_half_h = float(d1) / 2.0, float(d2) / 2.0
        if not (0.55 * half_w <= new_half_w <= 1.65 * half_w
                and 0.55 * half_h <= new_half_h <= 1.65 * half_h):
            break
        cx, cy = float(ecx), float(ecy)
        half_w, half_h = new_half_w, new_half_h
        angle = float(eang)
        if not (x - 0.45 * w <= cx <= x + 1.45 * w and y - 0.45 * h <= cy <= y + 1.45 * h):
            break
    if abs(half_w - half_h) / max(half_w, half_h) <= 0.07:
        radius = (half_w + half_h) / 2.0
        if radius < 3.0:
            return None
        angles = np.linspace(0, 2 * math.pi, 72, endpoint=False)
        points = np.column_stack([cx + radius * np.cos(angles), cy + radius * np.sin(angles)])
        native = {'type': 'ellipse', 'shape': 'ellipse', 'circle': True,
                  'bounds': {'x': round(cx - radius, 2), 'y': round(cy - radius, 2),
                             'w': round(2 * radius, 2), 'h': round(2 * radius, 2)},
                  'rx': round(radius, 2), 'ry': round(radius, 2)}
        return {'kind': 'circle', 'points': points, 'native': native, 'rx': radius, 'ry': radius, 'rotation': 0.0}
    if half_w < 3.0 or half_h < 3.0:
        return None
    rotation = math.radians(angle)
    angles = np.linspace(0, 2 * math.pi, 72, endpoint=False)
    ex = half_w * np.cos(angles)
    ey = half_h * np.sin(angles)
    points = np.column_stack([cx + ex * math.cos(rotation) - ey * math.sin(rotation),
                              cy + ex * math.sin(rotation) + ey * math.cos(rotation)])
    native = {'type': 'ellipse', 'shape': 'ellipse', 'circle': False,
              'bounds': {'x': round(cx - half_w, 2), 'y': round(cy - half_h, 2),
                         'w': round(2 * half_w, 2), 'h': round(2 * half_h, 2)},
              'rx': round(half_w, 2), 'ry': round(half_h, 2), 'rotation': round(angle, 2)}
    return {'kind': 'ellipse', 'points': points, 'native': native,
            'rx': half_w, 'ry': half_h, 'rotation': angle}


CLASS_TO_MODEL = {
    'rect-panel': 'QUAD', 'card': 'QUAD', 'plate': 'QUAD', 'cut-panel': 'QUAD',
    'parallelogram': 'QUAD', 'freeform-panel': 'QUAD', 'band': 'QUAD', 'progress-segment': 'QUAD',
    'table-grid': 'COMPOSITE', 'rounded-panel': 'ROUND-QUAD', 'bubble': 'ROUND-QUAD',
    'capsule': 'ROUND-QUAD', 'pill': 'ROUND-QUAD', 'ribbon': 'ROUND-QUAD',
    'circle': 'ELLIPSE', 'ellipse': 'ELLIPSE', 'badge': 'ELLIPSE', 'ring': 'RING',
    'chevron': 'PRESET-POLY', 'arrow': 'PRESET-POLY', 'flag': 'PRESET-POLY',
    'triangle': 'PRESET-POLY', 'trapezoid': 'PRESET-POLY', 'hexagon': 'PRESET-POLY',
    'diamond': 'PRESET-POLY', 'divider': 'LINE', 'line': 'LINE', 'path': 'OPEN-PATH',
    'blob': 'FREEFORM-CURVE', 'bubble-tail': 'FREEFORM-CURVE', 'glow': 'EFFECT',
    'shadow': 'EFFECT', 'light-beam': 'EFFECT', 'texture': 'EFFECT', 'background': 'ASSET',
    'svg': 'ASSET', 'icon': 'ASSET', 'ai-cutout': 'ASSET', 'image': 'ASSET', 'logo': 'ASSET',
    'chart-image': 'ASSET', 'artistic-text': 'ASSET', 'title': 'TEXT', 'subtitle': 'TEXT',
    'heading': 'TEXT', 'body': 'TEXT', 'caption': 'TEXT', 'number': 'TEXT', 'formula': 'TEXT',
}
DEFAULT_PROFILE = {'edge': .45, 'oriented': .40, 'error': 1.6, 'p95Max': 3.0, 'supportMin': .80,
                   'allowLanes': ('quad', 'cut', 'radius', 'ellipse', 'prototype'), 'fallback': 'seed-box'}


def model_of_class(class_hint, element=None):
    if class_hint in CLASS_TO_MODEL:
        return CLASS_TO_MODEL[class_hint]
    element_type = str((element or {}).get('type') or '').lower()
    if element_type == 'ellipse':
        return 'ELLIPSE'
    if element_type in ('svg', 'image', 'cutout', 'crop', 'generate'):
        return 'ASSET'
    if element_type in ('text', 'formula'):
        return 'TEXT'
    if element_type == 'line':
        return 'LINE'
    return 'UNKNOWN'


# ---------------------------------------------------------------- panel optimizer lane
# ROI-anchored parametric panel fitting: the audit box is the design truth, so the lane only
# refines its four edges and the corner radius inside a hard tolerance. Evidence terms are
# edge support, gradient-orientation consistency and inner/outer Lab contrast (weak borders
# never show up in the Canny map, but the fill boundary still has colour steps).
PANEL_OPT_WEIGHTS = {'edge': .38, 'orient': .24, 'contrast': .18, 'p95': .14,
                     'area': .08, 'guide': .05, 'penetration': 2.0}


def _edge_gradients(edge):
    gx = cv2.Sobel(edge.astype(np.float32), cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(edge.astype(np.float32), cv2.CV_32F, 0, 1, ksize=3)
    return gx, gy


def oriented_support_fast(points, edge, front, gx, gy, spacing=4.0, tolerance_deg=16.0):
    """Vectorised equivalent of oriented_support (same 7x7 window / gradient rule)."""
    samples = sample_polygon(points, spacing=spacing)
    if len(samples) < 24:
        return 0.0
    prev = np.roll(samples, 1, axis=0)
    nxt = np.roll(samples, -1, axis=0)
    tangents = nxt - prev
    norms = np.linalg.norm(tangents, axis=1)
    tangents = tangents / np.maximum(norms, 1e-9)[:, None]
    xi = np.rint(samples[:, 0]).astype(int)
    yi = np.rint(samples[:, 1]).astype(int)
    inside = (xi >= 2) & (xi < WIDTH - 2) & (yi >= 2) & (yi < HEIGHT - 2)
    total = int(inside.sum())
    if total < 24:
        return 0.0
    count = len(samples)
    best_score = np.full(count, -1.0)
    best_dx = np.zeros(count, int)
    best_dy = np.zeros(count, int)
    for dy in range(-3, 4):
        for dx in range(-3, 4):
            ex = xi + dx
            ey = yi + dy
            ok = inside & (ex >= 0) & (ex < WIDTH) & (ey >= 0) & (ey < HEIGHT)
            if not ok.any():
                continue
            exs = np.clip(ex, 0, WIDTH - 1)
            eys = np.clip(ey, 0, HEIGHT - 1)
            magnitude = np.abs(gx[eys, exs]) + np.abs(gy[eys, exs])
            ok = ok & edge[eys, exs].astype(bool) & (~front[eys, exs]) & (magnitude > 1e-3)
            score = magnitude / (1.0 + dx * dx + dy * dy)
            update = ok & (score > best_score)
            best_score[update] = score[update]
            best_dx[update] = dx
            best_dy[update] = dy
    found = best_score >= 0
    ex = np.clip(xi + best_dx, 0, WIDTH - 1)
    ey = np.clip(yi + best_dy, 0, HEIGHT - 1)
    gxv = gx[ey, ex]
    gyv = gy[ey, ex]
    gn = np.sqrt(gxv * gxv + gyv * gyv)
    safe = np.maximum(gn, 1e-9)
    edge_dir_x = np.where(gn < 1e-9, 1.0, -gyv / safe)
    edge_dir_y = np.where(gn < 1e-9, 0.0, gxv / safe)
    cosine = np.abs(edge_dir_x * tangents[:, 0] + edge_dir_y * tangents[:, 1])
    good = int((found & (cosine >= math.cos(math.radians(tolerance_deg)))).sum())
    return round(good / max(1, total), 4)


def boundary_color_contrast(points, lab, front, offsets=(3.0, 5.0)):
    """Inner/outer Lab colour step across the boundary (the weak-fill evidence channel)."""
    samples = sample_polygon(points, spacing=3.0)
    if len(samples) < 24:
        return 0.0
    prev = np.roll(samples, 1, axis=0)
    nxt = np.roll(samples, -1, axis=0)
    tangents = nxt - prev
    norms = np.linalg.norm(tangents, axis=1)
    tangents = tangents / np.maximum(norms, 1e-9)[:, None]
    normals = np.column_stack([-tangents[:, 1], tangents[:, 0]])
    values = []
    for offset in offsets:
        inner = samples + normals * offset
        outer = samples - normals * offset
        xi = np.rint(inner[:, 0]).astype(int)
        yi = np.rint(inner[:, 1]).astype(int)
        xo = np.rint(outer[:, 0]).astype(int)
        yo = np.rint(outer[:, 1]).astype(int)
        ok = ((xi >= 0) & (xi < WIDTH) & (yi >= 0) & (yi < HEIGHT)
              & (xo >= 0) & (xo < WIDTH) & (yo >= 0) & (yo < HEIGHT))
        xi_safe = np.clip(xi, 0, WIDTH - 1)
        yi_safe = np.clip(yi, 0, HEIGHT - 1)
        xo_safe = np.clip(xo, 0, WIDTH - 1)
        yo_safe = np.clip(yo, 0, HEIGHT - 1)
        ok = ok & (~front[yi_safe, xi_safe]) & (~front[yo_safe, xo_safe])
        if int(ok.sum()) < 12:
            continue
        delta = np.linalg.norm(lab[yi_safe[ok], xi_safe[ok]] - lab[yo_safe[ok], xo_safe[ok]], axis=1)
        values.append(delta)
    if not values:
        return 0.0
    all_values = np.concatenate(values)
    if len(all_values) < 24:
        return 0.0
    # 25th percentile: robust against text strokes / icons touching the boundary
    level = float(np.percentile(all_values, 25))
    return round(float(np.clip((level - 6.0) / 18.0, 0.0, 1.0)), 4)


def panel_prior_radius(e, box, model):
    """PPT roundRect adjustment -> pixel radius; declared round/pill gets a 6% prior."""
    short = max(1.0, min(float(box[2]), float(box[3])))
    radius = None
    geometry = e.get('shapeGeometry') if isinstance(e.get('shapeGeometry'), dict) else {}
    adjustments = e.get('adjustments') if isinstance(e.get('adjustments'), dict) else {}
    for source, keys in ((adjustments, ('adj', 'adjustment', 'radius')),
                         (geometry, ('adj', 'adjustment', 'cornerRadius'))):
        for key in keys:
            if source.get(key) is not None:
                radius = source.get(key)
                break
        if radius is not None:
            break
    try:
        if radius is not None:
            value = float(radius)
            if value > 1.0:
                # PPT adjustment: adj/100000 of the short side (50000 = stadium).
                return float(np.clip(value / 100000.0 * short, 0.0, short * 0.5))
            return float(np.clip(value * short, 0.0, short * 0.5))
    except Exception:
        pass
    declared = str(e.get('shape') or '').lower() in ('roundrect', 'round', 'pill')
    if declared or model in ('ROUND-RECT', 'BUBBLE'):
        return min(short * 0.5, max(2.0, short * 0.06))
    return 0.0


def panel_polygon(rect, corner_specs):
    x_left, y_top, x_right, y_bottom = [float(v) for v in rect]
    quad = np.array([[x_left, y_top], [x_right, y_top], [x_right, y_bottom], [x_left, y_bottom]], float)
    return corner_polygon(quad, corner_specs)


def uniform_corner_specs(radius_px, short):
    if float(radius_px) < 0.75:
        return [{'type': 'sharp'} for _ in range(4)]
    fraction = float(radius_px) / max(1.0, short)
    return [{'type': 'round', 'radius': round(fraction, 5)} for _ in range(4)]


def panel_native_for(kind, box, corners, radius_px):
    short = max(1.0, min(float(box[2]), float(box[3])))
    rounded = [corner for corner in corners if corner.get('type') == 'round']
    if kind in ('rect-sharp', 'seed-sharp') or not rounded:
        return {'type': 'rect', 'shape': 'rect',
                'shapeGeometry': {'version': 2, 'corners': [{'type': 'sharp'}] * 4}}
    native_corners = []
    for corner in corners:
        if corner.get('type') == 'round':
            native_corners.append({'type': 'round', 'radius': round(float(corner['radius']), 4)})
        elif corner.get('type') == 'cut':
            native_corners.append({'type': 'cut', 'cut': corner.get('cut')})
        else:
            native_corners.append({'type': 'sharp'})
    median_radius = float(np.median([float(corner['radius']) for corner in rounded] or [radius_px / short]))
    return {'type': 'shape', 'shape': 'roundRect',
            'shapeGeometry': {'version': 2, 'cornerRadius': round(median_radius, 4),
                              'corners': native_corners}}


def panel_context(dist, front, edge, ref, box, children):
    lab = get_lab(ref) if ref is not None else get_lab(_REF)
    gx, gy = _edge_gradients(edge)
    return {'dist': dist, 'front': front, 'edge': edge, 'lab': lab, 'gx': gx, 'gy': gy,
            'roi': [float(v) for v in box], 'children': children}


def _content_child_boxes(e, elements, box):
    """Child boxes fully inside the ROI (inset 4px): only these are 'content inside the
    panel'. Bands that overlap the ROI edge (heading pills, neighbour panels) are excluded,
    which is the lesson from the reverted hard-penetration filter."""
    x, y, w, h = [float(v) for v in box]
    children = []
    for other in elements:
        if other is e or other.get('managed') or other.get('role') == 'background':
            continue
        try:
            ox, oy, ow, oh = box_of(other)
        except Exception:
            continue
        if ow * oh >= w * h * 0.9:
            continue
        if (ox >= x + 4 and oy >= y + 4 and ox + ow <= x + w - 4 and oy + oh <= y + h - 4):
            children.append((ox, oy, ox + ow, oy + oh))
    return children


def _panel_bbox_drift(points, box):
    points = np.asarray(points, float)
    if points.ndim != 2 or len(points) < 3:
        return 1.0
    x, y, w, h = [float(v) for v in box]
    if w <= 0 or h <= 0:
        return 1.0
    lo = points.min(axis=0)
    hi = points.max(axis=0)
    drift = (abs(lo[0] - x) / w + abs(hi[0] - (x + w)) / w
             + abs(lo[1] - y) / h + abs(hi[1] - (y + h)) / h) / 4.0
    return round(float(drift), 5)


def panel_cost_parts(points, metrics, ctx):
    """Joint cost (lower is better) for one panel hypothesis."""
    points = np.asarray(points, float)
    edge_support = float(metrics['edgeSupport'])
    p95 = float(metrics['boundaryP95'])
    oriented = oriented_support_fast(points, ctx['edge'], ctx['front'], ctx['gx'], ctx['gy'])
    contrast = boundary_color_contrast(points, ctx['lab'], ctx['front'])
    x, y, w, h = ctx['roi']
    xs = points[:, 0]
    ys = points[:, 1]
    span_x = max(1e-6, float(xs.max() - xs.min()))
    span_y = max(1e-6, float(ys.max() - ys.min()))
    area = 0.5 * abs(float(np.dot(points[:, 0], np.roll(points[:, 1], 1))
                           - np.dot(points[:, 1], np.roll(points[:, 0], 1))))
    roi_area = max(1.0, float(w) * float(h))
    area_ratio = area / roi_area
    area_term = min(1.0, abs(math.log(max(1e-6, area_ratio))))
    d_roi = (abs(xs.min() - x) / max(1.0, w) + abs(xs.max() - (x + w)) / max(1.0, w)
             + abs(ys.min() - y) / max(1.0, h) + abs(ys.max() - (y + h)) / max(1.0, h)) / 4.0
    penetration = 0.0
    children = ctx.get('children') or []
    if children:
        samples = sample_polygon(points, spacing=3.0)
        if len(samples):
            hits = np.zeros(len(samples), bool)
            sx = samples[:, 0]
            sy = samples[:, 1]
            for bx0, by0, bx1, by1 in children:
                hits |= (sx >= bx0 - 1) & (sx <= bx1 + 1) & (sy >= by0 - 1) & (sy <= by1 + 1)
            penetration = float(hits.mean())
    parts = {'edge': round(edge_support, 4), 'orient': round(oriented, 4),
             'contrast': round(contrast, 4), 'p95': round(p95, 3),
             'roi': round(d_roi, 4), 'area': round(area_term, 4),
             'penetration': round(penetration, 4)}
    cost = (PANEL_OPT_WEIGHTS['edge'] * (1.0 - edge_support)
            + PANEL_OPT_WEIGHTS['orient'] * (1.0 - oriented)
            + PANEL_OPT_WEIGHTS['contrast'] * (1.0 - contrast)
            + PANEL_OPT_WEIGHTS['p95'] * min(1.0, p95 / 6.0)
            + PANEL_OPT_WEIGHTS['area'] * area_term
            + PANEL_OPT_WEIGHTS['guide'] * d_roi
            + PANEL_OPT_WEIGHTS['penetration'] * max(0.0, penetration - 0.02))
    # area / aspect priors (task-level guard rails against engulfing neighbours)
    if abs(math.log(max(1e-6, area_ratio))) > 0.7:
        cost += 0.5 * (abs(math.log(max(1e-6, area_ratio))) - 0.7)
    aspect_roi = float(w) / max(1e-6, float(h))
    aspect = span_x / max(1e-6, span_y)
    deviation = abs(math.log(max(1e-6, aspect / max(1e-6, aspect_roi))))
    if deviation > math.log(1.6):
        cost += 0.5 * (deviation - math.log(1.6))
    return float(cost), parts


def _panel_evaluate(rect, radius_px, corners, short, ctx):
    specs = corners if corners is not None else uniform_corner_specs(radius_px, short)
    points = panel_polygon(rect, specs)
    metrics = boundary_metrics(points, ctx['dist'], ctx['front'])
    cost, parts = panel_cost_parts(points, metrics, ctx)
    # radius prior (declared adj): keeps the search from inflating corners just to drop
    # boundary p95 near corner samples that sit on no edge at all.
    prior = float(ctx.get('prior') or 0.0)
    cost += 0.03 * abs(float(radius_px) - prior) / max(1.0, short)
    return {'rect': [float(v) for v in rect], 'radius': float(radius_px), 'corners': specs,
            'points': points, 'metrics': metrics, 'cost': cost, 'parts': parts}


def _panel_clamp_rect(candidate, box):
    x, y, w, h = [float(v) for v in box]
    tol_x = max(3.0, min(0.08 * w, 12.0))
    tol_y = max(3.0, min(0.08 * h, 12.0))
    left, top, right, bottom = [float(v) for v in candidate]
    if right - left < max(8.0, w * 0.35) or bottom - top < max(8.0, h * 0.35):
        return None
    if not (x - tol_x - 1e-6 <= left <= x + tol_x + 1e-6):
        return None
    if not (x + w - tol_x - 1e-6 <= right <= x + w + tol_x + 1e-6):
        return None
    if not (y - tol_y - 1e-6 <= top <= y + tol_y + 1e-6):
        return None
    if not (y + h - tol_y - 1e-6 <= bottom <= y + h + tol_y + 1e-6):
        return None
    return [left, top, right, bottom]


def optimize_panel(e, box, ctx, model, declared_round=False):
    """Coordinate descent over four edge positions + corner radius, ROI-anchored."""
    x, y, w, h = [float(v) for v in box]
    short = max(1.0, min(w, h))
    rect = [x, y, x + w, y + h]
    prior = panel_prior_radius(e, box, model)
    ctx['prior'] = prior
    # rounded panels: the declared adj is the design truth, so the search may not inflate the
    # radius far beyond it (otherwise corner pixels without edge evidence get "rounded away").
    if model == 'ROUND-RECT':
        radius_cap = min(short * 0.5, max(prior * 2.5 + 4.0, short * 0.22))
    else:
        radius_cap = short * 0.5
    best = _panel_evaluate(rect, prior, None, short, ctx)
    if model in ('ROUND-RECT', 'BUBBLE'):
        if model == 'BUBBLE':
            grid = np.arange(2.0, radius_cap + 0.01, max(1.0, short * 0.06))
        else:
            grid = np.arange(2.0, radius_cap + 0.01, max(1.0, short * 0.045))
            grid = np.unique(np.concatenate([[0.0], grid, [prior]]))
        for radius_px in grid:
            trial = _panel_evaluate(rect, float(radius_px), None, short, ctx)
            if trial['cost'] < best['cost'] - 1e-5:
                best = trial
        if best['radius'] > 0.5:
            for radius_px in np.arange(max(0.0, best['radius'] - 3.0),
                                       min(radius_cap, best['radius'] + 3.0) + 0.01, 0.5):
                trial = _panel_evaluate(rect, float(radius_px), None, short, ctx)
                if trial['cost'] < best['cost'] - 1e-5:
                    best = trial
    # two rounds of per-edge coordinate descent (1px steps inside the per-side tolerance)
    for round_index in range(2):
        offsets = np.arange(-2.0, 2.01, 1.0) if round_index else np.arange(-12.0, 12.01, 1.0)
        moved = False
        for side in range(4):
            local_best = best
            for offset in offsets:
                candidate = list(best['rect'])
                candidate[side] += float(offset)
                clamped = _panel_clamp_rect(candidate, box)
                if clamped is None:
                    continue
                trial = _panel_evaluate(clamped, best['radius'], None, short, ctx)
                if trial['cost'] < local_best['cost'] - 1e-5:
                    local_best = trial
            if local_best is not best:
                moved = True
            best = local_best
        if not moved:
            break
    # per-corner radius refinement for ROUND-RECT (independent radii are allowed there)
    if model == 'ROUND-RECT' and best['radius'] >= 0.5:
        radius_grid = np.arange(0.0, radius_cap + 0.51, max(1.5, min(radius_cap, short * 0.5) * 0.2))
        for corner_index in range(4):
            local_best = best
            for radius_px in radius_grid:
                specs = [dict(corner) for corner in best['corners']]
                specs[corner_index] = uniform_corner_specs(float(radius_px), short)[0]
                trial = _panel_evaluate(best['rect'], best['radius'], specs, short, ctx)
                if trial['cost'] < local_best['cost'] - 1e-5:
                    local_best = trial
            best = local_best
    return best


def panel_lane_candidate(e, box, ctx, model, declared_round=False):
    """Run the optimizer and map the result to a native-family candidate."""
    short = max(1.0, min(float(box[2]), float(box[3])))
    result = optimize_panel(e, box, ctx, model, declared_round)
    radius_px = 0.0 if model == 'QUAD' else float(result['radius'])
    corners = result['corners']
    points = result['points']
    if model == 'QUAD':
        kind = 'rect-sharp'
    else:
        if model == 'BUBBLE' and radius_px < min(3.0, short * 0.12):
            # a bubble is never sharp: fall back to the declared/20% radius and re-evaluate
            radius_px = min(short * 0.5, max(3.0, short * 0.2))
            corners = uniform_corner_specs(radius_px, short)
            trial = _panel_evaluate(result['rect'], radius_px, corners, short, ctx)
            if trial['cost'] <= result['cost'] + 0.02:
                result = trial
                points = trial['points']
            else:
                radius_px = float(result['radius'])
                corners = result['corners']
                points = result['points']
        if radius_px >= 0.40 * short:
            kind = 'pill'
        elif radius_px >= 2.0:
            kind = 'roundRect'
        else:
            kind = 'rect-sharp'
            radius_px = 0.0
            corners = [{'type': 'sharp'} for _ in range(4)]
            points = panel_polygon(result['rect'], corners)
    native = panel_native_for(kind, box, corners, radius_px)
    return {'kind': kind, 'points': np.asarray(points, float), 'corners': corners,
            'metrics': result['metrics'], 'native': native, 'cost': result['cost'],
            'parts': result['parts'], 'rect': result['rect'], 'radius': radius_px}


def build_seed_round(e, box, model, dist, front):
    """ROI fallback that still follows visible edges: the audit box is first snapped onto
    the nearest edge evidence (refine_quad + sub-pixel side slide), then rounded with the
    declared radius. Weak-border panels keep the ROI, strong-border ones land on the edge."""
    x, y, w, h = [float(v) for v in box]
    base_quad = np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], float)
    base_support = boundary_metrics(base_quad, dist, front)['edgeSupport']
    snapped_quad = refine_quad(base_quad, dist, front)
    slid_quad = refine_quad_offsets_subpixel(snapped_quad, dist, front)
    for candidate_quad in (slid_quad, snapped_quad):
        if candidate_quad is None or not quad_is_sane(candidate_quad, box):
            continue
        candidate_metrics = boundary_metrics(candidate_quad, dist, front)
        if candidate_metrics['edgeSupport'] <= base_support + 0.06:
            continue
        points_min = candidate_quad.min(axis=0)
        points_max = candidate_quad.max(axis=0)
        nx, ny = float(points_min[0]), float(points_min[1])
        nw, nh = float(points_max[0] - points_min[0]), float(points_max[1] - points_min[1])
        if nw >= 8 and nh >= 8:
            x, y, w, h = nx, ny, nw, nh
        break
    short = max(1.0, min(w, h))
    radius_px = 0.0 if model == 'QUAD' else panel_prior_radius(e, box, model)
    if model == 'BUBBLE':
        radius_px = max(radius_px, min(short * 0.5, max(3.0, short * 0.2)))
    corners = uniform_corner_specs(radius_px, short)
    points = panel_polygon([x, y, x + w, y + h], corners)
    metrics = boundary_metrics(points, dist, front)
    if radius_px < 0.75:
        kind = 'seed-sharp'
        native = panel_native_for('rect-sharp', box, corners, 0.0)
    else:
        kind = 'seed-round'
        native = panel_native_for('roundRect', box, corners, radius_px)
    return {'kind': kind, 'points': points.round(3).tolist(), 'metrics': metrics,
            'score': round(family_score(metrics, 1), 4),
            'extra': {'corners': corners, 'native': native, 'from': 'seed-round',
                      'cornerRadius': round(radius_px / short, 4)}}


def panel_accept(lane, champion, box, champion_cost, champion_drift):
    """P0-P2 protection: the lane may only replace the champion when it stays inside the
    audit-box tolerance and clearly improves the joint cost."""
    points = np.asarray(lane['points'], float)
    lo = points.min(axis=0)
    hi = points.max(axis=0)
    x, y, w, h = [float(v) for v in box]
    # ROI is a hint: only reject boxes that leave the page or are absurdly sized.
    if lo[0] < -8 or lo[1] < -8 or hi[0] > WIDTH + 8 or hi[1] > HEIGHT + 8:
        return False, 'p0-page'
    area = 0.5 * abs(float(np.dot(points[:, 0], np.roll(points[:, 1], 1))
                           - np.dot(points[:, 1], np.roll(points[:, 0], 1))))
    ratio = area / max(1.0, w * h)
    if not (0.20 <= ratio <= 3.0):
        return False, 'p0-area'
    kind = str(champion['kind'])
    metrics = champion['metrics']
    lane_p95 = float(lane['metrics']['boundaryP95'])
    champ_p95 = float(metrics['boundaryP95'])
    low_quality = kind in ('seed-box', 'box', 'fill-panel', 'roundPanel', 'seed-round', 'seed-sharp')
    if low_quality or champion_drift > 0.02:
        if lane['cost'] <= champion_cost - 0.005 and lane_p95 <= champ_p95 + 1.0:
            return True, 'p2-drift-fix'
        return False, 'p2-no-gain'
    if champ_p95 <= 3.0 and float(metrics.get('edgeSupport', 0.0)) >= 0.85:
        if lane_p95 <= champ_p95 + 0.5 and lane['cost'] <= champion_cost - 0.02:
            return True, 'p1-high-quality'
        return False, 'p1-protected'
    if lane['cost'] <= champion_cost - 0.005 and lane_p95 <= champ_p95 + 1.0:
        return True, 'p-general'
    return False, 'general-no-gain'


def snap_roi(box, front, edge, dist):
    """Per-side ROI correction before fitting. The audit proposal box is often offset
    (measured median 24/16px on real pages). Each of the four sides is searched
    independently along its own normal; a side is moved only when border evidence
    (edge support + inside/outside Lab contrast + inside colour uniformity) clearly
    improves. This avoids the earlier global-translation trap where a box locked onto
    text/pill edges instead of the real panel border."""
    x, y, w, h = (float(v) for v in box)
    if w < 12.0 or h < 12.0:
        return box, [0.0, 0.0, 0.0, 0.0], 0.0
    lab = get_lab(_REF) if _REF is not None else None
    if lab is None:
        return box, [0.0, 0.0, 0.0, 0.0], 0.0
    limit = min(24.0, max(6.0, 0.08 * max(w, h)))
    offsets = np.arange(-limit, limit + 0.001, 2.0)
    deltas = [0.0, 0.0, 0.0, 0.0]

    def sample_side(side, value):
        if side == 0:  # top
            xs = np.linspace(x + 0.08 * w, x + 0.92 * w, max(10, int(w / 6)))
            pts = np.stack([xs, np.full_like(xs, value)], axis=1)
            inner = np.stack([xs, np.full_like(xs, value + 6.0)], axis=1)
            outer = np.stack([xs, np.full_like(xs, value - 6.0)], axis=1)
        elif side == 1:  # bottom
            xs = np.linspace(x + 0.08 * w, x + 0.92 * w, max(10, int(w / 6)))
            pts = np.stack([xs, np.full_like(xs, value)], axis=1)
            inner = np.stack([xs, np.full_like(xs, value - 6.0)], axis=1)
            outer = np.stack([xs, np.full_like(xs, value + 6.0)], axis=1)
        elif side == 2:  # left
            ys = np.linspace(y + 0.08 * h, y + 0.92 * h, max(10, int(h / 6)))
            pts = np.stack([np.full_like(ys, value), ys], axis=1)
            inner = np.stack([np.full_like(ys, value + 6.0), ys], axis=1)
            outer = np.stack([np.full_like(ys, value - 6.0), ys], axis=1)
        else:  # right
            ys = np.linspace(y + 0.08 * h, y + 0.92 * h, max(10, int(h / 6)))
            pts = np.stack([np.full_like(ys, value), ys], axis=1)
            inner = np.stack([np.full_like(ys, value - 6.0), ys], axis=1)
            outer = np.stack([np.full_like(ys, value + 6.0), ys], axis=1)
        return pts, inner, outer

    def side_score(side, value):
        pts, inner, outer = sample_side(side, value)
        xi = np.clip(np.rint(pts[:, 0]).astype(np.int32), 0, WIDTH - 1)
        yi = np.clip(np.rint(pts[:, 1]).astype(np.int32), 0, HEIGHT - 1)
        visible = ~front[yi, xi]
        if visible.mean() < 0.6:
            return None
        support = float(((dist[yi, xi] <= 2.2) & visible).sum()) / max(1, int(visible.sum()))
        def lab_at(points):
            px = np.clip(np.rint(points[:, 0]).astype(np.int32), 0, WIDTH - 1)
            py = np.clip(np.rint(points[:, 1]).astype(np.int32), 0, HEIGHT - 1)
            return lab[py, px]
        inside_lab = lab_at(inner)
        outside_lab = lab_at(outer)
        contrast = float(np.linalg.norm(inside_lab - outside_lab, axis=1).mean())
        uniformity = float(inside_lab.std(axis=0).mean())
        return (0.55 * support + 0.30 * min(1.0, contrast / 25.0)
                + 0.15 * max(0.0, 1.0 - uniformity / 25.0))

    sides = [(0, y), (1, y + h), (2, x), (3, x + w)]
    for side, current in sides:
        base_score = side_score(side, current)
        if base_score is None:
            continue
        best = (base_score, current)
        for offset in offsets:
            if abs(offset) < 2.5:
                continue
            candidate = current + offset
            if candidate < 2 or candidate > (HEIGHT - 2 if side <= 1 else WIDTH - 2):
                continue
            score = side_score(side, candidate)
            if score is None:
                continue
            if score > best[0] + 0.035:
                best = (score, candidate)
        if best[1] != current:
            delta = float(best[1] - current)
            if abs(delta) <= limit:
                deltas[side] = delta

    nx, ny = x + deltas[2], y + deltas[0]
    nw, nh = w + deltas[3] - deltas[2], h + deltas[1] - deltas[0]
    if nw < 8 or nh < 8:
        return box, [0.0, 0.0, 0.0, 0.0], 0.0
    area_ratio = (nw * nh) / max(1.0, w * h)
    if area_ratio < 0.6 or area_ratio > 1.7:
        return box, [0.0, 0.0, 0.0, 0.0], 0.0
    score = 0.0
    for side, _current in sides:
        s = side_score(side, (ny if side == 0 else ny + nh if side == 1 else nx if side == 2 else nx + nw))
        if s is not None:
            score += s / 4.0
    return (float(nx), float(ny), float(nw), float(nh)), deltas, float(round(score, 4))


PANEL_PROFILE = {
    'QUAD': {'search': 14.0, 'confidence': 0.55},
    'ROUND-RECT': {'search': 14.0, 'confidence': 0.55},
    'BUBBLE': {'search': 8.0, 'confidence': 0.70},
}


def _hex_rgb(value):
    try:
        text = str(value or '').strip().lstrip('#')
        if len(text) == 3:
            text = ''.join(ch * 2 for ch in text)
        if len(text) != 6:
            return None
        return np.array([int(text[i:i + 2], 16) for i in (0, 2, 4)], np.uint8)
    except Exception:
        return None


def scanline_capsule_box(e, box):
    """Locate a stroked capsule by scanlines: two dominant horizontal stroke rows give the
    top/bottom; the tall vertical stroke columns give the caps. Robust when the outline is
    cut into pieces by an overlapping hexagon or underline (connected components fail)."""
    if _REF is None:
        return None
    stroke_width = float(e.get('strokeWidth') or 0)
    rgb = _hex_rgb(e.get('color')) if stroke_width >= 0.8 else None
    if rgb is None:
        return None
    lab = get_lab(_REF)
    x, y, w, h = [float(v) for v in box]
    if w < 12 or h < 10:
        return None
    pad_x = max(60.0, 0.55 * w)
    pad_y = max(40.0, 0.65 * h)
    x0 = max(0, int(x - pad_x)); y0 = max(0, int(y - pad_y))
    x1 = min(WIDTH, int(math.ceil(x + w + pad_x))); y1 = min(HEIGHT, int(math.ceil(y + h + pad_y)))
    if x1 - x0 < 16 or y1 - y0 < 12:
        return None
    patch = lab[y0:y1, x0:x1].astype(np.float32)
    target = cv2.cvtColor(rgb.reshape(1, 1, 3), cv2.COLOR_RGB2LAB)[0, 0].astype(np.float32)
    delta = np.linalg.norm(patch - target.reshape(1, 1, 3), axis=2)
    mask = (delta < 28.0).astype(np.uint8)
    rows = mask.sum(axis=1)
    peak = int(rows.max())
    if peak < max(8, 0.22 * w):
        return None
    strong_rows = np.where(rows > max(4, 0.30 * peak))[0]
    bands = []
    start = prev = int(strong_rows[0])
    for row in strong_rows[1:]:
        row = int(row)
        if row - prev <= 3:
            prev = row
            continue
        bands.append((start, prev)); start = prev = row
    bands.append((start, prev))
    if len(bands) < 2:
        return None
    top_band, bottom_band = bands[0], bands[-1]
    top = y0 + int(round((top_band[0] + top_band[1]) / 2.0))
    bottom = y0 + int(round((bottom_band[0] + bottom_band[1]) / 2.0))
    if bottom - top < 8:
        return None
    band = mask[top_band[0]:bottom_band[1] + 1, :]
    column_extent = band.sum(axis=0)
    span = bottom_band[1] - top_band[0] + 1
    strong_columns = np.where(column_extent > 0.35 * span)[0]
    if len(strong_columns) == 0:
        return None
    right = x0 + int(strong_columns.max())
    expected_width = w * max(0.5, min(2.0, (bottom - top) / max(1.0, h)))
    left_limit = right - int(expected_width * 2.4)
    left_candidates = strong_columns[strong_columns + x0 <= right - int(expected_width * 0.45)]
    if len(left_candidates):
        left = x0 + int(left_candidates.min())
        if 0.35 * expected_width <= right - left <= 1.35 * expected_width:
            pass
        else:
            left = right - int(expected_width)
    else:
        # the left cap is occluded: keep a conservative (wider) estimate incl. the cap
        left = right - int(expected_width)
    # conservative padding: prefer including a little extra over cutting the real edge
    left -= 4; right += 4; top -= 3; bottom += 3
    left = max(0, left); top = max(0, top); right = min(WIDTH, right); bottom = min(HEIGHT, bottom)
    width, height = right - left, bottom - top
    if width < 10 or height < 8:
        return None
    ratio_w = width / max(1.0, w); ratio_h = height / max(1.0, h)
    if not (0.40 <= ratio_w <= 2.60 and 0.45 <= ratio_h <= 2.20):
        return None
    return (float(left), float(top), float(width), float(height))


def relocate_box(e, ref):
    """ROI re-localization (pre-fit). Audit boxes are LLM-estimated: sizes are roughly
    right but positions can be 30-170px off. Search a wide window for the element's own
    colour evidence (declared stroke colour, saturated fill, or ROI interior colour),
    require the component size to match the estimate, and return its bbox as the true
    position. Only audit-origin elements are relocated (carriers/derived shapes are not).
    """
    box = box_of(e)
    if ref is None or not e.get('_fromAudit'):
        return box, None
    x, y, w, h = [float(v) for v in box]
    if w < 8 or h < 8:
        return box, None
    lab = get_lab(ref)
    targets = []
    stroke_width = float(e.get('strokeWidth') or 0)
    stroke_hex = e.get('color') if stroke_width >= 0.8 else None
    fill_hex = e.get('fill') if e.get('fill') not in (None, '', 'none') else None
    for hex_value, kind in ((stroke_hex, 'stroke'), (fill_hex, 'fill')):
        rgb = _hex_rgb(hex_value)
        if rgb is None:
            continue
        lab_target = cv2.cvtColor(rgb.reshape(1, 1, 3), cv2.COLOR_RGB2LAB)[0, 0].astype(np.float32)
        if kind == 'fill':
            chroma = math.hypot(float(lab_target[1]) - 128.0, float(lab_target[2]) - 128.0)
            if chroma < 24.0:
                continue  # light fills merge into the page background: not a safe locator
        targets.append((lab_target, kind))
    gradient = e.get('gradient') if isinstance(e.get('gradient'), dict) else None
    stop_colors = [stop.get('color') for stop in (gradient or {}).get('stops', []) if isinstance(stop, dict)]
    for hex_value in stop_colors:
        rgb = _hex_rgb(hex_value)
        if rgb is None:
            continue
        lab_target = cv2.cvtColor(rgb.reshape(1, 1, 3), cv2.COLOR_RGB2LAB)[0, 0].astype(np.float32)
        chroma = math.hypot(float(lab_target[1]) - 128.0, float(lab_target[2]) - 128.0)
        if chroma < 18.0:
            continue
        targets.append((lab_target, 'fill'))
    if not targets:
        cx0, cy0 = int(x + 0.2 * w), int(y + 0.2 * h)
        cx1, cy1 = int(x + 0.8 * w), int(y + 0.8 * h)
        if cx1 > cx0 and cy1 > cy0:
            interior = lab[cy0:cy1, cx0:cx1].reshape(-1, 3).astype(np.float32)
            targets.append((np.median(interior, axis=0), 'interior'))
    if not targets:
        return box, None
    win_x = max(60.0, min(0.26 * WIDTH, 0.30 * max(w, 0.5 * WIDTH)))
    win_y = max(40.0, min(0.22 * HEIGHT, 0.30 * max(h, 0.3 * HEIGHT)))
    x0 = max(0, int(x - win_x)); y0 = max(0, int(y - win_y))
    x1 = min(WIDTH, int(math.ceil(x + w + win_x))); y1 = min(HEIGHT, int(math.ceil(y + h + win_y)))
    if x1 - x0 < 16 or y1 - y0 < 16:
        return box, None
    patch = lab[y0:y1, x0:x1].astype(np.float32)
    expected_area = max(1.0, w * h)
    roi_center = np.array([x + w / 2.0, y + h / 2.0])

    def component_score(bx, by, bw, bh):
        ratio_w = bw / max(1.0, w)
        ratio_h = bh / max(1.0, h)
        if not (0.60 <= ratio_w <= 1.75 and 0.55 <= ratio_h <= 1.90):
            return None, None
        area_ratio = (bw * bh) / expected_area
        if not (0.40 <= area_ratio <= 2.10):
            return None, None
        centre = np.array([bx + bw / 2.0, by + bh / 2.0])
        distance = float(np.linalg.norm(centre - roi_center)) / max(1.0, max(WIDTH, HEIGHT))
        shape_penalty = abs(math.log(ratio_w)) + abs(math.log(ratio_h))
        return 1.7 - 2.4 * shape_penalty - 1.4 * distance, {'deltas': None}

    best = None
    for target, kind in targets:
        delta = np.linalg.norm(patch - target.reshape(1, 1, 3), axis=2)
        threshold = 28.0 if kind == 'stroke' else 30.0
        # capsule outlines often break into pieces when a hexagon/underline overlaps
        # them: try progressively stronger closing so the full outline becomes one blob
        for kernel in (5, 9, 13):
            mask = (delta < threshold).astype(np.uint8)
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((kernel, kernel), np.uint8))
            count, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, 8)
            boxes = []
            for component in range(1, count):
                area_px = int(stats[component, cv2.CC_STAT_AREA])
                if area_px < max(50, expected_area * 0.03):
                    continue
                bx = x0 + int(stats[component, cv2.CC_STAT_LEFT])
                by = y0 + int(stats[component, cv2.CC_STAT_TOP])
                bw = int(stats[component, cv2.CC_STAT_WIDTH])
                bh = int(stats[component, cv2.CC_STAT_HEIGHT])
                if bw < 8 or bh < 8:
                    continue
                boxes.append((bx, by, bw, bh))
                score, _info = component_score(bx, by, bw, bh)
                if score is not None and (best is None or score > best[0]):
                    best = (score, bx, by, bw, bh, kind)
            near = [box for box in boxes
                    if abs((box[0] + box[2] / 2.0) - roi_center[0]) <= max(1.15 * w, 70.0)
                    and abs((box[1] + box[3] / 2.0) - roi_center[1]) <= max(1.15 * h, 50.0)]
            if len(near) > 1:
                # union of pieces whose union size matches the estimate better than parts;
                # the union must not swallow the neighbouring row/column of the same style
                ux0 = min(box[0] for box in near); uy0 = min(box[1] for box in near)
                ux1 = max(box[0] + box[2] for box in near); uy1 = max(box[1] + box[3] for box in near)
                union_w, union_h = ux1 - ux0, uy1 - uy0
                if union_w <= 1.45 * w and union_h <= 1.35 * h:
                    score, _info = component_score(ux0, uy0, union_w, union_h)
                    if score is not None and (best is None or score > best[0]):
                        best = (score, ux0, uy0, union_w, union_h, kind)
    if best is None or best[0] < 0.35:
        return box, None
    _score, bx, by, bw, bh, kind = best
    deltas = [by - y, (by + bh) - (y + h), bx - x, (bx + bw) - (x + w)]
    if max(abs(v) for v in deltas) > max(80.0, 0.24 * max(WIDTH, HEIGHT)):
        return box, None
    return (float(bx), float(by), float(bw), float(bh)), {'source': kind, 'deltas': [round(v, 1) for v in deltas]}


def fill_mask_box(e, box, pad=36.0):
    """Recover the real element box from its own colour region, robust to a badly offset
    audit ROI.

    - target colour: median of the coloured interior pixels (white text glyphs / light
      background do not drag the median); falls back to the declared fill only as a hint;
    - connected components: pick the component nearest to the ROI centre (not the largest,
      so another same-coloured heading is not stolen);
    - if the ROI is so far off that no component matches, retry with a larger search pad.
    """
    if _REF is None:
        return box, [0.0, 0.0, 0.0, 0.0]
    lab = get_lab(_REF)
    x, y, w, h = [float(v) for v in box]
    if w < 8.0 or h < 8.0:
        return box, [0.0, 0.0, 0.0, 0.0]
    declared_rgb = _hex_rgb(e.get('fill') if e.get('fill') not in (None, '', 'none') else e.get('color'))
    declared_lab = None
    if declared_rgb is not None:
        declared_lab = cv2.cvtColor(declared_rgb.reshape(1, 1, 3), cv2.COLOR_RGB2LAB)[0, 0].astype(np.float32)

    def attempt(search_pad):
        x0 = max(0, int(x - search_pad))
        y0 = max(0, int(y - search_pad))
        x1 = min(WIDTH, int(math.ceil(x + w + search_pad)))
        y1 = min(HEIGHT, int(math.ceil(y + h + search_pad)))
        if x1 - x0 < 12 or y1 - y0 < 12:
            return None
        patch = lab[y0:y1, x0:x1]
        ix0 = max(0, int(x + 0.15 * w) - x0)
        iy0 = max(0, int(y + 0.15 * h) - y0)
        ix1 = min(patch.shape[1], int(x + 0.85 * w) - x0)
        iy1 = min(patch.shape[0], int(y + 0.85 * h) - y0)
        if ix1 - ix0 < 4 or iy1 - iy0 < 4:
            return None
        interior = patch[iy0:iy1, ix0:ix1].reshape(-1, 3).astype(np.float32)
        chroma = np.sqrt(np.square(interior[:, 1] - 128.0) + np.square(interior[:, 2] - 128.0))
        coloured = interior[chroma >= 45.0]
        # only saturated solid fills carry a reliable colour region; light plates/cards are
        # left to the colour-profile / edge lanes (otherwise a retry can grab the page bg)
        if len(coloured) < max(12, int(len(interior) * 0.15)):
            return None
        target = np.median(coloured, axis=0)
        if declared_lab is not None and float(np.linalg.norm(declared_lab - target)) <= 26.0:
            target = (target + declared_lab) / 2.0
        ring = np.concatenate([patch[0, :, :].reshape(-1, 3), patch[-1, :, :].reshape(-1, 3),
                               patch[:, 0, :].reshape(-1, 3), patch[:, -1, :].reshape(-1, 3)]).astype(np.float32)
        ring_median = np.median(ring, axis=0)
        if float(np.linalg.norm(ring_median - target)) < 9.0:
            return None
        delta = np.linalg.norm(patch.astype(np.float32) - target.reshape(1, 1, 3), axis=2)
        mask = (delta < 24.0).astype(np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        count, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, 8)
        if count <= 1:
            return None
        roi_center = np.array([x + w / 2.0, y + h / 2.0])
        best = None
        for component in range(1, count):
            area_px = int(stats[component, cv2.CC_STAT_AREA])
            if area_px < max(90, int(w * h * 0.15)):
                continue
            bx = x0 + int(stats[component, cv2.CC_STAT_LEFT])
            by = y0 + int(stats[component, cv2.CC_STAT_TOP])
            bw = int(stats[component, cv2.CC_STAT_WIDTH])
            bh = int(stats[component, cv2.CC_STAT_HEIGHT])
            if bw < 8 or bh < 8:
                continue
            ratio = (bw * bh) / max(1.0, w * h)
            if ratio < 0.25 or ratio > 3.0:
                continue
            centre = np.array([bx + bw / 2.0, by + bh / 2.0])
            distance = float(np.linalg.norm(centre - roi_center))
            if distance > max(w, h) * 1.6:
                continue
            score = area_px / (1.0 + distance / max(8.0, min(w, h) * 0.5))
            if best is None or score > best[0]:
                best = (score, bx, by, bw, bh)
        if best is None:
            return None
        _score, bx, by, bw, bh = best
        deltas = [by - y, (by + bh) - (y + h), bx - x, (bx + bw) - (x + w)]
        if max(abs(d) for d in deltas) > 60.0:
            return None
        return (float(bx), float(by), float(bw), float(bh)), [float(round(d, 2)) for d in deltas]

    for search_pad in (pad, pad * 1.6, pad * 2.4):
        result = attempt(search_pad)
        if result is not None:
            return result
    return box, [0.0, 0.0, 0.0, 0.0]


def profile_side_box(box, front, model):
    """Locate the four sides of a panel by the dominant colour step along each side.

    The old fitting could "skip the bottom edge and grab another element's edge" because a
    line/caption below the panel is long and strong. Here each side is voted on by many
    independent samples; the median of their best step positions wins, so a minority of
    text/caption edges cannot move the whole side."""
    spec = PANEL_PROFILE.get(model)
    if spec is None:
        return box, [0.0, 0.0, 0.0, 0.0], 0.0
    lab = get_lab(_REF) if _REF is not None else None
    if lab is None:
        return box, [0.0, 0.0, 0.0, 0.0], 0.0
    x, y, w, h = [float(v) for v in box]
    if w < 16.0 or h < 16.0:
        return box, [0.0, 0.0, 0.0, 0.0], 0.0
    search = float(spec['search'])
    if max(w, h) < 320.0:
        # small headings/pills: the audit ROI can be 20px off, give the profile more room
        search = max(search, 22.0)
    offsets = np.arange(-search, search + 0.001, 1.0)
    deltas = [0.0, 0.0, 0.0, 0.0]
    confidences = []

    def lab_at(px, py):
        xi = np.clip(np.rint(px).astype(np.int32), 0, WIDTH - 1)
        yi = np.clip(np.rint(py).astype(np.int32), 0, HEIGHT - 1)
        # the reference image is the final composite: for locating a heading/pill border we
        # must sample its own painted pixels even when a later sibling box covers the area
        # (the front mask is only for line evidence, not for colour profiles)
        visible = np.ones(xi.shape, bool)
        return lab[yi, xi], visible

    for side in range(4):
        if side == 0:
            along = np.linspace(x + 0.10 * w, x + 0.90 * w, max(12, int(w / 8)))
            base = np.full_like(along, y)
            normal = np.array([0.0, -1.0])
        elif side == 1:
            along = np.linspace(x + 0.10 * w, x + 0.90 * w, max(12, int(w / 8)))
            base = np.full_like(along, y + h)
            normal = np.array([0.0, 1.0])
        elif side == 2:
            along = np.linspace(y + 0.10 * h, y + 0.90 * h, max(12, int(h / 8)))
            base = np.full_like(along, x)
            normal = np.array([-1.0, 0.0])
        else:
            along = np.linspace(y + 0.10 * h, y + 0.90 * h, max(12, int(h / 8)))
            base = np.full_like(along, x + w)
            normal = np.array([1.0, 0.0])
        per_sample = []
        for index in range(len(along)):
            if side <= 1:
                px = np.full_like(offsets, along[index])
                py = base[index] + offsets
            else:
                px = base[index] + offsets
                py = np.full_like(offsets, along[index])
            inside_lab, inside_visible = lab_at(px + normal[0] * 4.0, py + normal[1] * 4.0)
            outside_lab, outside_visible = lab_at(px - normal[0] * 4.0, py - normal[1] * 4.0)
            if inside_visible.mean() < 0.5 or outside_visible.mean() < 0.5:
                continue
            step = np.linalg.norm(inside_lab - outside_lab, axis=1)
            best_index = int(np.argmax(step))
            if float(step[best_index]) < 9.0:
                continue
            per_sample.append(float(offsets[best_index]))
        if len(per_sample) < max(6, int(len(along) * 0.4)):
            continue
        values = np.asarray(per_sample)
        median = float(np.median(values))
        confidence = float((np.abs(values - median) <= 2.5).mean())
        confidences.append(confidence)
        if confidence >= spec['confidence']:
            deltas[side] = median

    nx, ny = x + deltas[2], y + deltas[0]
    nw, nh = w + deltas[3] - deltas[2], h + deltas[1] - deltas[0]
    if nw < 12.0 or nh < 12.0:
        return box, [0.0, 0.0, 0.0, 0.0], 0.0

    def side_mean_step(side, current):
        if side == 0:
            along = np.linspace(x + 0.10 * w, x + 0.90 * w, max(12, int(w / 8)))
            px, py = along, np.full_like(along, current)
            normal = np.array([0.0, -1.0])
        elif side == 1:
            along = np.linspace(x + 0.10 * w, x + 0.90 * w, max(12, int(w / 8)))
            px, py = along, np.full_like(along, current)
            normal = np.array([0.0, 1.0])
        elif side == 2:
            along = np.linspace(y + 0.10 * h, y + 0.90 * h, max(12, int(h / 8)))
            px, py = np.full_like(along, current), along
            normal = np.array([-1.0, 0.0])
        else:
            along = np.linspace(y + 0.10 * h, y + 0.90 * h, max(12, int(h / 8)))
            px, py = np.full_like(along, current), along
            normal = np.array([1.0, 0.0])
        inside, iv = lab_at(px + normal[0] * 4.0, py + normal[1] * 4.0)
        outside, ov = lab_at(px - normal[0] * 4.0, py - normal[1] * 4.0)
        valid = iv & ov
        if valid.sum() < 6:
            return None
        return float(np.linalg.norm(inside[valid] - outside[valid], axis=1).mean())

    base_scores = [side_mean_step(side, value) for side, value in
                   ((0, y), (1, y + h), (2, x), (3, x + w))]
    new_scores = [side_mean_step(side, value) for side, value in
                  ((0, ny), (1, ny + nh), (2, nx), (3, nx + nw))]
    base_valid = [v for v in base_scores if v is not None]
    new_valid = [v for v in new_scores if v is not None]
    if not base_valid or not new_valid:
        return box, [0.0, 0.0, 0.0, 0.0], 0.0
    if float(np.mean(new_valid)) < float(np.mean(base_valid)) * 1.02:
        return box, [0.0, 0.0, 0.0, 0.0], 0.0
    if (nw * nh) / max(1.0, w * h) < 0.6 or (nw * nh) / max(1.0, w * h) > 1.7:
        return box, [0.0, 0.0, 0.0, 0.0], 0.0
    mean_confidence = float(np.mean(confidences)) if confidences else 0.0
    if not any(abs(delta) >= 2.5 for delta in deltas):
        return box, [0.0, 0.0, 0.0, 0.0], mean_confidence
    return (float(nx), float(ny), float(nw), float(nh)), deltas, mean_confidence



def _element_lab_targets(e):
    lab_targets = []
    values = []
    if e.get('fill') not in (None, '', 'none'):
        values.append(e.get('fill'))
    gradient = e.get('gradient') if isinstance(e.get('gradient'), dict) else None
    values += [stop.get('color') for stop in (gradient or {}).get('stops', []) if isinstance(stop, dict)]
    for hex_value in values:
        rgb = _hex_rgb(hex_value)
        if rgb is None:
            continue
        lab_targets.append(cv2.cvtColor(rgb.reshape(1, 1, 3), cv2.COLOR_RGB2LAB)[0, 0].astype(np.float32))
    return lab_targets


def template_relocate_box(e, box):
    """Locate one element inside a composite group by matching the declared native template.

    Returns (box, info) or (box, None) when no confident match.
    """
    if _REF is None:
        return box, None
    x, y, w, h = [float(v) for v in box]
    targets = _element_lab_targets(e)
    if not targets or w < 12 or h < 12:
        return box, None
    lab = get_lab(_REF)
    shape = str(e.get('shape') or e.get('classHint') or '').lower()
    names = [shape] if shape in ('hexagon', 'chevron', 'trapezoid', 'rightarrow', 'triangle') else ['hexagon']
    pad = max(240.0, 1.1 * max(w, h))  # audit boxes can be 150-250px off inside a composite row
    x0 = max(0, int(x - pad)); y0 = max(0, int(y - pad))
    x1 = min(WIDTH, int(math.ceil(x + w + pad))); y1 = min(HEIGHT, int(math.ceil(y + h + pad)))
    if x1 - x0 < 24 or y1 - y0 < 24:
        return box, None
    patch = lab[y0:y1, x0:x1].astype(np.float32)
    distance = np.full(patch.shape[:2], 1e9, np.float32)
    for target in targets:
        distance = np.minimum(distance, np.linalg.norm(patch - target.reshape(1, 1, 3), axis=2))
    similarity = np.exp(-distance / 16.0).astype(np.float32)
    color_edge, color_dist = color_edge_maps(_REF, np.zeros((HEIGHT, WIDTH), bool), threshold=5.0)
    if color_dist is None:
        return box, None
    zero_mask = np.zeros((HEIGHT, WIDTH), bool)
    canny_edge, canny_dist = edge_maps(_REF, zero_mask)
    edge_patch = color_dist[y0:y1, x0:x1].astype(np.float32)
    canny_patch = canny_dist[y0:y1, x0:x1].astype(np.float32)
    best = None
    for name in names:
        depths = (0.12, 0.18, 0.24, 0.30, 0.36) if name == 'hexagon' else (0.18, 0.26)
        for depth in depths:
            for scale in (0.78, 0.88, 0.96, 1.0, 1.06, 1.16, 1.28):
                tw = int(round(w * scale)); th = int(round(h * scale))
                if tw > patch.shape[1] or th > patch.shape[0] or tw < 12 or th < 12:
                    continue
                points = prototype_polygon(name, (0, 0, tw, th),
                                           {'headDepth': depth, 'notchDepth': depth})
                if points is None:
                    continue
                mask = np.zeros((th, tw), np.uint8)
                cv2.fillPoly(mask, [np.rint(points).astype(np.int32)], 1)
                area = float(mask.sum())
                if area < 200:
                    continue
                template = mask.astype(np.float32)
                try:
                    result = cv2.matchTemplate(similarity, template, cv2.TM_CCORR_NORMED, mask=template)
                except cv2.error:
                    continue
                result = np.nan_to_num(result, nan=-1.0, posinf=-1.0, neginf=-1.0)
                for _ in range(3):
                    _min, max_value, _minloc, maxloc = cv2.minMaxLoc(result)
                    if max_value <= 0:
                        break
                    bx = x0 + maxloc[0]; by = y0 + maxloc[1]
                    result[maxloc[1], maxloc[0]] = -1.0
                    boundary = points[:, :]
                    samples = []
                    for index in range(len(boundary)):
                        a = boundary[index]; b = boundary[(index + 1) % len(boundary)]
                        for step in range(6):
                            f = step / 6.0
                            sx = int(round(bx + a[0] + (b[0] - a[0]) * f))
                            sy = int(round(by + a[1] + (b[1] - a[1]) * f))
                            if 0 <= sx < patch.shape[1] and 0 <= sy < patch.shape[0]:
                                samples.append(edge_patch[sy, sx])
                    if not samples:
                        continue
                    samples = np.asarray(samples, np.float32)
                    support = float((samples <= 1.5).mean())
                    chamfer = float(np.clip(samples, 0, 40).mean())
                    canny_samples = []
                    for index in range(len(boundary)):
                        a = boundary[index]; b = boundary[(index + 1) % len(boundary)]
                        for step in range(6):
                            f = step / 6.0
                            sx = int(round(bx + a[0] + (b[0] - a[0]) * f))
                            sy = int(round(by + a[1] + (b[1] - a[1]) * f))
                            if 0 <= sx < patch.shape[1] and 0 <= sy < patch.shape[0]:
                                canny_samples.append(canny_patch[sy, sx])
                    canny = np.asarray(canny_samples, np.float32) if canny_samples else np.asarray([40.0], np.float32)
                    canny_support = float((canny <= 2.0).mean())
                    canny_chamfer = float(np.clip(canny, 0, 40).mean())
                    ratio_penalty = abs(math.log(max(1e-3, tw / max(1.0, w)))) + abs(math.log(max(1e-3, th / max(1.0, h))))
                    score = (0.40 * float(max_value) + 0.25 * support + 0.25 * canny_support
                             - 0.010 * chamfer - 0.010 * canny_chamfer - 0.20 * ratio_penalty)
                    if (min(support, canny_support) >= 0.22 and score > (best['score'] if best else 0.20)):
                        best = {'score': score, 'box': (float(bx), float(by), float(tw), float(th)),
                                'shape': name, 'depth': depth, 'scale': scale,
                                'support': round(support, 3), 'chamfer': round(chamfer, 2)}
    if best is None:
        return box, None
    bx, by, bw, bh = best['box']
    return (bx, by, bw, bh), {'source': 'template', 'shape': best['shape'],
                             'depth': best['depth'], 'score': round(best['score'], 4),
                             'support': best['support'],
                             'deltas': [round(bx - x, 1), round(by - y, 1),
                                        round((bx + bw) - (x + w), 1), round((by + bh) - (y + h), 1)]}



def _bbox_of_points(points):
    points = np.asarray(points, float)
    if points.ndim != 2 or len(points) < 3:
        return None
    lo = points.min(axis=0); hi = points.max(axis=0)
    if hi[0] - lo[0] < 8 or hi[1] - lo[1] < 8:
        return None
    return [float(lo[0]), float(lo[1]), float(hi[0] - lo[0]), float(hi[1] - lo[1])]


def row_sibling_box(e, elements, box, front):
    """Locate a number frame/badge next to a fitted row sibling (capsule/card)."""
    x, y, w, h = [float(v) for v in box]
    own_center_y = y + h / 2.0
    candidates = []
    for other in elements:
        if other is e or other.get('key') == e.get('key'):
            continue
        sibling = other.get('_fittedBox') or box_of(other)
        ox, oy, ow, oh = [float(v) for v in sibling]
        if ow < 20 or oh < 20:
            continue
        if abs((oy + oh / 2.0) - own_center_y) > 0.35 * max(h, oh):
            continue
        # the frame attaches to this row body; relative order is not trusted (audit boxes drift)
        if abs(ox - x) > 3.0 * max(w, ow):
            continue
        frame_w = max(24.0, 0.95 * oh)
        frame_h = max(24.0, 0.90 * oh)
        frame_x = ox - 0.02 * ow
        frame_y = oy - 0.06 * oh
        candidates.append((frame_x, frame_y, frame_w, frame_h, other))
    if not candidates:
        return box, None
    color_edge, color_dist = color_edge_maps(_REF, front, threshold=5.0)
    if color_dist is None:
        return box, None
    audit_seed = seed_polygon_of(e)
    audit_metrics = boundary_metrics(audit_seed, color_dist, front, edge=color_edge)
    best = None
    for frame_x, frame_y, frame_w, frame_h, sibling in candidates:
        seed = seed_polygon_of({**e, 'x': frame_x, 'y': frame_y, 'w': frame_w, 'h': frame_h})
        metrics = boundary_metrics(seed, color_dist, front, edge=color_edge)
        support = metrics['edgeSupport'] + 0.5 * metrics.get('orientedSupport', metrics['edgeSupport'])
        audit_support = (audit_metrics['edgeSupport']
                         + 0.5 * audit_metrics.get('orientedSupport', audit_metrics['edgeSupport']))
        if support < max(0.32, audit_support + 0.02):
            continue
        if metrics['boundaryP95'] > min(12.0, max(4.5, audit_metrics['boundaryP95'] * 0.85)):
            continue
        score = support - 0.01 * metrics['boundaryP95']
        if best is None or score > best[0]:
            best = (score, (frame_x, frame_y, frame_w, frame_h), sibling.get('key'))
    if best is None:
        return box, None
    bx, by, bw, bh = best[1]
    return (bx, by, bw, bh), {'source': 'row-sibling', 'sibling': best[2],
                             'deltas': [round(bx - x, 1), round(by - y, 1),
                                        round((bx + bw) - (x + w), 1), round((by + bh) - (y + h), 1)]}



def capsule_long_edge_box(e, box, lines, edge, dist, front):
    """Fit a capsule/pill by pairing its two long, parallel edges."""
    ex, ey, ew, eh = [float(v) for v in box]
    if ew < 20 or eh < 10:
        return None
    expected = max(ew, eh)
    long_axis = 'horizontal' if ew >= eh else 'vertical'
    pad_x = 0.45 * ew + 40.0
    pad_y = 0.45 * eh + 40.0
    horizontals = []
    verticals = []
    for line in lines:
        a = np.asarray((line.get('a') if isinstance(line, dict) else line[0]), float)
        b = np.asarray((line.get('b') if isinstance(line, dict) else line[1]), float)
        dx = abs(float(b[0] - a[0])); dy = abs(float(b[1] - a[1]))
        length = math.hypot(dx, dy)
        if length < max(40.0, 0.40 * expected):
            continue
        cx = (a[0] + b[0]) / 2.0; cy = (a[1] + b[1]) / 2.0
        if abs(cx - (ex + ew / 2.0)) > ew / 2.0 + pad_x or abs(cy - (ey + eh / 2.0)) > eh / 2.0 + pad_y:
            continue
        if dy <= max(2.0, 0.03 * length):
            horizontals.append((min(float(a[0]), float(b[0])), max(float(a[0]), float(b[0])), cy))
        elif dx <= max(2.0, 0.03 * length):
            verticals.append((min(float(a[1]), float(b[1])), max(float(a[1]), float(b[1])), cx))
    best = None
    if long_axis == 'horizontal' and len(horizontals) >= 2:
        for index in range(len(horizontals)):
            sx1, ex1, ty = horizontals[index]
            for other in range(len(horizontals)):
                if other == index:
                    continue
                sx2, ex2, by = horizontals[other]
                if by <= ty + 2.0:
                    continue
                gap = by - ty
                if not (0.55 * eh <= gap <= 1.75 * eh):
                    continue
                overlap = min(ex1, ex2) - max(sx1, sx2)
                if overlap < max(0.0, 0.05 * ew):
                    continue
                span = max(ex1, ex2) - min(sx1, sx2)
                if span < 0.30 * ew:
                    continue
                bx = min(sx1, sx2) - gap / 2.0
                bw = span + gap
                bh = gap
                points = panel_polygon([bx, ty, bx + bw, ty + bh],
                                       uniform_corner_specs(gap / 2.0, gap))
                metrics = boundary_metrics(points, dist, front, edge=edge)
                score = (metrics['edgeSupport']
                         + 0.5 * metrics.get('orientedSupport', metrics['edgeSupport'])
                         - 0.004 * metrics['boundaryP95']
                         + 0.35 * (1.0 - min(1.0, abs(bw - ew) / max(1.0, ew))))
                if best is None or score > best[0]:
                    best = (score, (bx, ty, bw, bh), metrics)
    elif long_axis == 'vertical' and len(verticals) >= 2:
        for index in range(len(verticals)):
            sy1, ey1, tx = verticals[index]
            for other in range(len(verticals)):
                if other == index:
                    continue
                sy2, ey2, rx = verticals[other]
                if rx <= tx + 2.0:
                    continue
                gap = rx - tx
                if not (0.55 * ew <= gap <= 1.75 * ew):
                    continue
                overlap = min(ey1, ey2) - max(sy1, sy2)
                if overlap < 0.25 * eh:
                    continue
                span = max(ey1, ey2) - min(sy1, sy2)
                if span < 0.45 * eh:
                    continue
                by = min(sy1, sy2) - gap / 2.0
                bh = span + gap
                bw = gap
                points = panel_polygon([tx, by, tx + bw, by + bh],
                                       uniform_corner_specs(gap / 2.0, gap))
                metrics = boundary_metrics(points, dist, front, edge=edge)
                score = (metrics['edgeSupport']
                         + 0.5 * metrics.get('orientedSupport', metrics['edgeSupport'])
                         - 0.004 * metrics['boundaryP95']
                         + 0.35 * (1.0 - min(1.0, abs(bh - eh) / max(1.0, eh))))
                if best is None or score > best[0]:
                    best = (score, (tx, by, bw, bh), metrics)
    if best is None and long_axis == 'horizontal' and horizontals:
        # Only the top long edge was detected (the opposite edge is frequently a soft/shadowed
        # line that LSD misses). Recover the hidden long edge from the edge map by scanning
        # column profiles across the visible top edge, then complete the capsule.
        ordered = sorted(horizontals, key=lambda run: abs(run[2] - ey))
        for (sx, ex_edge, ty) in ordered:
            if abs(ty - ey) > 0.65 * eh + 24.0:
                continue
            span = ex_edge - sx
            if span < 0.35 * max(ew, eh):
                continue
            x_samples = [int(round(sx + span * f)) for f in np.linspace(0.15, 0.85, 14)]
            y_start = int(ty + 0.45 * eh)
            y_end = int(ty + 1.75 * eh)
            if y_end <= y_start:
                continue
            best_row = None
            for yy in range(max(0, y_start), min(HEIGHT, y_end)):
                count = 0
                for xx in x_samples:
                    if 0 <= xx < WIDTH and edge[yy, xx]:
                        count += 1
                if best_row is None or count > best_row[0]:
                    best_row = (count, yy)
            if best_row is None or best_row[0] < max(3, int(0.30 * len(x_samples))):
                continue
            bottom = float(best_row[1])
            gap = bottom - ty
            if not (0.55 * eh <= gap <= 1.75 * eh):
                continue
            bx = sx - gap / 2.0
            bw = span + gap
            bh = gap
            points = panel_polygon([bx, ty, bx + bw, ty + bh],
                                   uniform_corner_specs(gap / 2.0, gap))
            metrics = boundary_metrics(points, dist, front, edge=edge)
            if metrics['edgeSupport'] >= 0.35 and metrics['boundaryP95'] <= 18.0:
                best = (0.5, (bx, ty, bw, bh), metrics)
                break
    if best is None:
        return None
    score, capsule_box, metrics = best
    if metrics['edgeSupport'] < 0.35 or metrics['boundaryP95'] > 18.0:
        return None
    return capsule_box



def _boundary_samples(points, per_edge=10):
    pts = np.asarray(points, float)
    if pts.ndim != 2 or len(pts) < 3:
        return []
    samples = []
    count = len(pts)
    for edge_index in range(count):
        a = pts[edge_index]
        b = pts[(edge_index + 1) % count]
        for step in range(per_edge):
            f = (step + 0.5) / per_edge
            samples.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
    return samples


def occlusion_boundary_metrics(points, dist, front, edge=None, per_edge=10):
    """Metrics on visible boundary only: occluded samples are unknown, never misses."""
    pts = np.asarray(points, float)
    if pts.ndim != 2 or len(pts) < 3 or dist is None:
        return {'support': 0.0, 'p95': 99.0, 'samples': 0, 'hiddenFraction': 0.0, 'sides': {}}
    count = len(pts)
    sides = {}
    visible_values = []
    hidden_total = 0.0
    for edge_index in range(count):
        hidden = 0
        values = []
        a = pts[edge_index]
        b = pts[(edge_index + 1) % count]
        for step in range(per_edge):
            f = (step + 0.5) / per_edge
            x = a[0] + (b[0] - a[0]) * f
            y = a[1] + (b[1] - a[1]) * f
            xi = min(WIDTH - 1, max(0, int(round(x))))
            yi = min(HEIGHT - 1, max(0, int(round(y))))
            if front is not None and getattr(front, 'size', 0) and front[yi, xi]:
                hidden += 1
                continue
            values.append(float(dist[yi, xi]))
        hidden_share = hidden / float(per_edge)
        hidden_total += hidden_share
        visible_values.extend(values)
        sides[edge_index] = {'hidden': round(hidden_share, 3),
                             'support': round(float(np.mean(np.asarray(values) <= 1.5)), 3) if values else 0.0,
                             'p95': round(float(np.percentile(values, 95)), 2) if values else None}
    values_array = np.asarray(visible_values, np.float32) if visible_values else np.asarray([99.0], np.float32)
    return {'support': float((values_array <= 1.5).mean()),
            'p95': float(np.percentile(values_array, 95)),
            'samples': int(values_array.size),
            'hiddenFraction': round(hidden_total / max(1, count), 3),
            'sides': sides}




def row_search_hexagon_box(e, elements, box, front):
    """Simple hexagon localization: audit already says it is a hexagon, so only the box is
    searched — row-anchored candidate grid + hexagon-template edge support (no colour identity,
    no contour classification)."""
    if _REF is None:
        return box, None
    ax, ay, aw, ah = [float(v) for v in box]
    audit_center_y = ay + ah / 2.0
    sibling = None
    best_delta = 1e9
    for other in elements or []:
        if other is e or other.get('key') == e.get('key'):
            continue
        fitted = other.get('_fittedBox')
        if not fitted:
            continue
        ox, oy, ow, oh = [float(v) for v in fitted]
        if ow < 40 or oh < 20:
            continue
        delta = abs((oy + oh / 2.0) - audit_center_y)
        if delta <= 0.40 * max(ah, oh) and delta < best_delta:
            best_delta = delta
            sibling = (ox, oy, ow, oh)
    if sibling is None:
        return box, None
    ox, oy, ow, oh = sibling
    color_edge, color_dist = color_edge_maps(_REF, front, threshold=5.0)
    if color_dist is None:
        return box, None
    aspect = aw / max(1.0, ah)
    candidates = []
    for h_factor in (0.75, 0.85, 0.95, 1.05, 1.15):
        h_est = max(24.0, h_factor * oh)
        w_est = max(24.0, h_est * (aspect if 0.7 <= aspect <= 1.6 else 1.15))
        for x_factor in (0.75, 0.95, 1.15, 1.35):
            for dy in (-18.0, 0.0, 18.0):
                x0 = ox - h_est * x_factor
                y0 = oy + (oh - h_est) / 2.0 + dy
                if 0 <= x0 and 0 <= y0 and x0 + w_est <= WIDTH and y0 + h_est <= HEIGHT:
                    candidates.append((x0, y0, w_est, h_est))
    # also keep the audit estimate and a few direct shifts
    candidates.append((ax, ay, aw, ah))
    for dx in (-120.0, -60.0, 0.0, 60.0):
        if 0 <= ax + dx and ax + dx + aw <= WIDTH:
            candidates.append((ax + dx, ay, aw, ah))
    best = None
    empty_front = np.zeros((HEIGHT, WIDTH), bool)
    for (x0, y0, w0, h0) in candidates:
        for depth in (0.12, 0.18, 0.24, 0.30, 0.36):
            points = prototype_polygon('hexagon', (x0, y0, w0, h0), {'headDepth': depth})
            if points is None:
                continue
            metrics = boundary_metrics(points, color_dist, empty_front, edge=color_edge)
            support = metrics['edgeSupport'] + 0.5 * metrics.get('orientedSupport', metrics['edgeSupport'])
            score = support - 0.004 * metrics['boundaryP95']
            if best is None or score > best['score']:
                best = {'score': score, 'box': (x0, y0, w0, h0), 'depth': depth,
                        'support': metrics['edgeSupport'], 'p95': metrics['boundaryP95']}
    if best is None or best['support'] < 0.50 or best['p95'] > 6.0:
        return box, None
    x0, y0, w0, h0 = best['box']
    return (x0, y0, w0, h0), {'source': 'row-hex-grid', 'shape': 'hexagon',
                              'depth': best['depth'], 'score': round(best['score'], 4),
                              'deltas': [round(x0 - ax, 1), round(y0 - ay, 1),
                                         round((x0 + w0) - (ax + aw), 1),
                                         round((y0 + h0) - (ay + ah), 1)]}

def row_template_hexagon_box(e, elements, box):
    """Hexagon fitting by row-constrained template match.

    The audit box of a number-frame hexagon can drift >150px, while the fitted capsule row
    next to it is reliable. Constrain the search to that row, match the declared hexagon
    template against the gradient-stop colour map and return the single element's box.
    """
    if _REF is None:
        return box, None
    ax, ay, aw, ah = [float(v) for v in box]
    audit_center_y = ay + ah / 2.0
    sibling = None
    best_delta = 1e9
    for other in elements or []:
        if other is e or other.get('key') == e.get('key'):
            continue
        fitted = other.get('_fittedBox')
        if not fitted:
            continue
        ox, oy, ow, oh = [float(v) for v in fitted]
        if ow < 40 or oh < 20:
            continue
        delta = abs((oy + oh / 2.0) - audit_center_y)
        if delta <= 0.40 * max(ah, oh) and delta < best_delta:
            best_delta = delta
            sibling = (ox, oy, ow, oh)
    if sibling is None:
        return box, None
    ox, oy, ow, oh = sibling
    targets = _element_lab_targets(e)
    if not targets:
        return box, None
    lab = get_lab(_REF)
    h_est = max(24.0, 0.95 * oh)
    w_est = max(24.0, 1.15 * h_est)
    x0 = max(0, int(round(ox - 1.7 * w_est)))
    x1 = min(WIDTH, int(round(ox + 0.9 * w_est)))
    y0 = max(0, int(round(oy - 0.30 * h_est)))
    y1 = min(HEIGHT, int(round(oy + 1.30 * h_est)))
    if x1 - x0 < 30 or y1 - y0 < 20:
        return box, None
    patch = lab[y0:y1, x0:x1].astype(np.float32)
    distance = np.full(patch.shape[:2], 1e9, np.float32)
    for target in targets:
        distance = np.minimum(distance, np.linalg.norm(patch - target.reshape(1, 1, 3), axis=2))
    similarity = np.exp(-distance / 16.0).astype(np.float32)
    color_edge, color_dist = color_edge_maps(_REF, np.zeros((HEIGHT, WIDTH), bool), threshold=5.0)
    if color_dist is None:
        return box, None
    edge_patch = color_dist[y0:y1, x0:x1].astype(np.float32)
    empty_front = np.zeros((HEIGHT, WIDTH), bool)
    best = None
    for scale in (0.82, 0.90, 0.98, 1.06, 1.14):
        for depth in (0.10, 0.15, 0.20, 0.25, 0.30, 0.35):
            tw = int(round(w_est * scale)); th = int(round(h_est * scale))
            if tw > patch.shape[1] or th > patch.shape[0] or tw < 12 or th < 12:
                continue
            points = prototype_polygon('hexagon', (0, 0, tw, th), {'headDepth': depth})
            if points is None:
                continue
            mask = np.zeros((th, tw), np.uint8)
            cv2.fillPoly(mask, [np.rint(points).astype(np.int32)], 1)
            template = mask.astype(np.float32)
            try:
                result = cv2.matchTemplate(similarity, template, cv2.TM_CCORR_NORMED, mask=template)
            except cv2.error:
                continue
            result = np.nan_to_num(result, nan=-1.0, posinf=-1.0, neginf=-1.0)
            for _ in range(3):
                _min, max_value, _minloc, maxloc = cv2.minMaxLoc(result)
                if max_value <= 0:
                    break
                result[maxloc[1], maxloc[0]] = -1.0
                bx = float(x0 + maxloc[0]); by = float(y0 + maxloc[1])
                shifted = points + np.array([bx, by], float)
                metrics = boundary_metrics(shifted, color_dist, empty_front, edge=color_edge)
                score = (0.55 * float(max_value) + 0.45 * metrics['edgeSupport']
                         - 0.012 * metrics['boundaryP95'])
                if best is None or score > best['score']:
                    best = {'score': score, 'box': (bx, by, float(tw), float(th)),
                            'support': metrics['edgeSupport'], 'p95': metrics['boundaryP95'],
                            'depth': depth, 'scale': scale}
    if __import__('os').environ.get('SHAPE_HEXDEBUG') and 'hexagon' in str(e.get('shape') or '').lower():
        print('[hexdebug]', e.get('key'), 'sibling', sibling, 'best', best)
    if best is None or best['support'] < 0.35 or best['p95'] > 10.0:
        return box, None
    bx, by, bw, bh = best['box']
    return (bx, by, bw, bh), {'source': 'row-template', 'shape': 'hexagon',
                              'depth': best['depth'], 'score': round(best['score'], 4),
                              'deltas': [round(bx - ax, 1), round(by - ay, 1),
                                         round((bx + bw) - (ax + aw), 1),
                                         round((by + bh) - (ay + ah), 1)]}



def _line_intersection(a1, b1, a2, b2):
    x1, y1 = a1; x2, y2 = b1; x3, y3 = a2; x4, y4 = b2
    den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(den) < 1e-6:
        return None
    t1 = x1 * y2 - y1 * x2; t2 = x3 * y4 - y3 * x4
    px = (t1 * (x3 - x4) - (x1 - x2) * t2) / den
    py = (t1 * (y3 - y4) - (y1 - y2) * t2) / den
    return np.array([px, py], float)


def _line_angle(line):
    a = np.asarray((line.get('a') if isinstance(line, dict) else line[0]), float)
    b = np.asarray((line.get('b') if isinstance(line, dict) else line[1]), float)
    return math.degrees(math.atan2(float(b[1] - a[1]), float(b[0] - a[0]))), a, b


def _line_span_at(line, y):
    angle, a, b = _line_angle(line)
    if abs(math.sin(math.radians(angle))) < 1e-4:
        return None
    x = a[0] + (y - a[1]) / math.tan(math.radians(angle))
    return float(x)


def capsule_curvature_evidence(points):
    """Capsule vs other: two long straight sides plus long, near-constant-curvature caps.
    Uses curvature variation magnitudes only (no sharp-corner test)."""
    pts = np.asarray(points, float)
    if pts.ndim != 2 or len(pts) < 8:
        return {'capsule': False, 'reason': 'too-few-points'}
    closed = np.vstack([pts, pts[0]])
    seg = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    total = float(seg.sum())
    if total < 40:
        return {'capsule': False, 'reason': 'perimeter-too-small'}
    # resample by arc length
    n = 160
    acc = np.r_[0.0, np.cumsum(seg)]
    samples = np.linspace(0, total, n, endpoint=False)
    resampled = np.zeros((n, 2), float)
    for i, s in enumerate(samples):
        k = int(np.searchsorted(acc, s, side='right') - 1)
        k = max(0, min(len(seg) - 1, k))
        f = (s - acc[k]) / max(1e-6, seg[k])
        resampled[i] = closed[k] + (closed[k + 1] - closed[k]) * f
    tang = np.roll(resampled, -1, axis=0) - np.roll(resampled, 1, axis=0)
    ang = np.arctan2(tang[:, 1], tang[:, 0])
    d_ang = np.diff(np.r_[ang, ang[0]])
    d_ang = (d_ang + np.pi) % (2 * np.pi) - np.pi
    ds = total / n
    curvature = np.abs(d_ang) / ds
    curvature = np.convolve(curvature, np.ones(5) / 5.0, mode='same')
    straight = curvature < 0.004
    arc = curvature >= 0.010
    arc_fraction = float(arc.mean())
    straight_fraction = float(straight.mean())
    # long straight runs (each side)
    runs = []
    start = None
    for i, flag in enumerate(straight):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            runs.append((start, i)); start = None
    if start is not None:
        runs.append((start, len(straight)))
    long_sides = [run for run in runs if (run[1] - run[0]) * ds >= 0.15 * total]
    # arc runs and their curvature constancy
    arc_runs = []
    start = None
    for i, flag in enumerate(arc):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            arc_runs.append((start, i)); start = None
    if start is not None:
        arc_runs.append((start, len(arc)))
    long_arcs = []
    for begin, end in arc_runs:
        indices = np.arange(begin, end) % n
        values = curvature[indices]
        if len(values) < 6:
            continue
        length_ratio = (end - begin) / n
        mean = float(values.mean()); std = float(values.std())
        variation = std / max(1e-6, mean)
        if length_ratio >= 0.08 and variation < 0.55:
            long_arcs.append({'fraction': round(length_ratio, 3), 'radius': round(1.0 / max(1e-6, mean), 2),
                              'variation': round(variation, 3)})
    capsule = (len(long_sides) >= 2 and len(long_arcs) >= 2
               and arc_fraction >= 0.12 and straight_fraction >= 0.25
               and max((arc['variation'] for arc in long_arcs), default=1.0) < 0.55)
    return {'capsule': bool(capsule), 'arcFraction': round(arc_fraction, 3),
            'straightFraction': round(straight_fraction, 3),
            'longSides': [[int(a), int(b)] for a, b in long_sides],
            'longArcs': long_arcs,
            'curvatureVariation': round(float(curvature.std() / max(1e-6, curvature.mean())), 3)}


def hexagon_six_edge_box(e, elements, box, lines, front):
    """Hexagon fitting with six edges: pick 2 near-horizontal + 4 slanted lines, intersect them
    into the six vertices, then read bounds and headDepth directly from the intersections."""
    ax, ay, aw, ah = [float(v) for v in box]
    audit_center_y = ay + ah / 2.0
    sibling = None; best_delta = 1e9
    for other in elements or []:
        if other is e or other.get('key') == e.get('key'):
            continue
        fitted = other.get('_fittedBox')
        if not fitted:
            continue
        ox, oy, ow, oh = [float(v) for v in fitted]
        if ow < 40 or oh < 20:
            continue
        delta = abs((oy + oh / 2.0) - audit_center_y)
        if delta <= 0.40 * max(ah, oh) and delta < best_delta:
            best_delta = delta; sibling = (ox, oy, ow, oh)
    if sibling is not None:
        ox, oy, ow, oh = sibling
        window = (ox - 2.4 * oh, oy - 0.6 * oh, ox + 1.6 * oh, oy + 1.6 * oh)
    else:
        seed_points = image_contour_points(e, box, front)
        if seed_points is not None and len(seed_points) >= 12:
            lo = seed_points.min(axis=0); hi = seed_points.max(axis=0)
            pad = max(30.0, 0.6 * max(float(hi[0] - lo[0]), float(hi[1] - lo[1])))
            window = (float(lo[0]) - pad, float(lo[1]) - pad, float(hi[0]) + pad, float(hi[1]) + pad)
        else:
            window = (ax - 1.5 * aw, ay - 0.6 * ah, ax + 2.5 * aw, ay + 1.6 * ah)
    source_lines = _FIT_LINES or lines
    horizontals = []; slanted = []
    for line in source_lines:
        angle, a, b = _line_angle(line)
        mid = (a + b) / 2.0
        if not (window[0] <= mid[0] <= window[2] and window[1] <= mid[1] <= window[3]):
            continue
        length = float(np.linalg.norm(b - a))
        if length < 11:
            continue
        if abs(angle) <= 4.0:
            horizontals.append((float(mid[1]), a, b, length))
        elif 8.0 <= abs(angle) <= 80.0:
            slanted.append((a, b, length))
    if __import__('os').environ.get('SHAPE_HEXDEBUG'):
        print('[sixedge]', e.get('key'), 'window', [round(v) for v in window], 'H', len(horizontals), 'S', len(slanted))
    if len(horizontals) < 2 or len(slanted) < 4:
        return box, None
    horizontals.sort(key=lambda item: item[0])
    top = None; bottom = None; best_gap_diff = 1e9
    for first in range(len(horizontals)):
        for second in range(first + 1, len(horizontals)):
            gap = horizontals[second][0] - horizontals[first][0]
            if not (0.45 * ah <= gap <= 1.80 * ah):
                continue
            if abs(gap - ah) < best_gap_diff:
                best_gap_diff = abs(gap - ah)
                top = (horizontals[first][0], horizontals[first][1], horizontals[first][2])
                bottom = (horizontals[second][0], horizontals[second][1], horizontals[second][2])
    if top is None:
        return box, None
    top_y = top[0]; bottom_y = bottom[0]
    top_span = sorted([float(top[1][0]), float(top[2][0])])
    bot_span = sorted([float(bottom[1][0]), float(bottom[2][0])])
    center_x = (top_span[0] + top_span[1]) / 2.0
    roles = {'upper-left': None, 'upper-right': None, 'lower-left': None, 'lower-right': None}
    for a, b, length in slanted:
        line = {'a': a, 'b': b}
        xt = _line_span_at(line, top_y); xb = _line_span_at(line, bottom_y)
        if xt is None or xb is None:
            continue
        mid = (a + b) / 2.0
        if top_span[0] - 0.2 * (top_span[1] - top_span[0]) <= xt <= top_span[1] + 0.2 * (top_span[1] - top_span[0]):
            role = 'upper-left' if xt < center_x else 'upper-right'
            if roles[role] is None or length > roles[role][2]:
                roles[role] = (a, b, length)
        if bot_span[0] - 0.2 * (bot_span[1] - bot_span[0]) <= xb <= bot_span[1] + 0.2 * (bot_span[1] - bot_span[0]):
            role = 'lower-left' if xb < center_x else 'lower-right'
            if roles[role] is None or length > roles[role][2]:
                roles[role] = (a, b, length)
    if __import__('os').environ.get('SHAPE_HEXDEBUG'):
        print('[sixedge-roles]', e.get('key'), {k: (v is not None) for k, v in roles.items()}, 'topbottom', (round(top[0]), round(bottom[0])))
    center_x = (top_span[0] + top_span[1]) / 2.0
    for left, right in (('upper-left', 'upper-right'), ('lower-left', 'lower-right')):
        if roles[left] is None and roles[right] is None and False:
            pass
    for left_pair, right_pair in ((('upper-left', 'lower-left'), ('upper-right', 'lower-right')),
                                  (('upper-right', 'lower-right'), ('upper-left', 'lower-left'))):
        if all(roles[name] is None for name in left_pair) and all(roles[name] is not None for name in right_pair):
            for missing_name, source_name in zip(left_pair, right_pair):
                source = roles[source_name]
                a = np.array([2.0 * center_x - float(source[0][0]), float(source[0][1])])
                b = np.array([2.0 * center_x - float(source[1][0]), float(source[1][1])])
                roles[missing_name] = (a, b, float(source[2]))
    missing_roles = [name for name, value in roles.items() if value is None]
    if len(missing_roles) == 1:
        center_x = (top_span[0] + top_span[1]) / 2.0
        mirror = {'upper-left': 'upper-right', 'upper-right': 'upper-left',
                  'lower-left': 'lower-right', 'lower-right': 'lower-left'}[missing_roles[0]]
        source_role = roles.get(mirror)
        if source_role is not None:
            a = np.array([2.0 * center_x - float(source_role[0][0]), float(source_role[0][1])])
            b = np.array([2.0 * center_x - float(source_role[1][0]), float(source_role[1][1])])
            roles[missing_roles[0]] = (a, b, float(source_role[2]))
    if any(value is None for value in roles.values()):
        return box, None
    def as_line(value):
        return {'a': value[0], 'b': value[1]}
    tl = _line_intersection(as_line(roles['upper-left'])['a'], as_line(roles['upper-left'])['b'],
                            top[1], top[2])
    tr = _line_intersection(as_line(roles['upper-right'])['a'], as_line(roles['upper-right'])['b'],
                            top[1], top[2])
    bl = _line_intersection(as_line(roles['lower-left'])['a'], as_line(roles['lower-left'])['b'],
                            bottom[1], bottom[2])
    br = _line_intersection(as_line(roles['lower-right'])['a'], as_line(roles['lower-right'])['b'],
                            bottom[1], bottom[2])
    left_point = _line_intersection(as_line(roles['upper-left'])['a'], as_line(roles['upper-left'])['b'],
                                    as_line(roles['lower-left'])['a'], as_line(roles['lower-left'])['b'])
    right_point = _line_intersection(as_line(roles['upper-right'])['a'], as_line(roles['upper-right'])['b'],
                                     as_line(roles['lower-right'])['a'], as_line(roles['lower-right'])['b'])
    if any(value is None for value in (tl, tr, bl, br, left_point, right_point)):
        return box, None
    width = float(right_point[0] - left_point[0]); height = float(bottom_y - top_y)
    if width < 24 or height < 24:
        return box, None
    head_depth = float((tl[0] - left_point[0]) / max(1e-6, width))
    right_depth = float((right_point[0] - tr[0]) / max(1e-6, width))
    if __import__('os').environ.get('SHAPE_HEXDEBUG'):
        print('[sixedge-geom]', e.get('key'), 'w', round(width,1), 'h', round(height,1), 'left', [round(v,1) for v in left_point], 'right', [round(v,1) for v in right_point], 'd', round(head_depth,3), round(right_depth,3))
    if not (0.04 <= head_depth <= 0.48 and 0.04 <= right_depth <= 0.48):
        return box, None
    if abs(head_depth - right_depth) > 0.12:
        return box, None
    points = [[float(tl[0]), float(tl[1])], [float(tr[0]), float(tr[1])],
              [float(right_point[0]), float(right_point[1])],
              [float(br[0]), float(br[1])], [float(bl[0]), float(bl[1])],
              [float(left_point[0]), float(left_point[1])]]
    e['_hexDepth'] = round((head_depth + right_depth) / 2.0, 4)
    e['_hexPoints'] = points
    return (float(left_point[0]), top_y, width, height), {
        'source': 'hex-six-edge', 'shape': 'hexagon', 'headDepth': e['_hexDepth'],
        'deltas': [round(left_point[0] - ax, 1), round(top_y - ay, 1),
                   round((left_point[0] + width) - (ax + aw), 1),
                   round((top_y + height) - (ay + ah), 1)]}



def four_edge_quad_candidate(e, box, lines, dist, front, elements=None):
    """Four-edge independent fitting: choose the four main long sides from LSD lines, intersect
    them into a quad, and classify rect / parallelogram / trapezoid / generic quad. Corner
    bevels and rounded corners are corner features, not separate sides."""
    ax, ay, aw, ah = [float(v) for v in box]
    pad = max(40.0, 0.55 * max(aw, ah))
    window = (ax - pad, ay - pad, ax + aw + pad, ay + ah + pad)
    horizontals = []
    slanted = []
    for line in (_FIT_LINES or lines):
        angle, a, b = _line_angle(line)
        mid = (a + b) / 2.0
        if not (window[0] <= mid[0] <= window[2] and window[1] <= mid[1] <= window[3]):
            continue
        length = float(np.linalg.norm(b - a))
        if length < 20:
            continue
        if abs(angle) <= 12.0:
            horizontals.append({'y': float(mid[1]), 'a': a, 'b': b, 'length': length})
        elif 12.0 < abs(angle) <= 80.0:
            slanted.append({'x': float(mid[0]), 'a': a, 'b': b, 'length': length,
                            'angle': angle})
    if len(horizontals) < 2:
        return None
    horizontals.sort(key=lambda item: item['y'])
    center_y = ay + ah / 2.0
    above = [item for item in horizontals if item['y'] <= center_y]
    below = [item for item in horizontals if item['y'] > center_y]
    if not above or not below:
        return None
    top = max(above, key=lambda item: item['length'])
    bottom = max(below, key=lambda item: item['length'])
    gap = bottom['y'] - top['y']
    if not (0.45 * ah <= gap <= 1.85 * ah):
        return None
    center_x = ax + aw / 2.0
    lefts = [item for item in slanted if item['x'] < center_x]
    rights = [item for item in slanted if item['x'] >= center_x]
    if not lefts or not rights:
        return None
    left = max(lefts, key=lambda item: item['length'])
    right = max(rights, key=lambda item: item['length'])
    corners = []
    for pair in ((top, left), (top, right), (bottom, right), (bottom, left)):
        point = _line_intersection(pair[0]['a'], pair[0]['b'], pair[1]['a'], pair[1]['b'])
        if point is None:
            return None
        corners.append(point)
    points = np.asarray(corners, float)
    if not (window[0] - 10 <= points[:, 0].min() and points[:, 0].max() <= window[2] + 10
            and window[1] - 10 <= points[:, 1].min() and points[:, 1].max() <= window[3] + 10):
        return None
    # Long-edge continuity gate: every side must be mostly a continuous edge run.
    for i in range(4):
        a_pt = points[i]; b_pt = points[(i + 1) % 4]
        samples = a_pt + (b_pt - a_pt) * np.linspace(0.05, 0.95, 24)[:, None]
        xs = np.clip(np.rint(samples[:, 0]).astype(int), 0, WIDTH - 1)
        ys = np.clip(np.rint(samples[:, 1]).astype(int), 0, HEIGHT - 1)
        near = dist[ys, xs] <= 1.6
        # continuity through known occluders is allowed
        if front is not None:
            hidden = front[ys, xs]
            near = np.logical_or(near, hidden)
        coverage = float(near.mean())
        gaps = 0; run = 0
        for flag in near:
            run = 0 if flag else run + 1
            gaps = max(gaps, run)
        if coverage < 0.55 or gaps > max(4, int(0.12 * len(samples))):
            return None
        # Ownership: a side mostly lying on another registered element's outline is not ours.
        if elements:
            foreign = 0
            for other in elements:
                if other is e or other.get('key') == e.get('key'):
                    continue
                polygon = seed_polygon_of(other)
                if polygon is None or len(polygon) < 3:
                    continue
                contour = np.rint(np.asarray(polygon, float)).astype(np.int32).reshape(-1, 1, 2)
                near_other = 0
                for point in samples:
                    if cv2.pointPolygonTest(contour, (float(point[0]), float(point[1])), True) is not None:
                        distance = cv2.pointPolygonTest(contour, (float(point[0]), float(point[1])), True)
                        if abs(distance) <= 2.0:
                            near_other += 1
                foreign = max(foreign, near_other / len(samples))
            if foreign >= 0.5:
                return None
    side_lengths = [float(np.linalg.norm(points[(i + 1) % 4] - points[i])) for i in range(4)]
    if min(side_lengths) < 14:
        return None
    area = 0.5 * abs(float(np.dot(points[:, 0], np.roll(points[:, 1], -1))
                            - np.dot(points[:, 1], np.roll(points[:, 0], -1))))
    if not (0.45 * aw * ah <= area <= 2.2 * aw * ah):
        return None
    top_dir = points[1] - points[0]
    left_dir = points[3] - points[0]
    top_angle = math.degrees(math.atan2(float(top_dir[1]), float(top_dir[0])))
    left_angle = math.degrees(math.atan2(float(left_dir[1]), float(left_dir[0])))
    top_len = side_lengths[0]; bottom_len = side_lengths[2]
    left_len = side_lengths[3]; right_len = side_lengths[1]
    top_horizontal = abs(top_angle) <= 8.0
    bottom_horizontal = abs(math.degrees(math.atan2(float((points[2] - points[3])[1]),
                                                    float((points[2] - points[3])[0])))) <= 8.0
    left_vertical = abs(abs(left_angle) - 90.0) <= 10.0
    right_vertical = abs(abs(math.degrees(math.atan2(float((points[2] - points[1])[1]),
                                                     float((points[2] - points[1])[0])))) - 90.0) <= 10.0
    kind = 'rect-sharp'
    native = None
    bounds = {'x': round(float(points[:, 0].min()), 2), 'y': round(float(points[:, 1].min()), 2),
              'w': round(float(points[:, 0].max() - points[:, 0].min()), 2),
              'h': round(float(points[:, 1].max() - points[:, 1].min()), 2)}
    sharp = [{'type': 'sharp'}] * 4
    if top_horizontal and bottom_horizontal and left_vertical and right_vertical:
        kind = 'rect-sharp'
        native = {'type': 'shape', 'shape': 'rect', 'bounds': bounds,
                  'shapeGeometry': {'version': 2, 'corners': sharp}}
    elif abs(top_angle) <= 8.0 and abs(math.degrees(math.atan2(float((points[2] - points[1])[1]),
                                                                 float((points[2] - points[1])[0])))) <= 8.0:
        shift = float((points[1][0] - points[0][0] + points[2][0] - points[3][0]) / 2.0)
        if abs(shift) >= 2.0:
            kind = 'parallelogram-sharp'
            native = {'type': 'shape', 'shape': 'parallelogram', 'bounds': bounds,
                      'shapeGeometry': {'version': 2, 'corners': sharp,
                                        'headDepth': round(min(.45, abs(shift) / max(1.0, bounds['w'])), 4),
                                        'slantSign': 1 if shift > 0 else -1}}
    elif top_horizontal or bottom_horizontal:
        top_span = max(1.0, top_len); bottom_span = max(1.0, bottom_len)
        inset = abs(top_span - bottom_span) / 2.0 / max(1.0, max(top_span, bottom_span))
        kind = 'trapezoid'
        native = {'type': 'shape', 'shape': 'trapezoid', 'bounds': bounds,
                  'shapeGeometry': {'version': 2, 'headDepth': round(min(.45, max(.02, inset)), 4)}}
    return points, kind, native



def image_contour_points(e, box, front=None):
    """Real image contour of the element (fill/gradient mask) for curvature classification:
    never use the hypothesised candidate polygon for capsule/roundRect decisions."""
    if _REF is None:
        return None
    x, y, w, h = [float(v) for v in box]
    if w < 12 or h < 12:
        return None
    pad = max(12.0, 0.22 * max(w, h))
    x0 = max(0, int(round(x - pad))); y0 = max(0, int(round(y - pad)))
    x1 = min(WIDTH, int(round(x + w + pad))); y1 = min(HEIGHT, int(round(y + h + pad)))
    if x1 - x0 < 16 or y1 - y0 < 16:
        return None
    patch = cv2.cvtColor(_REF[y0:y1, x0:x1], cv2.COLOR_RGB2LAB).astype(np.float32)
    targets = _element_lab_targets(e)
    mask = np.zeros(patch.shape[:2], np.uint8)
    if targets:
        for target in targets:
            distance = np.linalg.norm(patch - target.reshape(1, 1, 3), axis=2)
            mask = np.maximum(mask, (distance < 25.0).astype(np.uint8))
    if int(mask.sum()) < 0.05 * w * h:
        # fallback: interior vs border contrast
        border = np.concatenate([patch[:3].reshape(-1, 3), patch[-3:].reshape(-1, 3),
                                 patch[:, :3].reshape(-1, 3), patch[:, -3:].reshape(-1, 3)])
        base = np.median(border, axis=0)
        distance = np.linalg.norm(patch - base.reshape(1, 1, 3), axis=2)
        mask = (distance > 9.0).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    contours = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0]
    if not contours:
        return None
    center = np.array([x + w / 2.0 - x0, y + h / 2.0 - y0], float)
    def score(contour):
        area = cv2.contourArea(contour)
        centre = np.array(cv2.mean(contour)[:2], float)
        return area - 3.0 * float(np.linalg.norm(centre - center))
    best = max(contours, key=score)
    if cv2.contourArea(best) < 0.12 * w * h:
        return None
    points = best[:, 0, :].astype(float) + np.array([x0, y0], float)
    return points



GATED_KINDS = {'rect-sharp', 'cutPanel', 'roundRect', 'pill', 'roundPanel',
               'parallelogram-sharp', 'hexagon', 'chevron', 'trapezoid',
               'rightArrow', 'triangle', 'quad-4edge'}


def perimeter_provenance(points, dist, front, elements, e):
    """Full-frame provenance: every boundary sample must be explained by own continuous edge,
    occlusion, or a shared edge with a registered neighbour. Unexplained runs are the real
    error signal (wrong boxes leave long unexplained stretches)."""
    pts = np.asarray(points, float)
    if pts.ndim != 2 or len(pts) < 3 or dist is None or _REF is None:
        return None
    seg = np.linalg.norm(np.diff(np.vstack([pts, pts[0]]), axis=0), axis=1)
    total = float(seg.sum())
    if total < 24.0:
        return None
    step = max(1.2, total / 220.0)
    samples = []; normals = []
    for index in range(len(pts)):
        a = pts[index]; b = pts[(index + 1) % len(pts)]
        length = float(np.linalg.norm(b - a))
        if length < 1e-3:
            continue
        count = int(max(1, round(length / step)))
        tangent = (b - a) / length
        normal = np.array([-tangent[1], tangent[0]])
        for k in range(count):
            samples.append(a + (b - a) * ((k + 0.5) / count))
            normals.append(normal)
    samples = np.asarray(samples); normals = np.asarray(normals)
    if len(samples) < 8:
        return None
    lab = _REF_LAB if _REF_LAB is not None else cv2.cvtColor(_REF, cv2.COLOR_RGB2LAB)
    contour = np.rint(pts).astype(np.int32).reshape(-1, 1, 2)
    neighbours = []
    if elements:
        for other in elements:
            if other is e or other.get('key') == e.get('key'):
                continue
            polygon = seed_polygon_of(other)
            if polygon is None or len(polygon) < 3:
                continue
            neighbours.append(np.rint(np.asarray(polygon, float)).astype(np.int32).reshape(-1, 1, 2))
    flags = []
    def lab_at(point):
        xx = min(WIDTH - 1, max(0, int(round(point[0]))))
        yy = min(HEIGHT - 1, max(0, int(round(point[1]))))
        return lab[yy, xx].astype(np.float32)
    for point, normal in zip(samples, normals):
        xi = min(WIDTH - 1, max(0, int(round(point[0]))))
        yi = min(HEIGHT - 1, max(0, int(round(point[1]))))
        if front is not None and getattr(front, 'size', 0) and front[yi, xi]:
            flags.append('hidden'); continue
        if dist[yi, xi] <= 2.2:
            inside = None; outside = None
            for sign in (1.0, -1.0):
                probe = point + sign * normal * 4.0
                if cv2.pointPolygonTest(contour, (float(probe[0]), float(probe[1])), False) >= 0:
                    inside = probe; outside = point - sign * normal * 4.0; break
            if inside is not None:
                contrast = float(np.linalg.norm(lab_at(inside) - lab_at(outside)))
                if contrast >= 5.0:
                    flags.append('own'); continue
            shared = False
            for neighbour in neighbours:
                if abs(cv2.pointPolygonTest(neighbour, (float(point[0]), float(point[1])), True)) <= 2.0:
                    shared = True; break
            flags.append('shared' if shared else 'unexplained')
            continue
        flags.append('unexplained')
    count = len(flags)
    counts = {name: flags.count(name) for name in ('own', 'hidden', 'shared', 'unexplained')}
    run = 0; max_run = 0
    for flag in flags:
        run = run + 1 if flag == 'unexplained' else 0
        max_run = max(max_run, run)
    explained = (counts['own'] + counts['hidden'] + counts['shared']) / count
    return {'explained': round(explained, 3), 'own': round(counts['own'] / count, 3),
            'hidden': round(counts['hidden'] / count, 3), 'shared': round(counts['shared'] / count, 3),
            'stroke': round(counts.get('stroke', 0) / count, 3),
            'unexplained': round(counts['unexplained'] / count, 3),
            'maxUnexplained': int(max_run), 'samples': count}



def inward_line_profile(points, dist, front, e, samples_per_side=12):
    """Scan inward from every side: if the candidate side itself is weakly supported while an
    inner parallel (and only partially covering) line exists, the box is snapped to internal
    content lines (dividers/dividers/underlines) rather than to the real closed frame."""
    pts = np.asarray(points, float)
    if pts.ndim != 2 or len(pts) < 3 or dist is None:
        return None
    lo = pts.min(axis=0); hi = pts.max(axis=0)
    short_side = max(1.0, float(min(hi[0] - lo[0], hi[1] - lo[1])))
    depth = int(max(6, min(22, round(0.12 * short_side))))
    centroid = pts.mean(axis=0)
    sides = []
    for index in range(len(pts)):
        a = pts[index]; b = pts[(index + 1) % len(pts)]
        length = float(np.linalg.norm(b - a))
        if length < 8:
            continue
        tangent = (b - a) / length
        normal = np.array([-tangent[1], tangent[0]])
        probe = (a + b) / 2.0 + normal * 4.0
        if float(np.linalg.norm(probe - centroid)) > float(np.linalg.norm((a + b) / 2.0 - centroid)):
            normal = -normal
        side_support = 0.0; inward_hits = 0; inward_span = []
        total = samples_per_side
        for step in range(total):
            f = (step + 0.5) / total
            point = a + (b - a) * f
            xi = min(WIDTH - 1, max(0, int(round(point[0]))))
            yi = min(HEIGHT - 1, max(0, int(round(point[1]))))
            if front is not None and getattr(front, 'size', 0) and front[yi, xi]:
                total -= 1
                continue
            if dist[yi, xi] <= 2.2:
                side_support += 1
            found = False
            for offset in range(3, depth + 1):
                sx = min(WIDTH - 1, max(0, int(round(point[0] + normal[0] * offset))))
                sy = min(HEIGHT - 1, max(0, int(round(point[1] + normal[1] * offset))))
                if dist[sy, sx] <= 1.6:
                    found = True
                    break
            if found:
                inward_hits += 1
                inward_span.append(f)
        if total < 4:
            continue
        support_ratio = side_support / total
        inward_ratio = inward_hits / total
        # non-closed inner line: partial coverage of this side (not running the whole side)
        span = (max(inward_span) - min(inward_span)) if inward_span else 0.0
        inner_line = (support_ratio < 0.45 and 0.15 <= inward_ratio <= 0.85
                      and span <= 0.85)
        sides.append({'support': round(support_ratio, 2), 'inward': round(inward_ratio, 2),
                      'span': round(float(span), 2), 'innerLine': bool(inner_line)})
    if not sides:
        return None
    return {'innerLineSides': sum(1 for side in sides if side['innerLine']),
            'weakSides': sum(1 for side in sides if side['support'] < 0.45),
            'maxInward': max(side['inward'] for side in sides),
            'sides': sides}



def color_jump_profile(points, front, samples_per_side=14, jump_threshold=10.0):
    """A real boundary is a COLOUR JUMP (discontinuity), not a gradient. Straddle the candidate
    boundary by ~2.5px and measure Lab dE: a wrong (over-reaching) box lies inside one uniform
    colour region and shows almost no jump along its sides."""
    if _REF_LAB is None:
        return None
    pts = np.asarray(points, float)
    if pts.ndim != 2 or len(pts) < 3:
        return None
    centroid = pts.mean(axis=0)

    def lab_at(point):
        xx = min(WIDTH - 1, max(0, int(round(point[0]))))
        yy = min(HEIGHT - 1, max(0, int(round(point[1]))))
        return _REF_LAB[yy, xx].astype(np.float32)

    jumps = []
    hidden = 0
    for index in range(len(pts)):
        a = pts[index]; b = pts[(index + 1) % len(pts)]
        length = float(np.linalg.norm(b - a))
        if length < 8:
            continue
        tangent = (b - a) / length
        normal = np.array([-tangent[1], tangent[0]])
        if float(np.linalg.norm((a + b) / 2.0 + normal * 3.0 - centroid)) > float(
                np.linalg.norm((a + b) / 2.0 - centroid)):
            normal = -normal
        for step in range(samples_per_side):
            point = a + (b - a) * ((step + 0.5) / samples_per_side)
            xi = min(WIDTH - 1, max(0, int(round(point[0]))))
            yi = min(HEIGHT - 1, max(0, int(round(point[1]))))
            if front is not None and getattr(front, 'size', 0) and front[yi, xi]:
                hidden += 1
                continue
            inside = lab_at(point + normal * 2.5)
            outside = lab_at(point - normal * 2.5)
            jump = float(np.linalg.norm(inside - outside))
            # local adaptive threshold: compare the jump with the local colour noise/variation
            cx = min(WIDTH - 1, max(3, int(round(point[0]))))
            cy = min(HEIGHT - 1, max(3, int(round(point[1]))))
            patch = _REF_LAB[max(0, cy - 3):cy + 4, max(0, cx - 3):cx + 4].reshape(-1, 3).astype(np.float32)
            local_noise = float(np.mean(np.std(patch, axis=0))) if len(patch) > 4 else 0.0
            local_threshold = max(3.5, min(12.0, 2.8 * local_noise))
            jumps.append((jump, local_threshold))
    if len(jumps) < 8:
        return None
    array = np.asarray([item[0] for item in jumps], np.float32)
    thresholds = np.asarray([item[1] for item in jumps], np.float32)
    covered = array >= thresholds
    coverage = float(covered.mean())
    strong = float((array >= thresholds * 1.6).mean())
    return {'jumpCoverage': round(coverage, 3), 'strongJump': round(strong, 3),
            'threshold': round(float(thresholds.mean()), 2),
            'localThresholdMin': round(float(thresholds.min()), 2),
            'localThresholdMax': round(float(thresholds.max()), 2),
            'meanJump': round(float(array.mean()), 2),
            'medianJump': round(float(np.median(array)), 2),
            'hidden': round(hidden / max(1, hidden + len(array)), 3),
            'samples': int(len(array))}


def color_boundary_profile(points, front, samples_per_side=12):
    """Use colour difference to detect whether a box crosses the real element boundary.

    For every boundary sample, compare the near-inside colour (element fill), a deep-inside
    reference colour (same fill) and the outside colour:
      correct   : near-inside matches the deep fill, outside differs from it
      overreach : near-inside no longer matches the element fill (box went past the element)
      undershoot: outside still matches the fill (box stopped inside the element)
    Works with light/dark backgrounds because it is a relative comparison.
    """
    if _REF_LAB is None:
        return None
    pts = np.asarray(points, float)
    if pts.ndim != 2 or len(pts) < 3:
        return None
    lo = pts.min(axis=0); hi = pts.max(axis=0)
    short = max(1.0, float(min(hi[0] - lo[0], hi[1] - lo[1])))
    deep = max(8.0, min(30.0, 0.18 * short))
    centroid = pts.mean(axis=0)
    counts = {'good': 0, 'overreach': 0, 'undershoot': 0, 'hidden': 0, 'samples': 0}
    def lab_at(point):
        xx = min(WIDTH - 1, max(0, int(round(point[0]))))
        yy = min(HEIGHT - 1, max(0, int(round(point[1]))))
        return _REF_LAB[yy, xx].astype(np.float32)
    for index in range(len(pts)):
        a = pts[index]; b = pts[(index + 1) % len(pts)]
        length = float(np.linalg.norm(b - a))
        if length < 8:
            continue
        tangent = (b - a) / length
        normal = np.array([-tangent[1], tangent[0]])
        if float(np.linalg.norm((a + b) / 2.0 + normal * 4.0 - centroid)) > float(
                np.linalg.norm((a + b) / 2.0 - centroid)):
            normal = -normal
        for step in range(samples_per_side):
            f = (step + 0.5) / samples_per_side
            point = a + (b - a) * f
            xi = min(WIDTH - 1, max(0, int(round(point[0]))))
            yi = min(HEIGHT - 1, max(0, int(round(point[1]))))
            if front is not None and getattr(front, 'size', 0) and front[yi, xi]:
                counts['hidden'] += 1
                continue
            near = lab_at(point + normal * 3.0)
            reference = lab_at(point + normal * deep)
            outside = lab_at(point - normal * 4.0)
            near_diff = float(np.linalg.norm(near - reference))
            outside_diff = float(np.linalg.norm(outside - reference))
            counts['samples'] += 1
            if near_diff > 13.0:
                counts['overreach'] += 1
            elif outside_diff < 9.0:
                counts['undershoot'] += 1
            elif outside_diff >= 10.0:
                counts['good'] += 1
            else:
                counts['undershoot'] += 1
    total = counts['samples']
    if total < 8:
        return None
    return {'good': round(counts['good'] / total, 3),
            'overreach': round(counts['overreach'] / total, 3),
            'undershoot': round(counts['undershoot'] / total, 3),
            'hidden': round(counts['hidden'] / (total + counts['hidden']), 3),
            'samples': total}



def color_ownership_profile(points, front, e, samples_per_side=12):
    """Colour jump + ownership: the boundary must separate the element's OWN fill from outside.
    combined rule per sample:
      - the deep-inside reference is the element fill (local, gradient-safe);
      - jump: inside vs outside colours differ (colour discontinuity, band-max over +/-4px);
      - ownership: near-inside matches the fill reference, near-outside does not.
    A box that over-reaches (boundary inside the background) or sits inside a uniform region
    fails the ownership part even when it happens to touch some strong edge.
    """
    if _REF_LAB is None:
        return None
    pts = np.asarray(points, float)
    if pts.ndim != 2 or len(pts) < 3:
        return None
    lo = pts.min(axis=0); hi = pts.max(axis=0)
    short = max(1.0, float(min(hi[0] - lo[0], hi[1] - lo[1])))
    deep = max(9.0, min(26.0, 0.16 * short))
    centroid = pts.mean(axis=0)

    def lab_at(point):
        xx = min(WIDTH - 1, max(0, int(round(point[0]))))
        yy = min(HEIGHT - 1, max(0, int(round(point[1]))))
        return _REF_LAB[yy, xx].astype(np.float32)

    total = 0; hidden = 0
    owned = 0; jump_hit = 0; inside_match = 0; outside_diff = 0
    thresholds = []; jumps = []
    for index in range(len(pts)):
        a = pts[index]; b = pts[(index + 1) % len(pts)]
        length = float(np.linalg.norm(b - a))
        if length < 8:
            continue
        tangent = (b - a) / length
        normal = np.array([-tangent[1], tangent[0]])
        if float(np.linalg.norm((a + b) / 2.0 + normal * 4.0 - centroid)) > float(
                np.linalg.norm((a + b) / 2.0 - centroid)):
            normal = -normal
        for step in range(samples_per_side):
            point = a + (b - a) * ((step + 0.5) / samples_per_side)
            xi = min(WIDTH - 1, max(0, int(round(point[0]))))
            yi = min(HEIGHT - 1, max(0, int(round(point[1]))))
            if front is not None and getattr(front, 'size', 0) and front[yi, xi]:
                hidden += 1
                continue
            total += 1
            # fill reference: median of a few deep-inside samples (text inside is outvoted)
            refs = [lab_at(point + normal * (deep + offset)) for offset in (0.0, 5.0, 10.0)]
            fill_ref = np.median(np.asarray(refs, np.float32), axis=0)
            near_inside = lab_at(point + normal * 2.0)
            near_outside = lab_at(point - normal * 2.0)
            # band-max colour jump across the candidate boundary (handles thin strokes)
            band = []
            for low in range(-4, 4):
                band.append(float(np.linalg.norm(
                    lab_at(point + normal * float(low)) - lab_at(point + normal * float(low + 2)))))
            jump = max(band) if band else 0.0
            # local adaptive threshold
            cx = min(WIDTH - 1, max(3, int(round(point[0]))))
            cy = min(HEIGHT - 1, max(3, int(round(point[1]))))
            patch = _REF_LAB[max(0, cy - 3):cy + 4, max(0, cx - 3):cx + 4].reshape(-1, 3).astype(np.float32)
            local_noise = float(np.mean(np.std(patch, axis=0))) if len(patch) > 4 else 0.0
            threshold = max(4.0, min(12.0, 2.8 * local_noise))
            thresholds.append(threshold); jumps.append(jump)
            inside_ok = float(np.linalg.norm(near_inside - fill_ref)) <= 13.0
            outside_ok = float(np.linalg.norm(near_outside - fill_ref)) >= 9.0
            jump_ok = jump >= threshold
            if inside_ok:
                inside_match += 1
            if outside_ok:
                outside_diff += 1
            if jump_ok:
                jump_hit += 1
            if inside_ok and outside_ok and jump_ok:
                owned += 1
    if total < 8:
        return None
    return {'ownedCoverage': round(owned / total, 3),
            'jumpCoverage': round(jump_hit / total, 3),
            'insideMatch': round(inside_match / total, 3),
            'outsideDiffers': round(outside_diff / total, 3),
            'meanJump': round(float(np.mean(jumps)), 2),
            'threshold': round(float(np.mean(thresholds)), 2),
            'hidden': round(hidden / max(1, hidden + total), 3),
            'samples': total}



def prepare_segmentation(ref):
    """Segmentation-boundary evidence: mean-shift smoothed image keeps real region boundaries
    (contrast-adaptive) while removing texture. Candidate boxes should follow these boundaries
    and their interior should stay homogeneous — independent of background colour."""
    global _SEG_DIST, _SEG_EDGE
    try:
        filtered = cv2.pyrMeanShiftFiltering(ref, 10, 24)
    except Exception:
        filtered = ref
    lab = cv2.cvtColor(filtered, cv2.COLOR_RGB2LAB).astype(np.float32)
    magnitude = np.zeros((HEIGHT, WIDTH), np.float32)
    for channel in range(3):
        gy, gx = np.gradient(lab[:, :, channel])
        magnitude = np.maximum(magnitude, np.hypot(gx, gy))
    threshold = max(2.5, float(np.percentile(magnitude, 80.0)))
    _SEG_EDGE = (magnitude > threshold).astype(np.uint8)
    _SEG_DIST = cv2.distanceTransform((_SEG_EDGE == 0).astype(np.uint8), cv2.DIST_L2, 3)


def segmentation_boundary_profile(points, front, samples_per_side=12):
    if _SEG_DIST is None:
        return None
    pts = np.asarray(points, float)
    if pts.ndim != 2 or len(pts) < 3:
        return None
    visible = 0; boundary_hits = 0
    for index in range(len(pts)):
        a = pts[index]; b = pts[(index + 1) % len(pts)]
        if float(np.linalg.norm(b - a)) < 8:
            continue
        for step in range(samples_per_side):
            point = a + (b - a) * ((step + 0.5) / samples_per_side)
            xi = min(WIDTH - 1, max(0, int(round(point[0]))))
            yi = min(HEIGHT - 1, max(0, int(round(point[1]))))
            if front is not None and getattr(front, 'size', 0) and front[yi, xi]:
                continue
            visible += 1
            if _SEG_DIST[yi, xi] <= 2.5:
                boundary_hits += 1
    if visible < 8:
        return None
    # interior homogeneity: grid points inside the polygon away from its edge
    lo = pts.min(axis=0); hi = pts.max(axis=0)
    margin = max(5.0, 0.12 * min(hi[0] - lo[0], hi[1] - lo[1]))
    contour = np.rint(pts).astype(np.int32).reshape(-1, 1, 2)
    inside = 0; homogeneous = 0
    steps = 9
    for gx in range(steps):
        for gy in range(steps):
            px = lo[0] + (hi[0] - lo[0]) * (gx + 0.5) / steps
            py = lo[1] + (hi[1] - lo[1]) * (gy + 0.5) / steps
            if cv2.pointPolygonTest(contour, (float(px), float(py)), False) < 0:
                continue
            if min(px - lo[0], hi[0] - px, py - lo[1], hi[1] - py) < margin:
                continue
            inside += 1
            xi = min(WIDTH - 1, max(0, int(round(px)))); yi = min(HEIGHT - 1, max(0, int(round(py))))
            if _SEG_DIST[yi, xi] > 3.0:
                homogeneous += 1
    return {'segCoverage': round(boundary_hits / visible, 3),
            'interiorHomogeneity': round(homogeneous / inside, 3) if inside else None,
            'samples': visible}



def prepare_oriented_gradients(ref):
    """Universal boundary evidence: gradient orientation vs boundary normal + edge continuity
    along the boundary. Colour/background independent, works for strokes and solid fills."""
    global _GRAD_MAG, _GRAD_DX, _GRAD_DY, _GRAD_THRESHOLD
    lab = cv2.cvtColor(ref, cv2.COLOR_RGB2LAB).astype(np.float32)
    best_mag = np.zeros((HEIGHT, WIDTH), np.float32)
    best_dx = np.zeros((HEIGHT, WIDTH), np.float32)
    best_dy = np.zeros((HEIGHT, WIDTH), np.float32)
    for channel in range(3):
        gy, gx = np.gradient(cv2.GaussianBlur(lab[:, :, channel], (3, 3), 0.8))
        mag = np.hypot(gx, gy)
        take = mag > best_mag
        best_mag = np.where(take, mag, best_mag)
        best_dx = np.where(take, gx, best_dx)
        best_dy = np.where(take, gy, best_dy)
    _GRAD_MAG = best_mag
    _GRAD_DX = best_dx
    _GRAD_DY = best_dy
    _GRAD_THRESHOLD = max(3.0, float(np.percentile(best_mag, 82.0)))


def oriented_boundary_profile(points, front, samples_per_side=14):
    if _GRAD_MAG is None:
        return None
    pts = np.asarray(points, float)
    if pts.ndim != 2 or len(pts) < 3:
        return None
    visible = 0
    covered_flags = []
    alignments = []
    for index in range(len(pts)):
        a = pts[index]; b = pts[(index + 1) % len(pts)]
        length = float(np.linalg.norm(b - a))
        if length < 8:
            continue
        tangent = (b - a) / length
        normal = np.array([-tangent[1], tangent[0]])
        for step in range(samples_per_side):
            point = a + (b - a) * ((step + 0.5) / samples_per_side)
            xi = min(WIDTH - 1, max(0, int(round(point[0]))))
            yi = min(HEIGHT - 1, max(0, int(round(point[1]))))
            if front is not None and getattr(front, 'size', 0) and front[yi, xi]:
                covered_flags.append(True)   # occlusion counts as explained (not a miss)
                continue
            visible += 1
            # best aligned gradient in a small window
            best = None
            for ox in range(-2, 3):
                for oy in range(-2, 3):
                    sx = min(WIDTH - 1, max(0, xi + ox)); sy = min(HEIGHT - 1, max(0, yi + oy))
                    mag = float(_GRAD_MAG[sy, sx])
                    if best is None or mag > best[0]:
                        best = (mag, float(_GRAD_DX[sy, sx]), float(_GRAD_DY[sy, sx]))
            if best is None or best[0] <= 1e-3:
                covered_flags.append(False); alignments.append(0.0); continue
            norm = max(1e-6, best[0])
            alignment = abs((best[1] / norm) * normal[0] + (best[2] / norm) * normal[1])
            alignments.append(alignment)
            # locally adaptive magnitude threshold: compare with the local gradient background
            px0 = max(0, xi - 4); py0 = max(0, yi - 4)
            local = _GRAD_MAG[py0:min(HEIGHT, yi + 5), px0:min(WIDTH, xi + 5)]
            local_median = float(np.median(local)) if local.size else 0.0
            local_threshold = max(2.0, min(14.0, 2.6 * local_median + 2.0))
            covered_flags.append(bool(alignment >= 0.80 and best[0] >= local_threshold))
    if visible < 8:
        return None
    total = len(covered_flags)
    coverage = sum(1 for flag in covered_flags if flag) / total
    # continuity along the boundary (proxy for a closed loop)
    longest = 0; run = 0; runs = 0
    for flag in covered_flags:
        if flag:
            run += 1
            if run == 1:
                runs += 1
            longest = max(longest, run)
        else:
            run = 0
    return {'orientedCoverage': round(coverage, 3),
            'longestRun': round(longest / total, 3),
            'runs': runs,
            'meanAlignment': round(float(np.mean(alignments)), 3) if alignments else None,
            'samples': total}



def synthesis_consistency(points, dist, front):
    """Analysis-by-synthesis proxy: render the candidate boundary, then check BOTH directions:
    boundary -> image edges (support) and image edges -> candidate boundary (explanation).
    A wrong box misses real local edges (low explanation) even when its own boundary happens
    to sit on some edge."""
    pts = np.asarray(points, float)
    if pts.ndim != 2 or len(pts) < 3 or dist is None:
        return None
    lo = pts.min(axis=0); hi = pts.max(axis=0)
    margin = max(10.0, 0.15 * max(float(hi[0] - lo[0]), float(hi[1] - lo[1])))
    x0 = max(0, int(np.floor(lo[0] - margin))); y0 = max(0, int(np.floor(lo[1] - margin)))
    x1 = min(WIDTH, int(np.ceil(hi[0] + margin))); y1 = min(HEIGHT, int(np.ceil(hi[1] + margin)))
    if x1 - x0 < 12 or y1 - y0 < 12:
        return None
    window = dist[y0:y1, x0:x1]
    local_pts = np.rint(pts - np.array([x0, y0], float)).astype(np.int32)
    rendered = np.zeros(window.shape, np.uint8)
    cv2.polylines(rendered, [local_pts.reshape(-1, 1, 2)], True, 1, 2)
    dist_to_boundary = cv2.distanceTransform((rendered == 0).astype(np.uint8), cv2.DIST_L2, 3)
    front_window = (front[y0:y1, x0:x1] if front is not None and getattr(front, 'size', 0)
                    else np.zeros(window.shape, bool))
    edge_pixels = (window <= 0.5) & (~front_window)
    count = int(edge_pixels.sum())
    explanation = float((dist_to_boundary[edge_pixels] <= 3.0).mean()) if count else None
    # boundary samples
    samples = []
    for index in range(len(pts)):
        a = pts[index]; b = pts[(index + 1) % len(pts)]
        for step in range(10):
            f = (step + 0.5) / 10
            samples.append(a + (b - a) * f)
    support = 0.0; visible = 0
    for point in samples:
        xi = min(WIDTH - 1, max(0, int(round(point[0]))))
        yi = min(HEIGHT - 1, max(0, int(round(point[1]))))
        if front is not None and getattr(front, 'size', 0) and front[yi, xi]:
            continue
        visible += 1
        if dist[yi, xi] <= 1.6:
            support += 1
    return {'boundarySupport': round(support / visible, 3) if visible else None,
            'edgeExplanation': round(explanation, 3) if explanation is not None else None,
            'localEdgePixels': count}



def unified_boundary_samples(points, front, elements, e, min_points=48, max_points=400):
    """Single arc-length-uniform sample table shared by all boundary metrics."""
    pts = np.asarray(points, float)
    if pts.ndim != 2 or len(pts) < 3 or _REF_LAB is None:
        return None
    closed = np.vstack([pts, pts[0]])
    seg = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    total = float(seg.sum())
    if total < 30:
        return None
    step = max(1.5, min(3.0, total / 240.0))
    count = int(max(min_points, min(max_points, round(total / step))))
    acc = np.r_[0.0, np.cumsum(seg)]
    samples = np.zeros((count, 2), float)
    tangents = np.zeros((count, 2), float)
    for k in range(count):
        s = total * (k + 0.5) / count
        index = int(np.searchsorted(acc, s, side='right') - 1)
        index = max(0, min(len(seg) - 1, index))
        f = (s - acc[index]) / max(1e-6, seg[index])
        samples[k] = closed[index] + (closed[index + 1] - closed[index]) * f
        tangents[k] = (closed[index + 1] - closed[index]) / max(1e-6, seg[index])
    normals = np.stack([-tangents[:, 1], tangents[:, 0]], axis=1)
    centroid = pts.mean(axis=0)
    neighbours = []
    if elements:
        for other in elements:
            if other is e or other.get('key') == e.get('key'):
                continue
            polygon = seed_polygon_of(other)
            if polygon is None or len(polygon) < 3:
                continue
            neighbours.append(np.rint(np.asarray(polygon, float)).astype(np.int32).reshape(-1, 1, 2))

    def lab_at(point):
        xx = min(WIDTH - 1, max(0, int(round(point[0]))))
        yy = min(HEIGHT - 1, max(0, int(round(point[1]))))
        return _REF_LAB[yy, xx].astype(np.float32)

    table = []
    for point, normal in zip(samples, normals):
        xi = min(WIDTH - 1, max(0, int(round(point[0]))))
        yi = min(HEIGHT - 1, max(0, int(round(point[1]))))
        hidden = bool(front is not None and getattr(front, 'size', 0) and front[yi, xi])
        patch = _REF_LAB[max(0, yi - 3):min(HEIGHT, yi + 4), max(0, xi - 3):min(WIDTH, xi + 4)]
        local_noise = (float(np.mean(np.std(patch.reshape(-1, 3).astype(np.float32), axis=0)))
                       if patch.size else 0.0)
        # own edge: gradient orientation aligned with the boundary normal (local threshold)
        own = False
        if _GRAD_MAG is not None:
            best = None
            for ox in (-2, -1, 0, 1, 2):
                for oy in (-2, -1, 0, 1, 2):
                    sx = min(WIDTH - 1, max(0, xi + ox)); sy = min(HEIGHT - 1, max(0, yi + oy))
                    mag = float(_GRAD_MAG[sy, sx])
                    if best is None or mag > best[0]:
                        best = (mag, float(_GRAD_DX[sy, sx]), float(_GRAD_DY[sy, sx]))
            if best and best[0] > 1e-3:
                local = _GRAD_MAG[max(0, yi - 4):min(HEIGHT, yi + 5), max(0, xi - 4):min(WIDTH, xi + 5)]
                local_threshold = max(2.0, min(14.0, 2.6 * float(np.median(local)) + 2.0))
                alignment = abs((best[1] / best[0]) * normal[0] + (best[2] / best[0]) * normal[1])
                own = alignment >= 0.80 and best[0] >= local_threshold
        # sub-pixel profile (0.5px), declared-stroke matched filter + generic double-edge
        offsets = np.arange(-4.0, 4.001, 0.5)
        colors = np.asarray([lab_at(point + normal * float(offset)) for offset in offsets], np.float32)
        deltas = np.linalg.norm(np.diff(colors, axis=0), axis=1)
        jump = float(deltas.max()) if len(deltas) else 0.0
        jump_threshold = max(4.0, min(12.0, 2.8 * local_noise))
        stroke_hit = False
        declared_width = float(e.get('strokeWidth') or 0.0)
        stroke_rgb = _hex_rgb(e.get('color') or e.get('strokeColor'))
        if declared_width >= 0.5 and stroke_rgb is not None:
            stroke_lab = cv2.cvtColor(np.asarray(stroke_rgb, np.uint8).reshape(1, 1, 3),
                                      cv2.COLOR_RGB2LAB)[0, 0].astype(np.float32)
            left_side = colors[0]; right_side = colors[-1]
            window = max(1, int(round(declared_width / 0.5)))
            best_score = None
            for start in range(0, len(offsets) - window):
                band = colors[start:start + window + 1]
                stroke_distance = float(np.mean(np.linalg.norm(band - stroke_lab, axis=1)))
                side_distance = min(float(np.linalg.norm(band.mean(axis=0) - left_side)),
                                    float(np.linalg.norm(band.mean(axis=0) - right_side)))
                score = side_distance - 2.2 * stroke_distance
                if best_score is None or score > best_score:
                    best_score = score
            if best_score is not None and best_score > 6.0:
                stroke_hit = True
        if not stroke_hit and declared_width >= 0.5:
            max_gap = max(2.0, declared_width + 1.5)
            strong = [i for i, value in enumerate(deltas) if value >= jump_threshold * 0.5]
            for first in range(len(strong)):
                for second in range(first + 1, len(strong)):
                    gap = float(offsets[strong[second] + 1] - offsets[strong[first]])
                    if gap > max_gap:
                        break
                    if gap < 0.5:
                        continue
                    mid_index = (strong[first] + strong[second]) // 2
                    left_index = max(0, strong[first] - 2)
                    right_index = min(len(colors) - 1, strong[second] + 2)
                    middle = colors[mid_index]
                    if (float(np.linalg.norm(middle - colors[left_index])) >= jump_threshold * 0.6
                            and float(np.linalg.norm(middle - colors[right_index])) >= jump_threshold * 0.6):
                        stroke_hit = True
                        break
                if stroke_hit:
                    break
        shared = False
        if neighbours:
            for neighbour in neighbours:
                if abs(cv2.pointPolygonTest(neighbour, (float(point[0]), float(point[1])), True)) <= 2.0:
                    shared = True; break
        if hidden:
            category = 'hidden'
        elif own:
            category = 'own'
        elif jump >= jump_threshold:
            category = 'jump'
        elif stroke_hit:
            category = 'stroke'
        elif shared:
            category = 'shared'
        else:
            category = 'unexplained'
        table.append({'point': point, 'normal': normal, 'hidden': hidden, 'own': own,
                      'jump': jump, 'jumpThreshold': jump_threshold, 'shared': shared,
                      'localNoise': local_noise, 'category': category})
    return {'table': table, 'step': total / count, 'perimeter': total}


def boundary_completeness(points, dist, front, elements, e):
    """Unified boundary-completeness judgement built on one arc-length sample table."""
    sampling = unified_boundary_samples(points, front, elements, e)
    if sampling is None:
        return None
    table = sampling['table']
    count = len(table)
    if count < 12:
        return None
    categories = [row['category'] for row in table]
    counts = {name: categories.count(name)
              for name in ('own', 'jump', 'hidden', 'shared', 'stroke', 'unexplained')}
    run = 0; max_run = 0
    for category in categories:
        run = run + 1 if category == 'unexplained' else 0
        max_run = max(max_run, run)
    explained = (counts['own'] + counts['jump'] + counts['hidden']
                 + counts['shared'] + counts.get('stroke', 0)) / count
    return {'completeRatio': round(explained, 3),
            'own': round(counts['own'] / count, 3), 'jump': round(counts['jump'] / count, 3),
            'hidden': round(counts['hidden'] / count, 3), 'shared': round(counts['shared'] / count, 3),
            'unexplained': round(counts['unexplained'] / count, 3),
            'maxUnexplainedPx': round(max_run * sampling['step'], 1),
            'perimeter': round(sampling['perimeter'], 1),
            'step': round(sampling['step'], 2), 'samples': count}



_REF_ENH = None


def enhance_reference(ref):
    """Contrast-enhanced copy used ONLY for edge evidence on low-contrast elements."""
    lab = cv2.cvtColor(ref, cv2.COLOR_RGB2LAB)
    l, a, b = cv2.split(lab)
    l = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(l)
    enhanced = cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)
    enhanced = cv2.addWeighted(enhanced, 1.35, cv2.GaussianBlur(enhanced, (0, 0), 3.0), -0.35, 0)
    return cv2.cvtColor(enhanced, cv2.COLOR_BGR2RGB)


def boundary_contrast_score(element, ref):
    """Mean Lab colour step across the audit-box boundary (low value => low-contrast element)."""
    x, y, w, h = box_of(element)
    if w < 12 or h < 12:
        return 99.0
    lab = cv2.cvtColor(ref, cv2.COLOR_RGB2LAB).astype(np.float32)
    steps = []
    for fraction in np.linspace(0.15, 0.85, 9):
        for (px, py, dx, dy) in (
                (x + w * fraction, y, 0.0, 1.0),
                (x + w * fraction, y + h, 0.0, 1.0),
                (x, y + h * fraction, 1.0, 0.0),
                (x + w, y + h * fraction, 1.0, 0.0)):
            inner = (px + dx * 3.0, py + dy * 3.0)
            outer = (px - dx * 3.0, py - dy * 3.0)
            xi = int(round(inner[0])); yi = int(round(inner[1]))
            xo = int(round(outer[0])); yo = int(round(outer[1]))
            if not (0 <= xi < WIDTH and 0 <= yi < HEIGHT and 0 <= xo < WIDTH and 0 <= yo < HEIGHT):
                continue
            steps.append(float(np.linalg.norm(lab[yi, xi] - lab[yo, xo])))
    return float(np.median(steps)) if steps else 99.0


def fit_element(e, index, elements, families, lines, edge, dist, front):
    key = e['key']
    box = box_of(e)
    x, y, w, h = box
    if w < 6 or h < 6:
        return None
    roi_shift = [0.0, 0.0, 0.0, 0.0]
    roi_score = 0.0
    relocation = None
    trusted_relocation = None
    original_box = tuple(box)
    early_class = str(e.get('classHint') or e.get('elementClass') or e.get('class')
                      or e.get('shape') or e.get('type') or '').lower()
    early_model = model_of_class(early_class, e)
    if early_model not in ('TEXT', 'ASSET', 'EFFECT', 'COMPOSITE') and not e.get('_probe'):
        # -- initial value policy: keep it conservative (prefer including the real element
        # over cutting it off). Refinement/fitting happens after this, on top of the hint.
        candidates = []
        component_box, component_info = relocate_box(e, _REF) if (
            early_model in PANEL_MODELS or early_model in ('ELLIPSE', 'PRESET-POLY')) else (box, None)
        if component_info is not None:
            candidates.append((component_box, component_info))
        if early_model in PANEL_MODELS:
            scanline_box = scanline_capsule_box(e, box)
            if scanline_box is not None:
                candidates.append((scanline_box, {
                    'source': 'scanline',
                    'deltas': [round(scanline_box[1] - box[1], 1),
                               round((scanline_box[1] + scanline_box[3]) - (box[1] + box[3]), 1),
                               round(scanline_box[0] - box[0], 1),
                               round((scanline_box[0] + scanline_box[2]) - (box[0] + box[2]), 1)]}))
        best_candidate = None
        for candidate_box, candidate_info in candidates:
            candidate_seed = seed_polygon_of({**e, 'x': candidate_box[0], 'y': candidate_box[1],
                                              'w': candidate_box[2], 'h': candidate_box[3]})
            metrics = boundary_metrics(candidate_seed, dist, front, edge=edge)
            color_edge, color_dist = color_edge_maps(_REF, front)
            color_metrics = (boundary_metrics(candidate_seed, color_dist, front, edge=color_edge)
                             if color_dist is not None else None)
            ratio_w = candidate_box[2] / max(1.0, w)
            ratio_h = candidate_box[3] / max(1.0, h)
            size_penalty = abs(math.log(max(1e-3, ratio_w))) + abs(math.log(max(1e-3, ratio_h)))
            canny_support = metrics['edgeSupport'] + 0.5 * metrics.get('orientedSupport', metrics['edgeSupport'])
            color_support = ((color_metrics['edgeSupport'] + 0.5 * color_metrics.get('orientedSupport', color_metrics['edgeSupport']))
                             if color_metrics is not None else 0.0)
            support = max(canny_support, color_support)
            score = support - 0.9 * size_penalty
            if best_candidate is None or score > best_candidate[0]:
                best_candidate = (score, candidate_box, candidate_info)
        if best_candidate is not None and any(abs(v) > 5.0 for v in best_candidate[2]['deltas']):
            box = best_candidate[1]
            x, y, w, h = box
            relocation = best_candidate[2]
            roi_shift = [float(v) for v in relocation['deltas']]
            roi_score = float(round(best_candidate[0], 4))
            declared_rounded = (e.get('shape') in ('roundRect', 'round', 'pill')
                                or str(e.get('type') or '') in ('rect', 'roundRect', 'ellipse'))
            if (relocation['source'] in ('stroke', 'fill') and roi_score >= 0.55
                    and (declared_rounded or early_model in ('ROUND-RECT', 'BUBBLE'))):
                # the colour region already gives the true capsule/panel box; post-relocation
                # refinement (profile/PANEL_OPT) must NOT move it onto interior text edges
                trusted_relocation = dict(relocation)
        else:
            # no reliable relocation: keep the audit estimate as the seed, but the search
            # region below is padded (conservative): prefer including a real edge over
            # cutting it, and let fitting refine the final shape.
            relocation = None
            roi_shift = [0.0, 0.0, 0.0, 0.0]
            roi_score = 0.0
        # Composite groups: a number frame inside a pill/card merges into one colour
        # component. Match the declared native template to isolate this single element.
        if early_model == 'PRESET-POLY' and relocation is None:
            hex_line_box, hex_line_info = hexagon_six_edge_box(e, elements, box, lines, front)
            if hex_line_info is not None:
                box = hex_line_box
                x, y, w, h = box
                relocation = hex_line_info
                roi_shift = [float(v) for v in hex_line_info['deltas']]
            sibling_box, sibling_info = (box, None) if relocation is not None else row_sibling_box(e, elements, box, front)
            if sibling_info is not None:
                box = sibling_box
                x, y, w, h = box
                relocation = sibling_info
                roi_shift = [float(v) for v in sibling_info['deltas']]
            elif relocation is None:
                row_box, row_info = row_search_hexagon_box(e, elements, box, front)
                if row_info is not None:
                    box = row_box
                    x, y, w, h = box
                    relocation = row_info
                    roi_shift = [float(v) for v in row_info['deltas']]
                template_box, template_info = template_relocate_box(e, box)
                if template_info is not None:
                    box = template_box
                    x, y, w, h = box
                    relocation = template_info
                    roi_shift = [float(v) for v in template_info['deltas']]
        if early_model == 'PRESET-POLY' and relocation is not None and relocation.get('source') not in (
                'hex-six-edge',) and relocation.get('source') in (
                'template', 'row-sibling', 'row-template', 'row-hex-grid', 'hex-six-edge'):
            color_edge, color_dist = color_edge_maps(_REF, front, threshold=5.0)
            if color_dist is not None:
                audit_seed = seed_polygon_of(e)
                audit_metrics = boundary_metrics(audit_seed, color_dist, front, edge=color_edge)
                new_seed = seed_polygon_of({**e, 'x': box[0], 'y': box[1], 'w': box[2], 'h': box[3]})
                new_metrics = boundary_metrics(new_seed, color_dist, front, edge=color_edge)
                audit_support = (audit_metrics['edgeSupport']
                                 + 0.5 * audit_metrics.get('orientedSupport', audit_metrics['edgeSupport']))
                new_support = (new_metrics['edgeSupport']
                               + 0.5 * new_metrics.get('orientedSupport', new_metrics['edgeSupport']))
                if (new_support < audit_support + 0.02
                        or new_metrics['boundaryP95'] > max(8.0, audit_metrics['boundaryP95'] * 0.85)):
                    box = box_of(e)
                    x, y, w, h = box
                    relocation = None
                    roi_shift = [0.0, 0.0, 0.0, 0.0]
        # sanity ratios below are measured against the audit estimate, not the padded hint
        audit_w, audit_h = max(1.0, original_box[2]), max(1.0, original_box[3])
    if ROI_SNAP and not e.get('_panelOptDone') and not e.get('_probe'):
        snapped_box, roi_deltas, roi_score = snap_roi(box, front, edge, dist)
        if any(abs(delta) > 0.5 for delta in roi_deltas):
            box = snapped_box
            x, y, w, h = box
            roi_shift = [float(round(delta, 2)) for delta in roi_deltas]
            seed = seed_polygon_of({**e, 'x': x, 'y': y, 'w': w, 'h': h})
        else:
            seed = seed_polygon_of(e)
    else:
        seed = seed_polygon_of({**e, 'x': x, 'y': y, 'w': w, 'h': h})
    sides = side_candidates(families, box)
    seed_metrics = boundary_metrics(seed, dist, front)

    declared_round = e.get('shape') in ('roundRect', 'round', 'pill') or e.get('type') == 'roundRect'
    class_hint = str(e.get('classHint') or e.get('elementClass') or e.get('class')
                     or e.get('shape') or e.get('type') or '').lower()
    round_classes = {'roundrect', 'round', 'pill', 'bubble', 'capsule', 'rounded', 'rounded-panel', 'round-panel'}
    ellipse_classes = {'ellipse', 'circle', 'oval', 'dot', 'badge-circle', 'badge', 'ring'}
    prototype_classes = {'hexagon', 'chevron', 'rightarrow', 'arrow', 'triangle', 'trapezoid', 'flag', 'diamond'}
    band_classes = {'band', 'ribbon', 'strip', 'divider'}
    asset_classes = {'svg', 'icon', 'ai-cutout', 'aiimage', 'cutout', 'image', 'logo', 'glyph', 'chart-image', 'artistic-text'}
    strategy_hint = str(e.get('fitStrategy') or '').lower()
    fitting_model = model_of_class(class_hint, e)
    profile = CLASS_PROFILES.get(fitting_model, DEFAULT_PROFILE)
    if fitting_model in ('ASSET', 'TEXT', 'EFFECT', 'COMPOSITE'):
        return None
    thin_band = max(w, h) / max(1.0, min(w, h)) >= 3.2 or class_hint in band_classes
    routed = {
        'class': class_hint,
        'strategyHint': strategy_hint,
        'roundAllowed': (class_hint in round_classes or class_hint not in prototype_classes)
                        and strategy_hint not in ('prototype', 'ellipse'),
        'ellipseAllowed': class_hint in ellipse_classes or class_hint not in prototype_classes,
        'prototypesAllowed': class_hint in prototype_classes or class_hint not in (
            round_classes | ellipse_classes),
        'quadAllowed': class_hint not in ellipse_classes and strategy_hint not in ('ellipse',),
    }
    if strategy_hint == 'ellipse':
        routed['ellipseAllowed'] = True
    if strategy_hint == 'prototype':
        routed['prototypesAllowed'] = True
    if fitting_model in PANEL_MODELS:
        # conservative ROI: search a padded region so a true edge just outside the estimate
        # is not lost (prefer keeping extra area over cutting a real border)
        pad_x = max(8.0, 0.15 * w)
        pad_y = max(8.0, 0.15 * h)
        search_box = (x - pad_x, y - pad_y, w + 2 * pad_x, h + 2 * pad_y)
        sides = side_candidates(families, search_box, tol_ratio=.22, min_span_ratio=.26)
    appearance = estimate_appearance(e, _REF, front, box, dist)
    profile_shift = [0.0, 0.0, 0.0, 0.0]
    if (fitting_model in ('QUAD', 'ROUND-RECT', 'BUBBLE') and not appearance.get('hasGradient')
            and not e.get('_probe') and not trusted_relocation):
        mask_box, mask_deltas = fill_mask_box(e, box)
        if any(abs(delta) >= 2.5 for delta in mask_deltas):
            box = mask_box
            x, y, w, h = box
            profile_shift = [float(round(delta, 2)) for delta in mask_deltas]
            seed = seed_polygon_of({**e, 'x': x, 'y': y, 'w': w, 'h': h})
            seed_metrics = boundary_metrics(seed, dist, front)
    if fitting_model in PANEL_PROFILE and not e.get('_probe') and not trusted_relocation:
        profile_box, profile_deltas, profile_confidence = profile_side_box(box, front, fitting_model)
        if any(abs(delta) >= 2.5 for delta in profile_deltas):
            box = profile_box
            x, y, w, h = box
            profile_shift = [float(round(delta, 2)) for delta in profile_deltas]
            seed = seed_polygon_of({**e, 'x': x, 'y': y, 'w': w, 'h': h})
            seed_metrics = boundary_metrics(seed, dist, front)
    used_color_map = False
    color_seed_support = 0.0
    pre_color_edge, pre_color_dist = color_edge_maps(_REF, front)
    if pre_color_dist is not None:
        pre_metrics = boundary_metrics(seed, pre_color_dist, front, edge=pre_color_edge)
        color_seed_support = pre_metrics['edgeSupport'] + 0.5 * pre_metrics.get('orientedSupport', pre_metrics['edgeSupport'])
    if (fitting_model in ('QUAD', 'ROUND-RECT', 'BUBBLE', 'PRESET-POLY')
            and (float(appearance.get('edgeVisibility') or 0.0) < 0.45 or color_seed_support >= 0.55)):
        color_edge, color_dist = (pre_color_edge, pre_color_dist)
        if color_edge is not None:
            edge, dist = color_edge, color_dist
            used_color_map = True
            seed_metrics = boundary_metrics(seed, dist, front)
    candidates = []

    def add(kind, points, complexity=None, extra=None, metrics_override=None, score_bonus=0.0):
        metrics = metrics_override if metrics_override is not None else boundary_metrics(points, dist, front, edge=edge)
        complexity_value = COMPLEXITY.get(kind, 3) if complexity is None else complexity
        if profile is not DEFAULT_PROFILE:
            score = (profile['edge'] * metrics['edgeSupport']
                     + profile['oriented'] * metrics.get('orientedSupport', metrics['edgeSupport'])
                     - profile['error'] * 0.0018 * max(0.0, metrics['boundaryP95'] - 1.2)
                     - 0.004 * metrics['chamfer'] - 0.008 * complexity_value) + score_bonus
        else:
            score = family_score(metrics, complexity_value) + score_bonus
        score_value = float(score)
        if kind not in ('seed-box', 'box', 'fill-panel', 'freeform', 'freeform-curve',
                        'seed-round', 'seed-sharp'):
            cand = np.asarray(points, float)
            cand_lo = cand.min(axis=0); cand_hi = cand.max(axis=0)
            ratio_w = float(cand_hi[0] - cand_lo[0]) / max(1.0, float(w))
            ratio_h = float(cand_hi[1] - cand_lo[1]) / max(1.0, float(h))
            if not (0.60 <= ratio_w <= 1.50 and 0.60 <= ratio_h <= 1.50):
                return
        if kind in GATED_KINDS:
            provenance = perimeter_provenance(points, dist, front, elements, e)
            if provenance is not None:
                score_value -= 0.18 * max(0.0, 1.0 - provenance['explained'])
                score_value -= 0.004 * provenance['maxUnexplained']
            oriented = oriented_boundary_profile(points, front)
            jump = color_jump_profile(points, front)
            oriented_cov = float(oriented['orientedCoverage']) if oriented else 0.0
            longest = float(oriented['longestRun']) if oriented else 0.0
            jump_cov = float(jump['jumpCoverage']) if jump else 0.0
            bonus = (0.25 * (oriented_cov - 0.80) + 0.10 * (longest - 0.50)
                     + 0.22 * (jump_cov - 0.70))
            score_value += max(-0.20, min(0.20, bonus))
            if oriented_cov < 0.45 and jump_cov < 0.40 and longest < 0.30:
                return
        candidates.append({'kind': kind, 'points': np.asarray(points, float).round(3).tolist(),
                           'metrics': metrics, 'score': round(score_value, 4), 'extra': extra or {}})

    quad = None
    anchored_best = None
    quads = []
    if routed['quadAllowed'] or len(elements) < 0:
        quads = general_quad_candidates(families, box, limit=20) or quad_candidates(sides, box, limit=24)
    anchored = []
    for candidate in quads[:16]:
        fixed = anchor_quad_to_edges(candidate, families, box)
        if fixed is not None:
            anchored.append(fixed)
    quads = quads + anchored
    if quads:
        coarse = sorted(((quad_score(q, box, dist, front), i) for i, q in enumerate(quads)), key=lambda item: -item[0])
        top = [index for _score, index in coarse[:10]]
        refined = [(quad_score(refine_quad(quads[index], dist, front), box, dist, front), index) for index in top]
        scored = sorted(coarse + refined, key=lambda item: -item[0])
        quad = refine_quad(quads[scored[0][1]], dist, front)
        # Prefer an edge-end-anchored variant when it clearly reduces boundary error:
        # this is what keeps panel borders on their own edge instead of a neighbour's.
        base_metrics = boundary_metrics(quad, dist, front)
        anchored_best = None
        anchored_best_p95 = 1e18
        for candidate in anchored:
            fixed = refine_quad(candidate, dist, front)
            if not quad_is_sane(fixed, box):
                continue
            m = boundary_metrics(fixed, dist, front)
            if m['boundaryP95'] < anchored_best_p95:
                anchored_best = fixed
                anchored_best_p95 = m['boundaryP95']
            if (m['boundaryP95'] <= base_metrics['boundaryP95'] * 0.85
                    and m['chamfer'] <= base_metrics['chamfer'] * 0.85
                    and m['edgeSupport'] >= base_metrics['edgeSupport'] - 0.05):
                quad = fixed
                break
        coarse_metrics = boundary_metrics(quad, dist, front)
        offset_quad = refine_quad_offsets_subpixel(quad, dist, front)
        if quad_is_sane(offset_quad, box):
            offset_metrics = boundary_metrics(offset_quad, dist, front)
            if (offset_metrics['edgeSupport'] > coarse_metrics['edgeSupport'] + 0.002
                    or offset_metrics['boundaryP95'] < coarse_metrics['boundaryP95'] - 0.2):
                quad = offset_quad
                coarse_metrics = offset_metrics
        if coarse_metrics['boundaryP95'] > 3.0 or coarse_metrics['chamfer'] > 2.0:
            refined_quad = refine_quad_subpixel(quad, edge, dist, front)
            if refined_quad is not None and quad_is_sane(refined_quad, box):
                refined_metrics = boundary_metrics(refined_quad, dist, front)
                if (refined_metrics['boundaryP95'] < coarse_metrics['boundaryP95'] - 0.15
                        or (refined_metrics['edgeSupport'] >= coarse_metrics['edgeSupport'] + 0.004
                            and refined_metrics['chamfer'] < coarse_metrics['chamfer'])):
                    quad = refined_quad
        quad_rank = [round(s, 4) for s, _ in scored[:5]]
        corners = [detect_corner(quad, i, lines, edge, dist, front, box) for i in range(4)]
        top_vec = quad[1] - quad[0]
        bottom_vec = quad[3] - quad[2]
        skew_left = float(quad[0][0] - quad[3][0])
        skew_right = float(quad[1][0] - quad[2][0])
        skew = (skew_left + skew_right) / 2.0 / max(1e-6, w)
        skewed = (abs(skew) > .02 and abs(float(top_vec[1])) < 0.03 * h
                  and abs(float(bottom_vec[1])) < 0.03 * h and abs(skew_left - skew_right) < .06 * w)
        has_cut = any(c['type'] == 'cut' for c in corners)
        skew_extra = {'skew': round(skew, 4), 'skewSign': 1 if skew > 0 else -1} if skewed else {}
        base_kind = 'parallelogram-sharp' if skewed else 'rect-sharp'
        add(base_kind, quad, extra={'corners': corners, 'quadRank': quad_rank, **skew_extra})
        panel = corner_polygon(quad, corners)
        if has_cut:
            add('cutPanel', panel, extra={'corners': corners, **skew_extra})
        # measurement-driven rounded corners / capsule bubbles: try per-corner radii
        # against the real edge field (geometry-based arc detection misses small radii).
        if (routed['roundAllowed'] and not thin_band
                and coarse_metrics['boundaryP95'] <= 20.0 and coarse_metrics['edgeSupport'] >= 0.35):
            optimized_corners, optimized_polygon, optimized_metrics, optimized_score = optimize_corner_radii(
                quad, dist, front, box, edge, min_gain=(0.0005 if declared_round else 0.0025))
        else:
            optimized_corners, optimized_polygon = [], panel
            optimized_metrics, optimized_score = coarse_metrics, -1e9
        rounded = [corner for corner in optimized_corners if corner.get('type') == 'round']
        radii = [float(corner['radius']) for corner in rounded]
        median_radius = float(np.median(radii)) if radii else 0.0
        if rounded:
            if fitting_model == 'BUBBLE':
                # bubbles/capsules: only a single uniform radius is allowed
                radii_values = [float(corner['radius']) for corner in rounded]
                median_value = float(np.median(radii_values))
                if max(radii_values) - min(radii_values) > 0.06:
                    rounded = []
                    optimized_corners = [{'type': 'sharp'} for _ in range(4)]
                    optimized_polygon = corner_polygon(quad, optimized_corners)
            native_corners = []
            for corner in optimized_corners:
                if corner.get('type') == 'round':
                    native_corners.append({'type': 'round', 'radius': round(float(corner['radius']), 4)})
                else:
                    native_corners.append({'type': 'sharp'})
            rounded_native = {'type': 'shape', 'shape': 'roundRect',
                              'shapeGeometry': {'version': 2, 'cornerRadius': round(median_radius, 4),
                                                'corners': native_corners}}
            add('roundPanel', optimized_polygon, complexity=2,
                extra={'corners': optimized_corners, 'cornerRadius': median_radius, 'native': rounded_native})
        # uniform rounded-rectangle candidate: a declared roundRect/bubble should have one
        # consistent corner radius instead of a per-corner patchwork (also works when the
        # geometric arc detector found nothing because the radius is small).
        if declared_round or len(rounded) >= 2:
            short_side = max(1.0, min(w, h))
            uniform_best = None
            for radius_px in np.arange(3.0, short_side * 0.5 + 0.1, max(1.0, short_side * 0.03)):
                uniform_radius = float(radius_px) / short_side
                uniform_corners = [{'type': 'round', 'radius': round(uniform_radius, 4)} for _ in range(4)]
                uniform_polygon = corner_polygon(quad, uniform_corners)
                uniform_metrics = boundary_metrics(uniform_polygon, dist, front)
                uniform_score = (uniform_metrics['edgeSupport']
                                 - 0.0016 * max(0.0, uniform_metrics['boundaryP95'] - 1.2)
                                 - 0.02 * uniform_metrics['chamfer'])
                if uniform_best is None or uniform_score > uniform_best[0]:
                    uniform_best = (uniform_score, uniform_radius, uniform_corners, uniform_polygon, uniform_metrics)
            if uniform_best is not None:
                uniform_radius = uniform_best[1]
                uniform_native = {'type': 'shape', 'shape': 'roundRect',
                                  'shapeGeometry': {'version': 2, 'cornerRadius': round(uniform_radius, 4),
                                                    'corners': uniform_best[2]}}
                add('pill' if uniform_radius >= 0.40 else 'roundRect', uniform_best[3], complexity=2,
                    extra={'corners': uniform_best[2], 'cornerRadius': uniform_radius, 'native': uniform_native})
        if len(rounded) == 4 and median_radius >= 0.30:
            # capsule/bubble: one uniform radius for every corner, searched up to half of
            # the short side (a stadium uses exactly half).
            best_radius = median_radius
            best_panel = optimized_polygon
            best_metrics = optimized_metrics
            short_side = max(1.0, min(w, h))
            for radius_px in np.arange(4.0, short_side * 0.5 + 0.1, 1.5):
                candidate_radius = float(radius_px) / short_side
                candidate_corners = [{'type': 'round', 'radius': round(candidate_radius, 4)} for _ in range(4)]
                candidate_panel = corner_polygon(quad, candidate_corners)
                candidate_metrics = boundary_metrics(candidate_panel, dist, front)
                support_delta = candidate_metrics['edgeSupport'] - best_metrics['edgeSupport']
                p95_delta = candidate_metrics['boundaryP95'] - best_metrics['boundaryP95']
                better = False
                if support_delta > 0.002:
                    better = True
                elif abs(support_delta) <= 0.002:
                    if p95_delta < -0.1:
                        better = True
                    elif abs(p95_delta) <= 0.1 and candidate_radius > best_radius + 0.02:
                        better = True
                if better:
                    best_radius = candidate_radius
                    best_panel = candidate_panel
                    best_metrics = candidate_metrics
            pill_corners = [{'type': 'round', 'radius': round(best_radius, 4)} for _ in range(4)]
            pill_native = {'type': 'shape', 'shape': 'roundRect',
                           'shapeGeometry': {'version': 2, 'cornerRadius': round(best_radius, 4),
                                             'corners': pill_corners}}
            add('pill' if best_radius >= 0.40 else 'roundRect', best_panel, complexity=2,
                extra={'corners': pill_corners, 'cornerRadius': best_radius, 'native': pill_native})
        capsule_box = capsule_long_edge_box(e, box, lines, edge, dist, front)
        if capsule_box is None and _FIT_LINES and _FIT_LINES is not lines:
            capsule_box = capsule_long_edge_box(e, box, _FIT_LINES, edge, dist, front)
        if capsule_box is not None:
            cbx, cby, cbw, cbh = capsule_box
            gap = min(cbw, cbh)
            cap_ratio = 0.5
            chosen_points = None
            chosen_metrics = None
            chosen_score = None
            for ratio in (0.06, 0.12, 0.18, 0.24, 0.30, 0.36, 0.42, 0.50):
                trial_specs = uniform_corner_specs(gap * ratio, gap)
                trial_points = panel_polygon([cbx, cby, cbx + cbw, cby + cbh], trial_specs)
                trial_metrics = boundary_metrics(trial_points, dist, front, edge=edge)
                trial_score = (trial_metrics['edgeSupport']
                               - 0.004 * trial_metrics['boundaryP95'])
                if chosen_score is None or trial_score > chosen_score:
                    cap_ratio = ratio
                    chosen_points = trial_points
                    chosen_metrics = trial_metrics
                    chosen_score = trial_score
            # Curvature classification: capsule needs long straight sides + long, near-constant
            # curvature caps. Without that evidence a declared roundRect keeps moderate corners.
            real_contour = image_contour_points(e, [cbx, cby, cbw, cbh])
            curvature_source = real_contour if (real_contour is not None and len(real_contour) >= 12) else chosen_points
            capsule_evidence = capsule_curvature_evidence(curvature_source)
            strong_non_capsule = (not capsule_evidence.get('capsule')
                                  and float(capsule_evidence.get('straightFraction') or 0.0) >= 0.55
                                  and float(capsule_evidence.get('arcFraction') or 1.0) <= 0.12
                                  and len(capsule_evidence.get('longSides') or []) >= 3)
            if (str(e.get('shape') or '').lower() == 'roundrect'
                    and cap_ratio >= 0.42 and strong_non_capsule):
                alt_specs = uniform_corner_specs(gap * 0.30, gap)
                alt_points = panel_polygon([cbx, cby, cbx + cbw, cby + cbh], alt_specs)
                alt_metrics = boundary_metrics(alt_points, dist, front, edge=edge)
                cap_ratio = 0.30
                chosen_points = alt_points
                chosen_metrics = alt_metrics
            # Declared-roundRect prior: the long-edge lane derives a full-cap box; a rounded
            # rectangle with moderate corners must not be emitted as a capsule unless the
            # full-round hypothesis is clearly better on the visible boundary.
            if str(e.get('shape') or '').lower() == 'roundrect' and cap_ratio >= 0.42:
                alt_specs = uniform_corner_specs(gap * 0.33, gap)
                alt_points = panel_polygon([cbx, cby, cbx + cbw, cby + cbh], alt_specs)
                alt_metrics = boundary_metrics(alt_points, dist, front, edge=edge)
                alt_score = (alt_metrics['edgeSupport']
                             - 0.004 * alt_metrics['boundaryP95'])
                support_gain = (chosen_metrics['edgeSupport']
                                - alt_metrics['edgeSupport'])
                if (chosen_score - alt_score) < 0.03 and support_gain < 0.06:
                    cap_ratio = 0.33
                    chosen_points = alt_points
                    chosen_metrics = alt_metrics
            specs = uniform_corner_specs(gap * cap_ratio, gap)
            capsule_points = chosen_points
            capsule_metrics = chosen_metrics
            capsule_occlusion = occlusion_boundary_metrics(capsule_points, dist, front)
            completed = (capsule_occlusion['hiddenFraction'] > 0.12
                         and capsule_occlusion['samples'] >= 24
                         and capsule_occlusion['support'] >= 0.60
                         and capsule_occlusion['p95'] <= 6.0)
            if completed or (capsule_metrics['edgeSupport'] >= 0.40
                             and capsule_metrics['boundaryP95'] <= 14.0):
                cap_corners = [{'type': 'round', 'radius': round(cap_ratio, 4)} for _ in range(4)]
                cap_native = {'type': 'shape', 'shape': 'roundRect',
                              'bounds': {'x': round(cbx, 2), 'y': round(cby, 2),
                                         'w': round(cbw, 2), 'h': round(cbh, 2)},
                              'shapeGeometry': {'version': 2, 'cornerRadius': round(cap_ratio, 4),
                                                'corners': cap_corners}}
                completion_extra = ({'completedSides': True,
                                     'from': 'capsule-long-edges-hidden'}
                                    if completed else {'from': 'capsule-long-edges'})
                add('pill' if cap_ratio >= 0.42 else 'roundRect', capsule_points,
                    complexity=1, extra={'corners': cap_corners, 'cornerRadius': cap_ratio,
                                         'native': cap_native, **completion_extra},
                    score_bonus=0.42 if completed else 0.34)
        if fitting_model in PANEL_MODELS and not thin_band:
            quad4 = four_edge_quad_candidate(e, box, lines if lines else _FIT_LINES, dist, front, elements)
            if quad4 is not None:
                quad4_points, quad4_kind, quad4_native = quad4
                add(quad4_kind, quad4_points, complexity=1,
                    extra={'native': quad4_native, 'from': 'quad-4edge'}, score_bonus=0.05)
        if routed['prototypesAllowed']:
            if class_hint in prototype_classes:
                prototype_names = (class_hint,)
            else:
                prototype_names = ('hexagon', 'chevron', 'trapezoid', 'rightArrow', 'triangle')
            for name in prototype_names:
                if name == 'hexagon':
                    for depth in (0.08, 0.12, 0.16, 0.20, 0.24, 0.28, 0.33, 0.38):
                        add('hexagon', prototype_polygon('hexagon', box, {'headDepth': depth}),
                            complexity=1, extra={'native': {'type': 'shape', 'shape': 'hexagon',
                                                           'shapeGeometry': {'version': 2,
                                                                             'headDepth': depth}}})
                elif name == 'chevron':
                    for depth in (0.12, 0.18, 0.24, 0.30):
                        add('chevron', prototype_polygon('chevron', box, {'notchDepth': depth}),
                            complexity=2, extra={'native': {'type': 'shape', 'shape': 'chevron',
                                                            'shapeGeometry': {'version': 2,
                                                                              'notchDepth': depth}}})
                else:
                    add(name, prototype_polygon(name, box, {'headDepth': .22, 'notchDepth': .22, 'slantSign': 1}),
                        extra={'native': {'type': 'shape', 'shape': name}})
        curve = residual_curve_check(panel, dist, front, box)
        if curve:
            add('freeform-curve', panel, complexity=5, extra={'curveEvidence': curve})
    else:
        contour = freeform_contour(edge, box, front)
        if contour is not None:
            add('freeform', contour, complexity=5)
        add('box', box_polygon(e), complexity=0, extra={'fallback': 'box'})

    # Non-panel fitting models (PRESET-POLY: hexagon/chevron/arrow...) do not enter the
    # panel candidate branch, so their template candidates must be generated here.
    if fitting_model == 'PRESET-POLY' or (routed['prototypesAllowed'] and fitting_model not in PANEL_MODELS):
        names = (class_hint,) if class_hint in prototype_classes else (
            'hexagon', 'chevron', 'trapezoid', 'rightArrow', 'triangle')
        for name in names:
            if name == 'hexagon':
                for depth in (0.08, 0.12, 0.16, 0.20, 0.24, 0.28, 0.33, 0.38):
                    add('hexagon', prototype_polygon('hexagon', box, {'headDepth': depth}),
                        complexity=1, extra={'native': {'type': 'shape', 'shape': 'hexagon',
                                                       'shapeGeometry': {'version': 2,
                                                                         'headDepth': depth}}})
            elif name == 'chevron':
                for depth in (0.12, 0.18, 0.24, 0.30):
                    add('chevron', prototype_polygon('chevron', box, {'notchDepth': depth}),
                        complexity=2, extra={'native': {'type': 'shape', 'shape': 'chevron',
                                                        'shapeGeometry': {'version': 2,
                                                                          'notchDepth': depth}}})
            elif name == 'trapezoid':
                for depth in (0.12, 0.20, 0.28):
                    add('trapezoid', prototype_polygon('trapezoid', box, {'headDepth': depth}),
                        complexity=2, extra={'native': {'type': 'shape', 'shape': 'trapezoid',
                                                        'shapeGeometry': {'version': 2,
                                                                          'headDepth': depth}}})
            elif name in ('rightArrow',):
                add(name, prototype_polygon(name, box, {'headDepth': .22}),
                    complexity=3, extra={'native': {'type': 'shape', 'shape': name}})
            elif name == 'triangle':
                add('triangle', prototype_polygon('triangle', box), complexity=2,
                    extra={'native': {'type': 'shape', 'shape': 'triangle'}})
    strategy_requested = str(e.get('fitStrategy') or '').lower()
    weak_edges = appearance['edgeVisibility'] < (0.55 if appearance['borderless'] else 0.35)
    use_fill_lane = (weak_edges or strategy_requested == 'fill-contrast'
                     or (appearance['hasGradient'] and appearance['edgeVisibility'] < 0.35))
    fill_candidates = fit_fill_contour(e, front, dist, box) if use_fill_lane else None
    if fill_candidates:
        for fill_candidate in fill_candidates:
            native = fill_candidate.get('native')
            if native is None:
                points = np.asarray(fill_candidate['points'], float)
                lo = points.min(axis=0)
                hi = points.max(axis=0)
                size = np.maximum(1e-6, hi - lo)
                normalized = [[float((point[0] - lo[0]) / size[0]), float((point[1] - lo[1]) / size[1])]
                              for point in points]
                native = {'type': 'shape', 'shape': 'freeform',
                          'bounds': {'x': round(float(lo[0]), 2), 'y': round(float(lo[1]), 2),
                                     'w': round(float(size[0]), 2), 'h': round(float(size[1]), 2)},
                          'customGeometry': {'points': [[round(px, 4), round(py, 4)] for px, py in normalized],
                                             'closed': True}}
            fill_support = float(fill_candidate['metrics'].get('fillSupport') or 0.0)
            add(fill_candidate['kind'], fill_candidate['points'], complexity=2,
                extra={'native': native, 'fillSupport': round(fill_support, 4),
                       'strategy': 'fill-contrast'},
                metrics_override=fill_candidate['metrics'],
                score_bonus=(0.12 * (fill_support - 0.6) if fill_support >= 0.70 else 0.0))
    explicit_ellipse = (e.get('type') == 'ellipse' or e.get('shape') in ('ellipse', 'circle', 'oval')
                        or class_hint in ellipse_classes)
    small_round = (routed['ellipseAllowed'] and max(w, h) <= 230.0
                   and min(w, h) / max(w, h) >= 0.72 and class_hint not in prototype_classes)
    if explicit_ellipse or small_round:
        ellipse_fit = fit_ellipse_candidate(e, edge, dist, front, box)
        if ellipse_fit is not None:
            ellipse_metrics = boundary_metrics(ellipse_fit['points'], dist, front)
            strong_fit = (ellipse_metrics['edgeSupport'] >= 0.82 and ellipse_metrics['boundaryP95'] <= 3.0)
            if explicit_ellipse or strong_fit:
                add(ellipse_fit['kind'], ellipse_fit['points'], complexity=1,
                    extra={'native': ellipse_fit['native'],
                           'ellipse': {'rx': round(ellipse_fit['rx'], 3), 'ry': round(ellipse_fit['ry'], 3),
                                       'rotation': round(ellipse_fit['rotation'], 2)}})
    prototype_kinds = ('hexagon', 'chevron', 'trapezoid', 'rightArrow', 'triangle')
    candidates = [candidate for candidate in candidates
                  if candidate['kind'] not in prototype_kinds
                  or (candidate['metrics']['boundaryP95'] <= 6.0 and candidate['metrics']['edgeSupport'] >= 0.65)]
    kind_tie = {'pill': 0, 'roundRect': 1, 'roundPanel': 2, 'rect-sharp': 3, 'parallelogram-sharp': 3,
                'cutPanel': 4, 'freeform': 6, 'freeform-curve': 6}
    candidates.sort(key=lambda c: (-round(c['score'], 3), kind_tie.get(c['kind'], 5), COMPLEXITY.get(c['kind'], 9)))
    if not candidates:
        candidates = [{'kind': 'box', 'points': box_polygon(e).round(3).tolist(),
                       'metrics': seed_metrics, 'score': round(family_score(seed_metrics, 0), 4),
                       'extra': {'fallback': 'box'}}]
    best = candidates[0]
    # A per-corner panel that is fully rounded is a roundRect/capsule in design terms;
    # prefer the symmetric native family when its geometry is equally good.
    if best['kind'] == 'roundPanel':
        symmetric = next((candidate for candidate in candidates
                          if candidate['kind'] in ('pill', 'roundRect')
                          and candidate['score'] >= best['score'] - 0.012), None)
        if symmetric is not None:
            best = symmetric
    if best['kind'] == 'fill-panel':
        edge_alternative = next((candidate for candidate in candidates
                                 if candidate['kind'] != 'fill-panel'
                                 and candidate['score'] >= best['score'] - 0.05
                                 and candidate['metrics']['boundaryP95'] <= best['metrics']['boundaryP95'] + 2.0
                                 and candidate['metrics']['edgeSupport'] >= best['metrics']['edgeSupport'] - 0.02),
                                None)
        if edge_alternative is not None:
            best = edge_alternative
    if declared_round:
        rounded_best = next((candidate for candidate in candidates
                             if candidate['kind'] in ('pill', 'roundRect', 'roundPanel')), None)
        if (rounded_best is not None and rounded_best['score'] >= best['score'] - 0.02
                and rounded_best['metrics']['boundaryP95'] <= best['metrics']['boundaryP95'] + 2.0
                and rounded_best['metrics']['edgeSupport'] >= best['metrics']['edgeSupport'] - 0.03):
            best = rounded_best
    if best['kind'] in prototype_kinds:
        straight = next((candidate for candidate in candidates if candidate['kind'] not in prototype_kinds), None)
        if straight is not None and best['score'] - straight['score'] < 0.05:
            best = straight
    # ---- panel optimizer lane (ROI-anchored), guarded so it can never degrade the champion
    lane_candidate = None
    optimizer_report = None
    if PANEL_OPT and fitting_model in PANEL_MODELS and not e.get('_panelOptDone'):
        champion_kind = str(best['kind'])
        champion_drift = _panel_bbox_drift(best['points'], box)
        run_lane = (champion_kind in ('seed-box', 'box', 'fill-panel', 'roundPanel', 'freeform')
                    or float(best['metrics']['boundaryP95']) > 6.0
                    or champion_drift > 0.02
                    or (declared_round and champion_kind not in ('pill', 'roundRect', 'seed-round')))
        if run_lane:
            children = _content_child_boxes(e, elements, box)
            lane_ctx = panel_context(dist, front, edge, _REF, box, children)
            lane_candidate = panel_lane_candidate(e, box, lane_ctx, fitting_model, declared_round)
            champion_cost, champion_parts = panel_cost_parts(np.asarray(best['points'], float),
                                                             best['metrics'], lane_ctx)
            accepted, guard = panel_accept(lane_candidate, best, box, champion_cost, champion_drift)
            optimizer_report = {
                'cost': round(float(lane_candidate['cost']), 4),
                'championCost': round(float(champion_cost), 4),
                'champion': champion_kind,
                'parts': {name: round(float(value), 4) for name, value in lane_candidate['parts'].items()},
                'rect': [round(float(value), 2) for value in lane_candidate['rect']],
                'radius': round(float(lane_candidate['radius']), 2),
                'accepted': bool(accepted), 'guard': guard,
            }
            if accepted:
                best = {'kind': lane_candidate['kind'],
                        'points': np.asarray(lane_candidate['points'], float).round(3).tolist(),
                        'metrics': lane_candidate['metrics'],
                        'score': round(1.0 - float(lane_candidate['cost']), 4),
                        'extra': {'corners': lane_candidate['corners'],
                                  'native': lane_candidate['native'],
                                  'from': 'panel-opt',
                                  'optimizer': optimizer_report,
                                  'cornerRadius': round(float(lane_candidate['radius']) / max(1.0, min(w, h)), 4)}}
                candidates.append(best)
    # declared roundRect/pill family consistency: a sharp result loses to the rounded native
    # family when its boundary quality is on par (fixes rect-sharp instead of pill).
    if declared_round and fitting_model != 'QUAD' and best['kind'] in ('rect-sharp', 'parallelogram-sharp', 'cutPanel'):
        family_alt = lane_candidate
        family_alt_cost = None if family_alt is None else float(family_alt['cost'])
        if family_alt is None:
            family_alt = build_seed_round(e, box, fitting_model, dist, front)
            family_alt_cost = None
        family_extra = family_alt.get('extra') or {}
        family_corners = family_alt.get('corners') or family_extra.get('corners') or []
        family_native = family_alt.get('native') or family_extra.get('native')
        family_radius = family_alt.get('radius')
        if family_radius is None:
            family_radius = float(family_extra.get('cornerRadius') or 0.0) * max(1.0, min(w, h))
        family_points = np.asarray(family_alt['points'], float)
        if (family_alt['metrics']['boundaryP95'] <= best['metrics']['boundaryP95'] + 1.0
                and family_alt['metrics']['edgeSupport'] >= best['metrics']['edgeSupport'] - 0.05):
            best = {'kind': family_alt['kind'],
                    'points': family_points.round(3).tolist(),
                    'metrics': family_alt['metrics'],
                    'score': round((1.0 - family_alt_cost) if family_alt_cost is not None
                                   else family_score(family_alt['metrics'], 1), 4),
                    'extra': {'corners': family_corners, 'native': family_native,
                              'from': 'declared-round', 'optimizer': optimizer_report,
                              'cornerRadius': round(float(family_radius) / max(1.0, min(w, h)), 4)}}
            candidates.append(best)
    # Never degrade the incoming element box: if the fit is no better in edge support and
    # noticeably worse in boundary error, keep the box geometry and report it as a fallback.
    anchored_lane = str((best.get('extra') or {}).get('from') or '') in ('panel-opt', 'declared-round')
    hopeless = (best['metrics']['boundaryP95'] >= 20.0
                and best['metrics']['boundaryP95'] > seed_metrics['boundaryP95'] - 2.0)
    degraded = (hopeless or (best['metrics']['boundaryP95'] > seed_metrics['boundaryP95'] + 8.0
                             and best['metrics']['edgeSupport'] <= seed_metrics['edgeSupport'] + 0.02))
    if best['kind'] != 'seed-box' and not anchored_lane and degraded:
        if fitting_model in PANEL_MODELS:
            best = build_seed_round(e, box, fitting_model, dist, front)
        else:
            best = {'kind': 'seed-box', 'points': seed.round(3).tolist(), 'metrics': seed_metrics,
                    'score': round(family_score(seed_metrics, 0), 4), 'extra': {'fallback': 'seed-bbox'}}
    # panel-like models: no fill-hull outline (a fill hull merges neighbouring columns)
    if fitting_model in PANEL_MODELS:
        panel_candidates = [c for c in candidates if c['kind'] not in ('fill-panel',)]
        if panel_candidates:
            candidates = panel_candidates
            candidates.sort(key=lambda c: (-round(c['score'], 3),
                                           {'pill': 0, 'roundRect': 1, 'seed-round': 2, 'roundPanel': 2,
                                            'rect-sharp': 3, 'parallelogram-sharp': 3,
                                            'cutPanel': 4, 'freeform': 6,
                                            'freeform-curve': 6}.get(c['kind'], 5)))
            if best['kind'] == 'fill-panel':
                best = candidates[0]
    # per-model acceptance gate: only accept when the class profile's precision holds
    occlusion_evidence = occlusion_boundary_metrics(best['points'], dist, front)
    if profile is not DEFAULT_PROFILE:
        chosen_metrics = best['metrics']
        gate_metrics = chosen_metrics
        if occlusion_evidence['hiddenFraction'] > 0.12 and occlusion_evidence['samples'] >= 24:
            # occluded elements: judge the fit on the visible boundary only
            gate_metrics = {'edgeSupport': occlusion_evidence['support'],
                            'boundaryP95': occlusion_evidence['p95'],
                            'visibleCoverage': chosen_metrics.get('visibleCoverage', 1.0)}
            best['metrics']['visibleSupport'] = round(occlusion_evidence['support'], 4)
            best['metrics']['visibleP95'] = round(occlusion_evidence['p95'], 3)
        gate_fail = (gate_metrics['boundaryP95'] > profile['p95Max']
                     or gate_metrics.get('edgeSupport', 0) < profile['supportMin'])
        if fitting_model in ('QUAD', 'ROUND-QUAD'):
            gate_fail = gate_fail or chosen_metrics.get('visibleCoverage', 1.0) < 0.90
        if gate_fail and fitting_model in PANEL_MODELS:
            # weak-border panels: an ROI-anchored native shape (seed-round) is the correct
            # semantic result; never fall back to the raw freeform seed box.
            drift = _panel_bbox_drift(best['points'], box)
            fallbackish = str(best['kind']) in ('seed-box', 'box', 'fill-panel', 'roundPanel',
                                                'freeform', 'seed-round', 'seed-sharp')
            lane_parts = ((best.get('extra') or {}).get('optimizer') or {}).get('parts') or {}
            lane_strong = (str((best.get('extra') or {}).get('from') or '') == 'panel-opt'
                           and float(lane_parts.get('contrast') or 0.0) >= 0.55
                           and chosen_metrics.get('edgeSupport', 0) >= 0.55)
            strong_edge_evidence = (
                (chosen_metrics.get('edgeSupport', 0) >= 0.62
                 and chosen_metrics.get('orientedSupport', 0) >= 0.55)
                or (str((best.get('extra') or {}).get('from') or '').startswith('capsule-long-edges')
                    and chosen_metrics.get('edgeSupport', 0) >= 0.60
                    and chosen_metrics.get('boundaryP95', 99) <= 12.0))
            if (fallbackish or drift > 0.02 or str(best['kind']) == 'rect-sharp') and not lane_strong and not strong_edge_evidence:
                best = build_seed_round(e, box, fitting_model, dist, front)
        elif gate_fail:
            rescued = None
            if class_hint in prototype_classes:
                proto_kinds = ('hexagon', 'chevron', 'trapezoid', 'rightArrow', 'triangle')
                protos = [c for c in candidates if str(c['kind']) in proto_kinds]
                protos.sort(key=lambda c: (-round(c['score'], 3),
                                           proto_kinds.index(str(c['kind'])) if str(c['kind']) in proto_kinds else 9))
                if protos:
                    candidate = protos[0]
                    metrics = candidate['metrics']
                    if metrics['edgeSupport'] >= 0.30 and metrics['boundaryP95'] <= 8.0:
                        rescued = candidate
            if rescued is not None:
                best = rescued
            elif profile['fallback'] in ('seed-box', 'reject', 'keep', 'quad'):
                best = {'kind': 'seed-box', 'points': seed.round(3).tolist(), 'metrics': seed_metrics,
                        'score': round(family_score(seed_metrics, 0), 4),
                        'extra': {'fallback': 'profile-gate', 'model': fitting_model}}
    # weak-edge guard: when the page has no usable edge near the outline (e.g. white pills
    # on a white background), a drifted fit would score nothing; keep the ROI-anchored
    # native fallback instead of a boundary that lies in blank space.
    if (fitting_model in PANEL_MODELS and str(best['kind']) not in
            ('seed-box', 'seed-round', 'seed-sharp')):
        evidence = best['metrics']
        if evidence['edgeSupport'] < 0.25 and evidence['boundaryP95'] > 40.0:
            best = build_seed_round(e, box, fitting_model, dist, front)
            best['extra']['fallback'] = 'weak-edge-roi'
    proto_all_kinds = ('hexagon', 'chevron', 'trapezoid', 'rightArrow', 'triangle')
    if class_hint in prototype_classes and str(best['kind']) not in proto_all_kinds:
        proto_kinds = ('hexagon', 'chevron', 'trapezoid', 'rightArrow', 'triangle')
        prototypes = [c for c in candidates if str(c['kind']) in proto_kinds]
        prototypes.sort(key=lambda c: (-round(c['score'], 3),
                                       proto_kinds.index(str(c['kind'])) if str(c['kind']) in proto_kinds else 9))
        selected = None
        for candidate in prototypes:
            metrics = candidate['metrics']
            if metrics['edgeSupport'] >= 0.40 and metrics['boundaryP95'] <= 6.0:
                selected = candidate
                break
        if selected is None:
            # geometry is already measured but the winning lane was a custom/fill hull: convert
            # the measured bounds to the declared preset (preset-first rule, never custom).
            points = np.asarray(best['points'], float)
            lo = points.min(axis=0); hi = points.max(axis=0)
            box_best = (float(lo[0]), float(lo[1]), float(hi[0] - lo[0]), float(hi[1] - lo[1]))
            if box_best[2] >= 12 and box_best[3] >= 12:
                names = (class_hint,) if class_hint in ('hexagon', 'chevron', 'trapezoid', 'rightarrow', 'triangle') else ('hexagon',)
                proto_best = None
                for name in names:
                    depths = (0.10, 0.14, 0.18, 0.22, 0.26, 0.30, 0.34) if name == 'hexagon' else (0.18, 0.26, 0.34)
                    if name == 'hexagon' and e.get('_hexDepth') is not None:
                        depths = (float(e['_hexDepth']),)
                    for depth in depths:
                        pts = prototype_polygon(name, box_best,
                                                {'headDepth': depth, 'notchDepth': depth})
                        if pts is None:
                            continue
                        m = boundary_metrics(pts, dist, front, edge=edge)
                        if proto_best is None or (m['edgeSupport'] - 0.01 * m['boundaryP95']) > (
                                proto_best[1]['edgeSupport'] - 0.01 * proto_best[1]['boundaryP95']):
                            proto_best = (name, m, pts, depth)
                if proto_best is not None and (proto_best[1]['edgeSupport'] >= 0.35
                                               and proto_best[1]['boundaryP95'] <= 8.0):
                    name, m, pts, depth = proto_best
                    native = {'type': 'shape', 'shape': name,
                              'shapeGeometry': {'version': 2,
                                                ('notchDepth' if name == 'chevron' else 'headDepth'): depth}}
                    selected = {'kind': name, 'points': np.asarray(pts).round(3).tolist(),
                                'metrics': m, 'score': round(family_score(m, 2), 4),
                                'extra': {'native': native, 'from': 'prototype-from-measured-bounds'}}
        if class_hint in ('hexagon',) and e.get('_hexPoints'):
            hex_points = np.asarray(e['_hexPoints'], float)
            hex_metrics = boundary_metrics(hex_points, dist, front, edge=edge)
            if hex_metrics['edgeSupport'] >= 0.35 and hex_metrics['boundaryP95'] <= 10.0:
                native = {'type': 'shape', 'shape': 'hexagon',
                          'shapeGeometry': {'version': 2, 'headDepth': e.get('_hexDepth') or 0.25}}
                selected = {'kind': 'hexagon', 'points': hex_points.round(3).tolist(),
                            'metrics': hex_metrics, 'score': round(family_score(hex_metrics, 2), 4),
                            'extra': {'native': native, 'from': 'hex-six-edge'}}
        if selected is not None:
            best = selected
    if trusted_relocation is not None:
        short_side = max(1.0, min(w, h))
        prior_radius = 0.0
        adjustments = e.get('adjustments') or {}
        if isinstance(adjustments, dict):
            try:
                prior_radius = float(adjustments.get('adj') or 0) / 100000.0 * short_side
            except (TypeError, ValueError):
                prior_radius = 0.0
        if prior_radius < 1.0 and fitting_model == 'BUBBLE':
            prior_radius = short_side * 0.5
        prior_radius = max(0.0, min(short_side * 0.5, prior_radius))
        trusted_corners = uniform_corner_specs(prior_radius, short_side)
        trusted_points = panel_polygon([x, y, x + w, y + h], trusted_corners)
        trusted_metrics = boundary_metrics(trusted_points, dist, front, edge=edge)
        trusted_kind = 'pill' if prior_radius >= 0.42 * short_side else 'roundRect'
        trusted_native = panel_native_for(trusted_kind, (x, y, w, h), trusted_corners, prior_radius)
        best = {'kind': trusted_kind, 'points': trusted_points.round(3).tolist(),
                'metrics': trusted_metrics, 'score': round(family_score(trusted_metrics, 1), 4),
                'extra': {'corners': trusted_corners, 'native': trusted_native,
                          'from': 'trusted-relocation', 'cornerRadius': round(prior_radius / short_side, 4)}}
    # generic sanity guard: never return a box that barely overlaps its ROI or has an
    # implausible size (the final protection against any lane drifting away)
    tried_points = np.asarray(best['points'], float)
    if tried_points.ndim == 2 and len(tried_points) >= 3:
        bx0, by0 = tried_points.min(axis=0)
        bx1, by1 = tried_points.max(axis=0)
        inter_w = max(0.0, min(bx1, x + w) - max(bx0, x))
        inter_h = max(0.0, min(by1, y + h) - max(by0, y))
        roi_overlap = (inter_w * inter_h) / max(1.0, w * h)
        box_area_ratio = ((bx1 - bx0) * (by1 - by0)) / max(1.0, audit_w * audit_h)
        if bx0 < -8 or by0 < -8 or bx1 > WIDTH + 8 or by1 > HEIGHT + 8 or box_area_ratio > 4.0 or box_area_ratio < 0.15:
            best = {'kind': 'seed-box', 'points': seed.round(3).tolist(), 'metrics': seed_metrics,
                    'score': round(family_score(seed_metrics, 0), 4),
                    'extra': {'fallback': 'roi-hint-sanity', 'reason': round(box_area_ratio, 3)}}
    summary = []
    for c in candidates:
        row = {'kind': c['kind'], 'score': c['score'], 'metrics': c['metrics']}
        if 'corners' in c['extra']:
            row['corners'] = c['extra']['corners']
        if 'curveEvidence' in c['extra']:
            row['curveEvidence'] = c['extra']['curveEvidence']
        if 'quadRank' in c['extra']:
            row['quadRank'] = c['extra']['quadRank']
        summary.append(row)
    low_confidence = False
    declared = str(e.get('shape') or e.get('classHint') or '').lower()
    kind_map = {'roundrect': 'roundRect', 'rect': 'rect-sharp', 'ellipse': 'ellipse',
                'circle': 'circle', 'hexagon': 'hexagon', 'parallelogram': 'parallelogram-sharp',
                'trapezoid': 'trapezoid', 'chevron': 'chevron', 'pill': 'pill'}
    fallback_kinds = ('seed-box', 'box', 'fill-panel', 'freeform', 'freeform-curve',
                      'seed-round', 'seed-sharp')
    if (str(best.get('kind') or '') in fallback_kinds
            or (best.get('extra') or {}).get('fallback')) and declared in kind_map:
        roi_points = seed_polygon_of(e)
        if roi_points is not None and len(roi_points) >= 3:
            declared_kind = kind_map[declared]
            roi_metrics = boundary_metrics(roi_points, dist, front, edge=edge)
            roi_native = native_geometry(declared_kind, roi_points, [], box)
            best = {'kind': declared_kind,
                    'points': np.asarray(roi_points, float).round(3).tolist(),
                    'metrics': roi_metrics,
                    'score': round(family_score(roi_metrics, 2), 4),
                    'extra': {'native': roi_native, 'from': 'low-confidence-roi-shape',
                              'fallback': 'low-confidence'}}
            low_confidence = True
    chosen_native = best['extra'].get('native') or native_geometry(best['kind'], best['points'], best['extra'].get('corners'), box)
    chosen_kind = best['kind']
    native_deviation = (best.get('extra') or {}).get('nativeSnap')
    native_decision = {
        'stage': 'post-fit',
        'shape': chosen_native.get('shape'),
        'params': {key: value for key, value in chosen_native.items()
                   if key in ('bounds', 'shapeGeometry')},
        'deviation': native_deviation,
        'tolerance': round(max(2.2, 0.007 * max(float(w), float(h))), 2),
    }
    if str(chosen_native.get('shape')) != 'freeform' and str(chosen_kind) in (
            'freeform', 'freeform-curve', 'fill-panel', 'seed-round', 'seed-sharp'):
        geometry = chosen_native.get('shapeGeometry') or {}
        corners_out = geometry.get('corners') or []
        if str(chosen_native.get('shape')) == 'rect' and any(str(c.get('type')) == 'round' for c in corners_out):
            chosen_kind = 'roundRect'
        elif str(chosen_native.get('shape')) == 'rect' and any(str(c.get('type')) == 'cut' for c in corners_out):
            chosen_kind = 'cutPanel'
        elif str(chosen_native.get('shape')) == 'rect':
            chosen_kind = 'rect-sharp'
        elif str(chosen_native.get('shape')) == 'roundRect':
            chosen_kind = 'roundRect'
        elif str(chosen_native.get('shape')) == 'parallelogram':
            chosen_kind = 'parallelogram-sharp'
    occluded_fraction = round(1.0 - float(best['metrics'].get('visibleCoverage', 1.0)), 4)
    occluders = []
    try:
        bx0 = max(0, int(round(x))); by0 = max(0, int(round(y)))
        bx1 = min(WIDTH, bx0 + max(1, int(round(w)))); by1 = min(HEIGHT, by0 + max(1, int(round(h))))
        for other_index in range(index + 1, len(elements or [])):
            other = elements[other_index]
            ox = float(other.get('x') or 0); oy = float(other.get('y') or 0)
            ow = float(other.get('w') or 0); oh = float(other.get('h') or 0)
            if not (ox < x + w and ox + ow > x and oy < y + h and oy + oh > y):
                continue
            ix0 = max(bx0, int(math.floor(ox))); iy0 = max(by0, int(math.floor(oy)))
            ix1 = min(bx1, int(math.ceil(ox + ow))); iy1 = min(by1, int(math.ceil(oy + oh)))
            if ix1 - ix0 < 2 or iy1 - iy0 < 2:
                continue
            if front is not None and getattr(front, 'size', 0):
                covered = int(front[iy0:iy1, ix0:ix1].sum())
                if covered < max(20, int(0.03 * (ix1 - ix0) * (iy1 - iy0))):
                    continue
            occluders.append(other.get('key'))
    except Exception:
        occluders = []
    return {
        'key': key,
        'roi': {'x': round(original_box[0], 2), 'y': round(original_box[1], 2),
                'w': round(original_box[2], 2), 'h': round(original_box[3], 2)},
        'seed': {'points': seed.round(3).tolist(), 'metrics': seed_metrics},
        'families': {side: [{'angle': round(f['angle'], 2), 'pos': round(family_pos(f), 2), 'span': round(f['span'], 1), 'total': round(f['total'], 1), 'segments': len(f['lines'])} for f in items] for side, items in sides.items()},
        'candidates': summary,
        'chosen': {'kind': chosen_kind, 'points': best['points'], 'metrics': best['metrics'], 'score': best['score'],
                   'corners': best['extra'].get('corners'), 'curveEvidence': best['extra'].get('curveEvidence'),
                   'quad': (quad.round(3).tolist() if quad is not None else None),
                   'anchoredQuad': (anchored_best.round(3).tolist() if anchored_best is not None else None),
                   'native': chosen_native,
                   'skew': best['extra'].get('skew')},
        'occludedFraction': occluded_fraction,
        'occlusion': {'hiddenFraction': occlusion_evidence['hiddenFraction'],
                      'occluders': occluders,
                      'layer': index,
                      'visibleSupport': round(occlusion_evidence['support'], 4),
                      'visibleP95': round(occlusion_evidence['p95'], 3),
                      'hiddenSides': [edge for edge, side in occlusion_evidence['sides'].items()
                                      if side['hidden'] > 0.4],
                      'completion': ('hidden-side-extrapolated'
                                     if (best.get('extra') or {}).get('completedSides')
                                     else 'visible-only-fit' if occlusion_evidence['hiddenFraction'] > 0.12
                                     else 'none')},
        'optimizer': optimizer_report,
        'model': fitting_model,
        'roiShift': roi_shift,
        'relocation': relocation,
        'edgeMap': ('color' if used_color_map else 'canny'),
        'profileShift': profile_shift,
        'roiScore': float(round(roi_score, 4) if roi_score else 0.0),
        'routing': routed,
        'nativeDecision': native_decision,
        'lowConfidence': bool(low_confidence),
        'provenance': perimeter_provenance(best['points'], dist, front, elements, e),
        'inward': inward_line_profile(best['points'], dist, front, e),
        'colorBoundary': color_boundary_profile(best['points'], front),
        'colorJump': color_jump_profile(best['points'], front),
        'colorOwnership': color_ownership_profile(best['points'], front, e),
        'segBoundary': segmentation_boundary_profile(best['points'], front),
        'orientedBoundary': oriented_boundary_profile(best['points'], front),
        'synthesis': synthesis_consistency(best['points'], dist, front),
        'boundaryCompleteness': boundary_completeness(best['points'], dist, front, elements, e),
        'appearance': appearance,
        'strategy': ('fill-contrast' if (best['extra'].get('strategy') == 'fill-contrast')
                     else 'edge-line-with-fill-fallback' if use_fill_lane else 'edge-line'),
    }


def freeform_contour(edge, box, front):
    x, y, w, h = box
    pad = 6
    x0, y0 = max(0, int(x) - pad), max(0, int(y) - pad)
    x1, y1 = min(WIDTH, int(math.ceil(x + w)) + pad), min(HEIGHT, int(math.ceil(y + h)) + pad)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    roi = edge[y0:y1, x0:x1].copy()
    roi[front[y0:y1, x0:x1]] = 0
    roi = cv2.morphologyEx(roi, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours = cv2.findContours(roi, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    if cv2.contourArea(contour) < w * h * .35:
        return None
    approx = cv2.approxPolyDP(contour, 2.5, True)[:, 0, :].astype(np.float64) + np.array([x0, y0])
    if len(approx) < 4 or len(approx) > 40:
        return None
    return approx


# ---------------------------------------------------------------- overlay
def draw_overlay(ref, result, elements, out_path):
    canvas = cv2.cvtColor(ref, cv2.COLOR_RGB2BGR).copy()
    for carrier in result.get('missing') or []:
        chosen = carrier.get('shape', {}).get('chosen') or {}
        if not chosen.get('points'):
            continue
        pts = np.asarray(chosen['points'], np.int32).reshape(-1, 1, 2)
        cv2.polylines(canvas, [pts], True, (255, 180, 0), 2)
        x, y = int(pts[0][0][0]), int(pts[0][0][1])
        cv2.putText(canvas, 'carrier:' + str(carrier.get('headingKey', '')), (max(2, x), max(14, y - 6)), cv2.FONT_HERSHEY_SIMPLEX, .45, (255, 180, 0), 1)
    for item in result['elements']:
        chosen = item['chosen']
        raw_points = np.asarray(chosen['points'], float)
        if str(chosen.get('kind')) == 'line' or len(raw_points) <= 2:
            if len(raw_points) >= 2:
                cv2.line(canvas, tuple(raw_points[0].astype(int)), tuple(raw_points[-1].astype(int)),
                         (0, 220, 0), 3)
            if item.get('seed'):
                seed_points = np.asarray(item['seed']['points'], float)
                if len(seed_points) >= 2:
                    cv2.line(canvas, tuple(seed_points[0].astype(int)), tuple(seed_points[-1].astype(int)),
                             (255, 0, 0), 1)
            continue
        pts = raw_points.astype(np.int32).reshape(-1, 1, 2)
        cv2.polylines(canvas, [pts], True, (0, 220, 0), 2)
        for corner in chosen.get('corners') or []:
            pass
        color = {'rect': (0, 220, 0), 'cutPanel': (0, 220, 0)}.get(chosen['kind'], (0, 180, 255))
        cv2.polylines(canvas, [pts], True, color, 2)
        if item.get('seed'):
            seed = np.asarray(item['seed']['points'], np.int32).reshape(-1, 1, 2)
            cv2.polylines(canvas, [seed], True, (255, 0, 0), 1)
        if item.get('optimizer'):
            cv2.polylines(canvas, [pts], True, (255, 255, 0), 1)
        for corner in chosen.get('corners') or []:
            if corner.get('type') == 'cut':
                cv2.putText(canvas, 'cut', (int(item['roi']['x']) + 6, int(item['roi']['y']) + 16), cv2.FONT_HERSHEY_SIMPLEX, .45, (0, 255, 255), 1)
                break
    cv2.imwrite(out_path, canvas)


# ---------------------------------------------------------------- heading carriers (missing shapes)
def detect_heading_band(ref, families, heading, parent):
    """Find the heading carrier band from existing line families (top/bottom rules)."""
    hx, hy, hw, hh = box_of(heading)
    px, py, pw, ph = box_of(parent)
    horizontals = [f for f in families if f['horizontal']]
    tol_top = max(8.0, ph * .04)
    tops = [f for f in horizontals if abs(family_pos(f) - py) <= tol_top]
    top = min(tops, key=lambda f: abs(family_pos(f) - py)) if tops else None
    target = hy + hh - hh * .15
    bottoms = [f for f in horizontals
               if hy + hh * .45 <= family_pos(f) <= hy + hh + 70
               and f['span'] >= max(60.0, hw * .5)]
    bottom = min(bottoms, key=lambda f: abs(family_pos(f) - target)) if bottoms else None
    if top is None or bottom is None:
        return None
    y0 = float(family_pos(top))
    y1 = float(family_pos(bottom))
    if y1 - y0 < max(36.0, hh * .6) or y1 - y0 > ph * .55:
        return None
    x0, x1 = int(px + 2), int(min(WIDTH, px + pw - 2))
    smooth = cv2.medianBlur(ref, 9).astype(float)
    band = smooth[int(y0 + 6):int(y1 - 6), x0:x1].mean(axis=0)
    body_y0 = int(min(py + ph - 20, y1 + 70))
    body_y1 = int(min(py + ph - 6, y1 + 190))
    if body_y1 - body_y0 < 24:
        return None
    body = smooth[body_y0:body_y1, x0:x1].mean(axis=0)
    contrast = float((band - body).mean())
    if contrast < 4.0:
        return None
    return {
        'x': float(px), 'y': y0, 'w': float(pw), 'h': y1 - y0,
        'contrast': round(contrast, 2),
        'confidence': round(min(0.95, .5 + contrast / 60.0), 2),
    }


def snap_band_seed(seed, families, box_parent):
    """Snap detected band bbox to nearby line families (top/bottom horizontal, sides)."""
    if isinstance(seed, dict):
        x, y, w, h = seed['x'], seed['y'], seed['w'], seed['h']
    else:
        x, y, w, h = seed
    result = {'x': x, 'y': y, 'w': w, 'h': h}
    if isinstance(seed, dict):
        for key in ('contrast', 'confidence'):
            if key in seed:
                result[key] = seed[key]
    horizontal = [f for f in families if f['horizontal']]
    verticals = [f for f in families if f['vertical'] or abs(math.cos(math.radians(f['angle']))) < .45]
    tol_y = max(6.0, h * .10)
    for side, target in (('top', y), ('bottom', y + h)):
        candidates = [f for f in horizontal if abs(family_pos(f) - target) <= tol_y]
        if candidates:
            pos = min(candidates, key=lambda f: abs(family_pos(f) - target))
            new_pos = float(family_pos(pos))
            if side == 'top':
                result['h'] = result['h'] + (result['y'] - new_pos)
                result['y'] = new_pos
            else:
                result['h'] = new_pos - result['y']
    return result


def detect_heading_carriers(ref, families, lines, elements, heading_node_ids, edge=None):
    """Fit heading carrier plates: same straight-edge machinery on a detected band seed."""
    if not heading_node_ids:
        return []
    ids = set(heading_node_ids)
    headings = [e for e in elements if e.get('type') == 'text' and e.get('nodeId') in ids]
    carriers = []
    for heading in headings:
        hx, hy, hw, hh = box_of(heading)
        parents = [e for e in elements if e.get('type') in ('rect', 'shape', 'ellipse')
                   and float(e.get('fillOpacity', 1)) > 0
                   and e['x'] <= hx + hw / 2 <= e['x'] + e['w'] and e['y'] <= hy + hh / 2 <= e['y'] + e['h']]
        if not parents:
            continue
        parent = min(parents, key=lambda e: e['w'] * e['h'])
        seed = detect_heading_band(ref, families, heading, parent)
        if seed is None:
            continue
        seed = snap_band_seed(seed, families, box_of(parent))
        if seed['w'] < 40 or seed['h'] < 24:
            continue
        synthetic = {'key': 'heading-carrier-' + str(heading.get('nodeId') or heading['key'])[:40],
                     'type': 'shape', 'x': seed['x'], 'y': seed['y'], 'w': seed['w'], 'h': seed['h'],
                     'fillOpacity': 1, 'role': 'carrier'}
        parent_index = elements.index(parent)
        working = elements[:parent_index + 1] + [synthetic] + elements[parent_index + 1:]
        index = parent_index + 1
        front = front_mask_for(working, index, {}, [])
        edge_map, dist = edge_maps(ref, front)
        item = fit_element(synthetic, index, working, families, lines, edge_map, dist, front)
        if item is None:
            continue
        item['_dist'] = dist
        item['_front'] = front
        item['_edge'] = edge_map
        item['_box'] = box_of(synthetic)
        band_mask = np.zeros((HEIGHT, WIDTH), bool)
        bx0, by0 = max(0, int(seed['x'])), max(0, int(seed['y']))
        bx1, by1 = min(WIDTH, int(math.ceil(seed['x'] + seed['w']))), min(HEIGHT, int(math.ceil(seed['y'] + seed['h'])))
        if bx1 > bx0 and by1 > by0:
            band_mask[by0:by1, bx0:bx1] = True
            band_mask &= ~front
        fill_hex = None
        if band_mask.sum() > 200:
            pixels = ref[band_mask].astype(float)
            median = np.median(pixels, axis=0)
            fill_hex = ''.join(f'{int(round(value)):02X}' for value in median)
        carriers.append({
            'kind': 'carrier',
            'subkind': 'heading-carrier',
            'fill': fill_hex,
            'parentKey': parent['key'],
            'textNodeIds': [heading.get('nodeId')],
            'headingKey': heading['key'],
            'region': {'x': round(seed['x'], 2), 'y': round(seed['y'], 2), 'w': round(seed['w'], 2), 'h': round(seed['h'], 2)},
            'bandContrast': seed.get('contrast'),
            'shape': item,
            'confidence': seed.get('confidence'),
        })
    return carriers


# ---------------------------------------------------------------- constrained merge
def constrain_quad(quad):
    """Project a fitted quad onto a true parallelogram: horizontal top/bottom and one
    common slant for both sides, so neighbours can be aligned edge-to-edge."""
    quad = np.asarray(quad, float)
    top_y = float((quad[0][1] + quad[1][1]) / 2.0)
    bottom_y = float((quad[2][1] + quad[3][1]) / 2.0)
    shift = float(((quad[3][0] - quad[0][0]) + (quad[2][0] - quad[1][0])) / 2.0)
    top_left = float((quad[0][0] + (quad[3][0] - shift)) / 2.0)
    top_right = float((quad[1][0] + (quad[2][0] - shift)) / 2.0)
    return np.array([[top_left, top_y], [top_right, top_y], [top_right + shift, bottom_y], [top_left + shift, bottom_y]], float)


def panel_quad(base, index, width, step, shift, top_y, bottom_y):
    tl_x = base + index * step
    return np.array([[tl_x, top_y], [tl_x + width, top_y],
                     [tl_x + width + shift, bottom_y], [tl_x + shift, bottom_y]], float)


def merge_parallelogram_group(keys, element_items):
    """Unify the family's height and slant (so neighbouring sides are parallel and the
    top/bottom rules line up), then re-optimize each panel's own width/position against
    its edge evidence instead of forcing one shared width that fights the reference."""
    items = [(key, element_items[key]) for key in keys if key in element_items]
    if len(items) < 2:
        return None
    constrained = []
    for key, item in items:
        quad_source = item['chosen'].get('anchoredQuad') or item['chosen'].get('quad')
        if quad_source is None or len(quad_source) != 4:
            points = np.asarray(item['chosen']['points'], float)
            if len(points) < 4:
                continue
            quad_source = points[:4]
        raw_points = np.asarray(quad_source, float)
        box_hint = item.get('_box')
        if box_hint is None:
            box_hint = [raw_points[:, 0].min(), raw_points[:, 1].min(),
                        max(1.0, raw_points[:, 0].max() - raw_points[:, 0].min()),
                        max(1.0, raw_points[:, 1].max() - raw_points[:, 1].min())]
        if not quad_is_sane(raw_points, box_hint):
            continue
        quad = constrain_quad(raw_points)
        constrained.append({
            'key': key, 'item': item,
            'top': float((quad[0][1] + quad[1][1]) / 2.0),
            'bottom': float((quad[2][1] + quad[3][1]) / 2.0),
            'shift': float(((quad[3][0] - quad[0][0]) + (quad[2][0] - quad[1][0])) / 2.0),
            'width': float(quad[1][0] - quad[0][0]),
            'left': float(quad[0][0]),
        })
    if len(constrained) < 2:
        return None
    constrained.sort(key=lambda entry: entry['left'])
    top_y = float(np.median([entry['top'] for entry in constrained]))
    bottom_y = float(np.median([entry['bottom'] for entry in constrained]))
    shift = float(np.median([entry['shift'] for entry in constrained]))
    merged = {}
    for entry in constrained:
        item = entry['item']
        best = None
        for width_delta in np.arange(-6, 6.01, 2.0):
            for left_delta in np.arange(-8, 8.01, 1.0):
                width = entry['width'] + width_delta
                left = entry['left'] + left_delta
                quad = np.array([[left, top_y], [left + width, top_y],
                                 [left + width + shift, bottom_y], [left + shift, bottom_y]], float)
                metrics = boundary_metrics(quad, item['_dist'], item['_front'], spacing=2.0)
                score = metrics['edgeSupport'] - 0.001 * max(0.0, metrics['boundaryP95'] - 1.5)
                if best is None or score > best[0]:
                    best = (score, width, left, quad, metrics)
        _score, width, left, quad, metrics = best
        merged[entry['key']] = {
            'quad': quad, 'metrics': metrics,
            'x': round(float(left), 2), 'y': round(top_y, 2), 'w': round(float(width), 2),
            'h': round(bottom_y - top_y, 2), 'shift': round(shift, 2),
            # Native parallelogram bbox width = top width + |shift| (the element bbox spans
            # both edges). shift is bottom-right minus top-right, so a negative shift means
            # the top edge sits to the right => slantSign +1.
            'headDepth': round(abs(shift) / max(1e-6, width + abs(shift)), 4),
            'slantSign': 1 if shift < 0 else -1,
        }
    ordered_keys = [entry['key'] for entry in constrained]
    lefts = [merged[key]['x'] for key in ordered_keys]
    widths = [merged[key]['w'] for key in ordered_keys]
    gaps = [lefts[i + 1] - (lefts[i] + widths[i]) for i in range(len(lefts) - 1)]
    if gaps:
        target_gap = max(float(np.median(gaps)), 8.0)
        positions = [lefts[0]]
        for i in range(len(ordered_keys) - 1):
            positions.append(positions[-1] + widths[i] + target_gap)
        for i in range(1, len(ordered_keys)):
            shift_x = positions[i] - lefts[i]
            if abs(shift_x) < 1e-9:
                continue
            quad = np.asarray(merged[ordered_keys[i]]['quad'], float)
            quad[:, 0] += shift_x
            merged[ordered_keys[i]]['quad'] = quad
            if 'metrics' in merged[ordered_keys[i]]:
                del merged[ordered_keys[i]]['metrics']
        for key in ordered_keys:
            merged[key]['x'] = round(float(merged[key]['quad'][0][0]), 3)
    lefts = [merged[key]['x'] for key in ordered_keys]
    rights = [merged[key]['x'] + merged[key]['w'] for key in ordered_keys]
    gaps = [round(lefts[i + 1] - rights[i], 2) for i in range(len(lefts) - 1)]
    return {'keys': ordered_keys, 'top': round(top_y, 2), 'bottom': round(bottom_y, 2),
            'shift': round(shift, 2), 'gap': gaps, 'items': merged}


def apply_family_merge(result, groups_spec, lines=None):
    reports = []
    by_key = {item['key']: item for item in result['elements']}
    for group in groups_spec or []:
        keys = [key for key in group.get('keys', []) if key in by_key]
        if len(keys) < 2:
            continue
        merged = merge_parallelogram_group(keys, by_key)
        if merged is None:
            continue
        for key, info in merged['items'].items():
            item = by_key[key]
            item['chosen']['points'] = info['quad'].round(3).tolist()
            item['chosen']['kind'] = 'parallelogram-merged'
            item['chosen']['metrics'] = info.get('metrics') or boundary_metrics(info['quad'], item['_dist'], item['_front'])
            item['chosen']['native'] = {'type': 'shape', 'shape': 'parallelogram',
                                        'shapeGeometry': {'version': 2, 'headDepth': info['headDepth'], 'slantSign': info['slantSign']}}
            item['chosen']['merged'] = True
            item['chosen']['mergeInfo'] = {key: (float(value) if isinstance(value, (int, float, np.floating)) else value)
                                           for key, value in info.items() if key != 'quad'}
        report = {'family': group.get('family', 'family'), 'type': 'parallelogram-panels'}
        for field in ('keys', 'top', 'bottom', 'shift', 'width', 'step', 'gap'):
            if field in merged:
                report[field] = merged[field]
        report['items'] = {key: {k: v for k, v in info.items() if k in ('x', 'y', 'w', 'h', 'shift', 'headDepth')} for key, info in merged['items'].items()}
        reports.append(report)
    carriers = [carrier for carrier in (result.get('missing') or []) if carrier.get('subkind') == 'heading-carrier']
    if len(carriers) >= 2:
        # Detect bevels again on the constrained (true-parallelogram) band outline so the
        # measured cut belongs to the same outline that will be written to the deck.
        evidence = []
        constrained_by_key = {}
        for carrier in carriers:
            shape = carrier['shape']
            quad_seed = shape['chosen'].get('quad')
            if not quad_seed:
                continue
            quad = constrain_quad(np.asarray(quad_seed, float))
            constrained_by_key[carrier['headingKey']] = quad
            box = box_of({'x': quad[:, 0].min(), 'y': quad[:, 1].min(),
                          'w': quad[:, 0].max() - quad[:, 0].min(), 'h': quad[:, 1].max() - quad[:, 1].min()})
            for index in range(4):
                corner = detect_corner(quad, index, lines, shape.get('_edge'), shape['_dist'], shape['_front'], box)
                if corner.get('type') == 'cut' and corner.get('cut'):
                    evidence.append((float(corner.get('confidence') or 0), index, corner['cut'], carrier['headingKey']))
        evidence.sort(key=lambda entry: -entry[0])
        if evidence:
            confidence, index, _cut, _key = evidence[0]
            cuts = [entry[2] for entry in evidence if entry[1] == index]
            median_cut = [float(np.median([cut[0] for cut in cuts])), float(np.median([cut[1] for cut in cuts]))]
            applied = 0
            for carrier in carriers:
                shape = carrier['shape']
                quad = constrained_by_key.get(carrier['headingKey'])
                if quad is None:
                    continue
                corners = [{'type': 'sharp'} for _ in range(4)]
                corners[index] = {'type': 'cut', 'confidence': round(min(0.95, confidence), 3),
                                  'cut': median_cut, 'support': 0.9, 'merged': True}
                points = corner_polygon(quad, corners)
                metrics = boundary_metrics(points, shape['_dist'], shape['_front'])
                shape['chosen']['points'] = points.round(3).tolist()
                shape['chosen']['kind'] = 'cutPanel'
                shape['chosen']['corners'] = corners
                shape['chosen']['metrics'] = metrics
                lo = points.min(axis=0)
                hi = points.max(axis=0)
                size = np.maximum(1e-6, hi - lo)
                normalized = [[float((p[0] - lo[0]) / size[0]), float((p[1] - lo[1]) / size[1])] for p in points]
                shape['chosen']['native'] = {'type': 'shape', 'shape': 'freeform',
                                             'bounds': {'x': round(float(lo[0]), 2), 'y': round(float(lo[1]), 2),
                                                        'w': round(float(size[0]), 2), 'h': round(float(size[1]), 2)},
                                             'customGeometry': {'points': [[round(px, 4), round(py, 4)] for px, py in normalized], 'closed': True}}
                shape['chosen']['mergeInfo'] = {'corner': index, 'cut': median_cut, 'familyConsensus': True,
                                                'sourceKey': _key, 'sourceConfidence': round(confidence, 3)}
                applied += 1
            reports.append({'family': 'heading-carriers', 'type': 'bevel-consensus', 'corner': index,
                            'cut': median_cut, 'source': _key, 'confidence': round(confidence, 3), 'applied': applied})
    for item in result['elements']:
        for key in ('_dist', '_front', '_box', '_edge'):
            item.pop(key, None)
    for carrier in result.get('missing') or []:
        shape = carrier.get('shape') or {}
        for key in ('_dist', '_front', '_box', '_edge'):
            shape.pop(key, None)
    return reports


# ---------------------------------------------------------------- main
def run(spec):
    global _REF, PANEL_OPT, _SEG_DIST, _SEG_EDGE, _GRAD_MAG, _GRAD_DX, _GRAD_DY, _FG_MASK, _FG_EDGE, _FG_GRAD, _SEG_DIST_ENH, _SEG_EDGE_ENH, _GRAD_MAG_ENH, _GRAD_DX_ENH, _GRAD_DY_ENH, _FG_MASK_ENH, _FG_EDGE_ENH, _FG_GRAD_ENH
    if 'panelOpt' in spec:
        PANEL_OPT = bool(spec.get('panelOpt'))
    started = time.perf_counter()
    ref = load_ref(spec['reference'])
    global _REF_LAB, _JUMP_THRESHOLD, _REF_ENH
    _REF = ref
    _REF_ENH = enhance_reference(ref)
    _REF_LAB = cv2.cvtColor(ref, cv2.COLOR_RGB2LAB)
    prepare_segmentation(ref)
    prepare_oriented_gradients(ref)
    try:
        labf = _REF_LAB.astype(np.float32)
        dx = np.linalg.norm(labf[:, 3:, :] - labf[:, :-3, :], axis=2)
        dy = np.linalg.norm(labf[3:, :, :] - labf[:-3, :, :], axis=2)
        scale = float(np.percentile(np.maximum(dx, dy), 90.0))
        _JUMP_THRESHOLD = max(4.0, min(14.0, 0.38 * scale))
    except Exception:
        _JUMP_THRESHOLD = 10.0
    prepare_background_evidence(ref, load_ref(spec['background']) if spec.get('background') else None)
    try:
        enhanced_background = enhance_reference(load_ref(spec['background'])) if spec.get('background') else None
        prepare_segmentation(_REF_ENH)
        _SEG_DIST_ENH = _SEG_DIST; _SEG_EDGE_ENH = _SEG_EDGE
        prepare_oriented_gradients(_REF_ENH)
        _GRAD_MAG_ENH = _GRAD_MAG; _GRAD_DX_ENH = _GRAD_DX; _GRAD_DY_ENH = _GRAD_DY
        if enhanced_background is not None:
            prepare_background_evidence(_REF_ENH, enhanced_background)
            _FG_MASK_ENH = _FG_MASK; _FG_EDGE_ENH = _FG_EDGE; _FG_GRAD_ENH = _FG_GRAD
        prepare_segmentation(ref)
        prepare_oriented_gradients(ref)
        prepare_background_evidence(ref, load_ref(spec['background']) if spec.get('background') else None)
    except Exception:
        pass
    elements = spec.get('elements') or []
    raw_masks = spec.get('masks') or {}
    masks = {}
    if isinstance(raw_masks, list):
        # Staged pipeline passes object-mask entries [{key, file, hash}] (HTML-export style);
        # committed native_frame_fit passes in-memory arrays. Accept both.
        for entry in raw_masks:
            if not isinstance(entry, dict) or entry.get('unavailable'):
                continue
            key = entry.get('key')
            file = entry.get('file')
            if not key or not file or not os.path.exists(str(file)):
                continue
            alpha = cv2.imread(str(file), cv2.IMREAD_GRAYSCALE)
            if alpha is None:
                continue
            if alpha.shape[1] != WIDTH or alpha.shape[0] != HEIGHT:
                alpha = cv2.resize(alpha, (WIDTH, HEIGHT), interpolation=cv2.INTER_NEAREST)
            masks[key] = alpha
    elif isinstance(raw_masks, dict):
        for key, value in raw_masks.items():
            if value is None:
                continue
            alpha = np.asarray(value, np.float32)
            if alpha.ndim != 2:
                continue
            if alpha.shape[1] != WIDTH or alpha.shape[0] != HEIGHT:
                alpha = cv2.resize(alpha, (WIDTH, HEIGHT), interpolation=cv2.INTER_NEAREST)
            masks[key] = alpha
    target_keys = spec.get('targetKeys')
    line_keys = {e.get('key') for e in elements
                 if e.get('type') == 'line' and not e.get('managed')
                 and (target_keys is None or e.get('key') in target_keys)}
    line_results = []
    if line_keys:
        try:
            line_proposals, _line_diagnostics = fit_native_lines(ref, elements, None, line_keys)
        except Exception:
            line_proposals = []
        for proposal in line_proposals or []:
            element = next((item for item in elements if item.get('key') == proposal.get('key')), None)
            props = proposal.get('properties') or {}
            if element is None or not props:
                continue
            x = float(props.get('x', element.get('x', 0))); y = float(props.get('y', element.get('y', 0)))
            w = float(props.get('w', element.get('w', 0))); h = float(props.get('h', element.get('h', 0)))
            flip_h = bool(props.get('flipH')); flip_v = bool(props.get('flipV'))
            ax = x + w if flip_h else x; ay = y + h if flip_v else y
            bx = x if flip_h else x + w; by = y if flip_v else y + h
            residual = float(proposal.get('medianResidual') or 0.0)
            support = float(proposal.get('support') or 0.0)
            metrics = {'edgeSupport': support, 'boundaryP95': residual, 'chamfer': residual,
                       'visibleCoverage': 1.0, 'samples': 0, 'supportLength': 0}
            points = [[ax, ay], [bx, by]]
            line_results.append({
                'key': element['key'],
                'roi': {'x': round(x, 2), 'y': round(y, 2), 'w': round(w, 2), 'h': round(h, 2)},
                'seed': {'points': points, 'metrics': metrics},
                'families': {},
                'candidates': [{'kind': 'line', 'score': 1.0, 'metrics': metrics,
                                'points': points, 'extra': {'from': 'native-line-fit'}}],
                'chosen': {'kind': 'line', 'points': points, 'metrics': metrics, 'score': 1.0,
                           'native': {'type': 'line',
                                      'bounds': {'x': round(x, 2), 'y': round(y, 2),
                                                 'w': round(w, 2), 'h': round(h, 2)},
                                      'flipH': flip_h, 'flipV': flip_v,
                                      'strokeWidth': props.get('strokeWidth'),
                                      'color': props.get('color'),
                                      'gradient': props.get('gradient')},
                           'extra': {'from': 'native-line-fit'}},
                'occludedFraction': 0.0,
                'optimizer': None,
                'model': 'LINE',
                'roiShift': [0.0, 0.0, 0.0, 0.0],
                'relocation': None,
                'edgeMap': 'canny',
                'profileShift': [0.0, 0.0, 0.0, 0.0],
                'roiScore': 1.0,
                'routing': {'class': 'line'},
                'nativeDecision': {'stage': 'post-fit', 'shape': 'line',
                                   'deviation': residual, 'tolerance': 2.0},
                'appearance': {'hasGradient': bool(props.get('gradient'))},
                'strategy': 'line-centreline',
            })
    explicit_exclude = spec.get('exclude') or []
    lines_all = long_edges(ref)
    asset_elements = [element for element in elements if element_is_asset(element)]
    edge_ignored_assets = [
        element for element in asset_elements
        if str(element.get('type') or '').lower() in ('svg', 'cutout', 'crop', 'generate')
        or str(element.get('classHint') or element.get('elementClass') or '').lower()
        in ('svg', 'icon', 'ai-cutout', 'cutout', 'glyph', 'logo')
    ]
    asset_boxes = [box_of(element) for element in edge_ignored_assets]
    lines_for_fit = filter_asset_lines(lines_all, asset_boxes)
    lines_for_fit_enh = filter_asset_lines(long_edges(_REF_ENH), asset_boxes) if _REF_ENH is not None else lines_for_fit
    page_lab = cv2.cvtColor(ref, cv2.COLOR_RGB2LAB)
    dark_page = float(np.median(page_lab[:, :, 0])) < 120.0
    global _FIT_LINES
    _FIT_LINES = lines_for_fit
    families = build_families(lines_for_fit)
    ignored_assets = [element.get('key') for element in asset_elements]
    results = []
    errors = []
    for index, e in enumerate(elements):
        if target_keys is not None and e.get('key') not in target_keys:
            continue
        if e.get('managed') or str(e.get('key') or '').startswith('nf-'):
            continue
        if e.get('type') == 'line':
            continue
        if element_is_asset(e):
            ignored_assets.append(e.get('key'))
            continue
        front = front_mask_for(elements, index, masks, explicit_exclude)
        excluded = front.copy()
        element_ref = ref
        contrast = boundary_contrast_score(e, ref)
        use_enhanced_edges = bool(dark_page and contrast < 20.0 and _REF_ENH is not None)
        enh_saved = None
        if use_enhanced_edges:
            element_ref = _REF_ENH
            enh_saved = (_SEG_DIST, _SEG_EDGE, _GRAD_MAG, _GRAD_DX, _GRAD_DY,
                         _FG_MASK, _FG_EDGE, _FG_GRAD)
            if _SEG_DIST_ENH is not None:
                _SEG_DIST, _SEG_EDGE = _SEG_DIST_ENH, _SEG_EDGE_ENH
            if _GRAD_MAG_ENH is not None:
                _GRAD_MAG, _GRAD_DX, _GRAD_DY = _GRAD_MAG_ENH, _GRAD_DX_ENH, _GRAD_DY_ENH
            if _FG_EDGE_ENH is not None:
                _FG_MASK, _FG_EDGE, _FG_GRAD = _FG_MASK_ENH, _FG_EDGE_ENH, _FG_GRAD_ENH
        e['_contrast'] = round(contrast, 2)
        e['_edgeRef'] = 'enhanced' if element_ref is not ref else 'original'
        edge, dist = edge_maps(element_ref, excluded)
        fg_edge = foreground_edges(front)
        if fg_edge is not None:
            combined = np.maximum(edge, fg_edge)
            edge = combined
            dist = cv2.distanceTransform((combined == 0).astype(np.uint8), cv2.DIST_L2, 3)
        active_lines = lines_for_fit_enh if use_enhanced_edges else lines_for_fit
        _FIT_LINES = active_lines
        ex, ey, ew, eh = box_of(e)
        owned_lines = []
        for line in active_lines:
            mid = (line['a'] + line['b']) / 2.0
            xi, yi = int(round(mid[0])), int(round(mid[1]))
            if not (0 <= xi < WIDTH and 0 <= yi < HEIGHT) or front[yi, xi]:
                continue
            owned_lines.append(line)
        element_families = build_families(owned_lines)
        merge_keys = set()
        for group in spec.get('mergeFamilies') or []:
            merge_keys.update(group.get('keys') or [])
        if e.get('key') in merge_keys:
            e['_mergeFamily'] = True
        e['_fromAudit'] = True
        try:
            item = fit_element(e, index, elements, element_families, owned_lines, edge, dist, front)
            if item is not None:
                item = improve_fit(e, item, index, elements, element_families, owned_lines, edge, dist, front, element_ref, excluded)
        except Exception as fit_error:
            item = None
            errors.append({'key': e.get('key'), 'error': str(fit_error)[:200]})
        if enh_saved is not None:
            (_SEG_DIST, _SEG_EDGE, _GRAD_MAG, _GRAD_DX, _GRAD_DY,
             _FG_MASK, _FG_EDGE, _FG_GRAD) = enh_saved
        if item is not None:
            fitted_box = _bbox_of_points((item.get('chosen') or {}).get('points') or [])
            if fitted_box is not None and str((item.get('chosen') or {}).get('kind')) not in (
                    'seed-box', 'seed-round', 'freeform', 'freeform-curve', 'box'):
                e['_fittedBox'] = fitted_box
            item['_dist'] = dist
            item['_front'] = front
            item['_edge'] = edge
            item['_box'] = box_of(e)
            results.append(item)
    results.extend(line_results)
    missing = []
    heading_ids = spec.get('headingNodeIds')
    if heading_ids:
        page_front = np.zeros((HEIGHT, WIDTH), bool)
        page_edge, _page_dist = edge_maps(ref, page_front)
        missing = detect_heading_carriers(ref, families, lines_all, elements, heading_ids, page_edge)
    audit_boxes = {e.get('key'): box_of(e) for e in elements}
    shape_items = [item for item in results
                   if item.get('key') in audit_boxes
                   and str((item.get('chosen') or {}).get('kind')) not in ('line',)]
    shape_items = [item for item in shape_items if _bbox_of_points((item.get('chosen') or {}).get('points') or []) is not None]
    shape_items.sort(key=lambda item: _bbox_of_points(item['chosen']['points'])[0])
    for left_item, right_item in zip(shape_items, shape_items[1:]):
        left_box = _bbox_of_points(left_item['chosen']['points'])
        right_box = _bbox_of_points(right_item['chosen']['points'])
        if not left_box or not right_box:
            continue
        row_overlap = min(left_box[1] + left_box[3], right_box[1] + right_box[3]) - max(left_box[1], right_box[1])
        if row_overlap < 0.5 * min(left_box[3], right_box[3]):
            continue
        if left_box[0] + left_box[2] <= right_box[0] + 2:
            continue
        audit_left = audit_boxes[left_item['key']]
        audit_right = audit_boxes[right_item['key']]
        if audit_left[0] + audit_left[2] > audit_right[0] + 2:
            continue
        left_bound = audit_left[0] + audit_left[2]
        right_bound = audit_right[0]
        if right_bound - left_bound < 2:
            continue
        for item, (lower, upper) in ((left_item, (None, left_bound)), (right_item, (right_bound, None))):
            points = np.asarray(item['chosen']['points'], float).copy()
            if upper is not None:
                points[:, 0] = np.minimum(points[:, 0], upper)
            if lower is not None:
                points[:, 0] = np.maximum(points[:, 0], lower)
            item['chosen']['points'] = np.round(points, 3).tolist()
            clipped_box = _bbox_of_points(points)
            if clipped_box is not None:
                item['chosen']['native'] = native_geometry(
                    item['chosen']['kind'], points, item['chosen'].get('corners') or [],
                    clipped_box)
            item['chosen'].setdefault('extra', {})['siblingGap'] = True
    merge_report = apply_family_merge({'elements': results, 'missing': missing}, spec.get('mergeFamilies') or [], lines_all)
    elapsed = round((time.perf_counter() - started) * 1000, 1)
    return {
        'status': 'available',
        'version': VERSION,
        'elapsedMs': elapsed,
        'page': {'width': WIDTH, 'height': HEIGHT, 'lines': len(lines_all), 'families': len(families)},
        'elements': results,
        'missing': missing,
        'merge': merge_report,
        'errors': errors,
        'ignoredAssets': ignored_assets,
    }


# ---- ROUND-RECT vs BUBBLE: different fitting rules for rounded panels and bubbles
CLASS_PROFILES['ROUND-RECT'] = {'edge': .35, 'oriented': .40, 'error': 1.6, 'p95Max': 3.0,
                               'supportMin': .85, 'allowLanes': ('quad', 'radius-per-corner'),
                               'fallback': 'roundPanel'}
CLASS_PROFILES['BUBBLE'] = {'edge': .30, 'oriented': .35, 'error': 1.4, 'p95Max': 2.5,
                            'supportMin': .85, 'allowLanes': ('quad', 'radius-uniform'),
                            'fallback': 'pill'}
CLASS_TO_MODEL.update({'rounded-panel': 'ROUND-RECT', 'ribbon': 'ROUND-RECT',
                       'bubble': 'BUBBLE', 'pill': 'BUBBLE', 'capsule': 'BUBBLE'})
_original_model_of_class = model_of_class
def model_of_class(class_hint, element=None):
    if class_hint in ('bubble', 'pill', 'capsule', 'bubble-tail'):
        return 'BUBBLE'
    if class_hint in ('rounded-panel', 'ribbon'):
        return 'ROUND-RECT'
    return _original_model_of_class(class_hint, element)


def main():
    spec_path, out_dir = sys.argv[1], Path(sys.argv[2])
    spec = json.loads(Path(spec_path).read_text(encoding='utf-8'))
    out_dir.mkdir(parents=True, exist_ok=True)
    result = run(spec)
    (out_dir / 'shape-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')
    if spec.get('debug'):
        try:
            ref = load_ref(spec['reference'])
            draw_overlay(ref, result, spec.get('elements') or [], str(out_dir / 'shape-overlay.png'))
        except Exception as error:
            result['overlayError'] = str(error)[:500]
    print(json.dumps({'status': result['status'], 'elements': len(result['elements']), 'elapsedMs': result['elapsedMs']}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'unavailable', 'error': str(error)[:900]}))
        sys.exit(1)
