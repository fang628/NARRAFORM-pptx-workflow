"""Seeded straight-line restoration: reconstruct centreline, not ragged edges."""
import cv2
import numpy as np
from paint_models import fit_native_paint


def endpoints(e):
    x,y,w,h=[float(e[k]) for k in ('x','y','w','h')]
    return np.array([x+w if e.get('flipH') else x,y+h if e.get('flipV') else y]),np.array([x if e.get('flipH') else x+w,y if e.get('flipV') else y+h])


def sample(image,points):
    return cv2.remap(image.astype(np.float32),points[:,:,0].astype(np.float32),points[:,:,1].astype(np.float32),cv2.INTER_LINEAR,borderMode=cv2.BORDER_REPLICATE)


def _fit_native_lines(ref,elements,excluded=None,target_keys=None):
    proposals=[];diagnostics=[]
    for e in elements:
        if e.get('type')!='line' or e.get('managed') or e.get('lineEffect')=='lit' or e.get('glow') or e.get('shadow') or target_keys is not None and e['key'] not in target_keys:continue
        a,b=endpoints(e);length=np.linalg.norm(b-a)
        if length<24:continue
        direction=(b-a)/length;normal=np.array([-direction[1],direction[0]])
        band=min(18,max(6,float(e.get('strokeWidth',1))*2.5));offsets=np.arange(-band,band+.1,.5)
        extension=min(12,length*.04);step=max(1,length/2000);t=np.arange(-extension,length+extension,step)
        points=a+t[:,None,None]*direction+offsets[None,:,None]*normal
        colors=sample(ref,points);outside=np.median(np.concatenate([colors[:,:3],colors[:,-3:]],axis=1),axis=1)
        distance=np.linalg.norm(colors-outside[:,None,:],axis=2)
        peak=distance.max(axis=1);threshold=max(12,float(np.percentile(peak,60))*.24)
        weights=np.maximum(0,distance-threshold);centres=(weights*offsets).sum(axis=1)/np.maximum(1,weights.sum(axis=1))
        reliable=(peak>max(15,threshold*1.7))&(abs(centres)<band*.65)&(t>=0)&(t<=length)
        if excluded is not None:
            q=np.rint(a+t[:,None]*direction+centres[:,None]*normal).astype(int);inside=(q[:,0]>=0)&(q[:,0]<ref.shape[1])&(q[:,1]>=0)&(q[:,1]<ref.shape[0]);reliable&=inside
            reliable[inside]&=~excluded[q[inside,1],q[inside,0]]
        if reliable.sum()<max(15,len(t)*.25):
            diagnostics.append({'key':e['key'],'status':'rejected','reason':'insufficient-line-support'});continue
        q=(a+t[:,None]*direction+centres[:,None]*normal)[reliable].astype(np.float32)
        vx,vy,cx,cy=cv2.fitLine(q,cv2.DIST_HUBER,0,.005,.005).ravel();d=np.array([vx,vy]);d*=1 if np.dot(d,direction)>=0 else -1
        turn=abs(float(d[0]*direction[1]-d[1]*direction[0]))
        residual=abs((q-[cx,cy])@np.array([-d[1],d[0]]))
        if turn>.07 or np.median(residual)>1.2:
            diagnostics.append({'key':e['key'],'status':'rejected','reason':'curved-or-inconsistent-centreline'});continue
        # Endpoints remain near the seed; only short incidental holes are closed.
        active=peak>max(15,threshold*1.7);changes=np.diff(np.r_[False,active,False].astype(int));starts=np.where(changes==1)[0];ends=np.where(changes==-1)[0]
        runs=[(s,z) for s,z in zip(starts,ends) if z-s>=2 and t[z-1]>=0 and t[s]<=length]
        dashed=False
        if len(runs)>=4:
            sizes=np.array([z-s for s,z in runs]);gaps=np.array([runs[i+1][0]-runs[i][1] for i in range(len(runs)-1)])
            dashed=np.std(sizes)/max(1,np.mean(sizes))<.4 and np.std(gaps)/max(1,np.mean(gaps))<.45 and np.median(gaps)>1
        support=np.mean(active[(t>=0)&(t<=length)])
        if support<.6 and not dashed:
            diagnostics.append({'key':e['key'],'status':'rejected','reason':'gaps-too-large-to-infer-solid-line'});continue
        centre=np.array([cx,cy]);pa=centre+d*np.dot(a-centre,d);pb=centre+d*np.dot(b-centre,d)
        if runs and not any(e.get(k) not in (None,'none') for k in ('beginArrowType','endArrowType')):
            first,last=t[runs[0][0]],t[runs[-1][1]-1]
            if abs(first)<extension and abs(last-length)<extension:pa+=d*first;pb+=d*(last-length)
        # Width from cross sections away from endpoints, arrows and intersections.
        ridge=distance>np.maximum(threshold,peak[:,None]*.5);widths=ridge.sum(axis=1)*.5
        width=float(np.median(widths[reliable&(t>length*.12)&(t<length*.88)]))
        if not .5<=width<=12:continue
        lo=np.minimum(pa,pb);hi=np.maximum(pa,pb)
        props={'x':round(float(lo[0]),3),'y':round(float(lo[1]),3),'w':round(max(.01,float(hi[0]-lo[0])),3),'h':round(max(.01,float(hi[1]-lo[1])),3),'flipH':bool(pa[0]>pb[0]),'flipV':bool(pa[1]>pb[1]),'strokeWidth':round(width,2)}
        if dashed:props['dashType']='sysDot' if np.median([z-s for s,z in runs])<=width*1.8 else 'dash'
        # Respect a deliberately dashed seed when evidence is incomplete.
        stations=np.where(reliable&(t>length*.08)&(t<length*.92))[0];centerpoints=a+t[stations,None]*direction+centres[stations,None]*normal
        pixels=sample(ref,centerpoints[:,None,:])[:,0,:];paint_detail={};measured={**e,**props,'fillOpacity':1}
        gradient=fit_native_paint(pixels,centerpoints[:,0],centerpoints[:,1],measured,e.get('gradient') or e.get('color'),diagnostics=paint_detail)
        if gradient and gradient['gradient']['type']=='linear':props['gradient']=gradient['gradient']
        elif len(pixels)>20 and np.mean(np.std(pixels,axis=0))<5:props.update(color=''.join(f'{int(round(c)):02X}' for c in np.median(pixels,axis=0)),gradient=None)
        proposals.append({'key':e['key'],'properties':props,'method':'multi-section-Huber-centreline','support':round(float(support),3),'medianResidual':round(float(np.median(residual)),3),'dashed':bool(dashed),'paint':paint_detail})
    return proposals,diagnostics


def relocate_arrow(ref,e,excluded=None):
    """Recover an isolated coloured arrow before retrying a misplaced seed."""
    if not any(e.get(k) not in (None,'none') for k in ('beginArrowType','endArrowType')):return None
    a,b=endpoints(e);direction=b-a;length=np.linalg.norm(direction)
    if length<20:return None
    direction/=length
    try:color=np.array([int(str(e.get('color','')).lstrip('#')[i:i+2],16) for i in (0,2,4)],float)
    except (ValueError,TypeError):return None
    pad=min(100,max(35,length*1.2));left=max(0,int(min(a[0],b[0])-pad));right=min(ref.shape[1],int(max(a[0],b[0])+pad));top=max(0,int(min(a[1],b[1])-pad));bottom=min(ref.shape[0],int(max(a[1],b[1])+pad))
    patch=ref[top:bottom,left:right].astype(float)
    mask=(np.linalg.norm(patch-color,axis=2)<70).astype(np.uint8)
    if excluded is not None:mask[excluded[top:bottom,left:right]]=0
    count,labels,stats,centers=cv2.connectedComponentsWithStats(mask)
    choices=[]
    for i in range(1,count):
        x,y,w,h,area=map(int,stats[i])
        if x<=1 or y<=1 or x+w>=mask.shape[1]-1 or y+h>=mask.shape[0]-1:continue
        if area<20 or max(w,h)<length*.45 or max(w,h)>length*1.8 or area>w*h*.65:continue
        yy,xx=np.nonzero(labels==i);points=np.column_stack([xx+left,yy+top]).astype(float)
        vx,vy,cx,cy=cv2.fitLine(points.astype(np.float32),cv2.DIST_HUBER,0,.005,.005).ravel();d=np.array([vx,vy],float)
        if np.dot(d,direction)<0:d=-d
        if np.dot(d,direction)<.94:continue
        normal=np.array([-d[1],d[0]]);projection=points@d
        lo,hi=float(projection.min()),float(projection.max());span=hi-lo
        begin_only=e.get('beginArrowType') not in (None,'none') and e.get('endArrowType') in (None,'none')
        shaft=points[(projection>lo+span*(.35 if begin_only else .15))&(projection<lo+span*(.85 if begin_only else .65))]
        if len(shaft)<12:continue
        offset=float(np.median(shaft@normal));residual=np.abs(shaft@normal-offset)
        if np.median(residual)>max(1.5,float(e.get('strokeWidth',2))):continue
        pa=d*lo+normal*offset;pb=d*hi+normal*offset
        distance=float(np.linalg.norm((pa+pb)/2-(a+b)/2))
        if distance>pad:continue
        choices.append((distance+abs(span-length)*.15,pa,pb,float(np.mean(residual<3))))
    if not choices:return None
    _,pa,pb,support=min(choices,key=lambda item:item[0]);lo=np.minimum(pa,pb);hi=np.maximum(pa,pb)
    return {'key':e['key'],'properties':{'x':round(float(lo[0]),3),'y':round(float(lo[1]),3),'w':round(float(hi[0]-lo[0]),3),'h':round(float(hi[1]-lo[1]),3),'flipH':bool(pa[0]>pb[0]),'flipV':bool(pa[1]>pb[1])},
        'method':'isolated-arrow-component-centreline','support':support,'medianResidual':0.5}


def fit_native_lines(ref,elements,excluded=None,target_keys=None):
    proposals,diagnostics=_fit_native_lines(ref,elements,excluded,target_keys)
    accepted={p['key'] for p in proposals}
    for e in elements:
        if e.get('type')!='line' or e['key'] in accepted or target_keys is not None and e['key'] not in target_keys:continue
        if e.get('managed') or e.get('glow') or e.get('shadow') or e.get('lineEffect')=='lit':continue
        recovered=relocate_arrow(ref,e,excluded)
        if recovered:
            proposals.append(recovered);diagnostics=[d for d in diagnostics if d['key']!=e['key']]
    return proposals,diagnostics
