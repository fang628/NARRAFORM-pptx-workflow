"""Independent bounded object registration against the approved preview; translation only."""
import json,sys
from pathlib import Path
import cv2
import numpy as np
cv2.setNumThreads(1)


def locate(element,mask_file,reference):
    key=element['key'];row={'key':key,'accepted':False}
    rendered=cv2.imread(str(mask_file),cv2.IMREAD_UNCHANGED)
    if rendered is None or rendered.ndim!=3 or rendered.shape[2]!=4:return {**row,'reason':'no-object-alpha'}
    rendered=cv2.resize(rendered,(1600,900));alpha=rendered[:,:,3]
    filled=alpha>max(24,float(alpha.max())*.45)
    if filled.sum()<12:return {**row,'reason':'insufficient-object-evidence'}
    text=element['type'] in ('text','formula')
    # Use visible geometry, not an opaque box or inherited parent translation.
    if not text:
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
    if min(template.shape)<3 or template.sum()<12:return {**row,'reason':'insufficient-object-extent'}
    # Fixed original neighbourhood bounds prevent repeated refits walking across rows.
    seed=(element.get('objectIdentity') or {}).get('sourceBox') or element
    radius_x=min(60,max(12,float(element['w'])*.15));radius_y=min(90,max(18,float(element['h'])*.8))
    sx=float(seed.get('x',element['x']));sy=float(seed.get('y',element['y']))
    dx0=max(-radius_x,sx-radius_x-element['x']);dx1=min(radius_x,sx+radius_x-element['x'])
    dy0=max(-radius_y,sy-radius_y-element['y']);dy1=min(radius_y,sy+radius_y-element['y'])
    tolerance_x=int(template.shape[1]*.11)+1 if text else 0
    tolerance_y=int(template.shape[0]*.11)+1 if text else 0
    x0=max(0,int(left+dx0));x1=min(1600,int(right+dx1+1)+tolerance_x);y0=max(0,int(top+dy0));y1=min(900,int(bottom+dy1+1)+tolerance_y)
    if x1-x0<template.shape[1] or y1-y0<template.shape[0]:return {**row,'reason':'outside-search-neighbourhood'}
    crop=reference[y0:y1,x0:x1]
    if text:
        rgb=np.median(rendered[:,:,:3][alpha>max(64,float(alpha.max())*.7)],axis=0)
        gray=cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY).astype(float)
        if rgb.mean()>150:
            hsv=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV);observed=((gray>max(120,float(np.percentile(gray,40))+35))&(hsv[:,:,1]<110)).astype(np.float32)
        elif rgb.mean()<100:
            observed=(gray<min(125,float(np.percentile(gray,65))-30)).astype(np.float32)
        else:
            delta=np.linalg.norm(crop.astype(float)-rgb,axis=2);observed=(delta<48).astype(np.float32)
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
    baseline=float(scores[iy,ix]);dx=float(x0+bx-left);dy=float(y0+by-top)
    competing=scores.copy();competing[max(0,by-8):by+9,max(0,bx-8):bx+9]=0
    margin=float(best-competing.max())
    row.update(beforeScore=round(baseline,5),afterScore=round(best,5),margin=round(margin,5),dx=dx,dy=dy)
    if best<(.56 if text else .28) or best-baseline<.035 or margin<.015:
        return {**row,'reason':'ambiguous-or-no-position-gain'}
    if abs(dx)<1 and abs(dy)<1:return {**row,'reason':'already-aligned'}
    # Do not accept a maximum truncated by the bounded search window.
    if bx in (0,scores.shape[1]-1) or by in (0,scores.shape[0]-1):return {**row,'reason':'search-boundary-maximum'}
    return {**row,'accepted':True,'x':round(element['x']+dx,3),'y':round(element['y']+dy,3),'confidence':round(min(.95,best)*min(1,margin/.04),4)}


def main():
    spec=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'));reference=cv2.resize(cv2.imread(spec['reference']),(1600,900))
    masks={m['key']:m.get('file') for m in spec.get('objectMasks',[])};results=[]
    for e in spec['elements']:
        try:row=locate(e,masks.get(e['key']),reference) if masks.get(e['key']) else {'key':e['key'],'accepted':False,'reason':'no-object-mask'}
        except Exception as error:row={'key':e['key'],'accepted':False,'reason':str(error)[:200]}
        results.append(row)
    Path(sys.argv[2]).write_text(json.dumps({'results':results},indent=1),encoding='utf-8')
    print(json.dumps({'objects':len(results),'relocated':sum(r['accepted'] for r in results)}))


if __name__=='__main__':main()
