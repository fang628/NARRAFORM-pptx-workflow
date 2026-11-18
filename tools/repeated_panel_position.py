"""Match registered rows of carriers to distinct closed outlines in the preview."""
import cv2
import numpy as np


def source(e):
    return (e.get('objectIdentity') or {}).get('sourceBox') or e


def edge_segments(edges, horizontal, length):
    kernel = (length, 1) if horizontal else (1, length)
    opened = cv2.morphologyEx(edges, cv2.MORPH_OPEN, np.ones(kernel[::-1], np.uint8))
    return cv2.connectedComponentsWithStats(opened, 8)[2][1:, :4]


def match_row(group, reference):
    seeds = sorted(group, key=lambda e: source(e)['x'])
    boxes = [source(e) for e in seeds]
    w, h, y = [np.median([b[field] for b in boxes]) for field in ('w', 'h', 'y')]
    if any(abs(b['y']-y) > .18*h or abs(b['w']-w) > .22*w or abs(b['h']-h) > .22*h for b in boxes):
        return {}
    gaps = np.diff([b['x'] for b in boxes])
    if min(gaps) < w*.85:
        return {}
    pad = min(220, np.median(gaps)*.65)
    x0, y0 = max(0, int(boxes[0]['x']-pad)), max(0, int(y-.38*h))
    crop = reference[y0:min(900, int(y+1.4*h)), x0:min(1600, int(boxes[-1]['x']+w+pad))]
    if not crop.size:
        return {}
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    edge = cv2.Canny(gray, 12, 35)
    horiz = edge_segments(edge, True, max(24, int(w*.22)))
    vert = edge_segments(edge, False, max(24, int(h*.25)))
    found = []
    for x, top, width, _ in horiz:
        if not .65*w <= width <= 1.25*w or abs(top+y0-y) > .32*h:
            continue
        bottoms = [b for b in horiz if .78*h <= b[1]-top <= 1.22*h and abs(b[0]-x) < .10*w and abs(b[2]-width) < .16*w]
        if not bottoms:
            continue
        bottom = np.median([b[1] for b in bottoms]); center = (top+bottom)/2
        sides = [v[0] for v in vert if v[1] <= center <= v[1]+v[3] and v[3] >= .4*h and v[1]-top < .19*h]
        pairs = [[s for s in sides if abs(s-end) <= .10*w] for end in (x, x+width)]
        if sum(bool(p) for p in pairs) == 1:
            # A faint edge may be fragmented. Require a luminance step along most of its height.
            i = 0 if not pairs[0] else 1
            end = x if i == 0 else x+width
            lo, hi = max(1,int(end-.055*w)), min(gray.shape[1]-1,int(end+.055*w)+1)
            strip = gray[int(top+.12*h):int(bottom-.12*h)].astype(np.int16)
            if lo < hi:
                profile = np.percentile(abs(strip[:,lo+1:hi+1]-strip[:,lo-1:hi-1]),25,axis=0)
                strong = np.flatnonzero(profile >= max(9,profile.max()*.82))
                if len(strong) and np.ptp(strong) <= 5:
                    pairs[i] = [lo+np.median(strong)]
        if not all(pairs) or any(np.ptp(p) > .045*w for p in pairs):
            continue
        l, r = [np.median(p) for p in pairs]
        if .77*w <= r-l <= 1.28*w:
            found.append((float(x0+l), float(y0+top), float(r-l), float(bottom-top)))
    unique = []
    for box in sorted(found):
        if not unique or abs(box[0]-unique[-1][0][0]) > 5:
            unique.append([])
        unique[-1].append(box)
    if len(unique) != len(seeds) or any(np.ptp(np.array(cluster)[:, 1]) > 5 for cluster in unique):
        return {}
    result = {}
    for e, cluster in zip(seeds, unique):
        x, y, width, height = np.median(cluster, axis=0).tolist()
        if abs(x-source(e)['x']) > pad:
            return {}
        result[e['key']] = dict(key=e['key'], accepted=True, method='distinct-panel-outlines', confidence=.92,
                                x=x, y=y, dx=x-e['x'], dy=y-e['y'], referenceBox=[x,y,width,height])
    return result


def locate_panels(panels, reference):
    groups = {}
    for e in panels:
        groups.setdefault(e['parameterGroups']['shape'], []).append(e)
    rows = {}
    for group in groups.values():
        if len(group) >= 2:
            rows.update(match_row(group, reference))
    return rows


def panel_markers(panels, rows, circles, reference):
    """Use the original enclosure only to select registered markers. Match actual discs in order."""
    result = {}
    for panel in panels:
        if panel['key'] not in rows:
            continue
        b = source(panel)
        members = [e for e in circles if 5 <= min(e['w'],e['h']) <= max(e['w'],e['h']) <= 18
                   and max(e['w'],e['h'])/min(e['w'],e['h']) < 1.18 and not e.get('strokeWidth')
                   and b['x'] <= source(e)['x'] <= b['x']+.2*b['w'] and b['y'] <= source(e)['y'] <= b['y']+b['h']-e['h']]
        if len(members)<2 or len({e.get('fill') for e in members})!=1:
            continue
        try:
            bgr=np.frombuffer(bytes.fromhex(members[0]['fill'].lstrip('#')),np.uint8).reshape(3)[::-1]
        except (ValueError,AttributeError,KeyError):
            continue
        x,y,w,h=rows[panel['key']]['referenceBox']; d=np.median([e['w'] for e in members])
        left,top=int(x+3),int(y+3); crop=reference[top:int(y+h-3),left:int(x+w*.24)].astype(np.float32)
        if not crop.size:continue
        mask=(np.linalg.norm(crop-bgr,axis=2)<75).astype(np.uint8)
        _,_,stats,centers=cv2.connectedComponentsWithStats(mask,8)
        discs=[c for (_,_,cw,ch,area),c in zip(stats[1:],centers[1:]) if .7*d<=min(cw,ch)<=max(cw,ch)<=1.3*d
               and max(cw,ch)/min(cw,ch)<1.25 and .59<=area/(cw*ch)<=.91]
        if len(discs)!=len(members) or np.ptp([c[0] for c in discs])>d*.65:continue
        for e,c in zip(sorted(members,key=lambda e:source(e)['y']),sorted(discs,key=lambda c:c[1])):
            nx,ny=float(left+c[0]-e['w']/2),float(top+c[1]-e['h']/2)
            result[e['key']]=dict(key=e['key'],accepted=True,x=nx,y=ny,dx=nx-e['x'],dy=ny-e['y'],confidence=.90,
                                  method='distinct-panel-markers',referenceCenter=[float(left+c[0]),float(top+c[1])])
    return result
