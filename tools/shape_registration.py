#!/usr/bin/env python
"""Registration + completion for the committed S2 path.

Input spec (JSON): {preview, background?, elements:[...], minAreaRatio?}
- seeds are the elements already registered by the rebuild pipeline (audit/committed list);
- the preview is compared with the registered background; foreground regions not covered by
  any non-text seed are registered as automatic frame candidates (补全);
- every seed is kept: text/image/svg/cutout pass through, shapes become fitting targets.
- independent narrow bright geometric cores (e.g. a slanted illuminated strip drawn between
  panels) that the audit missed are registered directly as SVG effects, but only with
  continuous/strong ridge evidence that is absent from the wordless background, is not text or a
  registered image, is not a near-parallel copy of an existing shape/line edge, and is not a soft
  halo or ornamental arc. The auto-frame logic is unchanged; the new lines are appended as
  foreground effects so they are not buried by the completion frames.

Output: registry JSON with the complete element list, auto frames, auto lines and coverage stats.
CLI: python tools/shape_registration.py <spec.json> <out.json>
"""
import json
import math
import sys

import cv2
import numpy as np

WIDTH, HEIGHT = 1600, 900
PASS_TYPES = {'text', 'formula', 'image', 'svg', 'cutout', 'crop', 'generate'}
SHAPE_TYPES = {'shape', 'rect', 'ellipse', 'line'}
PROTOTYPES = {'hexagon', 'chevron', 'triangle', 'trapezoid', 'arrow', 'rightArrow', 'leftArrow', 'upArrow', 'downArrow'}


def load(path):
    image = cv2.imread(path)
    if image is None:
        return None
    return cv2.resize(image, (WIDTH, HEIGHT))


def classify(mask, box):
    x, y, w, h = box
    region = np.zeros_like(mask)
    region[y:y + h, x:x + w] = mask[y:y + h, x:x + w]
    contours = cv2.findContours(region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]
    if not contours:
        return 'roundRect', 4
    contour = max(contours, key=cv2.contourArea)
    approx = cv2.approxPolyDP(contour, 0.02 * max(4.0, 2 * (w + h)), True)
    vertices = len(approx)
    aspect = w / max(1.0, h)
    if 5 <= vertices <= 7 and 0.7 <= aspect <= 1.4:
        return 'hexagon', vertices
    if 3 <= vertices <= 4:
        return 'rect', vertices
    return 'roundRect', vertices


def discover_frames(preview, background, min_area_ratio, protected=()):
    diff = np.abs(preview.astype(np.int16) - background.astype(np.int16)).max(axis=2).astype(np.uint8)
    mask = (diff > 14).astype(np.uint8)
    # Text and formulas are already native objects. Their glyphs are not missing frames.
    for element in protected:
        x, y, w, h = (float(element.get(key, 0)) for key in ('x', 'y', 'w', 'h'))
        left, top = max(0, int(np.floor(x)) - 2), max(0, int(np.floor(y)) - 2)
        right, bottom = min(WIDTH, int(np.ceil(x + w)) + 2), min(HEIGHT, int(np.ceil(y + h)) + 2)
        if right > left and bottom > top:
            mask[top:bottom, left:right] = 0
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, 8)
    frames = []
    page_area = WIDTH * HEIGHT
    for component in range(1, count):
        x, y, w, h, area = [int(value) for value in stats[component]]
        if area < max(900, page_area * min_area_ratio):
            continue
        if w > WIDTH * 0.92 and h > HEIGHT * 0.92:
            continue
        if w < 18 or h < 12:
            continue
        # A clipped background ornament has no closed contour to reconstruct.
        # Its difference bbox must not be promoted into a new opaque panel.
        if x<=1 or y<=1 or x+w>=WIDTH-1 or y+h>=HEIGHT-1:
            continue
        component_mask = labels[y:y + h, x:x + w] == component
        # Sparse contours and disconnected glyphs are evidence candidates, not solid carriers.
        if area / max(1, w * h) < 0.55:
            continue
        inside = preview[y:y + h, x:x + w][component_mask]
        if len(inside) == 0:
            continue
        median = np.median(inside, axis=0)
        fill = '%02X%02X%02X' % (int(median[2]), int(median[1]), int(median[0]))
        kind, vertices = classify(mask, (x, y, w, h))
        frames.append({'x': x, 'y': y, 'w': w, 'h': h, 'area': area, 'fill': fill,
                       'kind': kind, 'vertices': vertices})
    frames.sort(key=lambda frame: -frame['area'])
    return frames


def overlap_ratio(frame, element):
    ix = max(0, min(frame['x'] + frame['w'], element['x'] + element['w']) - max(frame['x'], element['x']))
    iy = max(0, min(frame['y'] + frame['h'], element['y'] + element['h']) - max(frame['y'], element['y']))
    return (ix * iy) / max(1, min(frame['w'] * frame['h'], max(1, element['w'] * element['h'])))


# ---------------------------------------------------------------- missing light-strip cores
# Conservative, deterministic completion for narrow long bright geometric cores that the saved
# audit missed. All thresholds are relative to the page (no page-specific ids/coordinates/colors),
# and any weak/ambiguous evidence returns nothing instead of inventing a line.
LIGHT_STRIP_MIN_LENGTH = 220.0
LIGHT_STRIP_CORE_DIFF = 30.0
LIGHT_STRIP_MAX_THICKNESS = 7.0
LIGHT_STRIP_MIN_CONTRAST = 45.0
LIGHT_STRIP_SIDE_SYMMETRY = 15.0
LIGHT_STRIP_MIN_COVERAGE = 0.78
LIGHT_STRIP_PROTECTED_RATIO = 0.20
LIGHT_STRIP_PARALLEL_DEG = 6.0
LIGHT_STRIP_EDGE_DISTANCE = 5.0
LIGHT_STRIP_MAX_COUNT = 3


def _unit(vector):
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm > 1e-9 else np.array([1.0, 0.0])


def _luma(image):
    blue, green, red = (image[:, :, index].astype(np.float32) for index in range(3))
    return 0.299 * red + 0.587 * green + 0.114 * blue


def _bgr_hex(pixel):
    return '%02X%02X%02X' % (int(pixel[2]), int(pixel[1]), int(pixel[0]))


def _polyline(element):
    """Straight-edge polyline of an already registered native element (line handled separately)."""
    x, y, w, h = (float(element.get(key, 0) or 0) for key in ('x', 'y', 'w', 'h'))
    geometry = element.get('customGeometry')
    source = []
    if isinstance(geometry, dict):
        points = geometry.get('points')
        commands = geometry.get('commands')
        if isinstance(points, list) and points:
            source = [point for point in points
                      if isinstance(point, (list, tuple)) and len(point) >= 2]
        elif isinstance(commands, list) and commands:
            for command in commands:
                if not isinstance(command, dict):
                    continue
                source.extend(point for point in command.get('points') or []
                              if isinstance(point, (list, tuple)) and len(point) >= 2)
        if source:
            normalized = all(0.0 <= float(point[0]) <= 1.0 and 0.0 <= float(point[1]) <= 1.0
                             for point in source)
            if normalized:
                return np.asarray([[x + float(point[0]) * w, y + float(point[1]) * h]
                                   for point in source], float)
            return np.asarray([[float(point[0]), float(point[1])] for point in source], float)
    if str(element.get('type') or '') in ('rect', 'shape'):
        return np.asarray([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], float)
    return None


def _existing_edges(elements):
    edges = []
    for element in elements:
        kind = str(element.get('type') or '')
        if kind == 'line':
            from line_geometry import straight_edges
            edges.extend((start,end) for start,end in straight_edges(element) if np.linalg.norm(end-start)>=6)
            continue
        if kind not in ('shape', 'rect'):
            continue  # ellipse/other curved outlines are not straight-edge evidence
        polygon = _polyline(element)
        if polygon is None or len(polygon) < 3:
            continue
        for index in range(len(polygon)):
            start, end = polygon[index], polygon[(index + 1) % len(polygon)]
            if float(np.linalg.norm(end - start)) >= 12.0:
                edges.append((start, end))
    return edges


def _protected_boxes(elements):
    boxes = []
    for element in elements:
        if str(element.get('type') or '') not in PASS_TYPES:
            continue
        x, y, w, h = (float(element.get(key, 0) or 0) for key in ('x', 'y', 'w', 'h'))
        if w > 0 and h > 0:
            boxes.append((x, y, x + w, y + h))
    return boxes


def _protected_overlap(start, end, boxes):
    if not boxes:
        return 0.0
    hits = 0
    samples = 40
    for step in range(samples):
        point = start + (end - start) * (step / float(samples - 1))
        if any(left <= point[0] <= right and top <= point[1] <= bottom
               for left, top, right, bottom in boxes):
            hits += 1
    return hits / float(samples)


def _near_parallel_edge(start, end, edges):
    length = float(np.linalg.norm(end - start))
    if length < 1e-6:
        return False
    direction = _unit(end - start)
    for edge_start, edge_end in edges:
        edge_vector = edge_end - edge_start
        edge_length = float(np.linalg.norm(edge_vector))
        if edge_length < 24.0:
            continue
        edge_direction = _unit(edge_vector)
        angle = math.degrees(math.acos(max(-1.0, min(1.0, float(np.dot(direction, edge_direction))))))
        angle = min(angle, 180.0 - angle)
        if angle > LIGHT_STRIP_PARALLEL_DEG:
            continue
        normal = np.array([-edge_direction[1], edge_direction[0]])
        distances = []
        for step in range(max(8, int(length / 8.0))):
            point = start + (end - start) * (step / float(max(1, int(length / 8.0)) - 1))
            projection = float(np.dot(point - edge_start, edge_direction))
            if projection < -12.0 or projection > edge_length + 12.0:
                continue
            distances.append(abs(float(np.dot(point - edge_start, normal))))
        if len(distances) >= 6 and float(np.mean(np.asarray(distances) <= LIGHT_STRIP_EDGE_DISTANCE)) >= 0.6:
            return True
    return False


def _core_threshold(luma, diff):
    valid = luma[diff >= 20.0]
    if valid.size == 0:
        return 150.0
    return float(max(145.0, min(205.0, float(np.percentile(valid, 99.0)) * 0.66)))


def _refine_light_strip(preview, luma, diff, core, core_threshold, line, protected, edges):
    """Refine one Hough candidate into a straight native line with measured evidence, or None."""
    start = np.array([float(line[0]), float(line[1])])
    end = np.array([float(line[2]), float(line[3])])
    length = float(np.linalg.norm(end - start))
    if length < LIGHT_STRIP_MIN_LENGTH * 0.55:
        return None
    direction = _unit(end - start)
    normal = np.array([-direction[1], direction[0]])
    pad = 6
    x0 = max(0, int(np.floor(min(start[0], end[0]))) - pad)
    x1 = min(WIDTH - 1, int(np.ceil(max(start[0], end[0]))) + pad)
    y0 = max(0, int(np.floor(min(start[1], end[1]))) - pad)
    y1 = min(HEIGHT - 1, int(np.ceil(max(start[1], end[1]))) + pad)
    ys, xs = np.nonzero((luma[y0:y1 + 1, x0:x1 + 1] >= core_threshold)
                        & (diff[y0:y1 + 1, x0:x1 + 1] >= LIGHT_STRIP_CORE_DIFF))
    if len(xs) < 60:
        return None
    points = np.column_stack([xs + x0, ys + y0]).astype(np.float32)
    relative = points - start
    along = relative @ direction
    across = relative @ normal
    keep = (np.abs(across) <= 4.5) & (along >= -0.15 * length) & (along <= length * 1.15)
    points = points[keep]
    if len(points) < 60:
        return None
    fit = cv2.fitLine(points, cv2.DIST_L2, 0, 0.01, 0.01).ravel()
    fit_direction = _unit(np.array([float(fit[0]), float(fit[1])], float))
    if float(np.dot(fit_direction, direction)) < 0:
        fit_direction = -fit_direction
    fit_point = np.array([float(fit[2]), float(fit[3])], float)
    fit_normal = np.array([-fit_direction[1], fit_direction[0]])
    projection = (points - fit_point) @ fit_direction
    residual = np.abs((points - fit_point) @ fit_normal)
    if float(np.median(residual)) > 1.1 or float(np.percentile(residual, 95)) > 2.6:
        return None  # ornamental arc or curved ornament: not a straight core
    t_min, t_max = float(projection.min()), float(projection.max())
    span = t_max - t_min
    if span < LIGHT_STRIP_MIN_LENGTH:
        return None
    bin_index = np.digitize(projection, np.arange(t_min, t_max + 4.0, 4.0)) - 1
    valid_bins = (bin_index >= 0) & (bin_index < max(1, int(math.ceil((t_max - t_min) / 4.0)) + 1))
    if valid_bins.sum() < 60:
        return None
    occupied = np.zeros(max(1, int(math.ceil((t_max - t_min) / 4.0)) + 1), dtype=bool)
    occupied[bin_index[valid_bins]] = True
    coverage = float(occupied.mean())
    if coverage < LIGHT_STRIP_MIN_COVERAGE:
        return None  # dashed / interrupted ornament
    point_pixels = points.astype(int)
    core_widths = []
    for step in np.linspace(0.15, 0.85, 15):
        point = fit_point + fit_direction * (t_min + (t_max - t_min) * step)
        width = 0.0
        for offset in np.arange(-4.0, 4.01, 0.5):
            px = int(round(point[0] + fit_normal[0] * offset))
            py = int(round(point[1] + fit_normal[1] * offset))
            if 0 <= px < WIDTH and 0 <= py < HEIGHT and core[py, px]:
                width += 0.5
        core_widths.append(width)
    thickness = float(np.median(core_widths)) if core_widths else 0.0
    if thickness < 1.0 or thickness > LIGHT_STRIP_MAX_THICKNESS:
        return None  # soft halo / wide glow band, not a narrow core
    halo = (luma >= max(70.0, core_threshold - 110.0)) & (diff >= 18.0)

    def extend(point, step_direction):
        traveled = 0.0
        gap = 0
        for index in range(1, 140):
            candidate = point + step_direction * (index * 2.0)
            xi, yi = int(round(candidate[0])), int(round(candidate[1]))
            if not (0 <= xi < WIDTH and 0 <= yi < HEIGHT):
                break
            found = False
            for offset in range(-5, 6):
                px = int(round(candidate[0] + fit_normal[0] * offset))
                py = int(round(candidate[1] + fit_normal[1] * offset))
                if 0 <= px < WIDTH and 0 <= py < HEIGHT and halo[py, px]:
                    found = True
                    break
            if found:
                traveled = index * 2.0
                gap = 0
            else:
                gap += 1
                if gap > 4:
                    break
        return point + step_direction * traveled

    start_point = extend(fit_point + fit_direction * t_min, -fit_direction)
    end_point = extend(fit_point + fit_direction * t_max, fit_direction)
    extended_span = float(np.linalg.norm(end_point - start_point))
    if extended_span < LIGHT_STRIP_MIN_LENGTH:
        return None
    core_samples, left_samples, right_samples = [], [], []
    for step in np.linspace(0.12, 0.88, 15):
        point = start_point + (end_point - start_point) * step
        peak = 0.0
        for offset in range(-2, 3):
            px = int(round(point[0] + fit_normal[0] * offset))
            py = int(round(point[1] + fit_normal[1] * offset))
            if 0 <= px < WIDTH and 0 <= py < HEIGHT:
                peak = max(peak, float(luma[py, px]))
        core_samples.append(peak)
        sides = []
        for sign in (-1.0, 1.0):
            values = []
            for offset in range(8, 13):
                px = int(round(point[0] + fit_normal[0] * offset * sign))
                py = int(round(point[1] + fit_normal[1] * offset * sign))
                if 0 <= px < WIDTH and 0 <= py < HEIGHT:
                    values.append(float(luma[py, px]))
            sides.append(float(np.mean(values)) if values else 0.0)
        left_samples.append(sides[0])
        right_samples.append(sides[1])
    mean_core = float(np.mean(core_samples))
    if mean_core < 150.0:
        return None
    contrast = [core - max(left, right) for core, left, right in
                zip(core_samples, left_samples, right_samples)]
    if float(np.mean(contrast)) < LIGHT_STRIP_MIN_CONTRAST:
        return None  # soft glow only: no sharp bright core
    if float(np.median([abs(left - right) for left, right in
                        zip(left_samples, right_samples)])) > LIGHT_STRIP_SIDE_SYMMETRY:
        return None  # one side is a panel fill: this is a panel border, not an isolated strip
    if _protected_overlap(start_point, end_point, protected) >= LIGHT_STRIP_PROTECTED_RATIO:
        return None  # text / formula / registered image region
    if _near_parallel_edge(start_point, end_point, edges):
        return None  # duplicate of an existing shape/line edge
    core_pixels = preview[np.clip(point_pixels[:, 1], 0, HEIGHT - 1),
                          np.clip(point_pixels[:, 0], 0, WIDTH - 1)]
    core_luma = [float(0.299 * pixel[2] + 0.587 * pixel[1] + 0.114 * pixel[0])
                 for pixel in core_pixels[::max(1, len(core_pixels) // 200)]]
    bright = np.asarray([pixel for pixel, value in zip(core_pixels[::max(1, len(core_pixels) // 200)], core_luma)
                         if value >= float(np.median(core_luma))])
    color = _bgr_hex(np.median(bright if len(bright) else core_pixels, axis=0))
    # Measure an independent SVG light bar's halo, never a native line effect.
    halo_widths, halo_contrasts, halo_pixels = [], [], []
    for step in np.linspace(0.18, 0.82, 11):
        point = start_point + (end_point - start_point) * step
        background_values = []
        for sign in (-1.0, 1.0):
            for offset in range(11, 15):
                px = int(round(point[0] + fit_normal[0] * offset * sign))
                py = int(round(point[1] + fit_normal[1] * offset * sign))
                if 0 <= px < WIDTH and 0 <= py < HEIGHT:
                    background_values.append(float(luma[py, px]))
        background_level = float(np.median(background_values)) if background_values else 0.0
        width = 0
        halo_values = []
        for sign in (-1.0, 1.0):
            for offset in range(int(thickness / 2.0) + 1, 15):
                px = int(round(point[0] + fit_normal[0] * offset * sign))
                py = int(round(point[1] + fit_normal[1] * offset * sign))
                if not (0 <= px < WIDTH and 0 <= py < HEIGHT):
                    break
                value = float(luma[py, px])
                if value >= background_level + 5.0:
                    width += 1
                    halo_values.append(value)
                    halo_pixels.append(preview[py, px])
                else:
                    break
        halo_widths.append(width)
        halo_contrasts.append((float(np.mean(halo_values)) - background_level) if halo_values else 0.0)
    halo_span = float(np.median(halo_widths))
    halo_contrast = float(np.median(halo_contrasts))
    glow = None
    if 2.0 <= halo_span <= 20.0 and halo_contrast >= 5.0 and halo_pixels:
        # Glow uses the registered core colour: sampling the dim halo median would produce a dark
        # blue shadow instead of light. Opacity/radius stay from measured halo evidence.
        glow = {'color': color,
                'opacity': round(float(np.clip(halo_contrast / 140.0 * 0.55, 0.12, 0.45)), 2),
                'radius': round(float(np.clip(halo_span * 0.8, 2.0, 16.0)), 1)}
    left, right = float(min(start_point[0], end_point[0])), float(max(start_point[0], end_point[0]))
    top, bottom = float(min(start_point[1], end_point[1])), float(max(start_point[1], end_point[1]))
    geometry = {'x': round(left, 1), 'y': round(top, 1), 'w': round(max(0.0, right - left), 1),
                'h': round(max(0.0, bottom - top), 1),
                'flipH': bool(end_point[0] < start_point[0]),
                'flipV': bool(end_point[1] < start_point[1]),
                'strokeWidth': round(float(max(1.0, min(6.0, thickness))), 1),
                'color': color,
                'length': round(extended_span, 1), 'coreLength': round(span, 1),
                'coverage': round(coverage, 3), 'thickness': round(thickness, 2),
                'contrast': round(float(np.mean(contrast)), 1),
                'brightness': round(mean_core, 1), 'haloWidth': round(halo_span, 1)}
    if glow:
        geometry['glow'] = glow
    return geometry


def discover_light_strips(preview, background, elements):
    """Register missing independent bright cores as complete SVG effects."""
    if preview is None or background is None:
        return []
    luma = _luma(preview)
    diff = np.maximum.reduce([np.abs(preview[:, :, index].astype(np.float32)
                                     - background[:, :, index].astype(np.float32)) for index in range(3)])
    threshold = _core_threshold(luma, diff)
    core = ((luma >= threshold) & (diff >= LIGHT_STRIP_CORE_DIFF)).astype(np.uint8)
    core = cv2.morphologyEx(core, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    if int(core.sum()) < 400:
        return []
    lines = cv2.HoughLinesP(core, 1, np.pi / 720, threshold=28,
                            minLineLength=int(LIGHT_STRIP_MIN_LENGTH * 0.55), maxLineGap=14)
    if lines is None:
        return []
    protected = _protected_boxes(elements)
    edges = _existing_edges(elements)
    candidates = sorted([tuple(int(value) for value in line) for line in lines[:, 0]],
                        key=lambda line: (-float(np.hypot(line[2] - line[0], line[3] - line[1])),
                                          line[1], line[0]))
    accepted = []
    for line in candidates:
        refined = _refine_light_strip(preview, luma, diff, core, threshold, line, protected, edges)
        if refined is None:
            continue
        if any(_same_light_strip(refined, other) for other in accepted):
            continue
        accepted.append(refined)
        if len(accepted) >= LIGHT_STRIP_MAX_COUNT:
            break
    accepted.sort(key=lambda item: (item['y'], item['x']))
    return accepted


def _same_light_strip(first, second):
    first_start = np.array([first['x'] + (first['w'] if first['flipH'] else 0.0),
                            first['y'] + (first['h'] if first['flipV'] else 0.0)])
    second_start = np.array([second['x'] + (second['w'] if second['flipH'] else 0.0),
                             second['y'] + (second['h'] if second['flipV'] else 0.0)])
    if float(np.linalg.norm(first_start - second_start)) > 14.0:
        return False
    if abs(first['length'] - second['length']) > max(12.0, 0.08 * max(first['length'], second['length'])):
        return False
    return abs(first['contrast'] - second['contrast']) < 60.0


def light_strip_element(strip,key):
    from xml.sax.saxutils import escape
    width=strip['strokeWidth'];glow=strip.get('glow') or {}
    pad=max(3,width/2+2,float(glow.get('radius',0))*2)
    w,h=strip['w']+pad*2,strip['h']+pad*2
    x1=pad+(strip['w'] if strip['flipH'] else 0);x2=pad+(0 if strip['flipH'] else strip['w'])
    y1=pad+(strip['h'] if strip['flipV'] else 0);y2=pad+(0 if strip['flipV'] else strip['h'])
    color=escape(strip['color']);core=f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#{color}" stroke-width="{width}"/>'
    halo=''
    if glow:
        halo=f'<defs><filter id="halo" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="{glow["radius"]/2}"/></filter></defs><g opacity="{glow["opacity"]}" filter="url(#halo)">{core}</g>'
    return {'key':key,'type':'svg','x':strip['x']-pad,'y':strip['y']-pad,'w':w,'h':h,
            'svg':f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">{halo}{core}</svg>',
            'role':'effect','visualKind':'light-effect','effectKind':'lit-stroke','autoRegistered':True,
            'representationOrigin':'svg-light-bar','description':'按参考亮脊和柔光补登记的独立SVG光条',
            'recognitionEvidence':{'source':'preview-bright-ridge',**{field:strip[field] for field in
                ('length','coreLength','coverage','thickness','contrast','brightness','haloWidth') if field in strip},'foundationDiff':True},
            'lighting':{'coreConfirmed':True,'evidence':'continuous visible ridge with measured local halo, absent from foundation'}}


def main():
    spec_path, out_path = sys.argv[1], sys.argv[2]
    spec = json.load(open(spec_path, encoding='utf-8'))
    preview = load(spec['preview'])
    background = load(spec['background']) if spec.get('background') else None
    seeds = spec.get('elements') or []
    min_area_ratio = float(spec.get('minAreaRatio') or 0.0015)

    pass_through = [element for element in seeds if element.get('type') in PASS_TYPES]
    shape_seeds = [element for element in seeds if element.get('type') in SHAPE_TYPES]
    prototypes = [element for element in shape_seeds
                  if str(element.get('shape') or '').lower() in {name.lower() for name in PROTOTYPES}]
    auto_frames = []
    auto_lines = []
    coverage = {'diffFrames': 0, 'uncovered': 0, 'autoRegistered': 0, 'autoLines': 0,
                'fullPageDiff': 0.0}
    if preview is not None and background is not None:
        frames = discover_frames(preview, background, min_area_ratio,
                                 [e for e in seeds if e.get('type') in ('text', 'formula')]+list(spec.get('protected') or []))
        diff = np.abs(preview.astype(np.int16) - background.astype(np.int16)).max(axis=2)
        coverage['diffFrames'] = len(frames)
        coverage['fullPageDiff'] = round(float((diff > 14).mean()), 4)
        covered_by = [element for element in seeds if element.get('type') not in ('text', 'formula')]
        for frame in frames:
            if any(overlap_ratio(frame, element) >= 0.55 for element in covered_by):
                continue
            # A thin residual touching an existing same-colour body is its
            # missed extent, not evidence for a second opaque block.
            attached=False
            for element in shape_seeds:
                if min(frame['w'],frame['h'])>24:continue
                try:
                    a=np.array([int(frame['fill'][i:i+2],16) for i in (0,2,4)])
                    b=np.array([int(element.get('fill','')[i:i+2],16) for i in (0,2,4)])
                    gap_x=max(frame['x']-element['x']-element['w'],element['x']-frame['x']-frame['w'],0)
                    gap_y=max(frame['y']-element['y']-element['h'],element['y']-frame['y']-frame['h'],0)
                    overlap_x=max(0,min(frame['x']+frame['w'],element['x']+element['w'])-max(frame['x'],element['x']))
                    overlap_y=max(0,min(frame['y']+frame['h'],element['y']+element['h'])-max(frame['y'],element['y']))
                    if np.linalg.norm(a-b)<45 and max(gap_x,gap_y)<=5 and (overlap_x>=frame['w']*.8 or overlap_y>=frame['h']*.8):attached=True;break
                except (ValueError,TypeError):pass
            if attached:continue
            coverage['uncovered'] += 1
            number = len(auto_frames) + 1
            used = {e.get('key') for e in seeds + auto_frames}
            while 'auto-frame-' + str(number) in used:
                number += 1
            auto_frames.append({
                'key': 'auto-frame-' + str(number),
                'type': 'shape',
                'shape': frame['kind'],
                'x': frame['x'], 'y': frame['y'], 'w': frame['w'], 'h': frame['h'],
                'fill': frame['fill'], 'strokeWidth': 0,
                'classHint': frame['kind'], 'autoRegistered': True,
                'role': 'background-diff',
            })
        coverage['autoRegistered'] = len(auto_frames)
        # Missing narrow bright geometric cores (e.g. the slanted illuminated strip between p11
        # panels). Evidence only: continuous/strong ridge, absent from the wordless background,
        # not text/image, not a near-parallel existing edge, not a soft halo or ornament arc.
        strips = discover_light_strips(preview, background, list(seeds) + auto_frames + list(spec.get('protected') or []))
        used_keys = {element.get('key') for element in list(seeds) + auto_frames}
        for strip in strips:
            number = len(auto_lines) + 1
            while 'auto-line-' + str(number) in used_keys:
                number += 1
            key = 'auto-line-' + str(number)
            used_keys.add(key)
            auto_lines.append(light_strip_element(strip,key))
        coverage['autoLines'] = len(auto_lines)

    # New carriers belong behind the already audited text and foreground objects; the completed
    # light cores are foreground effect cores, so they are appended last (never behind the frames).
    from arc_light_completion import discover_arc_lights
    arcs=discover_arc_lights(preview,background,list(seeds)+list(spec.get('protected') or [])) if preview is not None and background is not None else []
    used={e.get('key') for e in auto_frames+list(seeds)+auto_lines}
    for i,arc in enumerate(arcs):
        key='auto-arc-'+str(i+1)
        while key in used:key+='x'
        arc['key']=key;used.add(key)
    coverage['autoArcs']=len(arcs)
    registry = arcs + auto_frames + list(seeds) + auto_lines
    targets = [element['key'] for element in registry if element.get('type') in SHAPE_TYPES]
    by_class = {}
    for element in registry:
        if element.get('type') in PASS_TYPES:
            name = element.get('type')
        else:
            name = str(element.get('shape') or element.get('type') or 'shape')
        by_class[name] = by_class.get(name, 0) + 1
    result = {
        'status': 'available',
        'registry': registry,
        'targets': targets,
        'counts': {'seeds': len(seeds), 'passThrough': len(pass_through),
                   'shapeSeeds': len(shape_seeds), 'prototypes': len(prototypes),
                   'autoRegistered': len(auto_frames), 'autoLines': len(auto_lines),
                   'total': len(registry)},
        'byClass': by_class,
        'coverage': coverage,
    }
    json.dump(result, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps({'status': 'available', 'counts': result['counts'], 'coverage': coverage,
                      'byClass': by_class}))


if __name__ == '__main__':
    main()
