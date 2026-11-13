"""Visible straight-edge evidence and bounded three-sided panel reconstruction."""
import json,math,sys
from pathlib import Path
import cv2
import numpy as np

SIZE=(1600,900)

def load(file):
    image=cv2.imread(str(file)) if file else None
    return cv2.resize(image,SIZE) if image is not None else None

def mask_boxes(mask,boxes):
    for box in boxes:
        x,y,w,h=[float(box.get(k,0) or 0) for k in ('x','y','w','h')]
        mask[max(0,int(y)-2):min(900,int(y+h)+3),max(0,int(x)-2):min(1600,int(x+w)+3)]=0

def line_evidence(reference,background=None,exclude=()):
    hsv=cv2.cvtColor(reference,cv2.COLOR_BGR2HSV)
    ink=((hsv[:,:,1]>55)&(hsv[:,:,2]>100)).astype(np.uint8)*255
    if background is not None:ink[np.max(np.abs(reference.astype(float)-background),axis=2)<12]=0
    distance=cv2.distanceTransform(ink,cv2.DIST_L2,3);ink[distance>3.5]=0
    mask_boxes(ink,exclude)
    raw=cv2.HoughLinesP(ink,1,np.pi/720,35,minLineLength=65,maxLineGap=12)
    lines=[]
    for values in ([] if raw is None else raw[:,0]):
        a,b=np.asarray(values[:2],float),np.asarray(values[2:],float)
        if a[1]>b[1] or abs(a[1]-b[1])<2 and a[0]>b[0]:a,b=b,a
        length=float(np.linalg.norm(b-a))
        if length<65:continue
        horizontal=bool(abs(b[1]-a[1])<=max(2,length*.015))
        slope=float((b[0]-a[0])/max(1,b[1]-a[1]))
        if not horizontal and not .08<=abs(slope)<=1.2:continue
        line={'a':a.tolist(),'b':b.tolist(),'length':length,'horizontal':horizontal,'slope':slope}
        if any(other['horizontal']==horizontal and max(abs((other['b'][0]-other['a'][0])*(p[1]-other['a'][1])-(other['b'][1]-other['a'][1])*(p[0]-other['a'][0]))/other['length'] for p in (a,b))<2
               and max(a[1],other['a'][1])<=min(b[1],other['b'][1])+4 for other in lines):continue
        lines.append(line)
    horizontals=[]
    for line in sorted((l for l in lines if l['horizontal']),key=lambda l:-l['length']):
        left,right=sorted([line['a'][0],line['b'][0]]);y=(line['a'][1]+line['b'][1])/2
        peer=next((p for p in horizontals if abs(p['y']-y)<3 and max(left,p['left'])<=min(right,p['right'])+16),None)
        if peer:peer.update(left=min(left,peer['left']),right=max(right,peer['right']))
        else:horizontals.append({'left':left,'right':right,'y':y})
    return lines,horizontals

def panels_from_edges(reference,lines,horizontals,exclude=()):
    panels=[]
    for top in horizontals:
        left,right,y=top['left'],top['right'],top['y'];width=right-left
        if width<140 or y<80:continue
        sides=[]
        for target in (left,right):
            candidates=[]
            for line in lines:
                if line['horizontal']:continue
                a,b=np.asarray(line['a']),np.asarray(line['b']);slope=line['slope']
                at=a[0]+(y-a[1])*slope
                if abs(at-target)>max(12,width*.08) or a[1]>y+max(35,width*.1) or b[1]<y+45:continue
                candidates.append((abs(at-target)-line['length']*.015,line))
            if not candidates:break
            sides.append(min(candidates,key=lambda item:item[0])[1])
        if len(sides)!=2 or sides[0]['slope']*sides[1]['slope']<=0 or abs(sides[0]['slope']-sides[1]['slope'])>.07:continue
        left=sides[0]['a'][0]+(y-sides[0]['a'][1])*sides[0]['slope']
        right=sides[1]['a'][0]+(y-sides[1]['a'][1])*sides[1]['slope'];width=right-left
        slope=float(np.average([l['slope'] for l in sides],weights=[l['length'] for l in sides]))
        min_y=max(y+45,min(l['b'][1] for l in sides)-8)
        max_y=min(893,y+width*1.35)
        for box in exclude:
            if box.get('y',0)>min_y and box.get('x',0)<right and box.get('x',0)+box.get('w',0)>left:max_y=min(max_y,box['y']-5)
        transitions=[]
        for at in range(math.ceil(min_y),math.floor(max_y)):
            lo,hi=left+slope*(at-y),right+slope*(at-y)
            if lo<3 or hi>1597:continue
            deltas=[]
            for u0,u1 in ((.16,.34),(.41,.59),(.66,.84)):
                xs=np.rint(np.linspace(lo+width*u0,lo+width*u1,25)).astype(int)
                before=np.median(reference[at-3,xs].astype(float),axis=0);after=np.median(reference[at+3,xs].astype(float),axis=0)
                deltas.append(after-before)
            magnitudes=np.linalg.norm(deltas,axis=1);direction=np.median(deltas,axis=0)
            agree=sum(np.dot(d,direction)>0 and np.linalg.norm(d-direction)<max(8,np.linalg.norm(direction)*.65) for d in deltas)
            if min(magnitudes)>4 and agree==3:transitions.append((at,float(np.median(magnitudes))))
        if not transitions:continue
        runs=[]
        for at,delta in transitions:
            if runs and at-runs[-1][-1][0]<=2:runs[-1].append((at,delta))
            else:runs.append([(at,delta)])
        supported=[run for run in runs if len(run)>=3]
        if not supported:continue
        # The first continuous low-frequency transition after the two side
        # edges is the fill's termination, not a nearby image or later panel.
        run=supported[0];bottom=float(np.median([v[0] for v in run]))
        if bottom-y<45:continue
        points=[[left,y],[right,y],[right+slope*(bottom-y),bottom],[left+slope*(bottom-y),bottom]]
        panels.append({'points':points,'kind':'parallelogram','confidence':.85,
            'boundaryKinds':['stroke','stroke','fill-end','stroke'],'fillBoundary':{'y':bottom,'contrast':float(np.median([v[1] for v in run]))},
            'evidence':'two-parallel-sides+horizontal-top+three-band-fill-termination'})
    return panels

def analyze(reference,background=None,exclude=()):
    lines,horizontals=line_evidence(reference,background,exclude)
    return {'status':'available','version':1,'lines':lines,'panels':panels_from_edges(reference,lines,horizontals,exclude)}

def match_panel(element,panels):
    if element.get('type') not in ('shape','rect') or element.get('tableId') or min(element.get('w',0),element.get('h',0))<60:return None
    x,y,w,h=[float(element[k]) for k in ('x','y','w','h')];matches=[]
    for panel in panels:
        points=np.asarray(panel['points']);lo,hi=points.min(0),points.max(0);width,height=hi-lo
        if not (.55<=width/w<=1.8 and .5<=height/h<=2.7):continue
        if abs(points[0,1]-y)>max(20,h*.15) or abs(points[1,0]-(x+w))>max(35,w*.16):continue
        center=np.array([x+w/2,y+h/2]);inside=cv2.pointPolygonTest(points.astype(np.float32),tuple(center),False)>=0
        if inside:matches.append((abs(points[0,1]-y)+abs(points[1,0]-x-w)*.25,panel))
    return min(matches,key=lambda item:item[0])[1] if matches else None

if __name__=='__main__':
    spec=json.loads(Path(sys.argv[1]).read_text(encoding='utf8'));ref=load(spec['reference'])
    result=analyze(ref,load(spec.get('background')),spec.get('exclude') or [])
    Path(sys.argv[2]).write_text(json.dumps(result,ensure_ascii=False,indent=1),encoding='utf8')
