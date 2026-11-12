"""Deterministic local irregular color-block reconstruction from a reference PNG.

The reference and registered background are compared in the existing 1600x900
scene space. Existing shape-like scene objects are seeds: a seed may only be
patched by a detected reference contour that matches its neighbourhood. Global
contours outside seeds are returned as omission evidence, never as new elements.

Usage: python tools/shape_reference.py spec.json output-directory
"""
import json
import math
import re
import sys
import time
import hashlib
from pathlib import Path

from occlusion_layers import visible_layer_candidates
import cv2
import numpy as np
from PIL import Image
from shape_paint import fit_shape_paint
from shape_primitives import classify_shape
from object_masks import object_alpha, mask_entries
from reference_background import registered_background
from native_frame_fit import frame_evidence, contour_path, sample_path

cv2.setNumThreads(1)
SCENE = (1600, 900)
MIN_AREA = 240
MAX_PAGE_AREA = .30
MAX_POINTS = 160
PRIMITIVE_CACHE = {}


def primitive_profile(contour, preferred=None):
    x,y,w,h=cv2.boundingRect(contour)
    simplified=cv2.approxPolyDP(contour,max(.6,cv2.arcLength(contour,True)*.003),True)[:,0,:].astype(np.float64)
    normalized=(simplified-[x,y])/[max(1,w-1),max(1,h-1)]
    aliases={'rect':['rectangle','roundedRectangle'],'roundRect':['rectangle','roundedRectangle'],'ellipse':['circle','ellipse'],
             'rightArrow':['shaftArrow','flatArrow','notchedArrow'],'leftArrow':['shaftArrow','flatArrow','notchedArrow'],
             'upArrow':['shaftArrow','flatArrow','notchedArrow'],'downArrow':['shaftArrow','flatArrow','notchedArrow'],'chevron':['notchedArrow']}
    allowed=list(dict.fromkeys(kind for item in preferred or [] for kind in aliases.get(item,[item])))
    def classify(value):
        p=classify_shape(value,allowed)
        fallback=bool(allowed and (p.get('kind')=='freeform' or p.get('score',0)<.985 or p.get('confidence',0)<.8))
        if fallback:p=classify_shape(value)
        p.setdefault('diagnostics',{}).update(preferredKinds=allowed,candidateFallback=fallback)
        return p
    key=hashlib.sha256(np.round(normalized,3).tobytes()+str((round(w/max(1,h),3),allowed)).encode()).hexdigest()
    if key not in PRIMITIVE_CACHE:
        profile=classify(contour)
        if profile.get('kind')!='freeform':
            alternate=classify(simplified.reshape(-1,1,2))
            stable=alternate.get('kind')==profile.get('kind')
            profile.setdefault('diagnostics',{})['scaleAgreement']={'original':profile.get('kind'),'simplified':alternate.get('kind'),'stable':stable}
            if not stable:
                profile={**profile,'kind':'freeform','confidence':min(.5,profile.get('confidence',0)),'points':normalized.tolist(),
                    'diagnostics':{**profile.get('diagnostics',{}),'accepted':False,'reason':'轮廓简化前后类型不稳定，保留实测轮廓，不强套基础几何'}}
        PRIMITIVE_CACHE[key]=profile
    return {**PRIMITIVE_CACHE[key],'box':{'x':x,'y':y,'w':w,'h':h}}
SHAPE_NAMES = {'roundRect', 'plaque', 'triangle', 'rtTriangle', 'diamond', 'hexagon',
               'pentagon', 'chevron', 'parallelogram', 'trapezoid', 'rightArrow',
               'leftArrow', 'upArrow', 'downArrow', 'leftRightArrow', 'upDownArrow'}


def image(file, size):
    with Image.open(file) as source:
        source.load()
        return np.asarray(source.convert('RGB').resize(size, Image.Resampling.LANCZOS))


def delta(a, b):
    la = cv2.cvtColor(a.astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
    lb = cv2.cvtColor(b.astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
    return np.linalg.norm(la - lb, axis=2)


def hex_color(values):
    return ''.join(f'{int(round(float(v))):02X}' for v in values[:3])


def color_rgb(value):
    if not isinstance(value, str) or len(value.replace('#', '')) != 6:
        return None
    try:
        text = value.replace('#', '')
        return np.array([int(text[i:i + 2], 16) for i in (0, 2, 4)], np.float32)
    except (TypeError, ValueError):
        return None


def clamp(value, low=0.0, high=1.0):
    return max(low, min(high, float(value)))


def box_pixels(box):
    if isinstance(box, dict):
        x, y, w, h = (box.get(k, 0) for k in ('x', 'y', 'w', 'h'))
    else:
        x, y, w, h = box[:4]
    # The visual analysis contract uses scene coordinates (1600x900).
    left = int(round(float(x)))
    top = int(round(float(y)))
    right = int(round(float(x) + float(w)))
    bottom = int(round(float(y) + float(h)))
    return max(0, left), max(0, top), min(SCENE[0], right), min(SCENE[1], bottom)


def exclude_rects(spec, elements):
    boxes = []
    for box in spec.get('exclude', []) or []:
        boxes.append(box_pixels(box))
    # Text/image/line/table/formula content is semantic evidence, not a color
    # block. Managed progress/footer objects are owned by the native navigation
    # pipeline. Removing their boxes creates holes for overlay text, which are
    # filled by the external contour of a supporting block below.
    for element in elements:
        if not isinstance(element, dict):
            continue
        kind = str(element.get('type') or '')
        managed = str(element.get('managed') or '')
        role = str(element.get('role') or '')
        if kind in ('text', 'image', 'line', 'table', 'formula') or managed in ('progress', 'footer') or role in ('navigation', 'formula'):
            boxes.append(box_pixels(element))
    return boxes


def fill_holes(mask):
    """Fill enclosed holes without closing concavities of the outer shape."""
    if not mask.any():
        return mask
    flood = mask.copy()
    canvas = np.zeros((mask.shape[0] + 2, mask.shape[1] + 2), np.uint8)
    cv2.floodFill(flood, canvas, (0, 0), 2)
    holes = (flood == 0).astype(np.uint8) * 255
    return np.maximum(mask, holes)


def foreground_mask(ref, bg, boxes):
    difference = delta(ref, bg)
    values = difference.reshape(-1)
    median = float(np.median(values))
    mad = float(np.median(np.abs(values - median)))
    threshold = float(np.clip(median + 3 * mad, 10, 30))
    mask = (difference > threshold).astype(np.uint8) * 255
    for left, top, right, bottom in boxes:
        mask[max(0, top):min(SCENE[1], bottom), max(0, left):min(SCENE[0], right)] = 0
    mask = cv2.medianBlur(mask, 3)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    return difference, mask, threshold


# Seed shapes mirror native-shapes.mjs and directional-geometry.mjs. Keeping the
# seed footprint in this local tool avoids changing the JS-owned registry.
def preset_points(name, width, height, element):
    p = {
        'triangle': [[.5, 0], [1, 1], [0, 1]],
        'rtTriangle': [[0, 0], [1, 1], [0, 1]],
        'diamond': [[.5, 0], [1, .5], [.5, 1], [0, .5]],
        'hexagon': [[.25, 0], [.75, 0], [1, .5], [.75, 1], [.25, 1], [0, .5]],
        'pentagon': [[.5, 0], [1, .38], [.81, 1], [.19, 1], [0, .38]],
        'chevron': [[0, 0], [.75, 0], [1, .5], [.75, 1], [0, 1], [.25, .5]],
        'parallelogram': [[.25, 0], [1, 0], [.75, 1], [0, 1]],
        'trapezoid': [[.2, 0], [.8, 0], [1, 1], [0, 1]],
    }
    if name == 'hexagon' and isinstance(element.get('adjustments'), dict) and element['adjustments'].get('adj') is not None:
        inset = min(.5, min(width, height) * float(element['adjustments']['adj']) / 100000 / max(1, width))
        p['hexagon'] = [[inset, 0], [1 - inset, 0], [1, .5], [1 - inset, 1], [inset, 1], [0, .5]]
    if name == 'chevron':
        adjustment = float((element.get('adjustments') or {}).get('adj', 50000))
        notch = min(.5, min(width, height) * adjustment / 100000 / max(1, width))
        p['chevron'] = [[0, 0], [1 - notch, 0], [1, .5], [1 - notch, 1], [0, 1], [notch, .5]]
    geometry=element.get('shapeGeometry') or {}
    if name in ('hexagon','parallelogram','trapezoid') and geometry:
        a=geometry.get('headDepth')
        if geometry.get('slantAngle') is not None:
            a=(height/2 if name=='hexagon' else height)/math.tan(math.radians(geometry['slantAngle']))/width
        if a is not None:
            a=clamp(a,.005,.49)
            p[name]=([[a,0],[1-a,0],[1,.5],[1-a,1],[a,1],[0,.5]] if name=='hexagon' else [[a,0],[1,0],[1-a,1],[0,1]] if name=='parallelogram' else [[a,0],[1-a,0],[1,1],[0,1]])
            if name=='parallelogram' and geometry.get('slantSign',1)<0:p[name]=[[0,0],[1-a,0],[1,1],[a,1]]
    if name=='star5':
        inner=geometry.get('innerRadius',.381966);rotation=math.radians(geometry.get('rotation',0))
        vertices=np.array([[(inner if i%2 else 1)*math.cos(-math.pi/2+i*math.pi/5+rotation),(inner if i%2 else 1)*math.sin(-math.pi/2+i*math.pi/5+rotation)] for i in range(10)])
        p[name]=((vertices-vertices.min(0))/np.maximum(1e-9,vertices.max(0)-vertices.min(0))).tolist()
    return p.get(name)


def directional_points(element, width, height):
    tail = element.get('arrowTail')
    if tail not in ('flat', 'notched', 'shaft'):
        return None
    direction = element.get('arrowDirection') or {'leftArrow': 'left', 'upArrow': 'up', 'downArrow': 'down'}.get(element.get('shape'), 'right')
    length = height if direction in ('up', 'down') else width
    adjustments = element.get('adjustments') or {}
    adjustment = float(adjustments.get('adj' if tail == 'notched' else 'adj2', 50000))
    head = max(.01, min(.49, min(width, height) * adjustment / 100000 / max(1, length)))
    geometry=element.get('shapeGeometry') or {}
    if geometry.get('headDepth') is not None:head=clamp(geometry['headDepth'],.005,.49)
    if geometry.get('slantAngle') is not None:head=clamp((width if direction in ('up','down') else height)/2/math.tan(math.radians(geometry['slantAngle']))/length,.005,.49)
    notch=geometry.get('notchDepth',head)
    shaft = max(.01, min(.98, float(adjustments.get('adj1', 50000)) / 100000)) / 2
    if geometry.get('shaftRatio') is not None:shaft=geometry['shaftRatio']/2
    points = ([[0, 0], [1 - head, 0], [1, .5], [1 - head, 1], [0, 1], [notch, .5]] if tail == 'notched'
              else [[0, 0], [1 - head, 0], [1, .5], [1 - head, 1], [0, 1]] if tail == 'flat'
              else [[0, .5 - shaft], [1 - head, .5 - shaft], [1 - head, 0], [1, .5], [1 - head, 1], [1 - head, .5 + shaft], [0, .5 + shaft]])
    return [[1 - x, y] if direction == 'left' else [y, 1 - x] if direction == 'up' else [y, x] if direction == 'down' else [x, y] for x, y in points]


def custom_points(element, width, height):
    geometry = element.get('customGeometry') or {}
    if isinstance(geometry,dict) and geometry.get('commands'):
        parts=sample_path(geometry['commands'])
        return parts[0].tolist() if parts else None
    points = geometry.get('points') if isinstance(geometry, dict) else None
    if not isinstance(points, list) or len(points) < 3:
        return None
    values = []
    normalized = all(isinstance(p, (list, tuple)) and len(p) >= 2 and all(isinstance(v, (int, float)) and 0 <= v <= 1 for v in p[:2]) for p in points)
    for point in points:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            return None
        x, y = float(point[0]), float(point[1])
        values.append([x, y] if normalized else [(x - float(element.get('x', 0))) / max(1, width), (y - float(element.get('y', 0))) / max(1, height)])
    return values


def ellipse_points(count=64):
    return [[.5 + .5 * math.cos(2 * math.pi * i / count), .5 + .5 * math.sin(2 * math.pi * i / count)] for i in range(count)]


def seed_polygon(element):
    x, y, w, h = (float(element.get(k, 0)) for k in ('x', 'y', 'w', 'h'))
    if not all(math.isfinite(v) for v in (x, y, w, h)) or w <= 2 or h <= 2:
        return None
    kind = element.get('type')
    geometry=element.get('shapeGeometry') or {}
    if kind in ('shape','rect') and not element.get('customGeometry') and (geometry.get('corners') or geometry.get('cornerRadius') or geometry.get('cutCorner')):
        name=element.get('shape') or 'rect'
        points=preset_points(name,w,h,element) or [[0,0],[1,0],[1,1],[0,1]]
        vertices=np.asarray(points,float)*[w,h]
        corners=geometry.get('corners') or []
        out=[]
        for i,p in enumerate(vertices):
            a,b=vertices[i-1],vertices[(i+1)%len(vertices)]
            la,lb=np.linalg.norm(a-p),np.linalg.norm(b-p)
            u,v=(a-p)/max(1e-6,la),(b-p)/max(1e-6,lb)
            angle=math.acos(float(np.clip(np.dot(u,v),-1,1)))
            corner=corners[i] if i<len(corners) else {'type':'cut' if geometry.get('cutCorner') else 'round','radius':geometry.get('cornerRadius',.166667 if name=='roundRect' else 0),'distance':geometry.get('cutCorner',0)}
            size=(corner.get('radius',0)*min(w,h)/max(.01,math.tan(angle/2)) if corner['type']=='round'
                  else corner.get('distance',corner.get('cut',0))*min(w,h) if corner['type']=='cut' else 0)
            size=min(size,la*.45,lb*.45)
            entry,exit_=p+u*size,p+v*size
            out.append(entry+[x,y])
            if corner['type']=='round' and size>0:
                k=4/3*math.tan((math.pi-angle)/4)*size*math.tan(angle/2)
                c1,c2=entry-u*k,exit_-v*k
                out.extend((1-t)**3*entry+3*(1-t)**2*t*c1+3*(1-t)*t*t*c2+t**3*exit_+[x,y] for t in np.linspace(.1,1,10))
            elif corner['type']=='cut':out.append(exit_+[x,y])
        return [point.tolist() for point in out]
    if kind in ('rect', 'ellipse'):
        normalized = ellipse_points() if kind == 'ellipse' else [[0, 0], [1, 0], [1, 1], [0, 1]]
        return [[x + px * w, y + py * h] for px, py in normalized]
    if kind == 'shape':
        custom = custom_points(element, w, h)
        points = custom or directional_points(element, w, h) or preset_points(str(element.get('shape') or ''), w, h, element) or [[0, 0], [1, 0], [1, 1], [0, 1]]
        return [[x + px * w, y + py * h] for px, py in points]
    if kind == 'svg':
        frame = element.get('frameKind') or ''
        description = str(element.get('description') or '')
        custom = custom_points(element, w, h)
        points = custom
        if points is None and frame in SHAPE_NAMES:
            points = preset_points(frame, w, h, element)
        if points is None:
            points = [[0, 0], [1, 0], [1, 1], [0, 1]]
        return [[x + px * w, y + py * h] for px, py in points]
    return None


def is_seed(element):
    if not isinstance(element, dict) or not isinstance(element.get('key'), str):
        return False
    kind = element.get('type')
    managed = str(element.get('managed') or '')
    if managed in ('progress', 'footer'):
        return False
    if kind in ('shape', 'rect', 'ellipse'):
        return True
    if kind == 'svg':
        evidence = ' '.join(str(element.get(k) or '') for k in ('frameKind', 'description', 'key'))
        return bool(element.get('frameKind')) or bool(re.search(r'色块|color[-_ ]?block|填充块|filled[-_ ]?shape', evidence, re.I))
    return False


def fit_polygon(contour, origin):
    """Return normalized polygon points for a native custom polygon, max 160."""
    perimeter = cv2.arcLength(contour, True)
    approx = cv2.approxPolyDP(contour, max(.5, perimeter * .0015), True)
    points = approx[:, 0, :].astype(np.float64)
    if len(points) < 3:
        points = contour[:, 0, :].astype(np.float64)
    if len(points) > MAX_POINTS:
        sampled = cv2.resize(points.reshape(-1, 1, 2), (1, MAX_POINTS), interpolation=cv2.INTER_LINEAR)[:, 0, :]
        points = sampled.astype(np.float64)
    ox, oy, bw, bh = origin
    out = []
    for px, py in points:
        point = [round(clamp((px - ox) / max(1, bw)), 6), round(clamp((py - oy) / max(1, bh)), 6)]
        if not out or point != out[-1]:
            out.append(point)
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out if len(out) >= 3 else []


def contour_mask(contour, origin, size):
    mask = np.zeros((max(1, size[1]), max(1, size[0])), np.uint8)
    local = contour - np.array([[origin[0], origin[1]]])
    cv2.drawContours(mask, [local], -1, 255, -1)
    return mask


def polygon_mask(points, origin, size):
    mask = np.zeros((max(1, size[1]), max(1, size[0])), np.uint8)
    local = np.array([[[float(x) - origin[0], float(y) - origin[1]]] for x, y in points], np.int32)
    cv2.drawContours(mask, [local], -1, 255, -1)
    return mask


def polygon_iou(points, contour):
    xs = [float(p[0]) for p in points] + [float(p[0]) for p in contour[:, 0, :]]
    ys = [float(p[1]) for p in points] + [float(p[1]) for p in contour[:, 0, :]]
    ox, oy = math.floor(min(xs)), math.floor(min(ys))
    size = (max(1, math.ceil(max(xs) - ox)), max(1, math.ceil(max(ys) - oy)))
    a = polygon_mask(points, (ox, oy), size)
    b = contour_mask(contour, (ox, oy), size)
    union = np.count_nonzero(a | b)
    return float(np.count_nonzero(a & b) / union) if union else 0.0


def boundary_chamfer(points, contour):
    """Normalized symmetric boundary distance; vertices are not compared."""
    xs = [float(p[0]) for p in points] + [float(p[0]) for p in contour[:, 0, :]]
    ys = [float(p[1]) for p in points] + [float(p[1]) for p in contour[:, 0, :]]
    ox, oy = math.floor(min(xs)), math.floor(min(ys))
    size = (max(1, math.ceil(max(xs) - ox)), max(1, math.ceil(max(ys) - oy)))
    a = polygon_mask(points, (ox, oy), size)
    b = contour_mask(contour, (ox, oy), size)
    kernel = np.ones((3, 3), np.uint8)
    edge_a = cv2.subtract(a, cv2.erode(a, kernel, borderType=cv2.BORDER_CONSTANT, borderValue=0)) > 0
    edge_b = cv2.subtract(b, cv2.erode(b, kernel, borderType=cv2.BORDER_CONSTANT, borderValue=0)) > 0
    if not edge_a.any() or not edge_b.any():
        return 1.0
    da = cv2.distanceTransform((~edge_a).astype(np.uint8), cv2.DIST_L2, 3)
    db = cv2.distanceTransform((~edge_b).astype(np.uint8), cv2.DIST_L2, 3)
    dist = float(np.mean(np.concatenate([db[edge_a], da[edge_b]]))) if edge_a.any() and edge_b.any() else 999
    return float(dist / max(1.0, math.hypot(*size)))


def similarity(points, contour):
    iou = polygon_iou(points, contour)
    chamfer = boundary_chamfer(points, contour)
    return clamp(.7 * iou + .3 * (1 - min(1, chamfer * 4)))


def candidate_quality(ref, difference, contour, boxes, image_boxes):
    area = abs(cv2.contourArea(contour))
    x, y, w, h = cv2.boundingRect(contour)
    if area < MIN_AREA or area > SCENE[0] * SCENE[1] * MAX_PAGE_AREA:
        return None
    if min(w, h) < 6 or area / max(1, w * h) < .055:
        return None
    local = contour_mask(contour, (x, y), (w, h))
    sample = local > 0
    for left, top, right, bottom in boxes:
        ix0, iy0 = max(x, left), max(y, top)
        ix1, iy1 = min(x + w, right), min(y + h, bottom)
        if ix1 > ix0 and iy1 > iy0:
            sample[iy0 - y:iy1 - y, ix0 - x:ix1 - x] = False
    if not sample.any():
        sample = local > 0
    pixels = ref[y:y + h, x:x + w][sample]
    if not len(pixels):
        return None
    texture = float(np.mean(np.std(pixels.astype(np.float32), axis=0)))
    local_ref=ref[y:y+h,x:x+w].astype(np.float32)
    inside=(cv2.erode(local,np.ones((5,5),np.uint8))>0)&sample
    smooth_error=float(np.median(np.linalg.norm(local_ref-cv2.GaussianBlur(local_ref,(5,5),1.2),axis=2)[inside])) if inside.any() else 99
    if texture > 36 and smooth_error>6:
        return None  # smooth gradients are paint; textured photos stay material
    region_diff = difference[y:y + h, x:x + w][sample]
    contrast = float(np.mean(region_diff)) if len(region_diff) else 0
    if contrast < 9:
        return None  # shadow-only or nearly invisible contour
    image_overlap = 0.0
    for left, top, right, bottom in image_boxes:
        ix = max(0, min(x + w, right) - max(x, left))
        iy = max(0, min(y + h, bottom) - max(y, top))
        image_overlap = max(image_overlap, ix * iy / max(1, area))
    if image_overlap > .2:
        return None
    color = np.median(pixels, axis=0)
    rectangularity = area / max(1, w * h)
    perimeter = max(1.0, cv2.arcLength(contour, True))
    circularity = 4 * math.pi * area / (perimeter * perimeter)
    kind = 'rect' if len(fit_polygon(contour, (x, y, w, h))) <= 4 and rectangularity > .88 else 'ellipse' if circularity > .8 and abs(w / max(1, h) - 1) < .18 else 'polygon'
    confidence = clamp(.48 + .2 * min(1, contrast / 35) + .15 * max(0, 1 - texture / 40,1-smooth_error/8) + .12 * min(1, area / 6000))
    return {'x': int(x), 'y': int(y), 'w': int(w), 'h': int(h), 'points': fit_polygon(contour, (x, y, w, h)),
            'fill': hex_color(color), 'confidence': round(confidence, 3), 'kind': kind,
            '_contour': contour, '_area': area}


def candidate_border_text_cut(candidate, text_boxes, margin=3):
    """A text box fully erased at a carrier's edge can truncate its silhouette.
    Interior text (fully inside the carrier) is a hole to fill; a box touching
    or crossing the boundary makes the proposal conservative-skip."""
    x, y, w, h = candidate['x'], candidate['y'], candidate['w'], candidate['h']
    for left, top, right, bottom in text_boxes:
        if right <= x or left >= x + w or bottom <= y or top >= y + h:
            continue
        if left >= x + margin and top >= y + margin and right <= x + w - margin and bottom <= y + h - margin:
            continue
        return True
    return False


def seed_support_colors(ref, seed, candidate):
    """Sample the seed carrier's own fill/border colors so a gray drop shadow or
    background gradient is not mistaken for the filled shape boundary."""
    # Use one Lab convention throughout (float RGB -> L in 0..100). Mixing
    # OpenCV uint8 Lab and float Lab silently rejects every valid support pixel.
    known = []
    element = seed['element']
    stops = (element.get('gradient') or {}).get('stops') or []
    colors = [color_rgb(s.get('color')) for s in stops]
    colors = [c for c in colors if c is not None]
    if len(colors) > 1:
        for a, b in zip(colors, colors[1:]):
            known.extend(a * (1-t) + b * t for t in np.linspace(0, 1, 20))
    elif seed.get('fill') is not None:
        known.append(seed['fill'])
    stroke = color_rgb(element.get('color'))
    if stroke is not None and float(element.get('strokeWidth') or 0) > 0:
        known.append(stroke)
    if known:
        return cv2.cvtColor(np.array(known, np.float32).reshape(1, -1, 3) / 255, cv2.COLOR_RGB2LAB).reshape(-1, 3)
    return None


def refine_candidate_with_seed(ref, difference, candidate, seed, boxes, image_boxes):
    supports = seed_support_colors(ref, seed, candidate)
    if supports is None:
        return None
    x, y, w, h = candidate['x'], candidate['y'], candidate['w'], candidate['h']
    local = contour_mask(candidate['_contour'], (x, y), (w, h)) > 0
    if not local.any():
        return None
    region = ref[y:y + h, x:x + w]
    lab = cv2.cvtColor(region.astype(np.float32) / 255, cv2.COLOR_RGB2LAB).reshape(-1, 3)
    nearest = np.min(np.linalg.norm(lab[:, None, :] - supports[None, :, :], axis=2), axis=1)
    keep = local.reshape(-1) & (nearest < 12)
    mask = (keep.reshape(h, w).astype(np.uint8)) * 255
    if not mask.any():
        return None
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea) + np.array([[[x, y]]], dtype=np.int32)
    refined_area = abs(cv2.contourArea(contour))
    if refined_area < candidate['_area'] * .42 or refined_area > candidate['_area'] * 1.15:
        return None
    refined = candidate_quality(ref, difference, contour, boxes, image_boxes)
    if refined is None:
        return None
    if refined['w'] < candidate['w'] * .5 or refined['h'] < candidate['h'] * .5:
        return None
    return refined


def minimum_assignment(costs, missing=.82):
    """Global one-to-one assignment with a dummy unmatched column per seed."""
    n = len(costs)
    if not n:
        return []
    m = len(costs[0])
    a = [row + [missing]*n for row in costs]
    u, v, p, way = [0.]*(n+1), [0.]*(m+n+1), [0]*(m+n+1), [0]*(m+n+1)
    for i in range(1, n+1):
        p[0], j0 = i, 0
        minimum, used = [float('inf')]*(m+n+1), [False]*(m+n+1)
        while True:
            used[j0], i0 = True, p[j0]
            step, j1 = float('inf'), 0
            for j in range(1, m+n+1):
                if not used[j]:
                    value = a[i0-1][j-1]-u[i0]-v[j]
                    if value < minimum[j]:
                        minimum[j], way[j] = value, j0
                    if minimum[j] < step:
                        step, j1 = minimum[j], j
            for j in range(m+n+1):
                if used[j]:
                    u[p[j]] += step
                    v[j] -= step
                else:
                    minimum[j] -= step
            j0 = j1
            if not p[j0]:
                break
        while True:
            j1 = way[j0]
            p[j0], j0 = p[j1], j1
            if j0 == 0:
                break
    result = [-1]*n
    for j in range(1, m+1):
        if p[j] and a[p[j]-1][j-1] < missing:
            result[p[j]-1] = j-1
    return result


def build_result(spec, out):
    started = time.time()
    ref = image(spec['reference'], SCENE)
    bg = image(spec['background'], SCENE)
    elements = [e for e in spec.get('elements', []) or [] if isinstance(e, dict)]
    all_boxes = exclude_rects(spec, elements)
    bg,registration=registered_background(ref,bg,all_boxes)
    image_boxes = [box_pixels(e) for e in elements if str(e.get('type')) == 'image']
    text_boxes = [box_pixels(e) for e in elements if str(e.get('type')) in ('text', 'table', 'formula')]
    difference, mask, threshold = foreground_mask(ref, bg, all_boxes)
    coverage = float(np.mean(mask > 0))
    background_drift = coverage > .35
    # CCOMP retains an independent object inside a hollow frame as a top-level
    # component; RETR_EXTERNAL incorrectly hides that entire interior object.
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    candidates = []
    for contour_index,contour in enumerate(contours):
        if hierarchy is not None and hierarchy[0,contour_index,3]>=0:continue
        candidate = candidate_quality(ref, difference, contour, all_boxes, image_boxes)
        if candidate is None:
            continue
        if candidate['x'] + candidate['w'] >= SCENE[0] - 1 and candidate['y'] + candidate['h'] >= SCENE[1] - 1 and candidate['w'] * candidate['h'] > .2 * SCENE[0] * SCENE[1]:
            continue
        candidates.append(candidate)
    candidates.sort(key=lambda c: c['_area'], reverse=True)
    for index, candidate in enumerate(candidates):
        candidate['id'] = f'shape-{index + 1}'
        candidate['primitive'] = {'kind':'unclassified','confidence':0,'deferred':True}
    # Later opaque objects hide an earlier object. Never replace its complete
    # geometry with the visible L-shaped fragment or the union silhouette.
    occluders={};alpha_entries=mask_entries(spec)
    for i,element in enumerate(elements):
        if not is_seed(element):continue
        a=box_pixels(element);covered=[]
        support=object_alpha(element,alpha_entries,polygon=seed_polygon(element))
        for front in elements[i+1:]:
            if front.get('type') not in ('rect','ellipse','shape','svg','cutout','image') or front.get('role')=='background' or float(front.get('opacity',1))<=.01:continue
            b=box_pixels(front)
            if min(a[2],b[2])>max(a[0],b[0]) and min(a[3],b[3])>max(a[1],b[1]):
                alpha=object_alpha(front,alpha_entries)
                # Unknown objects are not silently promoted to solid rectangles.
                # Exact alpha preserves hollow interiors and soft transparency.
                if alpha is not None and support is not None and np.count_nonzero((alpha>200)&(support>16))>max(8,np.count_nonzero(support>16)*.005):covered.append(alpha)
        if covered:occluders[element['key']]=covered
    occluded_paints=[]
    for element in elements:
        covers=occluders.get(element.get('key'))
        polygon=seed_polygon(element) if covers else None
        if polygon:
            contour=np.rint(polygon).astype(np.int32).reshape(-1,1,2)
            paint=fit_shape_paint(ref,contour,element,all_boxes,np.maximum.reduce(covers))
            if paint:
                properties={}
                if paint.get('fill'):properties['gradient']=paint['fill']['gradient']
                if paint.get('stroke'):properties['strokeGradient']=paint['stroke']['gradient']
                if paint.get('outline') and paint['outline']['confidence']>=.9:
                    properties['strokeWidth']=paint['outline']['width']
                    if not element.get('strokeGradient') and paint['outline'].get('color'):properties['color']=paint['outline']['color']
                    if paint['outline'].get('presence')=='absent':properties.update(strokeWidth=0,strokeGradient=None,colorOpacity=0)
                occluded_paints.append({'key':element['key'],'properties':properties,'measurements':paint})
    seeds = []
    for element in elements:
        if not is_seed(element) or element.get('key') in occluders or spec.get('targetKeys') is not None and element.get('key') not in spec['targetKeys']:
            continue
        x, y, w, h = (float(element.get(k, 0)) for k in ('x', 'y', 'w', 'h'))
        if not all(math.isfinite(v) for v in (x, y, w, h)) or w <= 2 or h <= 2:
            continue
        polygon = seed_polygon(element)
        if not polygon:
            continue
        if w * h > SCENE[0] * SCENE[1] * .35:
            continue
        seeds.append({'element': element, 'key': element['key'], 'bbox': (x, y, w, h), 'polygon': polygon,
                      'fill': color_rgb(element.get('fill'))})
    pairs = []
    for si, seed in enumerate(seeds):
        sx, sy, sw, sh = seed['bbox']
        margin = max(12, sw * .18, sh * .18)
        for ci, candidate in enumerate(candidates):
            cx, cy, cw, ch = candidate['x'], candidate['y'], candidate['w'], candidate['h']
            if cx + cw < sx - margin or cx > sx + sw + margin or cy + ch < sy - margin or cy > sy + sh + margin:
                continue
            iou = polygon_iou(seed['polygon'], candidate['_contour'])
            chamfer = boundary_chamfer(seed['polygon'], candidate['_contour'])
            center_distance = math.hypot((cx + cw / 2) - (sx + sw / 2), (cy + ch / 2) - (sy + sh / 2)) / max(1, math.hypot(sw, sh) + 2 * margin)
            color_score = 0.0
            candidate_color = color_rgb(candidate.get('fill'))
            if seed['fill'] is not None and candidate_color is not None:
                color_score = 1 - min(1, float(np.linalg.norm(seed['fill'] - candidate_color)) / 441.67)
            score = .58 * iou + .24 * (1 - min(1, chamfer * 4)) + .12 * (1 - min(1, center_distance)) + .06 * color_score
            pairs.append((score, si, ci))
    costs = [[1e6]*len(candidates) for _ in seeds]
    pair_details = {}
    for score, si, ci in pairs:
        costs[si][ci] = 1-score
        pair_details[(si, ci)] = score
    matches = {}
    for si, ci in enumerate(minimum_assignment(costs)):
        if ci < 0:
            continue
        matches[si] = {'score': pair_details[(si, ci)], 'candidate': candidates[ci], 'iou': polygon_iou(seeds[si]['polygon'], candidates[ci]['_contour'])}
    proposals = []
    paint_proposals = occluded_paints
    border_text_skips = 0
    for si, match in matches.items():
        seed = seeds[si]
        candidate = match['candidate']
        refined = refine_candidate_with_seed(ref, difference, candidate, seed, all_boxes, image_boxes)
        if refined is not None:
            candidate_id = candidate.get('id')
            candidate.clear()
            candidate.update(refined)
            candidate['id'] = candidate_id
            match['iou'] = polygon_iou(seed['polygon'], candidate['_contour'])
        preferred=seed['element'].get('shapeCandidates') or [seed['element'].get('shape') or seed['element'].get('type')]
        candidate['primitive']=primitive_profile(candidate['_contour'],preferred)
        if candidate_border_text_cut(candidate, text_boxes):
            border_text_skips += 1
            continue
        if candidate['confidence']>=.8:
            paint=fit_shape_paint(ref,candidate['_contour'],seed['element'],all_boxes)
            if paint:
                properties={}
                if paint.get('fill'):properties['gradient']=paint['fill']['gradient']
                if paint.get('stroke'):properties['strokeGradient']=paint['stroke']['gradient']
                if paint.get('outline') and paint['outline']['confidence']>=.9:
                    properties['strokeWidth']=paint['outline']['width']
                    if not seed['element'].get('strokeGradient') and paint['outline'].get('color'):properties['color']=paint['outline']['color']
                    if paint['outline'].get('presence')=='absent':properties.update(strokeWidth=0,strokeGradient=None,colorOpacity=0)
                paint_proposals.append({'key':seed['key'],'properties':properties,'measurements':paint})
        absolute = [[candidate['x'] + px * candidate['w'], candidate['y'] + py * candidate['h']] for px, py in candidate['points']]
        before = similarity(seed['polygon'], candidate['_contour'])
        after = similarity(absolute, candidate['_contour'])
        improvement = after - before
        if before >= .985 or after < .94 or improvement < .015 or candidate['confidence'] < .45:
            continue
        properties = {'x': candidate['x'], 'y': candidate['y'], 'w': candidate['w'], 'h': candidate['h'],
                      'customGeometry': {'points': candidate['points'], 'closed': True}}
        if candidate.get('primitive',{}).get('kind')=='freeform':
            contour=candidate['_contour'].reshape(-1,2).astype(float)
            normalized=(contour-[candidate['x'],candidate['y']])/[candidate['w'],candidate['h']]
            commands=contour_path(contour,.8)
            if any(c['op']=='C' for c in commands) and len(commands)<=128:
                for command in commands:
                    command['points']=[[(p[0]-candidate['x'])/candidate['w'],(p[1]-candidate['y'])/candidate['h']] for p in command['points']]
                properties['customGeometry'].update({'version':2,'commands':commands})
        proposal = {'key': seed['key'], 'properties': properties, 'beforeScore': round(before, 3),
                    'afterScore': round(after, 3), 'confidence': round(min(candidate['confidence'], max(0, after)), 3), 'primitive': candidate.get('primitive'),
                    'reason': f"reference contour improves seed footprint IoU/chamfer score {before:.2f}->{after:.2f}"}
        seed_fill = seed['fill']
        candidate_fill = color_rgb(candidate.get('fill'))
        if seed_fill is None and candidate_fill is not None:
            proposal['properties']['fill'] = candidate['fill']
        proposals.append(proposal)
        match['proposal'] = True
    matched_ids = {id(matches[si]['candidate']) for si in matches}
    match_details = [{'key': seeds[si]['key'], 'candidate': matches[si]['candidate']['id'], 'score': round(matches[si]['score'], 3),
                      'iou': round(matches[si]['iou'], 3),
                      'before': round(similarity(seeds[si]['polygon'], matches[si]['candidate']['_contour']), 3),
                      'after': round(similarity([[matches[si]['candidate']['x'] + px * matches[si]['candidate']['w'], matches[si]['candidate']['y'] + py * matches[si]['candidate']['h']] for px, py in matches[si]['candidate']['points']], matches[si]['candidate']['_contour']), 3)}
                     for si in matches]
    for candidate in candidates:
        candidate.pop('_contour', None)
        candidate.pop('_area', None)
    unmatched = [candidate for candidate in candidates if id(candidate) not in matched_ids]
    evidence_exclude=np.zeros(mask.shape,bool)
    for x0,y0,x1,y1 in all_boxes:evidence_exclude[max(0,y0):min(900,y1),max(0,x0):min(1600,x1)]=True
    result = {
        'status': 'available',
        'candidates': candidates,
        'visibleLayers': visible_layer_candidates(ref,mask,all_boxes),
        'frameEvidence': frame_evidence(ref, evidence_exclude),
        'proposals': proposals,
        'paintProposals': paint_proposals,
        'unmatchedCandidates': unmatched,
        'diagnostics': {
            'method': 'registered-background-Lab-mask+external-contours+seed-polygon-fit+IoU/chamfer',
            'threshold': round(threshold, 2),
            'changedFraction': round(coverage, 4),
            'backgroundDrift': background_drift,
            'registration': registration,
            'seedCount': len(seeds),
            'candidateCount': len(candidates),
            'matchedCount': len(matches),
            'proposalCount': len(proposals),
            'unmatchedCount': len(unmatched),
            'borderTextSkips': border_text_skips,
            'occludedGeometryPreserved': list(occluders),
            'excludedCount': len(all_boxes),
            'imageRegionCount': len(image_boxes),
            'elapsedMs': int((time.time() - started) * 1000),
            'matches': match_details,
            'warnings': (['背景变化面积较大，结果仅作保守局部候选'] if background_drift else []),
        },
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / 'result.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    overlay = ref.copy()
    for candidate in candidates:
        cv2.rectangle(overlay, (candidate['x'], candidate['y']), (candidate['x'] + candidate['w'], candidate['y'] + candidate['h']), (255, 160, 20), 2)
    for proposal in proposals:
        props = proposal['properties']
        cv2.rectangle(overlay, (props['x'], props['y']), (props['x'] + props['w'], props['y'] + props['h']), (40, 180, 80), 2)
    Image.fromarray(overlay).save(out / 'shape-reference.png')
    return result


def main():
    try:
        spec = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
        out = Path(sys.argv[2])
        result = build_result(spec, out)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'status': 'unavailable', 'error': str(error)[:500]}, ensure_ascii=False))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
