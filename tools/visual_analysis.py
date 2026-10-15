"""Deterministic geometry proposals and masked, local SSIM/edge diagnostics.

Coordinates in specs/reports use the existing 1600x900 scene. No registration
warps are applied: a misplaced element must remain visible as a difference.
"""
import json
import sys
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
cv2.setNumThreads(1)


def image(file, size):
    with Image.open(file) as im:
        im.load()
        return np.asarray(im.convert('RGB').resize(size, Image.Resampling.LANCZOS))


def box_pixels(e, width, height):
    return (max(0, int(e['x']*width/1600)), max(0, int(e['y']*height/900)),
            min(width, int(np.ceil((e['x']+e['w'])*width/1600))),
            min(height, int(np.ceil((e['y']+e['h'])*height/900))))


def delta(a, b):
    lab_a = cv2.cvtColor(a.astype(np.float32)/255, cv2.COLOR_RGB2LAB)
    lab_b = cv2.cvtColor(b.astype(np.float32)/255, cv2.COLOR_RGB2LAB)
    return np.linalg.norm(lab_a-lab_b, axis=2)


def geometry(spec, out):
    a, b = image(spec['reference'], (1600,900)), image(spec['background'], (1600,900))
    difference = delta(a, b)
    threshold = float(np.clip(np.median(difference)+3*np.median(np.abs(difference-np.median(difference))),12,30))
    mask = (difference>threshold).astype(np.uint8)*255
    for area in spec.get('exclude', []):
        x,y,x1,y1=box_pixels(area,1600,900);mask[y:y1,x:x1]=0
    mask = cv2.morphologyEx(cv2.medianBlur(mask,3),cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
    for area in spec.get('exclude', []):
        x,y,x1,y1=box_pixels(area,1600,900);mask[y:y1,x:x1]=0
    coverage = float(np.mean(mask>0))
    contours,_ = cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    candidates=[]
    for contour in contours:
        area=cv2.contourArea(contour)
        if area<64 or area>1600*900*.35:continue
        x,y,w,h=cv2.boundingRect(contour)
        if min(w,h)<5:continue
        inside=np.zeros((h,w),np.uint8)
        cv2.drawContours(inside,[contour-np.array([[[x,y]]])],-1,255,-1)
        pixels=a[y:y+h,x:x+w][inside>0]
        if not len(pixels):continue
        spread=float(np.mean(np.std(pixels.astype(float),axis=0)))
        polygon=cv2.approxPolyDP(contour,.015*cv2.arcLength(contour,True),True)
        rectangularity=area/(w*h)
        kind='contour';confidence=.35
        if len(polygon)==4 and rectangularity>.9 and spread<18:
            kind='rect';confidence=.93
        elif len(contour)>=5 and .65<rectangularity<.86 and spread<18:
            ellipse=cv2.fitEllipse(contour)
            ellipse_area=np.pi*ellipse[1][0]*ellipse[1][1]/4
            axis_aligned=min(ellipse[2]%90,90-ellipse[2]%90)<5
            if ellipse_area>0 and abs(area/ellipse_area-1)<.12 and (axis_aligned or abs(w/h-1)<.08):
                kind='ellipse';confidence=.86
        # Avoid treating individual glyphs or arbitrary photograph contours as shapes.
        if kind=='contour' and (area<500 or spread>28):continue
        color=np.median(pixels,axis=0).astype(int)
        candidates.append({'type':kind,'x':x,'y':y,'w':w,'h':h,
          'fill':''.join(f'{c:02X}' for c in color),'confidence':confidence*(.6 if coverage>.6 else 1),
          'points':polygon[:,0,:].astype(int).tolist()[:100]})
    candidates=sorted(candidates,key=lambda c:c['confidence']*c['w']*c['h'],reverse=True)[:60]
    overlay=a.copy()
    for c in candidates:
        cv2.rectangle(overlay,(c['x'],c['y']),(c['x']+c['w'],c['y']+c['h']),(255,160,20),2)
    Image.fromarray(overlay).save(out/'geometry.png')
    return {'status':'available','method':'Lab-deltaE76+connected-contours+Douglas-Peucker',
            'threshold':threshold,'changedFraction':coverage,'backgroundDrift':coverage>.6,
            'candidates':candidates,'overlay':'geometry.png','advisoryOnly':True}


def ssim_map(a,b):
    # Standard local SSIM, Gaussian sigma 1.5, range 255, population moments.
    a=a.astype(np.float32);b=b.astype(np.float32)
    blur=lambda x:cv2.GaussianBlur(x,(11,11),1.5)
    ma,mb=blur(a),blur(b)
    va=np.maximum(0,blur(a*a)-ma*ma);vb=np.maximum(0,blur(b*b)-mb*mb)
    cov=blur(a*b)-ma*mb
    return np.clip(((2*ma*mb+6.5025)*(2*cov+58.5225))/
                   ((ma*ma+mb*mb+6.5025)*(va+vb+58.5225)),-1,1)


def difference_report(spec,out):
    size=(960,540)
    ref=image(spec['reference'],size);actual=image(spec['rendered'],size);base=image(spec['background'],size)
    gray=lambda im:cv2.cvtColor(im,cv2.COLOR_RGB2GRAY)
    local=np.mean([ssim_map(ref[:,:,c],actual[:,:,c]) for c in range(3)],axis=0)
    foreground=(delta(ref,base)>10)|(delta(actual,base)>10)
    mask=cv2.dilate(foreground.astype(np.uint8),np.ones((7,7),np.uint8))>0
    for e in spec.get('exclude',[]):
        x,y,x1,y1=box_pixels(e,*size);mask[y:y1,x:x1]=False
    # Luminance alone misses bright yellow shapes on a light background.
    edges=lambda im:np.logical_or.reduce([cv2.Canny(im[:,:,c].copy(),40,100)>0 for c in range(3)])
    edge_a=edges(ref);edge_b=edges(actual)
    dist_a=cv2.distanceTransform((~edge_a).astype(np.uint8),cv2.DIST_L2,3)
    dist_b=cv2.distanceTransform((~edge_b).astype(np.uint8),cv2.DIST_L2,3)
    dist_a=np.minimum(dist_a,float(np.hypot(*size)))
    dist_b=np.minimum(dist_b,float(np.hypot(*size)))
    error=(1-local)/2
    # Pixel-equal blank images receive a perfect empty-content diagnostic.
    def stats(region):
        selected=region&mask
        if not selected.any():return {'ssim':1.0,'edgeDistance':0.0,'samples':0}
        distances=np.concatenate([dist_b[edge_a&selected],dist_a[edge_b&selected]])
        return {'ssim':round(float(local[selected].mean()),4),
                'edgeDistance':round(float(distances.mean()),3) if len(distances) else 0,
                'samples':int(selected.sum())}
    regions=[]
    for e in spec.get('elements',[]):
        region=np.zeros(size[::-1],bool);x,y,x1,y1=box_pixels(e,*size);region[y:y1,x:x1]=True
        regions.append({'key':e['key'],'type':e['type'],'box':{k:e[k] for k in ['x','y','w','h']},**stats(region)})
    # Include missed objects outside the registered scene via a regular local grid.
    tiles=[]
    for row in range(6):
        for col in range(8):
            region=np.zeros(size[::-1],bool);region[row*90:(row+1)*90,col*120:(col+1)*120]=True
            stat=stats(region)
            if stat['samples']>=16 and stat['ssim']<.9:
                tiles.append({'box':{'x':col*200,'y':row*150,'w':200,'h':150},**stat})
    intensity=np.maximum(np.clip(error*2,0,1),np.clip(delta(ref,actual)/50,0,1))*mask
    hot=np.zeros_like(ref);hot[:,:,0]=255;hot[:,:,1]=90
    alpha=intensity[:,:,None]*.8
    heat=(ref*(1-alpha)+hot*alpha).astype(np.uint8)
    Image.fromarray(heat).resize((1920,1080),Image.Resampling.LANCZOS).save(out/'difference.png')
    return {'status':'available','method':'masked-RGB-local-SSIM+color-edge-distance+Lab-heatmap',
            'global':stats(np.ones(size[::-1],bool)),
            'regions':sorted(regions,key=lambda r:r['ssim']),
            'hotspots':sorted(tiles,key=lambda r:r['ssim'])[:12],
            'heatmap':'difference.png','advisoryOnly':True,
            'note':'相似度仅辅助定位，不作为美观度或内容正确性的通过门槛。'}


def main():
    spec=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
    result=geometry(spec,out) if spec['operation']=='geometry' else difference_report(spec,out)
    (out/'analysis.json').write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':main()
