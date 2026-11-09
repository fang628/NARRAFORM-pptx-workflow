"""Supplement union contours with colour-separated visible layer evidence.

These are hints, not complete hidden-object masks and never geometry patches.
Smooth gradients are rejected as layer splits by within-cluster variation.
"""
import cv2
import numpy as np


def visible_layer_candidates(ref,mask,excluded=()):
    h,w=mask.shape;small=cv2.resize(ref,(max(1,w//3),max(1,h//3)),interpolation=cv2.INTER_AREA)
    lab=cv2.cvtColor(small.astype(np.float32)/255,cv2.COLOR_RGB2LAB)
    active=cv2.resize(mask,(small.shape[1],small.shape[0]),interpolation=cv2.INTER_NEAREST)>0
    for x0,y0,x1,y1 in excluded:active[max(0,y0//3):min(active.shape[0],(y1+2)//3),max(0,x0//3):min(active.shape[1],(x1+2)//3)]=False
    samples=lab[active]
    if len(samples)<150:return []
    # Quantized frequent colours provide deterministic seeds; no random kmeans.
    codes=np.floor(samples/5).astype(np.int32);unique,counts=np.unique(codes,axis=0,return_counts=True)
    seeds=[]
    for index in np.argsort(-counts,kind='stable')[:40]:
        if counts[index]<max(30,len(samples)*.01):continue
        center=np.median(samples[np.all(codes==unique[index],axis=1)],axis=0)
        if all(np.linalg.norm(center-c)>18 for c in seeds):seeds.append(center)
        if len(seeds)>=8:break
    results=[]
    for color in seeds:
        region=((np.linalg.norm(lab-color,axis=2)<6)&active).astype(np.uint8)
        region=cv2.morphologyEx(region,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
        n,labels,stats,_=cv2.connectedComponentsWithStats(region,8)
        for i in range(1,n):
            x,y,bw,bh,area=stats[i]
            if area<120 or bw<10 or bh<10:continue
            selected=labels==i
            # A thin gradient band has low coverage and no stable 2D interior.
            eroded=cv2.erode(selected.astype(np.uint8),np.ones((5,5),np.uint8))>0
            if eroded.sum()<area*.25:continue
            values=lab[selected]
            if np.percentile(np.linalg.norm(values-color,axis=1),90)>5.5:continue
            contour=max(cv2.findContours(selected.astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)[0],key=cv2.contourArea)
            contour=cv2.approxPolyDP(contour,cv2.arcLength(contour,True)*.008,True)[:,0,:]*3
            pixels=small[selected];rgb=np.median(pixels,axis=0).astype(int)
            results.append({'id':f'visible-layer-{len(results)+1}','x':int(x*3),'y':int(y*3),'w':int(min(w-x*3,bw*3)),'h':int(min(h-y*3,bh*3)),
                'color':''.join(f'{v:02X}' for v in rgb),'visibleContour':contour.tolist(),'visibleOnly':True,'inferHiddenGeometry':False,'confidence':.75})
    # Only report components that touch/overlap another colour's support. Isolated
    # regions already have external contours; no duplicate object requirement.
    touching=[]
    for a in results:
        neighbors=[]
        for b in results:
            if a is b:continue
            dx=min(a['x']+a['w'],b['x']+b['w'])-max(a['x'],b['x'])
            dy=min(a['y']+a['h'],b['y']+b['h'])-max(a['y'],b['y'])
            if dx>=-6 and dy>=-6:neighbors.append(b['id'])
        if neighbors:touching.append({**a,'touching':neighbors})
    return touching[:24]
