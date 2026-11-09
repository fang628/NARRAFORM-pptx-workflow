"""Object-specific evidence from a reference and a real/scene render.

Alpha masks identify predicted support only. Reference edges and held-out colour
measurements remain separate, and ambiguous segmentation never becomes a patch.
"""
import cv2
import numpy as np
from PIL import Image
from object_masks import object_alpha, mask_entries


def read(file):
    with Image.open(file) as im:return np.asarray(im.convert('RGB').resize((1600,900),Image.Resampling.LANCZOS))


def target_segmentation(rgb,base,prior,excluded):
    changed=np.linalg.norm(rgb.astype(float)-base.astype(float),axis=2)>14
    seed=cv2.erode((prior>200).astype(np.uint8),np.ones((5,5),np.uint8))>0
    seed &= changed&~excluded
    outside=cv2.dilate((prior>16).astype(np.uint8),np.ones((25,25),np.uint8))==0
    if seed.sum()<20 or outside.sum()<20:return None
    labels=np.full(prior.shape,cv2.GC_PR_BGD,np.uint8)
    labels[prior>32]=cv2.GC_PR_FGD
    labels[outside|excluded]=cv2.GC_BGD
    labels[seed]=cv2.GC_FGD
    method='seeded-GrabCut'
    try:
        if float(np.mean(np.std(rgb[seed].astype(float),axis=0)))<18:
            markers=np.zeros(prior.shape,np.int32);markers[outside|excluded]=2;markers[seed]=1
            cv2.watershed(rgb,markers);mask=(markers==1)&~excluded;method='marker-watershed'
        else:
            cv2.grabCut(rgb,labels,None,np.zeros((1,65)),np.zeros((1,65)),2,cv2.GC_INIT_WITH_MASK)
            mask=np.isin(labels,[cv2.GC_FGD,cv2.GC_PR_FGD])&~excluded
    except cv2.error:return None
    # A seed-conditioned observation is not independent proof of full shape.
    # Report its visible boundary to the model, not an automatic geometry edit.
    contours=cv2.findContours(mask.astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)[0]
    if not contours:return None
    contour=max(contours,key=cv2.contourArea)
    polygon=cv2.approxPolyDP(contour,max(1,cv2.arcLength(contour,True)*.008),True)[:,0,:]
    return {'method':method,'visibleOnly':True,'seedConditioned':True,'points':polygon.astype(int).tolist()[:40]}


def analyze(spec):
    ref,actual,base=read(spec['reference']),read(spec['rendered']),read(spec['background'])
    elements=spec.get('elements',[]);entries=mask_entries(spec)
    edges=np.logical_or.reduce([cv2.Canny(ref[:,:,c].copy(),40,100)>0 for c in range(3)])
    actual_edges=np.logical_or.reduce([cv2.Canny(actual[:,:,c].copy(),40,100)>0 for c in range(3)])
    objects=[];covered=np.zeros((900,1600),np.uint8)
    excluded=np.zeros((900,1600),bool)
    for box in spec.get('exclude',[]):
        x,y,w,h=[box[k] for k in ('x','y','w','h')]
        excluded[max(0,int(y)):min(900,int(np.ceil(y+h))),max(0,int(x)):min(1600,int(np.ceil(x+w)))]=True
    for i,e in enumerate(elements):
        alpha=object_alpha(e,entries)
        if alpha is not None:covered=np.maximum(covered,alpha)
        if e.get('managed') or e.get('role')=='background' or e.get('type') in ('text','formula','table'):
            if e.get('type') in ('text','formula','table'):
                # Exact content is checked against node IDs and COM bounds, not
                # against AI glyphs or an old preview after a text-only edit.
                x,y,w,h=[e[k] for k in ('x','y','w','h')]
                covered[max(0,int(y)-3):min(900,int(np.ceil(y+h))+3),max(0,int(x)-3):min(1600,int(np.ceil(x+w))+3)]=255
            continue
        if alpha is None:
            objects.append({'key':e['key'],'status':'unavailable','issues':['缺少可验证的对象蒙版']});continue
        x0=max(0,int(e['x'])-16);y0=max(0,int(e['y'])-16)
        x1=min(1600,int(np.ceil(e['x']+e['w']))+16);y1=min(900,int(np.ceil(e['y']+e['h']))+16)
        local=alpha[y0:y1,x0:x1]
        hidden=excluded[y0:y1,x0:x1].copy()
        for j,o in enumerate(elements):
            if j<=i and o.get('type') not in ('text','formula','table'):continue
            if o['key']==e['key']:continue
            if min(x1,o['x']+o['w'])<=max(x0,o['x']) or min(y1,o['y']+o['h'])<=max(y0,o['y']):continue
            other=object_alpha(o,entries)
            if other is not None:hidden |= other[y0:y1,x0:x1]>16
        support=local>120
        boundary=cv2.morphologyEx(support.astype(np.uint8),cv2.MORPH_GRADIENT,np.ones((3,3),np.uint8))>0
        band=cv2.dilate(boundary.astype(np.uint8),np.ones((9,9),np.uint8))>0
        visible=actual_edges[y0:y1,x0:x1]&band&~hidden
        observed=edges[y0:y1,x0:x1]&~hidden
        core=(cv2.erode((local>220).astype(np.uint8),np.ones((5,5),np.uint8))>0)&~hidden
        report={'key':e['key'],'type':e['type'],'status':'available','visibleBoundaryPixels':int(visible.sum()),'predictedMask':True,'issues':[]}
        if observed.any() and visible.sum()>=12:
            distance=cv2.distanceTransform((~observed).astype(np.uint8),cv2.DIST_L2,3)[visible]
            median=float(np.median(distance));p95=float(np.percentile(distance,95))
            report.update(boundaryMedian=round(median,3),boundaryP95=round(p95,3),boundaryCoverage=round(float((distance<=3).mean()),3))
            if median>2 or p95>5:report['issues'].append('可见轮廓与参考边界存在偏差')
        else:report['status']='ambiguous'
        if core.sum()>=24:
            error=float(np.mean(abs(ref[y0:y1,x0:x1].astype(float)-actual[y0:y1,x0:x1].astype(float))[core]))
            report['appearanceMAE']=round(error,3)
            if error>12:report['issues'].append('对象内部填充或材质与参考存在差异')
        if report['issues'] and e.get('type') in ('rect','ellipse','shape'):
            segments=cv2.createLineSegmentDetector().detect(observed.astype(np.uint8)*255)[0]
            if segments is not None:
                lines=sorted(segments[:,0,:].tolist(),key=lambda a:-np.hypot(a[2]-a[0],a[3]-a[1]))[:8]
                report['lineEvidence']=[{'start':[round(a+x0,1),round(b+y0,1)],'end':[round(c+x0,1),round(d+y0,1)]} for a,b,c,d in lines if np.hypot(c-a,d-b)>12]
            if report.get('boundaryMedian',0)>2 and x1-x0<=700 and y1-y0<=600:
                segmentation=target_segmentation(ref[y0:y1,x0:x1].copy(),base[y0:y1,x0:x1],local,hidden)
                if segmentation:
                    segmentation['points']=[[x+x0,y+y0] for x,y in segmentation['points']];report['visibleSegmentation']=segmentation
        objects.append(report)
    # Outside predicted object support, preserve unexplained differences as
    # omission hints. Never turn them into autonomous new objects or text.
    residual=np.max(abs(ref.astype(np.int16)-actual.astype(np.int16)),axis=2)>24
    outside=cv2.dilate((covered>8).astype(np.uint8),np.ones((21,21),np.uint8))==0
    residual &= outside&~excluded
    n,labels,stats,_=cv2.connectedComponentsWithStats(residual.astype(np.uint8),8)
    missing=[]
    for x,y,w,h,area in stats[1:]:
        if area<12 or (area<40 and max(w,h)<24):continue
        if area>1600*900*.15:continue
        missing.append({'x':int(x),'y':int(y),'w':int(w),'h':int(h),'pixels':int(area)})
    # A predicted carrier covers its interior, but does not explain a missing
    # foreground plate/line there. Inspect coherent residual edges inside it,
    # masking registered text, icons and effects independently of filled frames.
    foreground=excluded.copy();interiors=np.zeros((900,1600),np.uint8)
    for e in elements:
        alpha=object_alpha(e,entries)
        if alpha is None:continue
        if e.get('managed') or e.get('type') in ('text','formula','table','image','svg') or e.get('role')=='effect':foreground|=alpha>8
        elif e.get('type') in ('rect','shape','ellipse') and e.get('role') in ('carrier','frame'):
            interiors|=cv2.erode((alpha>32).astype(np.uint8),np.ones((13,13),np.uint8))
    # Text boxes must also be excluded when the rendered glyph mask is sparse.
    for e in elements:
        if e.get('type') in ('text','formula','table'):
            x,y,w,h=[e[k] for k in ('x','y','w','h')];foreground[max(0,int(y)-4):min(900,int(np.ceil(y+h))+4),max(0,int(x)-4):min(1600,int(np.ceil(x+w))+4)]=True
    local=(np.max(abs(ref.astype(np.int16)-actual.astype(np.int16)),axis=2)>24)&(interiors>0)&~foreground
    # Report a thin, stable reference boundary or a new actual boundary. Do not
    # promote broad texture/color mismatch into an automatically created object.
    edge_difference=(edges&~cv2.dilate(actual_edges.astype(np.uint8),np.ones((5,5),np.uint8)).astype(bool))|(actual_edges&~cv2.dilate(edges.astype(np.uint8),np.ones((5,5),np.uint8)).astype(bool))
    residual_edges=local&edge_difference
    joined=cv2.morphologyEx(residual_edges.astype(np.uint8),cv2.MORPH_CLOSE,np.ones((3,7),np.uint8))
    _,_,stats,_=cv2.connectedComponentsWithStats(joined,8);inside=[]
    for x,y,w,h,area in stats[1:]:
        if area<30 or max(w,h)<45 or area>1600*900*.1:continue
        inside.append({'x':int(x),'y':int(y),'w':int(w),'h':int(h),'pixels':int(area),'kind':'unexplained-interior-boundary','action':'compare-missing-plate-vs-extra-outline'})
    return {'version':2,'status':'available','advisoryOnly':True,'units':'1600x900','objects':objects,'unexplainedRegions':sorted(missing,key=lambda e:-e['pixels'])[:8],'unexplainedInteriorRegions':sorted(inside,key=lambda e:-e['pixels'])[:12]}
