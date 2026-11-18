"""Uniform single-size text measurement for the 05 rebuild pipeline.

``reference_position.py`` already registers a translation for every text object.
This module adds one conservative, bounded measurement on top of the two inputs
that registration already has: the predicted text mask (RGBA, rendered from the
audit element at its declared size, at its original position) and the approved
1600x900 reference preview (BGR).  A single font size means the whole leading
line is one scaled copy of the mask glyphs; the scale at which the real ink
agrees with the mask is the size ratio.  So the measurement is the scale and
offset of the leading line, verified against glyph extent, ink amount and line
count, and it is reported in the same 1600x900 logical units as the rest of the
pipeline.

Scope: plain text with one size and one style.  Multi-style runs, script/math
runs, gradient or shadowed text, occluded text, changed line breaks, ambiguous
matches and geometry that disagrees with the supplied final position all return
``None`` so the caller keeps the declared size.  Every returned measurement has
confidence >= 0.75; below that evidence is ambiguous and ``None`` is returned.
Work is limited to a small crop around the final position; the whole preview is
never scanned.
"""
import math

import cv2
import numpy as np

METHOD = 'uniform-leading-glyph-scale-agreement'
_SCALE_MIN = 0.5
_SCALE_MAX = 2.0
_SIZE_MIN = 4.0
_SIZE_MAX = 400.0
_RUN_FIELDS = ('textColorRuns', 'boldRuns', 'sizeRuns', 'textRuns')
_SCRIPT_RANGES = ((0x00B2, 0x00B3), (0x00B9, 0x00B9), (0x2070, 0x209F),
                  (0x1D2C, 0x1D6A))


def _finite(value, default=None):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _has_script_runs(text):
    for character in text:
        code = ord(character)
        if any(low <= code <= high for low, high in _SCRIPT_RANGES):
            return True
    return False


def _declared(element):
    """Size/origin of a plain single-size text element, or None when out of scope."""
    if not isinstance(element, dict):
        return None
    if element.get('type') != 'text' or element.get('managed'):
        return None
    text = element.get('text')
    if not isinstance(text, str) or not text.strip():
        return None
    # Inline maths and script runs change the size inside one element.
    if element.get('latex') or '$' in text or '\\(' in text or _has_script_runs(text):
        return None
    # Mixed emphasis/colour runs mean the leading line is not one uniform style.
    if any(element.get(field) for field in _RUN_FIELDS):
        return None
    # A gradient or shadow is not solid glyph ink; its mask alpha is not the glyph.
    if element.get('gradient') or element.get('textGradient') or element.get('shadow'):
        return None
    size = _finite(element.get('size'))
    x = _finite(element.get('x'))
    y = _finite(element.get('y'))
    if size is None or x is None or y is None:
        return None
    if not _SIZE_MIN <= size <= _SIZE_MAX:
        return None
    return {'size': size, 'x': x, 'y': y}


def _colour(value):
    if not isinstance(value, str):
        return None
    text = value.strip().lstrip('#')
    if len(text) != 6:
        return None
    try:
        channels = [int(text[index:index + 2], 16) for index in (0, 2, 4)]
    except ValueError:
        return None
    return np.array([channels[2], channels[1], channels[0]], np.float32)


def _mask_alpha(mask_file, reference):
    if not mask_file:
        return None
    try:
        image = cv2.imread(str(mask_file), cv2.IMREAD_UNCHANGED)
    except Exception:
        return None
    if image is None or getattr(image, 'ndim', 2) != 3 or image.shape[2] != 4:
        return None
    height, width = reference.shape[:2]
    alpha = image[:, :, 3]
    if alpha.shape != (height, width):
        alpha = cv2.resize(alpha, (width, height), interpolation=cv2.INTER_AREA)
    return alpha.astype(np.float32) / 255.0


def _bands(flags):
    bands = []
    start = None
    for index, flag in enumerate(flags):
        if flag and start is None:
            start = index
        elif not flag and start is not None:
            bands.append([start, index])
            start = None
    if start is not None:
        bands.append([start, len(flags)])
    return bands


def _merge_bands(bands, gap):
    merged = []
    for band in bands:
        if merged and band[0] - merged[-1][1] < gap:
            merged[-1][1] = max(merged[-1][1], band[1])
        else:
            merged.append([band[0], band[1]])
    return merged


def _mask_evidence(alpha, declared_px):
    """Leading-line glyph template plus the mask's own geometry.

    The mask is rendered at the declared size, so its glyph extent is the unit
    scale that the real ink is compared against.  Only the leading line is kept
    as a template; other lines are counted for the line-break check.
    """
    maximum = float(alpha.max()) if alpha.size else 0.0
    if maximum < 0.2:
        return None
    glyph = alpha >= 0.5 * maximum
    if int(glyph.sum()) < 24:
        return None
    row_flags = glyph.sum(axis=1) >= 2
    bands = _merge_bands(_bands(row_flags), max(2, int(round(declared_px * 0.15))))
    minimum_band = max(2, int(round(declared_px * 0.2)))
    bands = [band for band in bands
             if band[1] - band[0] >= minimum_band
             and int(glyph[band[0]:band[1]].sum()) >= 12]
    if not bands:
        return None
    rows = np.flatnonzero(glyph.any(axis=1))
    columns = np.flatnonzero(glyph.any(axis=0))
    if not len(rows) or not len(columns):
        return None
    top, bottom = int(rows[0]), int(rows[-1]) + 1
    left, right = int(columns[0]), int(columns[-1]) + 1
    band_ink = [int(glyph[band[0]:band[1]].sum()) for band in bands]
    strongest = max(band_ink)
    leading = bands[0]
    for band, ink in zip(bands, band_ink):
        if ink >= max(12, int(strongest * 0.35)):
            leading = band
            break
    leading_glyph = glyph[leading[0]:leading[1]]
    leading_columns = np.flatnonzero(leading_glyph.any(axis=0))
    if not len(leading_columns):
        return None
    lead_left = int(leading_columns[0])
    lead_right = int(leading_columns[-1]) + 1
    lead_top, lead_bottom = int(leading[0]), int(leading[1])
    lead_width = lead_right - lead_left
    lead_height = lead_bottom - lead_top
    if lead_width < 6 or lead_height < 3:
        return None
    cap = min(lead_width, max(96, int(round(4.5 * declared_px))))
    if cap < 6:
        return None
    template = glyph[lead_top:lead_bottom, lead_left:lead_left + cap].astype(np.float32)
    mean = float(template.mean())
    if mean < 0.02 or mean > 0.9:
        return None
    return {'glyph': glyph, 'template': cv2.GaussianBlur(template, (3, 3), 0.6),
            'lines': len(bands), 'bbox': (left, top, right, bottom),
            'lead': (lead_left, lead_top, lead_bottom), 'leadWidth': lead_width,
            'leadHeight': lead_height, 'truncated': cap < lead_width, 'cap': cap}


def _background(window):
    """Solid local background of the crop, trimmed away from the glyph ink."""
    if window.shape[0] < 6 or window.shape[1] < 6:
        return None
    values = window.reshape(-1, 3).astype(np.float32)
    if len(values) < 32:
        return None
    pad = max(2, min(window.shape[0], window.shape[1]) // 12)
    ring = np.zeros(window.shape[:2], bool)
    ring[:pad, :] = True
    ring[-pad:, :] = True
    ring[:, :pad] = True
    ring[:, -pad:] = True
    ring_values = values[ring.reshape(-1)]
    if len(ring_values) < 16:
        ring_values = values
    base = np.median(ring_values, axis=0)
    for _ in range(3):
        distance = np.linalg.norm(values - base, axis=1)
        keep = distance <= float(np.percentile(distance, 40.0))
        if int(keep.sum()) < 24:
            break
        updated = np.median(values[keep], axis=0)
        moved = float(np.linalg.norm(updated - base))
        base = updated
        if moved < 0.5:
            break
    return base


def _ink_model(window, colour):
    """Background/ink colour model shared by every crop of this measurement."""
    background = _background(window)
    if background is None:
        return None
    if colour is not None:
        direction = colour - background
        length = float(np.dot(direction, direction))
        if length >= 2500.0:
            return {'background': background, 'direction': direction, 'length': length}
    distance = np.linalg.norm(window.astype(np.float32) - background, axis=2)
    length = max(24.0, float(np.percentile(distance, 99.0)))
    return {'background': background, 'direction': None, 'length': length}


def _coverage(crop, model):
    """Ink coverage in [0,1] along the background->declared-colour axis.

    Anti-aliased glyph edges are a blend of the two colours, so their projection
    is their coverage; a light card, a dark page or a lightly tinted background
    all keep the same interpretation without hard-coding light/dark.
    """
    delta = crop.astype(np.float32) - model['background']
    if model['direction'] is not None:
        coverage = (delta @ model['direction']) / model['length']
    else:
        coverage = np.linalg.norm(delta, axis=2) / model['length']
    return np.clip(coverage, 0.0, 1.0).astype(np.float32)


def _match_scale(soft, template, ratio, predicted, tolerance, origin):
    """Best legal template origin for one candidate scale."""
    height = int(round(template.shape[0] * ratio))
    width = int(round(template.shape[1] * ratio))
    if height < 3 or width < 3 or width > soft.shape[1] or height > soft.shape[0]:
        return None
    left = int(math.floor(predicted[0] - tolerance))
    top = int(math.floor(predicted[1] - tolerance))
    right = int(math.ceil(predicted[0] + width + tolerance))
    bottom = int(math.ceil(predicted[1] + height + tolerance))
    local_left = max(0, left - origin[0])
    local_top = max(0, top - origin[1])
    local_right = min(soft.shape[1], right - origin[0])
    local_bottom = min(soft.shape[0], bottom - origin[1])
    if local_right - local_left < width or local_bottom - local_top < height:
        return None
    window = soft[local_top:local_bottom, local_left:local_right]
    if window.shape[1] < width + 2 or window.shape[0] < height + 2:
        return None
    interpolation = cv2.INTER_AREA if ratio < 1.0 else cv2.INTER_LINEAR
    resized = cv2.resize(template, (width, height), interpolation=interpolation)
    resized = np.clip(resized, 0.0, 1.0).astype(np.float32)
    if float(resized.mean()) < 0.01:
        return None
    scores = cv2.matchTemplate(window, resized, cv2.TM_CCOEFF_NORMED)
    scores = np.nan_to_num(scores, nan=0.0, posinf=0.0, neginf=0.0)
    absolute_x = origin[0] + local_left + np.arange(scores.shape[1])
    absolute_y = origin[1] + local_top + np.arange(scores.shape[0])
    valid_columns = np.flatnonzero(np.abs(absolute_x - predicted[0]) <= tolerance + 0.5)
    valid_rows = np.flatnonzero(np.abs(absolute_y - predicted[1]) <= tolerance + 0.5)
    if not len(valid_columns) or not len(valid_rows):
        return None
    legal = scores[np.ix_(valid_rows, valid_columns)]
    if legal.size == 0:
        return None
    flat = int(np.argmax(legal))
    row, column = divmod(flat, legal.shape[1])
    # A maximum pinned to the tolerance edge is a truncated search, not a position.
    if legal.shape[0] > 2 and row in (0, legal.shape[0] - 1):
        return None
    if legal.shape[1] > 2 and column in (0, legal.shape[1] - 1):
        return None
    best = float(legal[row, column])
    competitors = legal.copy()
    competitors[max(0, row - 6):row + 7, max(0, column - 6):column + 7] = 0.0
    competing = float(competitors.max()) if competitors.size else 0.0
    template_ink = int((resized >= 0.5).sum())
    if template_ink < 8:
        return None
    ink_rows = np.flatnonzero((resized >= 0.5).any(axis=1))
    ink_columns = np.flatnonzero((resized >= 0.5).any(axis=0))
    if not len(ink_rows) or not len(ink_columns):
        return None
    return {'ratio': float(ratio), 'score': best, 'margin': best - competing,
            'origin': (int(absolute_x[valid_columns[column]]),
                       int(absolute_y[valid_rows[row]])),
            'width': width, 'height': height, 'template': resized,
            'templateInk': template_ink,
            'inkBox': (int(ink_rows[0]), int(ink_rows[-1]) + 1,
                       int(ink_columns[0]), int(ink_columns[-1]) + 1)}


def _measure(element, mask_file, reference, x, y):
    declared = _declared(element)
    if declared is None:
        return None
    size = declared['size']
    target_x = _finite(x)
    target_y = _finite(y)
    if target_x is None or target_y is None:
        return None
    if not isinstance(reference, np.ndarray) or reference.ndim != 3 or reference.shape[2] < 3:
        return None
    height, width = reference.shape[:2]
    if height < 120 or width < 120:
        return None
    unit = width / 1600.0
    if not math.isfinite(unit) or unit <= 0:
        return None
    alpha = _mask_alpha(mask_file, reference)
    if alpha is None:
        return None
    declared_px = size * unit
    mask = _mask_evidence(alpha, declared_px)
    if mask is None:
        return None
    lead_left, lead_top, _lead_bottom = mask['lead']
    # reference_position translates the mask glyph bbox by the same dx/dy it
    # reports, so the leading line's ink origin is the anchor of the search.
    predicted = (lead_left + (target_x - declared['x']) * unit,
                 lead_top + (target_y - declared['y']) * unit)
    tolerance_band = max(8.0, 0.35 * declared_px)
    tolerance_match = max(7.0, 0.24 * declared_px)
    window_left = int(math.floor(predicted[0] - tolerance_band))
    window_top = int(math.floor(predicted[1] - tolerance_band))
    window_right = int(math.ceil(predicted[0] + mask['cap'] * _SCALE_MAX + tolerance_band))
    window_bottom = int(math.ceil(predicted[1] + mask['leadHeight'] * _SCALE_MAX + tolerance_band))
    crop_left, crop_top = max(0, window_left), max(0, window_top)
    crop_right, crop_bottom = min(width, window_right), min(height, window_bottom)
    if crop_right - crop_left < 12 or crop_bottom - crop_top < 10:
        return None
    window = reference[crop_top:crop_bottom, crop_left:crop_right, :3]
    model = _ink_model(window, _colour(element.get('color')))
    if model is None:
        return None
    coverage = _coverage(window, model)
    observed = (coverage >= 0.5).astype(np.float32)
    if int(observed.sum()) < 12:
        return None
    soft = cv2.GaussianBlur(observed, (3, 3), 0.6)
    origin = (crop_left, crop_top)
    # Pick the live ink band nearest the predicted leading line.
    row_flags = observed.sum(axis=1) >= 2
    bands = _merge_bands(_bands(row_flags), max(2, int(round(declared_px * 0.12))))
    bands = [band for band in bands
             if band[1] - band[0] >= max(2, int(round(declared_px * 0.16)))]
    if not bands:
        return None
    expected_center = (predicted[1] - crop_top) + mask['leadHeight'] / 2.0
    band = min(bands, key=lambda item: abs((item[0] + item[1]) / 2.0 - expected_center))
    if abs((band[0] + band[1]) / 2.0 - expected_center) > tolerance_band + mask['leadHeight'] * 0.5:
        return None
    if band[0] <= 0 or band[1] >= observed.shape[0] - 1:
        return None
    observed_height = float(band[1] - band[0])
    if observed_height < 3:
        return None
    band_columns = np.flatnonzero(observed[band[0]:band[1]].any(axis=0))
    if not len(band_columns) or int(band_columns[-1]) - int(band_columns[0]) + 1 < 6:
        return None
    height_ratio = observed_height / mask['leadHeight']
    if not _SCALE_MIN <= height_ratio <= _SCALE_MAX:
        return None
    # The glyph height gives a cheap first estimate; correlation around it picks
    # the scale (and the exact origin) that the real ink actually supports.
    best = None
    for delta in (-0.16, -0.08, 0.0, 0.08, 0.16):
        ratio = min(_SCALE_MAX, max(_SCALE_MIN, height_ratio + delta))
        found = _match_scale(soft, mask['template'], ratio, predicted,
                             tolerance_match, origin)
        if found is not None and (best is None or found['score'] > best['score']):
            best = found
    if best is None or best['score'] < 0.55:
        return None
    for delta in (-0.05, -0.04, -0.03, -0.02, -0.01, 0.01, 0.02, 0.03, 0.04, 0.05):
        ratio = best['ratio'] + delta
        if not _SCALE_MIN <= ratio <= _SCALE_MAX:
            continue
        found = _match_scale(soft, mask['template'], ratio, predicted,
                             tolerance_match, origin)
        if found is not None and found['score'] > best['score']:
            best = found
    if best['margin'] < 0.008:
        return None
    template_width, template_height = best['width'], best['height']
    absolute_x, absolute_y = best['origin']
    if max(abs(absolute_x - predicted[0]), abs(absolute_y - predicted[1])) > tolerance_match + 0.75:
        return None
    local_x = absolute_x - origin[0]
    local_y = absolute_y - origin[1]
    if local_x < 0 or local_y < 0:
        return None
    region = observed[local_y:local_y + template_height, local_x:local_x + template_width]
    if region.shape != (template_height, template_width):
        return None
    # Correlation can be fooled by solid paint: the real ink must also cover the
    # template's amount and reach its edges (both are broken by occlusion).
    coverage_ratio = float(region.sum()) / max(1, best['templateInk'])
    if not 0.55 <= coverage_ratio <= 1.6:
        return None
    region_rows = np.flatnonzero(region.any(axis=1))
    region_columns = np.flatnonzero(region.any(axis=0))
    if not len(region_rows) or not len(region_columns):
        return None
    # Compare against the template's own ink box, not its rectangle: a mask crop
    # can legitimately end inside a line where later glyphs carry the descender.
    ink_top, ink_bottom, ink_left, ink_right = best['inkBox']
    row_margin = max(2, int(round(0.2 * (ink_bottom - ink_top))))
    column_margin = max(2, int(round(0.12 * (ink_right - ink_left))))
    if abs(region_rows[0] - ink_top) > row_margin:
        return None
    if abs(region_rows[-1] - (ink_bottom - 1)) > row_margin:
        return None
    if abs(region_columns[0] - ink_left) > column_margin:
        return None
    if not mask['truncated'] and abs(region_columns[-1] - (ink_right - 1)) > column_margin:
        return None
    # Changed line breaks change the mask block's row structure; keep the size.
    left, top, right, bottom = mask['bbox']
    full_height = bottom - top
    full_width = right - left
    ratio = best['ratio']
    mapped_left = absolute_x + (left - lead_left) * ratio
    mapped_top = absolute_y + (top - lead_top) * ratio
    pad_x = max(4.0, 0.15 * declared_px * ratio)
    pad_y = max(8.0, 0.6 * declared_px * ratio)
    strip_width = min(full_width * ratio, template_width * 1.35)
    block_left = int(math.floor(mapped_left - pad_x))
    block_top = int(math.floor(mapped_top - pad_y))
    block_right = int(math.ceil(mapped_left + strip_width + pad_x))
    block_bottom = int(math.ceil(mapped_top + full_height * ratio + pad_y))
    vertically_clipped = block_top < 0 or block_bottom > height
    block_left, block_top = max(0, block_left), max(0, block_top)
    block_right, block_bottom = min(width, block_right), min(height, block_bottom)
    if not vertically_clipped and block_right - block_left >= 6 and block_bottom - block_top >= 6:
        block = reference[block_top:block_bottom, block_left:block_right, :3]
        block_ink = (_coverage(block, model) >= 0.5).astype(np.float32)
        block_bands = _merge_bands(_bands(block_ink.sum(axis=1) >= 2),
                                   max(2, int(round(0.12 * declared_px * ratio))))
        block_bands = [item for item in block_bands
                       if item[1] - item[0] >= max(2, int(round(0.18 * declared_px * ratio)))
                       and int(block_ink[item[0]:item[1]].sum()) >= 8]
        if block_bands and len(block_bands) != mask['lines']:
            return None
    measured = size * ratio
    if not _SIZE_MIN <= measured <= 600.0:
        return None
    # Every gate above is an acceptance gate, so a returned size is trustworthy:
    # 0.75 is the floor for a just-accepted match and 0.95 a clean glyph match.
    score_quality = float(np.clip((best['score'] - 0.55) / 0.35, 0.0, 1.0))
    margin_quality = float(np.clip(best['margin'] / 0.05, 0.0, 1.0))
    ink_quality = float(np.clip(1.0 - abs(coverage_ratio - 1.0) / 0.35, 0.0, 1.0))
    height_quality = float(np.clip(1.0 - abs(height_ratio - ratio) / 0.30, 0.0, 1.0))
    quality = (0.4 * score_quality + 0.2 * margin_quality
               + 0.2 * ink_quality + 0.2 * height_quality)
    confidence = min(0.95, 0.75 + 0.20 * quality)
    return {'size': round(measured, 2),
            'confidence': round(float(confidence), 3),
            'method': METHOD,
            'declaredSize': round(size, 2),
            'scale': round(ratio, 4),
            'evidence': {'maskLeadingHeight': round(float(mask['leadHeight']), 2),
                         'referenceLeadingHeight': round(observed_height, 2),
                         'correlation': round(best['score'], 4),
                         'margin': round(best['margin'], 4),
                         'inkRatio': round(coverage_ratio, 3),
                         'lines': mask['lines'],
                         'shift': [round(absolute_x - predicted[0], 2),
                                   round(absolute_y - predicted[1], 2)]}}


def measure_uniform_text_size(element, mask_file, reference, x, y):
    """Measure one uniform text size from its mask and the approved preview.

    Args:
        element: audit text element (``type`` 'text', ``text``, ``size``, ``x``,
            ``y``, ``color``).  ``element['size']`` is the declared size and
            ``element['x']``/``['y']`` are the original (mask) box origin.
        mask_file: RGBA object mask rendered from the element at the original
            position and the declared size.
        reference: 1600x900 BGR approved preview (``numpy.ndarray``).
        x, y: final logical box origin after registration.

    Returns:
        ``None`` when the object is out of scope or the evidence is not
        trustworthy, otherwise ``{'size', 'confidence', 'method', ...}`` with
        the size in 1600x900 logical units and confidence >= 0.75.
    """
    return _measure(element, mask_file, reference, x, y)
