"""Geometry evidence for compact flat SVG symbols, independent of badge paint."""
import cv2
import numpy as np


def symbol_mask(image, valid, spec, size):
    box=spec.get('geometryFocus') or spec.get('detailBox')
    if not box:return None
    region=spec['region'];sx,sy=size[0]/region['w'],size[1]/region['h']
    x0=max(0,int((box['x']-region['x'])*sx));x1=min(size[0],int(np.ceil((box['x']+box['w']-region['x'])*sx)))
    y0=max(0,int((box['y']-region['y'])*sy));y1=min(size[1],int(np.ceil((box['y']+box['h']-region['y'])*sy)))
    crop=image[y0:y1,x0:x1];visible=valid[y0:y1,x0:x1]
    if not crop.size:return None
    luma=crop@np.array([.2126,.7152,.0722]);sat=crop.max(axis=2)-crop.min(axis=2)
    ink=((luma>max(155,float(np.percentile(luma,40))+38))&(sat<70)&visible).astype(np.uint8)
    count,labels,stats,centers=cv2.connectedComponentsWithStats(ink,8)
    distance=cv2.distanceTransform(ink,cv2.DIST_L2,3);kept=[];partial=False
    # The focus has room around the original object. Thin shell glints are not
    # internal parts, regardless of how white they are.
    ew=box['w']*sx/1.24;eh=box['h']*sy/1.85
    for i in range(1,count):
        x,y,w,h,area=stats[i];cx,cy=centers[i]
        if area<max(6,ew*eh*.002) or w>ew*.9 or h>eh*1.15:continue
        if distance[labels==i].max()<max(1.4,min(ew,eh)*.018):continue
        if not .13*ink.shape[1]<cx<.87*ink.shape[1]:continue
        if not .30*eh<cy<1.55*eh:continue
        if x<=1 or y<=1 or x+w>=ink.shape[1]-1 or y+h>=ink.shape[0]-1:
            if area/max(1,w*h)>.18:partial=True
            continue
        kept.append(i)
    mask=np.zeros(size[::-1],np.uint8)
    if not kept or len(kept)>12 or partial:return None
    selected=np.isin(labels,kept).astype(np.uint8)
    if not .007<selected.mean()<.48:return None
    mask[y0:y1,x0:x1]=selected
    return mask


def topology(mask):
    contours,hierarchy=cv2.findContours(mask,cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:return 0,0
    return int(sum(h[3]<0 for h in hierarchy[0])),int(sum(h[3]>=0 and cv2.contourArea(c)>=3 for c,h in zip(contours,hierarchy[0])))


def symbol_error(reference,candidate):
    if reference is None:return None
    if candidate is None:return {'error':1.,'iou':0.,'boundary':1.,'holes':None}
    a,b=reference>0,candidate>0;iou=float((a&b).sum()/max(1,(a|b).sum()))
    ea=cv2.morphologyEx(reference,cv2.MORPH_GRADIENT,np.ones((3,3),np.uint8))>0
    eb=cv2.morphologyEx(candidate,cv2.MORPH_GRADIENT,np.ones((3,3),np.uint8))>0
    da=cv2.distanceTransform((~ea).astype(np.uint8),cv2.DIST_L2,3);db=cv2.distanceTransform((~eb).astype(np.uint8),cv2.DIST_L2,3)
    boundary=float(np.mean(np.minimum(10,np.r_[da[eb],db[ea]])))/10
    ca,ha=topology(reference);cb,hb=topology(candidate)
    error=.5*(1-iou)+.35*boundary+.1*min(1,abs(ha-hb))+.05*min(1,abs(ca-cb))
    return {'error':round(error,5),'iou':round(iou,5),'boundary':round(boundary,5),'holes':abs(ha-hb),'components':abs(ca-cb)}


def contour_path(contour,convert):
    polygon=cv2.approxPolyDP(contour,max(.65,cv2.arcLength(contour,True)*.002),True)[:,0,:].astype(float)
    if len(polygon)<3:return '',0
    # Keep actual corners; turn shallow direction changes into short quadratics.
    entries=[];exits=[]
    for i,p in enumerate(polygon):
        a,b=polygon[i-1]-p,polygon[(i+1)%len(polygon)]-p
        la,lb=np.linalg.norm(a),np.linalg.norm(b)
        angle=np.degrees(np.arccos(np.clip(np.dot(a,b)/max(1e-6,la*lb),-1,1)))
        fraction=.22 if angle>110 else 0.
        entries.append(p+a*fraction);exits.append(p+b*fraction)
    fmt=lambda p:'%.3f %.3f'%tuple(convert(p))
    commands=['M'+fmt(entries[0])]
    for i,p in enumerate(polygon):
        if i:commands.append('L'+fmt(entries[i]))
        if np.linalg.norm(entries[i]-exits[i])>.01:commands.append('Q'+fmt(p)+' '+fmt(exits[i]))
    return ' '.join(commands)+' Z',len(polygon)


def reference_paths(spec,ctx,size):
    mask=symbol_mask(ctx['ref'],ctx['valid'],spec,size)
    if mask is None:return None
    box=spec.get('elementBox');view=spec.get('detailView')
    if not box or not view:return None
    region=spec['region'];contours,hierarchy=cv2.findContours(mask,cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
    def convert(p):
        px=region['x']+(p[0]+.5)*region['w']/size[0];py=region['y']+(p[1]+.5)*region['h']/size[1]
        return [view[0]+(px-box['x'])/box['w']*view[2],view[1]+(py-box['y'])/box['h']*view[3]]
    paths=[];vertices=0
    for i,h in enumerate(hierarchy[0]):
        if h[3]>=0:continue
        parts=[]
        for j,c in enumerate(contours):
            if j!=i and hierarchy[0,j,3]!=i:continue
            if cv2.contourArea(c)<2:continue
            part,n=contour_path(c,convert);vertices+=n
            if part:parts.append(part)
        if parts:paths.append(' '.join(parts))
    pixels=ctx['ref'][mask>0];color=np.median(pixels,axis=0)
    if not paths or vertices>240 or np.median(np.linalg.norm(pixels-color,axis=1))>30:return None
    detail={'path':' '.join(paths),'paths':paths,'color':'#'+''.join(f'{int(round(v)):02X}' for v in color),'vertices':vertices,'components':len(paths)}
    return detail


def whole_geometry(spec,ctx,size):
    """Measure shell and internal paths in one coordinate system, one candidate."""
    if not spec.get('detailView') or not spec.get('elementBox'):return None
    mask=symbol_mask(ctx['ref'],ctx['valid'],spec,size)
    if mask is None:return None
    ys,xs=np.where(mask);cx,cy=float(np.median(xs)),float(np.median(ys))
    box=spec['elementBox'];region=spec['region'];sx,sy=size[0]/region['w'],size[1]/region['h']
    hsv=cv2.cvtColor(ctx['ref'].astype(np.uint8),cv2.COLOR_RGB2HSV)
    # The enclosing shell must surround the same observed symbol. No semantic
    # icon template or separately normalised internal drawing is introduced.
    contours=[]
    for threshold in (90,130):
        colored=((hsv[:,:,1]>65)&(hsv[:,:,2]>threshold)&ctx['valid']).astype(np.uint8)
        contours.extend(cv2.findContours(colored,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)[0])
    choices=[]
    for contour in contours:
        hull=cv2.convexHull(contour);x,y,w,h=cv2.boundingRect(hull)
        if not (.65*box['w']*sx<w<1.4*box['w']*sx and .7*box['h']*sy<h<1.5*box['h']*sy):continue
        if not (x<=xs.min() and y<=ys.min() and x+w>=xs.max() and y+h>=ys.max()):continue
        if abs(x+w/2-cx)>w*.25 or abs(y+h/2-cy)>h*.3:continue
        polygon=cv2.approxPolyDP(hull,cv2.arcLength(hull,True)*.018,True)[:,0,:]
        if not 4<=len(polygon)<=10:continue
        normalized=(polygon-[x,y])/[w,h]
        symmetry=max(min(np.linalg.norm(p+q-[1,1]) for q in normalized) for p in normalized)
        choices.append((abs(w-box['w']*sx)+abs(h-box['h']*sy)+symmetry*max(w,h)*2,polygon,(x,y,w,h)))
    if not choices:return None
    _,polygon,(x,y,w,h)=min(choices,key=lambda a:a[0])
    if len(polygon)==6:
        # Fit the complete convex shell as one symmetric polygon; a local
        # neighbouring streak cannot pull just one vertex away from its peer.
        regular=np.array([[.25,0],[.75,0],[1,.5],[.75,1],[.25,1],[0,.5]])*[w,h]+[x,y]
        edges=cv2.Canny(ctx['ref'].astype(np.uint8),45,100)
        distance=cv2.distanceTransform(255-edges,cv2.DIST_L2,3)
        samples=np.concatenate([np.linspace(a,b,24) for a,b in zip(regular,np.roll(regular,-1,axis=0))])
        xi=np.clip(np.rint(samples[:,0]).astype(int),0,size[0]-1);yi=np.clip(np.rint(samples[:,1]).astype(int),0,size[1]-1)
        if (distance[yi,xi]<3).mean()>=.6:polygon=regular
    newbox={'x':region['x']+x/sx,'y':region['y']+y/sy,'w':w/sx,'h':h/sy}
    # Reuse the exact reference extraction with the measured enclosing box.
    detail=reference_paths({**spec,'elementBox':newbox},ctx,size)
    if detail is None:return None
    view=spec['detailView'];points=[[view[0]+(float(px)-x)/w*view[2],view[1]+(float(py)-y)/h*view[3]] for px,py in polygon]
    return {'box':newbox,'shell':points,'detail':detail}
