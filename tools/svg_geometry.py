"""Symmetrize isolated hexagonal contours, never concave arrow carriers."""
import math
import re

NUMBER = r'[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?'


def path_points(value, *, require_closed=True):
    # Geometry correction requires closed paths; paint repair also accepts open
    # straight paths. Curves, holes and multi-part artwork retain their paths.
    if any(c not in 'MmLlHhVvZz' for c in re.findall(r'[A-Za-z]', re.sub(NUMBER, '', value))):
        return None
    tokens = re.findall(r'[MmLlHhVvZz]|' + NUMBER, value)
    if re.sub(r'[MmLlHhVvZz]|' + NUMBER + r'|[\s,]', '', value):
        return None
    points, x, y, i, command, closed = [], 0., 0., 0, None, False
    try:
        while i < len(tokens):
            if tokens[i].isalpha():
                command = tokens[i]
                i += 1
                if command.lower() == 'z':
                    closed = True
                    if i != len(tokens):
                        return None
                    break
            if command is None:
                return None
            relative, kind = command.islower(), command.lower()
            if kind in ('m', 'l'):
                a, b = float(tokens[i]), float(tokens[i+1])
                if kind == 'm' and points:
                    return None
                x, y = (x+a, y+b) if relative else (a, b)
                i += 2
                command = 'l' if relative else 'L'
            elif kind == 'h':
                a = float(tokens[i]); x = x+a if relative else a; i += 1
            elif kind == 'v':
                a = float(tokens[i]); y = y+a if relative else a; i += 1
            else:
                return None
            points.append((x, y))
        return points if closed or not require_closed else None
    except (ValueError, IndexError):
        return None


def symmetric_hexagon(points, declared=False):
    if points and points[-1] == points[0]:
        points = points[:-1]
    if len(points or []) != 6 or any(not math.isfinite(v) for p in points for v in p):
        return None
    left, right = min(p[0] for p in points), max(p[0] for p in points)
    top, bottom = min(p[1] for p in points), max(p[1] for p in points)
    w, h = right-left, bottom-top
    if min(w, h) <= 0:
        return None
    cross = [(points[(i+1)%6][0]-points[i][0])*(points[(i+2)%6][1]-points[(i+1)%6][1]) - (points[(i+1)%6][1]-points[i][1])*(points[(i+2)%6][0]-points[(i+1)%6][0]) for i in range(6)]
    if not (all(c > w*h*1e-7 for c in cross) or all(c < -w*h*1e-7 for c in cross)):
        return None  # Concave chevrons and collinear subdivisions are not hexagons.
    cx, cy = (left+right)/2, (top+bottom)/2
    by_y, by_x = sorted(points, key=lambda p:p[1]), sorted(points, key=lambda p:p[0])
    a = max(w*.02, min(w*.48, sum(abs(p[0]-cx) for p in by_y[:2]+by_y[-2:])/4))
    b = max(h*.02, min(h*.48, sum(abs(p[1]-cy) for p in by_x[:2]+by_x[-2:])/4))
    horizontal = [(cx-a,top),(cx+a,top),(right,cy),(cx+a,bottom),(cx-a,bottom),(left,cy)]
    vertical = [(cx,top),(right,cy-b),(right,cy+b),(cx,bottom),(left,cy+b),(left,cy-b)]
    choices=[]
    for candidate in (horizontal, vertical):
        for order in (candidate, list(reversed(candidate))):
            for offset in range(6):
                ordered=order[offset:]+order[:offset]
                error=sum((p[0]-q[0])**2+(p[1]-q[1])**2 for p,q in zip(points,ordered))
                choices.append((error,ordered))
    error, result = min(choices, key=lambda item:item[0])
    if error <= 1e-12 or not declared and math.sqrt(error/6) > min(w,h)*.08:
        return None
    return result


def normalize_svg_hexagons(root, context=None):
    context=context or {}
    kind=str(context.get('frameKind',''))+' '+str(context.get('contourKind',''))
    if context.get('arrowRole') or re.search(r'arrow|chevron|箭形|箭头',kind,re.I):
        return []
    declared=bool(re.search(r'hexagon|六边形',kind,re.I))
    repairs=[]
    for index,node in enumerate(root.iter()):
        tag=node.tag.rsplit('}',1)[-1]
        if tag=='polygon':
            values=re.findall(NUMBER,node.get('points',''))
            points=list(zip(map(float,values[::2]),map(float,values[1::2]))) if len(values)%2==0 else None
        elif tag=='path':
            points=path_points(node.get('d',''))
        else:
            continue
        result=symmetric_hexagon(points,declared)
        if not result:
            continue
        coords=[f'{x:.6f},{y:.6f}' for x,y in result]
        node.set('points' if tag=='polygon' else 'd',' '.join(coords) if tag=='polygon' else 'M'+' L'.join(coords)+' Z')
        repairs.append({'kind':'symmetric-hexagon','tag':tag,'index':index})
    return repairs
