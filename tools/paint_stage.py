#!/usr/bin/env python
"""S4 fill / S5 stroke measurement stage (mask-aware, budgeted, committed paint fitting).

Spec JSON:
  {reference,
   elements:[...],
   targetKeys:[...],
   background?,
   exclude?:[{x,y,w,h}],
   masks?:[{key, file, predicted?, unavailable?}],   # per-object predicted alpha PNG
   underlays?:{key: absolutePngPath}}                 # lower-layer composite below an object

Output JSON:
  {status, results:[{key, status, properties, paintKeys, confidence, diagnostics,
                     elapsedMs, visiblePixels, candidates, gain, reasons}], stats}

Sampling contract (05 paint quality):
  - the S3 polygon only defines the search ROI; the measured interior comes from the
    per-object predicted alpha mask (`masks`), eroded away from its antialiased boundary;
  - objects painted *after* the target are front occluders: their predicted alpha is
    unioned into one front mask, so text / formula / icons painted above a block are never
    sampled as its fill. Objects painted *before* the target are behind it and stay valid;
  - text / icon masks replace the old whole-box exclusion when masks are available, which is
    what stops a small text box from erasing a real fill region;
  - a translucent object is de-mixed against its `underlays` composite. When there is no
    trustworthy lower composite the original parameters are kept and reported uncertain;
    the wordless page background is never used to de-mix transparency;
  - per-object candidate count and wall clock are bounded in paint_models; a rejected or
    budget-exhausted fit keeps the original parameters and reports why.

Geometry is owned by S3: this stage only reports paint properties.
"""
import json
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, __file__.rsplit('\\', 1)[0] if '\\' in __file__ else __file__.rsplit('/', 1)[0])
from shape_reference import image, seed_polygon, hex_color
from shape_paint import fit_shape_paint
from native_effects import detect_native_effects,without_soft_exterior

SCENE = (1600, 900)
PAINT_TYPES = ('shape', 'rect', 'ellipse','line')
MASK_SUPPORT = 8
ALPHA_EPS = 1e-6


def paint_color(value):
    """'#RRGGBB' / 'RRGGBB' / 'rgb(r,g,b)' / sequence -> 'RRGGBB', else None."""
    if isinstance(value, str):
        text = value.strip()
        if text.startswith('#') or len(text) == 6:
            text = text.lstrip('#')
            try:
                int(text, 16)
            except (ValueError, TypeError):
                return None
            return text.upper() if len(text) == 6 else None
        if text.lower().startswith('rgb'):
            digits = text[text.find('(') + 1:text.rfind(')')].replace('%', '').split(',')
            try:
                channels = [int(round(float(channel.strip()))) for channel in digits[:3]]
            except (TypeError, ValueError):
                return None
            if len(channels) != 3:
                return None
            return ''.join(f'{max(0, min(255, channel)):02X}' for channel in channels)
        return None
    if value is None:
        return None
    try:
        return hex_color(value)
    except Exception:
        return None


def pixel_box(values):
    try:
        bx, by, bw, bh = (float(value) for value in values)
    except (TypeError, ValueError):
        return None
    if not all(np.isfinite(value) for value in (bx, by, bw, bh)) or bw <= 2 or bh <= 2:
        return None
    return [int(round(bx)), int(round(by)), int(round(bx + bw)), int(round(by + bh))]


def element_box(element):
    return pixel_box([element.get(name, 0) for name in ('x', 'y', 'w', 'h')])


def _load_alpha(path, shape):
    """Predicted object alpha (0..255); None when the mask file is unusable.

    Per-object masks are rendered as an isolated scene object (transparent canvas), so their
    PNG alpha channel is the predicted coverage and can be used directly as visibility
    evidence. An empty render is not evidence and is dropped.
    """
    try:
        from PIL import Image
        with Image.open(path) as source:
            source.load()
            rgba = np.asarray(source.convert('RGBA').resize((shape[1], shape[0]),
                                                            Image.Resampling.BILINEAR))
    except Exception:
        return None
    if rgba.ndim != 3 or rgba.shape[2] < 4:
        return None
    alpha = np.ascontiguousarray(rgba[..., 3])
    # Masks are rendered as an isolated scene object (transparent canvas), so the alpha
    # channel is coverage. An empty render is not evidence and is dropped.
    if int(alpha.max()) < 16:
        return None
    return alpha


def _load_rgb(path, shape):
    try:
        from PIL import Image
        with Image.open(path) as source:
            source.load()
            return np.asarray(source.convert('RGB').resize((shape[1], shape[0]),
                                                            Image.Resampling.LANCZOS))
    except Exception:
        return None


def _alpha_value(value, default=1.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if np.isfinite(number) else default


def _paint_translucent(paint):
    if not isinstance(paint, dict):
        return False
    for stop in paint.get('stops') or []:
        if isinstance(stop, dict) and _alpha_value(stop.get('opacity', 1)) < .98 - ALPHA_EPS:
            return True
    return False


def element_translucency(element):
    """(fill translucent, stroke translucent) from the committed paint parameters."""
    opacity = _alpha_value(element.get('opacity', 1))
    fill = (opacity * _alpha_value(element.get('fillOpacity', 1)) < .98 - ALPHA_EPS
            or _paint_translucent(element.get('gradient')))
    stroke = (opacity * _alpha_value(element.get('colorOpacity', 1)) < .98 - ALPHA_EPS
              or _paint_translucent(element.get('strokeGradient')))
    return fill, stroke


def legacy_excluded(element):
    """Whole-box exclusion used when no per-object masks were supplied."""
    kind = str(element.get('type') or '')
    managed = str(element.get('managed') or '')
    role = str(element.get('role') or '')
    return (kind in ('text', 'image', 'line', 'table', 'formula')
            or managed in ('progress', 'footer')
            or role in ('navigation', 'formula'))


def main():
    started_all = time.monotonic()
    spec = json.load(open(sys.argv[1], encoding='utf-8'))
    out_path = sys.argv[2]
    ref = image(spec['reference'], SCENE)
    page_height, page_width = ref.shape[:2]
    page_background = image(spec['background'], SCENE) if spec.get('background') else None
    elements = [{**element,'_verticalGradientOnly':True} for element in (spec.get('elements') or []) if isinstance(element, dict)]
    target_keys = spec.get('targetKeys')
    target_set = set(target_keys) if target_keys is not None else None

    mask_files = {}
    raw_masks = spec.get('masks') or []
    if isinstance(raw_masks, dict):
        # Tolerated convenience form; the committed adapter sends [{key, file}].
        raw_masks = [{'key': key, 'file': file} for key, file in raw_masks.items()]
    for entry in raw_masks:
        if not isinstance(entry, dict) or entry.get('unavailable'):
            continue
        key, file = entry.get('key'), entry.get('file')
        if isinstance(key, str) and key and file:
            mask_files[key] = file
    underlays = spec.get('underlays') if isinstance(spec.get('underlays'), dict) else {}
    use_masks = bool(mask_files)

    exclude_global = []
    for box in spec.get('exclude') or []:
        if isinstance(box, dict):
            pixel = pixel_box([box.get(name, 0) for name in ('x', 'y', 'w', 'h')])
            if pixel:
                exclude_global.append(pixel)
    if not use_masks:
        for element in elements:
            # Skipped staged objects are still rendered into the page, so in legacy box mode
            # they must occlude lower targets exactly like any other foreground object.
            if element.get('_stagedSkip') or legacy_excluded(element):
                pixel = element_box(element)
                if pixel:
                    exclude_global.append(pixel)
    # Program chrome (progress bar / footer page number) is never part of a fitted interior,
    # whatever its position in the stacking order.
    for element in elements:
        managed = str(element.get('managed') or '')
        if managed in ('progress', 'footer') or str(element.get('role') or '') == 'navigation':
            pixel = element_box(element)
            if pixel:
                exclude_global.append(pixel)

    def is_target(element):
        if element.get('_stagedSkip'):
            # _stagedSkip only suppresses measurement of that object. It stays in the scene
            # and therefore occludes lower targets (handled by the front mask below).
            return False
        if str(element.get('managed') or ''):
            return False
        if element.get('tableFittedFill') and not (float(element.get('strokeWidth') or 0)>=.7 or element.get('strokeGradient')):
            return False
        if element.get('type') not in PAINT_TYPES:
            return False
        key = element.get('key')
        if not isinstance(key, str) or not key:
            return False
        return target_set is None or key in target_set

    def measure(element, own_alpha, front_alpha, front_boxes):
        started = time.monotonic()
        key = element.get('key')
        detail = {'fill': {}, 'stroke': {}, 'sampling': {},
                  'masks': {'self': own_alpha is not None,
                            'front': front_alpha is not None,
                            'frontBoxes': len(front_boxes)}}
        row = {'key': key}
        polygon = seed_polygon(element)
        if element.get('type')=='line':
            lower=_load_rgb(underlays.get(key),(page_height,page_width)) if underlays.get(key) else None
            props,evidence=detect_native_effects(ref,element,lower,front_alpha,list(exclude_global)+list(front_boxes),own_alpha)
            return {'key':key,'status':'fitted' if props else 'kept','properties':{**props,'nativeEffectEvidence':evidence},'diagnostics':{'effects':evidence}}
        if not polygon:
            row.update({'status': 'unsupported', 'reason': 'no-seed-polygon', 'properties': {},
                        'paintKeys': [], 'confidence': None, 'diagnostics': detail,
                        'elapsedMs': 0.0, 'visiblePixels': 0, 'candidates': 0, 'gain': {},
                        'reasons': ['no-seed-polygon']})
            return row
        contour = np.rint(np.asarray(polygon, float)).astype(np.int32).reshape(-1, 1, 2)
        if own_alpha is not None and not element.get('glow') and not element.get('shadow') and float(element.get('opacity',1))*float(element.get('fillOpacity',1))>=.98:
            rendered_contours=cv2.findContours((own_alpha>=128).astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_NONE)[0]
            if rendered_contours:contour=max(rendered_contours,key=cv2.contourArea)

        fill_translucent, stroke_translucent = element_translucency(element)
        underlay = None
        underlay_source = None
        file = underlays.get(key) if isinstance(key, str) else None
        if file:
            underlay = _load_rgb(file, (page_height, page_width))
            if underlay is not None:
                underlay_source = 'underlay'
        if underlay is None and not fill_translucent:
            underlay = page_background
            underlay_source = 'page-background' if page_background is not None else None
        if fill_translucent and underlay is None:
            detail['underlayMissing'] = True
        detail['underlay'] = underlay_source

        fit_element = element
        if stroke_translucent and underlay_source != 'underlay':
            # The outer half of a translucent stroke sits on lower layers; without the lower
            # composite its colour cannot be de-mixed, so keep the audited stroke parameters.
            detail['stroke']['skippedReason'] = 'underlay-missing-for-translucent-stroke'
            fit_element = {**element, 'colorOpacity': 0}

        effects,effect_evidence=detect_native_effects(ref,element,underlay if underlay_source=='underlay' else None,
                                                     front_alpha,list(exclude_global)+list(front_boxes),own_alpha)
        clean_reference=without_soft_exterior(ref,element,underlay,effects,own_alpha)

        try:
            paint = fit_shape_paint(clean_reference, contour, fit_element,
                                    list(exclude_global) + list(front_boxes), front_alpha,
                                    diagnostics=detail, background=underlay,
                                    visible_alpha=own_alpha)
        except Exception as error:  # one bad element must not break the page
            row.update({'status': 'error', 'error': str(error)[:200], 'properties': {},
                        'paintKeys': [], 'confidence': None, 'diagnostics': detail,
                        'elapsedMs': round((time.monotonic() - started) * 1000, 1),
                        'visiblePixels': 0, 'candidates': 0, 'gain': {},
                        'reasons': ['error']})
            return row
        if not isinstance(paint, dict):
            paint = {}

        properties = {}
        fill = paint.get('fill')
        solid = paint.get('solidFill')
        if isinstance(fill, dict) and fill.get('gradient'):
            properties['gradient'] = fill['gradient']
        if isinstance(solid, dict) and solid.get('color') is not None:
            color = paint_color(solid['color'])
            if color:
                properties['fill'] = color
                properties['gradient'] = None
        stroke = paint.get('stroke')
        outline = paint.get('outline')
        audit_width = _alpha_value(element.get('strokeWidth'), 0.0)
        stroke_kind = str(element.get('strokeKind') or '')
        if isinstance(stroke, dict) and stroke.get('gradient'):
            properties['strokeGradient'] = stroke['gradient']
        if isinstance(outline, dict) and float(outline.get('confidence') or 0) >= 0.9:
            if outline.get('presence') == 'absent':
                # Only clear a stroke the audit itself does not claim. A real audited stroke
                # that the normal profile cannot see (soft glow, very low contrast) keeps its
                # parameters instead of being erased.
                if audit_width < .8 and stroke_kind not in ('stroke', 'glow'):
                    properties.update({'strokeWidth': 0, 'strokeGradient': None, 'colorOpacity': 0})
            else:
                measured_width = outline.get('width')
                if audit_width >= .3:
                    # Keep the audited width; the measured profile refreshes the colour only.
                    properties['strokeWidth'] = round(float(audit_width), 3)
                elif measured_width and .4 <= float(measured_width) <= 6 and stroke_kind in ('', 'stroke', 'unknown'):
                    properties['strokeWidth'] = round(float(measured_width), 3)
                if not element.get('strokeGradient') and outline.get('color'):
                    color = paint_color(outline['color'])
                    if color:
                        properties['color'] = color
        stroke_solid = paint.get('strokeSolid')
        if isinstance(stroke_solid, dict) and stroke_solid.get('color') is not None:
            color = paint_color(stroke_solid['color'])
            if color and 'color' not in properties:
                properties['color'] = color
                properties['strokeGradient'] = None
        properties.update(effects)
        properties['nativeEffectEvidence']=effect_evidence
        detail['effects']=effect_evidence
        effective_glow=effects.get('glow',element.get('glow'))
        effective_shadow=effects.get('shadow',element.get('shadow'))
        if effective_shadow and not effective_glow:
            properties.update(strokeWidth=0,strokeGradient=None,colorOpacity=0)
        # Independent ridge evidence (normal-profile median colour) must agree with the fitted
        # stroke gradient. A fit that drifts to the dark fill/background while the actual rim is
        # bright is not a stroke measurement; keep the audited stroke parameters instead.
        if properties.get('strokeGradient') and isinstance(outline, dict) and outline.get('color'):
            ridge_color = paint_color(outline['color'])
            fitted_stops = [paint_color(stop.get('color')) for stop in properties['strokeGradient'].get('stops') or []
                            if isinstance(stop, dict)]
            fitted_stops = [value for value in fitted_stops if value]
            if ridge_color and fitted_stops:
                measured_rgb = np.asarray([[int(value[i:i + 2], 16) for i in (0, 2, 4)] for value in fitted_stops], float)
                ridge_rgb = np.asarray([int(ridge_color[i:i + 2], 16) for i in (0, 2, 4)], float)
                # The normal-profile median ridge colour must land inside the fitted stroke
                # gradient's colour range; a dark fit for a bright rim is not a measurement.
                if float(np.min(np.linalg.norm(measured_rgb - ridge_rgb, axis=1))) > 110:
                    properties.pop('strokeGradient', None)
                    detail.setdefault('stroke', {})['consistencyRejected'] = 'fitted-stroke-far-from-ridge-colour'

        sampling = detail.get('sampling') if isinstance(detail.get('sampling'), dict) else {}
        fill_detail = detail.get('fill') if isinstance(detail.get('fill'), dict) else {}
        stroke_detail = detail.get('stroke') if isinstance(detail.get('stroke'), dict) else {}

        def gain_of(item):
            if not isinstance(item, dict):
                return None
            before, after = item.get('beforeError'), item.get('afterError')
            if not isinstance(before, (int, float)) or not isinstance(after, (int, float)):
                return None
            return {'beforeError': round(float(before), 3), 'afterError': round(float(after), 3),
                    'delta': round(float(before) - float(after), 3),
                    'confidence': item.get('confidence'),
                    'kind': (item.get('gradient') or {}).get('type') if isinstance(item.get('gradient'), dict) else None}

        gains = {}
        for name, item in (('fill', fill_detail), ('stroke', stroke_detail)):
            gain = gain_of(item)
            if gain:
                gains[name] = gain

        confidences = [float(item['confidence']) for item in (fill_detail, stroke_detail)
                       if isinstance(item.get('confidence'), (int, float))]
        candidates = int(fill_detail.get('candidatesEvaluated') or 0) + int(stroke_detail.get('candidatesEvaluated') or 0)
        visible = int(sampling.get('visiblePixels') or 0)

        reasons = []
        if detail.get('underlayMissing'):
            reasons.append('underlay-missing-for-translucent-fill')
        for name in ('fill', 'stroke'):
            reason = (detail.get(name) or {}).get('reason')
            if reason:
                reasons.append(f'{name}:{reason}')
        if isinstance(detail.get('stroke'), dict) and detail['stroke'].get('skippedReason'):
            reasons.append('stroke:' + detail['stroke']['skippedReason'])
        if isinstance(detail.get('stroke'), dict) and detail['stroke'].get('consistencyRejected'):
            reasons.append('stroke:inconsistent-with-ridge')

        measured_paint = any(properties.get(name) is not None for name in ('fill', 'gradient', 'strokeGradient', 'color','glow','shadow'))
        if detail.get('underlayMissing') and not measured_paint:
            status = 'uncertain-kept'
        elif measured_paint:
            status = 'fitted'
        elif sampling.get('reason') == 'insufficient-visible-samples':
            status = 'insufficient-visible'
        elif sampling.get('mostlyOccluded'):
            status = 'occluded-kept'
        else:
            status = 'kept'

        row.update({'key': key, 'status': status, 'properties': properties,
                    'paintKeys': sorted(paint.keys()),
                    'confidence': round(float(np.mean(confidences)), 4) if confidences else None,
                    'diagnostics': detail,
                    'elapsedMs': round((time.monotonic() - started) * 1000, 1),
                    'visiblePixels': visible, 'candidates': candidates, 'gain': gains,
                    'reasons': sorted(set(reasons))})
        return row

    measured = {}
    front_alpha = None
    front_boxes = []
    kernel = np.ones((3, 3), np.uint8)
    # Walk top-down so the accumulated front mask always means "painted after this object".
    # Every rendered object participates: _stagedSkip objects are not measured (is_target
    # rejects them) but they are still drawn on the page and must occlude lower targets.
    for position in range(len(elements) - 1, -1, -1):
        element = elements[position]
        key = element.get('key')
        own_alpha = None
        if use_masks and isinstance(key, str) and key in mask_files:
            own_alpha = _load_alpha(mask_files[key], (page_height, page_width))
        if is_target(element):
            measured[key] = measure(element, own_alpha, front_alpha, list(front_boxes))
        if own_alpha is not None:
            grown = cv2.dilate(own_alpha, kernel, iterations=1)
            if front_alpha is None:
                front_alpha = grown
            else:
                np.maximum(front_alpha, grown, out=front_alpha)
        elif use_masks:
            pixel = element_box(element)
            if pixel:
                front_boxes.append(pixel)

    ordered = []
    seen = set()
    for element in elements:
        key = element.get('key')
        if isinstance(key, str) and key in measured and key not in seen:
            seen.add(key)
            ordered.append(measured[key])

    fitted = sum(1 for row in ordered if row.get('status') == 'fitted')
    payload = {'status': 'available', 'results': ordered,
               'stats': {'targets': len(ordered), 'fitted': fitted,
                         'kept': len(ordered) - fitted,
                         'masks': len(mask_files), 'underlays': len([key for key in underlays if key]),
                         'elapsedMs': round((time.monotonic() - started_all) * 1000, 1)}}
    if spec.get('samplesFile'):
        from paint_consensus import sample_members, save_samples
        patches={row['key']:row.get('properties') or {} for row in ordered}
        fitted_elements=[{**element,**patches.get(element['key'],{})} for element in elements]
        save_samples(spec['samplesFile'],sample_members(fitted_elements,ref,mask_files,underlays))
        payload['samplesFile']=spec['samplesFile']
    json.dump(payload, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps({'status': 'available', 'measured': len(ordered), 'fitted': fitted}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
