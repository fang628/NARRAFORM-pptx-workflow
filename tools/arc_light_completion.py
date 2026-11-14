"""Register missing curved light cores from reference/background evidence."""
import cv2
import numpy as np
import math
import re


def ellipse_arc_path(cx,cy,a,b,angle,start,end,origin):
    """Exact ellipse tangents with <=90 degree cubic spans; observed gaps stay gaps."""
    rotation=math.radians(angle);cr,sr=math.cos(rotation),math.sin(rotation)
    def point(t):return np.array([cx+a/2*math.cos(t)*cr-b/2*math.sin(t)*sr,cy+a/2*math.cos(t)*sr+b/2*math.sin(t)*cr])-origin
    def tangent(t):return np.array([-a/2*math.sin(t)*cr-b/2*math.cos(t)*sr,-a/2*math.sin(t)*sr+b/2*math.cos(t)*cr])
    fmt=lambda p:f'{p[0]:.3f} {p[1]:.3f}'
    steps=np.linspace(start,end,max(2,int(math.ceil((end-start)/(math.pi/2)))+1));parts=['M'+fmt(point(start))]
    for s,z in zip(steps[:-1],steps[1:]):
        k=4/3*math.tan((z-s)/4);parts.append('C'+fmt(point(s)+tangent(s)*k)+' '+fmt(point(z)-tangent(z)*k)+' '+fmt(point(z)))
    return ' '.join(parts)


def combine_arc_layers(elements):
    groups=[]
    for e in elements:
        g=e['arcGeometry'];center=np.asarray(g['center']);axes=np.sort(g['axes'])
        peers=next((p for p in groups if np.linalg.norm(np.asarray(p[0]['arcGeometry']['center'])-center)<8
                    and np.max(np.abs(np.sort(p[0]['arcGeometry']['axes'])-axes))<max(24,float(axes.max())*.15)),None)
        if peers is None:groups.append([e])
        else:peers.append(e)
    output=[]
    for group in groups:
        if len(group)==1:output.extend(group);continue
        x=min(e['x'] for e in group);y=min(e['y'] for e in group)
        w=max(e['x']+e['w'] for e in group)-x;h=max(e['y']+e['h'] for e in group)-y
        parts=[]
        for i,e in enumerate(group):
            body=re.sub(r'^<svg[^>]*>|</svg>$','',e['svg'])
            body=body.replace('id="soft"',f'id="soft-{i}"').replace('url(#soft)',f'url(#soft-{i})')
            parts.append(f'<g transform="translate({e["x"]-x:.3f} {e["y"]-y:.3f})">{body}</g>')
        output.append({**group[0],'x':x,'y':y,'w':w,'h':h,
            'svg':f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">'+''.join(parts)+'</svg>',
            'arcGeometry':{'layers':[e['arcGeometry'] for e in group]},'description':'同一坐标系保留全部实测环层与可见弧段的SVG装饰'})
    return output


def discover_arc_lights(preview,background,seeds):
    delta=np.max(np.abs(preview.astype(float)-background.astype(float)),axis=2)
    hsv=cv2.cvtColor(preview,cv2.COLOR_BGR2HSV)
    mask=((delta>30)&(hsv[:,:,2]>145)).astype(np.uint8)*255
    for e in seeds:
        x,y,w,h=[float(e.get(k,0)) for k in ('x','y','w','h')]
        if e.get('type') in ('text','formula','image','svg','cutout') or e.get('managed'):
            mask[max(0,int(y)-4):min(900,int(y+h)+4),max(0,int(x)-4):min(1600,int(x+w)+4)]=0
    contours=cv2.findContours(mask,cv2.RETR_LIST,cv2.CHAIN_APPROX_NONE)[0]
    distance=cv2.distanceTransform(255-mask,cv2.DIST_L2,3);thickness=cv2.distanceTransform(mask,cv2.DIST_L2,3);accepted=[]
    for contour in sorted(contours,key=lambda c:cv2.arcLength(c,False),reverse=True):
        if len(contour)<90:continue
        (cx,cy),(a,b),angle=cv2.fitEllipse(contour)
        if min(a,b)<18 or max(a,b)<220 or max(a,b)/min(a,b)>24:continue
        if max(a,b)>2100 or not -200<cx<1800 or not -200<cy<1100:continue
        t=np.linspace(0,2*np.pi,721);r=np.deg2rad(angle)
        xx=cx+a/2*np.cos(t)*np.cos(r)-b/2*np.sin(t)*np.sin(r)
        yy=cy+a/2*np.cos(t)*np.sin(r)+b/2*np.sin(t)*np.cos(r)
        xi=np.rint(xx).astype(int);yi=np.rint(yy).astype(int)
        visible=(xi>=0)&(xi<1600)&(yi>=0)&(yi<900)
        support=np.zeros(len(t),bool);support[visible]=distance[yi[visible],xi[visible]]<=3
        if support.sum()<100 or support.sum()/max(1,visible.sum())<.35:continue
        if any(abs(cx-q[0])+abs(cy-q[1])<4 and abs(max(a,b)-q[2])<4 for q in accepted):continue
        # Preserve only observed runs, never invent hidden portions of the ring.
        changes=np.diff(np.r_[False,support,False].astype(int));runs=list(zip(np.where(changes==1)[0],np.where(changes==-1)[0]))
        runs=[(s,z) for s,z in runs if z-s>=12]
        if not runs:continue
        points=np.concatenate([np.column_stack([xx[s:z],yy[s:z]]) for s,z in runs])
        lo=np.maximum([0,0],np.floor(points.min(0)-10));hi=np.minimum([1600,900],np.ceil(points.max(0)+10));w,h=hi-lo
        if w<100 or h<12:continue
        near=np.zeros_like(mask)
        cv2.polylines(near,[np.rint(np.column_stack([xx[s:z],yy[s:z]])).astype(np.int32) for s,z in runs],False,255,7)
        core=preview[(near>0)&(mask>0)]
        if len(core)<20:continue
        widths=thickness[(near>0)&(mask>0)]
        core_width=float(np.clip(np.percentile(widths,70)*2,1,4))
        color=np.median(core,axis=0)[::-1]
        color=''.join(f'{round(v):02X}' for v in color)
        paths=[]
        for s,z in runs:
            paths.append(ellipse_arc_path(cx,cy,a,b,angle,float(t[s]),float(t[z-1]),lo))
        drawing=' '.join(paths)
        svg=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}"><defs><filter id="soft"><feGaussianBlur stdDeviation="3"/></filter></defs><path d="{drawing}" fill="none" stroke="#{color}" stroke-width="{core_width+5:.2f}" opacity=".35" filter="url(#soft)"/><path d="{drawing}" fill="none" stroke="#{color}" stroke-width="{core_width:.2f}"/></svg>'
        accepted.append((cx,cy,max(a,b),{'type':'svg','x':float(lo[0]),'y':float(lo[1]),'w':float(w),'h':float(h),'svg':svg,
            'role':'effect','visualKind':'light-effect','effectKind':'lit-stroke','lighting':{'coreConfirmed':True,'evidence':'reference curved bright ridge absent from registered background'},
            'autoRegistered':True,'arcGeometry':{'center':[float(cx),float(cy)],'axes':[float(a),float(b)],'angle':float(angle),'runs':len(runs)},
            'description':'按参考可见弧段和真实环层补全的独立弧形装饰'}))
        if len(accepted)>=6:break
    return combine_arc_layers([q[3] for q in accepted])
