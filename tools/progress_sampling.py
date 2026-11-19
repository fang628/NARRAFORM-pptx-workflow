"""Measure paint inside the same segment contours used for placement."""
import cv2
import numpy as np

from progress_effects import exterior_fit, gradient_fit, hexa


STATES = ('track', 'completed', 'active')
FILL = dict(zip(STATES, ('track', 'completedFill', 'accent')))
INK = dict(zip(STATES, ('muted', 'completedInk', 'indicatorInk')))
BORDER = dict(zip(STATES, ('border', 'completedBorder', 'activeBorder')))


def region(pixels, shape):
    height, width = pixels.shape[:2]
    polygon = np.array(shape['polygon']) * [width, height]
    polygon = np.round(polygon).astype(np.int32)
    left, top, w, h = cv2.boundingRect(polygon)
    x, y = max(0, left), max(0, top)
    w, h = max(0, min(left+w, width)-x), max(0, min(top+h, height)-y)
    mask = np.zeros((h, w), np.uint8)
    if w and h:
        cv2.fillPoly(mask, [polygon-[x, y]], 1)
    return x, y, pixels[y:y+h, x:x+w], mask


def glyph_ink(patch, inside, surface, residual):
    h, w = inside.shape
    glyph = inside & (residual >= 14)
    glyph[:round(h*.16)] = glyph[round(h*.84):] = False
    # Keep left-aligned text while excluding the chevron seams.
    inset = min(round(w*.1), round(h*.45))
    glyph[:, :inset] = glyph[:, w-inset:] = False
    brighter = (patch-surface[:, None]) @ np.array([.2126, .7152, .0722]) >= 0
    cores = []
    for polarity in (brighter, ~brighter):
        count, labels, stats, _ = cv2.connectedComponentsWithStats((glyph & polarity).astype(np.uint8))
        for i in range(1, count):
            x, y, width, height, area = stats[i]
            if area < 3 or not 3 <= height <= h*.66 or width >= w-2*inset:
                continue
            # Find the solid part per glyph, so a stronger seam cannot set
            # the residual threshold for the rest of the label.
            box = np.s_[y:y+height, x:x+width]
            component = labels[box] == i
            strength = residual[box]
            core = component & (strength >= np.quantile(strength[component], .75))
            cores.append(patch[box][core])
    if not cores:
        return None
    ink_pixels = np.concatenate(cores)
    if len(ink_pixels) < 12:
        return None
    bins, counts = np.unique(np.round(ink_pixels/10).astype(int), axis=0, return_counts=True)
    peak = bins[counts.argmax()] * 10
    near = np.max(np.abs(ink_pixels-peak), axis=1) < 14
    if near.sum() >= 12 and near.mean() >= .28:
        return hexa(np.median(ink_pixels[near], axis=0))
    return None


def interior(patch, mask):
    h, w = mask.shape
    if h < 12 or w < 20:
        return None
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    inside = cv2.erode(mask, kernel, borderType=cv2.BORDER_CONSTANT, borderValue=0).astype(bool)
    profiles = []
    for row, valid in zip(patch, inside):
        sample = row[valid]
        profiles.append(np.median(sample, axis=0) if len(sample) >= 8 else None)
    rows = np.array([i for i, profile in enumerate(profiles) if profile is not None])
    if len(rows) < h*.55 or w < 20:
        return None
    colours = np.array([profiles[i] for i in rows])
    surface = np.stack([np.interp(np.arange(h), rows, c) for c in colours.T], axis=1)
    # Fill statistics and glyph analysis share the robust scanline background.
    residual = np.max(np.abs(patch-surface[:, None]), axis=2)
    clean = inside & (residual <= 12)
    clean[:round(h*.15)] = clean[round(h*.85):] = False
    fill = np.median(patch[clean], axis=0) if clean.sum() >= 24 else None
    return fill, glyph_ink(patch, inside, surface, residual), clean, surface


def unmix_surface(patch, background, clean):
    # With the registered underlay, variation within a row identifies alpha
    # independently of a possible vertical colour ramp. Verify on held-out columns.
    ys, xs = np.nonzero(clean)
    if len(ys) < 120:
        return None
    source, underlay = patch[ys, xs], background[ys, xs]
    train = xs % 3 != 0
    centered = []
    for y in np.unique(ys):
        ix = (ys == y) & train
        if ix.sum() >= 8:
            b, s = underlay[ix], source[ix]
            centered.append((b-b.mean(axis=0), s-s.mean(axis=0)))
    if not centered:
        return None
    b, s = [np.concatenate(items) for items in zip(*centered)]
    if np.sqrt(np.mean(b*b)) < 4:
        return None
    transmission = float(np.sum(b*s)/np.sum(b*b))
    if not .07 < transmission < .85:
        return None
    errors = []
    for y in np.unique(ys):
        row = ys == y
        a, c = row & train, row & ~train
        if a.sum() >= 8 and c.any():
            ref = np.median(source[a]-transmission*underlay[a], axis=0)
            base = np.median(source[a], axis=0)
            errors.append(np.array([np.mean(np.abs(source[c]-ref-transmission*underlay[c])),
                                    np.mean(np.abs(source[c]-base))]))
    if len(errors) < 8:
        return None
    error, opaque_error = np.median(errors, axis=0)
    if error > 3 or error > .70*opaque_error:
        return None
    recovered = (patch-transmission*background)/(1-transmission)
    sample = recovered[clean]
    if np.mean(np.any((sample < -7) | (sample > 262), axis=1)) > .05:
        return None
    return round(1-transmission, 3)


def outline(pixels, x, y, w, h, *, shared=False):
    h_image = len(pixels)
    a, b = x+round(w*.27), x+round(w*.73)
    scale = pixels.shape[1]/1600
    span = max(4, round(5*scale))
    strips = []
    for edge, direction in ((y, 1), (y+h-1, -1)):
        rows = edge + direction*np.arange(-span, span+1)
        if rows.min() < 0 or rows.max() >= h_image or b-a < 16:
            return None
        strip = pixels[rows, a:b]
        profile = np.median(strip, axis=1)
        if shared:
            outer = np.median(strip[:2], axis=0)
            inner = np.median(strip[-2:], axis=0)
            dist = np.median(np.minimum(np.linalg.norm(strip-outer, axis=2), np.linalg.norm(strip-inner, axis=2)), axis=1)
        else:
            # An antialiased fill edge lies between the two surfaces in RGB.
            # A separate stroke must depart from that colour transition.
            delta = profile[-1]-profile[0]
            t = np.clip((profile-profile[0])@delta/max(1, delta@delta), 0, 1)
            dist = np.linalg.norm(profile-profile[0]-t[:, None]*delta, axis=1)
        peak = int(dist.argmax())
        if dist[peak] < 13:
            return None
        stroke_rows = dist >= dist[peak]*.66
        start, end = peak, peak+1
        while start and stroke_rows[start-1]:
            start -= 1
        while end < len(rows) and stroke_rows[end]:
            end += 1
        width = end-start
        colour = np.median(profile[start:end], axis=0)
        coverage = float((np.max(np.abs(strip[start:end]-profile[start:end, None]), axis=2) <= 15).mean())
        if not 1 <= width <= max(2, round(3*scale)) or coverage < (.50 if shared else .68):
            return None
        strips.append((colour, width/scale, coverage))
    difference = strips[0][0]-strips[1][0]
    if shared:
        # Lighting can change the brightness along a continuous frame.
        difference = difference - .65*difference.mean()
    if np.linalg.norm(difference) > 28:
        return None
    return hexa(np.mean([s[0] for s in strips], axis=0)), round(np.median([s[1] for s in strips]), 3), min(s[2] for s in strips)


def consensus(rows, key):
    available = [(row[key], row['weight']) for row in rows if row.get(key) is not None]
    if not available:
        return None
    # Prefer a supported measured colour over averaging unrelated swatches.
    colours = np.float32([[int(colour[i:i+2], 16) for i in (0, 2, 4)] for colour, _ in available])
    lab = cv2.cvtColor((colours/255).reshape(1, -1, 3), cv2.COLOR_RGB2LAB)[0]
    distance = np.linalg.norm(lab[:, None]-lab[None, :], axis=2)
    weights = [weight for _, weight in available]
    return available[int(np.argmax(np.maximum(0, 1-distance/22)@weights))][0]


def shared_dividers(pixels, geometry, active, y, height):
    if height < 16:
        return []
    scale = pixels.shape[1]/1600
    radius = max(4, round(scale*6))
    measured = []
    for i, segment in enumerate(geometry['segments'][1:]):
        if active in (i, i+1):
            continue
        x = round(segment['box'][0]*pixels.shape[1])
        crop = pixels[y:y+height, x-radius:x+radius+1]
        if crop.shape[:2] != (height, 2*radius+1):
            continue
        base = np.median(crop[:, [0, 1, -2, -1]], axis=1)
        residual = np.max(np.abs(crop-base[:, None]), axis=2)
        lo, hi = round(height*.16), round(height*.84)
        support = (residual[lo:hi] > 14).mean(axis=0)
        columns = np.flatnonzero(support >= .64)
        if not 0 < len(columns) <= max(2, round(5*scale)):
            continue
        column = int(np.argmax(support))
        rows = np.nonzero(residual[lo:hi, column] > 14)[0]+lo
        color = np.median(crop[rows, column], axis=0)
        if np.mean(np.max(np.abs(crop[rows, column]-color), axis=1)<24) < .75:
            continue
        solid = np.nonzero(np.max(np.abs(crop[:, column]-color), axis=1)<24)[0]
        solid = solid[(solid>=height*.07)&(solid<height*.93)]
        if not len(solid):
            continue
        strength = np.median(residual[lo:hi], axis=0)
        width = np.sum(strength[columns] >= strength[column]*.72)
        measured.append({'index': i, 'color': hexa(color), 'width': round(min(3,max(1,width)/scale), 3),
                         'top': round(solid[0]/height, 4), 'height': round((solid[-1]-solid[0]+1)/height, 4)})
    return measured


def measure_progress(image, geometry, active, background=None):
    pixels = np.asarray(image, dtype=np.float32)
    underlay = None if background is None else np.asarray(background, dtype=np.float32)
    ih, iw = pixels.shape[:2]
    bx, by, bw, bh = geometry['box']
    x, y, width, height = [round(v) for v in (bx*iw, by*ih, bw*iw, bh*ih)]
    # Registered underlays may have shifted during image generation. Only use
    # them if unchanged pixels beside the detected row agree with the preview.
    if underlay is not None:
        lo, hi = min(len(pixels), y+height+5), min(len(pixels), y+height+22)
        delta = np.max(np.abs(pixels[lo:hi, x:x+width]-underlay[lo:hi, x:x+width]), axis=2)
        if not delta.size or np.mean(delta <= 8) < .75:
            underlay = None
    appearance, evidence, members = {}, {}, {state: [] for state in STATES}
    for i, shape in enumerate(geometry['segments']):
        state = 'active' if i == active else 'completed' if i < active else 'track'
        sx, sy, patch, mask = region(pixels, shape)
        measured = interior(patch, mask)
        if measured is None:
            continue
        fill, ink, clean, _ = measured
        h, w = mask.shape
        alpha = None
        if fill is not None and underlay is not None:
            alpha = unmix_surface(patch, underlay[sy:sy+h, sx:sx+w], clean)
        # The central strip lies inside the parallel top/bottom edges, with the
        # polygon mask excluding edge pixels in narrow or asymmetric segments.
        a, b = round(w*.26), round(w*.74)
        support = np.mean(mask[round(h*.19):round(h*.81), a:b]) if b > a else 0
        gradient, ge = gradient_fit(patch[:, a:b]) if support >= .98 else (None, {'status': 'unobservable'})
        owns_edges = not geometry.get('sharedFrame') or state == 'active'
        exterior, ee = exterior_fit(pixels, sx+a, sx+b, sy, h, pixels.shape[1]/1600, underlay) if owns_edges and b-a >= 24 else ({}, {'Shadow': {'status': 'unobservable'}})
        stroke = outline(pixels, sx, sy, w, h) if owns_edges else None
        members[state].append({'fill': hexa(fill) if fill is not None else None, 'ink': ink, 'alpha': alpha,
                               'weight': float(np.sqrt(clean.sum())*clean.mean()), 'gradient': gradient,
                               'gradientEvidence': ge, 'shadow': exterior.get('Shadow'), 'shadowEvidence': ee['Shadow'], 'stroke': stroke})

    for state, rows in members.items():
        fill = consensus(rows, 'fill')
        ink = consensus(rows, 'ink')
        if fill:
            appearance[FILL[state]] = fill
            best = max((row for row in rows if row['fill'] == fill), key=lambda row: row['weight'])
            evidence[state+'FillOpacity'] = best['alpha']
        if ink:
            appearance[INK[state]] = ink
        for effect in ('gradient', 'shadow'):
            measured = [row for row in rows if row[effect+'Evidence']['status'] != 'unobservable']
            measured.sort(key=lambda row: row['weight']/(1+row[effect+'Evidence'].get('rmse', 0)), reverse=True)
            key = state+effect.capitalize()
            if not measured:
                evidence[key] = {'status': 'unobservable', 'reason': 'state-not-measurable'}
                continue
            best = measured[0]
            evidence[key] = best[effect+'Evidence']
            appearance[key] = best[effect]
        strokes = [row['stroke'] for row in rows if row['stroke']]
        if strokes:
            colour, stroke_width, _ = max(strokes, key=lambda stroke: stroke[2])
            appearance[BORDER[state]] = colour
            appearance[state+'StrokeWidth'] = stroke_width

    if geometry.get('sharedFrame'):
        stroke = outline(pixels, x, y, width, height, shared=True) if geometry.get('sharedPolygon') else None
        if stroke:
            appearance['sharedBorder'], appearance['sharedStrokeWidth'], _ = stroke
        appearance['trackStrokeWidth'] = appearance['completedStrokeWidth'] = 0
    return {'appearance': appearance, 'effectEvidence': evidence,
            'sharedDividers': shared_dividers(pixels, geometry, active, y, height) if geometry.get('sharedFrame') else [],
            'sampleEvidence': {state: {'segments': len(rows), 'fillMeasured': FILL[state] in appearance,
                                       'inkMeasured': INK[state] in appearance} for state, rows in members.items()},
            'backgroundMatched': underlay is not None}
