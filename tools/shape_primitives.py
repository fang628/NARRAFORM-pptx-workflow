"""Recognize the basic primitive of one reference colour block, then measure detail.

``classify_shape(contour)`` takes one external contour in canvas coordinates, the
same ``np.ndarray`` shape ``Nx1x2`` that ``cv2.findContours`` returns and that
``tools/shape_reference.py`` consumes, and reports the base geometry plus the
measured deviations that a later fitting step needs (slant, corner radius, cut
corner, arrow head/notch depth, star inner radius, direction, rotation).

Method (deterministic, NumPy/OpenCV only, no extra packages, no downloads):

* the contour is normalized into its own axis aligned bounding box, so the
  comparison is invariant to canvas position and absolute size;
* convexity, vertex count at ``approxPolyDP`` tolerances, interior angles, edge
  parallelism, a 5-fold radial harmonic and the contour's own corner chains
  decide which parametric prototypes are plausible;
* every plausible prototype is rasterized in the normalized frame and scored
  against the measured silhouette with IoU plus a symmetric boundary Chamfer
  term (the same normalization idea as ``tools/shape_reference.py``);
* a regular kind is only reported when the prototype score and the margin
  against the runner-up are strong enough, otherwise the result is ``freeform``.
  Concave V-notch arrows are never reported as hexagons, rounded polygons keep
  their base kind and only report ``cornerRadius``/``residual``, low confidence
  never forces a rule shape.

Return value::

    {
      'kind': 'circle' | 'ellipse' | 'star5' | 'hexagon' | 'pentagon' |
              'notchedArrow' | 'flatArrow' | 'shaftArrow' | 'rectangle' |
              'roundedRectangle' | 'parallelogram' | 'triangle' | 'trapezoid' |
              'freeform',
      'score': 0..1,       # prototype silhouette IoU mixed with boundary agreement
      'confidence': 0..1,  # score quality x runner-up margin x structural evidence
      'parameters': {...}, # only the keys that actually apply:
                           #   slantAngle   degrees between the slanted side and the
                           #                horizontal, measured on the original canvas
                           #                (physical aspect, not the normalized box)
                           #   headDepth    arrow: head length / longitudinal bbox
                           #                extent; hexagon: pointed-end inset / bbox
                           #                longitudinal extent (adjustable side inset,
                           #                not fixed at 0.25)
                           #   notchDepth   V notch depth / longitudinal bbox extent
                           #   direction    right|left|up|down
                           #   cornerRadius rounded corner radius / min(box.w, box.h)
                           #   cutCorner    straight corner cut / min(box.w, box.h)
                           #   innerRadius  star inner/outer radius ratio
                           #   rotation     degrees, minimal modulo the shape symmetry
                           #   orientation  hexagon: horizontal|vertical
                           #   shaftThickness arrow shaft height / bbox TRANSVERSE
                           #                extent (for a right arrow: height/box.h);
                           #                not the longitudinal extent
                           #   residual     silhouette residual 1 - IoU
      'points': [[x, y], ...],  # prototype vertices normalized to the contour box
                                # ([0,1]^2); circles/ellipses are sampled with 64 pts
      'box': {'x', 'y', 'w', 'h'},  # contour box in canvas coordinates
      'diagnostics': {...}          # explainable evidence, alternatives, reason
    }

``rotation`` conventions: 0 is the canonical upright/flat orientation of the
kind (point-up pentagon/star, flat-top rectangle) and values are reported as the
minimal angle modulo the shape symmetry.  Hexagons only accept the structurally
symmetric horizontal/vertical orientations and report ``orientation`` instead of
``rotation``.  ``cornerRadius`` and ``cutCorner`` are relative to
``min(box.w, box.h)``; ``headDepth`` and ``notchDepth`` are relative to the
arrow's longitudinal bounding box extent; ``innerRadius`` is the inner/outer
radius ratio.

Base kinds are gated by structural evidence, not only by IoU: the prototype (not
the measured polygon) supplies ``points``, so an irregular convex hexagon or
pentagon cannot be completed to a perfect score by its own vertices.  A convex
six-gon that fails the horizontal/vertical symmetry and parallel-side checks, or
a convex five-gon that is far from a regular pentagon, is reported as
``freeform`` unless another prototype reaches a near perfect score.

Usage: python tools/shape_primitives.py input.json output.json
  input  {"contours": [ [[x, y], ...], {"id": "color-block-1", "contour": [...]}, ... ]}
  output {"status": "available", "shapes": [...]}
"""
import json
import math
import sys
import time
from pathlib import Path

import cv2
import numpy as np

cv2.setNumThreads(1)

# Fixed analysis raster for the normalized silhouette comparison.  Working in a
# small fixed frame keeps the IoU/chamfer scores comparable between a 40 px swatch
# and a 1400 px colour block and keeps the tool fast.
ANALYSIS = 192
FREE_SCORE = 0.925
FREE_CONFIDENCE = 0.55
CIRCLE_RATIO = 0.93
KIND_ORDER = ('flatArrow', 'notchedArrow', 'shaftArrow', 'star5', 'roundedRectangle',
              'circle', 'ellipse', 'hexagon', 'pentagon', 'parallelogram', 'trapezoid',
              'triangle', 'rectangle', 'freeform')
KIND_PRIORITY = {kind: index for index, kind in enumerate(KIND_ORDER)}


def _clamp(value, low=0.0, high=1.0):
    return max(low, min(high, float(value)))


def _r(value, digits):
    return round(float(value), digits)


def _clean_points(contour):
    """Return finite unique Nx2 float points or None for a degenerate contour."""
    try:
        array = np.asarray(contour, dtype=np.float64)
    except (TypeError, ValueError):
        return None
    if array.size == 0:
        return None
    if array.ndim == 3:
        array = array[:, 0, :]
    elif array.ndim == 2:
        if array.shape[1] < 2:
            return None
        array = array[:, :2]
    elif array.ndim == 1:
        if array.size < 6:
            return None
        array = array.reshape(-1, 2)
    else:
        return None
    if array.shape[0] < 3 or not np.isfinite(array).all():
        return None
    kept = [0]
    for index in range(1, len(array)):
        if float(np.linalg.norm(array[index] - array[kept[-1]])) > 1e-9:
            kept.append(index)
    points = array[kept]
    if len(points) > 1 and float(np.linalg.norm(points[0] - points[-1])) <= 1e-9:
        points = points[:-1]
    return points if len(points) >= 3 else None


def _curve(points):
    return np.asarray(points, dtype=np.float32).reshape(-1, 1, 2)


def _signed_area(points):
    x = points[:, 0]
    y = points[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def _orient_points(points):
    return points if _signed_area(points) >= 0.0 else points[::-1].copy()


def _polygon_area(points):
    if points is None or len(points) < 3:
        return 0.0
    points = np.asarray(points, dtype=np.float64)
    x = points[:, 0]
    y = points[:, 1]
    return 0.5 * abs(float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)))


def _normalize(points):
    """Normalize to the point set's own bounding box ([0, 1]^2), clipped."""
    points = np.asarray(points, dtype=np.float64)
    if len(points) == 0:
        return points.reshape(0, 2)
    mins = points.min(axis=0)
    maxs = points.max(axis=0)
    extent = np.maximum(maxs - mins, 1e-9)
    return np.clip((points - mins) / extent, 0.0, 1.0)


def _render(normalized_points):
    mask = np.zeros((ANALYSIS, ANALYSIS), np.uint8)
    points = np.asarray(normalized_points, dtype=np.float64)
    if len(points) < 3:
        return mask
    pixels = np.rint(np.clip(points, 0.0, 1.0) * (ANALYSIS - 1)).astype(np.int32)
    cv2.fillPoly(mask, [pixels.reshape(-1, 1, 2)], 255)
    return mask


def _mask_area(mask):
    return int(np.count_nonzero(mask))


def _mask_iou(a, b):
    union = int(np.count_nonzero(a | b))
    if union <= 0:
        return 0.0
    return int(np.count_nonzero(a & b)) / float(union)


def _boundary_agreement(a, b):
    """1 - normalized symmetric boundary distance (same idea as shape_reference)."""
    kernel = np.ones((3, 3), np.uint8)
    edge_a = cv2.subtract(a, cv2.erode(a, kernel, borderType=cv2.BORDER_CONSTANT, borderValue=0)) > 0
    edge_b = cv2.subtract(b, cv2.erode(b, kernel, borderType=cv2.BORDER_CONSTANT, borderValue=0)) > 0
    if not edge_a.any() or not edge_b.any():
        return 0.0
    to_a = cv2.distanceTransform((~edge_a).astype(np.uint8), cv2.DIST_L2, 3)
    to_b = cv2.distanceTransform((~edge_b).astype(np.uint8), cv2.DIST_L2, 3)
    chamfer = float(np.mean(np.concatenate([to_b[edge_a], to_a[edge_b]])))
    diagonal = math.hypot(float(a.shape[0]), float(a.shape[1]))
    return _clamp(1.0 - min(1.0, chamfer / max(1.0, diagonal) * 4.0))


def _similarity(prototype_mask, contour_mask):
    iou = _mask_iou(prototype_mask, contour_mask)
    if iou <= 0.0:
        return 0.0
    return _clamp(0.7 * iou + 0.3 * _boundary_agreement(prototype_mask, contour_mask))


def _point_list(points):
    if points is None:
        return []
    return [[_r(point[0], 6), _r(point[1], 6)] for point in np.asarray(points, dtype=np.float64)]


def _box(mins, extent):
    if mins is None or extent is None:
        return None
    return {'x': _r(mins[0], 3), 'y': _r(mins[1], 3),
            'w': _r(extent[0], 3), 'h': _r(extent[1], 3)}


def _approx(points, epsilon):
    curve = _curve(points)
    if len(points) < 3:
        return np.asarray(points, dtype=np.float64).reshape(-1, 2)
    approx = cv2.approxPolyDP(curve, max(0.5, float(epsilon)), True)
    return approx.reshape(-1, 2).astype(np.float64)


def _approx_count(points, target):
    """Smallest approxPolyDP tolerance whose polygon has exactly ``target`` vertices."""
    perimeter = float(cv2.arcLength(_curve(points), True))
    if perimeter <= 0.0 or target < 3:
        return None
    low, high = 0.0, perimeter * 0.30
    for _ in range(40):
        middle = 0.5 * (low + high)
        count = len(cv2.approxPolyDP(_curve(points), max(0.5, middle), True))
        if count > target:
            low = middle
        else:
            high = middle
    result = cv2.approxPolyDP(_curve(points), max(0.5, high), True).reshape(-1, 2)
    return result.astype(np.float64) if len(result) == target else None


def _angle_between(first, second):
    first = np.asarray(first, dtype=np.float64)
    second = np.asarray(second, dtype=np.float64)
    denominator = float(np.linalg.norm(first) * np.linalg.norm(second))
    if denominator <= 1e-12:
        return 90.0
    cosine = _clamp(float(np.dot(first, second)) / denominator, -1.0, 1.0)
    return math.degrees(math.acos(abs(cosine)))


def _interior_angles(points):
    angles = []
    count = len(points)
    for index in range(count):
        previous = points[index] - points[index - 1]
        following = points[(index + 1) % count] - points[index]
        denominator = float(np.linalg.norm(previous) * np.linalg.norm(following))
        if denominator <= 1e-12:
            angles.append(180.0)
            continue
        cosine = _clamp(float(np.dot(previous, following)) / denominator, -1.0, 1.0)
        angles.append(math.degrees(math.acos(cosine)))
    return angles


def _polygon_centroid(points):
    points = np.asarray(points, dtype=np.float64)
    x = points[:, 0]
    y = points[:, 1]
    cross = x * np.roll(y, -1) - np.roll(x, -1) * y
    area = 0.5 * float(np.sum(cross))
    if abs(area) <= 1e-9:
        return points.mean(axis=0)
    return np.array([float(np.sum((x + np.roll(x, -1)) * cross)) / (6.0 * area),
                     float(np.sum((y + np.roll(y, -1)) * cross)) / (6.0 * area)])


def _symmetric_angle(angle, symmetry):
    angle = float(angle)
    if symmetry <= 0:
        return angle
    half = 0.5 * symmetry
    return ((angle + half) % symmetry) - half


def _x_intersect(start, end, x):
    denominator = float(end[0] - start[0])
    if abs(denominator) <= 1e-12:
        return (x, float(start[1]))
    ratio = (x - float(start[0])) / denominator
    return (x, float(start[1]) + ratio * float(end[1] - start[1]))


def _y_intersect(start, end, y):
    denominator = float(end[1] - start[1])
    if abs(denominator) <= 1e-12:
        return (float(start[0]), y)
    ratio = (y - float(start[1])) / denominator
    return (float(start[0]) + ratio * float(end[0] - start[0]), y)


def _clip_polygon(points, x0, y0, x1, y1):
    """Sutherland-Hodgman clipping of one polygon against an axis aligned square."""
    polygon = [(float(p[0]), float(p[1])) for p in points]
    for inside, intersect in (
            (lambda p: p[0] >= x0, lambda a, b: _x_intersect(a, b, x0)),
            (lambda p: p[0] <= x1, lambda a, b: _x_intersect(a, b, x1)),
            (lambda p: p[1] >= y0, lambda a, b: _y_intersect(a, b, y0)),
            (lambda p: p[1] <= y1, lambda a, b: _y_intersect(a, b, y1))):
        if not polygon:
            break
        clipped = []
        for index in range(len(polygon)):
            current = polygon[index]
            previous = polygon[index - 1]
            current_in = inside(current)
            previous_in = inside(previous)
            if current_in:
                if not previous_in:
                    clipped.append(intersect(previous, current))
                clipped.append(current)
            elif previous_in:
                clipped.append(intersect(previous, current))
        polygon = clipped
    return polygon


def _make_candidate(kind, normalized_points, parameters, contour_mask, feature=None):
    points = np.clip(np.asarray(normalized_points, dtype=np.float64), 0.0, 1.0)
    if len(points) < 3:
        return None
    mask = _render(points)
    area = _mask_area(mask)
    if area == 0:
        return None
    iou = float(_mask_iou(mask, contour_mask))
    if iou <= 0.0:
        return None
    values = dict(parameters or {})
    values.setdefault('residual', _r(1.0 - iou, 4))
    if feature is None:
        feature = _clamp(1.0 - (1.0 - iou) * 8.0)
    return {'kind': kind, 'points': points, 'parameters': values, 'mask': mask,
            'iou': iou, 'feature': _clamp(feature)}


def _degenerate_result(reason):
    return {'kind': 'freeform', 'score': 0.0, 'confidence': 0.0, 'parameters': {},
            'points': [], 'box': None,
            'diagnostics': {'method': 'normalized-prototype-IoU+chamfer+feature-evidence',
                            'accepted': False, 'reason': reason}}


def _freeform_result(pixel_points, mins, extent, best_score, alternatives, reason,
                     best_kind=None, extra=None):
    points = []
    if pixel_points is not None and len(pixel_points) >= 3 and mins is not None and extent is not None:
        perimeter = float(cv2.arcLength(_curve(pixel_points), True))
        approx = _approx(pixel_points, max(0.8, perimeter * 0.01))
        source = approx if len(approx) >= 3 else pixel_points
        normalized = np.clip((source - mins) / extent, 0.0, 1.0)
        if len(normalized) > 80:
            index = np.rint(np.linspace(0.0, float(len(normalized) - 1), 80)).astype(int)
            normalized = normalized[index]
        points = _point_list(normalized)
    best = _clamp(best_score) if best_score is not None else 0.0
    confidence = 0.0 if not points else min(0.49, 0.30 + 0.25 * (1.0 - best))
    diagnostics = {'method': 'normalized-prototype-IoU+chamfer+feature-evidence',
                   'accepted': False, 'reason': reason,
                   'bestPrototypeKind': best_kind, 'bestPrototypeScore': _r(best, 3),
                   'alternatives': alternatives}
    if extra:
        diagnostics.update(extra)
    return {'kind': 'freeform', 'score': _r(best, 3), 'confidence': _r(confidence, 3),
            'parameters': {}, 'points': points, 'box': _box(mins, extent),
            'diagnostics': diagnostics}


def _ellipse_points(center, axes, angle_deg, count=64):
    semi_first = float(axes[0]) / 2.0
    semi_second = float(axes[1]) / 2.0
    theta = math.radians(float(angle_deg))
    cosine, sine = math.cos(theta), math.sin(theta)
    steps = np.linspace(0.0, 2.0 * math.pi, count, endpoint=False)
    local_x = semi_first * np.cos(steps)
    local_y = semi_second * np.sin(steps)
    return np.stack([float(center[0]) + local_x * cosine - local_y * sine,
                     float(center[1]) + local_x * sine + local_y * cosine], axis=1)


def _ellipse_candidates(pixel_points, contour_mask):
    if len(pixel_points) < 5:
        return []
    try:
        (center_x, center_y), (first, second), angle = cv2.fitEllipse(_curve(pixel_points))
    except cv2.error:
        return []
    if not np.isfinite([center_x, center_y, first, second, angle]).all() or min(first, second) < 2.0:
        return []
    best = None
    for axes, base_angle in (((float(first), float(second)), float(angle)),
                             ((float(second), float(first)), float(angle) + 90.0)):
        sample = _ellipse_points((center_x, center_y), axes, base_angle)
        normalized = _normalize(sample)
        iou = _mask_iou(_render(normalized), contour_mask)
        if best is None or iou > best[0] + 1e-9:
            best = (iou, normalized, axes, base_angle)
    _, normalized, axes, base_angle = best
    major, minor = max(axes), min(axes)
    ratio = minor / major if major > 0 else 0.0
    if ratio >= CIRCLE_RATIO:
        kind = 'circle'
        parameters = {}
        feature = _clamp(0.4 + (ratio - CIRCLE_RATIO) / (1.0 - CIRCLE_RATIO) * 0.6)
    else:
        kind = 'ellipse'
        major_angle = base_angle if axes[0] >= axes[1] else base_angle + 90.0
        parameters = {'rotation': _r(_symmetric_angle(major_angle, 180.0), 2)}
        feature = _clamp(0.4 + (CIRCLE_RATIO - ratio) / 0.35)
    candidate = _make_candidate(kind, normalized, parameters, contour_mask, feature)
    return [candidate] if candidate is not None else []


def _regular_prototype(count, base_deg, rotation_deg):
    angles = np.radians(float(base_deg) + float(rotation_deg) +
                        np.arange(count, dtype=np.float64) * (360.0 / count))
    return _normalize(np.stack([np.cos(angles), np.sin(angles)], axis=1))


def _rotation_phase(measured_poly, base_deg, count, symmetry):
    """Initial rotation estimate (degrees) from the measured vertex angles."""
    if measured_poly is None or len(measured_poly) != count:
        return None
    points = np.asarray(measured_poly, dtype=np.float64)
    center = _polygon_centroid(points)
    angles = np.degrees(np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0]))
    half = 0.5 * symmetry
    offsets = np.mod(angles - float(base_deg) + half, symmetry) - half
    return _symmetric_angle(float(np.mean(offsets)), symmetry)


def _vertex_fit_residual(measured_poly, prototype_points):
    """Largest nearest-vertex distance between the measured and the prototype polygon."""
    if measured_poly is None or prototype_points is None:
        return 1.0
    measured = _normalize(measured_poly)
    prototype = np.asarray(prototype_points, dtype=np.float64)
    distances = np.min(np.linalg.norm(measured[:, None, :] - prototype[None, :, :], axis=2), axis=1)
    return float(distances.max())


def _symmetric_distance(angle, reference, symmetry):
    return abs(_symmetric_angle(float(angle) - float(reference), symmetry))


def _regular_candidate(kind, count, base_deg, pixel_points, contour_mask, measured_poly):
    """Fit one regular polygon prototype; measured vertices only guide the fit.

    The raster IoU is piecewise constant, so several near-equal rotations can tie.
    Ties are resolved toward the analytic vertex phase (which is translation and
    direction invariant) instead of keeping whichever raster step is visited first.
    """
    symmetry = 360.0 / count
    phase = _rotation_phase(measured_poly, base_deg, count, symmetry)
    evaluations = []

    def evaluate(rotation):
        prototype = _regular_prototype(count, base_deg, rotation)
        iou = _mask_iou(_render(prototype), contour_mask)
        evaluations.append((float(rotation), iou, prototype))

    if phase is None:
        rotation = 0.0
        while rotation < symmetry - 1e-9:
            evaluate(rotation)
            rotation += 4.0
    else:
        offset = -8.0
        while offset <= 8.0 + 1e-9:
            evaluate(phase + offset)
            offset += 1.0
    if not evaluations:
        return None
    reference = phase if phase is not None else 0.0
    maximum = max(item[1] for item in evaluations)
    anchor = min((item for item in evaluations if item[1] >= maximum - 1e-9),
                 key=lambda item: _symmetric_distance(item[0], reference, symmetry))
    offset = -1.0
    while offset <= 1.0 + 1e-9:
        evaluate(anchor[0] + offset)
        offset += 0.2
    maximum = max(item[1] for item in evaluations)
    chosen = min((item for item in evaluations if item[1] >= maximum - 1e-9),
                 key=lambda item: (_symmetric_distance(item[0], reference, symmetry), item[0]))
    points = chosen[2]
    residual = _vertex_fit_residual(measured_poly, points) if measured_poly is not None else 0.0
    if measured_poly is not None and residual > 0.14:
        return None  # clearly not a regular pentagon: report freeform instead of forcing
    parameters = {'rotation': _r(_symmetric_angle(chosen[0], symmetry), 2)}
    if count == 5:
        radius = _polygon_corner_radius(count, points, pixel_points, contour_mask)
        if radius is not None and radius > 0.025:
            parameters['cornerRadius'] = _r(radius, 3)
    candidate = _make_candidate(kind, points, parameters, contour_mask,
                                _clamp(1.0 - residual / 0.18))
    return candidate


def _polygon_corner_radius(count, prototype_points, pixel_points, contour_mask):
    """Approximate rounding radius of a regular polygon from area/vertex evidence."""
    interior = {3: 60.0, 5: 108.0, 6: 120.0}.get(count)
    if interior is None:
        return None
    prototype_area = _mask_area(_render(prototype_points))
    contour_area = _mask_area(contour_mask)
    deficit = prototype_area - contour_area
    radius_from_area = 0.0
    if deficit > 0:
        half = math.radians(interior) / 2.0
        factor = 1.0 / math.tan(half) - (math.pi - math.radians(interior)) / 2.0
        if factor > 1e-6:
            extent = pixel_points.max(axis=0) - pixel_points.min(axis=0)
            width = max(1e-6, float(extent[0]))
            height = max(1e-6, float(extent[1]))
            fraction = (deficit / float(ANALYSIS * ANALYSIS)) / (count * factor)
            rho = height / width
            semis = (math.sqrt(max(0.0, fraction * rho)), math.sqrt(max(0.0, fraction / rho)))
            radius_from_area = max(semis)
    sample = pixel_points[::max(1, len(pixel_points) // 400)]
    mins = pixel_points.min(axis=0)
    extent = pixel_points.max(axis=0) - mins
    vertex_pixels = mins[None, :] + np.asarray(prototype_points, dtype=np.float64) * extent[None, :]
    distances = np.min(np.linalg.norm(sample[None, :, :] - vertex_pixels[:, None, :], axis=2), axis=1)
    median_distance = float(np.median(distances))
    vertex_factor = 1.0 / math.sin(math.radians(interior) / 2.0) - 1.0
    radius_from_vertex = median_distance / max(1e-6, vertex_factor) / max(1e-6, float(min(extent)))
    if radius_from_area > 0.0 and radius_from_vertex > 0.0:
        return min(radius_from_area, radius_from_vertex)
    return None


def _rect_frame(pixel_points):
    try:
        rotated = cv2.minAreaRect(_curve(pixel_points))
        box = cv2.boxPoints(rotated)
    except cv2.error:
        return None
    if box is None or not np.isfinite(box).all():
        return None
    center = box.mean(axis=0)
    edges = [box[(index + 1) % 4] - box[index] for index in range(4)]
    lengths = [float(np.linalg.norm(edge)) for edge in edges]
    longest = int(np.argmax(lengths))
    if lengths[longest] < 2.0:
        return None
    axis_u = edges[longest] / lengths[longest]
    axis_v = np.array([-axis_u[1], axis_u[0]])
    relative = pixel_points - center
    projection_u = relative @ axis_u
    projection_v = relative @ axis_v
    low_u, high_u = float(projection_u.min()), float(projection_u.max())
    low_v, high_v = float(projection_v.min()), float(projection_v.max())
    length = high_u - low_u
    thickness = high_v - low_v
    if length < 2.0 or thickness < 2.0:
        return None
    frame_points = np.stack([projection_u - low_u, projection_v - low_v], axis=1)
    rotation = _symmetric_angle(math.degrees(math.atan2(float(axis_u[1]), float(axis_u[0]))), 90.0)
    return {'center': center, 'u': axis_u, 'v': axis_v, 'low_u': low_u, 'low_v': low_v,
            'length': length, 'thickness': thickness, 'points': frame_points,
            'rotation': rotation}


def _frame_to_pixel(frame_points, frame):
    points = np.asarray(frame_points, dtype=np.float64)
    along = points[:, 0] + frame['low_u']
    across = points[:, 1] + frame['low_v']
    return (frame['center'][None, :] + along[:, None] * frame['u'][None, :] +
            across[:, None] * frame['v'][None, :])


def _corner_analysis(frame_points, length, thickness):
    """Classify the four rectangle frame corners as sharp/rounded/chamfered."""
    if length < 8.0 or thickness < 8.0:
        return []
    fine = _approx(frame_points, max(0.4, 0.0025 * min(length, thickness)))
    square = 0.5 * min(length, thickness)
    results = []
    for corner_x, corner_y, sign_x, sign_y in ((0.0, 0.0, 1.0, 1.0), (length, 0.0, -1.0, 1.0),
                                               (length, thickness, -1.0, -1.0),
                                               (0.0, thickness, 1.0, -1.0)):
        local = np.stack([(frame_points[:, 0] - corner_x) * sign_x,
                          (frame_points[:, 1] - corner_y) * sign_y], axis=1)
        clipped = _clip_polygon(local, 0.0, 0.0, square, square)
        inside = _polygon_area(np.asarray(clipped, dtype=np.float64)) if len(clipped) >= 3 else 0.0
        missing = max(0.0, square * square - inside)
        if missing <= max(0.5, 0.0002 * square * square):
            results.append({'type': 'sharp', 'size': 0.0})
            continue
        size_reference = math.sqrt(missing / (1.0 - math.pi / 4.0))
        limit = max(1.5, 1.1 * size_reference)
        fine_local = np.stack([(fine[:, 0] - corner_x) * sign_x,
                               (fine[:, 1] - corner_y) * sign_y], axis=1)
        chords = 0
        for index in range(len(fine_local)):
            start = fine_local[index]
            end = fine_local[(index + 1) % len(fine_local)]
            if max(start[0], start[1]) > limit or max(end[0], end[1]) > limit:
                continue
            if float(np.linalg.norm(end - start)) < 0.5:
                continue
            middle = 0.5 * (start + end)
            if min(middle[0], middle[1]) < 1.0:
                continue
            chords += 1
        rounded = chords >= 2
        if chords == 0:
            selected = local[(local[:, 0] >= 1.0) & (local[:, 1] >= 1.0) &
                             (local[:, 0] <= limit) & (local[:, 1] <= limit)]
            if len(selected) >= 3:
                centred = selected - selected.mean(axis=0)
                try:
                    direction = np.linalg.svd(centred, full_matrices=False)[2][0]
                except np.linalg.LinAlgError:
                    direction = np.array([1.0, 1.0]) / math.sqrt(2.0)
                normal = np.array([-direction[1], direction[0]])
                deviation = float(np.abs(centred @ normal).max())
                rounded = deviation > max(1.5, 0.1 * size_reference)
        if rounded:
            results.append({'type': 'rounded',
                            'size': math.sqrt(missing / (1.0 - math.pi / 4.0))})
        else:
            results.append({'type': 'chamfer', 'size': math.sqrt(2.0 * missing)})
    return results


def _rounded_rect_points(length, thickness, radius, segments=8):
    radius = max(0.0, min(float(radius), 0.5 * min(length, thickness)))
    corners = ((radius, radius, 180.0, 270.0), (length - radius, radius, 270.0, 360.0),
               (length - radius, thickness - radius, 0.0, 90.0),
               (radius, thickness - radius, 90.0, 180.0))
    points = []
    for corner_x, corner_y, start, end in corners:
        for step in range(segments + 1):
            angle = math.radians(start + (end - start) * step / segments)
            points.append((corner_x + radius * math.cos(angle),
                           corner_y + radius * math.sin(angle)))
    return points


def _chamfered_rect_points(length, thickness, cut):
    cut = max(0.0, min(float(cut), 0.5 * min(length, thickness)))
    return [(cut, 0.0), (length - cut, 0.0), (length, cut), (length, thickness - cut),
            (length - cut, thickness), (cut, thickness), (0.0, thickness - cut), (0.0, cut)]


def _rect_family_candidates(pixel_points, contour_mask, extent):
    frame = _rect_frame(pixel_points)
    if frame is None:
        return []
    length = frame['length']
    thickness = frame['thickness']
    short_side = max(1e-6, float(min(extent)))
    candidates = []
    rectangle_frame = np.array([[0.0, 0.0], [length, 0.0], [length, thickness], [0.0, thickness]])
    plain = _make_candidate('rectangle', _normalize(_frame_to_pixel(rectangle_frame, frame)),
                            {'rotation': _r(frame['rotation'], 2)}, contour_mask)
    if plain is not None:
        candidates.append(plain)
    corners = _corner_analysis(frame['points'], length, thickness)
    minimum_vote = max(1.5, 0.01 * short_side)
    rounded_sizes = [corner['size'] for corner in corners
                     if corner['type'] == 'rounded' and corner['size'] >= minimum_vote]
    chamfer_sizes = [corner['size'] for corner in corners
                     if corner['type'] == 'chamfer' and corner['size'] >= minimum_vote]
    cap = 0.45 * min(length, thickness)
    if len(rounded_sizes) >= 2:
        radius = min(float(np.median(rounded_sizes)), cap)
        ratio = radius / short_side
        if ratio >= 0.03 and radius >= 2.0:
            prototype = _frame_to_pixel(_rounded_rect_points(length, thickness, radius), frame)
            candidate = _make_candidate('roundedRectangle', _normalize(prototype),
                                        {'cornerRadius': _r(ratio, 3),
                                         'rotation': _r(frame['rotation'], 2)},
                                        contour_mask, _clamp(len(rounded_sizes) / 3.0))
            if candidate is not None and (plain is None or
                                          candidate['iou'] >= plain['iou'] + 0.002):
                candidates.append(candidate)
    if len(chamfer_sizes) >= 2:
        cut = min(float(np.median(chamfer_sizes)), cap)
        ratio = cut / short_side
        if ratio >= 0.03 and cut >= 2.0:
            prototype = _frame_to_pixel(_chamfered_rect_points(length, thickness, cut), frame)
            candidate = _make_candidate('rectangle', _normalize(prototype),
                                        {'cutCorner': _r(ratio, 3),
                                         'rotation': _r(frame['rotation'], 2)},
                                        contour_mask, _clamp(len(chamfer_sizes) / 3.0))
            if candidate is not None and (plain is None or
                                          candidate['iou'] >= plain['iou'] + 0.002):
                candidates.append(candidate)
    return candidates


def _measured_candidate(kind, polygon, contour_mask, parameters=None):
    if polygon is None or len(polygon) < 3:
        return None
    return _make_candidate(kind, _normalize(polygon), parameters or {}, contour_mask)


def _quadrilateral_candidates(polygon, contour_mask):
    """Return (candidates, implied_freeform) for a convex four vertex contour."""
    if polygon is None or len(polygon) != 4:
        return [], False
    quad = _orient_points(np.asarray(polygon, dtype=np.float64))
    angles = _interior_angles(quad)
    if max(abs(angle - 90.0) for angle in angles) < 12.0:
        return [], False  # axis aligned or rotated rectangle: handled by the rect family
    sides = [quad[(index + 1) % 4] - quad[index] for index in range(4)]
    first_pair = _angle_between(sides[0], sides[2])
    second_pair = _angle_between(sides[1], sides[3])
    candidates = []
    if first_pair < 8.0 and second_pair < 8.0:
        to_horizontal = [math.degrees(math.atan2(abs(float(side[1])), abs(float(side[0]))))
                         for side in sides]
        pair_zero = 0.5 * (to_horizontal[0] + to_horizontal[2])
        pair_one = 0.5 * (to_horizontal[1] + to_horizontal[3])
        reference = min((0, 1), key=lambda index: min(
            abs(pair_zero if index == 0 else pair_one),
            abs(90.0 - (pair_zero if index == 0 else pair_one))))
        slant = pair_one if reference == 0 else pair_zero
        candidate = _measured_candidate('parallelogram', quad, contour_mask,
                                        {'slantAngle': _r(slant, 2), 'slantSign': 1 if np.mean(quad[np.argsort(quad[:,1])[:2],0]) >= np.mean(quad[np.argsort(quad[:,1])[-2:],0]) else -1})
        if candidate is not None:
            candidates.append(candidate)
    elif (first_pair < 8.0) != (second_pair < 8.0):
        candidate = _measured_candidate('trapezoid', quad, contour_mask)
        if candidate is not None:
            candidates.append(candidate)
    else:
        return [], True
    return candidates, False


def _canonical_points(normalized_points, direction):
    points = np.asarray(normalized_points, dtype=np.float64)
    x = points[:, 0]
    y = points[:, 1]
    if direction == 'left':
        return np.stack([1.0 - x, y], axis=1)
    if direction == 'up':
        return np.stack([1.0 - y, x], axis=1)
    if direction == 'down':
        return np.stack([y, x], axis=1)
    return np.stack([x, y], axis=1)


def _from_canonical(canonical_points, direction):
    points = np.asarray(canonical_points, dtype=np.float64)
    x = points[:, 0]
    y = points[:, 1]
    if direction == 'left':
        return np.stack([1.0 - x, y], axis=1)
    if direction == 'up':
        return np.stack([y, 1.0 - x], axis=1)
    if direction == 'down':
        return np.stack([y, x], axis=1)
    return np.stack([x, y], axis=1)


def _flat_arrow_points(head):
    return np.array([[0.0, 0.0], [1.0 - head, 0.0], [1.0, 0.5], [1.0 - head, 1.0], [0.0, 1.0]])


def _notched_arrow_points(head, notch):
    return np.array([[0.0, 0.0], [1.0 - head, 0.0], [1.0, 0.5], [1.0 - head, 1.0],
                     [0.0, 1.0], [notch, 0.5]])


def _shaft_arrow_points(head, shaft):
    return np.array([[0.0, 0.5 - shaft], [1.0 - head, 0.5 - shaft], [1.0 - head, 0.0],
                     [1.0, 0.5], [1.0 - head, 1.0], [1.0 - head, 0.5 + shaft],
                     [0.0, 0.5 + shaft]])


def _flat_structure(canonical):
    if len(canonical) != 5:
        return None
    x = canonical[:, 0]
    y = canonical[:, 1]
    tip = [index for index in range(5) if x[index] > 0.9 and abs(y[index] - 0.5) < 0.08]
    tail = [index for index in range(5) if x[index] < 0.07 and (y[index] < 0.08 or y[index] > 0.92)]
    shoulders = [index for index in range(5)
                 if 0.07 < x[index] < 0.93 and (y[index] < 0.08 or y[index] > 0.92)]
    if len(tip) != 1 or len(tail) != 2 or len(shoulders) != 2:
        return None
    if min(y[tail]) > 0.1 or max(y[tail]) < 0.9:
        return None
    head = 1.0 - float(np.mean(x[shoulders]))
    if not 0.03 <= head <= 0.48:
        return None
    return head


def _notched_structure(canonical):
    if len(canonical) != 6:
        return None
    x = canonical[:, 0]
    y = canonical[:, 1]
    tip = [index for index in range(6) if x[index] > 0.9 and abs(y[index] - 0.5) < 0.08]
    tail = [index for index in range(6) if x[index] < 0.07 and (y[index] < 0.08 or y[index] > 0.92)]
    shoulders = [index for index in range(6)
                 if 0.07 < x[index] < 0.93 and (y[index] < 0.08 or y[index] > 0.92)]
    used = set(tip + tail + shoulders)
    notch = [index for index in range(6) if index not in used]
    if len(tip) != 1 or len(tail) != 2 or len(shoulders) != 2 or len(notch) != 1:
        return None
    index = notch[0]
    if abs(float(y[index]) - 0.5) > 0.08:
        return None
    head = 1.0 - float(np.mean(x[shoulders]))
    depth = float(x[index])
    if not 0.03 <= head <= 0.48 or not 0.03 <= depth <= 0.95:
        return None
    if depth > 1.0 - head - 0.02:
        return None
    return {'head': head, 'notch': depth}


def _shaft_structure(canonical):
    if len(canonical) != 7:
        return None
    x = canonical[:, 0]
    y = canonical[:, 1]
    tip = [index for index in range(7) if x[index] > 0.9 and abs(y[index] - 0.5) < 0.08]
    tail = [index for index in range(7) if x[index] < 0.07]
    middle = [index for index in range(7) if 0.07 <= x[index] <= 0.93]
    if len(tip) != 1 or len(tail) != 2 or len(middle) != 4:
        return None
    tail_y = sorted(float(y[index]) for index in tail)
    shaft = 0.5 * (tail_y[1] - tail_y[0])
    if abs(0.5 * (tail_y[0] + tail_y[1]) - 0.5) > 0.06:
        return None
    head = 1.0 - float(np.mean(x[middle]))
    if not 0.06 <= head <= 0.48 or not 0.04 <= shaft <= 0.46:
        return None
    edges = [float(value) for value in y[middle]]
    if sum(1 for value in edges if value < 0.08 or value > 0.92) != 2:
        return None
    if sum(1 for value in edges if abs(value - (0.5 - shaft)) < 0.07 or
           abs(value - (0.5 + shaft)) < 0.07) != 2:
        return None
    return {'head': head, 'shaft': shaft}


def _flat_arrow_candidate(pixel_points, contour_mask, coarse_polygon):
    polygon = coarse_polygon if coarse_polygon is not None and len(coarse_polygon) == 5 else \
        _approx_count(pixel_points, 5)
    if polygon is None:
        return None
    normalized = _normalize(polygon)
    best = None
    for direction in ('right', 'left', 'up', 'down'):
        head = _flat_structure(_canonical_points(normalized, direction))
        if head is None:
            continue
        prototype = _from_canonical(_flat_arrow_points(head), direction)
        candidate = _make_candidate('flatArrow', prototype,
                                    {'headDepth': _r(head, 3), 'direction': direction},
                                    contour_mask)
        if candidate is not None and (best is None or candidate['iou'] > best['iou'] + 1e-9):
            best = candidate
    return best


def _arrow_candidates(pixel_points, contour_mask, coarse_polygon):
    candidates = []
    for target, kind in ((6, 'notchedArrow'), (7, 'shaftArrow')):
        polygon = coarse_polygon if coarse_polygon is not None and len(coarse_polygon) == target else \
            _approx_count(pixel_points, target)
        if polygon is None:
            continue
        normalized = _normalize(polygon)
        best = None
        for direction in ('right', 'left', 'up', 'down'):
            canonical = _canonical_points(normalized, direction)
            if kind == 'notchedArrow':
                structure = _notched_structure(canonical)
                prototype = _notched_arrow_points(structure['head'], structure['notch']) \
                    if structure is not None else None
            else:
                structure = _shaft_structure(canonical)
                prototype = _shaft_arrow_points(structure['head'], structure['shaft']) \
                    if structure is not None else None
            if prototype is None:
                continue
            observed = _from_canonical(prototype, direction)
            parameters = {'headDepth': _r(structure['head'], 3), 'direction': direction}
            if kind == 'notchedArrow':
                parameters['notchDepth'] = _r(structure['notch'], 3)
            else:
                parameters['shaftThickness'] = _r(2.0 * structure['shaft'], 3)
            candidate = _make_candidate(kind, observed, parameters, contour_mask)
            if candidate is not None and (best is None or candidate['iou'] > best['iou'] + 1e-9):
                best = candidate
        if best is not None:
            candidates.append(best)
    return candidates


def _star_prototype(inner_ratio, rotation_deg, count=5):
    points = []
    for index in range(count):
        outer_angle = math.radians(-90.0 + rotation_deg + 72.0 * index)
        inner_angle = math.radians(-90.0 + rotation_deg + 36.0 + 72.0 * index)
        points.append((math.cos(outer_angle), math.sin(outer_angle)))
        points.append((inner_ratio * math.cos(inner_angle), inner_ratio * math.sin(inner_angle)))
    return _normalize(np.asarray(points, dtype=np.float64))


def _star_candidate(pixel_points, contour_mask):
    if len(pixel_points) < 8:
        return None
    center = _polygon_centroid(pixel_points)
    relative = pixel_points - center
    radii = np.linalg.norm(relative, axis=1)
    maximum = float(radii.max())
    if maximum <= 1e-6:
        return None
    angles = np.arctan2(relative[:, 1], relative[:, 0])
    harmonic = complex(np.sum(radii * np.exp(1j * 5.0 * angles)))
    if abs(harmonic) < 0.12 * float(np.sum(radii)):
        return None
    outer = radii >= 0.8 * maximum
    if int(np.count_nonzero(outer)) < 5:
        return None
    inner_ratio = float(radii.min()) / max(1e-6, maximum)
    if not 0.15 <= inner_ratio <= 0.85:
        return None
    # The five tip directions are the phase of the 5-fold harmonic; the mean of
    # the tip unit vectors would be exactly zero for a symmetric star.
    phase_degrees = math.degrees(math.atan2(harmonic.imag, harmonic.real)) / 5.0
    outer_degrees = np.degrees(angles[outer])
    base_rotation = None
    best_cost = None
    for candidate_index in range(5):
        candidate = phase_degrees + 72.0 * candidate_index
        cost = float(np.sum(np.abs(np.mod(outer_degrees - candidate + 36.0, 72.0) - 36.0)))
        if best_cost is None or cost < best_cost - 1e-12:
            best_cost = cost
            base_rotation = _symmetric_angle(candidate + 90.0, 72.0)
    best = {'iou': -1.0, 'points': None, 'inner': inner_ratio, 'rotation': base_rotation}
    for factor in (1.0, 0.97, 1.03):
        ratio = _clamp(inner_ratio * factor, 0.12, 0.86)
        for offset in (-4.0, -2.0, 0.0, 2.0, 4.0):
            prototype = _star_prototype(ratio, base_rotation + offset)
            iou = _mask_iou(_render(prototype), contour_mask)
            if iou > best['iou'] + 1e-9:
                best.update({'iou': iou, 'points': prototype, 'inner': ratio,
                             'rotation': base_rotation + offset})
    for step, span in ((0.5, 2.0), (0.2, 0.5)):
        centre = best['rotation']
        offset = -span
        while offset <= span + 1e-9:
            prototype = _star_prototype(best['inner'], centre + offset)
            iou = _mask_iou(_render(prototype), contour_mask)
            if iou > best['iou'] + 1e-9:
                best.update({'iou': iou, 'points': prototype,
                             'rotation': centre + offset})
            offset += step
    parameters = {'innerRadius': _r(best['inner'], 3),
                  'rotation': _r(_symmetric_angle(best['rotation'], 72.0), 2)}
    return _make_candidate('star5', best['points'], parameters, contour_mask)


def _has_mirror(vertices, target, tolerance):
    return float(np.min(np.linalg.norm(vertices - target[None, :], axis=1))) <= tolerance


def _angle_to_horizontal(points, first, second):
    dx = abs(float(points[second, 0] - points[first, 0]))
    dy = abs(float(points[second, 1] - points[first, 1]))
    return math.degrees(math.atan2(dy, dx))


def _hexagon_candidate(pixel_points, contour_mask, coarse):
    """Symmetric six-gon with an adjustable pointed-end inset (not fixed at 0.25).

    Structural evidence is mandatory: the two bounding-box axes must be mirror
    symmetry axes and the three pairs of corresponding sides must be parallel.
    Otherwise any convex six-gon could be completed to IoU 1 with its own vertices.
    Vertices are assigned by their sorted bounding-box coordinates (not by a fixed
    edge distance) so a narrow pointed-end inset smaller than the tolerance still
    works.  The inset is seeded from the silhouette area (which survives corner
    rounding) and refined by IoU.  ``headDepth`` is the pointed-end inset relative
    to the bounding box longitudinal extent; ``slantAngle`` is the physical canvas
    angle of the slanted side.
    """
    if coarse is None or len(coarse) != 6:
        return None
    vertices = _orient_points(np.asarray(coarse, dtype=np.float64))
    mins = pixel_points.min(axis=0)
    extent = pixel_points.max(axis=0) - mins
    width = max(1e-6, float(extent[0]))
    height = max(1e-6, float(extent[1]))
    normalized = np.clip((vertices - mins) / extent, 0.0, 1.0)
    for vertex in normalized:
        if not _has_mirror(normalized, np.array([1.0 - vertex[0], vertex[1]]), 0.10):
            return None
        if not _has_mirror(normalized, np.array([vertex[0], 1.0 - vertex[1]]), 0.10):
            return None
    x = normalized[:, 0]
    y = normalized[:, 1]
    order_y = list(np.argsort(y, kind='stable'))
    order_x = list(np.argsort(x, kind='stable'))
    # Area fraction is 1 - inset for both orientations and corner rounding only
    # removes a tiny area, so it seeds the pointed-end inset without assuming .25.
    area_fraction = _mask_area(contour_mask) / float(ANALYSIS * ANALYSIS)
    inset_guess = _clamp(1.0 - area_fraction, 0.02, 0.48)
    for orientation in ('horizontal', 'vertical'):
        slant_angles = []
        pairs = ()
        if orientation == 'horizontal':
            top = order_y[:2]
            bottom = order_y[4:]
            remaining = [index for index in range(6) if index not in top and index not in bottom]
            if len(remaining) != 2:
                continue
            if abs(float(np.mean(y[top]))) > 0.12 or abs(float(np.mean(y[bottom])) - 1.0) > 0.12:
                continue
            if abs(float(y[top[0]]) - float(y[top[1]])) > 0.10:
                continue
            if abs(float(y[bottom[0]]) - float(y[bottom[1]])) > 0.10:
                continue
            left = min(remaining, key=lambda index: x[index])
            right = max(remaining, key=lambda index: x[index])
            if x[left] > 0.12 or x[right] < 0.88:
                continue
            if abs(float(y[left]) - 0.5) > 0.18 or abs(float(y[right]) - 0.5) > 0.18:
                continue
            top_sorted = sorted(top, key=lambda index: x[index])
            bottom_sorted = sorted(bottom, key=lambda index: x[index])
            top_inset = 0.5 * (1.0 - (float(vertices[top_sorted[1], 0]) -
                                      float(vertices[top_sorted[0], 0])) / width)
            bottom_inset = 0.5 * (1.0 - (float(vertices[bottom_sorted[1], 0]) -
                                         float(vertices[bottom_sorted[0], 0])) / width)
            if abs(top_inset - bottom_inset) > 0.08:
                continue
            top_left, top_right = top_sorted
            bottom_left, bottom_right = bottom_sorted
            if _angle_to_horizontal(vertices, top_left, top_right) > 8.0:
                continue
            if _angle_to_horizontal(vertices, bottom_left, bottom_right) > 8.0:
                continue
            pairs = ((top_left, top_right, bottom_left, bottom_right),
                     (top_right, right, left, bottom_left),
                     (right, bottom_right, top_left, left))
            slant_angles = [_angle_to_horizontal(vertices, top_right, right),
                            _angle_to_horizontal(vertices, right, bottom_right),
                            _angle_to_horizontal(vertices, bottom_left, left),
                            _angle_to_horizontal(vertices, left, top_left)]

            def prototype(value):
                return np.array([[value, 0.0], [1.0 - value, 0.0], [1.0, 0.5],
                                 [1.0 - value, 1.0], [value, 1.0], [0.0, 0.5]])
        else:
            left_pair = order_x[:2]
            right_pair = order_x[4:]
            remaining = [index for index in range(6)
                         if index not in left_pair and index not in right_pair]
            if len(remaining) != 2:
                continue
            if abs(float(np.mean(x[left_pair]))) > 0.12 or \
                    abs(float(np.mean(x[right_pair])) - 1.0) > 0.12:
                continue
            if abs(float(x[left_pair[0]]) - float(x[left_pair[1]])) > 0.10:
                continue
            if abs(float(x[right_pair[0]]) - float(x[right_pair[1]])) > 0.10:
                continue
            top = min(remaining, key=lambda index: y[index])
            bottom = max(remaining, key=lambda index: y[index])
            if y[top] > 0.12 or y[bottom] < 0.88:
                continue
            if abs(float(x[top]) - 0.5) > 0.18 or abs(float(x[bottom]) - 0.5) > 0.18:
                continue
            left_sorted = sorted(left_pair, key=lambda index: y[index])
            right_sorted = sorted(right_pair, key=lambda index: y[index])
            left_inset = 0.5 * (1.0 - (float(vertices[left_sorted[1], 1]) -
                                       float(vertices[left_sorted[0], 1])) / height)
            right_inset = 0.5 * (1.0 - (float(vertices[right_sorted[1], 1]) -
                                        float(vertices[right_sorted[0], 1])) / height)
            if abs(left_inset - right_inset) > 0.08:
                continue
            left_top, left_bottom = left_sorted
            right_top, right_bottom = right_sorted
            if abs(_angle_to_horizontal(vertices, left_top, left_bottom) - 90.0) > 8.0:
                continue
            if abs(_angle_to_horizontal(vertices, right_top, right_bottom) - 90.0) > 8.0:
                continue
            pairs = ((left_top, left_bottom, right_top, right_bottom),
                     (top, right_top, left_bottom, bottom),
                     (top, left_top, right_bottom, bottom))
            slant_angles = [_angle_to_horizontal(vertices, top, right_top),
                            _angle_to_horizontal(vertices, bottom, right_bottom),
                            _angle_to_horizontal(vertices, top, left_top),
                            _angle_to_horizontal(vertices, bottom, left_bottom)]

            def prototype(value):
                return np.array([[0.5, 0.0], [1.0, value], [1.0, 1.0 - value],
                                 [0.5, 1.0], [0.0, 1.0 - value], [0.0, value]])
        parallel = True
        for first_a, first_b, second_a, second_b in pairs:
            if _angle_between(vertices[first_b] - vertices[first_a],
                              vertices[second_b] - vertices[second_a]) > 9.0:
                parallel = False
                break
        if not parallel:
            continue
        slant = float(np.median(slant_angles))
        if not 1.0 <= slant <= 89.0:
            continue
        best = None
        center = inset_guess
        for step, span in ((0.01, 0.05), (0.0025, 0.01)):
            offset = -span
            while offset <= span + 1e-9:
                value = center + offset
                if 0.02 <= value <= 0.48:
                    points = prototype(value)
                    iou = _mask_iou(_render(points), contour_mask)
                    if best is None or iou > best[1] + 1e-9:
                        best = (value, iou, points)
                offset += step
            if best is None:
                break
            center = best[0]
        if best is None:
            continue
        return _make_candidate('hexagon', best[2],
                               {'headDepth': _r(best[0], 3), 'slantAngle': _r(slant, 2),
                                'orientation': orientation}, contour_mask)
    return None



def classify_shape(contour, allowed_kinds=None):
    """Classify one external contour (canvas coordinates) into a base primitive."""
    points = _clean_points(contour)
    if points is None or len(points) < 3:
        return _degenerate_result('轮廓少于3个有效点')
    points = _orient_points(points)
    mins = points.min(axis=0)
    maxs = points.max(axis=0)
    extent = maxs - mins
    if float(extent[0]) < 2.0 or float(extent[1]) < 2.0:
        return _degenerate_result('轮廓包围盒过小')
    normalized = np.clip((points - mins) / extent, 0.0, 1.0)
    contour_mask = _render(normalized)
    contour_area = _mask_area(contour_mask)
    if contour_area < 12:
        return _degenerate_result('轮廓填充面积过小')
    hull_points = cv2.convexHull(_curve(points)).reshape(-1, 2)
    hull_normalized = np.clip((hull_points - mins) / extent, 0.0, 1.0)
    hull_area = _mask_area(_render(hull_normalized))
    defect = 0.0 if hull_area <= 0 else max(0.0, (hull_area - contour_area) / float(hull_area))
    convex = defect <= 0.012
    perimeter = float(cv2.arcLength(_curve(points), True))
    coarse = _approx(points, max(0.8, perimeter * 0.02))
    vertices = len(coarse)

    candidates = []
    implied_freeform = False
    allowed=set(allowed_kinds) if allowed_kinds else None
    if allowed is None or allowed.intersection(('circle','ellipse')):candidates.extend(_ellipse_candidates(points, contour_mask))
    if convex:
        if allowed is None or allowed.intersection(('rectangle','roundedRectangle')):candidates.extend(_rect_family_candidates(points, contour_mask, extent))
        if vertices == 3:
            candidate = _measured_candidate('triangle', coarse, contour_mask)
            if candidate is not None:
                candidates.append(candidate)
        elif vertices == 4:
            quadrilateral, implied_freeform = _quadrilateral_candidates(coarse, contour_mask)
            candidates.extend(quadrilateral)
        elif vertices == 5:
            candidate = _flat_arrow_candidate(points, contour_mask, coarse)
            if candidate is not None:
                candidates.append(candidate)
            pentagon = _regular_candidate('pentagon', 5, -90.0, points, contour_mask, coarse)
            if pentagon is not None:
                candidates.append(pentagon)
            else:
                implied_freeform = True
        elif vertices == 6:
            hexagon = _hexagon_candidate(points, contour_mask, coarse)
            if hexagon is not None:
                candidates.append(hexagon)
            else:
                implied_freeform = True
        elif vertices >= 7:
            # Heavily rounded symmetric hexagons can approximate to more vertices.
            polygon = _approx_count(points, 6)
            if polygon is not None:
                hexagon = _hexagon_candidate(points, contour_mask, polygon)
                if hexagon is not None:
                    candidates.append(hexagon)
    else:
        candidate = _star_candidate(points, contour_mask) if allowed is None or 'star5' in allowed else None
        if candidate is not None:
            candidates.append(candidate)
        if allowed is None or allowed.intersection(('notchedArrow','flatArrow','shaftArrow')):candidates.extend(_arrow_candidates(points, contour_mask, coarse))

    if allowed is not None:candidates=[candidate for candidate in candidates if candidate['kind'] in allowed]

    if not candidates:
        return _freeform_result(points, mins, extent, 0.0, [], '没有可用的规则原型')
    for candidate in candidates:
        candidate['score'] = _similarity(candidate['mask'], contour_mask)
    best_by_kind = {}
    for candidate in candidates:
        current = best_by_kind.get(candidate['kind'])
        if current is None or candidate['score'] > current['score'] + 1e-9:
            best_by_kind[candidate['kind']] = candidate
    ranked = sorted(best_by_kind.values(),
                    key=lambda item: (-item['score'], KIND_PRIORITY.get(item['kind'], 99)))
    top = ranked[0]
    tied = [candidate for candidate in ranked if top['score'] - candidate['score'] <= 0.004]
    chosen = min(tied, key=lambda item: KIND_PRIORITY.get(item['kind'], 99))
    runner = next((candidate for candidate in ranked if candidate['kind'] != chosen['kind']), None)
    margin = 0.08 if runner is None else max(0.0, chosen['score'] - runner['score'])
    score = _clamp(chosen['score'])
    quality = _clamp((score - 0.86) / 0.12)
    confidence = _clamp(0.60 * quality + 0.25 * _clamp(margin / 0.08) +
                        0.15 * _clamp(chosen.get('feature', 1.0)))
    alternatives = [{'kind': candidate['kind'], 'score': _r(_clamp(candidate['score']), 3)}
                    for candidate in ranked if candidate['kind'] != chosen['kind']][:2]
    diagnostics = {'method': 'normalized-prototype-IoU+chamfer+feature-evidence',
                   'vertices': vertices, 'convexityDefect': _r(defect, 4),
                   'convex': convex, 'impliedFreeform': implied_freeform,
                   'iou': _r(chosen['iou'], 4),
                   'margin': _r(margin, 4), 'alternatives': alternatives}
    strict_freeform = implied_freeform and score < 0.985
    if score < FREE_SCORE or confidence < FREE_CONFIDENCE or strict_freeform:
        if strict_freeform and score >= FREE_SCORE and confidence >= FREE_CONFIDENCE:
            reason = '凸多边形缺少对称/平行结构证据，不强行套用规则形状'
        elif score < FREE_SCORE:
            reason = '原型IoU/边界分数不足'
        else:
            reason = '候选种类区分度不足'
        return _freeform_result(points, mins, extent, score, alternatives, reason,
                                best_kind=chosen['kind'], extra=diagnostics)
    diagnostics['accepted'] = True
    return {'kind': chosen['kind'], 'score': _r(score, 3),
            'confidence': _r(confidence, 3), 'parameters': dict(chosen['parameters']),
            'points': _point_list(chosen['points']), 'box': _box(mins, extent),
            'diagnostics': diagnostics}


def main():
    try:
        payload = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
        items = payload.get('contours', []) if isinstance(payload, dict) else payload
        shapes = []
        timings = []
        for item in items or []:
            if isinstance(item, dict):
                contour = item.get('contour', item.get('points'))
                identifier = item.get('id')
            else:
                contour, identifier = item, None
            started = time.perf_counter()
            if contour is None:
                result = _degenerate_result('缺少轮廓点')
            else:
                result = classify_shape(np.asarray(contour, dtype=np.float64))
            timings.append(round((time.perf_counter() - started) * 1000.0, 3))
            if identifier is not None:
                result['id'] = str(identifier)
            shapes.append(result)
        target = Path(sys.argv[2])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps({'status': 'available', 'shapes': shapes,
                                      'timings': timings}, ensure_ascii=False),
                          encoding='utf-8')
    except Exception as error:  # keep the tool's contract: never fail the caller hard
        print(json.dumps({'status': 'unavailable', 'error': str(error)[:500]}, ensure_ascii=False))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
