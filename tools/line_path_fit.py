"""One open-path model for straight, segmented and Bezier strokes, including terminals."""
import json,sys,math
from pathlib import Path
import cv2
import numpy as np
from stroke_topology import recover_stroke
from line_geometry import path_model,snap_nodes
from paint_models import fit_native_paint
from parameter_confidence import parameter_blocked
cv2.setNumThreads(1)
HORIZONTAL_SNAP_DEGREES=3.


def snap_horizontal(controls,segments,e):
    """Resolve shallow straight spans as exact shared-y constraints in this path."""
    if any(k in e.get('keepParameters',[]) for k in ('position','geometry','linePath','x','y')):return controls,[]
    links=[]
    for index,(op,ids) in enumerate(segments,1):
        if op!='L' or parameter_blocked(e,'slant') or parameter_blocked(e,'slant:'+str(index)):continue
        a,b=controls[ids[0]],controls[ids[-1]];d=b-a
        if np.linalg.norm(d)<8 or abs(d[0])<1e-6:continue
        angle=math.degrees(math.atan2(abs(d[1]),abs(d[0])))
        if angle<=HORIZONTAL_SNAP_DEGREES:links.append((index,ids[0],ids[-1]))
    result=controls.copy();groups=[]
    for _,a,b in links:
        touched=[g for g in groups if a in g or b in g];merged={a,b}
        for g in touched:merged.update(g);groups.remove(g)
        groups.append(merged)
    for group in groups:
        # A shared vertex cannot rotate a neighbouring protected L segment.
        protected=any(op=='L' and any(i in group for i in ids) and parameter_blocked(e,'slant:'+str(index))
                      for index,(op,ids) in enumerate(segments,1))
        if protected:continue
        y=float(np.mean(controls[list(group),1]));result[list(group),1]=y
    # Keep Bezier tangents attached when an adjoining straight span moves a join.
    for op,ids in segments:
        if op in ('Q','C'):
            result[ids[1]]+=result[ids[0]]-controls[ids[0]]
            if op=='C':result[ids[-2]]+=result[ids[-1]]-controls[ids[-1]]
    snapped=[index for index,a,b in links if abs(result[a,1]-result[b,1])<1e-9 and abs(controls[a,1]-controls[b,1])>1e-8]
    return result,snapped


def remap(image,points):
    return cv2.remap(image.astype(np.float32),points[:,:,0].astype(np.float32),points[:,:,1].astype(np.float32),cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT)


def stroke_observations(ref,bg,points,width,hidden):
    tangent=np.gradient(points,axis=0);tangent/=np.maximum(1e-6,np.linalg.norm(tangent,axis=1))[:,None];normal=np.column_stack([-tangent[:,1],tangent[:,0]])
    band=min(24,max(8,width*4));offsets=np.arange(-band,band+.1,.5)
    grid=points[:,None,:]+normal[:,None,:]*offsets[None,:,None];colors=remap(ref,grid)
    # Local sides supply contrast only; they do not become stroke colour samples.
    lower=(np.median(colors[:,:4],axis=1)+np.median(colors[:,-4:],axis=1))/2
    signal=np.linalg.norm(colors-lower[:,None,:],axis=2)
    penalty=np.abs(offsets)[None,:]*1.1;at=np.argmax(signal-penalty,axis=1);peaks=signal[np.arange(len(points)),at]
    centers=offsets[at];observed=points+normal*centers[:,None]
    xx=np.clip(np.rint(observed[:,0]).astype(int),0,1599);yy=np.clip(np.rint(observed[:,1]).astype(int),0,899)
    valid=(peaks>18)&(abs(centers)<band*.7)&~hidden[yy,xx]
    widths=[]
    for i,p in enumerate(at):
        lo=hi=p;threshold=peaks[i]*.55
        while lo>0 and signal[i,lo-1]>=threshold:lo-=1
        while hi+1<len(offsets) and signal[i,hi+1]>=threshold:hi+=1
        widths.append((hi-lo+1)*.5)
    return observed,valid,np.asarray(widths),colors[np.arange(len(points)),at],normal


def encode(controls,segments):
    lo=controls.min(axis=0);extent=np.maximum(.01,controls.max(axis=0)-lo);commands=[{'op':'M','points':[((controls[0]-lo)/extent).tolist()]}]
    for op,ids in segments:commands.append({'op':op,'points':[((controls[i]-lo)/extent).tolist() for i in ids[1:]]})
    return dict(x=round(float(lo[0]),3),y=round(float(lo[1]),3),w=round(float(extent[0]),3),h=round(float(extent[1]),3),linePath={'version':1,'commands':commands})


def project_to_path(point,samples):
    a=samples[:-1];d=samples[1:]-a
    t=np.clip(np.sum((point-a)*d,axis=1)/np.maximum(1e-9,np.sum(d*d,axis=1)),0,1)
    projected=a+t[:,None]*d;index=int(np.argmin(np.linalg.norm(projected-point,axis=1)))
    return projected[index],index,float(t[index])


def relocate_nodes(source,target):
    """Keep attached nodes at their path station when shared controls move."""
    if not source.get('linePath',{}).get('nodes'):return
    controls,_,basis=path_model(source);new_controls,_,_=path_model(target)
    samples=basis@controls;new_samples=basis@new_controls;lo=np.array([target['x'],target['y']]);extent=np.maximum(.01,[target['w'],target['h']]);nodes=[]
    for n in source['linePath']['nodes']:
        point=np.array(n['position'])*[source['w'],source['h']]+[source['x'],source['y']]
        _,index,t=project_to_path(point,samples);mapped=new_samples[index]*(1-t)+new_samples[index+1]*t
        nodes.append({**n,'position':np.clip((mapped-lo)/extent,0,1).tolist()})
    target['linePath']['nodes']=nodes


def solve_controls(A,target,controls,segments,e,original):
    """Hard slope locks live in the new path solve, not a post-fit repair."""
    n=len(controls);matrix=np.kron(A,np.eye(2));values=target.reshape(-1)
    design=np.vstack([matrix,np.eye(n*2)*.6]);rhs=np.r_[values,controls.reshape(-1)*.6]
    constraints=[]
    for index,(op,ids) in enumerate(segments,1):
        if op!='L' or not (parameter_blocked(e,'slant') or parameter_blocked(e,'slant:'+str(index))):continue
        direction=original[ids[-1]]-original[ids[0]];length=float(np.linalg.norm(direction))
        if length<1e-6:continue
        normal=np.array([-direction[1],direction[0]])/length;row=np.zeros(n*2)
        row[ids[-1]*2:ids[-1]*2+2]=normal;row[ids[0]*2:ids[0]*2+2]=-normal
        constraints.append(row)
    if not constraints:return np.linalg.lstsq(design,rhs,rcond=None)[0].reshape(-1,2)
    C=np.asarray(constraints);H=design.T@design;g=design.T@rhs
    kkt=np.block([[H,C.T],[C,np.zeros((len(C),len(C)))]])
    return np.linalg.lstsq(kkt,np.r_[g,np.zeros(len(C))],rcond=None)[0][:n*2].reshape(-1,2)


def terminal(ref,bg,tip,inward,width,kind,hidden):
    if kind in (None,'none'):return {},{'type':'none'}
    if bg is None:return {},{'type':kind,'status':'unobservable'}
    tx,ty=np.rint(tip).astype(int)
    if not (0<=tx<1600 and 0<=ty<900):return {},{'type':kind,'status':'unobservable','reason':'terminal-clipped'}
    if hidden[max(0,ty-2):min(900,ty+3),max(0,tx-2):min(1600,tx+3)].any():return {},{'type':kind,'status':'unobservable','reason':'terminal-occluded'}
    normal=np.array([-inward[1],inward[0]]);extent=min(30,max(7,width*5));u=np.arange(-extent,extent+.1,.5);a,b=np.meshgrid(u,u)
    grid=tip+a[:,:,None]*inward+b[:,:,None]*normal
    delta=np.linalg.norm(remap(ref,grid)-remap(bg,grid),axis=2);hit=delta>max(18,float(np.percentile(delta,99))*.45)
    q=np.rint(grid).astype(int);inside=(q[:,:,0]>=0)&(q[:,:,0]<1600)&(q[:,:,1]>=0)&(q[:,:,1]<900)
    visible=inside.copy();visible[inside]&=~hidden[q[:,:,1][inside],q[:,:,0][inside]];hit &= visible
    perimeter=(abs(a)>extent-1)|(abs(b)>extent-1)
    if not (perimeter&visible).any() or np.median(delta[perimeter&visible])>12:return {},{'type':kind,'status':'unobservable','reason':'terminal-underlay-mismatch'}
    # Nearby labels may have the same colour. Only the component meeting the
    # axis at the tip can supply this terminal's wings. Allow subpixel rounding.
    _,labels=cv2.connectedComponents(hit.astype(np.uint8),connectivity=8)
    core=hit&(abs(b)<=1.5)&(abs(a)<=max(2.,min(4.,width*.6)))
    candidates=np.unique(labels[core])
    if len(candidates)!=1:return {},{'type':kind,'status':'unobservable','reason':'ambiguous-terminal-component'}
    hit=labels==candidates[0]
    # Terminal wings, not the attached shaft, determine marker dimensions.
    wings=hit&(abs(b)>width*.85)&(abs(a)<extent*.75)
    if wings.sum()<8:return {},{'type':kind,'status':'unobservable','reason':'no-terminal-wings'}
    across=float(np.ptp(b[wings])+.5);along=float(np.ptp(a[wings])+.5)
    if kind=='oval' and not .65<along/max(1,across)<1.45:return {},{'type':kind,'status':'unobservable','reason':'not-round-terminal'}
    sizes={'sm':2,'med':3,'lg':5};size=lambda v:min(sizes,key=lambda k:abs(math.log(max(.1,v/width)/sizes[k])))
    marker={'width':size(across),'length':size(across if kind=='oval' else along)}
    return marker,{'type':kind,'status':'measured','width':round(across,3),'length':round(along,3),'size':marker}


def fade_profile(e,points,colors,lower,valid):
    """Native spatial alpha field with station holdout; never fit gaps as fades."""
    raw=str(e.get('color','')).lstrip('#')
    if len(raw)!=6:return None,{'status':'unobservable','reason':'unknown-ink'}
    ink=np.array([int(raw[i:i+2],16) for i in (0,2,4)],float);base=ink-lower
    alpha=np.sum((colors-lower)*base,axis=1)/np.maximum(1,np.sum(base*base,axis=1))
    color_error=float(np.sqrt(np.mean((lower+alpha[:,None]*base-colors)[valid]**2)))
    global_alpha=float(e.get('opacity',1))*float(e.get('colorOpacity',1))
    if color_error>4 or global_alpha<.1:return None,{'status':'unobservable','reason':'colour-change-not-alpha-fade','colorRmse':color_error}
    direction=points[-1]-points[0];length=np.linalg.norm(direction)
    if length<8:return None,{'status':'unobservable','reason':'nonmonotone-spatial-path'}
    unit=direction/length;u=(points-points[0])@unit/length
    if (np.diff(u)<-.002).any():return None,{'status':'unobservable','reason':'nonmonotone-spatial-path'}
    selected=valid&(u>=.07)&(u<=.93);indices=np.where(selected)[0]
    if len(indices)<30:return None,{'status':'unobservable','reason':'insufficient-visible-stations'}
    # Inspect continuous samples before any coarse spline can smooth a gap away.
    aa=alpha[indices]/global_alpha
    continuous=np.diff(indices)==1
    if continuous.any() and np.max(abs(np.diff(aa))[continuous])>.18:return None,{'status':'unobservable','reason':'hard-cap-gap-or-texture'}
    bins=[]
    for at in np.linspace(.08,.92,22):
        hit=selected&(abs(u-at)<.025)
        if hit.sum()>=2:bins.append([float(np.median(u[hit])),float(np.median(alpha[hit]))/global_alpha])
    if len(bins)<14:return None,{'status':'unobservable','reason':'occluded-profile'}
    values=np.asarray(bins);peak=int(np.argmax(values[:,1]));span=float(np.ptp(values[:,1]))
    if span<.25:return None,{'status':'absent'}
    increasing=(np.diff(values[:,1])>=-.04).mean()>.88;decreasing=(np.diff(values[:,1])<=.04).mean()>.88
    bilateral=2<=peak<len(values)-2 and (np.diff(values[:peak+1,1])>=-.04).mean()>.85 and (np.diff(values[peak:,1])<=.04).mean()>.85
    if not (increasing or decreasing or bilateral):return None,{'status':'unobservable','reason':'nonfade-profile'}
    knots_list=[[0.,1.]]
    locations=np.round(np.arange(.15,.851,.05),2)
    knots_list.extend([[0.,float(a),1.] for a in locations])
    if bilateral:knots_list.extend([[0.,float(a),float(b),1.] for a in locations for b in locations if b>a])
    train=np.arange(len(values))%2==0;choices=[]
    for knots in knots_list:
        matrix=np.column_stack([np.interp(values[:,0],knots,np.eye(len(knots))[i]) for i in range(len(knots))])
        if np.linalg.matrix_rank(matrix[train])<len(knots):continue
        coef=np.linalg.lstsq(matrix[train],values[train,1],rcond=None)[0]
        if coef.min()<-.05 or coef.max()>1.08:continue
        shape=np.diff(coef)
        if bilateral:
            p=int(np.argmax(coef))
            if not 0<p<len(coef)-1 or (shape[:p]<-.04).any() or (shape[p:]>.04).any():continue
        elif increasing and (shape<-.04).any() or decreasing and (shape>.04).any():continue
        error=float(np.sqrt(np.mean((matrix[~train]@coef-values[~train,1])**2)))
        dense=float(np.sqrt(np.mean((np.interp(u[indices],knots,coef)-aa)**2)))
        if error<.045 and dense<.055:choices.append((error+dense+.002*len(knots),knots,coef,error))
    if not choices:return None,{'status':'unobservable','reason':'fade-holdout-rejected'}
    _,knots,coef,error=min(choices,key=lambda a:a[0])
    # PowerPoint's linear field is expressed over the object's box projection.
    x,y,w,h=[float(e[k]) for k in ('x','y','w','h')];projection=abs(unit[0])*w+abs(unit[1])*h
    origin=min(unit@np.array([x+dx*w,y+dy*h]) for dx,dy in [(0,0),(1,0),(1,1),(0,1)])
    stops=[{'position':float(np.clip((unit@points[0]+u0*length-origin)/max(.01,projection),0,1)),
            'color':raw.upper(),'opacity':round(float(np.clip(a,0,1)),4)} for u0,a in zip(knots,coef)]
    angle=math.degrees(math.atan2(unit[1],unit[0]))%360
    return {'type':'linear','angle':angle,'stops':stops},{'status':'present','shape':'bilateral' if bilateral else 'unilateral','holdoutRmse':error,'globalAlphaPreserved':True}


def dash_profile(points,observed_valid,width):
    changes=np.diff(np.r_[False,observed_valid,False].astype(int));starts=np.where(changes==1)[0];ends=np.where(changes==-1)[0]
    if len(starts)<4:return None
    lengths=np.linalg.norm(np.diff(points,axis=0),axis=1);step=max(.1,float(np.median(lengths[lengths>0])))
    sizes=(ends-starts)*step;gaps=(starts[1:]-ends[:-1])*step
    if np.std(sizes)/max(1,np.mean(sizes))>.4 or np.std(gaps)/max(1,np.mean(gaps))>.45 or np.median(gaps)<1:return None
    return 'sysDot' if np.median(sizes)<width*1.6 else 'dash'


AXIS_LINE_MIN_LENGTH=16.
AXIS_LINE_MIN_PAD=60.
AXIS_LINE_MAX_PAD=200.
AXIS_LINE_COLOR_DISTANCE=95.
AXIS_LINE_HUE_DEGREES=20.
AXIS_LINE_MIN_CONFIDENCE=.85
AXIS_LINE_DIRECTIONAL=('triangle','stealth','arrow','diamond')
AXIS_LINE_MAX_DISPLACEMENT=180.


def axis_line_descriptor(e):
    """A declared straight axial span is the only instance a repeated-line group may locate."""
    if e.get('type')!='line' or e.get('managed') or e.get('tableId') or e.get('tableRole'):return None
    if e.get('dashType','solid')!='solid':return None
    if any(k in (e.get('keepParameters') or []) for k in ('position','x','y','geometry','linePath')):return None
    line=e.get('linePath') or {}
    if line.get('nodes'):return None
    commands=line.get('commands') or []
    if len(commands)!=2 or commands[0].get('op')!='M' or commands[1].get('op')!='L':return None
    try:
        w,h=float(e.get('w') or 0),float(e.get('h') or 0);stroke=float(e.get('strokeWidth') or 1)
        opacity=float(e.get('opacity',1))*float(e.get('colorOpacity',1))
        first=[float(v) for v in commands[0]['points'][0]];last=[float(v) for v in commands[1]['points'][0]]
    except (TypeError,ValueError,KeyError,IndexError):return None
    # Only a truly horizontal or vertical single-span path is an axis instance; bent or
    # slanted declared paths are never reset by repeated-line registration.
    dx=(last[0]-first[0])*w;dy=(last[1]-first[1])*h
    if abs(dy)<=max(1.5,.02*abs(dx)) and abs(dx)>=AXIS_LINE_MIN_LENGTH:axis=0;length=abs(dx)
    elif abs(dx)<=max(1.5,.02*abs(dy)) and abs(dy)>=AXIS_LINE_MIN_LENGTH:axis=1;length=abs(dy)
    else:return None
    raw=str(e.get('color') or '').lstrip('#').upper()
    if len(raw)!=6:return None
    try:rgb=np.array([int(raw[i:i+2],16) for i in (0,2,4)],float)
    except ValueError:return None
    return {'axis':axis,'length':length,'rgb':rgb,'strokeWidth':stroke,'opacity':round(opacity,3),
            'arrow':(e.get('beginArrowType') or 'none',e.get('endArrowType') or 'none'),
            'state':str(e.get('visualState',e.get('emphasis','normal')))}


def axis_line_groups(elements):
    """Explicit repetition: same declared appearance, aligned row or column, distinct order."""
    buckets={}
    for e in elements:
        d=axis_line_descriptor(e)
        if d is None:continue
        buckets.setdefault((d['axis'],d['rgb'].tobytes(),round(d['strokeWidth'],2),d['arrow'],d['state'],d['opacity']),[]).append((e,d))
    groups=[]
    for items in buckets.values():
        if len(items)<2:continue
        axis=items[0][1]['axis'];rows=[];usable=True
        for e,d in items:
            try:ex,ey,ew,eh=float(e['x']),float(e['y']),float(e['w']),float(e['h'])
            except (KeyError,TypeError,ValueError):usable=False;break
            if axis==0:along,cross=ex+ew/2,ey+eh/2
            else:along,cross=ey+eh/2,ex+ew/2
            rows.append({'element':e,'descriptor':d,'along':along,'cross':cross})
        if not usable or len(rows)!=len(items):continue
        length=float(np.median([r['descriptor']['length'] for r in rows]));tolerance=max(4.,.15*length)
        if min(r['descriptor']['length'] for r in rows)<.8*length:continue
        crosses=[r['cross'] for r in rows];along_coords=[r['along'] for r in rows]
        if max(crosses)-min(crosses)<=tolerance and max(along_coords)-min(along_coords)>max(8.,length*.5):ordering='along'
        elif max(along_coords)-min(along_coords)<=tolerance and max(crosses)-min(crosses)>max(8.,length*.5):ordering='cross'
        else:continue
        rows.sort(key=lambda r:(r[ordering],str(r['element'].get('key'))))
        coords=[r[ordering] for r in rows];gaps=[coords[i+1]-coords[i] for i in range(len(coords)-1)]
        if not gaps:continue
        median_gap=float(np.median(gaps))
        if median_gap<max(8.,length*.5) or min(gaps)<max(6.,median_gap*.45):continue
        groups.append({'items':rows,'axis':axis,'ordering':ordering,'length':length,'medianGap':median_gap})
    groups.sort(key=lambda g:(-len(g['items']),g['axis'],g['ordering'],-g['medianGap']))
    return groups


def locate_axis_group(reference,hidden,group):
    """Exact cardinality plus preserved order assigns one preview component per declared line."""
    items=group['items'];axis=group['axis'];ordering=group['ordering']
    length=float(group['length']);pad=min(AXIS_LINE_MAX_PAD,max(AXIS_LINE_MIN_PAD,.7*float(group['medianGap'])))
    centres=[]
    for r in items:
        e=r['element']
        try:centres.append((float(e['x'])+float(e['w'])/2,float(e['y'])+float(e['h'])/2))
        except (KeyError,TypeError,ValueError):return None
    x0=max(0,int(np.floor(min(c[0] for c in centres)-pad)));x1=min(1600,int(np.ceil(max(c[0] for c in centres)+pad)))
    y0=max(0,int(np.floor(min(c[1] for c in centres)-pad)));y1=min(900,int(np.ceil(max(c[1] for c in centres)+pad)))
    crop=reference[y0:y1,x0:x1].astype(float)
    if crop.size==0:return None
    rgb=np.asarray(items[0]['descriptor']['rgb'],float)
    delta=np.linalg.norm(crop-rgb[None,None,:],axis=2)
    hsv=cv2.cvtColor(crop.astype(np.uint8),cv2.COLOR_RGB2HSV)
    prior=cv2.cvtColor(np.rint(rgb).astype(np.uint8).reshape(1,1,3),cv2.COLOR_RGB2HSV)[0,0]
    # Measure the true preview ink: the declared colour scopes hue, while brightness must stay
    # near the declared paint. Deeper same-hue text (headings) never becomes a line candidate.
    value=max(1.,float(rgb.max()));low_value=.85*value;high_value=min(255.,1.3*value)
    eligible=(delta<AXIS_LINE_COLOR_DISTANCE)&(hsv[:,:,2]>=low_value)&(hsv[:,:,2]<=high_value)
    if float(prior[1])>110:
        dh=np.abs(hsv[:,:,0].astype(float)-float(prior[0]));dh=np.minimum(dh,180-dh)
        eligible|=(dh<AXIS_LINE_HUE_DEGREES)&(hsv[:,:,1]>130)&(hsv[:,:,2]>=low_value)&(hsv[:,:,2]<=high_value)&(delta<150)
    count,labels,stats,_=cv2.connectedComponentsWithStats(eligible.astype(np.uint8),8)
    median_stroke=float(np.median([r['descriptor']['strokeWidth'] for r in items]))
    limit=max(8.,2.*median_stroke+5.);min_thickness=max(1.,.4*median_stroke)
    # One-directional arrows must show a taper before counting: the tip side is derived from the
    # declared marker so a real extra arrow still rejects, while text strokes never pass counting.
    arrow=(items[0]['element'].get('beginArrowType') or 'none',items[0]['element'].get('endArrowType') or 'none')
    begin_directional=arrow[0] in AXIS_LINE_DIRECTIONAL;end_directional=arrow[1] in AXIS_LINE_DIRECTIONAL
    directional=begin_directional!=end_directional
    marker_highs=set()
    if directional:
        position=0 if axis==0 else 1
        for r in items:
            commands=(r['element'].get('linePath') or {}).get('commands') or []
            if len(commands)<2:marker_highs=set();break
            end_high=float(commands[-1]['points'][-1][position])>=float(commands[0]['points'][0][position])
            marker_highs.add(end_high if end_directional else not end_high)
    marker_high=next(iter(marker_highs)) if len(marker_highs)==1 else None
    candidates=[]
    for index in range(1,count):
        x,y,w,h,area=[int(v) for v in stats[index]]
        if area<12:continue
        if x<=0 or y<=0 or x+w>=eligible.shape[1] or y+h>=eligible.shape[0]:continue
        # Early axial length, narrowness and thickness filtering keep the scan local.
        if axis==0:along_lo,along_ext,cross_ext=x,w,h
        else:along_lo,along_ext,cross_ext=y,h,w
        if along_ext<max(AXIS_LINE_MIN_LENGTH,.55*length) or along_ext>1.5*length:continue
        if along_ext<1.25*max(1.,cross_ext):continue
        if cross_ext<min_thickness:continue
        local=labels[y:y+h,x:x+w]==index;ys,xs=np.nonzero(local)
        if ys.size<8:continue
        if axis==0:
            counts=local.sum(axis=0)
            weights=np.bincount(xs,minlength=w).astype(float);sums=np.bincount(xs,weights=ys.astype(float),minlength=w)
            cross=float(np.median(sums[weights>0]/weights[weights>0]))+y+y0+.5
        else:
            counts=local.sum(axis=1)
            weights=np.bincount(ys,minlength=h).astype(float);sums=np.bincount(ys,weights=xs.astype(float),minlength=h)
            cross=float(np.median(sums[weights>0]/weights[weights>0]))+x+x0+.5
        counts=counts[counts>0].astype(float)
        if float(np.median(counts))<min_thickness:continue
        if directional:
            # Shaft width, expanded arrowhead and taper direction are judged before cardinality.
            span=max(2,int(round(counts.size*.12)))
            low=float(np.mean(counts[:span]));high=float(np.mean(counts[-span:]))
            shaft=max(low,high);head=float(np.max(counts))
            if shaft<min_thickness:continue
            if head<max(shaft*1.5,shaft+4.):continue
            if abs(low-high)<max(2.,.3*shaft):continue
            if marker_high is not None and (high<low)!=marker_high:continue
        thin=float((counts<=limit).mean())
        if thin<.6:continue
        span=max(2,int(round(counts.size*.12)))
        along_start=along_lo+(x0 if axis==0 else y0)
        candidates.append({'box':[x+x0,y+y0,w,h],'along':along_start,'alongExt':along_ext,
            'cross':cross,'order':(along_start+along_ext/2.) if ordering=='along' else cross,
            'thin':thin,'first':float(np.mean(counts[:span])),'last':float(np.mean(counts[-span:])),
            'color':np.median(crop[y:y+h,x:x+w][local],axis=0)})
    if len(candidates)!=len(items):return None
    members=sorted(items,key=lambda r:r[ordering]);registered=[float(r[ordering]) for r in members]
    gaps=[registered[i+1]-registered[i] for i in range(len(registered)-1)]
    if not gaps or min(gaps)<=0:return None
    candidates.sort(key=lambda c:c['order']);observed=[float(c['order']) for c in candidates]
    for i in range(len(observed)-1):
        if observed[i+1]-observed[i]<max(6.,min(gaps)*.45):return None
    max_displacement=max(AXIS_LINE_MAX_DISPLACEMENT,1.1*length)
    for r,c in zip(members,candidates):
        e=r['element']
        try:ex,ey,ew,eh=float(e['x']),float(e['y']),float(e['w']),float(e['h'])
        except (KeyError,TypeError,ValueError):return None
        if axis==0:along_delta=float(c['along'])-ex;cross_delta=float(c['cross'])-(ey+eh/2)
        else:along_delta=float(c['along'])-ey;cross_delta=float(c['cross'])-(ex+ew/2)
        if float(np.hypot(along_delta,cross_delta))>max_displacement:return None
        if abs(float(c['order'])-float(r[ordering]))>pad+8:return None
    colours=[np.asarray(c['color'],float) for c in candidates]
    if max(float(np.linalg.norm(a-b)) for a in colours for b in colours)>40:return None
    for r,c in zip(members,candidates):
        e=r['element'];begin=e.get('beginArrowType') or 'none';end=e.get('endArrowType') or 'none'
        begin_directional=begin in AXIS_LINE_DIRECTIONAL;end_directional=end in AXIS_LINE_DIRECTIONAL
        if begin_directional==end_directional:continue
        commands=(e.get('linePath') or {}).get('commands') or []
        if len(commands)<2:return None
        position=0 if axis==0 else 1
        end_high=float(commands[-1]['points'][-1][position])>=float(commands[0]['points'][0][position])
        marker_high=end_high if end_directional else not end_high
        if abs(float(c['first'])-float(c['last']))<1.:return None
        if (float(c['last'])<float(c['first']))!=marker_high:return None
    colour=''.join(f'{max(0,min(255,int(round(float(v))))):02X}' for v in np.median(np.asarray(colours),axis=0))
    member_keys=[str(r['element'].get('key')) for r in members];seeds={}
    for r,c in zip(members,candidates):
        e=r['element'];d=r['descriptor']
        markers=(e.get('beginArrowType') or 'none',e.get('endArrowType') or 'none')
        if not any(kind in ('oval','diamond') for kind in markers):start=float(c['along']);extent=float(c['alongExt'])
        else:
            centre=float(c['along'])+float(c['alongExt'])/2.;start=centre-float(d['length'])/2.;extent=float(d['length'])
        if axis==0:x,y,w,h=start,float(c['cross']),extent,float(e.get('h') or 0)
        else:x,y,w,h=float(c['cross']),start,float(e.get('w') or 0),extent
        seeds[str(e.get('key'))]={'x':round(x,3),'y':round(y,3),'w':round(w,3),'h':round(h,3),
            'evidence':{'method':'preview-repeated-axis-lines','members':member_keys,
                'axis':'horizontal' if axis==0 else 'vertical','ordering':ordering,'confidence':.9,
                'previewColor':colour,'componentBox':[int(c['box'][0]),int(c['box'][1]),int(c['box'][2]),int(c['box'][3])],
                'thinRatio':round(float(c['thin']),4),
                'registered':[round(float(e.get('x') or 0),3),round(float(e.get('y') or 0),3),round(float(e.get('w') or 0),3),round(float(e.get('h') or 0),3)]}}
    return seeds


def locate_axis_lines(elements,reference,hidden):
    """Repeated similar axial lines are seeded by preview colour, cardinality and order only."""
    seeds={}
    try:groups=axis_line_groups(elements)
    except Exception:return seeds
    for group in groups:
        try:located=locate_axis_group(reference,hidden,group)
        except Exception:located=None
        if located:seeds.update(located)
    return seeds


def localized_geometry(e):
    """Take the registered line's measured box while keeping its declared path."""
    controls,segments,basis=path_model(e)
    geometry=encode(controls,segments);declared=e.get('linePath') or {}
    for field in ('nodes','terminals','segmentGroups'):
        if declared.get(field):geometry['linePath'][field]=declared[field]
    return geometry


def fit(e,ref,bg,hidden):
    """Fit one registered path; a repeated-axis-line group may seed the real preview position."""
    seed=e.get('_axisSeed') if isinstance(e.get('_axisSeed'),dict) else None
    if seed is None:return fit_registered(e,ref,bg,hidden)
    registered={k:v for k,v in e.items() if k!='_axisSeed'}
    try:positioned={**registered,'x':float(seed['x']),'y':float(seed['y']),'w':float(seed['w']),'h':float(seed['h']),'_fixedGeometry':True}
    except (KeyError,TypeError,ValueError):return fit_registered(registered,ref,bg,hidden)
    if all(abs(positioned[k]-float(registered.get(k,0)))<1 for k in ('x','y','w','h')):return fit_registered(registered,ref,bg,hidden)
    seeded=None
    try:seeded=fit_registered(positioned,ref,bg,hidden)
    except Exception:seeded=None
    localization=seed.get('evidence') if isinstance(seed.get('evidence'),dict) else {}
    if isinstance(seeded,dict) and seeded.get('accepted'):
        return {**seeded,'evidence':{**(seeded.get('evidence') or {}),'source':'preview-axis-line-registration','axisLocalization':localization}}
    if float(localization.get('confidence') or 0)<AXIS_LINE_MIN_CONFIDENCE:return fit_registered(registered,ref,bg,hidden)
    try:geometry=localized_geometry(positioned)
    except Exception:return fit_registered(registered,ref,bg,hidden)
    return {'key':e['key'],'accepted':True,'geometry':geometry,
        'evidence':{'source':'preview-axis-line-registration','support':localization.get('thinRatio'),'axisLocalization':localization}}


def fit_registered(e,ref,bg,hidden):
    controls,segments,basis=path_model(e);original=controls.copy();topology='registered-path'
    fixed=e.get('_fixedGeometry',False) or any(k in e.get('keepParameters',[]) for k in ('position','x','y','geometry','linePath'))
    topology_locked=parameter_blocked(e,'slant') or any(str(p).startswith('slant:') for p in e.get('keepParameters',[])) or bool(e['linePath'].get('segmentGroups'))
    recovered=None;topology_evidence=None
    if not fixed and not topology_locked and all(op=='L' for op,ids in segments):
        recovered,topology_evidence=recover_stroke(ref,bg,e,controls,hidden)
        if recovered is not None:
            traced=recovered['points']
            geometry=encode(traced,[('L',[i-1,i]) for i in range(1,len(traced))]);controls,segments,basis=path_model({**e,**geometry});original=controls.copy();topology='reference-connected-path'
        elif topology_evidence.get('reason')=='ambiguous-stroke-components' or any(c.get('endpoints') is not None and c['endpoints']!=2 for c in topology_evidence.get('components',[])):
            return {'key':e['key'],'accepted':False,'evidence':{'reason':'ambiguous-path-topology','topologyEvidence':topology_evidence}}
    width=float(e.get('strokeWidth',1));points=basis@controls
    for _ in range(2):
        observed,valid,widths,colors,normals=stroke_observations(ref,bg,points,width,hidden)
        detected_dash=dash_profile(points,valid,width)
        t=np.arange(len(valid));valid &= (t>max(3,len(t)*.05))&(t<len(t)*.95)&(widths<max(7,width*3))
        if valid.sum()<max(12,len(points)*(.18 if detected_dash or e.get('dashType','solid')!='solid' else .35)):return {'key':e['key'],'accepted':False,'evidence':{'support':float(valid.mean()),'reason':'insufficient-path-support'}}
        A=basis[valid];target=observed[valid]
        # One solve shares segment junction controls and both terminal locations.
        fitted=controls if fixed or recovered is not None else solve_controls(A,target,controls,segments,e,original)
        if np.max(np.linalg.norm(fitted-controls,axis=1))>18:return {'key':e['key'],'accepted':False,'evidence':{'reason':'path-displacement-too-large'}}
        controls=fitted;points=basis@controls
    snapped=[]
    if not fixed:
        controls,snapped=snap_horizontal(controls,segments,e);points=basis@controls
        observed,valid,widths,colors,normals=stroke_observations(ref,bg,points,width,hidden)
        t=np.arange(len(valid));valid&=(t>max(3,len(t)*.05))&(t<len(t)*.95)&(widths<max(7,width*3))
        if valid.sum()<12:return {'key':e['key'],'accepted':False,'evidence':{'reason':'insufficient-path-support-after-axis-fit'}}
    residual=np.linalg.norm(points[valid]-observed[valid],axis=1);p95=float(np.percentile(residual,90));support=float((residual<2.5).mean())
    if p95>4:return {'key':e['key'],'accepted':False,'evidence':{'p95':p95,'support':support,'reason':'path-not-supported'}}
    geometry=encode(controls,segments)
    if recovered is not None:
        lo=np.array([geometry['x'],geometry['y']]);extent=np.array([geometry['w'],geometry['h']]);nodes=[]
        for node in recovered['nodes']:
            nearest,_,_=project_to_path(np.array(node['point']),points)
            if node.get('end'):continue
            position=np.clip((nearest-lo)/extent,0,1).tolist()
            nodes.append({'position':position,'diameter':round(node['radius']*2,3)})
        if nodes:geometry['linePath']['nodes']=nodes
        terminals={node['end']:node for node in recovered['nodes'] if node.get('end')}
        if terminals:geometry['linePath']['terminals']={side:{'diameter':round(node['radius']*2,3)} for side,node in terminals.items()}
        geometry['beginArrowType']='oval' if 'begin' in terminals else e.get('beginArrowType','none') if e.get('beginArrowType') not in ('oval',None) else 'none'
        geometry['endArrowType']='oval' if 'end' in terminals else e.get('endArrowType','none') if e.get('endArrowType') not in ('oval',None) else 'none'
    elif e['linePath'].get('nodes'):
        if fixed:geometry['linePath']['nodes']=e['linePath']['nodes']
        else:relocate_nodes(e,geometry)
    if recovered is None and e['linePath'].get('terminals'):geometry['linePath']['terminals']=e['linePath']['terminals']
    if e['linePath'].get('segmentGroups') and topology=='registered-path':geometry['linePath']['segmentGroups']=e['linePath']['segmentGroups']
    if not fixed:
        attached={**e,**geometry};snap_nodes(attached)
        geometry['linePath']=attached['linePath']
        for side in ('begin','end'):
            if side+'ArrowType' in attached:geometry[side+'ArrowType']=attached[side+'ArrowType']
    segment_evidence={}
    for index,(op,ids) in enumerate(segments,1):
        # Basis sample counts were fixed before fitting. Recover each segment's
        # rows by its nonzero control support, excluding shared join rows.
        active=(basis[:,ids].sum(axis=1)>.999)&(np.count_nonzero(basis,axis=1)>1)
        usable=active&valid
        coverage=float(usable.sum()/max(1,active.sum()))
        if usable.sum()>=max(3,min(8,int(active.sum()*.35))):
            error=np.linalg.norm(points[usable]-observed[usable],axis=1);p=float(np.percentile(error,90));s=float((error<2.5).mean())
            score=s*min(1.,coverage/.6)*max(0.,1-p/6)
        else:p=None;s=0.;score=0.
        segment_evidence[str(index)]={'confidence':round(score,4),'support':round(s,4),'visibleCoverage':round(coverage,4),'p95':p,'independent':True}
    unsupported=[]
    for index,(op,ids) in enumerate(segments,1):
        evidence=segment_evidence[str(index)];active=(basis[:,ids].sum(axis=1)>.999)&(np.count_nonzero(basis,axis=1)>1)
        q=points[active];xx=np.clip(np.rint(q[:,0]).astype(int),0,1599);yy=np.clip(np.rint(q[:,1]).astype(int),0,899)
        visibility=float((~hidden[yy,xx]).mean()) if len(q) else 0
        evidence['occluded']=visibility<.35
        if evidence['occluded']:evidence['confidence']=0.;evidence['independent']=False
        if visibility>=.35 and (evidence['visibleCoverage']<.4 or evidence['support']<.6 or evidence['p95'] is None or evidence['p95']>4):unsupported.append(index)
    if unsupported:return {'key':e['key'],'accepted':False,'evidence':{'reason':'unsupported-path-segments','unsupportedSegments':unsupported,'segments':segment_evidence,'topologyEvidence':topology_evidence}}
    if not e.get('_measureStyle',True):return {'key':e['key'],'accepted':True,'geometry':geometry,'evidence':{'p95':round(p95,4),'support':round(support,4),'topology':topology,'topologyEvidence':topology_evidence,'segments':segment_evidence,'horizontalSegments':snapped,'horizontalThresholdDegrees':HORIZONTAL_SNAP_DEGREES}}
    measured_width=float(np.median(widths[valid]));spread=float(np.median(abs(widths[valid]-measured_width)))
    style={};confidence=support*max(0,1-p95/6)
    if detected_dash and e.get('dashType','solid')=='solid':style['dashType']=detected_dash
    if .4<=measured_width<=8 and spread<max(.6,measured_width*.25):style['strokeWidth']=round(measured_width,3)
    for side,tip,inward in [('begin',points[0],points[1]-points[0]),('end',points[-1],points[-2]-points[-1])]:
        measured=geometry['linePath'].get('terminals',{}).get(side)
        if measured and (geometry.get(side+'ArrowType') or e.get(side+'ArrowType'))=='oval':
            style.setdefault('terminals',{})[side]={'type':'oval','status':'measured','diameter':measured['diameter'],'source':'preview-topology'};continue
        inward/=max(1e-6,np.linalg.norm(inward));marker,info=terminal(ref,bg,tip,inward,measured_width,e.get(side+'ArrowType'),hidden)
        if marker:style[side+'ArrowSize']=marker
        style.setdefault('terminals',{})[side]=info
    fade={'status':'unobservable','reason':'lower-composite-unavailable'}
    if bg is not None:
        center=points[:,None,:];lower=remap(bg,center)[:,0,:];tangent=np.gradient(points,axis=0);tangent/=np.maximum(1e-6,np.linalg.norm(tangent,axis=1))[:,None]
        normal=np.column_stack([-tangent[:,1],tangent[:,0]])
        outer=np.concatenate([remap(ref,(points+normal*12)[:,None,:])-remap(bg,(points+normal*12)[:,None,:]),remap(ref,(points-normal*12)[:,None,:])-remap(bg,(points-normal*12)[:,None,:])])
        mismatch=float(np.sqrt(np.mean(outer**2)))
        if mismatch<4:
            active_width=widths[valid]
            taper=float(np.percentile(active_width,90)-np.percentile(active_width,10))>max(1.2,measured_width*.45)
            if taper or detected_dash or e.get('dashType','solid')!='solid':
                alpha_paint=None;fade={'status':'unobservable','reason':'taper-or-dash-not-alpha-fade'}
            else:alpha_paint,fade=fade_profile(e,points,colors,lower,valid)
            if alpha_paint:style['strokeGradient']=alpha_paint
            elif fade['status']=='absent' or fade.get('reason')=='colour-change-not-alpha-fade':
                detail={};paint=fit_native_paint(colors[valid],points[valid,0],points[valid,1],{**e,'fillOpacity':e.get('colorOpacity',1)},e.get('strokeGradient') or e.get('gradient') or e.get('color'),background=lower[valid],diagnostics=detail)
                if paint and paint.get('gradient',{}).get('type')=='linear':style['strokeGradient']=paint['gradient']
        else:fade={'status':'unobservable','reason':'lower-composite-mismatch','rmse':mismatch}
    if fade['status']=='absent' and (e.get('opacity',1)*e.get('colorOpacity',1))>=.98 and np.max(np.percentile(colors[valid],90,axis=0)-np.percentile(colors[valid],10,axis=0))<14:
        style['color']=''.join(f'{int(round(v)):02X}' for v in np.median(colors[valid],axis=0))
    terminal_evidence=style.pop('terminals')
    style['parameterEvidence']={p:{'confidence':round(confidence,4),'independent':True,'source':'joint-path-profile'} for p in ['strokeWidth','strokeColor'] if ('color' if p=='strokeColor' else p) in style or p=='strokeColor' and 'strokeGradient' in style}
    if parameter_blocked(e,'strokeWidth'):style.pop('strokeWidth',None);style['parameterEvidence'].pop('strokeWidth',None)
    if parameter_blocked(e,'strokeColor') or 'stroke' in e.get('keepParameters',[]):
        style.pop('color',None);style.pop('strokeGradient',None);style['parameterEvidence'].pop('strokeColor',None)
    for field in ('beginArrowSize','endArrowSize','dashType'):
        if field in e.get('keepParameters',[]):style.pop(field,None)
    return {'key':e['key'],'accepted':True,'geometry':geometry,'style':style,
        'evidence':{'p95':round(p95,4),'support':round(support,4),'topology':topology,'segments':segment_evidence,'terminals':terminal_evidence,'fade':fade,'dash':detected_dash,'widthSpread':round(spread,4)}}


def main():
    spec=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'));ref=cv2.resize(cv2.imread(spec['reference']),(1600,900))[:,:,::-1].astype(float)
    bg=cv2.imread(spec.get('background','')) if spec.get('background') else None
    if bg is not None:bg=cv2.resize(bg,(1600,900))[:,:,::-1].astype(float)
    hidden=np.zeros((900,1600),bool);masks={};scene_types={e['key']:e.get('type') for e in spec.get('scene',spec['elements'])}
    for m in spec.get('objectMasks',[]):
        if not m.get('file'):continue
        im=cv2.imread(m['file'],cv2.IMREAD_UNCHANGED)
        if im is not None and im.ndim==3 and im.shape[2]==4:
            masks[m['key']]=cv2.resize(im[:,:,3],(1600,900))>24
            if scene_types.get(m['key']) in ('text','formula','image','svg'):hidden |= masks[m['key']]
    results=[];scene=spec.get('scene') or spec['elements'];slants=[]
    axis_seeds={}
    if spec.get('operation') not in ('style','finalize'):
        try:axis_seeds=locate_axis_lines(spec['elements'],ref,hidden)
        except Exception:axis_seeds={}
    if spec.get('operation')=='finalize':
        from path_slant_consensus import merge
        boundary_masks=hidden
        if 'occluders' in spec:
            boundary_masks={}
            for element in scene:
                blocked=np.zeros((900,1600),bool)
                for key in spec['occluders'].get(element['key'],[]):
                    if key in masks:blocked |= masks[key]
                boundary_masks[element['key']]=blocked
        scene,slants=merge(scene,ref,boundary_masks,set(spec.get('editableKeys') or []) if spec.get('scoped') else None)
        current={e['key']:e for e in scene}
        # Geometry was already observed once. Consensus validates only changed
        # boundaries; inherited results must not become a second independent fit.
        for e in spec['elements']:
            evidence=dict(current[e['key']].get('pathFitEvidence') or {})
            accepted=bool(evidence.pop('accepted',False))
            for field in ('source','style','styleEvidence','styleAccepted'):evidence.pop(field,None)
            results.append({'key':e['key'],'accepted':accepted,'evidence':evidence})
        Path(sys.argv[2]).write_text(json.dumps({'results':results,'scene':scene,'slantGroups':slants},indent=1),encoding='utf-8')
        print(json.dumps({'paths':len(results),'slantGroups':len(slants)}));return
    for e in spec['elements']:
        if spec.get('operation')=='style':e={**e,'_fixedGeometry':True}
        elif spec.get('operation') in ('fit','finalize'):e={**e,'_measureStyle':False}
        seed=axis_seeds.get(e['key'])
        if seed:e={**e,'_axisSeed':seed}
        lower=cv2.imread((spec.get('underlays') or {}).get(e['key'],'')) if (spec.get('underlays') or {}).get(e['key']) else None
        if lower is not None:lower=cv2.resize(lower,(1600,900))[:,:,::-1].astype(float)
        own_hidden=hidden
        if 'occluders' in spec:
            own_hidden=np.zeros((900,1600),bool)
            for key in spec['occluders'].get(e['key'],[]):
                if key in masks:own_hidden |= masks[key]
        try:r=fit(e,ref,lower if lower is not None else bg,own_hidden)
        except Exception as error:r={'key':e['key'],'accepted':False,'evidence':{'reason':str(error)[:250]}}
        results.append(r)
    Path(sys.argv[2]).write_text(json.dumps({'results':results,'scene':scene,'slantGroups':slants},indent=1),encoding='utf-8');print(json.dumps({'paths':len(results),'accepted':sum(r['accepted'] for r in results)}))


if __name__=='__main__':main()
