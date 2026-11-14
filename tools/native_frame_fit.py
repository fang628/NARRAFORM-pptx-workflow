"""Reference evidence and constrained native geometry, without SVG generation.

LSD/Huber long edges determine base geometry before corner detail. Predicted
object masks only explain occlusion; they are not ground truth segmentation.
NumPy/OpenCV keep this path available in the existing runtime environment.
"""
import json
import math
import sys
import time
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
from object_masks import object_alpha, mask_entries
from shape_paint import fit_shape_paint
from paint_models import spatial_samples, predict_paint, validate_shared_paint
from light_profiles import light_profiles


def frame_underlay(background,elements,index,entries,region):
    """Composite known native layers below a translucent carrier in its ROI."""
    if background is None:return None
    x0=max(0,int(region['x'])-20);y0=max(0,int(region['y'])-20)
    x1=min(1600,int(math.ceil(region['x']+region['w']))+20);y1=min(900,int(math.ceil(region['y']+region['h']))+20)
    result=background.copy();yy,xx=np.mgrid[y0:y1,x0:x1];flat=result[y0:y1,x0:x1].astype(float)
    for back in elements[:index]:
        if back.get('type') not in ('rect','ellipse','shape') or back.get('role')=='effect' or float(back.get('fillOpacity',1))<=0:continue
        if back['x']>=x1 or back['x']+back['w']<=x0 or back['y']>=y1 or back['y']+back['h']<=y0:continue
        mask=object_alpha(back,entries)
        if mask is None:continue
        alpha=mask[y0:y1,x0:x1].astype(float)/255
        paint=back.get('gradient') or back.get('fill')
        if isinstance(paint,dict):paint={**paint,'stops':[{**s,'opacity':1} for s in paint['stops']]}
        rgb=predict_paint(paint,xx.ravel(),yy.ravel(),back)
        if rgb is not None:flat=rgb.reshape(flat.shape)*alpha[:,:,None]+flat*(1-alpha[:,:,None])
    result[y0:y1,x0:x1]=np.clip(flat,0,255).astype(np.uint8)
    return result

cv2.setNumThreads(1)
VERSION = 4


def long_edges(ref, excluded=None):
    lab = cv2.cvtColor(ref, cv2.COLOR_RGB2LAB)
    detector = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD)
    found = []
    # Multiple channels retain colored boundaries with little luminance change.
    channels=[(cv2.GaussianBlur(lab[:,:,i],(3,3),.6),1.) for i in range(3)]
    channels+=[(cv2.resize(lab[:,:,i],None,fx=.5,fy=.5,interpolation=cv2.INTER_AREA),.5) for i in range(3)]
    # Evidence-only 2px closure rescues hairlines. Original colour samples and
    # exported geometry never use this processed image; periodic gaps stay data.
    channels.append((cv2.morphologyEx(lab[:,:,0],cv2.MORPH_CLOSE,np.ones((1,3),np.uint8)),1.))
    for channel,scale in channels:
        lines = detector.detect(channel)[0]
        for raw in (() if lines is None else lines[:, 0]/scale):
            a, b = np.asarray(raw[:2], float), np.asarray(raw[2:], float)
            length = float(np.linalg.norm(b-a))
            if length < 16:
                continue
            if tuple(a) > tuple(b):
                a, b = b, a
            t = np.linspace(.05, .95, 16)[:, None]
            samples = a+(b-a)*t
            xx, yy = np.rint(samples).astype(int).T
            xx = np.clip(xx, 0, ref.shape[1]-1); yy = np.clip(yy, 0, ref.shape[0]-1)
            if excluded is not None and np.mean(excluded[yy, xx]) > .35:
                continue
            angle = math.atan2(*(b-a)[::-1])
            found.append({'a': a, 'b': b, 'length': length, 'angle': angle})
    merged = []
    for line in sorted(found, key=lambda q: -q['length'])[:500]:
        v = (line['b']-line['a'])/line['length']; normal = np.array([-v[1], v[0]])
        group = None
        for prior in merged:
            u = (prior['b']-prior['a'])/prior['length']
            parallel = abs(float(np.dot(u, v))) > math.cos(math.radians(1.8))
            distance = max(abs(float(np.dot(prior['a']-line['a'], normal))), abs(float(np.dot(prior['b']-line['a'], normal))))
            extents = sorted([float(np.dot(prior['a']-line['a'], v)), float(np.dot(prior['b']-line['a'], v))])
            if parallel and distance < 2.4 and extents[0] <= line['length']+22 and extents[1] >= -22:
                group = prior; break
        if group is None:
            merged.append({**line, 'samples': [line['a'], line['b']]})
        else:
            group['samples'].extend([line['a'], line['b']])
            points = np.asarray(group['samples'], np.float32)
            vx, vy, x, y = cv2.fitLine(points, cv2.DIST_HUBER, 0, .01, .01).ravel()
            direction = np.array([vx, vy]); direction *= 1 if direction[0] >= 0 else -1
            center = np.array([x, y]); projection = (points-center)@direction
            group['a'] = center+direction*projection.min(); group['b'] = center+direction*projection.max()
            group['length'] = float(projection.max()-projection.min()); group['angle'] = math.atan2(direction[1], direction[0])
    return merged


def line_dict(line):
    return {'start': np.round(line['a'], 2).tolist(), 'end': np.round(line['b'], 2).tolist(), 'length': round(line['length'], 2), 'angle': round(math.degrees(line['angle']), 2)}


def frame_evidence(ref, excluded=None, lines=None):
    lines = long_edges(ref, excluded) if lines is None else lines
    horizontal = [q for q in lines if abs(math.sin(q['angle'])) < .12 and q['length'] > 80]
    groups = []
    for top in horizontal:
        for bottom in horizontal:
            ty = float(np.mean([top['a'][1], top['b'][1]])); by = float(np.mean([bottom['a'][1], bottom['b'][1]]))
            dy = by-ty
            overlap = min(top['b'][0], bottom['b'][0])-max(top['a'][0], bottom['a'][0])
            if not 28 < dy < 260 or overlap < .6*min(top['length'], bottom['length']) or min(top['length'], bottom['length']) < dy*.7:
                continue
            x0 = max(top['a'][0], bottom['a'][0]); x1 = min(top['b'][0], bottom['b'][0])
            if any(abs(g['y']-ty) < 8 and abs(g['h']-dy) < 10 and abs(g['x']-x0) < 15 for g in groups):
                continue
            # A panel hypothesis also needs non-horizontal side evidence; long
            # rules under body paragraphs alone are not evidence for extra boxes.
            sides = [q for q in lines if abs(math.sin(q['angle'])) > .65 and q['length'] > dy*.7 and
                     abs(min(q['a'][1],q['b'][1])-ty)<max(10,dy*.10) and abs(max(q['a'][1],q['b'][1])-by)<max(10,dy*.10) and
                     (abs(np.mean([q['a'][0], q['b'][0]])-x0) < dy*.65+20 or abs(np.mean([q['a'][0], q['b'][0]])-x1) < dy*.65+20)]
            if not sides:
                continue
            groups.append({'x': round(float(x0), 2), 'y': round(ty, 2), 'w': round(float(x1-x0), 2), 'h': round(dy, 2),
                           'hypotheses': ['single-frame-gradient', 'independent-overlapping-frame'], 'sideEvidence': len(sides),
                           'confidence': round(min(.9, .45+.1*len(sides)), 2), 'requiresObjectComparison': True})
    groups.sort(key=lambda g: (-g['confidence'], -g['w']*g['h']))
    return {'version': VERSION, 'lines': [line_dict(q) for q in sorted(lines, key=lambda q: -q['length'])[:100]], 'groups': groups[:20]}


def sample_path(commands, steps=16):
    current = np.array([0., 0.]); start = current; parts = []; part = []
    for c in commands:
        op = c['op']; pts = np.asarray(c.get('points', []), float)
        if op == 'M':
            if part: parts.append(part)
            current = pts[0]; start = current; part = [current]
        elif op == 'Z':
            current = start
            if part: parts.append(part); part = []
        elif op == 'L':
            current = pts[0]; part.append(current)
        elif op in ('Q', 'C'):
            old = current.copy()
            for t in np.linspace(0, 1, steps+1)[1:]:
                s = 1-t
                q = s*s*old+2*s*t*pts[0]+t*t*pts[1] if op == 'Q' else s**3*old+3*s*s*t*pts[0]+3*s*t*t*pts[1]+t**3*pts[2]
                part.append(q)
            current = pts[-1]
    if part: parts.append(part)
    return [np.asarray(p) for p in parts]


def fit_bezier(points, tolerance=.8, depth=0):
    """Endpoint/tangent-constrained LS cubic, subdividing only uncertain segments."""
    points = np.asarray(points, float)
    if len(points) < 3:
        return [{'op': 'L', 'points': [points[-1].tolist()]}]
    a, b = points[0], points[-1]; chord = b-a
    norm = max(1e-9, float(np.linalg.norm(chord)))
    relative=points-a;distance = np.abs(chord[0]*relative[:,1]-chord[1]*relative[:,0])/norm
    if float(distance.max()) <= tolerance:
        return [{'op': 'L', 'points': [b.tolist()]}]
    tangent_a = points[min(2, len(points)-1)]-a; tangent_b = b-points[max(0, len(points)-3)]
    tangent_a /= max(1e-9, np.linalg.norm(tangent_a)); tangent_b /= max(1e-9, np.linalg.norm(tangent_b))
    lengths = np.r_[0., np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1))]; t = lengths/max(1e-9, lengths[-1]); s = 1-t
    p1 = 3*s*s*t; p2 = 3*s*t*t
    base = (s**3+p1)[:, None]*a+(t**3+p2)[:, None]*b
    matrix = np.stack([p1[:, None]*tangent_a, -p2[:, None]*tangent_b], axis=-1).reshape(-1, 2)
    target = (points-base).reshape(-1)
    alpha = np.linalg.lstsq(matrix, target, rcond=None)[0]
    alpha = np.clip(alpha, norm*.03, max(norm*1.5, lengths[-1]))
    ca = a+tangent_a*alpha[0]; cb = b-tangent_b*alpha[1]
    prediction = s[:, None]**3*a+p1[:, None]*ca+p2[:, None]*cb+t[:, None]**3*b
    errors = np.linalg.norm(prediction-points, axis=1)
    if errors.max() <= tolerance or depth >= 6:
        return [{'op': 'C', 'points': [ca.tolist(), cb.tolist(), b.tolist()]}]
    split = int(np.argmax(errors)); split = min(len(points)-2, max(1, split))
    return fit_bezier(points[:split+1], tolerance, depth+1)+fit_bezier(points[split:], tolerance, depth+1)


def contour_path(points, tolerance=.8):
    points = np.asarray(points, float).reshape(-1, 2)
    # Stable corners anchor the segments; high-frequency raster wiggles don't.
    coarse = cv2.approxPolyDP(points.astype(np.float32).reshape(-1, 1, 2), max(tolerance, .004*cv2.arcLength(points.astype(np.float32), True)), True)[:, 0]
    anchors = []
    for i, p in enumerate(coarse):
        a = coarse[i-1]-p; b = coarse[(i+1) % len(coarse)]-p
        angle = math.acos(float(np.clip(np.dot(a,b)/max(1e-9,np.linalg.norm(a)*np.linalg.norm(b)), -1, 1)))
        if angle < math.radians(148): anchors.append(int(np.argmin(np.linalg.norm(points-p, axis=1))))
    if len(anchors) < 2: anchors = [0, len(points)//4, len(points)//2, 3*len(points)//4]
    anchors = sorted(set(anchors)); commands = [{'op': 'M', 'points': [points[anchors[0]].tolist()]}]
    for i, start in enumerate(anchors):
        end = anchors[(i+1) % len(anchors)]
        segment = points[start:end+1] if end > start else np.vstack([points[start:], points[:end+1]])
        commands.extend(fit_bezier(segment, tolerance))
    commands.append({'op': 'Z', 'points': []}); return commands


def polygon_score(points, edges, excluded, box, shape_prior=0):
    sampled = []
    for a, b in zip(points, np.roll(points, -1, axis=0)):
        n = max(4, int(np.linalg.norm(b-a)/3)); sampled.extend(a+(b-a)*np.linspace(.04, .96, n)[:, None])
    samples = np.asarray(sampled); xx, yy = np.rint(samples).astype(int).T
    valid = (xx>2)&(yy>2)&(xx<edges.shape[1]-3)&(yy<edges.shape[0]-3); xx=xx[valid]; yy=yy[valid]
    valid = ~excluded[yy,xx]; xx=xx[valid]; yy=yy[valid]
    if len(xx)<12: return None
    distance = edges[yy,xx]
    # Huber/truncated distances protect a few genuinely hidden or soft edges.
    robust = np.where(distance < 3, distance*distance/6, distance-1.5)
    coverage = float(np.mean(distance<3))
    return float(np.mean(np.minimum(robust,12)))+shape_prior, coverage, len(xx)


def intersect(a,b):
    p,q=a['a'],b['a'];v=a['b']-p;u=b['b']-q;den=v[0]*u[1]-v[1]*u[0];d=q-p
    return None if abs(float(den))<1e-8 else p+v*((d[0]*u[1]-d[1]*u[0])/den)


def visible_canvas_region(poly):
    """Analysis/paint samples only. Never used as the exported object path."""
    result=[np.asarray(p,float) for p in poly]
    for axis,bound,greater in ((0,0,True),(0,1600,False),(1,0,True),(1,900,False)):
        old=result;result=[]
        for i,p in enumerate(old):
            previous=old[i-1];inside=p[axis]>=bound if greater else p[axis]<=bound;before=previous[axis]>=bound if greater else previous[axis]<=bound
            if inside!=before:
                t=(bound-previous[axis])/(p[axis]-previous[axis]);result.append(previous+(p-previous)*t)
            if inside:result.append(p)
    return np.asarray(result)


def layer_comparison(ref, excluded, box, group):
    x,y,w,h=[float(box[k]) for k in ('x','y','w','h')]
    xs=np.linspace(max(0,x+w*.08),min(1599,x+w*.92),28).astype(int)
    ys=np.linspace(max(0,y+h*.03),min(899,y+h*.97),42).astype(int)
    xx,yy=np.meshgrid(xs,ys);valid=~excluded[yy,xx];xx=xx[valid];yy=yy[valid]
    if len(xx)<100:return None
    inside=(yy>=group['y'])&(yy<=group['y']+group['h'])&(xx>=group['x'])&(xx<=group['x']+group['w'])
    if min(inside.sum(),(~inside).sum())<50:return None
    u=(xx-x)/w;v=(yy-y)/h
    # A multi-stop/curved gradient is a legitimate single carrier. Comparing
    # against only an RGB plane turns paragraph rules into imaginary panels.
    design=np.stack([np.ones(len(xx)),u,v,u*u,v*v,u*v,u**3,v**3],axis=1)
    colors=ref[yy,xx].astype(float)
    heldout=np.arange(len(xx))%5==0
    def error(active):
        train=active&~heldout;test=active&heldout
        if train.sum()<30 or test.sum()<10:return float('inf')
        a=design[train];b=colors[train];weights=np.ones(len(a))
        for _ in range(4):
            fit=np.linalg.lstsq(a*weights[:,None]**.5,b*weights[:,None]**.5,rcond=None)[0]
            residual=np.linalg.norm(a@fit-b,axis=1);weights=np.minimum(1,12/np.maximum(1e-6,residual))
        residual=np.linalg.norm(design[test]@fit-colors[test],axis=1)
        return float(np.sum(np.minimum(residual**2,35**2)))
    single=error(np.ones(len(xx),bool));split=error(inside)+error(~inside)
    if not np.isfinite(single+split):return None
    # Three extra coefficients per color; penalize additional independent paint.
    penalty=24*math.log(len(xx))*12
    improvement=(single-split-penalty)/max(1,single)
    return {'singleError':round(single/len(xx),3),'layeredError':round(split/len(xx),3),'complexityPenalty':round(penalty/len(xx),3),
            'improvement':round(improvement,3),'preferred':'overlapping-frame' if improvement>.25 and group['sideEvidence']>=2 else 'undetermined',
            'validation':'held-out-curved-single-vs-split','boundaryEvidence':group.get('connectedSides',False)}


def missing_title_carriers(ref,elements,lines,excluded,heading_ids):
    """Suggest missing short carriers inside a known large body, never add one.

    Node identity + two measured boundaries + a coherent paint change are
    independent of the already predicted union mask used by omission checks.
    """
    issues=[]
    for text in elements:
        if text.get('type')!='text' or text.get('nodeId') not in heading_ids:continue
        tx,ty,tw,th=[float(text[k]) for k in ('x','y','w','h')]
        frames=[e for e in elements if e.get('type') in ('rect','shape') and e.get('role')!='effect' and not e.get('managed') and float(e.get('fillOpacity',1))>.15 and e['x']<=tx+tw*.5<=e['x']+e['w'] and e['y']<=ty+th*.5<=e['y']+e['h']]
        if not frames:continue
        parent=max(frames,key=lambda e:e['h'])
        if parent['h']<th*2.2:continue
        if any(e['h']<parent['h']*.55 and e['w']>=tw*.85 and e['y']<=ty+th*.15 and e['y']+e['h']>=ty+th*.85 for e in frames):continue
        edges=[]
        for q in lines:
            if abs(math.sin(q['angle']))>.1 or q['length']<max(80,tw*.4):continue
            a,b=q['a'],q['b'];lo=min(a[0],b[0]);hi=max(a[0],b[0]);y=float((a[1]+b[1])/2)
            if min(hi,tx+tw)-max(lo,tx)<tw*.35:continue
            if parent['y']-12<=y<=ty+th+60:edges.append((y,lo,hi))
        tops=[q for q in edges if ty-min(70,th*.8)<=q[0]<=ty+8]
        bottoms=[q for q in edges if ty+th-12<=q[0]<=ty+th+60]
        options=[]
        for top in tops:
            for bottom in bottoms:
                y0,x0,x1=top;y1,l,r=bottom
                if not max(th*.85,28)<y1-y0<parent['h']*.55:continue
                left=max(0,int(max(x0,l)));right=min(1600,int(min(x1,r)))
                if right-left<max(75,tw*.5):continue
                xs=np.arange(left+6,right-5,3);ys0=np.clip(np.rint(y1-np.arange(7,20,3)).astype(int),0,899);ys1=np.clip(np.rint(y1+np.arange(7,20,3)).astype(int),0,899)
                before=ref[ys0[:,None],xs].astype(float);after=ref[ys1[:,None],xs].astype(float)
                good=(~excluded[ys0[:,None],xs]).all(axis=0)&(~excluded[ys1[:,None],xs]).all(axis=0)
                if good.sum()<12:continue
                delta=np.linalg.norm(np.median(before[:,good],axis=0)-np.median(after[:,good],axis=0),axis=1)
                if float(np.median(delta))<9 or float((delta>7).mean())<.65:continue
                region={'x':round(float(min(x0,l)),2),'y':round(y0,2),'w':round(float(max(x1,r)-min(x0,l)),2),'h':round(y1-y0,2)}
                options.append((abs(y0-ty)+abs(y1-ty-th),region,float(np.median(delta))))
        if options:
            _,region,contrast=min(options,key=lambda q:q[0])
            from title_carriers import plate_proposal
            measured=plate_proposal(ref,parent,text,region,lines,excluded)
            issues.append({'key':parent['key'],'headingKey':text['key'],'kind':'missing-title-carrier','region':region,'comparison':{'preferred':'missing-title-carrier','paintDifference':round(contrast,2),'evidence':'heading-node+two-horizontal-boundaries+coherent-paint-change'},'confidence':.85,**({'measuredCarrier':measured} if measured else {})})
    return issues


def corner_path(poly, corners, scale):
    segments=[]
    for i,p in enumerate(poly):
        a=poly[i-1]-p;b=poly[(i+1)%len(poly)]-p;la=np.linalg.norm(a);lb=np.linalg.norm(b);u=a/la;v=b/lb
        angle=math.acos(float(np.clip(np.dot(u,v),-1,1)));c=corners[i]
        trim=c.get('radius',0)*scale/max(.01,math.tan(angle/2)) if c['type']=='round' else c.get('distance',0)*scale if c['type']=='cut' else 0
        trim=min(trim,la*.45,lb*.45);start=p+u*trim;end=p+v*trim;radius=trim*math.tan(angle/2);k=4/3*math.tan((math.pi-angle)/4)*radius
        segments.append((start,end,start-u*k,end-v*k,c['type']))
    commands=[]
    for i,(a,b,c,d,kind) in enumerate(segments):
        commands.append({'op':'L' if i else 'M','points':[a.tolist()]})
        if kind=='round':commands.append({'op':'C','points':[c.tolist(),d.tolist(),b.tolist()]})
        elif kind=='cut':commands.append({'op':'L','points':[b.tolist()]})
    return commands+[{'op':'Z','points':[]}]


def fit_corners(poly, distance, excluded):
    scale=float(min(np.ptp(poly[:,0]),np.ptp(poly[:,1])));corners=[{'type':'sharp'} for _ in poly]
    def error(commands,p):
        samples=[];current=None;start=None
        for c in commands:
            if c['op']=='M':current=np.asarray(c['points'][0]);start=current.copy();continue
            if c['op'] in ('L','Z'):
                end=np.asarray(c['points'][0]) if c['op']=='L' else start
                samples.extend(current+(end-current)*np.linspace(0,1,max(3,int(np.linalg.norm(end-current)/2)))[:,None]);current=end
            elif c['op']=='C':
                a,b,end=np.asarray(c['points']);old=current.copy()
                for t in np.linspace(0,1,24):s=1-t;samples.append(s**3*old+3*s*s*t*a+3*s*t*t*b+t**3*end)
                current=end
        q=np.asarray(samples);q=q[np.linalg.norm(q-p,axis=1)<max(10,scale*.12)]
        if not len(q):return None
        xx,yy=np.rint(q).astype(int).T;valid=(xx>=0)&(yy>=0)&(xx<1600)&(yy<900);xx=xx[valid];yy=yy[valid];valid=~excluded[yy,xx];xx=xx[valid];yy=yy[valid]
        return float(np.mean(np.minimum(distance[yy,xx],8))) if len(xx)>=5 else None
    for i,p in enumerate(poly):
        baseline=error(corner_path(poly,corners,scale),p)
        if baseline is None:continue
        best=baseline
        for kind in ('cut','round'):
            for size in (.012,.025,.04,.065,.09):
                candidate=[dict(c) for c in corners];candidate[i]={'type':kind,('radius' if kind=='round' else 'distance'):size}
                measured=error(corner_path(poly,candidate,scale),p)
                if measured is not None and measured+.12<best:best=measured+.12;corners[i]=candidate[i]
    return corners


def fit_native_frames(spec):
    started=time.perf_counter()
    ref = np.asarray(Image.open(spec['reference']).convert('RGB').resize((1600,900)), np.uint8)
    elements = spec.get('elements', []); masks = mask_entries(spec)
    excluded = np.zeros((900,1600), bool)
    for e in elements:
        if e.get('type') in ('text','formula','image','table') or e.get('managed'):
            alpha=object_alpha(e,masks)
            if alpha is not None: excluded |= alpha>16
    for b in spec.get('exclude', []):
        x,y,w,h=[int(b[k]) for k in ('x','y','w','h')];excluded[max(0,y):min(900,y+h),max(0,x):min(1600,x+w)]=True
    lines=long_edges(ref,excluded);evidence=frame_evidence(ref,excluded,lines)
    lab=cv2.cvtColor(ref,cv2.COLOR_RGB2LAB);edge=np.zeros((900,1600),np.uint8)
    for c in range(3):edge|=cv2.Canny(cv2.GaussianBlur(lab[:,:,c],(3,3),.7),35,100)
    edge[excluded]=0;distance=cv2.distanceTransform((edge==0).astype(np.uint8),cv2.DIST_L2,3)
    luminance=cv2.cvtColor(ref,cv2.COLOR_RGB2GRAY)
    glyphs=luminance.astype(float)-cv2.medianBlur(luminance,9).astype(float)>18
    # Reference-derived text exclusion works even when old OCR boxes are wrong.
    top=cv2.morphologyEx(luminance,cv2.MORPH_TOPHAT,np.ones((25,25),np.uint8))
    chroma=ref.max(axis=2).astype(float)-ref.min(axis=2).astype(float)
    glyphs|=(top>24)&(luminance>125)&(chroma<95)
    glyphs=cv2.dilate(glyphs.astype(np.uint8),np.ones((3,3),np.uint8))>0
    # Opening removes narrow bright glyph strokes instead of smearing them into
    # the estimated base paint; broad gradients survive as low-frequency colour.
    low_frequency=cv2.morphologyEx(cv2.medianBlur(ref,7),cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(17,17)))
    background=np.asarray(Image.open(spec['background']).convert('RGB').resize((1600,900))) if spec.get('background') else None
    results=[];unresolved=[];fitted_masks={};diagnostics=[];paint_proposals=[];paint_diagnostics=[];paint_regions={}
    for position,e in sorted(enumerate(elements),key=lambda item:float(item[1].get('w',0))*float(item[1].get('h',0))):
        if spec.get('targetKeys') is not None and e.get('key') not in spec['targetKeys']:continue
        if e.get('managed') or e.get('role') in ('background','effect') or e.get('effectOf') or e.get('visualKind')=='light-effect' or e.get('type') not in ('rect','shape','ellipse'):continue
        if time.perf_counter()-started>min(30,max(5,float(spec.get('timeBudgetMs',25000))/1000)):
            diagnostics.append({'key':e['key'],'status':'deferred','reason':'page-local-fit-budget'});continue
        x,y,w,h=[float(e[k]) for k in ('x','y','w','h')]
        if w<18 or h<16 or w*h>1600*900*.45:continue
        custom=e.get('customGeometry') or {};parts=sample_path(custom['commands']) if custom.get('commands') else []
        if parts: seed=parts[0]*[w,h]+[x,y]
        elif custom.get('points'):seed=np.asarray(custom['points'])*[w,h]+[x,y]
        else:
            from shape_reference import seed_polygon
            seed=np.asarray(seed_polygon(e) or [[x,y],[x+w,y],[x+w,y+h],[x,y+h]],float)
        if len(parts)>1 or e.get('arrowRole')=='connector':continue
        visible=excluded.copy()
        for front in elements[position+1:]:
            if front.get('type') in ('rect','shape','ellipse','image','svg'):
                alpha=fitted_masks.get(front.get('key'))
                if alpha is None:alpha=object_alpha(front,masks)
                if alpha is not None:visible|=alpha>220
        baseline=polygon_score(seed,distance,visible,e)
        if baseline is None:continue
        # Long, approximately horizontal/vertical sides explain base geometry.
        horizontal=[];left=[];right=[]
        for q in lines:
            a,b=q['a'],q['b'];mid=(a+b)/2
            if not (x-w*.55<=mid[0]<=x+w*1.65 and y-h*.55<=mid[1]<=y+h*1.65):continue
            if abs(math.sin(q['angle']))<.12 and q['length']>w*.35:
                if abs(mid[1]-y)<h*.6 or abs(mid[1]-(y+h))<h*.6:horizontal.append(q)
            if abs(math.sin(q['angle']))>.78 and q['length']>h*.25:
                if mid[0]<x+w*.65:left.append(q)
                if mid[0]>x+w*.35:right.append(q)
        tops=sorted((q for q in horizontal if np.mean([q['a'][1],q['b'][1]])<y+h*.55),key=lambda q:abs(np.mean([q['a'][1],q['b'][1]])-y))[:5]
        bottoms=sorted((q for q in horizontal if np.mean([q['a'][1],q['b'][1]])>y+h*.45),key=lambda q:abs(np.mean([q['a'][1],q['b'][1]])-y-h))[:5]
        left=sorted(left,key=lambda q:-q['length'])[:4];right=sorted(right,key=lambda q:-q['length'])[:4]
        candidates=[]
        quad_family=len(seed)==4 and e.get('type')!='ellipse' and e.get('shape') not in ('plaque','diamond','hexagon','pentagon','star5','triangle','rtTriangle','chevron','rightArrow','leftArrow','upArrow','downArrow','leftRightArrow','upDownArrow') and e.get('contourKind') not in ('arrow','hexagon') and not e.get('arrowTail')
        for top in tops if quad_family else []:
            for bottom in bottoms:
                for l in left:
                    for r in right:
                        points=[intersect(top,l),intersect(top,r),intersect(bottom,r),intersect(bottom,l)]
                        if any(p is None for p in points):continue
                        points=np.asarray(points)
                        lo=points.min(axis=0);hi=points.max(axis=0)
                        if abs(lo[0]-x)>w*.55 or abs(lo[1]-y)>h*.6:continue
                        if not .55*w<hi[0]-lo[0]<w*1.65 or not .5*h<hi[1]-lo[1]<h*1.65:continue
                        if not cv2.isContourConvex(points.astype(np.float32)):continue
                        v1=points[3]-points[0];v2=points[2]-points[1]
                        parallel=abs(float(np.dot(v1,v2)/max(1e-6,np.linalg.norm(v1)*np.linalg.norm(v2))))
                        if parallel<.992:continue
                        # Family constraints regularize noisy, independently detected sides.
                        shift=(v1[0]+v2[0])/2;height=(v1[1]+v2[1])/2
                        top_y=(points[0,1]+points[1,1])/2;bottom_y=top_y+height
                        lx=(points[0,0]+points[3,0]-shift)/2;rx=(points[1,0]+points[2,0]-shift)/2
                        poly=np.array([[lx,top_y],[rx,top_y],[rx+shift,bottom_y],[lx+shift,bottom_y]])
                        measured=polygon_score(poly,distance,visible,e,.035)
                        if measured is not None:candidates.append((measured,poly))
        candidates.sort(key=lambda item:item[0][0]);best=candidates[0] if candidates else None
        diagnostics.append({'key':e['key'],'baseline':list(baseline),'best':list(best[0]) if best else None,'candidates':len(candidates),'sides':{'top':len(tops),'bottom':len(bottoms),'left':len(left),'right':len(right)}})
        if not spec.get('paintOnly') and best and best[0][0]<baseline[0]-.25 and best[0][1]>=max(.4,baseline[1]-.01):
            score,poly=best;lo=poly.min(axis=0);hi=poly.max(axis=0);size=hi-lo;norm=(poly-lo)/size
            shift=poly[3,0]-poly[0,0];base='parallelogram' if abs(shift)>max(3,size[0]*.015) else 'rectangle'
            corners=fit_corners(poly,distance,visible)
            alpha=np.zeros((900,1600),np.uint8);cv2.fillPoly(alpha,[np.rint(poly).astype(np.int32)],int(255*float(e.get('opacity',1))*float(e.get('fillOpacity',1))))
            fitted_masks[e['key']]=alpha
            geometry={'version':2,'corners':corners}
            if base=='parallelogram':geometry.update({'headDepth':float(abs(shift)/size[0]),'slantSign':1 if shift<0 else -1})
            properties={'x':round(float(lo[0]),4),'y':round(float(lo[1]),4),'w':round(float(size[0]),4),'h':round(float(size[1]),4),'type':'shape' if base=='parallelogram' else 'rect','shape':base if base=='parallelogram' else 'rect','shapeGeometry':geometry,'baseGeometry':{'kind':base,'confidence':round(score[1],3)}}
            overflow=(lo<0).any() or hi[0]>1600 or hi[1]>900
            results.append({'key':e['key'],'properties':properties,'extendsCanvas':bool(overflow),'fullVertices':np.round(poly,3).tolist(),
                            'beforeError':round(baseline[0],4),'afterError':round(score[0],4),'visibleCoverage':round(score[1],4),'samples':score[2],
                            'method':'long-edge-Huber+parallel-family+occlusion-aware-fit'})
        # Geometry and paint have separate evidence and acceptance gates. Use the
        # chosen complete contour, while excluding text and opaque front objects.
        chosen=visible_canvas_region(best[1]) if best and results and results[-1]['key']==e['key'] else visible_canvas_region(seed)
        if len(chosen)>=3:
            measured_element={**e,**(results[-1]['properties'] if results and results[-1]['key']==e['key'] else {})}
            dense=[]
            for a,b in zip(chosen,np.roll(chosen,-1,axis=0)):
                dense.extend(a+(b-a)*np.linspace(0,1,max(3,int(np.linalg.norm(b-a)/4)),endpoint=False)[:,None])
            contour=np.rint(dense).astype(np.int32).reshape(-1,1,2)
            contour[:,:,0]=np.clip(contour[:,:,0],0,1599);contour[:,:,1]=np.clip(contour[:,:,1],0,899)
            # Unmapped reference glyph edges must not become gradient color stops.
            detail={'key':e['key']}
            underlay=frame_underlay(background,elements,position,masks,measured_element)
            paint=fit_shape_paint(ref,contour,measured_element,[],(visible|glyphs).astype(np.uint8)*255,diagnostics=detail,background=underlay)
            if not paint.get('fill') and not paint.get('solidFill'):
                hidden=(visible|(cv2.dilate(glyphs.astype(np.uint8),np.ones((7,7),np.uint8))>0)).astype(np.uint8)*255
                fallback={}
                smooth=fit_shape_paint(low_frequency,contour,measured_element,[],hidden,diagnostics=fallback,background=underlay)
                detail['lowFrequency']=fallback
                for field in ('fill','solidFill'):
                    if smooth.get(field):paint[field]={**smooth[field],'referenceBand':'low-frequency'}
            detail['acceptedFields']=list(paint);paint_diagnostics.append(detail)
            paint_regions[e['key']]=(contour,measured_element,visible|glyphs)
            if paint:
                properties={}
                for name,field in (('fill','gradient'),('stroke','strokeGradient')):
                    if paint.get(name):properties[field]=paint[name]['gradient']
                paint_proposals.append({'key':e['key'],'properties':properties,'measurements':paint})
        # Independently inspect internal stable boundary evidence, even when no
        # additional object was declared in the model inventory.
        for group in evidence['groups']:
            area=max(0,min(x+w,group['x']+group['w'])-max(x,group['x']))*max(0,min(y+h,group['y']+group['h'])-max(y,group['y']))
            if area>group['w']*group['h']*.7 and .10*h<group['h']<.7*h and not any(other.get('key')!=e['key'] and other.get('nativeRequired') and abs(other['y']-group['y'])<12 and abs(other['h']-group['h'])<20 for other in elements):
                comparison=layer_comparison(ref,excluded,e,group)
                unresolved.append({'key':e['key'],'kind':'possible-unregistered-layer','region':{k:group[k] for k in ('x','y','w','h')},'hypotheses':group['hypotheses'],'confidence':group['confidence'],'comparison':comparison})
                if comparison and comparison['preferred']=='overlapping-frame':break
    # Title outlines must use the fitted full parent, not the model's original
    # rough rectangle; otherwise the independent clipped edge is searched in
    # the wrong place and a real title plate is missed again.
    fitted={p['key']:p['properties'] for p in results}
    title_elements=[]
    for e in elements:
        properties=fitted.get(e['key'],{});current={**e,**properties}
        if properties and not properties.get('customGeometry'):current.pop('customGeometry',None)
        title_elements.append(current)
    unresolved=missing_title_carriers(ref,title_elements,lines,excluded,set(spec.get('headingNodeIds',[])))+unresolved
    # Missing paint can borrow ONLY a proven same-family parameter, then must
    # improve its own reference samples. Geometry/dimensions are never copied.
    paints={p['key']:p for p in paint_proposals};originals={e['key']:e for e in elements}
    for key,(contour,e,hidden) in paint_regions.items():
        existing=paints.get(key)
        if existing and (existing['measurements'].get('fill') or existing['measurements'].get('solidFill')):continue
        if any(k in e.get('keepParameters',[]) for k in ('fill','gradientAngle','gradientCenter','gradientStops')):continue
        mask=np.zeros((900,1600),np.uint8);cv2.fillPoly(mask,[contour],1);mask=cv2.erode(mask,np.ones((9,9),np.uint8));mask[hidden]=0
        yy,xx=np.where(mask>0)
        if len(xx)<100:continue
        pixels,xx,yy=spatial_samples(low_frequency[yy,xx].astype(float),xx,yy)
        baseline=predict_paint(e.get('gradient') or e.get('fill'),xx,yy,e)
        if baseline is None:continue
        before=float(np.mean(abs(baseline-pixels)));options=[]
        for source,p in paints.items():
            m=p['measurements'].get('fill');o=originals[source]
            same_explicit=e.get('parameterGroups',{}).get('fill') and e.get('parameterGroups',{}).get('fill')==o.get('parameterGroups',{}).get('fill')
            same_initial=e.get('frameKind')==o.get('frameKind') and e.get('gradient')==o.get('gradient') and e.get('fill')==o.get('fill') and max(e['h']/o['h'],o['h']/e['h'])<1.4
            if not m or not m.get('accepted') or m.get('scope')=='group-base-fill' or not (same_explicit or same_initial):continue
            if e.get('state')!=o.get('state') or e.get('progressState')!=o.get('progressState'):continue
            measured=validate_shared_paint(pixels,xx,yy,e,m['gradient'])
            if measured:options.append((measured['robustError'],source,m,measured['afterError'],measured['confidence']))
        if not options:continue
        robust,source,m,after,coverage=min(options,key=lambda x:x[0])
        shared={**m,'method':'validated-shared-fill-prototype','referenceSource':source,'scope':'group-base-fill','beforeError':round(before,3),'afterError':round(after,3),'robustError':round(robust,3),'confidence':round(coverage,3),'samples':len(pixels),'accepted':True}
        proposal=existing or {'key':key,'properties':{},'measurements':{}}
        proposal['properties']['gradient']=shared['gradient'];proposal['measurements']['fill']=shared
        if not existing:paint_proposals.append(proposal);paints[key]=proposal
        for d in paint_diagnostics:
            if d['key']==key:d['sharedFill']=shared;d['acceptedFields']=list(proposal['measurements'])
    line_proposals,line_diagnostics=[],[]
    return {'status':'available','version':VERSION,'proposals':results,'paintProposals':paint_proposals,'paintDiagnostics':paint_diagnostics,'lineProposals':line_proposals,'lineDiagnostics':line_diagnostics,'lightEvidence':light_profiles(ref,background,elements),'frameEvidence':evidence,'unresolved':unresolved,'diagnostics':diagnostics,'elapsedMs':round((time.perf_counter()-started)*1000,1)}


if __name__=='__main__':
    try:
        spec=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')); result=fit_native_frames(spec)
        print(json.dumps(result,ensure_ascii=True))
    except Exception as error:
        print(json.dumps({'status':'unavailable','error':str(error)[:700]}));sys.exit(1)
