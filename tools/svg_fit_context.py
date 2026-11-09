"""Cached, object-local multiscale scores for non-carrier SVG candidates."""
import hashlib
import json
from collections import OrderedDict
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
from object_masks import object_alpha, mask_entries, crop_alpha

cv2.setNumThreads(1)
CACHE = OrderedDict()


def sample(file, region, size):
    with Image.open(file) as source:
        image=source.convert('RGB')
        x,y,w,h=(region[k] for k in ('x','y','w','h'))
        box=(x*image.width/1600,y*image.height/900,(x+w)*image.width/1600,(y+h)*image.height/900)
        return np.asarray(image.resize(size,Image.Resampling.LANCZOS,box=box),np.float32)


def edges(mask, valid):
    # Exclusion boundaries must not become apparent reference shape edges.
    safe=cv2.erode(valid.astype(np.uint8),np.ones((3,3),np.uint8))>0
    return (cv2.Canny(mask.astype(np.uint8)*255,40,100)>0)&safe


def holes(mask, valid):
    contours,hierarchy=cv2.findContours(mask.astype(np.uint8),cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:return 0
    count=0
    for i,c in enumerate(contours):
        if hierarchy[0,i,3]<0 or cv2.contourArea(c)<8:continue
        canvas=np.zeros(mask.shape,np.uint8);cv2.drawContours(canvas,[c],-1,1,-1)
        if np.all(valid[canvas>0]):count+=1
    return count


def context(spec,size):
    stable={k:v for k,v in spec.items() if k not in ('candidates','stage')}
    for k in ('reference','background','contextBackground'):
        if stable.get(k):stable[k]=[stable[k],Path(stable[k]).stat().st_mtime_ns]
    key=hashlib.sha256(json.dumps([stable,size],sort_keys=True).encode()).hexdigest()
    if key in CACHE:CACHE.move_to_end(key);return CACHE[key],True
    region=spec['region'];ref=sample(spec['reference'],region,size)
    bg=sample(spec.get('contextBackground') or spec['background'],region,size)
    valid=np.ones(size[::-1],bool);entries=mask_entries(spec)
    for e in spec.get('occluders',[]):
        alpha=object_alpha(e,entries)
        if alpha is not None:valid &= crop_alpha(alpha,region,size)<24
    for e in spec.get('exclude',[]):
        x0=max(0,int((e['x']-region['x'])/region['w']*size[0]));y0=max(0,int((e['y']-region['y'])/region['h']*size[1]))
        x1=min(size[0],int(np.ceil((e['x']+e['w']-region['x'])/region['w']*size[0])));y1=min(size[1],int(np.ceil((e['y']+e['h']-region['y'])/region['h']*size[1])))
        valid[y0:y1,x0:x1]=False
    # Observed evidence and candidate alpha have independent origins.
    lab_ref=cv2.cvtColor(ref/255,cv2.COLOR_RGB2LAB);lab_bg=cv2.cvtColor(bg/255,cv2.COLOR_RGB2LAB)
    foreground=(np.linalg.norm(lab_ref-lab_bg,axis=2)>5)&valid
    boundary=edges(foreground,valid);distance=cv2.distanceTransform((~boundary).astype(np.uint8),cv2.DIST_L2,3)
    gray=cv2.cvtColor(ref.astype(np.uint8),cv2.COLOR_RGB2GRAY)
    internal=(cv2.Canny(gray,35,100)>0)&cv2.erode(valid.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)
    internal &= cv2.dilate(foreground.astype(np.uint8),np.ones((3,3),np.uint8))>0
    internal_distance=cv2.distanceTransform((~internal).astype(np.uint8),cv2.DIST_L2,3)
    result={'ref':ref,'bg':bg,'valid':valid,'foreground':foreground,'boundary':boundary,'distance':distance,
            'internal':internal,'internalDistance':internal_distance,'holes':holes(foreground,valid)}
    CACHE[key]=result
    while len(CACHE)>8:CACHE.popitem(last=False)
    return result,False


def run(spec):
    with Image.open(spec['candidates'][0]['file']) as first:size=first.size
    ctx,cached=context(spec,size);ref,bg,valid,foreground=(ctx[k] for k in ('ref','bg','valid','foreground'))
    if foreground.sum()<12 or valid.mean()<.15:return {'status':'unavailable','scores':[],'cached':cached}
    scores=[]
    for candidate in spec['candidates']:
        with Image.open(candidate['file']) as source:rgba=np.asarray(source.convert('RGBA').resize(size),np.float32)
        alpha=rgba[:,:,3:4]/255;rgb=rgba[:,:,:3]*alpha+bg*(1-alpha);mask=(alpha[:,:,0]>.08)&valid
        union=mask|foreground;iou=float((mask&foreground).sum()/max(1,union.sum()))
        selected=(cv2.dilate(union.astype(np.uint8),np.ones((5,5),np.uint8))>0)&valid
        error=float(np.mean(np.abs(rgb-ref)[selected])/255) if selected.any() else 1
        boundary=edges(mask,valid)
        if boundary.any() and ctx['boundary'].any():
            distance=cv2.distanceTransform((~boundary).astype(np.uint8),cv2.DIST_L2,3)
            chamfer=float(np.mean(np.minimum(20,np.r_[ctx['distance'][boundary],distance[ctx['boundary']]])))
        else:chamfer=20
        internal=(cv2.Canny(cv2.cvtColor(rgb.astype(np.uint8),cv2.COLOR_RGB2GRAY),35,100)>0)
        internal &= cv2.erode(valid.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)
        internal &= cv2.dilate(union.astype(np.uint8),np.ones((3,3),np.uint8))>0
        if internal.any() and ctx['internal'].any():
            distance=cv2.distanceTransform((~internal).astype(np.uint8),cv2.DIST_L2,3)
            detail=float(np.mean(np.minimum(12,np.r_[ctx['internalDistance'][internal],distance[ctx['internal']]])))/12
        else:detail=0 if not internal.any() and not ctx['internal'].any() else 1
        tile=[]
        for rows in np.array_split(np.arange(size[1]),4):
            for columns in np.array_split(np.arange(size[0]),4):
                select=selected[np.ix_(rows,columns)]
                if select.sum()>=8:tile.append(float(np.mean(np.abs(rgb[np.ix_(rows,columns)]-ref[np.ix_(rows,columns)])[select])/255))
        worst=float(np.percentile(tile,80)) if tile else error
        hole_error=min(2,abs(holes(mask,valid)-ctx['holes']))
        score=1-(error*.55+(1-iou)*.22+min(20,chamfer)*.012+detail*.12+worst*.12+hole_error*.025)
        scores.append({'id':candidate['id'],'score':round(score,6),'iou':round(iou,5),'edgeDistance':round(chamfer,4),
                       'colorError':round(error,5),'internalEdgeError':round(detail,5),'holeDifference':hole_error,'componentError':round(worst,5)})
    return {'status':'available','scores':scores,'samples':int(valid.sum()),'cached':cached}
