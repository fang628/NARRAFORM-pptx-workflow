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


def fit(e,ref,bg,hidden):
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
