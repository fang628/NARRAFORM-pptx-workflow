"""Conservative measurements of navigation surfaces and exterior soft effects.

Only horizontal, unobstructed interior bands are used. Effect parameters are
estimates from a flattened image; missing/occluded states remain unobservable.
"""
import math
import numpy as np


def hexa(value):
    return '%02X%02X%02X' % tuple(np.clip(np.round(value), 0, 255).astype(int))


def gradient_fit(pixels):
    h, w = pixels.shape[:2]
    if h < 16 or w < 24:
        return None, {'status': 'unobservable', 'reason': 'interior-too-small'}
    lo, hi = round(h*.19), round(h*.81)
    ys = np.arange(lo, hi)/max(1, h-1)
    bands = [np.median(b, axis=1) for b in np.array_split(pixels[lo:hi], 3, axis=1)]
    profile = np.median(bands, axis=0)
    design = np.column_stack((np.ones(len(ys)), ys))
    keep = np.ones(len(ys), dtype=bool)
    for _ in range(3):
        coef = np.linalg.lstsq(design[keep], profile[keep], rcond=None)[0]
        errors = np.max(np.abs(profile-design@coef), axis=1)
        keep = errors <= max(3, float(np.median(errors))*2.5)
        if keep.mean() < .7:
            return None, {'status': 'unobservable', 'reason': 'text-or-texture'}
    # Require independent horizontal bands to agree on the vertical trend.
    slopes = [np.linalg.lstsq(design[keep], band[keep], rcond=None)[0][1] for band in bands]
    agreement = sum(np.linalg.norm(s-coef[1]) <= max(6, np.linalg.norm(coef[1])*.3) for s in slopes)/3
    train = keep & (np.arange(len(ys)) % 2 == 0)
    hold = keep & ~train
    if not hold.any():
        return None, {'status': 'unobservable', 'reason': 'insufficient-rows'}
    linear = np.linalg.lstsq(design[train], profile[train], rcond=None)[0]
    error = float(np.sqrt(np.mean((profile[hold]-design[hold]@linear)**2)))
    delta = float(np.linalg.norm(coef[1]))
    evidence = {'status': 'absent', 'delta': round(delta, 2), 'rmse': round(error, 2), 'bandAgreement': round(agreement, 2)}
    if delta < 10 and error <= 3.5:
        return None, evidence
    if error > 3.5 or agreement < .99:
        return None, {**evidence, 'status': 'unobservable', 'reason': 'nonlinear-or-horizontal-surface'}
    return {'type': 'linear', 'angle': 90, 'stops': [
        {'position': 0, 'color': hexa(coef[0]), 'opacity': 1},
        {'position': 1, 'color': hexa(coef.sum(axis=0)), 'opacity': 1}]}, {**evidence, 'status': 'present'}


def exterior_fit(image, x0, x1, y, h, scale):
    """Estimate symmetric light tails and vertically offset dark tails.

    A hard stroke is excluded by a three-pixel guard. Texture, clipped overscan,
    mixed light/dark tails and unsupported horizontal offsets are not guessed.
    """
    radius = max(12, round(30*scale))
    guard = max(2, round(3*scale))
    evidence = {'Shadow': {'status': 'unobservable', 'reason': 'clipped-overscan'}}
    if y-radius < 0 or y+h+radius >= image.shape[0]:
        return {}, evidence
    distances = np.arange(guard, radius+1, dtype=float)
    strips = [image[np.round(y-distances).astype(int), x0:x1],
              image[np.round(y+h-1+distances).astype(int), x0:x1]]
    profiles = np.array([np.median(strip, axis=1) for strip in strips])
    # Measure a local background separately above/below, including its trend.
    far = distances >= radius*.73
    design = np.column_stack((np.ones(len(distances)), distances))
    baselines = []; noise = []; support = []
    for strip, profile in zip(strips, profiles):
        coef = np.linalg.lstsq(design[far], profile[far], rcond=None)[0]
        baseline = design@coef
        baselines.append(baseline)
        noise.append(float(np.sqrt(np.mean((profile[far]-baseline[far])**2))))
        support.append(float(np.median(np.std(strip[far], axis=1))))
        if np.max(np.abs(coef[1])) > .45/scale:
            return {}, {k: {'status': 'unobservable', 'reason': 'background-trend'} for k in evidence}
    if max(noise) > 2 or max(support) > 6:
        return {}, {k: {'status': 'unobservable', 'reason': 'background-texture'} for k in evidence}
    baseline = np.array(baselines)
    residual = profiles-baseline
    # Separate horizontal bands must see the same exterior tail.
    bands = [np.array([np.median(b, axis=1) for b in np.array_split(strip, 3, axis=1)]) for strip in strips]
    disagreement = max(float(np.median(np.abs(b-profile))) for b, profile in zip(bands, profiles))
    if disagreement > 3:
        return {}, {k: {'status': 'unobservable', 'reason': 'exterior-obstructed'} for k in evidence}
    luma = residual@np.array([.2126, .7152, .0722])
    evidence = {k: {'status': 'absent', 'noise': round(max(noise), 2)} for k in evidence}
    effects = {}
    # Only dark exterior tails can become a native shadow.
    light = np.maximum(luma, 0)
    dark = np.maximum(-luma, 0)
    if light.max() >= 4 and dark.max() >= 4:
        return {}, {k: {'status': 'unobservable', 'reason': 'mixed-effects-or-background'} for k in evidence}
    if light.max() >= dark.max():return {}, evidence
    signal = dark
    if signal.max() < 4:
        return {}, evidence
    kind = 'Shadow'
    if max((s > 3).sum() for s in signal) < max(3, round(2*scale)):
        evidence[kind] = {'status': 'unobservable', 'reason': 'hard-edge'}
        return {}, evidence
    best = None
    offsets = np.arange(-8, 8.1, 1)*scale
    for sigma in np.arange(1, 6.1, .5)*scale:
        for offset in offsets:
            tails = np.array([[.5*math.erfc((d+offset)/(math.sqrt(2)*sigma)) for d in distances],
                              [.5*math.erfc((d-offset)/(math.sqrt(2)*sigma)) for d in distances]])
            denom = float(np.sum(tails*tails))
            if denom < 1e-8:
                continue
            amplitude = float(np.sum(signal*tails)/denom)
            error = float(np.sqrt(np.mean((signal-amplitude*tails)**2)))
            if best is None or error < best[0]:
                best = (error, sigma, offset, amplitude, tails)
    error, sigma, offset, amplitude, tails = best
    energy = float(np.sqrt(np.mean(signal**2)))
    if error > max(1.2, energy*.22):
        evidence[kind] = {'status': 'unobservable', 'reason': 'non-soft-tail', 'rmse': round(error, 2)}
        return {}, evidence
    coefficient = np.sum(residual*tails[:, :, None], axis=(0, 1))/np.sum(tails*tails)
    bg = np.mean(baseline, axis=(0, 1))
    ratios = -coefficient/np.maximum(bg, 1)
    usable = bg > 20
    if not usable.any() or np.std(ratios[usable]) > .12:
        evidence[kind] = {'status': 'unobservable', 'reason': 'colored-or-low-contrast-shadow'}
        return {}, evidence
    params = {'type': 'outer', 'color': '000000', 'opacity': round(min(1, float(np.median(ratios[usable]))), 3),
              'blur': round(min(12, sigma*2/scale), 2), 'offset': round(abs(offset)/scale, 2), 'angle': 90 if offset >= 0 else 270}
    effects[kind] = params
    evidence[kind] = {'status': 'present', 'rmse': round(error, 2), 'estimated': True,
                      'scope': 'horizontal-edge-profile', 'parameterAmbiguity': 'color-opacity-from-flattened-image'}
    return effects, evidence


def observed_effects(image, box, count, active):
    effects = {}; evidence = {}; measured = {}
    if not 1 <= count <= 12 or not 0 <= active < count:
        return effects, {'status': 'unobservable', 'reason': 'missing-state-map'}
    pixels = np.asarray(image.convert('RGB'), dtype=float)
    x, y, w, h = [round(v) for v in box]
    for index in range(count):
        state = 'active' if index == active else 'completed' if index < active else 'track'
        x0 = max(0, round(x+(index+.24)*w/count)); x1 = min(image.width, round(x+(index+.76)*w/count))
        if x1-x0 < 24 or h < 16 or y < 0 or y+h > image.height:
            continue
        gradient, ge = gradient_fit(pixels[y:y+h, x0:x1])
        outer, ee = exterior_fit(pixels, x0, x1, y, h, image.width/1600)
        values = {'Gradient': gradient, 'Shadow': outer.get('Shadow')}
        checks = {'Gradient': ge, **ee}
        measured.setdefault(state, []).append((values, checks))
    for state in ('track', 'completed', 'active'):
        rows = measured.get(state, [])
        for kind in ('Gradient', 'Shadow'):
            key = state+kind
            if not rows:
                evidence[key] = {'status': 'unobservable', 'reason': 'state-not-visible'}
                continue
            statuses = [checks[kind]['status'] for _, checks in rows]
            if len(set(statuses)) != 1:
                evidence[key] = {'status': 'unobservable', 'reason': 'segments-disagree', 'segments': statuses}
                continue
            selected=min(rows,key=lambda row:row[1][kind].get('rmse',99))
            evidence[key] = selected[1][kind]
            if statuses[0] == 'present':
                # Do not share one state's effect with another state.
                effects[key] = selected[0][kind]
            elif statuses[0] == 'absent' and kind != 'Gradient':
                effects[key] = None
    return effects, evidence
