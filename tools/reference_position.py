"""Independent bounded object registration against the approved preview; translation only."""
import json,sys
from pathlib import Path
import cv2
import numpy as np
from repeated_panel_position import locate_panels, panel_markers, source
cv2.setNumThreads(1)


def locate_circle_columns(elements, reference, background):
    """Ordered rows/columns use distinct discs; ambiguous groups never fall back to nearest."""
    circles=[e for e in elements if e['type']=='ellipse' and max(e['w'],e['h'])<=80
             and min(e['w'],e['h'])>=6 and max(e['w'],e['h'])/min(e['w'],e['h'])<1.18
             and not e.get('rotate') and float(e.get('fillOpacity',1))*float(e.get('opacity',1))>.2]
    def seed(e):
        return (e.get('objectIdentity') or {}).get('sourceBox') or e
    groups=[];claimed=set()
    for axis in (1,0):
        remaining=[e for e in circles if e['key'] not in claimed]
        candidates=[]
        for e in sorted(remaining,key=lambda e:(e['y'],e['x'],e['key'])):
            def aligned(p):
                cross='x' if axis else 'y';extent='w' if axis else 'h'
                along='y' if axis else 'x'
                return (abs(e[cross]+e[extent]/2-p[cross]-p[extent]/2)<max(e['w'],p['w'])
                        and max(e['w']/p['w'],p['w']/e['w'])<1.25
                        and abs(seed(e)[along]-seed(p)[along])>max(e['w'],p['w'])*1.5
                        and e.get('visualState',e.get('emphasis','normal'))==p.get('visualState',p.get('emphasis','normal')))
            group=next((g for g in candidates if all(aligned(p) for p in g)),None)
            if group is None:candidates.append([e])
            else:group.append(e)
        for group in candidates:
            if len(group)>=2:
                groups.append((axis,group));claimed.update(e['key'] for e in group)
    output={}
    for axis,group in groups:
        along='y' if axis else 'x';cross='x' if axis else 'y'
        group=sorted(group,key=lambda e:seed(e)[along]);diameter=float(np.median([e['w'] for e in group]))
        span=seed(group[-1])[along]-seed(group[0])[along]
        pad=min(180,max(80,span*.4,span/max(1,len(group)-1)*1.7))
        centre=float(np.median([e[cross]+(e['w'] if axis else e['h'])/2 for e in group]))
        low=int(min(min(e[along],seed(e)[along]) for e in group)-pad)
        high=int(max(max(e[along],seed(e)[along]) for e in group)+diameter+pad)
        left=max(0,int(centre-diameter*2) if axis else low);right=min(1600,int(centre+diameter*2) if axis else high)
        top=max(0,low if axis else int(centre-diameter*2));bottom=min(900,high if axis else int(centre+diameter*2))
        members=[e['key'] for e in group]
        for e in group:output[e['key']]={'key':e['key'],'accepted':False,'reason':'ambiguous-repeated-circle-correspondence',
            'method':'distinct-reference-circle-components','members':members}
        crop=reference[top:bottom,left:right]
        if crop.size==0:continue
        # The foundation can differ across the page. Local median suppression
        # isolates both light and dark discs without reading or changing paint.
        kernel=max(5,int(diameter*3)//2*2+1)
        lower=cv2.medianBlur(crop,kernel)
        mask=(np.max(abs(crop.astype(float)-lower.astype(float)),axis=2)>24).astype(np.uint8)
        count,labels,stats,centres=cv2.connectedComponentsWithStats(mask,8)
        candidates=[]
        for i in range(1,count):
            x,y,w,h,area=stats[i]
            if not (.72*diameter<=w<=1.30*diameter and .72*diameter<=h<=1.30*diameter
                    and max(w/h,h/w)<1.20 and .60<=area/(w*h)<=.90):continue
            contours=cv2.findContours((labels==i).astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)[0]
            contour=max(contours,key=cv2.contourArea);perimeter=cv2.arcLength(contour,True)
            if not perimeter or 4*np.pi*cv2.contourArea(contour)/perimeter**2<.72:continue
            candidates.append((float(centres[i][0]+left),float(centres[i][1]+top)))
        if len(candidates)<len(group) and diameter>=20:
            # A disc attached to a banner may have no isolated fill component.
            # Count closed circular rims, coalescing both faces of the same edge.
            edges=cv2.Canny(crop,40,120)
            for contour in cv2.findContours(edges,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)[0]:
                x,y,w,h=cv2.boundingRect(contour)
                if not .78*diameter<=min(w,h)<=max(w,h)<=1.23*diameter or max(w,h)>min(w,h)*1.12:continue
                perimeter=cv2.arcLength(contour,True)
                if 4*np.pi*cv2.contourArea(contour)/max(1,perimeter**2)<.75 or len(cv2.approxPolyDP(contour,.025*perimeter,True))<7:continue
                point=(left+x+(w-1)/2,top+y+(h-1)/2)
                if all(np.hypot(point[0]-px,point[1]-py)>diameter*.15 for px,py in candidates):candidates.append(point)
        # Exact cardinality and preserved order avoid guessing missing dots or
        # assigning one visible component to two registered instances.
        if len(candidates)!=len(group):continue
        candidates.sort(key=lambda c:c[axis])
        if max(p[1-axis] for p in candidates)-min(p[1-axis] for p in candidates)>diameter*.5:continue
        if any(candidates[i+1][axis]-p[axis]<diameter*1.5 for i,p in enumerate(candidates[:-1])):continue
        if any(abs(p[axis]-(seed(e)[along]+(e['h'] if axis else e['w'])/2))>pad for e,p in zip(group,candidates)):continue
        for e,(x,y) in zip(group,candidates):
            nx=x-e['w']/2;ny=y-e['h']/2
            output[e['key']]={'key':e['key'],'accepted':True,'x':round(nx,3),'y':round(ny,3),
                'dx':round(nx-e['x'],3),'dy':round(ny-e['y'],3),'confidence':.9,
                'method':'distinct-reference-circle-components','members':members,
                'referenceCenter':[round(x,3),round(y,3)]}
    return output


def locate(element,mask_file,reference,panel=None):
    key=element['key'];row={'key':key,'accepted':False}
    rendered=cv2.imread(str(mask_file),cv2.IMREAD_UNCHANGED)
    if rendered is None or rendered.ndim!=3 or rendered.shape[2]!=4:return {**row,'reason':'no-object-alpha'}
    rendered=cv2.resize(rendered,(1600,900));alpha=rendered[:,:,3]
    filled=alpha>max(24,float(alpha.max())*.45)
    if filled.sum()<12:return {**row,'reason':'insufficient-object-evidence'}
    text=element['type'] in ('text','formula')
    compact=not text and element['type'] in ('shape','rect','ellipse') and max(element['w'],element['h'])<=100 and float(element.get('strokeWidth') or 0)==0
    # Use visible geometry, not an opaque box or inherited parent translation.
    if not text and not compact:
        filled=cv2.morphologyEx(filled.astype(np.uint8),cv2.MORPH_GRADIENT,np.ones((3,3),np.uint8))>0
    yy,xx=np.where(filled)
    left,top,right,bottom=int(xx.min()),int(yy.min()),int(xx.max()+1),int(yy.max()+1)
    if text:
        # Line wrapping and font metrics may differ from the preview. Match a
        # distinctive leading span, not an entire differently wrapped paragraph.
        ink_rows=filled[top:bottom,left:right].any(axis=1);gaps=np.flatnonzero(~ink_rows)
        split=next((i for i in gaps if i>max(4,float(element.get('size',24))*.4)),None)
        if split is not None:bottom=min(bottom,top+int(split))
        right=min(right,left+max(80,min(190,int(float(element.get('size',24))*6))))
    template=filled[top:bottom,left:right].astype(np.float32)
    accent=None
    if text:
        pixels=rendered[top:bottom,left:right,:3].astype(float)
        saturated=(pixels.max(axis=2)-pixels.min(axis=2)>70)&(template>0)
        if saturated.sum()>=max(20,template.sum()*.15):
            # The coloured prefix is more distinctive than neighbouring white
            # lines. Match that prefix in its own colour, preserving identity.
            accent=np.median(pixels[saturated],axis=0)
            template=saturated.astype(np.float32)
    if min(template.shape)<3 or template.sum()<12:return {**row,'reason':'insufficient-object-extent'}
    # Fixed original neighbourhood bounds prevent repeated refits walking across rows.
    seed=(element.get('objectIdentity') or {}).get('sourceBox') or element
    radius_x=min(60,max(12,float(element['w'])*.15));radius_y=min(90,max(18,float(element['h'])*.8,float(element.get('size',24))*2.5 if text else 0))
    if compact:
        radius_x=radius_y=min(80,max(28,min(element['w'],element['h'])*2))
    sx=float(seed.get('x',element['x']));sy=float(seed.get('y',element['y']))
    dx0=max(-radius_x,sx-radius_x-element['x']);dx1=min(radius_x,sx+radius_x-element['x'])
    dy0=max(-radius_y,sy-radius_y-element['y']);dy1=min(radius_y,sy+radius_y-element['y'])
    if panel and text:
        px,py,pw,ph=panel['referenceBox'];cx=sx+panel['shift'][0]-element['x'];cy=sy+panel['shift'][1]-element['y']
        dx0=max(px-left,cx-radius_x);dx1=min(px+pw-right,cx+radius_x)
        dy0=max(py-top,cy-radius_y);dy1=min(py+ph-bottom,cy+radius_y)
    tolerance_x=int(template.shape[1]*.11)+1 if text else 0
    tolerance_y=int(template.shape[0]*.11)+1 if text else 0
    x0=max(0,int(left+dx0));x1=min(1600,int(right+dx1+1)+tolerance_x);y0=max(0,int(top+dy0));y1=min(900,int(bottom+dy1+1)+tolerance_y)
    if x1-x0<template.shape[1] or y1-y0<template.shape[0]:return {**row,'reason':'outside-search-neighbourhood'}
    crop=reference[y0:y1,x0:x1]
    if text:
        rgb=np.median(rendered[:,:,:3][alpha>max(64,float(alpha.max())*.7)],axis=0)
        gray=cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY).astype(float)
        if accent is not None:
            observed=(np.linalg.norm(crop.astype(float)-accent,axis=2)<65).astype(np.float32)
        elif rgb.mean()>150:
            # Yellow accent prefixes belong to the same text as white prose.
            # A low-saturation-only mask made the leading-span match reject them.
            observed=(gray>max(120,float(np.percentile(gray,40))+35)).astype(np.float32)
        elif rgb.mean()<100:
            observed=(gray<min(125,float(np.percentile(gray,65))-30)).astype(np.float32)
        else:
            delta=np.linalg.norm(crop.astype(float)-rgb,axis=2);observed=(delta<48).astype(np.float32)
    elif compact:
        rgb=np.median(rendered[:,:,:3][alpha>max(64,float(alpha.max())*.7)],axis=0)
        # Match the filled silhouette, not nearby letter edges. The declared
        # palette scopes correspondence; paint is still measured independently.
        observed=(np.linalg.norm(crop.astype(float)-rgb,axis=2)<75).astype(np.float32)
    else:
        observed=(cv2.Canny(crop,35,100)>0).astype(np.float32)
    # Small antialias tolerance, with normalised agreement penalising nearby clutter.
    observed=cv2.GaussianBlur(observed,(3,3),.65)
    if text:
        # Preview fonts can have slightly different glyph proportions. Probe a
        # small visual tolerance without changing exported font/size or box.
        maps=[]
        for scale in (.9,1.,1.1):
            trial=cv2.resize(template,None,fx=scale,fy=scale,interpolation=cv2.INTER_AREA)
            trial=cv2.GaussianBlur(trial,(3,3),.65)
            score=cv2.matchTemplate(observed,trial,cv2.TM_CCORR_NORMED)
            maps.append(score)
        h=min(min(s.shape[0] for s in maps),int(top+dy1-y0)+1);w=min(min(s.shape[1] for s in maps),int(left+dx1-x0)+1)
        scores=np.maximum.reduce([s[:h,:w] for s in maps])
    else:scores=cv2.matchTemplate(observed,template,cv2.TM_CCORR_NORMED)
    scores=np.nan_to_num(scores,nan=0,posinf=0,neginf=0)
    _,best,_,at=cv2.minMaxLoc(scores);bx,by=at
    ix,iy=int(np.clip(left-x0,0,scores.shape[1]-1)),int(np.clip(top-y0,0,scores.shape[0]-1))
    baseline=float(scores[iy,ix]) if x0<=left<x0+scores.shape[1] and y0<=top<y0+scores.shape[0] else 0.
    dx=float(x0+bx-left);dy=float(y0+by-top)
    competing=scores.copy();competing[max(0,by-8):by+9,max(0,bx-8):bx+9]=0
    margin=float(best-competing.max())
    row.update(beforeScore=round(baseline,5),afterScore=round(best,5),margin=round(margin,5),dx=dx,dy=dy)
    if best<(.56 if text else .28) or best-baseline<.035 or margin<.015:
        return {**row,'reason':'ambiguous-or-no-position-gain'}
    confidence=float(min(.95,best)*min(1,margin/.04))
    if max(abs(dx),abs(dy))>8 and confidence<.45:
        return {**row,'reason':'weak-large-displacement','confidence':round(confidence,4)}
    if abs(dx)<1 and abs(dy)<1:return {**row,'reason':'already-aligned'}
    # Do not accept a maximum truncated by the bounded search window.
    if bx in (0,scores.shape[1]-1) or by in (0,scores.shape[0]-1):return {**row,'reason':'search-boundary-maximum'}
    return {**row,'accepted':True,'x':round(element['x']+dx,3),'y':round(element['y']+dy,3),'confidence':round(min(.95,best)*min(1,margin/.04),4)}


def badge_positions(relation, grouped, reference, masks):
    circle,number,band,heading=(relation[k] for k in ('circle','number','band','heading'))
    center=grouped.get(circle['key'],{}).get('referenceCenter')
    def bgr(value):
        try:return np.frombuffer(bytes.fromhex(value.lstrip('#')),dtype=np.uint8).reshape(3)[::-1].astype(float)
        except (AttributeError,ValueError):return None
    fill=bgr(band.get('fill'))
    if not center or fill is None or band['w']<band['h']*2:return {}
    cx,cy=center;radius=circle['w']/2
    right=heading['x']+heading['w']/2>number['x']+number['w']/2
    reach=band['w']*1.35+radius
    x0=max(0,int(cx-(radius if right else reach)));x1=min(1600,int(cx+(reach if right else radius))+1)
    y0=max(0,int(cy-band['h']));y1=min(900,int(cy+band['h'])+1)
    crop=reference[y0:y1,x0:x1].astype(np.float32)
    if not crop.size:return {}
    region=(np.linalg.norm(crop-fill,axis=2)<90).astype(np.uint8)
    _,_,stats,_=cv2.connectedComponentsWithStats(region,8)
    candidates=[]
    for x,y,w,h,area in stats[1:]:
        left,top=x+x0,y+y0
        near=left if right else left+w
        if (.65*band['w']<=w<=1.3*band['w'] and .65*band['h']<=h<=1.35*band['h']
                and area>w*h*.55 and abs(near-cx)<=radius*1.4 and abs(top+h/2-cy)<radius*.5):
            candidates.append((left,top,w,h))
    if len(candidates)!=1:return {}
    left,top,w,h=candidates[0]
    def position(e,x,y):
        x,y=float(x),float(y)
        return {'key':e['key'],'accepted':True,'x':round(x,3),'y':round(y,3),'dx':round(x-e['x'],3),
                'dy':round(y-e['y'],3),'confidence':.9,'method':'registered-badge-and-banner-ink'}
    rows={band['key']:position(band,left,top)}
    for text in (number,heading):
        ink=bgr(text.get('color'));file=masks.get(text['key'])
        if ink is None or file is None or np.linalg.norm(ink-fill)<110:continue
        if text is number:
            yy,xx=np.ogrid[y0:y1,x0:x1];inner=(xx-cx)**2+(yy-cy)**2<(radius*.76)**2
        else:
            yy,xx=np.ogrid[y0:y1,x0:x1];inner=(xx>=left+4)&(xx<left+w-4)&(yy>=top+h*.16)&(yy<top+h*.84)
            inner &= (xx>cx+radius+3) if right else (xx<cx-radius-3)
        foreground=inner&(np.linalg.norm(crop-ink,axis=2)<70)
        iy,ix=np.where(foreground)
        if len(ix)<12:continue
        rendered=cv2.imread(file,cv2.IMREAD_UNCHANGED)
        if rendered is None or rendered.ndim!=3 or rendered.shape[2]!=4:continue
        alpha=cv2.resize(rendered[:,:,3],(1600,900));sy,sx=np.where(alpha>max(24,float(alpha.max())*.45))
        if not len(sx) or not .60<=(np.ptp(ix)+1)/(np.ptp(sx)+1)<=1.5 or not .55<=(np.ptp(iy)+1)/(np.ptp(sy)+1)<=1.7:continue
        dx=x0+(ix.min()+ix.max()-sx.min()-sx.max())/2
        dy=y0+(iy.min()+iy.max()-sy.min()-sy.max())/2
        rows[text['key']]=position(text,text['x']+dx,text['y']+dy)
    return rows


def main():
    spec=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'));reference=cv2.resize(cv2.imread(spec['reference']),(1600,900))
    background=cv2.imread(spec['background']) if spec.get('background') else None
    if background is not None:background=cv2.resize(background,(1600,900))
    grouped=locate_circle_columns(spec.get('circleElements',spec['elements']),reference,background)
    panels=spec.get('panels',[]);panel_rows=locate_panels(panels,reference)
    grouped.update(panel_rows)
    grouped.update(panel_markers(panels,panel_rows,spec.get('circleElements',[]),reference))
    hints={e['key']:{**panel_rows[e['key']],'shift':[panel_rows[e['key']][k]-source(e)[k] for k in ('x','y')]} for e in panels if e['key'] in panel_rows}
    masks={m['key']:m.get('file') for m in spec.get('objectMasks',[])};results=[]
    for relation in spec.get('badges',[]):
        grouped.update(badge_positions(relation,grouped,reference,masks))
    for e in spec['elements']:
        if e['key'] in grouped:
            results.append(grouped[e['key']]);continue
        try:row=locate(e,masks.get(e['key']),reference,hints.get(e.get('carrierId'))) if masks.get(e['key']) else {'key':e['key'],'accepted':False,'reason':'no-object-mask'}
        except Exception as error:row={'key':e['key'],'accepted':False,'reason':str(error)[:200]}
        results.append(row)
    Path(sys.argv[2]).write_text(json.dumps({'results':results},indent=1),encoding='utf-8')
    print(json.dumps({'objects':len(results),'relocated':sum(r['accepted'] for r in results)}))


if __name__=='__main__':main()
