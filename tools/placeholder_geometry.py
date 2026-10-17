"""Measure flat image placeholders at native resolution; never warp originals.

AI boxes are location hints, not ground truth. Uncertain/ambiguous assignments
keep those hints unchanged. Output coordinates use the shared 1600x900 scene.
"""
import itertools
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

cv2.setNumThreads(1)
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8')
VERSION = 'placeholder-geometry-v3'


def intersection(a, b):
    return max(0, min(a[0]+a[2], b[0]+b[2])-max(a[0], b[0])) * max(0, min(a[1]+a[3], b[1]+b[3])-max(a[1], b[1]))


def iou(a, b):
    overlap = intersection(a, b)
    return overlap / max(1, a[2]*a[3]+b[2]*b[3]-overlap)


def assignment(cost):
    """Rectangular Hungarian assignment, rows <= columns; O(rows^2*columns)."""
    n, m = cost.shape
    u, v, p, way = np.zeros(n+1), np.zeros(m+1), np.zeros(m+1, int), np.zeros(m+1, int)
    for i in range(1, n+1):
        p[0] = i
        j0, minimum, used = 0, np.full(m+1, np.inf), np.zeros(m+1, bool)
        while True:
            used[j0] = True
            i0, delta, j1 = p[j0], np.inf, 0
            for j in range(1, m+1):
                if used[j]:
                    continue
                value = cost[i0-1, j-1]-u[i0]-v[j]
                if value < minimum[j]:
                    minimum[j], way[j] = value, j0
                if minimum[j] < delta:
                    delta, j1 = minimum[j], j
            for j in range(m+1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minimum[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while j0:
            j1 = way[j0]
            p[j0], j0 = p[j1], j1
    selected = [-1]*n
    for j in range(1, m+1):
        if p[j]:
            selected[p[j]-1] = j-1
    return selected


def quality(lab, edges, box):
    x, y, w, h = box
    inset = max(2, min(6, int(min(w, h)*.025)))
    inside = lab[y+inset:y+h-inset, x+inset:x+w-inset]
    if not inside.size:
        return None
    # Sampling bounds work per candidate even for large flat rectangles.
    pixels = inside[::max(1, h//100), ::max(1, w//100)].reshape(-1, 3)
    color = np.median(pixels, axis=0)
    distances = np.linalg.norm(pixels-color, axis=1)
    uniformity = float(np.mean(distances < 7))
    # Generated placeholders can have a mild gradient or noise. Accept quiet
    # fills, but reject text, illustrations and strong gradients.
    quiet = (np.percentile(distances, 95) <= 12 and
             np.mean(edges[y+inset:y+h-inset, x+inset:x+w-inset] > 0) < .003)
    if (uniformity < .995 or np.percentile(distances, 95) > 7) and not quiet:
        return None
    # The boundary must describe the flat *inner* fill, not an enclosing stroke
    # or shadow whose interior only becomes uniform after a generous inset.
    cx,cy=max(3,int(w*.12)),max(3,int(h*.12))
    rings=[lab[y+1,x+cx:x+w-cx],lab[y+h-2,x+cx:x+w-cx],
           lab[y+cy:y+h-cy,x+1],lab[y+cy:y+h-cy,x+w-2]]
    if any(not ring.size or np.mean(np.linalg.norm(ring-color,axis=1)<16)<.92 for ring in rings):
        return None
    H, W = lab.shape[:2]
    border, contrast = [], []
    for vertical, at, start, length in [(True,x,y,h),(True,x+w,y,h),(False,y,x,w),(False,y+h,x,w)]:
        if vertical:
            strip = edges[start+inset:start+length-inset, max(0,at-3):min(W,at+4)]
            outside = lab[start+inset:start+length-inset, max(0,at-5):max(0,at-2)] if at==x else lab[start+inset:start+length-inset,min(W,at+2):min(W,at+5)]
            support = np.mean(np.any(strip>0,axis=1)) if strip.size else 0
        else:
            strip = edges[max(0,at-3):min(H,at+4), start+inset:start+length-inset]
            outside = lab[max(0,at-5):max(0,at-2),start+inset:start+length-inset] if at==y else lab[min(H,at+2):min(H,at+5),start+inset:start+length-inset]
            support = np.mean(np.any(strip>0,axis=0)) if strip.size else 0
        border.append(float(support))
        contrast.append(float(np.median(np.linalg.norm(outside-color,axis=2))) if outside.size else 0)
    # All four sides need independent evidence: no invented edge at a crop boundary.
    evidence = [max(s, min(1, c/10)) for s,c in zip(border,contrast)]
    if min(evidence) < .45 or np.mean(evidence) < .75:
        return None
    return {'uniformity':uniformity,'edgeSupport':float(np.mean(border)),
            'boundaryEvidence':float(np.mean(evidence)),
            'confidence':float(.45*(max(uniformity,.98) if quiet else uniformity)+.55*np.mean(evidence))}


def candidates_for(rgb, lab, edges, coarse, outlined=()):
    H, W = rgb.shape[:2]
    x,y,w,h = coarse
    mx,my = max(24,w*.3),max(24,h*.3)
    left,top = max(0,int(x-mx)),max(0,int(y-my))
    right,bottom = min(W,math.ceil(x+w+mx)),min(H,math.ceil(y+h+my))
    local = lab[top:bottom,left:right]
    local_edges = edges[top:bottom,left:right]
    # Full-canvas closed boundaries recover frames whose far edge lies outside
    # the coarse AI search window. Spatial identity still governs assignment.
    proposals=list(outlined)
    colors=[]
    # Flat-region connected contours find the inner fill, excluding outlines/shadows.
    for fx,fy in itertools.product([.3,.5,.7],repeat=2):
        sx,sy = min(W-1,max(0,int(x+w*fx))),min(H-1,max(0,int(y+h*fy)))
        color=np.median(lab[max(0,sy-1):sy+2,max(0,sx-1):sx+2].reshape(-1,3),axis=0)
        if any(np.linalg.norm(color-previous)<2 for previous in colors):continue
        colors.append(color)
        mask=(np.linalg.norm(local-color,axis=2)<7).astype(np.uint8)*255
        mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
        contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            bx,by,bw,bh=cv2.boundingRect(contour)
            if bx<=1 or by<=1 or bx+bw>=right-left-1 or by+bh>=bottom-top-1:
                continue
            if cv2.contourArea(contour)/max(1,bw*bh)>.93:
                proposals.append((bx+left,by+top,bw,bh,'color-contour'))
    # Closed four-sided outlines cover subtle fill differences.
    contours,_=cv2.findContours(local_edges,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        polygon=cv2.approxPolyDP(contour,.015*cv2.arcLength(contour,True),True)
        if len(polygon)==4 and cv2.isContourConvex(polygon):
            bx,by,bw,bh=cv2.boundingRect(polygon)
            if cv2.contourArea(polygon)/max(1,bw*bh)>.94:
                proposals.append((bx+left,by+top,bw,bh,'edge-contour'))
    # Hough segments allow interrupted borders; no perspective warp is applied.
    lines=cv2.HoughLinesP(local_edges,1,np.pi/180,threshold=30,
                         minLineLength=max(12,int(min(w,h)*.35)),maxLineGap=12)
    if lines is not None:
        vertical,horizontal=[],[]
        for a,b,c,d in lines[:150,0]:
            if abs(a-c)<=2 and abs(b-d)>=h*.35:
                vertical.append((a+c)/2+left)
            if abs(b-d)<=2 and abs(a-c)>=w*.35:
                horizontal.append((b+d)/2+top)
        def nearby(values, expected):
            chosen=[]
            for value in sorted(values,key=lambda v:abs(v-expected)):
                if abs(value-expected)<=max(15,min(w,h)*.22) and all(abs(value-v)>3 for v in chosen):
                    chosen.append(value)
                if len(chosen)==2:break
            return chosen
        for a,b,c,d in itertools.product(nearby(vertical,x),nearby(horizontal,y),nearby(vertical,x+w),nearby(horizontal,y+h)):
            # Canny can lie on either side of a 1–3px stroke. Test the inward
            # alternatives against actual fill pixels instead of taking its center.
            for inset in range(4):
                if c-a>2*inset and d-b>2*inset:
                    proposals.append((round(a)+inset,round(b)+inset,round(c-a)-2*inset,round(d-b)-2*inset,'hough-lines'))
    candidates=[]
    for bx,by,bw,bh,method in proposals:
        box=(bx,by,bw,bh)
        if min(bw,bh)<12 or not .35<=bw*bh/max(1,w*h)<=2.2 or iou(box,coarse)<.3:
            continue
        if bx<0 or by<0 or bx+bw>W or by+bh>H:
            continue
        metrics=quality(lab,edges,box)
        if metrics:
            candidates.append({'box':list(box),'method':method,**metrics})
    return candidates


def localize(spec):
    with Image.open(spec['image']) as im:
        rgb=np.asarray(im.convert('RGB'))
    H,W=rgb.shape[:2]
    lab=cv2.cvtColor(rgb.astype(np.float32)/255,cv2.COLOR_RGB2LAB)
    gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    edges=cv2.Canny(cv2.GaussianBlur(gray,(3,3),.6),35,100)
    outlined=[]
    contours,_=cv2.findContours(edges,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        x,y,w,h=cv2.boundingRect(contour)
        if min(w,h)<12 or cv2.contourArea(contour)/max(1,w*h)<.93:
            continue
        # Rounded rectangles do not approximate to exactly four vertices.
        for inset in range(5):
            if min(w,h)>2*inset:
                outlined.append((x+inset,y+inset,w-2*inset,h-2*inset,'closed-boundary'))
    images=spec['images']
    coarse=[(e['x']*W/1600,e['y']*H/900,e['w']*W/1600,e['h']*H/900) for e in images]
    candidates=[]
    for box in coarse:
        for candidate in candidates_for(rgb,lab,edges,box,outlined):
            # Inner/outer Canny responses and inward Hough alternatives describe
            # one physical region; they must never become slots for two images.
            duplicate=next((c for c in candidates if iou(c['box'],candidate['box'])>.85),None)
            if duplicate is None:candidates.append(candidate)
            elif (candidate['method']=='color-contour',candidate['confidence'])>(duplicate['method']=='color-contour',duplicate['confidence']):duplicate.update(candidate)
    # Every image has a private no-op column. Missing/ambiguous detections are valid.
    costs=np.full((len(images),len(candidates)+len(images)),1000.)
    for i,box in enumerate(coarse):
        costs[i,len(candidates)+i]=1.15
        for j,c in enumerate(candidates):
            overlap=iou(box,c['box'])
            if overlap<.3:continue
            # Identity comes from the AI-confirmed node and its location hint.
            # Original image ratios/dimensions never participate in assignment.
            costs[i,j]=1.6*(1-overlap)+.2*(1-c['confidence'])
    selected=assignment(costs) if images else []
    output=[]
    for i,(e,j) in enumerate(zip(images,selected)):
        chosen=candidates[j] if j<len(candidates) and costs[i,j]<1.15 else None
        if chosen:
            alternatives=sorted((costs[i,k] for k in range(len(candidates)) if k!=j and iou(chosen['box'],candidates[k]['box'])<.7))
            if alternatives and alternatives[0]-costs[i,j]<.1:chosen=None
        if chosen:
            x,y,w,h=chosen['box']
            output.append({**e,'x':x*1600/W,'y':y*900/H,'w':w*1600/W,'h':h*900/H,
                           'localization':{**chosen,'status':'refined','cost':float(costs[i,j])}})
        else:
            output.append({**e,'localization':{'status':'fallback','reason':'未找到唯一可信的平坦四边区域，保留AI定位'}})
    return {'version':VERSION,'status':'available','width':W,'height':H,'candidateCount':len(candidates),
            'method':'Lab-connected-contours+Canny-Hough+position-guided-Hungarian',
            'matchingBasis':'AI-node-identity+spatial-overlap+boundary-confidence','images':output}


if __name__=='__main__':
    spec=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    result=localize(spec)
    Path(sys.argv[2]).write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))
