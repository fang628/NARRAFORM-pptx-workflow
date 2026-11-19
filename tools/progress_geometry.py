"""Locate a header progress row and the geometry of each of its segments.

The locator only trusts observable evidence:

* the row band comes from long horizontal edges that enclose a smooth interior,
  so text lines, cards and badges do not become a navigation row;
* the row extent comes from the fill/silhouette mask against the surrounding
  colour, with a small hole tolerance for interlocking chevron notches;
* segment boundaries come from silhouette pinches (gaps between interlocking
  segments), narrow full-height strokes (bubble separators) and state colour
  jumps, and only as a declared downgrade from text projection when those are
  missing;
* each segment polygon is traced from its own colour region (actual body
  boundary) and falls back to a declared analytic approximation.

No equal splitting and no per-project or per-image rules are applied: when the
observed segment count cannot be trusted the locator returns None.  A supplied
hint only contributes one more candidate band; it never clips a detection.

Coordinates are normalized by the image width and height (the working canvas is
a width-1600 resample of the same aspect ratio, so the ratios are unchanged).
"""

import json
import sys

import numpy as np
from PIL import Image

CANVAS_WIDTH = 1600
SEARCH_FRACTION = 0.36          # progress rows live in the top of the page
ROW_HEIGHT_RANGE = (0.016, 0.115)
MIN_SPAN_FRACTION = 0.20        # of the canvas width
MIN_ASPECT = 5.0                # row width / row height
MAX_SEGMENTS = 12
CANDIDATE_BANDS = 14
CONFIDENCE_FLOOR = 0.50
HIGH_CONFIDENCE = 0.85
INK_FLOOR = 8.0


def _as_rgb(image):
    """Return an HxWx3 float32 array for a PIL image or a numpy array."""
    if image is None:
        return None
    if isinstance(image, np.ndarray):
        array = np.asarray(image)
        if array.ndim == 2:
            array = np.stack((array,) * 3, axis=-1)
        if array.ndim != 3 or array.shape[2] < 3:
            return None
        return array[:, :, :3].astype(np.float32)
    if not hasattr(image, 'convert'):
        return None
    return np.asarray(image.convert('RGB'), dtype=np.float32)


def _canvas(image):
    """Resample to a width-1600 canvas; return (canvas, original size)."""
    rgb = _as_rgb(image)
    if rgb is None:
        return None, None
    height, width = rgb.shape[:2]
    if width < 320 or height < 180:
        return None, None
    scale = CANVAS_WIDTH / float(width)
    target_height = max(96, int(round(height * scale)))
    if width == CANVAS_WIDTH and target_height == height:
        return rgb, (width, height)
    resized = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    resized = resized.resize((CANVAS_WIDTH, target_height), Image.BILINEAR)
    return np.asarray(resized, dtype=np.float32), (width, height)


def _fit_rgb(image, height, width):
    """Fit an optional background image to the working canvas."""
    rgb = _as_rgb(image)
    if rgb is None:
        return None
    if rgb.shape[:2] == (height, width):
        return rgb
    resized = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    resized = resized.resize((width, height), Image.BILINEAR)
    return np.asarray(resized, dtype=np.float32)


def _box_blur_x(values, radius):
    """Exact horizontal box mean over a (2*radius+1) window."""
    radius = max(0, int(radius))
    if radius == 0:
        return values.astype(np.float32)
    padded = np.pad(values.astype(np.float32), ((0, 0), (radius, radius), (0, 0)), mode='edge')
    cumulative = np.cumsum(padded, axis=1)
    zero = np.zeros_like(cumulative[:, :1, :])
    cumulative = np.concatenate((zero, cumulative), axis=1)
    width = 2 * radius + 1
    return (cumulative[:, width:, :] - cumulative[:, :-width, :]) / width


def _detail_map(rgb, radius):
    """High-frequency detail: text and thin strokes, not surfaces."""
    blurred = _box_blur_x(rgb, radius)
    return np.abs(rgb - blurred).max(axis=2)


def _smooth_1d(values, radius):
    values = np.asarray(values, dtype=np.float32)
    if values.size == 0 or radius <= 0:
        return values
    window = np.ones(2 * radius + 1, dtype=np.float32) / float(2 * radius + 1)
    return np.convolve(values, window, mode='same')


def _runs(flags):
    """Inclusive True runs of a 1-D boolean sequence."""
    result = []
    start = None
    for index, value in enumerate(flags):
        if value and start is None:
            start = index
        elif not value and start is not None:
            result.append((start, index - 1))
            start = None
    if start is not None:
        result.append((start, len(flags) - 1))
    return result


def _merge_runs(runs, max_gap):
    if not runs:
        return []
    merged = [list(runs[0])]
    for start, end in runs[1:]:
        if start - merged[-1][1] - 1 <= max_gap:
            merged[-1][1] = end
        else:
            merged.append([start, end])
    return [(int(start), int(end)) for start, end in merged]


def _local_maxima(values, threshold, min_distance):
    peaks = []
    for index in range(1, len(values) - 1):
        if values[index] < threshold:
            continue
        if values[index] < values[index - 1] or values[index] < values[index + 1]:
            continue
        if peaks and index - peaks[-1] < min_distance:
            if values[index] > values[peaks[-1]]:
                peaks[-1] = index
        else:
            peaks.append(index)
    return peaks


def _rdp(points, epsilon):
    """Ramer-Douglas-Peucker simplification of a 2-D polyline."""
    if len(points) < 3:
        return [tuple(point) for point in points]
    start = np.asarray(points[0], dtype=float)
    end = np.asarray(points[-1], dtype=float)
    delta = end - start
    length = float(np.hypot(delta[0], delta[1]))
    distances = []
    for point in points:
        offset = np.asarray(point, dtype=float) - start
        if length < 1e-6:
            distances.append(float(np.hypot(offset[0], offset[1])))
        else:
            distances.append(abs(delta[0] * offset[1] - delta[1] * offset[0]) / length)
    index = int(np.argmax(distances))
    if distances[index] > epsilon:
        left = _rdp(points[:index + 1], epsilon)
        right = _rdp(points[index:], epsilon)
        return left[:-1] + right
    return [tuple(points[0]), tuple(points[-1])]


def _simplify_chain(points, limit):
    if len(points) <= 2:
        return [(float(point[0]), float(point[1])) for point in points]
    if len(points) > 240:
        # Keep recursion shallow on very noisy boundaries: decimate first, the
        # final epsilon pass below still recovers the visible corners.
        stride = int(np.ceil(len(points) / 240.0))
        reduced = list(points[::stride])
        if reduced[-1] != points[-1]:
            reduced.append(points[-1])
        points = reduced
    epsilon = 0.8
    for _ in range(8):
        try:
            simplified = _rdp(points, epsilon)
        except RecursionError:
            simplified = [tuple(points[0]), tuple(points[-1])]
        if len(simplified) <= limit:
            return [(float(point[0]), float(point[1])) for point in simplified]
        epsilon *= 1.8
    return [(float(point[0]), float(point[1])) for point in simplified]


def _dedupe(points):
    cleaned = []
    for point in points:
        if cleaned and abs(point[0] - cleaned[-1][0]) < 0.6 and abs(point[1] - cleaned[-1][1]) < 0.6:
            continue
        cleaned.append((float(point[0]), float(point[1])))
    while len(cleaned) > 1 and abs(cleaned[0][0] - cleaned[-1][0]) < 0.6 \
            and abs(cleaned[0][1] - cleaned[-1][1]) < 0.6:
        cleaned.pop()
    return cleaned


def _trace_polygon(mask, x_offset, y_offset, point_limit=34):
    """Outline a body mask along its column-wise upper and lower boundary."""
    if mask is None or mask.size == 0 or mask.ndim != 2:
        return None
    rows = mask.shape[0]
    columns = mask.any(axis=0)
    filled = np.where(columns)[0]
    if filled.size < 4 or rows < 4:
        return None
    left = int(filled[0])
    right = int(filled[-1])
    local = mask[:, left:right + 1]
    if local.shape[1] < 4:
        return None
    upper = np.argmax(local, axis=0)
    lower = local.shape[0] - 1 - np.argmax(local[::-1], axis=0)
    present = local.any(axis=0)
    if present.any() and not present.all():
        # A hole (glyph or occlusion) must not turn the boundary into a spike;
        # interpolate only the missing columns between observed ones.
        positions = np.arange(local.shape[1], dtype=np.float32)
        known = positions[present]
        upper = np.interp(positions, known, upper[present]).astype(int)
        lower = np.interp(positions, known, lower[present]).astype(int)
    top_chain = [(x_offset + left + index, y_offset + int(upper[index]))
                 for index in range(local.shape[1])]
    bottom_chain = [(x_offset + left + index, y_offset + int(lower[index]))
                    for index in range(local.shape[1] - 1, -1, -1)]
    top_points = _simplify_chain(top_chain, point_limit // 2)
    bottom_points = _simplify_chain(bottom_chain, point_limit // 2)
    points = _dedupe(top_points + bottom_points)
    if len(points) < 3:
        return None
    return points


def _analytic_polygon(left, right, top, bottom, layout):
    """Declared approximation when a body cannot be separated by colour."""
    width = float(right - left)
    height = float(bottom - top)
    if width < 4 or height < 4:
        return None
    if layout == 'bubble':
        radius = min(height / 2.0, width * 0.45)
        points = [(left + radius, top), (right - radius, top),
                  (right, top + radius), (right, bottom - radius),
                  (right - radius, bottom), (left + radius, bottom),
                  (left, bottom - radius), (left, top + radius)]
    else:
        head = min(width * 0.28, height * 0.55)
        notch = min(head * 2.0, width * 0.45)
        middle = top + height / 2.0
        points = [(left + head, top), (right - head, top), (right, middle),
                  (right - head, bottom), (left + head, bottom), (left + notch, middle)]
    return [(float(x), float(y)) for x, y in points]


def _background_supported(rgb, background):
    """Only trust a background image that provably matches this page."""
    if background is None or background.shape != rgb.shape:
        return False, 0.0
    height, width = rgb.shape[:2]
    top = int(round(height * 0.60))
    bottom = int(round(height * 0.97))
    left = int(round(width * 0.06))
    right = int(round(width * 0.94))
    if bottom - top < 20 or right - left < 40:
        return False, 0.0
    difference = np.abs(rgb[top:bottom, left:right] - background[top:bottom, left:right]).max(axis=2)
    middle = float(np.median(difference))
    upper = float(np.percentile(difference, 90))
    return (middle < 5.0 and upper < 18.0), middle


def _outside_colors(rgb, y0, y1):
    """Background colour per column above/below a band, plus its own noise."""
    height = rgb.shape[0]
    strips = []
    top = rgb[max(0, y0 - 7):max(0, y0 - 1)]
    bottom = rgb[min(height, y1 + 1):min(height, y1 + 7)]
    if top.shape[0] >= 2:
        strips.append(top)
    if bottom.shape[0] >= 2:
        strips.append(bottom)
    if not strips:
        return None, 0.0
    outside = np.median(np.concatenate(strips, axis=0), axis=0)
    noise = 0.0
    if len(strips) == 2:
        upper = np.median(strips[0], axis=0)
        lower = np.median(strips[1], axis=0)
        noise = float(np.median(np.abs(upper - lower).max(axis=1)))
    return outside, noise


def _row_mask(rgb, background, background_ok, background_noise, y0, y1):
    """Band pixels that do not belong to the surrounding background.

    Also returns the per-column background colour used for the comparison.
    """
    band = rgb[y0:y1]
    if background_ok:
        difference = np.abs(band - background[y0:y1]).max(axis=2)
        threshold = max(3.0, 2.0 * background_noise + 0.5)
        outside = np.median(background[y0:y1], axis=0)
        return band, difference >= threshold, outside
    outside, noise = _outside_colors(rgb, y0, y1)
    if outside is None:
        return None, None, None
    difference = np.abs(band - outside[None, :, :]).max(axis=2)
    threshold = max(2.5, 1.6 * noise + 0.8)
    return band, difference >= threshold, outside


def _row_profiles(rgb):
    """Horizontal edge strength and interior smoothness per canvas row."""
    height, width = rgb.shape[:2]
    limit = int(round(height * SEARCH_FRACTION))
    left = int(round(width * 0.04))
    right = int(round(width * 0.96))
    rows = rgb[:min(height, limit + 3), left:right]
    if rows.shape[0] < 12 or rows.shape[1] < 32:
        return None
    change = np.abs(rows[3:] - rows[:-3]).max(axis=2)
    return {'edge': _smooth_1d(change.mean(axis=1), 1),
            'interior': np.median(change, axis=1),
            'limit': change.shape[0]}


def _band_candidates(profiles, height):
    """Candidate row bands from pairs of long horizontal edges."""
    edge = profiles['edge']
    interior = profiles['interior']
    limit = min(profiles['limit'], int(round(height * 0.35)))
    if edge.size < 6 or limit < 6:
        return [], [], 0.0
    base = float(np.median(edge[:limit])) + 1e-3
    threshold = float(min(max(2.0, 3.0 * base), 14.0))
    peaks = _local_maxima(edge[:limit], threshold, 3)
    if len(peaks) < 2:
        return [], peaks, threshold
    low, high = ROW_HEIGHT_RANGE
    scored = []
    for first in range(len(peaks) - 1):
        for second in range(first + 1, len(peaks)):
            y0 = peaks[first]
            y1 = peaks[second]
            span = y1 - y0
            if span < low * height or span > high * height:
                continue
            strength = min(float(edge[y0]), float(edge[y1]))
            if strength < threshold:
                continue
            inside = interior[y0 + 1:max(y0 + 2, y1 - 1)]
            flat = float(np.median(inside)) if inside.size else float('inf')
            if flat > max(2.0, 0.45 * strength):
                continue
            scored.append((strength / (1.0 + 2.0 * flat / max(strength, 1e-3)), y0, y1))
    scored.sort(reverse=True)
    bands = [(int(y0), int(y1)) for _, y0, y1 in scored[:CANDIDATE_BANDS]]
    return bands, peaks, threshold


def _hint_box(hint, width, height):
    """Normalized hint to canvas pixels; the locator never clips to it."""
    if hint is None:
        return None
    try:
        values = [float(value) for value in hint[:4]]
    except (TypeError, ValueError):
        return None
    if len(values) < 4 or not all(np.isfinite(values)):
        return None
    x, y, w, h = values
    if w <= 0 or h <= 0:
        return None
    return (x * width, y * height, w * width, h * height)


def _box_iou(first, second):
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[0] + first[2], second[0] + second[2])
    bottom = min(first[1] + first[3], second[1] + second[3])
    if right <= left or bottom <= top:
        return 0.0
    overlap = (right - left) * (bottom - top)
    union = first[2] * first[3] + second[2] * second[3] - overlap
    return float(overlap / union) if union > 0 else 0.0


def _choose_boundaries(score, margin, min_separation, needed):
    """Pick the strongest separated boundary peaks; never invent positions."""
    span = score.size
    if needed <= 0:
        return [], 1.0
    low = int(margin)
    high = span - int(margin)
    if high - low < 4:
        return [], 0.0
    region = score[low:high]
    peak = float(region.max())
    if peak <= 1e-6:
        return [], 0.0
    indices = _local_maxima(region, max(0.12 * peak, 1e-6), max(3, min_separation // 2))
    if not indices:
        indices = [int(np.argmax(region))]
    ranked = sorted((low + index for index in indices), key=lambda index: float(score[index]), reverse=True)
    chosen = []
    for index in ranked:
        if all(abs(index - other) >= min_separation for other in chosen):
            chosen.append(int(index))
        if len(chosen) == needed:
            break
    chosen.sort()
    quality = 0.0
    if len(chosen) == needed:
        quality = float(np.mean([float(score[index]) / peak for index in chosen]))
    return chosen, min(1.0, max(0.0, quality))


def _text_boundaries(text, span, margin, count):
    """Declared downgrade: separator positions between observed label runs.

    Only used when measured edge evidence cannot supply a trustworthy cut; the
    positions are the midpoints between visible label runs, never equal splits.
    """
    if count < 2 or len(text) != count:
        return None
    boundaries = [int((text[index][1] + text[index + 1][0]) / 2) for index in range(count - 1)]
    if any(boundaries[index] >= boundaries[index + 1] for index in range(len(boundaries) - 1)):
        return None
    if boundaries[0] <= margin or boundaries[-1] >= span - margin:
        return None
    return boundaries


def _segment_widths(boundaries, span):
    edges = [0] + list(boundaries) + [span]
    return [edges[index + 1] - edges[index] for index in range(len(edges) - 1)]


def _active_evidence(fills, active):
    """How clearly one segment's fill stands apart, as the highlight should."""
    if len(fills) < 2 or not 0 <= active < len(fills):
        return 0.5
    separate = []
    for index in range(len(fills)):
        others = [abs(float(np.max(np.abs(fills[index] - fills[other]))))
                  for other in range(len(fills)) if other != index]
        separate.append(min(others) if others else 0.0)
    if max(separate) < 18.0:
        return 0.5
    return float(min(1.0, max(0.0, (separate[active] / max(separate) - 0.5) / 0.5)))


def _segment_polygon(rgb, band_mask, local_mask, top_abs, left, right, fill, layout):
    """Actual body boundary for one segment, else a declared approximation.

    Returns (polygon, kind) where kind is 'body' for a traced colour region and
    'analytic' for the declared shape approximation of the same box.
    """
    region = rgb[top_abs:top_abs + band_mask.shape[0], left:right]
    tolerance = max(16.0, 1.5 * float(np.percentile(np.abs(region - fill[None, None, :]).max(axis=2), 30)))
    own = (np.abs(region - fill[None, None, :]).max(axis=2) <= tolerance) & local_mask
    if own.size and own.mean() >= 0.18:
        # A vertical colour ramp can match the median in only a narrow strip.
        # Fit that segment from its silhouette so sampling sees the full ramp.
        columns = slice(round(own.shape[1]*.25), round(own.shape[1]*.75))
        own_height = np.median(own[:, columns].sum(axis=0))
        mask_height = np.median(local_mask[:, columns].sum(axis=0))
        observed = local_mask if own_height < .82 * mask_height else own
        polygon = _trace_polygon(observed, left, top_abs)
        if polygon is not None and len(polygon) >= 4:
            return polygon, 'body'
    local_rows = np.where(local_mask.any(axis=1))[0]
    if local_rows.size < 2:
        return None, 'analytic'
    top = top_abs + int(local_rows[0])
    bottom = top_abs + int(local_rows[-1]) + 1
    return _analytic_polygon(left, right, top, bottom, layout), 'analytic'


def _ridge_map(rgb):
    """Vertical gradient magnitude, smoothed along x: the row's outer ridge."""
    height = rgb.shape[0]
    values = np.zeros(rgb.shape[:2], dtype=np.float32)
    if height >= 3:
        change = np.abs(rgb[2:] - rgb[:-2]).max(axis=2)
        values[1:height - 1] = change
        values[0] = values[1]
        values[height - 1] = values[height - 2]
    return _box_blur_x(values[:, :, None], 2)[:, :, 0]


def _ridge_lines(ridge, top_guess, bottom_guess, radius=4):
    """Maximum ridge strength per column in a small window around each edge."""
    height = ridge.shape[0]

    def collect(guess):
        start = max(0, int(guess) - radius)
        stop = min(height, int(guess) + radius + 1)
        if stop - start < 1:
            return None
        return ridge[start:stop].max(axis=0)

    return collect(top_guess), collect(bottom_guess)


def _ridge_flags(line):
    """Outer-ridge presence per column with a background-noise aware threshold."""
    if line is None or line.size < 8:
        return None, 0.0
    border = np.concatenate((line[:8], line[-8:]))
    baseline = float(np.median(border))
    peak = float(np.percentile(line, 95))
    if peak <= 1e-6:
        return None, 0.0
    threshold = max(2.0, 0.025 * peak, 1.5 * baseline + 2.0)
    return line >= threshold, peak


def _ridge_extent(top_line, bottom_line, height):
    """Row extent from the outer ridge, not from interior texture.

    Slanted chevron ends carry only one of the two edges at a time, so the
    extent is the union of both edge runs; a both-edges support gate over the
    middle rejects decoration strips that only line up with one edge.
    """
    top_flags, _ = _ridge_flags(top_line)
    bottom_flags, _ = _ridge_flags(bottom_line)
    if top_flags is None or bottom_flags is None:
        return None
    paired = top_flags & bottom_flags
    runs = [(a,b) for a,b in _runs(paired) if b-a+1 >= max(8, height*.65)]
    joined = _merge_runs(runs, max(4, round(height*.85)))
    if not joined:
        return None
    left, right = max(joined, key=lambda run: run[1]-run[0])
    if paired[left:right+1].mean() < .72:
        return None
    union = top_flags | bottom_flags
    limit = round(height*.4)
    while left > 0 and limit and union[left-1]:
        left -= 1
        limit -= 1
    limit = round(height*.4)
    while right+1 < len(union) and limit and union[right+1]:
        right += 1
        limit -= 1
    return left, right


def _ridge_row(ridge, guess, x0, x1, radius=4):
    """Most supported edge row near a guess, taken over the observed extent."""
    height = ridge.shape[0]
    start = max(0, int(guess) - radius)
    stop = min(height, int(guess) + radius + 1)
    if stop - start < 2 or x1 <= x0:
        return int(guess)
    window = ridge[start:stop, x0:x1 + 1]
    return int(np.median(np.argmax(window, axis=0))) + start


def _arrow_tip(band, outside, right, start):
    """Follow the last surface into its tip, starting inside its flat body."""
    height, width = band.shape[:2]
    near = max(start, right-height)
    far = min(width, right+round(height*.65)+1)
    if right-near < 12 or height < 12:
        return right, None
    anchor = band[:, near:near+max(5,(right-near)//3)]
    fill = np.median(anchor, axis=1)
    area = band[:, near:far]
    inside = np.linalg.norm(area-fill[:, None], axis=2)
    outside_distance = np.linalg.norm(area-outside[None, near:far], axis=2)
    flags = (inside+1 < outside_distance) & (outside_distance >= 5)
    edges = np.array([next((b+near for a,b in _runs(row) if a <= 2 and b >= 4), np.nan) for row in flags])
    center = edges[round(height*.41):round(height*.59)]
    sides = (edges[round(height*.12):round(height*.28)], edges[round(height*.72):round(height*.88)])
    if any(np.isfinite(part).sum() < max(2,len(part)*.70) for part in (center,*sides)):
        return right, None
    tip = float(np.nanmedian(center))
    depths = [(tip-float(np.nanmedian(edge)))/.60 for edge in sides]
    if min(depths) < 2 or max(depths) > height*.85 or abs(depths[0]-depths[1]) > max(3,.4*max(depths)):
        return right, None
    return max(right, round(tip)), float(np.mean(depths))


def _shared_frame(rgb, top_guess, bottom_guess, x0, x1, fill_med, outside, boundaries, row_height):
    """Detect one stroke enclosing every segment (a shared bubble frame).

    Compare the outer ridge itself with the surrounding background and with the
    segment fills. A shared frame keeps one stroke colour along the whole top
    and bottom ridge; independent segment bodies show their own state fill on
    the ridge, which varies per segment and matches the interior.
    """
    inset = round((x1 - x0) * .05)
    left, right = x0 + inset, x1 + 1 - inset
    fill = np.median(fill_med, axis=0)
    background = np.median(outside[left:right], axis=0)
    radius = max(3, round(row_height*.16))

    def strokes(edge):
        strip = rgb[max(0, edge-5):edge+6, left:right]
        colours = np.median(strip, axis=1)
        support = np.abs(strip-colours[:, None]).max(axis=2) <= 24
        continuous = support.mean(axis=1) >= .55
        for boundary in boundaries:
            center = x0 + boundary - left
            seam = support[:, max(0, center-radius):min(right-left, center+radius+1)]
            continuous &= seam.mean(axis=1) >= .65
        distinct = np.minimum(np.abs(colours-fill).max(axis=1), np.abs(colours-background).max(axis=1))
        return colours[continuous & (distinct >= 22)]

    top, bottom = strokes(top_guess), strokes(bottom_guess)
    return bool(len(top) and len(bottom) and np.min(np.abs(top[:, None]-bottom).max(axis=2)) <= 26)


def _seam_profiles(band):
    """Persistent vertical or slanted edges in both halves of the row."""
    height, width = band.shape[:2]
    start, stop = max(1, round(height*.10)), min(height//2, round(height*.44))
    slopes = np.r_[0, np.arange(-1.4, -.27, .14), np.arange(.28, 1.41, .14)]
    contrast = np.abs(band[:, 2:] - band[:, :-2]).max(axis=2)
    contrast = np.pad(contrast, ((0, 0), (1, 1)))
    contrast = _box_blur_x(contrast[:, :, None], 1)[:, :, 0]
    distance = np.arange(start, stop)
    columns = np.arange(width)
    profiles = []
    for slope in slopes:
        shifts = np.rint((height/2-distance)*slope).astype(int)
        indexes = np.clip(columns + shifts[:, None], 0, width-1)
        lower = round((len(distance)-1)*.4)
        top = np.partition(contrast[distance[:, None], indexes], lower, axis=0)[lower]
        bottom = np.partition(contrast[(height-1-distance)[:, None], indexes], lower, axis=0)[lower]
        profiles.append(np.minimum(top, bottom))
    return profiles[0], np.max(profiles[1:], axis=0)


def _normalized_box(box, width, height):
    x, y, w, h = box
    return [round(float(min(1.0, max(0.0, x / width))), 5),
            round(float(min(1.0, max(0.0, y / height))), 5),
            round(float(min(1.0, max(0.0, w / width))), 5),
            round(float(min(1.0, max(0.0, h / height))), 5)]


def _normalized_polygon(points, width, height):
    return [[round(float(min(1.0, max(0.0, x / width))), 5),
             round(float(min(1.0, max(0.0, y / height))), 5)]
            for x, y in points]


def _evaluate_band(rgb, detail, y0, y1, context):
    """Score one candidate band; returns (result, metrics) or None."""
    height = context['height']
    width = context['width']
    count = context['count']
    layout = context['layout']
    active = context['active']
    background = context['background']
    background_ok = context['background_ok']
    background_noise = context['background_noise']
    ink_threshold = context['ink_threshold']
    hint_pixels = context['hint_pixels']
    polygons = bool(context.get('polygons', True))
    ridge = context['ridge']

    if y1 - y0 < 6 or y0 < 1 or y1 > height:
        return None
    top_line, bottom_line = _ridge_lines(ridge, y0, y1)
    run = _ridge_extent(top_line, bottom_line, y1-y0)
    if run is None:
        return None
    x0, x1 = run
    span = x1 - x0 + 1
    if span < MIN_SPAN_FRACTION * width:
        return None
    top_abs = max(1, _ridge_row(ridge, y0, x0, x1) - 1)
    bot_abs = min(height, _ridge_row(ridge, y1, x0, x1) + 2)
    if bot_abs - top_abs < max(6, int(round(ROW_HEIGHT_RANGE[0] * height))):
        top_abs = max(1, y0)
        bot_abs = min(height, y1 + 2)
    if bot_abs - top_abs < 6:
        return None
    band, mask, outside = _row_mask(rgb, background, background_ok, background_noise,
                                    top_abs, bot_abs)
    if band is None or mask is None:
        return None
    band_height = bot_abs - top_abs
    if span < MIN_ASPECT * band_height:
        return None
    band_mask = mask[:, x0:x1 + 1]
    has = band_mask.any(axis=0)
    if float(has.mean()) < 0.45:
        return None
    upper = np.argmax(band_mask, axis=0)
    lower = band_height - 1 - np.argmax(band_mask[::-1], axis=0)
    upper = np.where(has, upper, band_height)
    lower = np.where(has, lower, -1)
    top_plateau = max(0, int(np.percentile(upper[has], 15)))
    bot_plateau = min(band_height - 1, int(np.percentile(lower[has], 85)))
    row_height = bot_plateau - top_plateau + 1
    if row_height < 6:
        return None
    top = upper
    bot = lower

    # Text evidence comes from the row interior only, so the
    # enclosing edge cannot be mistaken for ink.
    pad = max(1, int(round(row_height * 0.13)))
    ink_top = top_abs + top_plateau + pad
    ink_bottom = top_abs + bot_plateau - pad + 1
    if ink_bottom - ink_top < 4:
        return None
    ink = detail[ink_top:ink_bottom, x0:x1 + 1] >= ink_threshold
    tall = ink.mean(axis=0)
    region = rgb[ink_top:ink_bottom, x0:x1 + 1]
    fill_med = np.median(region, axis=0)

    vertical, slanted = _seam_profiles(band[top_plateau:bot_plateau+1, x0:x1+1])
    raw_score = np.maximum(vertical, slanted) if layout == 'chevron' else vertical
    score = np.sqrt(np.where(raw_score >= max(2.2, float(np.median(raw_score))*3.5), raw_score, 0))
    if layout == 'chevron':
        top_flags, _ = _ridge_flags(top_line)
        bottom_flags, _ = _ridge_flags(bottom_line)
        for a, b in _runs(~(top_flags & bottom_flags)[x0:x1+1]):
            if a == 0 or b == span-1 or b-a+1 > row_height*.85:
                continue
            lo, hi = max(0, a-round(row_height*.15)), min(span, b+round(row_height*.6)+1)
            peak = lo+int(np.argmax(raw_score[lo:hi]))
            if raw_score[peak] >= 2.2:
                score[peak] = np.sqrt(raw_score[peak]) + max(2.5, float(score.max())*.28)
    margin = max(6, round(.42 * span/count))
    minimum = max(row_height, margin)
    boundaries, boundary_quality = _choose_boundaries(score, margin, minimum, count - 1)

    text_runs = _merge_runs(_runs(ink.mean(axis=0) >= 0.08), max(6, int(round(0.010 * width))))
    text = [(start, end) for start, end in text_runs
            if end - start + 1 >= max(4, int(round(0.004 * span)))
            and float(tall[start:end + 1].mean()) < 0.78]
    tier = 'measured'
    if len(boundaries) < count - 1:
        tier = 'text'
        boundaries = _text_boundaries(text, span, margin, count)
        boundary_quality = 0.0
        if boundaries is None:
            return None
    if tier == 'measured' and count > 1:
        mean_width = span / float(count)
        if min(_segment_widths(boundaries, span)) < max(6, int(round(0.40 * mean_width))):
            # An implausibly narrow relative segment means the cuts are wrong.
            # Refuse them and use the declared text downgrade instead.
            tier = 'text'
            boundaries = _text_boundaries(text, span, margin, count)
            boundary_quality = 0.0
            if boundaries is None:
                return None

    stops = [0] + boundaries + [span]
    head_depth = None
    if layout == 'chevron' and polygons:
        right, head_depth = _arrow_tip(band[top_plateau:bot_plateau+1], outside, x1, x0+stops[-2])
        if right > x1:
            # Keep the observed interior cuts; only the last segment grows.
            x1, span = right, right-x0+1
            stops[-1] = span
            band_mask = mask[:, x0:x1+1]
            has = band_mask.any(axis=0)
            top = np.where(has, np.argmax(band_mask, axis=0), band_height)
            bot = np.where(has, band_height-1-np.argmax(band_mask[::-1], axis=0), -1)
    segments = []
    fills = []
    surface_support = []
    polygon_kinds = set()
    for index in range(count):
        start = stops[index]
        end = stops[index + 1]
        if end - start < 4:
            return None
        left = x0 + start
        right = x0 + end
        segment_top = top_abs + int(np.percentile(top[start:end], 20))
        segment_bottom = top_abs + int(np.percentile(bot[start:end], 80)) + 1
        if segment_bottom - segment_top < 4:
            return None
        fill = np.median(fill_med[start:end], axis=0)
        fills.append(fill)
        inset = round((end-start)*.18)
        core = band_mask[top_plateau+pad:bot_plateau-pad+1, start+inset:end-inset]
        surface_support.append(float(core.mean()) if core.size else 0.0)
        polygon = None
        if polygons:
            polygon, polygon_kind = _segment_polygon(rgb, band_mask, band_mask[:, start:end],
                                                     top_abs, left, right, fill, layout)
            if polygon is None:
                return None
            polygon_kinds.add(polygon_kind)
        segments.append({
            'box': _normalized_box([left, segment_top, right - left, segment_bottom - segment_top],
                                   width, height),
            'polygon': _normalized_polygon(polygon, width, height) if polygon else []})

    shared = layout == 'bubble' and _shared_frame(rgb, y0, y1, x0, x1, fill_med, outside, boundaries, row_height)
    shared_polygon = None
    if shared and polygons:
        shared_polygon = _trace_polygon(band_mask, x0, top_abs)
        if shared_polygon is not None:
            shared_polygon = _normalized_polygon(shared_polygon, width, height)

    text_score = 1.0 if len(text) == count else 0.0
    span_score = min(1.0, max(0.0, (span / float(width) - MIN_SPAN_FRACTION) /
                               max(1e-6, 0.60 - MIN_SPAN_FRACTION)))
    row_score = min(1.0, (span / float(band_height)) / 24.0)
    active_score = _active_evidence(fills, active)
    # Glyph strokes can supply strong slanted seams. A navigation row also
    # needs filled segment interiors across the row, including inactive states.
    surface = float(np.median(surface_support))
    if surface < .30:
        return None
    shape_agreement = 0.0
    if tier == 'measured' and boundaries:
        straight, angled = [], []
        for seam in boundaries:
            neighborhood = slice(max(0, seam-3), min(len(vertical), seam+4))
            straight.append(float(vertical[neighborhood].max()))
            angled.append(float(slanted[neighborhood].max()))
        evidence = [(a-v)/max(a, v, 1) for a, v in zip(angled, straight)]
        shape_agreement = float(np.median(evidence)) * (1 if layout == 'chevron' else -1)
    hint_fit = 0.0
    if hint_pixels is not None:
        hint_fit = _box_iou([x0, top_abs, span, band_height], hint_pixels)

    if tier == 'measured':
        confidence = (0.46 + 0.34 * boundary_quality + 0.10 * span_score
                      + 0.12 * active_score + 0.08 * text_score
                      + 0.05 * row_score + 0.03 * min(1.0, hint_fit / 0.6))
        strong = surface >= .55 and boundary_quality >= .40 and top_abs < height*.14 and (text_score >= 1.0 or active_score > .45 or shared)
        confidence = min(confidence, 0.97 if strong else HIGH_CONFIDENCE - 0.01)
    else:
        confidence = 0.42 + 0.10 * span_score + 0.12 * active_score \
            + 0.06 * text_score + 0.04 * row_score
        confidence = min(confidence, 0.72)

    if shared:
        shape_source = 'shared-frame'
    elif polygon_kinds == {'body'}:
        shape_source = 'body-trace'
    elif polygon_kinds == {'analytic'}:
        shape_source = 'analytic'
    else:
        shape_source = 'body-trace-partial'
    method = 'edge-band+{}+{}+{}'.format(tier, shape_source, layout)
    result = {
        'box': _normalized_box([x0, top_abs, span, band_height], width, height),
        'segments': segments,
        'confidence': round(float(min(1.0, max(0.0, confidence))), 3),
        'segmentEvidence': tier,
        'sharedFrame': bool(shared),
        'method': method}
    if head_depth is not None:
        result['headDepth'] = round(head_depth/width, 5)
    if shared_polygon is not None:
        result['sharedPolygon'] = shared_polygon
    metrics = {'band': [int(y0), int(y1)], 'box': [x0, top_abs, span, band_height],
               'span': int(span), 'tier': tier, 'boundaries': [int(v) for v in boundaries],
               'boundaryQuality': round(float(boundary_quality), 3), 'shapeAgreement': round(shape_agreement, 3),
               'textRuns': len(text), 'surfaceSupport': round(surface, 3), 'hintFit': round(float(hint_fit), 3),
               'confidence': result['confidence'], 'sharedFrame': bool(shared),
               'polygonKinds': sorted(polygon_kinds)}
    return result, metrics


def _locate(image, layout, labels, active, background, hint, debug):
    rgb, _ = _canvas(image)
    if rgb is None:
        return None
    height, width = rgb.shape[:2]
    names = [str(value) for value in (labels or [])]
    count = len(names)
    if not 1 <= count <= MAX_SEGMENTS:
        return None
    layout_name = 'bubble' if str(layout or '').lower().startswith('bubble') else 'chevron'
    try:
        active_index = int(active)
    except (TypeError, ValueError):
        active_index = -1
    if not 0 <= active_index < count:
        active_index = -1

    fitted = _fit_rgb(background, height, width) if background is not None else None
    background_ok, background_noise = _background_supported(rgb, fitted)
    if not background_ok:
        fitted = None

    profiles = _row_profiles(rgb)
    if profiles is None:
        return None
    bands, peaks, _ = _band_candidates(profiles, height)
    hint_pixels = _hint_box(hint, width, height)
    if hint_pixels is not None:
        hint_top = int(round(hint_pixels[1]))
        hint_bottom = int(round(hint_pixels[1] + hint_pixels[3]))
        if peaks:
            nearest_top = min(peaks, key=lambda value: abs(value - hint_top))
            nearest_bottom = min(peaks, key=lambda value: abs(value - hint_bottom))
            if 0 < nearest_bottom - nearest_top <= ROW_HEIGHT_RANGE[1] * height * 1.6:
                bands.append((int(nearest_top), int(nearest_bottom)))
        bands.append((max(1, hint_top), max(hint_top + 2, hint_bottom)))
    bands = sorted(set((int(a), int(b)) for a, b in bands if b > a))
    if not bands:
        return {'selected': None, 'candidates': []} if debug else None
    header = rgb[:max(y1 for _,y1 in bands)+8]
    detail = _detail_map(header, max(4, round(width*.008)))
    ridge = _ridge_map(header)
    ink_threshold = max(INK_FLOOR, 3.0 * float(np.percentile(detail, 40)))

    context = {'height': height, 'width': width, 'labels': names, 'count': count,
               'layout': layout_name, 'active': active_index,
               'background': fitted, 'background_ok': background_ok,
               'background_noise': background_noise, 'ink_threshold': ink_threshold,
               'hint_pixels': hint_pixels, 'polygons': False, 'ridge': ridge}
    evaluated = []
    for band in bands:
        outcome = _evaluate_band(rgb, detail, band[0], band[1], context)
        if outcome is None:
            continue
        result, metrics = outcome
        evaluated.append((result['confidence'],
                          float(metrics.get('hintFit') or 0.0),
                          float(metrics.get('span') or 0.0), result, metrics))
    if not evaluated:
        if debug:
            return {'selected': None, 'candidates': []}
        return None
    def rank(item):
        confidence, hint_fit, span, _, metrics = item
        score = confidence + .17*metrics['shapeAgreement'] + .12*metrics['surfaceSupport']
        return (hint_fit >= .55, score, hint_fit, -metrics['band'][0], span)

    evaluated.sort(key=rank, reverse=True)
    confidence, _, _, result, metrics = evaluated[0]
    if confidence >= CONFIDENCE_FLOOR:
        # Only the winning band pays for body polygons and the shared outline.
        band = metrics.get('band')
        if band:
            refined = _evaluate_band(rgb, detail, int(band[0]), int(band[1]),
                                     dict(context, polygons=True))
            if refined is not None:
                result, metrics = refined
            elif not debug:
                return None
    if debug:
        return {'selected': result if confidence >= CONFIDENCE_FLOOR else None,
                'candidates': [item[4] for item in evaluated]}
    if confidence < CONFIDENCE_FLOOR:
        return None
    return result


def locate_progress(image, layout, labels, active, background=None, hint=None):
    """Locate the progress row: shared box, segments and body polygons.

    ``image`` is an RGB PIL image (a numpy array is also accepted).
    ``layout`` is 'chevron' or 'bubble'.  ``labels`` lists every section title in
    order; ``active`` is the zero-based current section.  ``background`` is an
    optional RGB PIL background already scaled to the image size; it is used only
    after it proves to match this page.  ``hint`` is an optional normalized
    [x, y, w, h] model box that may add a candidate but never clips detection.

    Returns {'box', 'segments', 'confidence', 'sharedFrame', 'method'} (plus
    'sharedPolygon' when one frame encloses every segment), or None when no
    segment count can be trusted.  Geometry is normalized by image width/height.
    """
    try:
        return _locate(image, layout, labels, active, background, hint, debug=False)
    except (ValueError, TypeError, IndexError, KeyError, ZeroDivisionError):
        return None


def debug_locate(image, layout, labels, active, background=None, hint=None):
    """Same inputs as locate_progress, plus the scored candidate bands.

    Returns {'selected': result|None, 'candidates': [metrics, ...]}.  Unlike
    locate_progress this re-raises unexpected errors, which makes it suitable
    for tuning thresholds on new previews.
    """
    return _locate(image, layout, labels, active, background, hint, debug=True)


def _load_rgb(path):
    with Image.open(path) as source:
        return source.convert('RGB')


def main(argv=None):
    arguments = list(sys.argv[1:] if argv is None else argv)
    debug = '--debug' in arguments
    arguments = [value for value in arguments if value != '--debug']
    if len(arguments) < 4:
        print('usage: python tools/progress_geometry.py IMAGE LAYOUT LABELS ACTIVE '
              '[--background PATH] [--hint x,y,w,h] [--debug]')
        return 2
    image_path, layout, labels_argument, active_argument = arguments[:4]
    background_path = None
    hint = None
    extra = arguments[4:]
    index = 0
    while index < len(extra):
        if extra[index] == '--background' and index + 1 < len(extra):
            background_path = extra[index + 1]
            index += 2
            continue
        if extra[index] == '--hint' and index + 1 < len(extra):
            try:
                hint = [float(value) for value in extra[index + 1].split(',')]
            except ValueError:
                hint = None
            index += 2
            continue
        index += 1
    if labels_argument.startswith('@'):
        with open(labels_argument[1:], encoding='utf-8') as handle:
            labels = [line.strip() for line in handle if line.strip()]
    else:
        labels = [part.strip() for part in labels_argument.split(',') if part.strip()]
    try:
        active = int(active_argument)
    except ValueError:
        print('ACTIVE must be a zero-based integer index')
        return 2
    image = _load_rgb(image_path)
    background = _load_rgb(background_path) if background_path else None
    if debug:
        output = debug_locate(image, layout, labels, active, background, hint)
    else:
        output = locate_progress(image, layout, labels, active, background, hint)
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
