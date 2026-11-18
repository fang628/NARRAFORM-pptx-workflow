"""Text colour recognition for the 05 rebuild pipeline.

Title text: detect whether the fill actually has a (vertical only) gradient and fit it.
Secondary titles (subtitle/heading/table-header/...): at most two distinct solid colours
including the base, never a glyph gradient.
Body text: find differently-coloured runs inside one text element and record their colours
and approximate line ranges for later reconstruction.
"""
import cv2
import json
import os
import re
import sys
from functools import lru_cache

import numpy as np

# Phase/main values are installed by main() when this file is used as a CLI. Importing the
# module for its pure policy helpers must not read argv/spec files.
spec = None
image = None
surface_image = None
page_width = 1600.0
ratio = 1.0


@lru_cache(maxsize=4)
def glyph_alpha(file, width, height):
    glyph = cv2.imread(file, cv2.IMREAD_UNCHANGED)
    if glyph is None or glyph.ndim != 3 or glyph.shape[2] != 4:
        return None
    return cv2.resize(glyph[:, :, 3], (width, height))

# Exact roles only: substring/size fallbacks used to promote subtitles to titles.
TITLE_ROLES = {'title'}
SECONDARY_TITLE_ROLES = {'subtitle', 'heading', 'subheading', 'table-header', 'table-title',
                         'imagetitle', 'figure-title'}
MATH_MARKUP = re.compile(r'[\^_$<>]|\\(?:frac|sqrt|sum|int|alpha|beta|gamma|theta|cdot|times|le|ge|neq|left|right)')


def role_of(element):
    return str((element or {}).get('role') or '').strip().lower()


def is_title_element(element):
    """The page main title is decided by explicit identity, never by a role substring or size."""
    element = element or {}
    role = role_of(element)
    if role and role not in TITLE_ROLES:
        return False
    if role in TITLE_ROLES:
        return True
    if element.get('title') is True:
        return True
    if str(element.get('part') or '').strip().lower() == 'title':
        return True
    return str(element.get('nodeId') or '').strip().lower() == 'title'


def is_secondary_title_element(element):
    """Subtitle/heading/table-header etc. keep solid fills (no glyph gradient)."""
    return role_of(element) in SECONDARY_TITLE_ROLES


def color_run_limit(element):
    # Secondary titles may carry two solid colours on one line (e.g. prefix + value); body text
    # keeps its single emphasis colour.
    if is_secondary_title_element(element):
        return 1  # base colour + one emphasis colour = two distinct glyph colours
    return 2 if is_title_element(element) else 1


def run_coverage(run):
    """Character coverage of a colour run; spatial spans win over pixel-cluster share."""
    spans = (run or {}).get('lineSpans') or []
    if spans:
        return sum(max(0.0, float(span.get('endFraction') or 0) - float(span.get('startFraction') or 0))
                   for span in spans)
    evidence = (run or {}).get('evidence') or {}
    return float((run or {}).get('share') or evidence.get('share') or 0.0)


def rank_color_runs(runs, limit):
    """Keep the strongest spatially separated runs, preserving their original order."""
    if not runs or limit <= 0:
        return []
    ranked = sorted(enumerate(runs), key=lambda pair: (-run_coverage(pair[1]), pair[0]))
    kept = sorted(ranked[:int(limit)], key=lambda pair: pair[0])
    return [run for _, run in kept]


def merge_style(element, measured, page_median_ratio=0.0):
    """Separate colour confidence from weight/slant. Weak stroke evidence must not clear an
    explicit bold/italic flag; only strong same-class evidence may override it."""
    element = element or {}
    measured = measured or {}
    ratio = float(measured.get('thicknessRatio') or 0.0)
    slope = float(measured.get('skew') or 0.0)
    slope_samples = int(measured.get('slopeSamples') or 0)
    span_bold = bool(measured.get('boldSpans'))
    wide_bold = bool(measured.get('wideBoldRun'))
    strong_bold = bool(span_bold or wide_bold or
                       (ratio > 0 and ratio >= max(0.12, page_median_ratio * 1.6)))
    measured_bold = bool(span_bold or wide_bold or
                         (ratio > 0 and ratio >= max(0.095, page_median_ratio * 1.20)))
    measured_italic = bool(0.10 <= slope <= 0.65 and slope_samples >= 2)
    strong_italic = bool(measured_italic and slope_samples >= 4 and 0.15 <= slope <= 0.60)
    explicit_bold = element.get('bold') is True
    explicit_italic = element.get('italic') is True
    return {
        'bold': True if explicit_bold and not strong_bold else measured_bold,
        'italic': True if explicit_italic and not strong_italic else measured_italic,
        'styleConfidence': {
            'bold': 'strong' if strong_bold else ('weak' if measured_bold else 'none'),
            'italic': 'strong' if strong_italic else ('weak' if measured_italic else 'none'),
        },
    }



def to_hex(color):
    color = np.clip(np.asarray(color, float), 0, 255).astype(np.uint8)
    rgb = cv2.cvtColor(color.reshape(1, 1, 3), cv2.COLOR_LAB2RGB)[0, 0]
    return '%02x%02x%02x' % (int(rgb[0]), int(rgb[1]), int(rgb[2]))


def to_lab(rgb):
    pixel = np.asarray(rgb, np.uint8).reshape(1, 1, 3)
    return cv2.cvtColor(pixel, cv2.COLOR_RGB2LAB)[0, 0].astype(np.float32)


def robust_lab_median(values, tolerance=12.0, iterations=2):
    """Median colour of ink-core pixels, trimmed twice so anti-aliased fringes and a
    minority accent/decoration colour cannot pull the solid base colour away."""
    values = np.asarray(values, np.float32).reshape(-1, 3)
    if not len(values):
        return None, 0.0
    median = np.median(values, axis=0)
    for _ in range(max(1, int(iterations))):
        distances = np.linalg.norm(values - median, axis=1)
        keep = distances <= tolerance
        if int(keep.sum()) < max(8, int(len(values) * 0.35)):
            break
        updated = np.median(values[keep], axis=0)
        if float(np.linalg.norm(updated - median)) < 0.5:
            median = updated
            break
        median = updated
    distances = np.linalg.norm(values - median, axis=1)
    return median, float(np.median(distances))


def kmeans_colours(pixels, k):
    if len(pixels) < k * 12:
        return []
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)
    pixels = np.float32(pixels)
    _, labels, centers = cv2.kmeans(pixels, k, None, criteria, 4, cv2.KMEANS_PP_CENTERS)
    counts = np.bincount(labels.ravel(), minlength=k)
    order = np.argsort(-counts)
    return [(centers[index], int(counts[index])) for index in order]


def analyse_text(element):
    x, y, w, h = [float(element.get(key) or 0) for key in ('x', 'y', 'w', 'h')]
    if w < 8 or h < 8:
        return None
    x0, y0 = int(round(x * ratio)), int(round(y * ratio))
    x1, y1 = int(round((x + w) * ratio)), int(round((y + h) * ratio))
    pad = max(8, int(round(0.35 * max(w, h))))
    ex0, ey0 = max(0, x0 - pad), max(0, y0 - pad)
    ex1, ey1 = min(image.shape[1], x1 + pad), min(image.shape[0], y1 + pad)
    patch = image[max(0, y0):y1, max(0, x0):x1]
    expanded = image[ey0:ey1, ex0:ex1]
    if patch.size == 0 or expanded.size == 0:
        return None
    lab = cv2.cvtColor(patch, cv2.COLOR_BGR2LAB).astype(np.float32)
    expanded_lab = cv2.cvtColor(expanded, cv2.COLOR_BGR2LAB).astype(np.float32)
    # Background estimate must come from OUTSIDE the glyph box: a tight text box is usually
    # filled by glyph pixels, so the old inner-ring estimate mistook white glyphs for the
    # background and repainted white text with the dark page colour.
    ring_pixels = np.concatenate([
        expanded_lab[:pad].reshape(-1, 3) if pad > 0 else np.empty((0, 3), np.float32),
        expanded_lab[-pad:].reshape(-1, 3) if pad > 0 else np.empty((0, 3), np.float32),
        expanded_lab[:, :pad].reshape(-1, 3) if pad > 0 else np.empty((0, 3), np.float32),
        expanded_lab[:, -pad:].reshape(-1, 3) if pad > 0 else np.empty((0, 3), np.float32),
    ]).astype(np.float32)
    if len(ring_pixels) < 20:
        ring_pixels = expanded_lab.reshape(-1, 3)
    background = np.median(ring_pixels, axis=0)
    # A bounded badge/label lives on its carrier, not on the page surrounding
    # that carrier. Sample the local surface when its declared colour is present.
    carrier_mask=None
    local_carrier=None
    carriers=sorted(spec.get('elements',[]) if spec else [],key=lambda c:(c.get('key')!=element.get('carrierId'),float(c.get('w',0))*float(c.get('h',0))))
    declared_carrier=next((c for c in carriers if c.get('key')==element.get('carrierId')),None)
    for carrier in carriers:
        if carrier.get('type') not in ('shape','rect','ellipse') or carrier.get('key')==element.get('key'):continue
        ox,oy,ow,oh=[float(carrier.get(k,0) or 0) for k in ('x','y','w','h')]
        if carrier is not declared_carrier and not (ox-3<=x and oy-3<=y and x+w<=ox+ow+3 and y+h<=oy+oh+3):continue
        fill=carrier.get('fill')
        try:
            ink=to_lab([int(fill[i:i+2],16) for i in (0,2,4)])
            candidates=lab.reshape(-1,3);candidates=candidates[np.linalg.norm(candidates-ink,axis=1)<45]
            if len(candidates)>=40:
                background=np.median(candidates,axis=0)
                local_carrier=carrier
                if carrier.get('type')=='ellipse':
                    yy,xx=np.mgrid[0:patch.shape[0],0:patch.shape[1]]
                    carrier_mask=((xx/ratio+x-ox)/ow-.5)**2+((yy/ratio+y-oy)/oh-.5)**2<.44**2
                break
        except (TypeError,ValueError):pass
    distance = np.linalg.norm(lab - background, axis=2)
    surface_patch=None
    if surface_image is not None:
        surface=surface_image[max(0,y0):y1,max(0,x0):x1]
        if surface.shape==patch.shape:
            surface_patch=cv2.cvtColor(surface,cv2.COLOR_BGR2LAB).astype(np.float32)
            # Protect the actual fitted gradient/background at each location,
            # not a page-wide median that can mistake a blue carrier for ink.
            distance=np.minimum(distance,np.linalg.norm(lab-surface_patch,axis=2))
    mask = distance > 22.0
    if declared_carrier is not None:
        palette=[declared_carrier.get('fill')]+[s.get('color') for s in (declared_carrier.get('gradient') or {}).get('stops',[])]
        for color in palette:
            try:
                base=to_lab([int(str(color).lstrip('#')[i:i+2],16) for i in (0,2,4)])
                mask &= np.linalg.norm(lab-base,axis=2)>35
            except (TypeError,ValueError):pass
    # Pixels that belong to another object are not this text's ink: an overhanging audit
    # box can include a neighbouring label, a bullet, a frame edge or a decoration. Those
    # pixels used to become fake emphasis colours and pulled solid colours toward the
    # culprit's paint, so remove them before any colour sampling.
    def build_foreign_mask():
        foreign = np.zeros(lab.shape[:2], bool)

        def intersect(first, second):
            return (max(0, min(first[2], second[2]) - max(first[0], second[0]))
                    * max(0, min(first[3], second[3]) - max(first[1], second[1])))

        own = (int(round(x * ratio)), int(round(y * ratio)),
               int(round((x + w) * ratio)), int(round((y + h) * ratio)))
        own_area = max(1, (own[2] - own[0]) * (own[3] - own[1]))
        for other in ((spec or {}).get('elements') or []):
            if not isinstance(other, dict) or other.get('key') == element.get('key'):
                continue
            if other is local_carrier or other is declared_carrier:
                continue
            kind = str(other.get('type') or '')
            try:
                ox, oy, ow, oh = [float(other.get(key, 0) or 0) for key in ('x', 'y', 'w', 'h')]
            except (TypeError, ValueError):
                continue
            if ow <= 0 or oh <= 0:
                continue
            box = (int(round(ox * ratio)), int(round(oy * ratio)),
                   int(round((ox + ow) * ratio)), int(round((oy + oh) * ratio)))
            if intersect(own, box) <= 0:
                continue
            if kind == 'text':
                entry = next((row for row in ((spec or {}).get('objectMasks') or [])
                              if row.get('key') == other.get('key') and row.get('file')), None)
                if not entry:
                    continue
                alpha = glyph_alpha(entry['file'], image.shape[1], image.shape[0])
                if alpha is None:
                    continue
                patch_alpha = alpha[max(0, y0):y1, max(0, x0):x1]
                if patch_alpha.shape == foreign.shape:
                    foreign |= patch_alpha > 128
                continue
            # Only nearby small objects can contaminate a text box; large card/page
            # surfaces are background, and carriers were handled above.
            if kind not in ('shape', 'rect', 'ellipse', 'line'):
                continue
            box_area = (box[2] - box[0]) * (box[3] - box[1])
            if box_area > own_area * 1.5:
                continue
            left = max(0, box[0] - max(0, x0))
            top = max(0, box[1] - max(0, y0))
            right = min(foreign.shape[1], box[2] - max(0, x0))
            bottom = min(foreign.shape[0], box[3] - max(0, y0))
            if right > left and bottom > top:
                foreign[top:bottom, left:right] = True
        return foreign

    raw_mask = mask
    foreign = build_foreign_mask()
    foreign_reliable = True
    if foreign.any():
        mask = raw_mask & ~foreign
        if int(mask.sum()) < max(40, int(raw_mask.sum() * 0.25)):
            # The other objects' boxes cover most of this one: the audit geometry is
            # contradictory, so do not guess a colour from that sample.
            mask = raw_mask
            foreign_reliable = False
    glyph_core = None
    glyph_entry=next((m for m in (spec or {}).get('objectMasks',[]) if m.get('key')==element.get('key') and m.get('file')),None)
    if glyph_entry:
        alpha=glyph_alpha(glyph_entry['file'],image.shape[1],image.shape[0])
        if alpha is not None:
            glyph_core=alpha[max(0,y0):y1,max(0,x0):x1]>180
            # A predicted mask may have different wrapping/font metrics. Keep it
            # as supporting evidence; clipping to it would erase real accents.
    if carrier_mask is not None:mask &= carrier_mask
    # Remove solid carrier/edge residues before colour clustering, rather than
    # asking colour distance to distinguish an orange panel from orange ink.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    size=max(8.,float(element.get('size') or 24)*ratio)
    for label in range(1,count):
        _,_,cw,ch,area=stats[label]
        if ch>size*1.8 or cw>size*2.5 or area>size*size*1.4 or (max(cw,ch)>size*.9 and min(cw,ch)<2):
            mask[labels==label]=False
    if mask.sum() < 40:
        if raw_mask.sum() >= 40:
            # Cleanup/foreign subtraction left too little ink to trust; keep the audit colour.
            mask = raw_mask
            foreign_reliable = False
        else:
            return None
    background_lab = background
    rows = np.where(mask.any(axis=1))[0]
    text_pixels = lab[mask]
    glyph_usable = False
    if glyph_core is not None and glyph_core.shape == mask.shape:
        predicted = int((glyph_core & mask).sum())
        # Predicted masks can be offset by later position fitting; only use them when they
        # clearly coincide with the measured ink, otherwise they would bias the sample.
        if (glyph_core.sum() >= 40 and predicted >= max(30, int(0.60 * glyph_core.sum()))
                and predicted >= int(0.45 * max(1, int(mask.sum())))):
            glyph_usable = True
    surface_strength = (np.linalg.norm(lab - surface_patch, axis=2)
                        if surface_patch is not None else distance)

    def local_solid_sample():
        """Solid ink colour from high-contrast glyph-core pixels only.

        Mask pixels include anti-aliased fringes, and contaminated boxes include other
        objects' paint. Neither belongs to a single-colour glyph fill, so the sample uses
        the ink core (measured against the rendered surface/background when available),
        trims twice and records background/dispersion as conservative evidence. The
        predicted glyph mask is deliberately not used here: position fitting can offset it.
        """
        if int(mask.sum()) < 40:
            return None
        values = surface_strength[mask]
        cutoff = max(24.0, float(np.percentile(values, 70)))
        region = mask & (surface_strength >= cutoff)
        if int(region.sum()) < 20:
            region = mask
        color, dispersion = robust_lab_median(lab[region])
        if color is None:
            return None
        local_background = background_lab
        if surface_patch is not None:
            values = surface_patch[region]
            if len(values) >= 20:
                local_background = np.median(values, axis=0)
        return {'lab': color, 'region': region, 'dispersion': dispersion,
                'localBackground': local_background, 'ink': int(mask.sum()),
                'core': int(region.sum())}

    # Main title only: explicit role/node/part identity. Subtitle/heading/table-header must not be
    # promoted by 'title' substrings, key naming or a large font size.
    title = is_title_element(element)
    secondary_title = is_secondary_title_element(element)
    def contrast_score(colour_lab):
        delta_l = abs(float(colour_lab[0]) - float(background_lab[0]))
        chroma = float(np.linalg.norm(colour_lab[1:] - background_lab[1:]))
        return delta_l + 0.5 * chroma

    def style_features():
        """Detect italic (glyph shear) and bold (stroke thickness) plus intra-line bold spans."""
        # Adaptive text mask: low-contrast text (e.g. white on a bright band) can yield only a
        # handful of pixels with the fixed colour-distance mask; use the high tail of the local
        # distance distribution so style still works.
        flat = distance.reshape(-1)
        threshold = max(12.0, float(np.percentile(flat, 92)) * 0.55)
        adaptive_mask = distance > threshold
        style_mask = adaptive_mask if int(adaptive_mask.sum()) >= 60 else mask
        if style_mask.sum() < 40:
            return None
        dt = cv2.distanceTransform(style_mask.astype(np.uint8), cv2.DIST_L2, 3)
        thickness = 2.0 * float(np.median(dt[style_mask])) if style_mask.any() else 0.0
        scaled_size = max(8.0, float(element.get('size') or 24) * ratio)
        thickness_ratio = thickness / scaled_size
        row_flags = style_mask.any(axis=1)
        bands = []
        start_row = None
        for row_index, flag in enumerate(row_flags):
            if flag and start_row is None:
                start_row = row_index
            elif not flag and start_row is not None:
                if row_index - start_row >= 3:
                    bands.append((start_row, row_index - 1))
                start_row = None
        if start_row is not None and len(row_flags) - start_row >= 3:
            bands.append((start_row, len(row_flags) - 1))
        slopes = []
        bold_spans = []
        for line_index, (band_start, band_end) in enumerate(bands):
            ys, xs = [], []
            for row_index in range(band_start, band_end + 1):
                columns = np.where(style_mask[row_index])[0]
                if len(columns) >= 3:
                    ys.append(row_index)
                    xs.append(float(columns.mean()))
            if len(ys) >= 4:
                slopes.append(float(np.polyfit(ys, xs, 1)[0]))
            band_dt = dt[band_start:band_end + 1]
            band_mask = style_mask[band_start:band_end + 1]
            column_thickness = []
            for column in range(band_mask.shape[1]):
                values = band_dt[band_mask[:, column], column]
                if len(values) >= 2:
                    column_thickness.append((column, float(np.mean(values) * 2.0)))
            if not column_thickness:
                continue
            median_thickness = float(np.median([value for _, value in column_thickness]))
            if median_thickness <= 0:
                continue
            hits = [column for column, value in column_thickness if value >= 1.30 * median_thickness]
            if not hits:
                continue
            runs = []
            run_start = previous = hits[0]
            for column in hits[1:]:
                if column - previous <= 2:
                    previous = column
                else:
                    runs.append((run_start, previous))
                    run_start = previous = column
            runs.append((run_start, previous))
            text_columns = np.where(band_mask.any(axis=0))[0]
            if len(text_columns) < 4:
                continue
            x0, x1 = float(text_columns[0]), float(text_columns[-1])
            width = max(1.0, x1 - x0)
            for left, right in runs:
                if right - left + 1 < max(3, int(0.05 * width)):
                    continue
                bold_spans.append({'lineIndex': line_index,
                                   'startFraction': round((left - x0) / width, 3),
                                   'endFraction': round((right + 1 - x0) / width, 3)})
        valid_slopes = [slope for slope in slopes if abs(slope) <= 0.8]
        skew = float(np.median(valid_slopes)) if valid_slopes else 0.0
        wide_bold = any((span['endFraction'] - span['startFraction']) > 0.6 for span in bold_spans)
        bold_spans = [span for span in bold_spans
                      if (span['endFraction'] - span['startFraction']) <= 0.6]
        return {'skew': round(skew, 3), 'slopeSamples': len(valid_slopes),
                'thicknessRatio': round(thickness_ratio, 3), 'boldSpans': bold_spans,
                'wideBoldRun': wide_bold}

    # Italic/bold heuristics only make sense for body/table text; calligraphic titles keep the
    # project-level title style and must not be judged as bold/italic from stroke thickness.
    style = style_features() if not title and spec.get('measureTypography',True) else None
    if not foreign_reliable:
        # Another object's box covers most of this text box: the audit geometry is
        # contradictory, so a colour guessed from the remaining pixels is not trustworthy.
        return {'key': element.get('key'), 'kind': 'title' if title else 'body',
                'color': element.get('color'), 'role': role_of(element), 'gradient': None,
                'colorRuns': [], 'confident': False, 'colorConfident': False, 'style': style}

    def contrast_ok(colour_lab, reference_lab=None):
        reference = background_lab if reference_lab is None else reference_lab
        delta_l = abs(float(colour_lab[0]) - float(reference[0]))
        chroma = float(np.linalg.norm(colour_lab[1:] - reference[1:]))
        return delta_l >= 24.0 or chroma >= 18.0

    sample = local_solid_sample()
    if title:
        # per-row median text colour, then linear fit over rows -> vertical gradient only.
        # Prefer glyph-core pixels so anti-aliasing cannot bend either gradient stop.
        core_region = sample['region'] if sample else None
        row_colours = []
        for row in rows:
            if core_region is not None and int(core_region[row].sum()) >= 2:
                values = lab[row][core_region[row]]
            else:
                values = lab[row][mask[row]]
            if len(values) >= 3:
                row_colours.append((row, np.median(values, axis=0)))
        gradient = None
        solid = to_hex(sample['lab']) if sample else (to_hex(np.median(text_pixels, axis=0)) if len(text_pixels) else None)
        if len(row_colours) >= 8:
            ys = np.asarray([item[0] for item in row_colours], np.float32)
            values = np.asarray([item[1] for item in row_colours], np.float32)
            slopes = []
            predictions = []
            for channel in range(3):
                slope, intercept = np.polyfit(ys, values[:, channel], 1)
                slopes.append(slope)
                predictions.append(np.polyval([slope, intercept], ys))
            predictions = np.stack(predictions, axis=1)
            total = float(np.linalg.norm(predictions[-1] - predictions[0]))
            residual = float(np.mean(np.linalg.norm(values - predictions, axis=1)))
            if total >= 9.0 and residual <= total * 0.75:
                # Titles keep a two-node vertical gradient (top -> bottom).
                top = predictions[0]
                bottom = predictions[-1]
                gradient = {'angle': 90, 'vertical': True,
                            'stops': [{'offset': 0, 'color': to_hex(top)},
                                      {'offset': 1, 'color': to_hex(bottom)}],
                            'delta': round(total, 1)}
                solid = to_hex(top)
        confident = True
        local_background = sample['localBackground'] if sample else None
        if solid:
            try:
                solid_lab = to_lab([int(solid[i:i + 2], 16) for i in (0, 2, 4)])
                confident = contrast_ok(solid_lab, local_background)
            except Exception:
                confident = True
        if gradient:
            for stop in gradient.get('stops', []):
                try:
                    stop_lab = to_lab([int(stop['color'][i:i + 2], 16) for i in (0, 2, 4)])
                    if not contrast_ok(stop_lab, local_background):
                        confident = False
                except Exception:
                    pass
        audit_hex = element.get('color')
        if isinstance(audit_hex, str) and len(audit_hex) >= 6:
            try:
                audit_lab = to_lab([int(audit_hex[i:i + 2], 16) for i in (0, 2, 4)])
                measured_score = contrast_score(to_lab([int(solid[i:i + 2], 16) for i in (0, 2, 4)])) if solid else -1
                if contrast_score(audit_lab) > measured_score + 4.0:
                    confident = False
            except Exception:
                pass
        if not confident:
            return {'key': element.get('key'), 'kind': 'title', 'color': element.get('color'),
                    'role': role_of(element), 'gradient': None, 'colorRuns': [], 'confident': False,
                    'colorConfident': False, 'style': style}
        return {'key': element.get('key'), 'kind': 'title', 'color': solid,
                'role': role_of(element), 'gradient': gradient, 'colorRuns': [],
                'confident': True, 'colorConfident': True, 'style': style}
    # parent fill (card background) must never be reported as a text colour
    parent_fill = None
    if declared_carrier is not None:
        try:parent_fill=to_lab([int(str(declared_carrier['fill']).lstrip('#')[i:i+2],16) for i in (0,2,4)])
        except (KeyError,TypeError,ValueError):pass
    for other in spec.get('elements') or []:
        if parent_fill is not None:break
        if other is element or other.get('type') not in ('shape', 'rect'):
            continue
        ox, oy, ow, oh = [float(other.get(k) or 0) for k in ('x', 'y', 'w', 'h')]
        fill = other.get('fill')
        if (x >= ox - 4 and y >= oy - 4 and x + w <= ox + ow + 4 and y + h <= oy + oh + 4
                and isinstance(fill, str) and len(fill) >= 6):
            try:
                parent_fill = to_lab([int(fill[i:i + 2], 16) for i in (0, 2, 4)])
                break
            except Exception:
                parent_fill = None
    clusters = kmeans_colours(text_pixels, min(5, max(3, len(text_pixels) // 120)))
    if not clusters:
        return None
    main = clusters[0][0]
    if sample is not None:
        main = np.asarray(sample['lab'], np.float32)
    else:
        try:
            # Refine the solid colour on the glyph core only: the cluster centre includes
            # anti-aliased edge pixels and would read white text as light grey.
            core = text_pixels[np.linalg.norm(text_pixels - np.asarray(main, np.float32), axis=1) <= 14.0]
            if len(core) >= 20:
                main = np.median(core, axis=0)
        except Exception:
            pass
    # A single solid ink fill has a tight core. Wide Lab spread or a tiny core means the
    # box is contaminated (neighbouring text/decoration or mixed glyph paint), so keep the
    # audit colour instead of inventing a colour.
    if sample is not None and (sample['dispersion'] > 22.0
                               or sample['core'] < max(20, int(0.10 * sample['ink']))):
        return {'key': element.get('key'), 'kind': 'body', 'color': element.get('color'),
                'role': role_of(element), 'gradient': None, 'colorRuns': [],
                'confident': False, 'colorConfident': False, 'style': style}
    try:
        main_lab = np.asarray(main, np.float32)
        if not contrast_ok(main_lab, sample['localBackground'] if sample else None):
            return {'key': element.get('key'), 'kind': 'body', 'color': element.get('color'),
                    'role': role_of(element), 'gradient': None, 'colorRuns': [], 'confident': False,
                    'colorConfident': False, 'style': style}
        audit_hex = element.get('color')
        if isinstance(audit_hex, str) and len(audit_hex) >= 6:
            audit_lab = to_lab([int(audit_hex[i:i + 2], 16) for i in (0, 2, 4)])
            if contrast_score(audit_lab) > contrast_score(main_lab) + 4.0:
                return {'key': element.get('key'), 'kind': 'body', 'color': element.get('color'),
                        'role': role_of(element), 'gradient': None, 'colorRuns': [],
                        'confident': False, 'colorConfident': False, 'style': style}
    except Exception:
        pass
    runs = []
    accent_masks = {}
    accent_centres = {}
    total = sum(count for _, count in clusters)
    # Evidence gate: a different-coloured run is only used when the evidence is obvious — it must
    # be a large enough share, differ in hue/saturation (not just brightness) and be far away from
    # the anti-aliasing/shadow blend line between the text colour and the background.
    def distance_to_blend(point, first, second):
        direction = second - first
        length = float(np.dot(direction, direction))
        if length < 1e-6:
            return float(np.linalg.norm(point - first))
        ratio = float(np.clip(np.dot(point - first, direction) / length, 0.0, 1.0))
        projection = first + direction * ratio
        return float(np.linalg.norm(point - projection))
    debug = bool(os.environ.get('TEXTCOLOR_DEBUG'))
    for center, count in clusters[1:]:
        share = count / max(1, total)
        # Anti-aliased fringe pixels sit between the emphasis ink and its background and pull
        # the k-means centre toward the background. Re-measure the run colour on the tight
        # core around the cluster so real accents keep their designed colour.
        near_pixels = (np.linalg.norm(lab - center, axis=2) < 18.0) & mask
        if int(near_pixels.sum()) >= 20:
            refined, _ = robust_lab_median(lab[near_pixels])
            if refined is not None:
                center = refined
        if debug:
            reasons = []
            if share < 0.02: reasons.append('share<2%%')
            if float(np.linalg.norm(center - main)) < 45.0: reasons.append('delta<45')
            if float(np.linalg.norm(center[1:] - main[1:])) < 25.0: reasons.append('chroma<25')
            if distance_to_blend(center, main, background) < 30.0: reasons.append('offBlend<30')
            if float(np.linalg.norm(center - background)) < 40.0: reasons.append('bgDelta<40')
            print('DEBUGRUN', element.get('key'), 'cluster', to_hex(center), 'share', round(share, 3),
                  'chroma', round(float(np.linalg.norm(center[1:] - main[1:])), 1),
                  'delta', round(float(np.linalg.norm(center - main)), 1),
                  'bgDelta', round(float(np.linalg.norm(center - background)), 1),
                  'main', to_hex(main), 'reasons', reasons, file=sys.stderr)
        chroma = float(np.linalg.norm(center[1:] - main[1:]))
        off_blend = distance_to_blend(center, main, background)
        total_delta = float(np.linalg.norm(center - main))
        background_delta = float(np.linalg.norm(center - background))
        if share < 0.02:
            continue
        # Obvious two-colour paragraphs only: strong overall Lab delta + real hue shift, not an
        # anti-aliasing / shadow blend, not the parent card fill, not the page background, and the
        # emphasis colour must itself be readable against that background.
        if total_delta < 45.0:
            continue
        if chroma < 25.0:
            continue
        if off_blend < 30.0:
            continue
        if background_delta < 40.0:
            continue
        if parent_fill is not None and float(np.linalg.norm(center - parent_fill)) < 30.0:
            continue
        if not contrast_ok(np.asarray(center, np.float32)):
            continue
        if contrast_score(np.asarray(center, np.float32)) < 0.50 * contrast_score(np.asarray(main, np.float32)):
            continue
        extra=(np.linalg.norm(lab-center,axis=2)<18.) & mask
        # An accent must dominate actual glyph interiors. A coloured edge or
        # antialias fringe touching otherwise white letters is not an accent.
        ink_core=cv2.erode(mask.astype(np.uint8),np.ones((2,2),np.uint8))>0
        supported=np.zeros_like(mask)
        for label in range(1,count):
            component=(labels==label)&mask
            total_core=int((component&ink_core).sum())
            accent_core=int((component&ink_core&extra).sum())
            if total_core>=3 and accent_core>=max(3,.55*total_core):
                supported |= component&extra
        # Disconnected strokes of a CJK glyph may be separate components. A
        # local column with coloured core ink is still evidence for those strokes.
        for column in range(mask.shape[1]):
            lo=max(0,column-1);hi=min(mask.shape[1],column+2)
            total_core=int(ink_core[:,lo:hi].sum());accent_core=int((ink_core[:,lo:hi]&extra[:,lo:hi]).sum())
            if accent_core>=3 and accent_core>=.70*max(1,total_core):supported[:,column]|=extra[:,column]
        if int(supported.sum())<max(8,int(extra.sum()*.40)):
            continue
        # A real emphasis colour sits on this text's glyphs. When a predicted glyph mask is
        # available and trustworthy, reject "accents" that live mostly outside it (bullets,
        # frame edges, neighbouring labels caught by an overhanging audit box).
        if glyph_usable:
            overlap = float((supported & glyph_core).sum()) / max(1, int(supported.sum()))
            if overlap < 0.45:
                continue
        accent_masks[to_hex(center)] = supported
        accent_centres[to_hex(center)] = center
        channel_rows = []
        for row in rows:
            values = lab[row][mask[row]]
            if len(values) < 3:
                continue
            # Presence-based: the emphasis colour is usually a minority inside each row, so a
            # per-row median would always read the main colour and never find the run.
            near = int((np.linalg.norm(values - center, axis=1) < 18.0).sum())
            if near >= max(2, int(0.02 * len(values))):
                channel_rows.append(row)
        if len(channel_rows) < max(1, int(len(rows) * 0.03)):
            continue
        height = max(1, rows[-1] - rows[0])
        runs.append({'color': to_hex(center),
                     'source': 'reference-glyphs',
                     'startLine': round((min(channel_rows) - rows[0]) / height, 2),
                     'endLine': round((max(channel_rows) - rows[0]) / height, 2),
                     'share': round(share, 3),
                     'evidence': {'share': round(share, 3), 'chroma': round(chroma, 1),
                                  'offBlend': round(off_blend, 1),
                                  'delta': round(total_delta, 1),
                                  'backgroundDistance': round(background_delta, 1),
                                  'confidence': round(min(.95,.55+.4*int(supported.sum())/max(1,int(extra.sum()))),3),
                                  'predictedGlyphOverlap': round(float((supported & glyph_core).sum()) / max(1,int(supported.sum())),3) if glyph_core is not None and glyph_core.shape==mask.shape else None}})
    # Intra-line different-colour evidence: for every accepted run colour, locate its horizontal
    # span inside each detected text line. Fractions are relative to that line's text width, so
    # the S7 renderer can map them onto characters without OCR.
    line_bands = []
    row_flags = mask.any(axis=1)
    start_row = None
    for row in range(len(row_flags)):
        if row_flags[row] and start_row is None:
            start_row = row
        elif not row_flags[row] and start_row is not None:
            if row - start_row >= 2:
                line_bands.append((start_row, row - 1))
            start_row = None
    if start_row is not None:
        line_bands.append((start_row, len(row_flags) - 1))
    centres = [(cluster[0], cluster) for cluster in clusters]
    if runs and line_bands:
        for run in runs:
            target = accent_centres.get(str(run['color']).lower())
            if target is None:
                # find the cluster centre whose hex equals the run colour
                for centre, _cluster in centres:
                    if to_hex(centre).lower() == str(run['color']).lower():
                        target = centre
                        break
            if target is None:
                continue
            spans = []
            for line_index, (row0, row1) in enumerate(line_bands):
                band_lab = lab[row0:row1 + 1]
                band_mask = mask[row0:row1 + 1]
                if band_mask.sum() < 20:
                    continue
                distances = np.linalg.norm(band_lab - target, axis=2)
                extra = (distances < 24.0) & band_mask & accent_masks[run['color']][row0:row1 + 1]
                if extra.sum() < max(6,0.02 * band_mask.sum()):
                    continue
                columns = np.where(extra.any(axis=0))[0]
                if len(columns) < 2:
                    continue
                text_columns = np.where(band_mask.any(axis=0))[0]
                if len(text_columns) < 4:
                    continue
                x0, x1 = float(text_columns[0]), float(text_columns[-1])
                width = max(1.0, x1 - x0)
                # Separate distant coloured fragments; do not paint the white
                # words between the first and last coloured pixel.
                cuts=[]
                for index in range(len(columns)-1):
                    left,right=columns[index],columns[index+1]
                    if right-left<=1:continue
                    gap=band_mask[:,left+1:right] & (np.linalg.norm(band_lab[:,left+1:right]-main,axis=2)<18.)
                    # Bridge empty space within/between accented glyphs, but
                    # never bridge intervening foreground of the main colour.
                    if right-left>size*.8 or int(gap.sum())>max(3,(right-left)*2):cuts.append(index+1)
                groups=np.split(columns,cuts)
                for group in groups:
                    if len(group)<2:continue
                    spans.append({'lineIndex': line_index,
                                  'startFraction': round((float(group[0]) - x0) / width, 3),
                                  'endFraction': min(1.,round((float(group[-1]) + 1 - x0) / width, 3)),
                                  'share': run.get('share'), 'evidence': run.get('evidence')})
            if spans:
                run['lineSpans'] = spans
    # Body paragraphs keep one emphasis colour; secondary titles (subtitle/heading/table-header)
    # may keep up to two spatially separated solid colours on the same line. Never a gradient.
    runs = rank_color_runs([run for run in runs if run.get('lineSpans')], color_run_limit(element))
    return {'key': element.get('key'), 'kind': 'body',
            'color': to_hex(main), 'role': role_of(element), 'gradient': None,
            'colorRuns': runs, 'confident': True, 'colorConfident': True, 'style': style}


# OpenCV converts 8-bit RGB to 8-bit Lab: L is 0..255 (not 0..100) and a/b are
# offset by 128. Keep the snap thresholds at the actual near-black/near-white ends
# of that scale (L* ~= 3.1/98.7). The previous 92/14 thresholds treated any grey
# lighter than ~36% lightness as white and lifted mid greys to #FFFFFF.
EXTREME_WHITE_LIGHTNESS = 252.0
EXTREME_BLACK_LIGHTNESS = 8.0
EXTREME_NEUTRAL_CHROMA = 4.0


def snap_extreme(value):
    """Only true near-white/near-black neutral fills become pure #FFFFFF/#000000."""
    text = str(value or '').lstrip('#')
    if len(text) != 6:
        return value
    try:
        lab = to_lab([int(text[index:index + 2], 16) for index in (0, 2, 4)])
    except Exception:
        return value
    lightness = float(lab[0])
    chroma = float(np.hypot(float(lab[1]) - 128.0, float(lab[2]) - 128.0))
    if lightness >= EXTREME_WHITE_LIGHTNESS and chroma <= EXTREME_NEUTRAL_CHROMA:
        return 'FFFFFF'
    if lightness <= EXTREME_BLACK_LIGHTNESS and chroma <= EXTREME_NEUTRAL_CHROMA:
        return '000000'
    return text.upper()


def main():
    global spec, image, surface_image, page_width, ratio, output
    spec = json.load(open(sys.argv[1], encoding='utf-8'))
    output = sys.argv[2]
    image = cv2.imread(spec['reference'])
    surface_image=cv2.imread(spec['surface']) if spec.get('surface') else None
    if surface_image is not None and image is not None:surface_image=cv2.resize(surface_image,(image.shape[1],image.shape[0]))
    if image is None:
        raise SystemExit('无法读取参考图：' + str(spec.get('reference')))
    page_width = float(spec.get('pageWidth') or 1600)
    ratio = image.shape[1] / page_width
    results = []
    targets=set(spec['targetKeys']) if spec.get('targetKeys') is not None else None
    size_keys = set(spec.get('uniformSizeKeys') or [])
    if size_keys:
        from uniform_text_size import measure_uniform_text_size
        logical_image = cv2.resize(image, (1600, 900), interpolation=cv2.INTER_AREA)
        masks = {m['key']: m.get('file') for m in spec.get('objectMasks', [])}
    for element in spec.get('elements') or []:
        if targets is not None and element.get('key') not in targets:continue
        if element.get('type') != 'text':
            continue
        try:
            row = analyse_text(element)
        except Exception as error:
            row = {'key': element.get('key'), 'error': str(error)[:200]}
        key = element.get('key')
        if key in size_keys and masks.get(key):
            row = row or {'key': key, 'confident': False}
            try:
                measurement = measure_uniform_text_size(element, masks[key], logical_image, element['x'], element['y'])
                if measurement:
                    row['uniformTextSize'] = measurement
            except (ValueError, OSError, cv2.error) as error:
                row['sizeError'] = str(error)[:200]
        if row:
            # Audit weight/slant is explicit evidence; weak stroke statistics must not clear it.
            row['auditStyle'] = {'bold': element.get('bold') is True, 'italic': element.get('italic') is True}
            results.append(row)
    ratios = [row['style']['thicknessRatio'] for row in results
              if row.get('style') and row.get('kind') == 'body' and row['style'].get('thicknessRatio')]
    page_median_ratio = float(np.median(ratios)) if ratios else 0.0
    for row in results:
        style = row.get('style')
        audit = row.pop('auditStyle', None) or {}
        if not style:
            continue
        measured = {'thicknessRatio': style.get('thicknessRatio'), 'skew': style.get('skew'),
                    'slopeSamples': style.get('slopeSamples'), 'boldSpans': style.get('boldSpans'),
                    'wideBoldRun': style.get('wideBoldRun')}
        decision = merge_style(audit, measured, page_median_ratio)
        row['bold'] = decision['bold']
        row['italic'] = decision['italic']
        row['styleConfidence'] = decision['styleConfidence']
        if style.get('boldSpans') and decision['bold']:
            row['boldSpans'] = style['boldSpans']
        row['styleEvidence'] = style
    for row in results:
        if row.get('error'):
            continue
        row['color'] = snap_extreme(row.get('color'))
        gradient = row.get('gradient')
        if isinstance(gradient, dict):
            for stop in gradient.get('stops') or []:
                stop['color'] = snap_extreme(stop.get('color'))
        for run in row.get('colorRuns') or []:
            run['color'] = snap_extreme(run.get('color'))
    json.dump({'results': results}, open(output, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps({'status': 'available', 'texts': len(results)}))


if __name__ == '__main__':
    main()
