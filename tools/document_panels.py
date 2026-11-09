"""Candidate panel geometry and local crop framing for one figure region.

This is deliberately conservative evidence only. It never decides on its own to split a
figure: the caller must combine separators/cells with caption or panel-label evidence.
`crop` is the real pixel operation: find the minimal content inside the candidate safe cell,
crop original pixels, then add a local same-background protective border. No neighbour pixels
are ever read and the original content is never scaled.
"""
import json
import math
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageOps

MIN_SEPARATOR = 0.012  # of the figure side; smaller gaps are ordinary spacing


def _crop(page_path, box):
    with Image.open(page_path) as image:
        image = ImageOps.exif_transpose(image).convert('RGB')
    pixels = np.array(image)
    height, width = pixels.shape[:2]
    x = max(0.0, min(1000.0, float(box['x'])))
    y = max(0.0, min(1000.0, float(box['y'])))
    right = max(x, min(1000.0, x + float(box['w'])))
    bottom = max(y, min(1000.0, y + float(box['h'])))
    left = round(x * width / 1000)
    top = round(y * height / 1000)
    right = max(left + 1, round(right * width / 1000))
    bottom = max(top + 1, round(bottom * height / 1000))
    return pixels[top:bottom, left:right]


def _white_content_mask(pixels):
    """Blank separators are near-white bands; colored/raster content is marked as content."""
    white = (pixels[:, :, 0] > 235) & (pixels[:, :, 1] > 235) & (pixels[:, :, 2] > 235)
    return (~white).astype(np.uint8)


def _rgb_content_mask(pixels, tolerance=10):
    """RGB colour difference from the page border, not gray: coloured lines with the same
    luminance as the background must still be content. Thin 1px lines survive (no open)."""
    border = np.concatenate([pixels[0, :], pixels[-1, :], pixels[:, 0], pixels[:, -1]])
    background = np.median(border, axis=0)
    difference = np.max(np.abs(pixels.astype(np.int16) - background.astype(np.int16)), axis=2)
    mask = (difference > tolerance).astype(np.uint8)
    return _denoise(mask, minimum=2)


def _denoise(mask, minimum=4):
    """Remove isolated speckles only; one-pixel axes, curves and connector lines must survive."""
    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
    cleaned = mask.copy()
    for index in range(1, count):
        if stats[index][4] < minimum:
            cleaned[labels == index] = 0
    return cleaned


def _separators(profile):
    low = profile < 0.0006
    total = float(profile.sum()) or 1.0
    separators, index = [], 0
    while index < len(low):
        if not low[index]:
            index += 1
            continue
        end = index
        while end < len(low) and low[end]:
            end += 1
        size = (end - index) / len(profile)
        if size >= MIN_SEPARATOR:
            left, right = float(profile[:index].sum()), float(profile[end:].sum())
            if left > total * 0.05 and right > total * 0.05:
                separators.append({'pos': round((index + end) / 2 / len(profile), 4), 'gap': round(size, 4)})
        index = end
    return separators


def _cells(profile, separators):
    cuts = [0.0] + [item['pos'] for item in separators] + [1.0]
    cells = []
    for start, end in zip(cuts, cuts[1:]):
        first, last = round(start * len(profile)), max(round(start * len(profile)) + 1, round(end * len(profile)))
        segment = profile[first:last]
        if not len(segment):
            continue
        cells.append({'start': round(start, 4), 'end': round(end, 4), 'content': round(float(segment.mean()), 4), 'filled': round(float((segment > 0.0006).mean()), 4)})
    return cells


def analyze(page_path, box):
    crop = _crop(page_path, box)
    height, width = crop.shape[:2]
    if width < 24 or height < 24:
        return {'size': [width, height], 'contentRatio': 0.0, 'verticalSeparators': [], 'horizontalSeparators': [], 'verticalCells': [], 'horizontalCells': [], 'components': [], 'componentCount': 0}
    mask = _denoise(_white_content_mask(crop))
    columns, rows = mask.mean(axis=0), mask.mean(axis=1)
    vertical, horizontal = _separators(columns), _separators(rows)
    scale = min(1.0, 1600.0 / max(height, width))
    small = cv2.resize(mask, (max(1, round(width * scale)), max(1, round(height * scale))), interpolation=cv2.INTER_NEAREST)
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(small, connectivity=8)
    components = []
    canvas = float(small.shape[0] * small.shape[1]) or 1.0
    for index in range(1, count):
        x, y, component_width, component_height, area = stats[index]
        if area < 3:
            continue
        components.append({'box': [x / small.shape[1], y / small.shape[0], (x + component_width) / small.shape[1], (y + component_height) / small.shape[0]], 'area': round(float(area) / canvas, 6)})
    components.sort(key=lambda item: -item['area'])
    return {
        'size': [width, height],
        'contentRatio': round(float(mask.mean()), 4),
        'verticalSeparators': vertical,
        'horizontalSeparators': horizontal,
        'verticalCells': _cells(columns, vertical),
        'horizontalCells': _cells(rows, horizontal),
        'components': components[:40],
        'componentCount': len(components),
    }


def _page_points(box, width, height):
    return (int(round(box['x'] * width / 1000)), int(round(box['y'] * height / 1000)),
            int(round((box['x'] + box['w']) * width / 1000)), int(round((box['y'] + box['h']) * height / 1000)))


def _page_box(rect, width, height):
    x0, y0, x1, y1 = [float(value) for value in rect]
    x = min(1000.0, max(0.0, x0 / width * 1000))
    y = min(1000.0, max(0.0, y0 / height * 1000))
    return {'x': round(x, 2), 'y': round(y, 2),
            'w': round(min(1000.0 - x, max(0.0, (x1 - x0) / width * 1000)), 2),
            'h': round(min(1000.0 - y, max(0.0, (y1 - y0) / height * 1000)), 2)}


def _iou(a, b):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    return max(0, x1 - x0) * max(0, y1 - y0)


def _contains(rect, x, y):
    return rect[0] <= x <= rect[2] and rect[1] <= y <= rect[3]


def _oriented_pixels(path):
    """Load the displayed orientation (EXIF applied) plus an optional alpha channel."""
    with Image.open(path) as opened:
        info = dict(getattr(opened, 'info', {}) or {})
        image = ImageOps.exif_transpose(opened)
        image.load()
        transparent = image.mode in ('RGBA', 'LA') or (image.mode in ('P', 'RGB') and 'transparency' in info)
        if transparent:
            rgba = np.asarray(image.convert('RGBA'))
            return np.ascontiguousarray(rgba[:, :, :3]), np.ascontiguousarray(rgba[:, :, 3]), (int(rgba.shape[1]), int(rgba.shape[0]))
        rgb = np.asarray(image.convert('RGB'))
        return rgb, None, (int(rgb.shape[1]), int(rgb.shape[0]))


def _cell_rect(box, width, height):
    def number(value):
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0.0
    x0 = max(0.0, min(1000.0, number(box.get('x'))))
    y0 = max(0.0, min(1000.0, number(box.get('y'))))
    x1 = max(x0, min(1000.0, x0 + max(0.0, number(box.get('w')))))
    y1 = max(y0, min(1000.0, y0 + max(0.0, number(box.get('h')))))
    left = int(math.floor(x0 * width / 1000))
    top = int(math.floor(y0 * height / 1000))
    right = int(math.ceil(x1 * width / 1000))
    bottom = int(math.ceil(y1 * height / 1000))
    left, top = max(0, min(width - 1, left)), max(0, min(height - 1, top))
    right, bottom = max(left + 1, min(width, right)), max(top + 1, min(height, bottom))
    return (left, top, right, bottom)


def _option(options, key, default, minimum=None, maximum=None):
    try:
        value = float((options or {}).get(key, default))
    except (TypeError, ValueError):
        value = float(default)
    if not math.isfinite(value):
        value = float(default)
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def _padding_for(content_width, content_height, options, default_ratio=0.009, default_maximum=12):
    # Thin local border: about 0.8%-1% of the short content side, with a small pixel floor and a
    # reasonable cap for large images (12px by default, or ~2% of a tiny content side).
    ratio = _option(options, 'paddingRatio', default_ratio, 0.002, 0.05)
    minimum = int(_option(options, 'minPadding', 2, 1, 64))
    default_max = int(min(default_maximum, max(minimum, round(min(content_width, content_height) * 0.02))))
    maximum = int(_option(options, 'maxPadding', default_max, minimum, 256))
    pad = int(round(min(content_width, content_height) * ratio))
    pad = int(max(minimum, min(maximum, pad)))
    return pad, {'paddingRatio': round(ratio, 4), 'minPadding': minimum, 'maxPadding': maximum}


def _structural_bounds(mask, cell_shape):
    """Union of trustworthy low-contrast structures anywhere in the safe cell.

    Independent faint 1px rules, small units/legend/panel letters can be far away from the main
    rectangle, so limiting the low-contrast search to a small window around the strong bbox would
    lose real image information. Only isolated 1x1 speckles are ignored; thin long lines and tiny
    text components (area>=2) are kept, preferring completeness over tightness.
    """
    if mask is None:
        return None
    kernel = mask.astype(np.uint8)
    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(kernel, connectivity=8)
    height, width = cell_shape
    bounds = None
    for index in range(1, count):
        x, y, component_width, component_height, area = stats[index]
        if area < 2 and component_width < 3 and component_height < 3:
            continue
        left, top = int(x), int(y)
        right, bottom = int(x + component_width), int(y + component_height)
        if bounds is None:
            bounds = (left, top, right, bottom)
        else:
            bounds = (min(bounds[0], left), min(bounds[1], top), max(bounds[2], right), max(bounds[3], bottom))
    if bounds is None:
        return None
    return (max(0, bounds[0]), max(0, bounds[1]), min(width, bounds[2]), min(height, bounds[3]))



def _border_stats(rgb, alpha, cell):
    x0, y0, x1, y1 = cell
    cell_height, cell_width = y1 - y0, x1 - x0
    ring = max(2, int(round(min(cell_height, cell_width) * 0.02)))
    ring = min(ring, max(1, min(cell_height, cell_width) // 4))
    region = rgb[y0:y1, x0:x1]
    alpha_region = alpha[y0:y1, x0:x1] if alpha is not None else None
    masks = np.zeros((cell_height, cell_width), dtype=bool)
    masks[:ring, :] = True
    masks[-ring:, :] = True
    masks[:, :ring] = True
    masks[:, -ring:] = True
    border = region[masks]
    border_alpha = alpha_region[masks] if alpha_region is not None else None
    transparent_fraction = float((alpha_region < 250).mean()) if alpha_region is not None else 0.0
    if alpha_region is not None and transparent_fraction > 0.002:
        opaque = border_alpha >= 200
        opaque_border = border[opaque] if opaque.any() else border
        color = np.median(opaque_border, axis=0).astype(int).tolist() if len(opaque_border) else [255, 255, 255]
        return {'alphaMode': True, 'transparentFraction': round(transparent_fraction, 4), 'color': [int(v) for v in color], 'dominance': 1.0, 'std': 0.0, 'ring': ring}
    if alpha_region is not None:
        opaque = border_alpha >= 200
        border = border[opaque] if opaque.any() else border
    color = np.median(border, axis=0).astype(int)
    difference = np.max(np.abs(border.astype(np.int16) - color.astype(np.int16)), axis=1)
    tolerance = 20
    dominance = float((difference <= tolerance).mean())
    std = float(np.max(border.astype(np.float32).std(axis=0))) if len(border) else 0.0
    return {'alphaMode': False, 'transparentFraction': round(transparent_fraction, 4), 'color': [int(v) for v in color], 'dominance': round(dominance, 4), 'std': round(std, 2), 'ring': ring}


def _detect_content(rgb, alpha, cell, options):
    """Minimal content bounds inside one safe cell; conservative when the cell is a photo/flat."""
    x0, y0, x1, y1 = cell
    cell_rgb = rgb[y0:y1, x0:x1]
    cell_alpha = alpha[y0:y1, x0:x1] if alpha is not None else None
    stats = _border_stats(rgb, alpha, cell)
    tolerance = int(_option(options, 'backgroundTolerance', 8, 2, 90))
    alpha_threshold = int(_option(options, 'alphaThreshold', 2, 1, 254))
    background = {'color': stats['color'], 'dominance': stats['dominance'], 'std': stats['std'], 'alphaMode': stats['alphaMode'], 'transparentFraction': stats['transparentFraction'], 'ringPx': stats['ring']}
    if stats['alphaMode']:
        mask = (cell_alpha > alpha_threshold)
        weak_mask = (cell_alpha > 0)
        mode = 'alpha-background'
        if not mask.any():
            return {'conservative': True, 'reason': '全透明或无可见内容，保持候选范围', 'content': (0, 0, cell_rgb.shape[1], cell_rgb.shape[0]), 'mask': mask, 'coverage': 0.0, 'background': background, 'mode': 'conservative'}
        coverage = float(mask.mean())
        evidence_mode = mode
        alpha_pad = True
    else:
        if stats['dominance'] < 0.72 or stats['std'] > 32:
            return {'conservative': True, 'reason': '边缘背景不稳定（疑似满幅照片/纹理画面），不按白底裁剪', 'content': (0, 0, cell_rgb.shape[1], cell_rgb.shape[0]), 'mask': None, 'coverage': float((cell_rgb != stats['color']).any(axis=2).mean()), 'background': background, 'mode': 'conservative'}
        difference = np.max(np.abs(cell_rgb.astype(np.int16) - np.array(stats['color'], dtype=np.int16)), axis=2)
        mask = difference > tolerance
        weak_mask = difference > max(2, round(tolerance * 0.4))
        alpha_pad = False
    assert mask is not None
    coverage = float(mask.mean())
    if coverage < 0.0004:
        return {'conservative': True, 'reason': '无可靠前景/纯色或均匀图，保持候选范围', 'content': (0, 0, cell_rgb.shape[1], cell_rgb.shape[0]), 'mask': mask, 'coverage': round(coverage, 6), 'background': background, 'mode': 'conservative'}
    if not stats['alphaMode']:
        # A textured photo with a uniform border (vignette) must not lose its normal picture.
        sample = cell_rgb[::max(1, cell_rgb.shape[0] // 80), ::max(1, cell_rgb.shape[1] // 80)].reshape(-1, 3)
        unique = int(np.unique(sample, axis=0).shape[0]) if len(sample) else 0
        if unique > 1500 and coverage > 0.25:
            return {'conservative': True, 'reason': '画面颜色/纹理丰富（疑似照片），不自动裁掉正常画面', 'content': (0, 0, cell_rgb.shape[1], cell_rgb.shape[0]), 'mask': mask, 'coverage': round(coverage, 6), 'background': background, 'mode': 'conservative'}
    rows = np.where(mask.any(axis=1))[0]
    columns = np.where(mask.any(axis=0))[0]
    if not len(rows) or not len(columns):
        return {'conservative': True, 'reason': '无可靠前景，保持候选范围', 'content': (0, 0, cell_rgb.shape[1], cell_rgb.shape[0]), 'mask': mask, 'coverage': round(coverage, 6), 'background': background, 'mode': 'conservative'}
    content = (int(columns[0]), int(rows[0]), int(columns[-1]) + 1, int(rows[-1]) + 1)
    content_width, content_height = content[2] - content[0], content[3] - content[1]
    if content_width >= cell_rgb.shape[1] - 1 and content_height >= cell_rgb.shape[0] - 1 and coverage > 0.35:
        return {'conservative': True, 'reason': '内容占满候选范围，无更紧可信边界', 'content': content, 'mask': mask, 'coverage': round(coverage, 6), 'background': background, 'mode': 'conservative'}
    structural = _structural_bounds(weak_mask, cell_rgb.shape[:2])
    if structural:
        content = (min(content[0], structural[0]), min(content[1], structural[1]), max(content[2], structural[2]), max(content[3], structural[3]))
    return {'conservative': False, 'content': content, 'mask': mask, 'coverage': round(coverage, 6), 'background': background, 'mode': evidence_mode if stats['alphaMode'] else 'uniform-background', 'alphaPad': bool(stats['alphaMode'])}


def _expanded(content, pad, shape, clamp_rect=None):
    x0, y0, x1, y1 = content
    left, top, right, bottom = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    height, width = shape
    left, top = max(0, left), max(0, top)
    right, bottom = min(width, right), min(height, bottom)
    if clamp_rect is not None:
        left, top = max(clamp_rect[0], left), max(clamp_rect[1], top)
        right, bottom = min(clamp_rect[2], right), min(clamp_rect[3], bottom)
    return (int(left), int(top), int(right), int(bottom))


def frame(page_path, box, options=None):
    rgb, alpha, (width, height) = _oriented_pixels(page_path)
    cell = _cell_rect(box, width, height)
    options = options if isinstance(options, dict) else {}
    result = _detect_content(rgb, alpha, cell, options)
    candidate = _page_box(cell, width, height)
    if result['conservative']:
        return {'box': candidate, 'contentBox': candidate, 'evidence': {
            'mode': 'conservative', 'reason': result['reason'], 'candidateBox': candidate,
            'backgroundColor': result['background']['color'], 'backgroundDominance': result['background']['dominance'],
            'coverage': result['coverage'], 'paddingPx': 0, 'orientationApplied': True,
            'sourceSize': [width, height], 'cellRectPx': list(cell)
        }}
    content_local = result['content']
    content_px = (cell[0] + content_local[0], cell[1] + content_local[1], cell[0] + content_local[2], cell[1] + content_local[3])
    pad, padding_bounds = _padding_for(content_px[2] - content_px[0], content_px[3] - content_px[1], options)
    framed = _expanded(content_px, pad, (height, width), clamp_rect=cell)
    return {'box': _page_box(framed, width, height), 'contentBox': _page_box(content_px, width, height), 'evidence': {
        'mode': result['mode'], 'candidateBox': candidate,
        'backgroundColor': result['background']['color'], 'backgroundDominance': result['background']['dominance'],
        'backgroundStd': result['background']['std'], 'coverage': result['coverage'],
        'paddingPx': int(pad), **padding_bounds, 'contentRectPx': list(content_px), 'framedRectPx': list(framed),
        'cellRectPx': list(cell), 'orientationApplied': True, 'sourceSize': [width, height]
    }}


def crop(page_path, box, output_path, options=None):
    """Crop the minimal real content inside the candidate cell, then add a local background pad.

    The candidate box is a hard safe cell: no pixels outside it are searched as content. The
    output content pixels are copied unchanged (never scaled); the added border uses this cell's
    own background colour (or transparent pixels for transparent assets). Without a stable
    background (photos/flat frames) the whole candidate is returned without trimming or padding.
    """
    rgb, alpha, (width, height) = _oriented_pixels(page_path)
    cell = _cell_rect(box, width, height)
    options = options if isinstance(options, dict) else {}
    result = _detect_content(rgb, alpha, cell, options)
    candidate = _page_box(cell, width, height)
    evidence = {
        'candidateBox': candidate, 'backgroundDominance': result['background']['dominance'],
        'backgroundStd': result['background']['std'], 'coverage': result['coverage'],
        'orientationApplied': True, 'sourceSize': [width, height], 'cellRectPx': list(cell)
    }
    if result['conservative']:
        content_px = cell
        plain = rgb[cell[1]:cell[3], cell[0]:cell[2]]
        out_alpha = alpha[cell[1]:cell[3], cell[0]:cell[2]] if alpha is not None else None
        output = np.dstack([plain, out_alpha]) if out_alpha is not None else plain
        result_box = candidate
        evidence.update({'mode': 'conservative', 'reason': result['reason'], 'paddingPx': 0,
                         'backgroundColor': result['background']['color'], 'padMode': 'none'})
    else:
        content_px = (cell[0] + result['content'][0], cell[1] + result['content'][1], cell[0] + result['content'][2], cell[1] + result['content'][3])
        pad, padding_bounds = _padding_for(content_px[2] - content_px[0], content_px[3] - content_px[1], options)
        base = rgb[content_px[1]:content_px[3], content_px[0]:content_px[2]]
        base_alpha = alpha[content_px[1]:content_px[3], content_px[0]:content_px[2]] if alpha is not None else None
        fill = np.array(result['background']['color'], dtype=np.uint8)
        out_height, out_width = base.shape[0] + pad * 2, base.shape[1] + pad * 2
        if result.get('alphaPad'):
            # Transparent asset: pad is fully transparent; hidden RGB is only a filler, never content.
            output = np.zeros((out_height, out_width, 4), dtype=np.uint8)
            output[:, :, :3] = fill
            output[:, :, 3] = 0
            output[pad:pad + base.shape[0], pad:pad + base.shape[1], :3] = base
            output[pad:pad + base.shape[0], pad:pad + base.shape[1], 3] = base_alpha
            evidence.update({'mode': result['mode'], 'backgroundColor': 'transparent', 'padMode': 'transparent',
                             'backgroundColorRgb': [int(v) for v in fill], 'alphaThreshold': True})
        else:
            output = np.empty((out_height, out_width, 3), dtype=np.uint8)
            output[:, :, :] = fill
            output[pad:pad + base.shape[0], pad:pad + base.shape[1], :] = base
            evidence.update({'mode': result['mode'], 'backgroundColor': [int(v) for v in fill], 'padMode': 'background-color'})
        evidence.update({'paddingPx': int(pad), **padding_bounds, 'contentRectPx': list(content_px), 'outputSize': [int(out_width), int(out_height)]})
        result_box = _page_box(content_px, width, height)
    if evidence['mode'] == 'conservative':
        output_size = [int(output.shape[1]), int(output.shape[0])]
        evidence['outputSize'] = output_size
    folder = os.path.dirname(os.path.abspath(output_path))
    if folder:
        os.makedirs(folder, exist_ok=True)
    image = Image.fromarray(output)
    image.save(output_path)
    return {'box': result_box, 'contentBox': result_box, 'width': int(output.shape[1]), 'height': int(output.shape[0]), 'file': os.path.basename(output_path), 'evidence': evidence}


def complete(page_path, vision_box, caption_box, body_boxes):
    """Confirm complete connected content, then return real content bounds + small protective pad.

    The AI/vision box is never unioned into the final range: a loose box must not permanently keep
    blank space. A tight half box still expands through connected drawing components. Body text and
    caption guards are preserved; if the pad would touch body text the pad is reduced, never the
    confirmed content.
    """
    rgb, alpha, (width, height) = _oriented_pixels(page_path)
    vision = _page_points(vision_box, width, height)
    caption = _page_points(caption_box, width, height) if caption_box else None
    if alpha is not None and (alpha < 250).any() and (alpha > 0).any():
        # Visible alpha edges win over hidden RGB: transparent filler must never become content.
        mask = (alpha > 0).astype(np.uint8)
    else:
        mask = _rgb_content_mask(rgb, tolerance=10)
    kernel = max(2, round(max(width, height) * 0.004))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((kernel, kernel), np.uint8))
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
    bodies = [_page_points(box, width, height) for box in (body_boxes or [])]
    # Small units/panel letters are real content: keep tiny components instead of filtering them
    # out by pixel area; body/caption guards still remove long prose blocks.
    minimum = max(3, width * height * 0.000008)
    components = []
    for index in range(1, count):
        x, y, component_width, component_height, area = stats[index]
        if area < minimum:
            continue
        center_x, center_y = x + component_width / 2, y + component_height / 2
        if any(_contains(body, center_x, center_y) for body in bodies):
            continue
        if caption and _contains(caption, center_x, center_y):
            continue
        components.append((int(x), int(y), int(x + component_width), int(y + component_height)))
    expanded_vision = (vision[0] - int(width * 0.02), vision[1] - int(height * 0.02), vision[2] + int(width * 0.02), vision[3] + int(height * 0.02))
    seeds = [component for component in components if _iou(component, expanded_vision) > 0]
    if not seeds:
        return {'error': '视觉框附近没有可确认的图形结构'}
    region = [min(component[0] for component in seeds), min(component[1] for component in seeds), max(component[2] for component in seeds), max(component[3] for component in seeds)]
    distance = max(width, height) * 0.025
    changed = True
    while changed:
        changed = False
        for component in components:
            if component in seeds:
                continue
            gap = max(region[0] - component[2], component[0] - region[2], region[1] - component[3], component[1] - region[3], 0)
            if gap <= distance:
                seeds.append(component)
                region = [min(region[0], component[0]), min(region[1], component[1]), max(region[2], component[2]), max(region[3], component[3])]
                changed = True
    content = (max(0, int(region[0])), max(0, int(region[1])), min(width, int(region[2])), min(height, int(region[3])))
    if content[2] - content[0] < 4 or content[3] - content[1] < 4:
        return {'error': '完整图形范围过小'}
    if content[0] <= 0 and content[2] >= width and content[1] <= 0 and content[3] >= height:
        return {'error': '完整图形覆盖整页，已保留页面参考'}
    # Keep a small protective pad; it may be limited by body/caption but content is never cut.
    pad, padding_bounds = _padding_for(content[2] - content[0], content[3] - content[1], {}, default_ratio=0.018, default_maximum=24)
    padded = list(_expanded(content, pad, (height, width)))
    for body in bodies:
        if body[2] <= body[0] or body[3] <= body[1]:
            continue
        body_area = (body[2] - body[0]) * (body[3] - body[1]) or 1
        if _iou(content, body) / body_area > 0.18:
            return {'error': '完整候选范围会混入正文，已保留页面参考'}
        if pad and _iou(tuple(padded), body) / body_area > 0.18:
            pad = 0
            padded = list(content)
    if caption:
        horizontal = max(0, min(padded[2], caption[2]) - max(padded[0], caption[0]))
        if horizontal / max(1, padded[2] - padded[0]) < 0.25:
            return {'error': '图注与图形横向不对应'}
        below_gap = caption[1] - padded[3]
        above_gap = padded[1] - caption[3]
        if below_gap > int(height * 0.06):
            if above_gap > int(height * 0.10) or above_gap < -int(height * 0.05):
                return {'error': '图注与图形距离过远'}
        elif below_gap < -int(height * 0.05):
            if above_gap < 0 or above_gap > int(height * 0.10):
                return {'error': '图注与图形距离过远'}
    box = _page_box(padded, width, height)
    content_box = _page_box(content, width, height)
    if box['w'] < 20 or box['h'] < 20:
        return {'error': '完整范围过小'}
    if box['w'] * box['h'] > 850000:
        return {'error': '完整范围过大，已保留页面参考'}
    return {'box': {key: float(value) for key, value in box.items()}, 'contentBox': {key: float(value) for key, value in content_box.items()}, 'evidence': {
        'components': int(len(seeds)), 'expanded': bool(box['w'] * box['h'] > vision_box['w'] * vision_box['h'] * 1.02),
        'caption': bool(caption), 'paddingPx': int(pad), **padding_bounds,
        'visionBox': {key: float(value) for key, value in vision_box.items()}
    }}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'usage: document_panels.py analyze|frame|crop|complete ...'}))
        return
    op = sys.argv[1]
    if op == 'analyze':
        if len(sys.argv) < 4:
            print(json.dumps({'error': 'analyze path boxJSON'}))
            return
        page_path, box = sys.argv[2], json.loads(sys.argv[3])
        print(json.dumps(analyze(page_path, box), ensure_ascii=True))
        return
    if op == 'frame':
        if len(sys.argv) < 4:
            print(json.dumps({'error': 'frame path boxJSON [optionsJSON]'}))
            return
        page_path, box = sys.argv[2], json.loads(sys.argv[3])
        options = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else {}
        print(json.dumps(frame(page_path, box, options), ensure_ascii=True))
        return
    if op == 'crop':
        if len(sys.argv) < 5:
            print(json.dumps({'error': 'crop path boxJSON outputPath [optionsJSON]'}))
            return
        page_path, box, output_path = sys.argv[2], json.loads(sys.argv[3]), sys.argv[4]
        options = json.loads(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] else {}
        print(json.dumps(crop(page_path, box, output_path, options), ensure_ascii=True))
        return
    if op == 'complete':
        page_path, box = sys.argv[2], json.loads(sys.argv[3])
        caption = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else None
        bodies = json.loads(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] else []
        print(json.dumps(complete(page_path, box, caption, bodies), ensure_ascii=True))
        return
    print(json.dumps({'error': '不支持的操作'}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=True))
        sys.exit(1)
