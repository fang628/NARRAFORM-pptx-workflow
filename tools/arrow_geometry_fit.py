"""Independent symmetric head/notch fitting from visible paired boundaries."""
import cv2
import numpy as np
from fit_window import complete_components


def arrow_kind(element):
    if element.get('customGeometry') or element.get('managed'):
        return None
    shape = str(element.get('shape') or '')
    if element.get('arrowTail') in ('flat', 'notched', 'shaft'):
        return element['arrowTail']
    return 'notched' if shape == 'chevron' else 'shaft' if shape in ('rightArrow', 'leftArrow', 'upArrow', 'downArrow') else None


def arrow_points(element, box, head, notch):
    tail = arrow_kind(element)
    shaft = float((element.get('shapeGeometry') or {}).get('shaftRatio',
                  (element.get('adjustments') or {}).get('adj1', 50000) / 100000)) / 2
    if tail == 'notched':
        points = [[0, 0], [1-head, 0], [1, .5], [1-head, 1], [0, 1], [notch, .5]]
    elif tail == 'flat':
        points = [[0, 0], [1-head, 0], [1, .5], [1-head, 1], [0, 1]]
    else:
        points = [[0, .5-shaft], [1-head, .5-shaft], [1-head, 0], [1, .5],
                  [1-head, 1], [1-head, .5+shaft], [0, .5+shaft]]
    points = np.asarray(points, float)
    direction = element.get('arrowDirection') or {'leftArrow': 'left', 'upArrow': 'up', 'downArrow': 'down'}.get(element.get('shape'), 'right')
    if direction == 'left':
        points[:, 0] = 1-points[:, 0]
    elif direction == 'up':
        points = np.column_stack([points[:, 1], 1-points[:, 0]])
    elif direction == 'down':
        points = points[:, ::-1]
    return points * np.asarray(box[2:]) + np.asarray(box[:2])


def initial_depths(element, box):
    g = element.get('shapeGeometry') or {}
    vertical = element.get('arrowDirection') in ('up', 'down') or element.get('shape') in ('upArrow', 'downArrow')
    length, cross = (box[3], box[2]) if vertical else (box[2], box[3])
    adjustment = (element.get('adjustments') or {}).get('adj' if arrow_kind(element) == 'notched' else 'adj2', 50000)
    head = float(g.get('headDepth', min(.49, min(box[2:])*adjustment/100000/length)))
    if g.get('slantAngle') is not None:
        head = cross / (2*np.tan(np.radians(g['slantAngle']))) / length
    return float(np.clip(head, .005, .49)), float(np.clip(g.get('notchDepth', head), 0, .49))


def pair_score(points, indices, distance, valid):
    edges = []
    for index in indices:
        a, b = points[index], points[(index+1) % len(points)]
        samples = a+(b-a)*np.linspace(.10, .90, 48)[:, None]
        x = np.rint(samples[:, 0]).astype(int); y = np.rint(samples[:, 1]).astype(int)
        inside = (x >= 0) & (x < distance.shape[1]) & (y >= 0) & (y < distance.shape[0])
        x, y = x[inside], y[inside]
        keep = valid[y, x]
        if keep.sum() < 20:
            return None
        values = distance[y[keep], x[keep]]
        edges.append({'support': float((values <= 2.5).mean()),
                      'p95': float(np.percentile(values, 90)),
                      'cost': float(np.minimum(values, 12).mean()),
                      'coverage': float(keep.sum()/48)})
    return {'support': min(e['support'] for e in edges), 'p95': max(e['p95'] for e in edges),
            'coverage': min(e['coverage'] for e in edges), 'cost': float(np.mean([e['cost'] for e in edges]))}


def candidate_boxes(element, ref, box):
    """A connected observed silhouette can refine the bbox, as for hexagon edges."""
    yield box
    palette = [(element.get('fill') or '')] + [s.get('color') for s in (element.get('gradient') or {}).get('stops', [])]
    colors = []
    for color in palette:
        try:
            colors.append([int(str(color).lstrip('#')[i:i+2], 16) for i in (4, 2, 0)])
        except (ValueError, TypeError):
            continue
    if not colors:
        return
    x, y, w, h = box
    pad = min(35, max(8, min(w, h)*.2))
    palette = np.asarray(colors)
    def mask_for(patch):
        delta = np.min(np.linalg.norm(patch.astype(float)[:, :, None]-palette[None, None], axis=3), axis=2)
        return cv2.morphologyEx((delta < 50).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))

    def eligible(bounds, center, area):
        a, b, cw, ch = bounds
        return (area >= w*h*.25 and .75*w <= cw <= 1.25*w+1 and .75*h <= ch <= 1.25*h+1
                and abs(a-x) <= pad and abs(b-y) <= pad)

    for (a, b, cw, ch), _ in complete_components(ref, box, (pad+1,pad+1), mask_for, eligible, min(80,max(20,max(w,h)*.32))):
        # Integer filled contours include both edge pixels; bounds use their centres.
        yield np.array([a, b, cw-1, ch-1], float)


def fit_arrow_parameters(element, ref, distance, valid, score):
    box = np.asarray([float(element[k]) for k in ('x', 'y', 'w', 'h')])
    tail = arrow_kind(element)
    initial = initial_depths(element, box)
    locks = set(element.get('keepParameters') or [])
    if min(box[2:]) < 8 or locks.intersection(('geometry', 'shape')):
        return {'key': element['key'], 'family': 'arrow', 'status': 'retained', 'reason': 'geometry-protected-or-small', 'properties': {}}
    head_edges = (2, 3) if tail == 'shaft' else (1, 2)
    parameters = [('headDepth', head_edges, 0)] + ([('notchDepth', (4, 5), 1)] if tail == 'notched' else [])
    best = None
    for trial in candidate_boxes(element, ref, box):
        if locks.intersection(('position', 'x', 'y', 'width', 'height')) and not np.array_equal(trial, box):
            continue
        depths = list(initial);evidence = {}
        for name, edges, axis in parameters:
            if name in locks or name == 'headDepth' and 'slant' in locks:
                evidence[name] = {'confidence': 0, 'reason': 'parameter-protected'}
                continue
            winner = None
            # Coarse-to-fine bounded search: each parameter reads only its two
            # slanted edges, so the other end cannot bias it toward one depth.
            for values in (np.linspace(.005 if axis == 0 else 0, .49, 50), None):
                if values is None:
                    if winner is None:
                        break
                    values = np.linspace(max(.005 if axis == 0 else 0, winner[1]-.012), min(.49, winner[1]+.012), 25)
                for value in values:
                    candidate = depths.copy(); candidate[axis] = float(value)
                    metric = pair_score(arrow_points(element, trial, *candidate), edges, distance, valid)
                    if metric is None:
                        continue
                    cost = metric['cost'] + .002*abs(value-initial[axis])
                    if winner is None or cost < winner[0]:
                        winner = (cost, float(value), metric)
            if winner and winner[2]['support'] >= .70 and winner[2]['p95'] <= 3:
                depths[axis] = winner[1]
                evidence[name] = {**winner[2], 'confidence': round(min(.95, winner[2]['support'])*(1-min(.5, winner[2]['p95']/12)), 4),
                                  'independent': True, 'source': 'paired-arrow-boundaries'}
            else:
                evidence[name] = {'confidence': 0, 'independent': True, 'source': 'unresolved-arrow-boundaries'}
        points = arrow_points(element, trial, *depths);metric = score(points, distance, valid)
        if metric is None or not any(e.get('confidence', 0) >= .55 for e in evidence.values()):
            continue
        cost = metric['cost'] + .005*float(abs(trial-box).sum())
        if best is None or cost < best[0]:
            best = (cost, trial, depths, evidence, metric)
    if best is None or best[4]['support'] < .60 or best[4]['p95'] > 6:
        return {'key': element['key'], 'family': 'arrow', 'status': 'retained', 'reason': 'insufficient-arrow-boundaries', 'properties': {}}
    _, fitted_box, depths, evidence, metric = best
    geometry = {**(element.get('shapeGeometry') or {})}
    if tail == 'notched' and 'notchDepth' not in geometry:
        # A previously implicit notch must not follow a newly measured head.
        geometry['notchDepth'] = initial[1]
    for name, _, axis in parameters:
        if evidence[name].get('confidence', 0) >= .55:
            geometry[name] = round(depths[axis], 6)
            if name == 'headDepth':
                geometry.pop('slantAngle', None)
    return {'key': element['key'], 'family': 'arrow', 'status': 'accepted', 'method': 'independent-paired-arrow-boundaries',
            'properties': {**dict(zip(('x', 'y', 'w', 'h'), [round(float(v), 3) for v in fitted_box])), 'shapeGeometry': geometry},
            'metrics': metric, 'parameterEvidence': evidence}
