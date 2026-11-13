"""Mask-aware S5 line style measurement; S3 alone owns line endpoints."""
import math
import cv2
import numpy as np
from native_line_fit import endpoints,sample
from paint_models import fit_native_paint

SIZE_FACTORS={'sm':2.,'med':3.,'lg':5.}


def bilateral_alpha_fit(xy,positions,alpha,global_alpha):
    """One rising tail, an optional plateau, one falling tail; bounded holdout."""
    peak=int(np.argmax(xy[:,1]))
    if peak<2 or peak>len(xy)-3:return None
    strength=min(xy[peak,1]-xy[0,1],xy[peak,1]-xy[-1,1])/global_alpha
    if strength<.2:return None
    if (np.diff(xy[:peak+1,1])>=-.025).mean()<.85 or (np.diff(xy[peak:,1])<=.025).mean()<.85:return None
    train=np.arange(len(xy))%2==0;hold=~train;choices=[]
    for left in np.arange(.15,.851,.05):
        for right in np.arange(left,.851,.05):
            knots=np.array([0.,left,1.] if right-left<.05 else [0.,left,right,1.])
            matrix=np.column_stack([np.interp(xy[:,0],knots,np.eye(len(knots))[i]) for i in range(len(knots))])
            if np.linalg.matrix_rank(matrix[train])<len(knots):continue
            coef=np.linalg.lstsq(matrix[train],xy[train,1],rcond=None)[0]
            if coef.min()<-.04 or coef.max()>global_alpha*1.08:continue
            if min(coef[1:-1])-max(coef[0],coef[-1])<global_alpha*.3:continue
            if len(coef)==4 and abs(coef[1]-coef[2])>global_alpha*.08:continue
            error=float(np.sqrt(np.mean((matrix[hold]@coef-xy[hold,1])**2)))/global_alpha
            dense_error=float(np.sqrt(np.mean((np.interp(positions,knots,coef)-alpha)**2)))/global_alpha
            if error>.035 or dense_error>.045:continue
            # A spline must explain continuous pixels, not interpolate a hard
            # cut, missing middle segment or noise hidden by median bins.
            choices.append((error+dense_error+len(knots)*.002,knots,coef/global_alpha,error))
    if not choices:return None
    _,knots,values,error=min(choices,key=lambda item:item[0])
    return knots,np.clip(values,0,1),error


def measure_line_style(ref,e,underlay=None,excluded=None):
    evidence={};props={}
    a,b=endpoints(e);length=float(np.linalg.norm(b-a))
    if length<24:return {},{'status':'unobservable','reason':'short-line'}
    direction=(b-a)/length;normal=np.array([-direction[1],direction[0]])
    band=min(32,max(12,float(e.get('strokeWidth') or 1)*3))
    offsets=np.arange(-band,band+.01,.25)
    t=np.linspace(0,length,min(1200,max(80,round(length))))
    points=a+t[:,None,None]*direction+offsets[None,:,None]*normal
    colors=sample(ref,points)
    if underlay is not None:
        background=sample(underlay,points)
        outer=np.abs(offsets)>band-2
        mismatch=float(np.sqrt(np.mean((colors[:,outer]-background[:,outer])**2)))
        known=mismatch<3
    else:
        outside=np.median(np.concatenate((colors[:,:6],colors[:,-6:]),axis=1),axis=1)
        background=np.broadcast_to(outside[:,None,:],colors.shape)
        mismatch=None;known=False
    delta=colors-background;contrast=np.linalg.norm(delta,axis=2)
    station=(t>length*.12)&(t<length*.88)
    if excluded is not None:
        q=np.rint(a+t[:,None]*direction).astype(int)
        inside=(q[:,0]>=0)&(q[:,0]<ref.shape[1])&(q[:,1]>=0)&(q[:,1]<ref.shape[0]);station &= inside
        station[inside] &= ~excluded[q[inside,1],q[inside,0]]
    widths=[];centres=[];peaks=contrast.max(axis=1)
    for index in np.where(station&(peaks>20))[0]:
        values=contrast[index];peak=int(np.argmax(values));threshold=values[peak]*.5
        if abs(offsets[peak])>band*.55:continue
        lo=hi=peak
        while lo>0 and values[lo-1]>=threshold:lo-=1
        while hi+1<len(values) and values[hi+1]>=threshold:hi+=1
        if lo==0 or hi==len(values)-1:continue
        left=offsets[lo]-(values[lo]-threshold)/max(.001,values[lo]-values[lo-1])*.25
        right=offsets[hi]+(values[hi]-threshold)/max(.001,values[hi]-values[hi+1])*.25
        width=right-left
        if .4<=width<=20 and abs((left+right)/2)<=max(2,width*.3):widths.append(width);centres.append((left+right)/2)
    if len(widths)<20:return {},{'status':'unobservable','reason':'insufficient-cross-sections'}
    width=float(np.median(widths));spread=float(np.percentile(np.abs(np.asarray(widths)-width),80))
    evidence['width']={'status':'present' if spread<max(.6,width*.2) else 'unobservable','value':round(width,3),'spread':round(spread,3),'sections':len(widths)}
    if evidence['width']['status']!='present':return {},evidence
    props['strokeWidth']=round(width,3)
    inner=np.abs(offsets-float(np.median(centres)))<=max(.12,width*.2)
    core=np.median(colors[:,inner],axis=1);lower=np.median(background[:,inner],axis=1)
    fade={'status':'unobservable','reason':'lower-composite-unavailable-or-mismatched','backgroundRmse':mismatch}
    raw=str(e.get('color') or '').lstrip('#');global_alpha=float(e.get('opacity',1))*float(e.get('colorOpacity',1))
    if known and len(raw)==6 and global_alpha>.05:
        ink=np.array([int(raw[i:i+2],16) for i in (0,2,4)],float);base=ink-lower
        alpha=np.sum((core-lower)*base,axis=1)/np.maximum(1,np.sum(base*base,axis=1))
        color_error=float(np.sqrt(np.mean((lower+alpha[:,None]*base-core)[station]**2)))
        bins=[]
        for u in np.linspace(.13,.87,15):
            selected=station&(abs(t/length-u)<=.03)
            if selected.sum()>=3:bins.append((float(np.median(t[selected]/length)),float(np.median(alpha[selected]))))
        if len(bins)>=10 and color_error<3:
            xy=np.array(bins);trend=np.polyfit(xy[:,0],xy[:,1],1);drift=float(abs(trend[0]))
            monotonic=float((np.diff(xy[:,1])*np.sign(trend[0])>=-.035).mean())
            error=float(np.sqrt(np.mean((np.polyval(trend,xy[:,0])-xy[:,1])**2)))
            fade={'status':'absent','colorRmse':round(color_error,3),'alphaDelta':round(drift,3),'monotonic':round(monotonic,3)}
            knots=np.array([0.,1.]);values=np.polyval(trend,knots)/global_alpha
            # A plateau followed by a fade needs an interior alpha stop. Select
            # a small monotone spline with independent station holdout, avoiding
            # arbitrary per-pixel stops or fitting through a missing segment.
            if error>=.025 and monotonic>.85:
                train=np.arange(len(xy))%2==0;hold=~train;choices=[]
                for trial in ([0.,.25,1.],[0.,.5,1.],[0.,.75,1.],[0.,.25,.75,1.]):
                    matrix=np.column_stack([np.interp(xy[:,0],trial,np.eye(len(trial))[i]) for i in range(len(trial))])
                    coef=np.linalg.lstsq(matrix[train],xy[train,1],rcond=None)[0]
                    if np.any(np.diff(coef)*np.sign(trend[0])<-.025) or coef.min()<-.04 or coef.max()>global_alpha*1.08:continue
                    score=float(np.sqrt(np.mean((matrix[hold]@coef-xy[hold,1])**2)))
                    choices.append((score+len(trial)*.002,score,np.array(trial),coef/global_alpha))
                if choices:
                    _,new_error,new_knots,new_values=min(choices,key=lambda row:row[0])
                    if new_error<error*.75:error,knots,values=new_error,new_knots,new_values
            if drift>.3 and monotonic>.85 and error<.045 and xy[:,1].min()>-.03 and xy[:,1].max()<global_alpha*1.08:
                values=np.clip(values,0,1)
                angle=math.degrees(math.atan2(direction[1],direction[0]))%360
                # Same physical gradient field for either semantic line direction.
                if angle>=180:angle-=180;knots=1-knots[::-1];values=values[::-1]
                props['strokeGradient']={'type':'linear','angle':round(angle,4),'stops':[
                    {'position':round(float(u),4),'color':raw.upper(),'opacity':round(float(v),4)} for u,v in zip(knots,values)]}
                fade.update(status='present',method='constant-ink-alpha-against-lower-composite',alphaRmse=round(error,4))
            elif drift>.3:fade.update(status='unobservable',reason='gap-texture-or-nonlinear-tail')
            if fade['status']!='present':
                bilateral=bilateral_alpha_fit(xy,t[station]/length,alpha[station],global_alpha)
                if bilateral:
                    knots,values,error=bilateral
                    angle=math.degrees(math.atan2(direction[1],direction[0]))%360
                    if angle>=180:angle-=180;knots=1-knots[::-1];values=values[::-1]
                    props['strokeGradient']={'type':'linear','angle':round(angle,4),'stops':[
                        {'position':round(float(u),4),'color':raw.upper(),'opacity':round(float(v),4)} for u,v in zip(knots,values)]}
                    fade.update(status='present',shape='bilateral',method='unimodal-alpha-with-station-holdout',alphaRmse=round(error,4))
                    fade.pop('reason',None)
                elif min(xy[len(xy)//2,1]-xy[0,1],xy[len(xy)//2,1]-xy[-1,1])>global_alpha*.2:
                    fade.update(status='unobservable',reason='bilateral-tail-not-supported')
        elif color_error>=3:fade={'status':'unobservable','reason':'colour-change-not-alpha-fade','colorRmse':round(color_error,3)}
    evidence['fade']=fade
    if (fade['status']=='absent' or fade.get('reason')=='colour-change-not-alpha-fade') and len(core[station])>30:
        # Solid/colour-gradient fits share the line's real centre samples. Avoid
        # interpreting a non-identifiable alpha tail as opaque background ink.
        pixels=core[station];coordinates=(a+t[:,None]*direction)[station]
        if np.mean(np.std(pixels,axis=0))<4 and global_alpha>=.98:
            solid=''.join(f'{v:02X}' for v in np.round(np.median(pixels,axis=0)).astype(int))
            props.update(color=solid,strokeGradient={'type':'linear','angle':0,'stops':[
                {'position':i,'color':solid,'opacity':1} for i in (0,1)]} if e.get('gradient') else None)
        else:
            detail={};fit=fit_native_paint(pixels,coordinates[:,0],coordinates[:,1],{**e,'fillOpacity':e.get('colorOpacity',1)},e.get('strokeGradient') or e.get('gradient') or e.get('color'),background=lower[station] if known else None,diagnostics=detail)
            if fit and fit['gradient']['type']=='linear':props['strokeGradient']=fit['gradient']
            evidence['paint']=detail
    for side,tip,inward in [('begin',a,direction),('end',b,-direction)]:
        kind=e.get(side+'ArrowType')
        if kind in (None,'none'):continue
        if underlay is None:evidence[side]={'status':'unobservable','reason':'lower-composite-unavailable'};continue
        extent=min(80,max(12,width*7));u=np.arange(-extent,extent+.01,.5);uu,vv=np.meshgrid(u,u)
        grid=tip+uu[:,:,None]*inward+vv[:,:,None]*normal
        if grid[:,:,0].min()<0 or grid[:,:,0].max()>=ref.shape[1] or grid[:,:,1].min()<0 or grid[:,:,1].max()>=ref.shape[0]:
            evidence[side]={'status':'unobservable','reason':'terminal-clipped'};continue
        signal=np.linalg.norm(sample(ref,grid)-sample(underlay,grid),axis=2)
        hit=signal>max(15,float(np.percentile(signal,99))*.45)
        if excluded is not None:
            q=np.rint(grid).astype(int);valid=(q[:,:,0]>=0)&(q[:,:,0]<ref.shape[1])&(q[:,:,1]>=0)&(q[:,:,1]<ref.shape[0])
            if (excluded[q[:,:,1][valid],q[:,:,0][valid]]&hit[valid]).any():evidence[side]={'status':'unobservable','reason':'terminal-occluded'};continue
        _,labels,_,_=cv2.connectedComponentsWithStats(hit.astype(np.uint8),8)
        c=round(extent/.5);label=labels[c,c]
        if not label:
            nearby=labels[max(0,c-2):c+3,max(0,c-2):c+3];candidates=nearby[nearby>0]
            if not len(candidates):evidence[side]={'status':'unobservable','reason':'terminal-not-visible'};continue
            label=int(np.bincount(candidates).argmax())
        hit &= labels==label;wings=hit&(abs(vv)>width*.65)
        if wings.sum()<12:evidence[side]={'status':'unobservable','reason':'no-independent-terminal-wings'};continue
        measured_width=float(np.ptp(vv[hit])+.5);measured_length=float(np.ptp(uu[wings])+.5)
        # Circle length comes from diameter; shaft occlusion removes a cap at
        # its centre. For triangles extrapolate the measured sides to the tip.
        if kind=='oval':measured_length/=math.sqrt(max(.1,1-(width*1.3/max(1,measured_width))**2))
        elif kind in ('triangle','stealth','arrow'):measured_length+=width*.65
        ws=min(SIZE_FACTORS,key=lambda k:abs(math.log(max(.1,measured_width/width)/SIZE_FACTORS[k])))
        ls=min(SIZE_FACTORS,key=lambda k:abs(math.log(max(.1,measured_length/width)/SIZE_FACTORS[k])))
        props[side+'ArrowSize']={'width':ws,'length':ls}
        evidence[side]={'status':'present','kind':kind,'width':round(measured_width,2),'length':round(measured_length,2),'nativeSize':props[side+'ArrowSize'],'quantized':True}
    props['linePaintEvidence']=evidence
    return props,evidence
