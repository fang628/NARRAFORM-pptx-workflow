"""Recover a complete, unbranched stroke and its round nodes from preview evidence."""
import heapq
import math
import cv2
import numpy as np


def thin(mask):
    # Zhang-Suen thinning, vectorised over a bounded object-local raster.
    a=np.pad(mask.astype(np.uint8),1)
    for _ in range(100):
        changed=False
        for phase in (0,1):
            p=[a[:-2,1:-1],a[:-2,2:],a[1:-1,2:],a[2:,2:],a[2:,1:-1],a[2:,:-2],a[1:-1,:-2],a[:-2,:-2]]
            count=sum(p);transitions=sum(((p[i]==0)&(p[(i+1)%8]>0)).astype(np.uint8) for i in range(8))
            if phase==0:guard=(p[0]*p[2]*p[4]==0)&(p[2]*p[4]*p[6]==0)
            else:guard=(p[0]*p[2]*p[6]==0)&(p[0]*p[4]*p[6]==0)
            erase=(a[1:-1,1:-1]>0)&(count>=2)&(count<=6)&(transitions==1)&guard
            if erase.any():a[1:-1,1:-1][erase]=0;changed=True
        if not changed:break
    return a[1:-1,1:-1]>0


def graph(mask):
    pixels={tuple(p) for p in np.argwhere(mask)};adj={}
    for y,x in pixels:
        neighbours=[]
        for dy,dx in [(-1,0),(0,-1),(0,1),(1,0),(-1,-1),(-1,1),(1,-1),(1,1)]:
            q=(y+dy,x+dx)
            if q not in pixels:continue
            # A diagonal across two connected orthogonal pixels is a shortcut,
            # not a second branch in a one-pixel corner.
            if dx and dy and ((y+dy,x) in pixels or (y,x+dx) in pixels):continue
            neighbours.append((q,math.hypot(dx,dy)))
        adj[y,x]=neighbours
    return adj


def distances(adj,start):
    costs={start:0.};parent={};queue=[(0.,start)]
    while queue:
        d,p=heapq.heappop(queue)
        if d!=costs[p]:continue
        for q,w in adj[p]:
            trial=d+w
            if trial<costs.get(q,math.inf):costs[q]=trial;parent[q]=p;heapq.heappush(queue,(trial,q))
    return costs,parent


def prune(adj,limit):
    # Remove only short terminal spurs from thick dots/raster corners. Long
    # branches are retained and make the topology ambiguous below.
    for _ in range(4):
        erase=set()
        for start in list(adj):
            if len(adj[start])!=1:continue
            chain=[start];previous=None;at=start;length=0.
            while len(chain)<limit*3+5:
                choices=[(p,w) for p,w in adj[at] if p!=previous]
                if len(choices)!=1:break
                q,w=choices[0];length+=w
                if len(adj[q])!=2:
                    if len(adj[q])>2 and length<limit:erase.update(chain)
                    break
                chain.append(q);previous,at=at,q
                if length>=limit:break
        if not erase:break
        for p in erase:adj.pop(p,None)
        for p in adj:adj[p]=[(q,w) for q,w in adj[p] if q in adj]
    return adj


def round_nodes(mask,path,width):
    distance=cv2.distanceTransform(mask.astype(np.uint8),cv2.DIST_L2,3)
    # Radius peaks separate real nodes from a thicker line or a bright halo.
    peaks=(distance>=cv2.dilate(distance,np.ones((5,5),np.uint8))-.01)&(distance>max(1.5,width*.85))
    count,labels,_,_=cv2.connectedComponentsWithStats(peaks.astype(np.uint8),8);result=[]
    for i in range(1,count):
        yy,xx=np.where(labels==i);radii=distance[yy,xx];best=int(np.argmax(radii));center=np.array([xx[best],yy[best]],float);radius=float(radii[best])
        if radius>max(12,width*5):continue
        nearest=int(np.argmin(np.linalg.norm(path-center,axis=1)))
        if np.linalg.norm(path[nearest]-center)>radius:continue
        angles=np.linspace(0,2*math.pi,48,endpoint=False);ring=center+np.column_stack([np.cos(angles),np.sin(angles)])*radius*.7
        x=np.clip(np.rint(ring[:,0]).astype(int),0,mask.shape[1]-1);y=np.clip(np.rint(ring[:,1]).astype(int),0,mask.shape[0]-1)
        if mask[y,x].mean()<.92:continue
        outer=center+np.column_stack([np.cos(angles),np.sin(angles)])*(radius+1.7)
        x=np.clip(np.rint(outer[:,0]).astype(int),0,mask.shape[1]-1);y=np.clip(np.rint(outer[:,1]).astype(int),0,mask.shape[0]-1)
        if mask[y,x].mean()>.4:continue
        if any(np.linalg.norm(center-n['point'])<radius+n['radius'] for n in result):continue
        result.append({'point':center,'radius':radius,'sample':nearest})
    return result


def simplify_polyline(path,width):
    """Minimise segments under a small preview-space error, then resolve bevels."""
    tolerance=max(2.5,min(3.5,width*1.25))
    candidates=cv2.approxPolyDP(path.astype(np.float32).reshape(-1,1,2),.75,False)[:,0,:].astype(float)
    indices=[0]
    for point in candidates[1:-1]:
        start=indices[-1]+1
        if start>=len(path)-1:break
        indices.append(start+int(np.argmin(np.linalg.norm(path[start:-1]-point,axis=1))))
    indices.append(len(path)-1);candidates=path[indices]
    if len(indices)>160:return cv2.approxPolyDP(path.astype(np.float32).reshape(-1,1,2),tolerance,False)[:,0,:].astype(float)
    def errors(points,a,b):
        d=b-a;t=np.clip((points-a)@d/max(1e-9,float(d@d)),0,1)
        return np.linalg.norm(points-a-t[:,None]*d,axis=1)
    costs=[(math.inf,math.inf)]*len(indices);parents=[None]*len(indices);costs[0]=(0,0.)
    for j in range(1,len(indices)):
        for i in range(j):
            error=errors(path[indices[i]:indices[j]+1],candidates[i],candidates[j])
            if error.max()>tolerance:continue
            score=(costs[i][0]+1,costs[i][1]+float(np.sum(error*error)))
            if score<costs[j]:costs[j]=score;parents[j]=i
    if parents[-1] is None:return candidates
    selected=[len(indices)-1]
    while selected[-1]:selected.append(parents[selected[-1]])
    selected=selected[::-1];points=[candidates[i] for i in selected];stations=[indices[i] for i in selected]
    # A few short raster turns around one intended corner become the
    # intersection of the two supported long spans, not a string of bevels.
    changed=True
    while changed and len(points)>=4:
        changed=False
        for i in range(1,len(points)-2):
            a,b,c,d=points[i-1:i+3];u=b-a;v=d-c
            if np.linalg.norm(c-b)>max(10,width*4) or min(np.linalg.norm(u),np.linalg.norm(v))<12:continue
            matrix=np.column_stack([u,-v])
            if abs(np.linalg.det(matrix))<1e-6:continue
            t,s=np.linalg.solve(matrix,c-a);corner=a+t*u
            if t<.5 or s>.5 or max(np.linalg.norm(corner-b),np.linalg.norm(corner-c))>12:continue
            original=path[stations[i-1]:stations[i+2]+1]
            error=np.minimum(errors(original,a,corner),errors(original,corner,d))
            if error.max()>tolerance:continue
            station=stations[i-1]+int(np.argmin(np.linalg.norm(original-corner,axis=1)))
            points[i:i+2]=[corner];stations[i:i+2]=[station];changed=True;break
    return np.asarray(points)


def recover_stroke(ref,bg,e,controls,hidden,expansion=1):
    """Seed overlap selects identity; graph endpoints define the actual extent."""
    if bg is None or e.get('dashType','solid')!='solid':return None,{'status':'skipped','reason':'background-or-solid-path-required'}
    width=float(e.get('strokeWidth',1));span=np.ptp(controls,axis=0);length=float(sum(np.linalg.norm(b-a) for a,b in zip(controls,controls[1:])))
    pad_x=min(520,max(45,length*.65)*expansion);pad_y=min(160,max(40,float(span[1])+length*.35)*expansion)
    lo=np.maximum([0,0],np.floor(controls.min(0)-[pad_x,pad_y])).astype(int);hi=np.minimum([1600,900],np.ceil(controls.max(0)+[pad_x,pad_y])).astype(int)
    patch=ref[lo[1]:hi[1],lo[0]:hi[0]];lower=bg[lo[1]:hi[1],lo[0]:hi[0]]
    if not patch.size:return None,{'status':'unobservable','reason':'empty-neighbourhood'}
    delta=np.linalg.norm(patch-lower,axis=2)
    # Colour direction suppresses nearby panels and text. The registered RGB is
    # a broad hue prior, never the measured line colour or the traced geometry.
    raw=str(e.get('color','')).lstrip('#');prior=None
    if len(raw)==6:
        try:prior=np.array([int(raw[j:j+2],16) for j in (0,2,4)],np.uint8)
        except ValueError:pass
    hsv=cv2.cvtColor(patch.astype(np.uint8),cv2.COLOR_RGB2HSV)
    eligible=np.ones(delta.shape,bool)
    if prior is not None:
        h,s,v=cv2.cvtColor(prior.reshape(1,1,3),cv2.COLOR_RGB2HSV)[0,0]
        if s>40:
            dh=abs(hsv[:,:,0].astype(float)-float(h));dh=np.minimum(dh,180-dh)
            eligible=(dh<28)&(hsv[:,:,1]>35)
    valid=~hidden[lo[1]:hi[1],lo[0]:hi[0]]
    core=(hsv[:,:,2]>90) if prior is not None and prior.max()>90 else np.ones(delta.shape,bool)
    ink=((delta>18)&eligible&core&valid).astype(np.uint8)
    # Close subpixel/antialias holes only, never bridge independent components.
    ink=cv2.morphologyEx(ink,cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_CROSS,(3,3)))
    ink[~valid]=0
    holes,hierarchy=cv2.findContours(ink,cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is not None:
        for contour,h in zip(holes,hierarchy[0]):
            if h[3]>=0 and cv2.contourArea(contour)<=max(9,width*width*2):cv2.drawContours(ink,[contour],-1,1,-1)
    count,labels,stats,_=cv2.connectedComponentsWithStats(ink,8);choices=[];diagnostics=[];clipped=False
    seed=np.concatenate([np.linspace(a,b,max(8,min(80,round(np.linalg.norm(b-a))))) for a,b in zip(controls,controls[1:])])-lo
    for i in range(1,count):
        x,y,w,h,area=stats[i]
        if area<15 or area>max(1800,length*max(width,2)*18):continue
        component=(labels==i).astype(np.uint8)
        d=cv2.distanceTransform(1-component,cv2.DIST_L2,3)
        xx=np.clip(np.rint(seed[:,0]).astype(int),0,ink.shape[1]-1);yy=np.clip(np.rint(seed[:,1]).astype(int),0,ink.shape[0]-1)
        support=float((d[yy,xx]<max(10,width*3)).mean())
        if support<.55:continue
        diagnostic={'box':[int(x+lo[0]),int(y+lo[1]),int(w),int(h)],'seedSupport':support};diagnostics.append(diagnostic)
        if x<=1 or y<=1 or x+w>=ink.shape[1]-1 or y+h>=ink.shape[0]-1:clipped=True;continue
        skeleton=thin(component);adj=prune(graph(skeleton),max(5,width*2.5))
        ends=[p for p in adj if len(adj[p])==1]
        diagnostic.update(endpoints=len(ends),skeleton=len(adj))
        if len(ends)!=2:continue
        costs,parent=distances(adj,ends[0]);end=ends[1]
        if end not in costs:continue
        points=[end]
        while points[-1]!=ends[0]:points.append(parent[points[-1]])
        path=np.asarray(points[::-1])[:,::-1].astype(float)
        if len(path)<max(15,length*.5) or len(path)>max(800,length*8):continue
        # The two-ended graph must account for the whole skeleton. A loop or
        # unpruned branch cannot silently collapse to a convenient shortest path.
        if len(path)/max(1,len(adj))<.88:continue
        radii=cv2.distanceTransform(component,cv2.DIST_L2,3)[np.rint(path[:,1]).astype(int),np.rint(path[:,0]).astype(int)]
        measured=max(1.,float(np.percentile(radii,35))*2-1)
        nodes=round_nodes(component,path,measured)
        for n in nodes:
            if n['sample']<max(5,n['radius']*2):n['end']='begin'
            elif n['sample']>len(path)-max(6,n['radius']*2):n['end']='end'
        terminals={n['end']:n for n in nodes if n.get('end')}
        first=terminals.get('begin',{}).get('sample',0);last=terminals.get('end',{}).get('sample',len(path)-1)
        path=path[first:last+1].copy()
        for n in nodes:n['sample']-=first
        if 'begin' in terminals:path[0]=terminals['begin']['point']
        if 'end' in terminals:path[-1]=terminals['end']['point']
        global_path=path+lo
        forward=np.linalg.norm(global_path[0]-controls[0])+np.linalg.norm(global_path[-1]-controls[-1])
        reverse=np.linalg.norm(global_path[-1]-controls[0])+np.linalg.norm(global_path[0]-controls[-1])
        if reverse<forward:
            path=path[::-1];global_path=global_path[::-1]
            for n in nodes:
                n['sample']=len(path)-1-n['sample']
                if n.get('end'):n['end']='end' if n['end']=='begin' else 'begin'
        polygon=simplify_polyline(global_path,measured)
        if not 2<=len(polygon)<=24:continue
        observed_nodes=[{**n,'point':(n['point']+lo).tolist()} for n in nodes]
        distance_cost=float(np.median(d[yy,xx]))
        choices.append((support-distance_cost*.03,polygon,observed_nodes,component,lo,measured))
    if clipped and expansion<8:return recover_stroke(ref,bg,e,controls,hidden,expansion*2)
    if not choices:return None,{'status':'unobservable','reason':'no-complete-unbranched-stroke','components':diagnostics}
    choices.sort(key=lambda a:-a[0])
    if len(choices)>1 and choices[0][0]-choices[1][0]<.06:return None,{'status':'unobservable','reason':'ambiguous-stroke-components'}
    _,polygon,nodes,mask,origin,measured=choices[0]
    return ({'points':polygon,'nodes':nodes,'mask':mask,'origin':origin,'width':measured},
        {'status':'complete','nodes':len(nodes),'vertices':len(polygon),'method':'two-terminal-preview-skeleton'})
