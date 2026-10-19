"""Conservative regional color fitting; no geometry warps or source-file edits."""
import json, sys
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
cv2.setNumThreads(1)
SIZE=(800,450)
def load(file):
    with Image.open(file) as im:return np.asarray(im.convert('RGB').resize(SIZE,Image.Resampling.LANCZOS))
def box(e):
    x=max(0,int(e['x']/2));y=max(0,int(e['y']/2));r=min(800,int(np.ceil((e['x']+e['w'])/2)));b=min(450,int(np.ceil((e['y']+e['h'])/2)))
    return x,y,r,b
def lab(a):return cv2.cvtColor(a.reshape(1,-1,3).astype(np.float32)/255,cv2.COLOR_RGB2LAB)[0]
def corrected(a,s,b):
    l=a@np.array([.2126,.7152,.0722]);return np.clip(l[:,None]+(a-l[:,None])*s+b*255,0,255)
def fit(reference,rendered,mask,item):
    positions=np.flatnonzero(mask)
    if len(positions)<80:return {'key':item['key'],'status':'insufficient_samples'}
    if len(positions)>2048:positions=positions[np.linspace(0,len(positions)-1,2048).astype(int)]
    a=rendered.reshape(-1,3)[positions].astype(float);b=reference.reshape(-1,3)[positions].astype(float)
    hsv_a=cv2.cvtColor(a.reshape(1,-1,3).astype(np.float32)/255,cv2.COLOR_RGB2HSV)[0];hsv_b=cv2.cvtColor(b.reshape(1,-1,3).astype(np.float32)/255,cv2.COLOR_RGB2HSV)[0]
    hue=np.abs(hsv_a[:,0]-hsv_b[:,0]);hue=np.minimum(hue,360-hue);colored=(hsv_a[:,1]>.12)&(hsv_b[:,1]>.12)
    target=lab(b);error=lambda rgb:float(np.median(np.linalg.norm(lab(rgb)-target,axis=1)))
    base=error(a);result={'key':item['key'],'samples':len(positions),'error':base,'status':'unchanged','medianSaturationDelta':float(np.median(hsv_b[:,1]-hsv_a[:,1])),'medianValueDelta':float(np.median(hsv_b[:,2]-hsv_a[:,2]))}
    if colored.sum()>50 and np.median(hue[colored])>15:return {**result,'status':'hue_mismatch'}
    if base<2.5:return result
    best=(base,1.,0.);clipped=float(np.mean((a<3)|(a>252)))
    for s in [.88,.94,1.,1.06,1.12]:
        if np.median(hsv_a[:,1])<.04 and s!=1:continue
        for brightness in [-.06,-.03,0.,.03,.06]:
            candidate=corrected(a,s,brightness)
            if float(np.mean((candidate<3)|(candidate>252)))>clipped+.04:continue
            value=error(candidate)
            if value<best[0]:best=(value,s,brightness)
    gain=base-best[0]
    if gain>=1.5 and gain/base>=.2:return {**result,'status':'proposed','predictedError':best[0],'saturation':best[1],'brightness':best[2]}
    return result

def page(spec):
    ref,actual=load(spec['reference']),load(spec['rendered']);elements=spec['elements'];regions=[]
    all_mask=np.ones((450,800),bool)
    for e in elements:
        x,y,r,b=box(e);all_mask[max(0,y-2):min(450,b+2),max(0,x-2):min(800,r+2)]=False
    ref_edges=cv2.Canny(cv2.cvtColor(ref,cv2.COLOR_RGB2GRAY),40,120);actual_edges=cv2.Canny(cv2.cvtColor(actual,cv2.COLOR_RGB2GRAY),40,120)
    bg_edges=(actual_edges>0)&all_mask;ref_near=cv2.dilate(ref_edges,np.ones((5,5),np.uint8))>0
    if all_mask.sum()>800:
        if bg_edges.sum()>100 and float(np.mean(ref_near[bg_edges]))<.5:regions.append({'key':'__background__','status':'geometry_mismatch'})
        else:regions.append(fit(ref,actual,all_mask,{'key':'__background__'}))
    for index,e in enumerate(elements):
        if e.get('type')!='image' or e.get('implementation')!='cutout':continue
        if e.get('managed')=='progress' or e.get('role')=='navigation' or e['key'].startswith('nf-progress-'):continue
        x,y,r,b=box(e)
        if r-x<5 or b-y<5:continue
        mask=np.zeros((450,800),bool);mask[y+1:b-1,x+1:r-1]=True
        # Exclude later foreground layers, instead of mistaking them for this object.
        for other in elements[index+1:]:
            xx,yy,rr,bb=box(other);mask[yy:bb,xx:rr]=False
        if e.get('opacity',1)<.98:continue
        asset=spec.get('assetFiles',{}).get(e.get('id'))
        if asset:
            with Image.open(asset) as source:
                alpha=source.convert('RGBA').getchannel('A')
                if e.get('imageFit')=='fill':alpha=alpha.resize((r-x,b-y),Image.Resampling.LANCZOS)
                else:alpha.thumbnail((r-x,b-y),Image.Resampling.LANCZOS)
                layer=np.zeros((b-y,r-x),bool);xx=(r-x-alpha.width)//2;yy=(b-y-alpha.height)//2
                layer[yy:yy+alpha.height,xx:xx+alpha.width]=np.asarray(alpha)>230
                mask[y:b,x:r]&=layer
        edge=actual_edges[y:b,x:r]>0;near=cv2.dilate(ref_edges[y:b,x:r],np.ones((5,5),np.uint8))>0
        if edge.sum()>50 and float(np.mean(near[edge]))<.5:
            regions.append({'key':e['key'],'status':'geometry_mismatch'});continue
        regions.append(fit(ref,actual,mask,e))
    return {'status':'available','method':'occlusion-mask+edge-gate+HSV-hue-gate+robust-Lab-deltaE-grid-fit','regions':regions}
if __name__=='__main__':
    spec=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'));print(json.dumps({'pages':[page(p) for p in spec['pages']]}))
