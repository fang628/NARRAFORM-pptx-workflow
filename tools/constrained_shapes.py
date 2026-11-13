"""Bounded prototype fitting. Geometry only; one page feature preparation per invocation.

The fitter never trusts a declared preset blindly:
  * quad edges are re-measured from visible boundary evidence; parallelogram slant sign/angle are
    measured from the left/right edge deltas (declared slantSign is only a search prior);
  * every corner is classified independently (sharp / round / cut) with a bounded radius/chamfer
    search against the edge-distance field, so a panel with one cut corner is not collapsed to a
    scalar-radius roundRect and a declared cut bevel is preserved when evidence is ambiguous;
  * hexagon orientation (flat-top preset vs 90-degree pointy-top) is chosen by evidence with a margin,
    and the chosen orientation is encoded ONCE (customGeometry points or preset) while stale flip/
    rotation evidence is cleared, so a renderer cannot apply a second transform.
"""
import json
import math
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from shape_reference import seed_polygon
from native_line_fit import fit_native_lines
from parameter_confidence import weighted_median,provenance
from structural_edges import match_panel

cv2.setNumThreads(1)
WIDTH, HEIGHT = 1600, 900
CORNER_STEPS = (.02, .03, .045, .06, .08, .105, .13)


def load(file):
    value = cv2.imread(str(file))
    if value is None:
        raise ValueError('Cannot read reference')
    return cv2.resize(value, (WIDTH, HEIGHT))


def family(element):
    shape = str(element.get('shape') or element.get('type') or '').lower()
    if shape == 'hexagon':
        return 'hexagon'
    if shape in ('ellipse', 'circle'):
        return 'ellipse'
    if shape in ('rect', 'roundrect', 'parallelogram', 'trapezoid', 'freeform'):
        points = (element.get('customGeometry') or {}).get('points')
        commands=(element.get('customGeometry') or {}).get('commands') or []
        vertices=[c for c in commands if c.get('op')!='Z']
        if len(vertices)==4 and all(c.get('op')==('M' if i==0 else 'L') and len(c.get('points',[]))==1 for i,c in enumerate(vertices)):
            points=[c['points'][0] for c in vertices]
        if shape == 'freeform' and (not points or len(points) != 4) and not (
                element.get('frameKind') == 'panel' or element.get('class') == 'freeform-panel'):
            return None
        return 'quad'
    return None


def prototype(e, box, kind):
    x, y, w, h = box
    if kind == 'hexagon':
        points = np.array([[.5,0],[1,.25],[1,.75],[.5,1],[0,.75],[0,.25]] if e.get('_hexVertical')
                          else [[.25, 0], [.75, 0], [1, .5], [.75, 1], [.25, 1], [0, .5]])
        return points * [w, h] + [x, y]
    if kind == 'ellipse':
        angles = np.linspace(0, math.tau, 64, endpoint=False)
        return np.column_stack([x + w * (.5 + .5 * np.cos(angles)),
                                y + h * (.5 + .5 * np.sin(angles))])
    # seed_polygon rejects sub-3px boxes; scale the real declared geometry instead.
    points = seed_polygon(e)
    if points and len(points) == 4:
        points = (np.asarray(points) - [e['x'], e['y']]) / [e['w'], e['h']]
    else:
        points = np.array([[0, 0], [1, 0], [1, 1], [0, 1]])
    return points * [w, h] + [x, y]


def samples(points):
    out = []
    for a, b in zip(points, np.roll(points, -1, axis=0)):
        count = max(4, min(80, int(np.linalg.norm(b-a) / 3)))
        out.extend(a + (b-a) * t for t in np.linspace(.1, .9, count))
    return np.asarray(out)


def score(points, distance, valid):
    points = samples(points)
    x = np.clip(np.rint(points[:, 0]).astype(int), 0, WIDTH-1)
    y = np.clip(np.rint(points[:, 1]).astype(int), 0, HEIGHT-1)
    mask = valid[y, x]
    if mask.sum() < max(8, len(points) * .35):
        return None
    values = distance[y[mask], x[mask]]
    return {'p95': float(np.percentile(values, 90)),
            'median': float(np.median(values)), 'support': float((values <= 2.5).mean()),
            'coverage': float(mask.mean()), 'cost': float(np.mean(np.minimum(values, 15)))}


def search_side(distance, valid, x0, top, bottom, width, expected_delta=0):
    ys=np.linspace(top+.12*(bottom-top),bottom-.12*(bottom-top),64)
    yi=np.clip(np.rint(ys).astype(int),0,HEIGHT-1)
    fractions=(ys-top)/max(1,bottom-top)
    # Local edge search must not jump from the carrier to a parallel light strip in its gutter.
    local_shift=min(35,max(10,min(width,bottom-top)*.08))
    delta=min(150,max(12,(bottom-top)*.35))
    best=None
    for shift in (local_shift,min(90,max(local_shift,width*.13))):
        for intercept in np.linspace(x0-shift,x0+shift,41):
            for change in np.linspace(expected_delta-delta,expected_delta+delta,41):
                xs=np.clip(np.rint(intercept+fractions*change).astype(int),0,WIDTH-1)
                usable=valid[yi,xs]
                if usable.sum()<25:continue
                values=distance[yi[usable],xs[usable]]
                support=float((values<=2.5).mean())
                cost=float(np.mean(np.minimum(values,12)))+.025*abs(intercept-x0)+.005*abs(change-expected_delta)
                if best is None or cost<best[0]:best=(cost,intercept,intercept+change,support)
        if best and best[3]>=.8:break
    if best and best[3]>=.65:return [best[1],best[2]]
    return None


def search_vertical_side(distance, valid, x0, top, bottom, width):
    """Fit a vertical edge directly, independently of the free-slope solution."""
    ys=np.linspace(top+.12*(bottom-top),bottom-.12*(bottom-top),64)
    yi=np.clip(np.rint(ys).astype(int),0,HEIGHT-1)
    span=min(90,max(10,width*.13));best=None
    for x in np.linspace(x0-span,x0+span,max(41,int(span*4)+1)):
        xi=int(np.clip(round(x),0,WIDTH-1));mask=valid[yi,xi]
        if mask.sum()<25:continue
        values=distance[yi[mask],xi];support=float(np.mean(values<=2.5))
        cost=float(np.mean(np.minimum(values,12)))+.025*abs(x-x0)
        if support>=.65 and (best is None or cost<best[0]):best=(cost,x)
    return [best[1],best[1]] if best else None


# ------------------------------------------------------------------ geometry primitives
def _unit(a, b):
    vector = np.asarray(b, float) - np.asarray(a, float)
    return vector / max(1e-9, float(np.linalg.norm(vector)))


def _round_controls(entry, vertex, exit_):
    before=_unit(vertex,entry)
    after=_unit(vertex,exit_)
    angle=math.acos(float(np.clip(np.dot(before,after),-1,1)))
    radius=np.linalg.norm(np.asarray(entry)-vertex)*math.tan(angle*.5)
    k=4/3*math.tan((math.pi-angle)/4)*radius
    return np.asarray(entry)-before*k,np.asarray(exit_)-after*k


def _bezier(a, control, b, count=11):
    t = np.linspace(.08, .92, count)[:, None]
    c1,c2=_round_controls(a,control,b)
    return (1-t)**3*np.asarray(a,float)+3*(1-t)**2*t*c1+3*(1-t)*t**2*c2+t**3*np.asarray(b,float)


def _corner_points(vertex, before_dir, after_dir, span, kind, size):
    vertex = np.asarray(vertex, float)
    start = vertex + before_dir * span
    end = vertex + after_dir * span
    if kind in ('round', 'cut') and size >= 1:
        entry = vertex + before_dir * size
        exit_ = vertex + after_dir * size
        left = np.linspace(start, entry, 4)[:-1]
        middle = _bezier(entry, vertex, exit_) if kind == 'round' else np.linspace(entry, exit_, 6)[1:-1]
        right = np.linspace(exit_, end, 4)
        return np.vstack([left, middle, right])
    return np.vstack([np.linspace(start, vertex, 4)[:-1], np.linspace(vertex, end, 4)])


def _boundary_metric(points, distance, valid):
    xs = np.clip(np.rint(points[:, 0]).astype(int), 0, WIDTH-1)
    ys = np.clip(np.rint(points[:, 1]).astype(int), 0, HEIGHT-1)
    mask = valid[ys, xs]
    if mask.sum() < max(6, len(points) * .4):
        return None
    values = distance[ys[mask], xs[mask]]
    return {'cost': float(np.mean(np.minimum(values, 6))),
            'p95': float(np.percentile(values, 90)), 'support': float(mask.mean())}


def declared_corner_radius(element, width, height):
    geometry = element.get('shapeGeometry') or {}
    radii = [float(c.get('radius', 0)) for c in geometry.get('corners', []) if c.get('type') == 'round']
    radius = float(geometry.get('cornerRadius') or (np.median(radii) if radii else 0)) * min(width, height)
    # Existing quadratic corners remain evidence when an old preset left sharp flags.
    for command in (element.get('customGeometry') or {}).get('commands', []):
        points = command.get('points') or []
        if command.get('op') == 'Q' and len(points) == 2:
            radius = max(radius, float(np.linalg.norm((np.asarray(points[1])-points[0])*[width, height])))
    if not radius and element.get('shape') == 'roundRect':
        radius = .035 * min(width, height)
    return min(.5 * min(width, height), radius)


def declared_corners(element, width, height):
    """Per-corner prior: explicit version-2 corners are strong; a scalar radius is only a weak prior."""
    geometry = element.get('shapeGeometry') or {}
    corners = geometry.get('corners')
    result = []
    if isinstance(corners, list) and len(corners) == 4:
        for corner in corners:
            corner = corner or {}
            kind = str(corner.get('type') or 'sharp')
            value = corner.get('radius') if kind == 'round' else corner.get('distance') if kind == 'cut' else None
            result.append({'type': kind, 'strong': True,
                           'value': float(value) if isinstance(value, (int, float)) else None})
        return result
    radius = declared_corner_radius(element, width, height) / max(1.0, min(width, height))
    if radius > .004:
        return [{'type': 'round', 'value': radius, 'strong': False} for _ in range(4)]
    return [{'type': 'sharp', 'value': None, 'strong': False} for _ in range(4)]


def measure_corner(vertex, before_dir, after_dir, distance, valid, min_side, declared):
    """Bounded per-corner model: sharp vs round(radius) vs cut(distance), boundary evidence only."""
    span = max(8.0, min(72.0, .22 * min_side))
    base = _boundary_metric(_corner_points(vertex, before_dir, after_dir, span, 'sharp', 0),
                            distance, valid)
    if base is None:
        prior_type=(declared or {}).get('type') or 'sharp'
        return {'type':prior_type,'size':float((declared or {}).get('value') or 0)*min_side,'confidence':0.0}
    candidates = {}
    for step in CORNER_STEPS:
        size = step * min_side
        for kind in ('round', 'cut'):
            metric = _boundary_metric(_corner_points(vertex, before_dir, after_dir, span, kind, size),
                                      distance, valid)
            if not metric or metric['support'] < .45:
                continue
            if kind not in candidates or metric['cost'] < candidates[kind]['cost']:
                candidates[kind] = {'type': kind, 'size': size, 'cost': metric['cost'],
                                    'p95': metric['p95']}
    best = min(candidates.values(), key=lambda item: item['cost']) if candidates else None
    improvement = base['cost'] - best['cost'] if best else 0.0
    chosen = None
    if best and improvement >= .15 and best['size'] >= 1.8 and best['p95'] <= 6:
        chosen = dict(best)
    # Preserve a declared bevel/cut prior, or an explicitly declared per-corner prior, unless the
    # measured model is clearly better. A scalar declared radius must never erase measured corner
    # differences (that is the "no scalar-radius collapse" rule).
    declared_type = str((declared or {}).get('type') or 'sharp')
    prior_allowed = bool(declared and declared.get('strong')) or declared_type == 'cut' or chosen is None
    if declared_type in ('round', 'cut') and prior_allowed:
        declared_size = (declared or {}).get('value')
        declared_size = declared_size * min_side if declared_size else (
            chosen['size'] if chosen else .05 * min_side)
        if declared_type=='round' and (declared or {}).get('value'):
            angle=math.acos(float(np.clip(np.dot(before_dir,after_dir),-1,1)))
            declared_size/=max(.01,math.tan(angle/2))
        prior = _boundary_metric(_corner_points(vertex, before_dir, after_dir, span,
                                                declared_type, declared_size), distance, valid)
        if prior and (chosen is None or prior['cost'] <= chosen['cost'] + .35):
            chosen = {'type': declared_type, 'size': max(declared_size, 1.0),
                      'cost': prior['cost'], 'p95': prior['p95']}
    if not chosen:
        return {'type': 'sharp', 'size': 0.0, 'confidence': 0.0}
    # Round/cut ambiguity: keep the declared family, otherwise prefer the smoother round model.
    if chosen['type'] == 'cut' and 'round' in candidates and declared_type != 'cut':
        if candidates['round']['cost'] <= chosen['cost'] + .2:
            chosen = dict(candidates['round'])
    if chosen['type'] == 'round' and 'cut' in candidates and declared_type == 'cut':
        if candidates['cut']['cost'] <= chosen['cost'] + .2:
            chosen = dict(candidates['cut'])
    return {'type': chosen['type'], 'size': chosen['size'],
            'confidence': round(float(improvement), 3)}


def corner_payload(corners, min_side, ring=None):
    payload = []
    for index,corner in enumerate(corners):
        if corner['type'] == 'round':
            factor=1.
            if ring is not None:
                before=_unit(ring[index],ring[(index-1)%4]);after=_unit(ring[index],ring[(index+1)%4])
                factor=math.tan(math.acos(float(np.clip(np.dot(before,after),-1,1)))/2)
            payload.append({'type': 'round',
                            'radius': round(max(.004, min(.49, corner['size']*factor / max(1.0, min_side))), 5)})
        elif corner['type'] == 'cut':
            payload.append({'type': 'cut',
                            'distance': round(max(.004, min(.49, corner['size'] / max(1.0, min_side))), 5)})
        else:
            payload.append({'type': 'sharp'})
    return payload


def mixed_corner_commands(ring, corners, x, y, width, height):
    ring = np.asarray(ring, float)
    entries, exits = [], []
    for index in range(4):
        vertex = ring[index]
        before = _unit(vertex, ring[(index - 1) % 4])
        after = _unit(vertex, ring[(index + 1) % 4])
        size = corners[index]['size'] if corners[index]['type'] in ('round', 'cut') else 0.0
        entries.append(vertex + before * size)
        exits.append(vertex + after * size)

    def norm(point):
        return ((np.asarray(point, float) - [x, y]) / [max(1e-6, width), max(1e-6, height)]).tolist()

    commands = [{'op': 'M', 'points': [norm(entries[0])]}]
    for index in range(4):
        if index:
            commands.append({'op': 'L', 'points': [norm(entries[index])]})
        corner = corners[index]
        if corner['type'] == 'round' and corner['size'] >= 1:
            c1,c2=_round_controls(entries[index],ring[index],exits[index])
            commands.append({'op': 'C', 'points': [norm(c1),norm(c2),norm(exits[index])]})
        elif corner['type'] == 'cut' and corner['size'] >= 1:
            commands.append({'op': 'L', 'points': [norm(exits[index])]})
    commands.append({'op': 'Z', 'points': []})
    return commands


def measure_quad_corners(ring, distance, valid, min_side, declared):
    corners = []
    for index in range(4):
        vertex = np.asarray(ring[index], float)
        before = _unit(vertex, ring[(index - 1) % 4])
        after = _unit(vertex, ring[(index + 1) % 4])
        corners.append(measure_corner(vertex, before, after, distance, valid, min_side,
                                      declared[index] if index < len(declared) else None))
    return corners


def merge_corner_symmetry(corners,mode='auto',ring=None,distance=None,valid=None):
    """Infer symmetry from measured geometry, then test the shared local contour."""
    same=lambda ids:len({corners[i]['type'] for i in ids})==1
    if mode=='none':return corners
    def factor(i):
        if ring is None or corners[i]['type']!='round':return 1.
        before=_unit(ring[i],ring[(i-1)%4]);after=_unit(ring[i],ring[(i+1)%4])
        return max(.01,math.tan(math.acos(float(np.clip(np.dot(before,after),-1,1)))/2))
    def comparable(ids):
        values=[corners[i]['size']*factor(i) for i in ids]
        return same(ids) and max(values)-min(values)<=max(2.,float(np.median(values))*.35)
    def geometric(kind):
        if ring is None:return True
        points=np.asarray(ring,float);center=(points.min(axis=0)+points.max(axis=0))/2
        tolerance=max(2.,float(np.min(np.ptp(points,axis=0)))*.03)
        pairs=[[0,1],[3,2]] if kind=='horizontal' else [[0,2],[1,3]]
        return all(np.linalg.norm(points[a]+points[b]-2*center if kind=='diagonal' else
                                  [points[a,0]+points[b,0]-2*center[0],points[a,1]-points[b,1]])<=tolerance for a,b in pairs)
    candidates=[]
    if mode in ('auto','all') and comparable(range(4)) and (geometric('horizontal') or geometric('diagonal')):candidates.append(('all',[list(range(4))]))
    for kind,groups in [('horizontal',[[0,1],[3,2]]),('diagonal',[[0,2],[1,3]])]:
        if mode in ('auto',kind) and geometric(kind) and all(comparable(g) for g in groups):candidates.append((kind,groups))
    result=[dict(c) for c in corners]
    for kind,groups in candidates:
        proposals=[]
        for ids in groups:
            weights=[max(0.,float(corners[i].get('confidence',0))) for i in ids]
            if ring is not None and distance is not None and valid is not None:
                for j,i in enumerate(ids):
                    vertex=np.asarray(ring[i],float);span=max(8.,min(72.,.22*float(np.min(np.ptp(ring,axis=0)))))
                    observed=_boundary_metric(_corner_points(vertex,_unit(vertex,ring[(i-1)%4]),_unit(vertex,ring[(i+1)%4]),span,corners[i]['type'],corners[i]['size']),distance,valid)
                    weights[j]=observed['support']/(1+observed['cost']) if observed else 0.
            if distance is None:weights=[1.]*len(ids)
            if not any(weights):continue
            size=weighted_median([corners[i]['size']*factor(i) for i in ids],weights);accepted=True
            if ring is not None and distance is not None and valid is not None:
                min_side=max(1.,float(np.min(np.ptp(ring,axis=0))));span=max(8.,min(72.,.22*min_side))
                for i in ids:
                    vertex=np.asarray(ring[i],float);before=_unit(vertex,ring[(i-1)%4]);after=_unit(vertex,ring[(i+1)%4])
                    old=_boundary_metric(_corner_points(vertex,before,after,span,corners[i]['type'],corners[i]['size']),distance,valid)
                    new=_boundary_metric(_corner_points(vertex,before,after,span,corners[i]['type'],size/factor(i)),distance,valid)
                    if old is None or new is None or new['support']<.6 or new['p95']>6 or new['cost']>old['cost']+.35:accepted=False;break
            if accepted:proposals.append((ids,size))
        if len(proposals)!=len(groups):continue
        for ids,size in proposals:
            for i in ids:result[i].update(size=round(size/factor(i),6),symmetryMode=kind,boundaryChecked=distance is not None)
        break
    return result


def quad_properties(element, best, distance, valid):
    """Encode the measured quad once: preset parallelogram + measured slant, or mixed corner path."""
    best = np.asarray(best, float)
    x, y = best.min(axis=0)
    width, height = best.max(axis=0) - [x, y]
    min_side = max(1.0, min(width, height))
    left_delta = float(best[3, 0] - best[0, 0])
    right_delta = float(best[2, 0] - best[1, 0])
    skew = max(abs(left_delta), abs(right_delta))
    parallel = abs(left_delta - right_delta) <= max(3.0, .22 * max(abs(left_delta), abs(right_delta)) + 1.0)
    axis_aligned = skew <= max(3.0, width * .012)
    ring = np.array([[x, y], [x + width, y], [x + width, y + height], [x, y + height]]) \
        if axis_aligned else best
    declared = declared_corners(element, width, height)
    corners = merge_corner_symmetry(measure_quad_corners(ring, distance, valid, min_side, declared),
                                    (element.get('shapeGeometry') or {}).get('cornerSymmetry','auto'),ring,distance,valid)
    payload = corner_payload(corners, min_side,ring)
    all_sharp = all(corner['type'] == 'sharp' for corner in corners)
    normalized = ((ring - [x, y]) / [max(1.0, width), max(1.0, height)]).tolist()
    properties = {'x': round(float(x), 3), 'y': round(float(y), 3),
                  'w': round(float(width), 3), 'h': round(float(height), 3),
                  'type': 'shape', 'adjustments': None, 'flipH': False, 'flipV': False}
    if axis_aligned:
        if all_sharp:
            properties.update(shape='rect', shapeGeometry=None, customGeometry=None)
        else:
            # Per-corner payload; never collapse a mixed cut/round set to one scalar radius.
            properties.update(shape='roundRect', customGeometry=None,
                              shapeGeometry={'version': 2, 'corners': payload})
    elif parallel:
        delta = (left_delta + right_delta) * .5
        sign = -1 if delta > 0 else 1
        angle = math.degrees(math.atan2(height, max(1e-3, abs(delta))))
        angle = max(5.0, min(85.0, angle))
        if all_sharp:
            properties.update(shape='parallelogram', customGeometry=None,
                              shapeGeometry={'slantAngle': round(angle, 1), 'slantSign': sign})
        else:
            properties.update(shape='freeform', shapeGeometry=None,
                              customGeometry={'version': 2,
                                              'commands': mixed_corner_commands(ring, corners, x, y,
                                                                                width, height)})
    else:
        if all_sharp:
            properties.update(shape='freeform', shapeGeometry=None,
                              customGeometry={'points': normalized, 'closed': True})
        else:
            properties.update(shape='freeform', shapeGeometry=None,
                              customGeometry={'version': 2,
                                              'commands': mixed_corner_commands(ring, corners, x, y,
                                                                                width, height)})
    return properties, corners


def top_bottom_evidence(edge, valid, x, y, w, h):
    horizontal = []
    for at in (y, y + h):
        search = max(8, min(35, h * .08))
        rows = np.arange(max(1, int(at - search)), min(HEIGHT - 1, int(at + search) + 1))
        xs = np.arange(max(1, int(x + w * .18)), min(WIDTH - 1, int(x + w * .82)))
        if len(rows) and len(xs):
            strengths = (edge[np.ix_(rows, xs)] * valid[np.ix_(rows, xs)]).mean(axis=1)
            selected = int(np.argmax(strengths / (1 + .06 * abs(rows - at))))
            horizontal.append(float(rows[selected]) if strengths[selected] > 35 else float(at))
        else:
            horizontal.append(float(at))
    return horizontal[0], horizontal[1]


def quad_side_candidates(e, reference, distance, valid, edge, box, baseline):
    x, y, w, h = box
    top, bottom = top_bottom_evidence(edge, valid, x, y, w, h)
    if e.get('_formulaCarrier'):
        horizontal=[]
        for at in (y,y+h):
            search=min(50,max(12,h*.6))
            rows=np.arange(max(1,int(at-search)),min(HEIGHT-1,int(at+search)))
            xs=np.arange(max(1,int(x+w*.12)),min(WIDTH-1,int(x+w*.88)))
            strength=np.percentile(edge[np.ix_(rows,xs)],60,axis=1)
            order=np.argsort(strength)[-12:]
            horizontal.append([(float(rows[i]),float(strength[i])) for i in order if strength[i]>40]+[(float(at),0.)])
        pairs=[(sa+sb-.4*(abs(a-y)+abs(b-y-h)),a,b) for a,sa in horizontal[0] for b,sb in horizontal[1]
               if h*.75<=b-a<=h*1.35]
        if pairs:_,top,bottom=max(pairs)
    geometry = e.get('shapeGeometry') or {}
    declared_sign = geometry.get('slantSign')
    variants = [1]
    if str(e.get('shape') or '').lower() in ('parallelogram', 'trapezoid'):
        preferred = -1 if declared_sign == -1 else 1
        variants = [preferred, -preferred]
    candidates = [(baseline, prototype(e, box, 'quad'))]  # declared geometry remains a candidate
    if str(e.get('shape') or '').lower()=='parallelogram' and min(w,h)<=80:
        colors=[e.get('fill')]+[stop.get('color') for stop in (e.get('gradient') or {}).get('stops',[])]
        hues=[]
        for color in colors:
            try:
                value=str(color).lstrip('#')
                hsv=cv2.cvtColor(np.array([[[int(value[i:i+2],16) for i in (4,2,0)]]],np.uint8),cv2.COLOR_BGR2HSV)[0,0]
                if hsv[1]>80 and hsv[2]>100:hues.append(float(hsv[0]))
            except (ValueError,TypeError):pass
        if hues:
            left,top_roi=max(0,int(x-60)),max(0,int(y-40))
            right,bottom_roi=min(WIDTH,int(x+w+60)),min(HEIGHT,int(y+h+40))
            hsv=cv2.cvtColor(reference[top_roi:bottom_roi,left:right],cv2.COLOR_BGR2HSV).astype(float)
            hue_distance=np.minimum.reduce([np.minimum(abs(hsv[:,:,0]-hue),180-abs(hsv[:,:,0]-hue)) for hue in hues])
            ink=((hue_distance<16)&(hsv[:,:,1]>80)&(hsv[:,:,2]>100)).astype(np.uint8)*255
            contours=cv2.findContours(ink,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)[0]
            for contour in contours:
                if cv2.contourArea(contour)<max(25,w*h*.12):continue
                polygon=cv2.approxPolyDP(cv2.convexHull(contour),.035*cv2.arcLength(contour,True),True)[:,0,:].astype(float)+[left,top_roi]
                if len(polygon)!=4:continue
                order=np.argsort(polygon[:,1]);upper=polygon[order[:2]][np.argsort(polygon[order[:2],0])]
                lower=polygon[order[2:]][np.argsort(polygon[order[2:],0])]
                candidate=np.array([upper[0],upper[1],lower[1],lower[0]])
                candidate_size=candidate.max(0)-candidate.min(0)
                if not (.45<=candidate_size[0]/w<=2 and .6<=candidate_size[1]/h<=1.5):continue
                observed=score(candidate,distance,valid)
                if observed and observed['support']>=.6:candidates.append((observed,candidate))
    for sign in variants:
        variant = {**e}
        if sign != 1 or declared_sign in (1, -1):
            variant_geometry = dict(geometry)
            variant_geometry['slantSign'] = sign
            variant['shapeGeometry'] = variant_geometry
        seed = prototype(variant, box, 'quad')
        prototype_metric = score(seed, distance, valid)
        if prototype_metric:
            candidates.append((prototype_metric, seed))
        rectangular=str(e.get('shape') or e.get('type') or '').lower() in ('rect','roundrect')
        rectangle_metric=None
        if rectangular:
            vertical_left=search_vertical_side(distance,valid,seed[0,0],top,bottom,w)
            vertical_right=search_vertical_side(distance,valid,seed[1,0],top,bottom,w)
            if vertical_left and vertical_right:
                rectangle=np.array([[vertical_left[0],top],[vertical_right[0],top],
                                    [vertical_right[1],bottom],[vertical_left[1],bottom]])
                rectangle_metric=score(rectangle,distance,valid)
                if rectangle_metric:candidates.append((rectangle_metric,rectangle))
        left = search_side(distance, valid, seed[0, 0], top, bottom, w,
                           seed[3, 0] - seed[0, 0])
        right = search_side(distance, valid, seed[1, 0], top, bottom, w,
                            seed[2, 0] - seed[1, 0])
        if not left or not right or bottom - top < h * .8:
            continue
        if rectangular:
            alternate=np.array([[left[0],top],[right[0],top],[right[1],bottom],[left[1],bottom]])
            evidence=score(alternate,distance,valid)
            # An actually slanted reference may overturn a wrong preset, but
            # near-noise side drift never earns a new shape family.
            fitted_rectangle=rectangle_metric or baseline
            if evidence and evidence['support']>=.9 and evidence['p95']<=2.5 and fitted_rectangle['p95']>8:
                candidates.append((evidence,alternate))
            # Solve parallel vertical sides as a family; independent slope noise
            # must not turn a rounded rectangle into a trapezoid.
            continue
        candidate = np.array([[left[0], top], [right[0], top], [right[1], bottom],
                              [left[1], bottom]])
        observed = score(candidate, distance, valid)
        if observed:
            candidates.append((observed, candidate))
    visible = [item for item in candidates if item[0] and item[0]['support'] >= .6
               and item[1][1,0]>item[1][0,0]+1 and item[1][2,0]>item[1][3,0]+1
               and item[1][2,1]>item[1][1,1]+3]
    if not visible:
        return prototype(e, box, 'quad'), baseline
    chosen = min(visible, key=lambda item: item[0]['cost'])
    if chosen[0]['cost'] > baseline['cost'] - .15:
        return prototype(e, box, 'quad'), baseline
    return chosen[1], chosen[0]


def locate_thin_fill(element,reference,box):
    x,y,w,h=box
    if min(w,h)>14 or max(w,h)/max(1,min(w,h))<3:return None
    colors=[element.get('fill')]+[s.get('color') for s in (element.get('gradient') or {}).get('stops',[])]
    palette=[]
    for color in colors:
        try:palette.append([int(str(color).lstrip('#')[i:i+2],16) for i in (4,2,0)])
        except (ValueError,TypeError):pass
    if not palette:return None
    pad=min(32,max(12,max(w,h)*.5));left,top=max(0,int(x-pad)),max(0,int(y-pad));right,bottom=min(WIDTH,int(x+w+pad)),min(HEIGHT,int(y+h+pad))
    patch=reference[top:bottom,left:right]
    hsv=cv2.cvtColor(patch,cv2.COLOR_BGR2HSV).astype(float)
    hints=cv2.cvtColor(np.array([palette],np.uint8),cv2.COLOR_BGR2HSV)[0].astype(float)
    hints=hints[hints[:,1]>65]
    if not len(hints):return None
    d=np.minimum.reduce([np.minimum(abs(hsv[:,:,0]-v[0]),180-abs(hsv[:,:,0]-v[0])) for v in hints])
    mask=((d<12)&(hsv[:,:,1]>70)&(hsv[:,:,2]>90)).astype(np.uint8)
    count,labels,stats,centers=cv2.connectedComponentsWithStats(mask);candidates=[]
    for i in range(1,count):
        a,b,c,d,pixels=stats[i];cx,cy=centers[i]+[left,top]
        if not (.4*w<=c<=2.5*w and .4*h<=d<=2*h and pixels>=max(8,w*h*.2)):continue
        if (w<h)!=(c<d):continue
        candidates.append((math.hypot(cx-x-w/2,cy-y-h/2),np.array([a+left,b+top,c,d],float)))
    return min(candidates,key=lambda item:item[0])[1] if candidates else None


def locate_coloured_dot(element, reference, box):
    """Recover a small filled dot from its declared hue before following nearby edges."""
    x, y, width, height = box
    if max(width, height) > (80 if family(element)=='hexagon' or element.get('_badge') else 36):
        return None
    colors = [element.get('fill')] + [stop.get('color') for stop in (element.get('gradient') or {}).get('stops', [])]
    hues = []
    for color in colors:
        try:
            value = str(color).lstrip('#')
            bgr = np.array([[[int(value[i:i+2], 16) for i in (4, 2, 0)]]], np.uint8)
            hue, saturation, brightness = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)[0, 0]
            if saturation >= 75 and brightness >= 130:
                hues.append(float(hue))
        except (ValueError, TypeError):
            pass
    if not hues:
        return None
    pad_x, pad_y = min(24, max(6, width*.75)), min(24,max(6,height*.75))
    left, right = max(0, int(x-pad_x)), min(WIDTH, int(x+width+pad_x))
    top, bottom = max(0, int(y-pad_y)), min(HEIGHT, int(y+height+pad_y))
    hsv = cv2.cvtColor(reference[top:bottom, left:right], cv2.COLOR_BGR2HSV).astype(float)
    hue_distance = np.minimum.reduce([np.minimum(abs(hsv[:, :, 0]-h), 180-abs(hsv[:, :, 0]-h)) for h in hues])
    mask = ((hue_distance < 16) & (hsv[:, :, 1] > 65) & (hsv[:, :, 2] > 130)).astype(np.uint8)
    count, labels, stats, centers = cv2.connectedComponentsWithStats(mask)
    candidates = []
    for i in range(1, count):
        lx, ly, cw, ch, pixels = stats[i]
        cx, cy = centers[i] + [left, top]
        if not (.1*width*height <= pixels <= 3*width*height and .5 <= cw/max(1,ch) <= 2):
            continue
        if family(element)=='ellipse' and element.get('_circle'):
            if max(cw,ch)/max(1,min(cw,ch))>1.18:continue
            diameter=(cw+ch)/2
            if not .7*((width+height)/2)<=diameter<=1.35*((width+height)/2):continue
            cw=ch=diameter
        if abs(cx-(x+width/2)) > pad_x or abs(cy-(y+height/2)) > pad_y:
            continue
        cost = math.hypot(cx-(x+width/2),cy-(y+height/2)) + abs(cw-ch)
        candidates.append((cost, [cx-cw/2, cy-ch/2, float(cw), float(ch)]))
    return np.asarray(min(candidates, key=lambda item: item[0])[1]) if candidates else None


def fit_capsule(e,ref,distance,valid):
    """A capsule has full semicircular ends, not four tiny local bevels."""
    x,y,w,h=[float(e[k]) for k in ('x','y','w','h')];boxes=[np.array([x,y,w,h])]
    try:
        color=str(e.get('fill','')).lstrip('#');bgr=np.array([[[int(color[i:i+2],16) for i in (4,2,0)]]],np.uint8)
        hint=cv2.cvtColor(bgr,cv2.COLOR_BGR2HSV)[0,0].astype(float)
        pad=min(28,max(10,min(w,h)*.5));left,top=max(0,int(x-pad)),max(0,int(y-pad));right,bottom=min(WIDTH,int(x+w+pad)),min(HEIGHT,int(y+h+pad))
        hsv=cv2.cvtColor(ref[top:bottom,left:right],cv2.COLOR_BGR2HSV).astype(float)
        hue=np.minimum(abs(hsv[:,:,0]-hint[0]),180-abs(hsv[:,:,0]-hint[0]))
        mask=((hue<16)&(hsv[:,:,1]>max(30,hint[1]*.45))&(hsv[:,:,2]>70)).astype(np.uint8)
        count,labels,stats,centers=cv2.connectedComponentsWithStats(mask)
        for i in range(1,count):
            a,b,c,d,area=map(int,stats[i])
            if .7*w<c<1.4*w and .65*h<d<1.4*h and area>w*h*.35:boxes.append(np.array([left+a,top+b,c,d],float))
    except (ValueError,TypeError):pass
    candidates=[]
    for box in boxes:
        a,b,c,d=box
        for fraction in (.4,.45,.5):
            radius=min(c,d)*fraction;points=[]
            for cx,cy,start in [(a+radius,b+radius,180),(a+c-radius,b+radius,270),(a+c-radius,b+d-radius,0),(a+radius,b+d-radius,90)]:
                angles=np.deg2rad(np.linspace(start,start+90,18));points.extend(np.column_stack([cx+radius*np.cos(angles),cy+radius*np.sin(angles)]))
            metric=score(np.array(points),distance,valid)
            if metric and metric['support']>=.7 and metric['p95']<=4:
                candidates.append((metric['cost']+.01*np.sum(abs(box-[x,y,w,h])),box,fraction,metric))
    if not candidates:return {'key':e['key'],'status':'retained','family':'capsule','properties':{},'reason':'capsule-boundary-unresolved'}
    _,box,fraction,metric=min(candidates,key=lambda item:item[0])
    return {'key':e['key'],'status':'accepted','family':'capsule','properties':dict(zip(('x','y','w','h'),[round(float(v),3) for v in box]))|
        {'type':'shape','shape':'roundRect','shapeGeometry':{'version':2,'cornerRadius':fraction,'corners':[{'type':'round','radius':fraction} for _ in range(4)]},'customGeometry':None,'adjustments':None,'flipH':False,'flipV':False},'metrics':metric}


def fit(e, ref, distance, edge, valid):
    started = time.perf_counter()
    g=e.get('shapeGeometry') or {};corners=g.get('corners') or []
    capsule=str(e.get('shape','')).lower() in ('pill','roundrect') and not e.get('customGeometry') and (
        float(g.get('cornerRadius',0))>=.35 or len(corners)==4 and all(c.get('type')=='round' and float(c.get('radius',0))>=.35 for c in corners))
    if capsule:return fit_capsule(e,ref,distance,valid)
    kind = family(e)
    if not kind:
        return {'key': e['key'], 'status': 'unsupported'}
    panel=e.get('_structuralPanel')
    if panel and e.get('shape') in ('freeform','parallelogram','trapezoid'):
        points=np.asarray(panel['points'],float);samples_visible=[]
        for i in (0,1,3):
            a,b=points[i],points[(i+1)%4]
            samples_visible.extend(np.linspace(a,b,70)[7:-7])
        sampled=np.asarray(samples_visible);xx=np.rint(sampled[:,0]).astype(int);yy=np.rint(sampled[:,1]).astype(int)
        keep=valid[yy,xx];values=distance[yy[keep],xx[keep]]
        if len(values)>=50 and np.mean(values<=2.5)>=.75 and np.percentile(values,90)<=3:
            lo,hi=points.min(0),points.max(0);w,h=hi-lo
            return {'key':e['key'],'status':'accepted','family':'quad','properties':{'x':round(float(lo[0]),3),'y':round(float(lo[1]),3),'w':round(float(w),3),'h':round(float(h),3),
                'type':'shape','shape':'freeform','customGeometry':{'points':((points-lo)/[w,h]).tolist(),'closed':True},'shapeGeometry':None,'adjustments':None,'flipH':False,'flipV':False},
                'metrics':{'p95':float(np.percentile(values,90)),'support':float(np.mean(values<=2.5)),'coverage':float(keep.mean())},'structuralEvidence':panel,
                'elapsedMs':round((time.perf_counter()-started)*1000,1)}
    box = np.array([float(e[k]) for k in ('x', 'y', 'w', 'h')])
    if kind=='ellipse' and e.get('_circle'):
        diameter=float((box[2]+box[3])/2)
        box[:2]+=(box[2:]-diameter)/2;box[2:]=diameter
    thin=locate_thin_fill(e,ref,box) if kind=='quad' else None
    if thin is not None:box=thin
    if min(box[2:]) < 4:
        return {'key': e['key'], 'status': 'retained', 'reason': 'small-object'}
    original = prototype(e, box, kind)
    baseline = score(original, distance, valid)
    if baseline is None:
        return {'key': e['key'], 'status': 'retained', 'reason': 'insufficient-visible-boundary'}
    best, metric = original, baseline
    located_dot = False
    if kind == 'hexagon':
        located = locate_coloured_dot(e, ref, box)
        orientation_metrics = {}
        for vertical in (False, True):
            variant = {**e, '_hexVertical': vertical}
            for candidate_box in (box, located):
                if candidate_box is None:
                    continue
                candidate = prototype(variant, candidate_box, kind)
                observed = score(candidate, distance, valid)
                if observed and (vertical not in orientation_metrics
                                 or observed['cost'] < orientation_metrics[vertical][0]['cost']):
                    orientation_metrics[vertical] = (observed, candidate, candidate_box, variant)
        flat = orientation_metrics.get(False)
        vertical = orientation_metrics.get(True)
        # A 90-degree orientation is only used on strong, one-sided evidence; ties keep the preset
        # family (flat top) so glow/edge noise cannot rotate a hexagon by accident.
        chosen = flat
        if vertical and (flat is None or (
                vertical[0]['cost'] < flat[0]['cost'] - max(.35, .10 * flat[0]['cost'])
                and flat[0]['support'] < .9)):
            chosen = vertical
        if chosen:
            observed, candidate, candidate_box, variant = chosen
            if observed['cost'] < metric['cost'] - .1 or chosen is not flat:
                e, best, metric = variant, candidate, observed
                if candidate_box is located:
                    box = candidate_box
    # Prototype only: bounded translation/scale cannot turn a hexagon into arbitrary contours.
    if kind in ('hexagon', 'ellipse') or min(box[2:])/max(box[2:]) < .1:
        if kind == 'ellipse':
            located = locate_coloured_dot(e, ref, box)
            if located is not None:
                points = prototype(e, located, kind)
                observed = score(points, distance, valid)
                if observed and observed['support'] >= .6:
                    box, best, metric = located, points, observed
                    located_dot = True
        search = max(3, min(24, min(box[2:]) * .5))
        current = box.copy()
        for _ in range(2):
            candidates = [current + [dx, dy, 0, 0] for dx in np.linspace(-search, search, 9)
                          for dy in np.linspace(-search, search, 9)]
            candidates += [current + [current[2]*(1-scale)/2, current[3]*(1-scale)/2,
                                      current[2]*(scale-1), current[3]*(scale-1)]
                           for scale in (.75, .85, .95, 1.05, 1.15)]
            for trial in candidates:
                points = prototype(e, trial, kind)
                observed = score(points, distance, valid)
                if observed and observed['cost'] < metric['cost'] - .12:
                    best, metric, current = points, observed, trial
            search = max(1, search / 4)
    else:
        best, metric = quad_side_candidates(e, ref, distance, valid, edge, box, baseline)
    if kind == 'quad' and metric is baseline:
        # The outer quad edges do not beat the declared geometry (straight panel edges are already
        # visible), but CORNER evidence is independent: a scalar/round declared preset with a cut
        # corner must still be re-encoded. Retain only when the baseline boundary is trustworthy and
        # no corner model was measured.
        baseline_ok = metric['support'] >= .6 and metric['p95'] <= 6 \
            and min((best.max(axis=0) - best.min(axis=0)).tolist()) >= 4
        properties, corners = quad_properties(e, best, distance, valid)
        measured_corner = any(corner['type'] != 'sharp' for corner in corners)
        if baseline_ok and (measured_corner or thin is not None or metric['support']>=.8 and metric['p95']<=3):
            return {'key': e['key'], 'status': 'accepted', 'family': kind,
                    'properties': properties, 'locatedDot': located_dot,'cornerEvidence':corners,
                    'metrics': metric, 'before': baseline,
                    'elapsedMs': round((time.perf_counter()-started)*1000, 1)}
        return {'key': e['key'], 'status': 'retained', 'family': kind, 'properties': {},
                'locatedDot': located_dot, 'metrics': metric, 'before': baseline,
                'elapsedMs': round((time.perf_counter()-started)*1000, 1)}
    x, y = best.min(axis=0)
    w, h = best.max(axis=0)-[x, y]
    accepted = metric['support'] >= .6 and metric['p95'] <= 6 and min(w, h) >= 4
    if kind == 'quad':
        polygon_area = abs(float(np.dot(best[:, 0], np.roll(best[:, 1], -1))
                                 - np.dot(best[:, 1], np.roll(best[:, 0], -1))))*.5
        thin = min(box[2], box[3]) < .45 * max(box[2], box[3])
        low, high = (.4, 2.5) if thin else (.6, 1.6)
        accepted = accepted and polygon_area >= w*h*.25 and by_ratio(box[2], w, low, high) \
            and by_ratio(box[3], h, low, high)
    if kind == 'hexagon':
        properties = {'x': round(float(x), 3), 'y': round(float(y), 3),
                      'w': round(float(w), 3), 'h': round(float(h), 3),
                      'type': 'shape', 'shape': 'hexagon', 'shapeGeometry': None,
                      'adjustments': None, 'flipH': False, 'flipV': False}
        properties['customGeometry'] = ({'points': [[.5,0],[1,.25],[1,.75],[.5,1],[0,.75],[0,.25]],
                                         'closed': True} if e.get('_hexVertical') else None)
    elif kind == 'ellipse':
        properties = {'x': round(float(x), 3), 'y': round(float(y), 3),
                      'w': round(float(w), 3), 'h': round(float(h), 3),
                      'type': 'ellipse', 'shape': 'ellipse', 'shapeGeometry': None,
                      'customGeometry': None, 'adjustments': None,
                      'flipH': False, 'flipV': False}
    else:
        properties, _corners = quad_properties(e, best, distance, valid)
        properties.update(x=round(float(x), 3), y=round(float(y), 3),
                          w=round(float(w), 3), h=round(float(h), 3))
    return {'key': e['key'], 'status': 'accepted' if accepted else 'retained',
            'family': kind, 'properties': properties if accepted else {},
            **({'cornerEvidence':_corners} if kind=='quad' else {}),
            'locatedDot': located_dot, 'metrics': metric, 'before': baseline,
            'elapsedMs': round((time.perf_counter()-started)*1000, 1)}


def by_ratio(original, measured, low, high):
    original = max(1e-6, float(original))
    return low <= float(measured) / original <= high


SLANT_GROUP_MAX_DELTA = 2.0


def _line_slant_from_properties(properties):
    width = max(0.0, float(properties.get('w', 0) or 0))
    height = max(0.0, float(properties.get('h', 0) or 0))
    if width <= 0 and height <= 0:
        return None
    angle = math.degrees(math.atan2(height, width))
    visual_dx = -width if properties.get('flipH') else width
    visual_dy = -height if properties.get('flipV') else height
    product = visual_dx * visual_dy
    sign = 0 if product == 0 else (1 if product > 0 else -1)
    return {'family': 'line', 'angle': angle, 'sign': sign}


def _quad_slant_from_properties(properties):
    shape = str(properties.get('shape') or '').lower()
    if shape == 'parallelogram':
        geometry = properties.get('shapeGeometry') or {}
        try:
            angle = float(geometry.get('slantAngle'))
        except (TypeError, ValueError):
            return None
        if not np.isfinite(angle):
            return None
        width, height = float(properties['w']), float(properties['h'])
        depth = min(.49, height / math.tan(math.radians(max(5., min(85., angle)))) / width)
        return {'family': 'parallelogram', 'angle': math.degrees(math.atan2(height, depth * width)),
                'sign': 1 if geometry.get('slantSign') == -1 else -1}
    if shape not in ('trapezoid', 'freeform'):
        return None
    commands=(properties.get('customGeometry') or {}).get('commands')
    if commands:
        # Rounded parallelograms retain their corner curves. Long straight side
        # segments, not the curve control handles, define the slope evidence.
        sides=[];current=first=None
        for command in commands:
            op=command.get('op');points=command.get('points') or []
            end=points[-1] if points else first if op=='Z' else None
            if op in ('L','Z') and current is not None and end is not None:
                dx=(end[0]-current[0])*properties['w'];dy=(end[1]-current[1])*properties['h']
                angle=math.degrees(math.atan2(abs(dy),abs(dx)))
                if abs(dy)>=properties['h']*.5 and 5<=angle<=85:
                    sides.append({'angle':angle,'sign':1 if dx*dy>0 else -1})
            if op=='M':first=end
            if end is not None:current=end
        if len(sides)==2 and sides[0]['sign']==sides[1]['sign'] and abs(sides[0]['angle']-sides[1]['angle'])<=.75:
            return {'family':'parallelogram','angle':sum(s['angle'] for s in sides)/2,
                    'sign':sides[0]['sign'],'parallelCommands':True}
        return None
    if shape == 'trapezoid' and not properties.get('customGeometry'):
        points = prototype(properties, [properties[k] for k in ('x','y','w','h')], 'quad')
        dx = abs(points[3,0]-points[0,0])
        angle = math.degrees(math.atan2(properties['h'], dx))
        return {'family':'trapezoid','angle':angle,'sign':0,'symmetric':True}
    points = (properties.get('customGeometry') or {}).get('points')
    if not isinstance(points, list) or len(points) != 4:
        return None
    try:
        points = np.asarray(points, float)
    except (TypeError, ValueError):
        return None
    width, height = float(properties.get('w', 0) or 0), float(properties.get('h', 0) or 0)
    if width <= 0 or height <= 0:
        return None
    slanted = []
    for index in range(4):
        first, second = points[index], points[(index + 1) % 4]
        dx = abs(second[0] - first[0]) * width
        dy = abs(second[1] - first[1]) * height
        if dy < 2 or dx < 1:
            continue
        angle = math.degrees(math.atan2(dy, dx)) if dx > 0 else 90.0
        if angle < 5 or angle > 85:
            continue
        upper, lower = (first, second) if first[1] <= second[1] else (second, first)
        slanted.append({'index': index, 'points': points, 'upper': upper, 'lower': lower,
                        'angle': angle, 'sign': 1 if lower[0] >= upper[0] else -1})
    if len(slanted)==2 and slanted[0]['sign']!=slanted[1]['sign'] and abs(slanted[0]['angle']-slanted[1]['angle'])<=.75:
        return {'family':'trapezoid','angle':sum(side['angle'] for side in slanted)/2,
                'sign':0,'symmetric':True,'points':points}
    if len(slanted)==2 and slanted[0]['sign']==slanted[1]['sign'] and abs(slanted[0]['angle']-slanted[1]['angle'])<=.75:
        return {'family':'parallelogram','angle':sum(side['angle'] for side in slanted)/2,
                'sign':slanted[0]['sign'],'points':points,'parallelCustom':True,
                'sideIndices':[side['index'] for side in slanted]}
    if len(slanted) != 1:
        return None
    side = slanted[0]
    return {'family': 'trapezoid', 'angle': side['angle'], 'sign': side['sign'],
            'points': points, 'sideIndex': side['index'], 'upperIndex': int(np.where(
                np.all(points == side['upper'], axis=1))[0][0]), 'lowerIndex': int(np.where(
                np.all(points == side['lower'], axis=1))[0][0])}


def _measured_slant(row):
    if row.get('status') not in ('accepted','retained'):
        return None
    properties = row.get('properties') or {}
    if row.get('family') == 'line':
        return _line_slant_from_properties(properties)
    descriptor = _quad_slant_from_properties(properties)
    return descriptor


def _quad_polygon(properties):
    x, y = float(properties.get('x', 0)), float(properties.get('y', 0))
    width, height = float(properties.get('w', 0) or 0), float(properties.get('h', 0) or 0)
    if width <= 0 or height <= 0:
        return None
    if (properties.get('customGeometry') or {}).get('commands'):
        points=seed_polygon(properties)
        return np.asarray(points,float) if points else None
    if properties.get('shape') == 'trapezoid' and not properties.get('customGeometry'):
        return prototype(properties,[x,y,width,height],'quad')
    shape = str(properties.get('shape') or '').lower()
    if shape == 'parallelogram':
        geometry = properties.get('shapeGeometry') or {}
        try:
            angle = float(geometry.get('slantAngle'))
        except (TypeError, ValueError):
            return None
        sign = -1 if geometry.get('slantSign') == -1 else 1
        a = min(.49, max(.005, height / math.tan(math.radians(max(5.0, min(85.0, angle)))) / width))
        points = ([[0, 0], [1 - a, 0], [1, 1], [a, 1]] if sign < 0
                  else [[a, 0], [1, 0], [1 - a, 1], [0, 1]])
        return np.asarray(points, float) * [width, height] + [x, y]
    points = (properties.get('customGeometry') or {}).get('points')
    if not isinstance(points, list) or len(points) != 4:
        return None
    try:
        points = np.asarray(points, float)
    except (TypeError, ValueError):
        return None
    if not np.all(np.isfinite(points)):
        return None
    return points * [width, height] + [x, y]


def _row_boundary_metric(row, properties=None):
    properties = properties or row.get('properties') or {}
    if row.get('family') == 'line':
        x, y = float(properties.get('x', 0) or 0), float(properties.get('y', 0) or 0)
        width, height = float(properties.get('w', 0) or 0), float(properties.get('h', 0) or 0)
        start = np.array([x+width if properties.get('flipH') else x,
                          y+height if properties.get('flipV') else y])
        end = np.array([x if properties.get('flipH') else x+width,
                        y if properties.get('flipV') else y+height])
        points=np.linspace(start,end,64)
        xx=np.clip(np.rint(points[:,0]).astype(int),0,WIDTH-1)
        yy=np.clip(np.rint(points[:,1]).astype(int),0,HEIGHT-1)
        usable=_VALID_FIELD[yy,xx]
        if usable.sum()<24:return None
        values=_DISTANCE_FIELD[yy[usable],xx[usable]]
        return {'p95':float(np.percentile(values,90)), 'support':float((values<=2.5).mean()),
                'cost':float(np.minimum(values,15).mean())}
    polygon = _quad_polygon(properties)
    if polygon is None:
        return None
    return score(polygon, _DISTANCE_FIELD, _VALID_FIELD)


def _merged_slant_properties(row, descriptor, angle):
    properties = dict(row.get('properties') or {})
    family = descriptor['family']
    if family == 'line':
        width, height = max(0.0, float(properties.get('w', 0) or 0)), max(0.0, float(properties.get('h', 0) or 0))
        length = math.hypot(width, height)
        if length <= 0:
            return None
        middle_x, middle_y = float(properties.get('x', 0)) + width * .5, float(properties.get('y', 0)) + height * .5
        target = max(0.0, min(90.0, angle))
        new_width = 0.0 if target >= 89.95 else length * math.cos(math.radians(target))
        new_height = 0.0 if target <= .05 else length * math.sin(math.radians(target))
        new_x, new_y = middle_x - new_width * .5, middle_y - new_height * .5
        if new_x < -0.01 or new_y < -0.01 or new_x + new_width > WIDTH + .01 or new_y + new_height > HEIGHT + .01:
            return None
        properties['x'] = round(float(new_x), 3)
        properties['y'] = round(float(new_y), 3)
        properties['w'] = round(float(new_width), 3)
        properties['h'] = round(float(new_height), 3)
        return properties
    if family == 'parallelogram':
        target = max(5.0, min(85.0, angle))
        depth = float(properties.get('h', 0) or 0) / math.tan(math.radians(target)) / max(1e-6, float(properties.get('w', 0) or 0))
        if depth < .005 or depth > .49:
            return None
        if descriptor.get('parallelCommands'):
            old=descriptor['sign']/math.tan(math.radians(descriptor['angle']))
            new=descriptor['sign']/math.tan(math.radians(target))
            delta=(new-old)*properties['h']/properties['w']
            commands=[]
            for command in properties['customGeometry']['commands']:
                points=[]
                for x,y in command.get('points') or []:
                    # For each side keep its outermost endpoint fixed. Every
                    # curve handle receives the same side shear as its anchors.
                    pivot=(0 if x>=.5 else 1) if descriptor['sign']<0 else (1 if x>=.5 else 0)
                    xx=x+delta*(y-pivot)
                    if xx<-.00001 or xx>1.00001:return None
                    points.append([round(min(1,max(0,xx)),6),y])
                commands.append({**command,'points':points})
            properties['customGeometry']={**properties['customGeometry'],'commands':commands}
            return properties
        if descriptor.get('parallelCustom'):
            points=np.asarray(descriptor['points'],float).copy()
            for index in descriptor['sideIndices']:
                first,second=index,(index+1)%4
                upper,lower=(first,second) if points[first,1]<points[second,1] else (second,first)
                dx=descriptor['sign']*abs(points[lower,1]-points[upper,1])*depth
                if min(abs(points[upper,0]),abs(points[upper,0]-1))<.02:
                    points[lower,0]=points[upper,0]+dx
                else:points[upper,0]=points[lower,0]-dx
            if np.any(points[:,0]<0) or np.any(points[:,0]>1):return None
            properties['customGeometry']={'points':np.round(points,5).tolist(),'closed':True}
            return properties
        properties['shapeGeometry'] = {**(properties.get('shapeGeometry') or {}),'slantAngle': round(target, 1),
                                       'slantSign': -descriptor['sign']}
        return properties
    if family == 'trapezoid':
        target = max(5.0, min(85.0, angle))
        if descriptor.get('symmetric'):
            if 'points' in descriptor:
                points=np.asarray(descriptor['points'],float).copy()
                top=np.argsort(points[:,1])[:2];bottom=np.argsort(points[:,1])[2:]
                top=top[np.argsort(points[top,0])];bottom=bottom[np.argsort(points[bottom,0])]
                inset=float(properties['h'])/math.tan(math.radians(target))/float(properties['w'])
                if not 0<inset<.49:return None
                if points[top[1],0]-points[top[0],0]<points[bottom[1],0]-points[bottom[0],0]:
                    points[top[0],0]=inset;points[top[1],0]=1-inset
                else:
                    points[bottom[0],0]=inset;points[bottom[1],0]=1-inset
                properties['customGeometry']={'points':np.round(points,5).tolist(),'closed':True}
                return properties
            properties['shapeGeometry']={**(properties.get('shapeGeometry') or {}),'slantAngle':round(target,1)}
            return properties
        points = np.asarray(descriptor['points'], float).copy()
        width, height = float(properties.get('w', 0) or 0), float(properties.get('h', 0) or 0)
        if width <= 0 or height <= 0:
            return None
        upper_index, lower_index = descriptor['upperIndex'], descriptor['lowerIndex']
        upper, lower = points[upper_index], points[lower_index]
        vertical_pixels = abs(lower[1] - upper[1]) * height
        target_dx_pixels = vertical_pixels / math.tan(math.radians(target))
        if target_dx_pixels <= 0:
            return None
        target_dx = descriptor['sign'] * target_dx_pixels / width
        fixed_upper = abs(upper[0] - 0) <= .02 or abs(upper[0] - 1) <= .02
        fixed_lower = abs(lower[0] - 0) <= .02 or abs(lower[0] - 1) <= .02
        if not fixed_upper and not fixed_lower:
            return None
        if fixed_upper and fixed_lower:
            # Keep the endpoint farther from the other axis extreme as the moving endpoint.
            fixed_upper = abs(upper[0] - round(upper[0])) <= abs(lower[0] - round(lower[0]))
        if fixed_upper:
            new_lower_x = upper[0] + target_dx
            if new_lower_x < 0 or new_lower_x > 1:
                return None
            points[lower_index, 0] = new_lower_x
        else:
            new_upper_x = lower[0] - target_dx
            if new_upper_x < 0 or new_upper_x > 1:
                return None
            points[upper_index, 0] = new_upper_x
        if (points[lower_index, 0] - points[upper_index, 0]) * descriptor['sign'] <= 0:
            return None
        properties['customGeometry'] = {'points': np.round(points, 5).tolist(), 'closed': True}
        return properties
    return None


_DISTANCE_FIELD = None
_VALID_FIELD = None


def merge_measured_slant_groups(results, distance, valid, target_keys, originals=None):
    """Bounded S3 measured-slant joint fit. Near screen-space slopes share direction across families;
    positions, widths/heights (quads), line midpoints/lengths, corners and colors stay untouched."""
    global _DISTANCE_FIELD, _VALID_FIELD
    _DISTANCE_FIELD, _VALID_FIELD = distance, valid
    targets = set(target_keys or [])
    originals=originals or {}
    candidates = []
    for row in results:
        if row.get('key') not in targets:
            continue
        original=originals.get(row['key'],{})
        if original.get('managed') or original.get('effectOf') or 'slant' in original.get('keepParameters',[]):continue
        if any(r.get('parameter')=='slant' for r in original.get('recognitionRejections',[])):continue
        if row.get('status')=='retained':
            metric=row.get('metrics') or {}
            if row.get('family')=='line' and not metric:
                metric=_row_boundary_metric({'family':'line','properties':original}) or {}
            if metric.get('support',0)<.85 or metric.get('p95',99)>2.5:continue
            row['properties']={key:value for key,value in original.items() if key in (
                'x','y','w','h','type','shape','shapeGeometry','customGeometry','flipH','flipV','rotate','adjustments')}
        descriptor = _measured_slant(row)
        if descriptor:
            candidates.append((row, descriptor))
    candidates.sort(key=lambda item: (item[1]['sign'], item[1]['angle'],
                                     str(item[0].get('key'))))
    scopes={}
    for row,descriptor in candidates:
        original=originals.get(row['key'],{})
        label=(original.get('parameterGroups') or {}).get('slant')
        scope=(descriptor['family'] if descriptor['sign']==0 else 'edge',descriptor['sign'],
               'explicit' if label else 'local',label or '')
        scopes.setdefault(scope,[]).append((row,descriptor))
    groups=[]
    for scope,members in scopes.items():
        used=set()
        for row,descriptor in members:
            if row['key'] in used:continue
            cluster=[(row,descriptor)];used.add(row['key'])
            for other,slant in members:
                if other['key'] in used:continue
                if any(abs(slant['angle']-own['angle'])>SLANT_GROUP_MAX_DELTA for _,own in cluster):continue
                nearby=True
                if scope[2]=='local':
                    for peer,_ in cluster:
                        a,b=peer['properties'],other['properties']
                        gap_x=max(a['x']-b['x']-b['w'],b['x']-a['x']-a['w'],0)
                        gap_y=max(a['y']-b['y']-b['h'],b['y']-a['y']-a['h'],0)
                        if max(gap_x,gap_y)>max(120,min(max(a['w'],a['h']),max(b['w'],b['h']))*2):nearby=False;break
                if nearby:cluster.append((other,slant));used.add(other['key'])
            if len(cluster)>=2:groups.append(cluster)
    for group_index, group in enumerate(groups):
        angles = sorted(float(item[1]['angle']) for item in group)
        sources=[(row,d) for row,d in group if row.get('status')=='accepted' or not (originals.get(row['key'],{}).get('parameterEvidence') or {}).get('slant',{}).get('inherited')]
        weights=[max(0.,float((row.get('metrics') or _row_boundary_metric(row) or {}).get('support',0)))*(1-min(.8,float((row.get('metrics') or {}).get('p95',0))/10)) for row,_ in sources]
        reliable=[(item,w) for item,w in zip(sources,weights) if w>=.55]
        if not reliable:continue
        representative = weighted_median([item[1]['angle'] for item,w in reliable],[w for item,w in reliable])
        representative = round(representative, 1)
        if group[0][1]['family'] == 'line':
            representative = max(0.0, min(90.0, representative))
        else:
            representative = max(5.0, min(85.0, representative))
        proposals = []
        accepted = True
        old_cost = new_cost = 0.0
        for row, descriptor in group:
            merged = _merged_slant_properties(row, descriptor, representative)
            if merged is None:
                accepted = False
                break
            old_metric = _row_boundary_metric(row)
            new_metric = _row_boundary_metric(row, merged)
            if not old_metric or not new_metric:
                accepted = False
                break
            if (new_metric['p95'] > old_metric['p95'] + .9
                    or new_metric['support'] < old_metric['support'] - .1
                    or new_metric['cost'] > old_metric['cost'] + .6):
                accepted = False
                break
            proposals.append((row, descriptor, merged))
            old_cost += old_metric['cost']
            new_cost += new_metric['cost']
        spread = angles[-1] - angles[0]
        if not accepted:
            continue
        # Only near-noise changes or a clear boundary improvement are applied.
        if spread > .75 and old_cost - new_cost < .15:
            continue
        families={d['family'] for _,d in group}
        family = next(iter(families)) if len(families)==1 else 'mixed'
        evidence = {'group': 'slant-%s-%s-%d-%d' % (family, 'neg' if group[0][1]['sign'] < 0
                                                else 'pos' if group[0][1]['sign'] > 0 else 'axis',
                                                round(representative * 10),group_index),
                    'angle': representative, 'family': family, 'sign': group[0][1]['sign'],
                    'memberKeys': [str(row.get('key')) for row, _d, _m in proposals],
                    'maxDelta': round(spread, 2), 'boundaryChecked': True,
                    'source': 'S3-measured-joint-slant'}
        for row, descriptor, merged in proposals:
            row['properties'] = merged
            row['status']='accepted'
            row['slantEvidence'] = evidence
            row.setdefault('parameterEvidence',{})['slant']=provenance([item[0]['key'] for item,w in reliable],max(w for item,w in reliable))
    return results


def main():
    started = time.perf_counter()
    spec = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    ref = load(spec['reference'])
    lab = cv2.cvtColor(ref, cv2.COLOR_BGR2LAB)
    dx = cv2.Sobel(lab.astype(np.float32), cv2.CV_32F, 1, 0, ksize=3)
    dy = cv2.Sobel(lab.astype(np.float32), cv2.CV_32F, 0, 1, ksize=3)
    strength = np.sqrt(np.sum(dx*dx + dy*dy, axis=2))
    edge = (strength > 70).astype(np.uint8)*255
    distance = cv2.distanceTransform(255-edge, cv2.DIST_L2, 3)
    valid = np.ones((HEIGHT, WIDTH), bool)
    for e in spec.get('elements', []):
        if e.get('type') not in ('text', 'formula', 'image', 'svg', 'cutout'):
            continue
        x, y, w, h = [float(e.get(k, 0)) for k in ('x', 'y', 'w', 'h')]
        valid[max(0,int(y)-2):min(HEIGHT,int(y+h)+2), max(0,int(x)-2):min(WIDTH,int(x+w)+2)] = False
    keys = set(spec.get('targetKeys') or [])
    results = []
    line_keys={e['key'] for e in spec.get('elements',[]) if e.get('type')=='line' and e.get('key') in keys}
    if line_keys:
        proposals, line_diagnostics = fit_native_lines(cv2.cvtColor(ref,cv2.COLOR_BGR2RGB),spec['elements'],None,line_keys)
        for proposal in proposals:
            properties={key:value for key,value in (proposal.get('properties') or {}).items()
                        if key in ('x','y','w','h','flipH','flipV')}
            if max(float(properties.get('w', 0)), float(properties.get('h', 0))) < 4:
                results.append({'key': proposal['key'], 'status': 'retained', 'family': 'line',
                                'properties': {}, 'reason': 'degenerate-line-proposal'})
                continue
            results.append({'key':proposal['key'],'status':'accepted','family':'line','properties':properties,
                            'metrics':{'p95':proposal.get('medianResidual'),'support':proposal.get('support')}})
        proposed={row['key'] for row in results}
        # A line already agreeing with the reference still supplies boundary
        # evidence to a shared slope; the joint validator decides whether to keep it.
        reasons={d['key']:d.get('reason') for d in line_diagnostics}
        results.extend({'key':key,'status':'retained','family':'line','properties':{},'reason':reasons.get(key,'line-not-observable')}
                       for key in sorted(line_keys-proposed))
    for e in spec.get('elements', []):
        if e.get('key') in keys and e.get('type')!='line':
            try:
                formula_carrier=False
                if family(e)=='quad':
                    for other in spec.get('elements',[]):
                        if other.get('type')!='formula':continue
                        enclosing=[carrier for carrier in spec.get('elements',[]) if family(carrier)=='quad'
                            and other['x']>=carrier['x']-4 and other['x']+other['w']<=carrier['x']+carrier['w']+4
                            and other['y']>=carrier['y']-4 and other['y']+other['h']<=carrier['y']+carrier['h']+4]
                        if enclosing and min(enclosing,key=lambda carrier:carrier['w']*carrier['h'])['key']==e['key']:formula_carrier=True
                local_valid=valid
                if formula_carrier:
                    local_valid=valid.copy();local_valid[max(0,int(e['y']-50)):min(HEIGHT,int(e['y']+e['h']+50)),max(0,int(e['x']-5)):min(WIDTH,int(e['x']+e['w']+5))]=True
                panel=match_panel(e,(spec.get('structural') or {}).get('panels',[]))
                badge=e.get('type')=='ellipse' and any(other.get('role')=='visual-number'
                    and e['x']<=other['x']+other['w']/2<=e['x']+e['w'] and e['y']<=other['y']+other['h']/2<=e['y']+e['h'] for other in spec.get('elements',[]))
                circle=e.get('shape')=='circle' or e['key'] in {k for group in spec.get('circleGroups',[]) for k in group['keys']} or max(e['w'],e['h'])/max(1,min(e['w'],e['h']))<=1.18
                results.append(fit({**e,'_formulaCarrier':formula_carrier,'_structuralPanel':panel,'_badge':badge,'_circle':circle}, ref, distance, strength, local_valid))
            except Exception as error:
                results.append({'key': e['key'], 'status': 'retained', 'error': str(error)[:250]})
    # Table icon rows are an explicit repeated-shape group. Share size only after each member's
    # local evidence supports that size; fills remain independently sampled orange/cyan groups.
    originals = {e['key']: e for e in spec.get('elements', [])}
    groups = {}
    for row in results:
        e = originals.get(row['key'], {})
        if row.get('family')=='hexagon' and row.get('status')=='accepted' and e.get('tableRole')=='icon':
            groups.setdefault(e.get('tableId'), []).append(row)
    for _, members in groups.items():
        if len(members)<2:
            continue
        located={}
        for row in members:
            original=originals[row['key']]
            box=locate_coloured_dot(original,ref,np.asarray([original[k] for k in ('x','y','w','h')],float))
            p=row['properties']
            located[row['key']]=box if box is not None else np.asarray([p[k] for k in ('x','y','w','h')])
        scores=[]
        for orientation in (False,True):
            observed=[score(prototype({**originals[row['key']],'_hexVertical':orientation},located[row['key']],'hexagon'),distance,valid) for row in members]
            if all(item is not None for item in observed):scores.append((sum(item['cost'] for item in observed),orientation))
        vertical=min(scores)[1] if scores else False
        for row in members:
            row['properties'].update(zip(('x','y','w','h'),located[row['key']].tolist()))
        widths, heights = [row['properties']['w'] for row in members], [row['properties']['h'] for row in members]
        weights=[max(0.,float((row.get('metrics') or {}).get('support',0)))*(1-min(.8,float((row.get('metrics') or {}).get('p95',0))/10)) for row in members]
        width,height=weighted_median(widths,weights),weighted_median(heights,weights)
        if width is None or height is None:continue
        if max(widths)-min(widths)>width*.25 or max(heights)-min(heights)>height*.25:
            continue
        for row in members:
            p = row['properties']
            trial = [p['x']+(p['w']-width)/2,p['y']+(p['h']-height)/2,width,height]
            observed = score(prototype({**originals[row['key']], '_hexVertical':vertical}, trial, 'hexagon'), distance, valid)
            if observed and observed['support']>=.6 and observed['p95']<=6:
                p.update(zip(('x','y','w','h'), [round(float(value),3) for value in trial]))
                p.update(customGeometry={'points':[[.5,0],[1,.25],[1,.75],[.5,1],[0,.75],[0,.25]],'closed':True} if vertical else None,
                         shapeGeometry=None,adjustments=None,flipH=False,flipV=False)
                row['sharedGeometry'] = True
                row.setdefault('parameterEvidence',{})['diameter']=provenance([m['key'] for m in members],max(weights))
    # Repeated circles share a measured diameter at their own centres. Small
    # raster boxes such as 9x10 and 10x9 are not intentional ellipses.
    by_key={row['key']:row for row in results}
    for group in spec.get('circleGroups',[]):
        members=[by_key[k] for k in group['keys'] if k in by_key and by_key[k].get('status')=='accepted' and by_key[k].get('family')=='ellipse'
                 and not any(p in originals[k].get('keepParameters',[]) for p in ('width','height','diameter'))]
        anchors=[originals[k] for k in group['keys'] if k in originals and k not in keys
                 and (originals[k].get('geometryEvidence') or {}).get('accepted')
                 and not (originals[k].get('parameterEvidence') or {}).get('diameter',{}).get('inherited')]
        anchor_sizes=[(e['w']+e['h'])/2 for e in anchors]
        anchored=len(anchor_sizes)>=1 and max(anchor_sizes)-min(anchor_sizes)<=max(1.,float(np.median(anchor_sizes))*.1)
        if not anchored and len(members)<2:continue
        diameter=weighted_median(anchor_sizes if anchored else [(r['properties']['w']+r['properties']['h'])/2 for r in members],
            [float((e.get('geometryEvidence') or {}).get('support',.8)) for e in anchors] if anchored else [float((r.get('metrics') or {}).get('support',0)) for r in members])
        if diameter is None:continue
        for row in members:
            p=row['properties'];trial=[p['x']+(p['w']-diameter)/2,p['y']+(p['h']-diameter)/2,diameter,diameter]
            observed=score(prototype(originals[row['key']],trial,'ellipse'),distance,valid)
            if observed and observed['support']>=.6 and observed['p95']<=6:
                p.update(zip(('x','y','w','h'),[round(float(v),3) for v in trial]));row['sharedGeometry']=True;row['sharedDiameter']=group['id']
            elif anchored:
                # A local repair cannot replace a verified shared diameter with
                # a different nearby dot. Retain the prior centre and diameter.
                original=originals[row['key']]
                row.update(status='retained',properties={'x':round(original['x']+(original['w']-diameter)/2,3),
                           'y':round(original['y']+(original['h']-diameter)/2,3),'w':round(diameter,3),'h':round(diameter,3)},sharedDiameter=group['id'])
        # One independent representative retains the raw measured diameter;
        # peers are inherited and cannot multiply its vote in a later refit.
        sources=[e['key'] for e in anchors] if anchored else [r['key'] for r in members]
        representative=max(members,key=lambda r:(r.get('metrics') or {}).get('support',0)) if members else None
        for row in members:
            if row.get('sharedDiameter'):
                row.setdefault('parameterEvidence',{})['diameter']=(
                    {'confidence':.85,'independent':True,'source':'reference-boundary','observationId':group['id']+':diameter'}
                    if row is representative and not anchored else provenance(sources,.85))
        for key in group['keys']:
            row=by_key.get(key);original=originals.get(key,{})
            if not row or row in members or any(p in original.get('keepParameters',[]) for p in ('width','height','diameter')):continue
            if abs((original.get('w',0)+original.get('h',0))/2-diameter)>max(1,diameter*.1):continue
            # Boundary-poor peers can share only the already-supported group
            # diameter. Keep their own centres and unresolved-position evidence.
            row['properties']={'x':round(original['x']+(original['w']-diameter)/2,3),
                               'y':round(original['y']+(original['h']-diameter)/2,3),
                               'w':round(diameter,3),'h':round(diameter,3)}
            row['sharedDiameter']=group['id']
            row.setdefault('parameterEvidence',{})['diameter']=provenance([e['key'] for e in anchors] if anchored else [r['key'] for r in members],.8)
    # Explicit shape equivalence owns the whole corner signature; paint/slant groups do not.
    corner_groups={}
    for key,original in originals.items():
        labels=original.get('parameterGroups') or {}
        label=labels.get('shape') or labels.get('geometry') or labels.get('corners')
        if label and key in by_key:corner_groups.setdefault(label,[]).append(by_key[key])
    for label,rows in corner_groups.items():
        sources=[r for r in rows if r.get('status')=='accepted' and len(r.get('cornerEvidence',[]))==4
                 and float((r.get('metrics') or {}).get('support',0))*(1-min(.6,float((r.get('metrics') or {}).get('p95',0))/12))>=.55]
        if not sources:continue
        source=max(sources,key=lambda r:float((r.get('metrics') or {}).get('support',0))/(1+float((r.get('metrics') or {}).get('p95',0))))
        corners=((source.get('properties') or {}).get('shapeGeometry') or {}).get('corners')
        if not corners:continue
        for row in rows:
            original=originals[row['key']]
            if 'corners' in original.get('keepParameters',[]):continue
            props=row.setdefault('properties',{})
            shape_shared=bool((original.get('parameterGroups') or {}).get('shape') or (original.get('parameterGroups') or {}).get('geometry'))
            if shape_shared:
                props['shape']=source['properties']['shape']
                props['customGeometry']=source['properties'].get('customGeometry')
            else:props.setdefault('shape',original.get('shape'))
            props['shapeGeometry']={**(props.get('shapeGeometry') or {}),'version':2,'corners':corners}
            row['sharedCorners']=label
            row.setdefault('parameterEvidence',{})['corners']=provenance([source['key']],.85)
    # Bounded S3 measured-slant joint fit: only near slopes of the same family/direction, never
    # positions/widths/heights/fonts; S3 result owns the merged slope so S6 must not rewrite it.
    merge_measured_slant_groups(results, distance, valid, keys, originals)
    output = {'status': 'available', 'results': results, 'elapsedMs': round((time.perf_counter()-started)*1000, 1)}
    Path(sys.argv[2]).write_text(json.dumps(output, ensure_ascii=False, indent=1), encoding='utf-8')
    print(json.dumps({'status': 'available', 'elapsedMs': output['elapsedMs'], 'objects': len(results)}))


if __name__ == '__main__':
    main()
