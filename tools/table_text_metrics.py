"""Measure actual rendered cell ink, separate from PowerPoint typographic bearings."""
import json,sys
from pathlib import Path
import cv2
import numpy as np

def measure(image,element,metric):
    a=element.get('tableAlignment') or {}
    if not a.get('version') or not all(isinstance(a.get(k),(int,float)) for k in ('left','right','top','bottom')):return None
    left,top,right,bottom=a['left'],a['top'],a['right'],a['bottom']
    x0,x1=max(0,round(left+3)),min(1600,round(right-3));y0,y1=max(0,round(top+2)),min(900,round(bottom-2))
    patch=image[y0:y1,x0:x1]
    if patch.size<30:return None
    bg=np.median(patch.reshape(-1,3),axis=0)
    mask=(np.linalg.norm(patch.astype(float)-bg,axis=2)>45).astype(np.uint8)
    count,labels,stats,centers=cv2.connectedComponentsWithStats(mask)
    parts=[]
    mx=metric.get('boundLeft',element['x']);my=metric.get('boundTop',element['y'])
    mw=metric.get('boundWidth',element['w']);mh=metric.get('boundHeight',element['h'])
    for i in range(1,count):
        x,y,w,h,area=map(int,stats[i]);cx=x0+x+w/2;cy=y0+y+h/2
        if area>=4 and h>=3 and h<patch.shape[0] and w<patch.shape[1]*.8 and mx-5<=cx<=mx+mw+5 and my-5<=cy<=my+mh+5:
            parts.append((x0+x,y0+y,w,h))
    if len(parts)<2:return None
    lo_x=min(p[0] for p in parts);lo_y=min(p[1] for p in parts);hi_x=max(p[0]+p[2] for p in parts);hi_y=max(p[1]+p[3] for p in parts)
    if hi_x-lo_x>right-left-6 or hi_y-lo_y>bottom-top-4:return None
    return {'inkLeft':lo_x,'inkTop':lo_y,'inkWidth':hi_x-lo_x,'inkHeight':hi_y-lo_y}

if __name__=='__main__':
    spec=json.loads(Path(sys.argv[1]).read_text(encoding='utf8'));im=cv2.imread(spec['rendered'])
    if im is None:raise ValueError('Missing rendered image')
    image=cv2.cvtColor(cv2.resize(im,(1600,900)),cv2.COLOR_BGR2RGB)
    metrics={m['key']:m for m in spec['measurements']}
    rows=[]
    for element in spec['elements']:
        metric=metrics.get(element['key'])
        if metric:
            ink=measure(image,element,metric)
            if ink:rows.append({'key':element['key'],**ink})
    Path(sys.argv[2]).write_text(json.dumps(rows,ensure_ascii=False),encoding='utf8')
