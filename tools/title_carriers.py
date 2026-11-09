"""Measured native title plates; only independent visible contours can add one."""
import re
import cv2
import numpy as np


def plate_proposal(ref,parent,text,region,lines,excluded):
    from shape_reference import seed_polygon
    from shape_paint import fit_shape_paint
    points=seed_polygon(parent)
    if not points:return None
    points=np.asarray(points,float)
    y0=region['y'];y1=y0+region['h'];height=y1-y0
    def span(y):
        found=[]
        for a,b in zip(points,np.roll(points,-1,axis=0)):
            if abs(b[1]-a[1])<1e-5:continue
            t=(y-a[1])/(b[1]-a[1])
            if -.03<=t<=1.03:found.append(a[0]+t*(b[0]-a[0]))
        return (min(found),max(found)) if len(found)>=2 else None
    top_span=span(y0+1);bottom_span=span(y1-1)
    if not top_span or not bottom_span:return None
    candidates=[]
    for line in lines:
        if abs(np.sin(line['angle']))>.10 or line['length']<parent['w']*.45:continue
        a,b=line['a'],line['b'];y=float((a[1]+b[1])/2)
        if abs(y-y1)>6:continue
        left,right=sorted([float(a[0]),float(b[0])])
        if right<text['x']+text['w']*.7 or right>bottom_span[1]-10:continue
        if abs(left-bottom_span[0])>max(25,parent['w']*.12):continue
        candidates.append((abs(y-y1)+abs(left-bottom_span[0])*.1,y,left,right))
    if not candidates:return None
    _,y1,left1,right1=min(candidates)
    tops=[q for q in lines if abs(np.sin(q['angle']))<.1 and abs(float((q['a'][1]+q['b'][1])/2)-y0)<6 and q['length']>text['w']*.4 and abs(max(q['a'][0],q['b'][0])-top_span[1])<20]
    if not tops:
        # Texture/antialiasing can interrupt the top rule. Its measured visible
        # segment may end early; the parent anchors the start of the right trace,
        # which must still independently pass the per-pixel support test below.
        tops=[q for q in lines if abs(np.sin(q['angle']))<.1 and abs(float((q['a'][1]+q['b'][1])/2)-y0)<6 and q['length']>text['w']*.4 and abs(max(q['a'][0],q['b'][0])-top_span[1])<min(90,parent['w']*.2)]
    if not tops:return None
    top=min(tops,key=lambda q:abs(max(q['a'][0],q['b'][0])-top_span[1]))
    right0=float(max(top['a'][0],top['b'][0]));y0=float((top['a'][1]+top['b'][1])/2)
    if right0<top_span[1]-20:right0=top_span[1]
    if y0<0 or y1>=900 or y1-y0<28:return None
    xlo=max(0,int(min(right0,right1))-22);xhi=min(1599,int(max(right0,right1))+15)
    rows=np.arange(int(round(y0)),int(round(y1))+1);cols=np.arange(xlo,xhi+1)
    if len(rows)<20 or len(cols)<8:return None
    lab=cv2.cvtColor(ref,cv2.COLOR_RGB2LAB);edge=np.zeros(ref.shape[:2],np.uint8)
    for channel in range(3):edge|=cv2.Canny(cv2.GaussianBlur(lab[:,:,channel],(3,3),.6),25,80)
    distance=cv2.distanceTransform((edge==0).astype(np.uint8),cv2.DIST_L2,3)
    costs=np.minimum(distance[rows[:,None],cols],8).astype(float)
    expected=np.linspace(right0,right1,len(rows))
    costs+=.012*abs(cols[None,:]-expected[:,None])
    dp=np.full(costs.shape,np.inf);previous=np.zeros(costs.shape,np.int16)
    dp[0]=costs[0]+abs(cols-right0)*3
    for i in range(1,len(rows)):
        for j in range(len(cols)):
            candidates_j=np.arange(max(0,j-2),min(len(cols),j+3))
            values=dp[i-1,candidates_j]+.05*(candidates_j-j)**2
            at=int(np.argmin(values));previous[i,j]=candidates_j[at];dp[i,j]=values[at]+costs[i,j]
    j=int(np.argmin(dp[-1]+abs(cols-right1)*4));trace=[]
    for i in range(len(rows)-1,-1,-1):trace.append([cols[j],rows[i]]);j=int(previous[i,j])
    trace=np.array(trace[::-1],np.float32)
    sampled=distance[trace[:,1].astype(int),trace[:,0].astype(int)]
    coverage=float((sampled<=2).mean())
    if coverage<.8 or np.median(sampled)>1.3:return None
    # The short plate has a distinct right edge from its large parent, rather
    # than a divider plus the same enclosing sides. This is the false-box gate.
    parent_edge=np.array([span(float(y))[1] if span(float(y)) else right0 for y in rows])
    if np.percentile(parent_edge-trace[:,0],85)<12:return None
    smooth=trace.copy();smooth[:,0]=cv2.GaussianBlur(trace[:,0:1],(1,7),1.5)[:,0]
    smooth[0]=[right0,y0];smooth[-1]=[right1,y1]
    right=cv2.approxPolyDP(smooth.reshape(-1,1,2),3.0,False)[:,0,:].astype(float)
    polygon=np.vstack([[top_span[0],y0],right,[left1,y1]])
    polygon=cv2.approxPolyDP(cv2.convexHull(polygon.astype(np.float32)),2.5,True)[:,0,:].astype(float)
    if len(polygon)>9 or not cv2.isContourConvex(polygon.astype(np.float32)):return None
    if cv2.contourArea(polygon.astype(np.float32))<parent['w']*(y1-y0)*.5:return None
    lo=polygon.min(axis=0);size=polygon.max(axis=0)-lo;contour=np.rint(polygon).astype(np.int32).reshape(-1,1,2)
    mask=np.zeros(ref.shape[:2],np.uint8);cv2.fillPoly(mask,[contour],1);mask=cv2.erode(mask,np.ones((9,9),np.uint8));mask[excluded]=0
    pixels=ref[mask>0]
    if len(pixels)<120:return None
    color=''.join(f'{int(c):02X}' for c in np.median(pixels,axis=0));key='title-plate-'+re.sub('[^a-zA-Z0-9_-]','-',text.get('nodeId') or text['key'])[:48]
    element={'key':key,'type':'shape','shape':'freeform','role':'carrier','nativeRequired':True,'frameKind':'heading-carrier','contourKind':'measured-title-band',
             'x':round(float(lo[0]),3),'y':round(float(lo[1]),3),'w':round(float(size[0]),3),'h':round(float(size[1]),3),
             'fill':color,'color':color,'strokeWidth':0,'fillOpacity':1,'customGeometry':{'points':np.round((polygon-lo)/size,6).tolist(),'closed':True},
             'carrierId':parent['key'],'geometryEvidence':{'method':'independent-title-boundary-DP','visibleCoverage':round(coverage,3),'samples':len(rows),'confidence':round(coverage,3)}}
    paint=fit_shape_paint(ref,contour,element,[],excluded.astype(np.uint8)*255)
    if paint.get('fill'):element['gradient']=paint['fill']['gradient']
    outline=paint.get('outline')
    if outline and outline.get('color') and outline['confidence']>=.9 and .5<=outline['width']<=3:element.update(strokeWidth=outline['width'],color=outline['color'])
    return element
