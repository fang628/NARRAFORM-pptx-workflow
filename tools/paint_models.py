"""Native paint fitting; DrawingML coordinates calibrated against PowerPoint."""
import cv2
import numpy as np
VERSION=5

def _stop_alpha(paint):
    """Stop positions/opacities of a gradient paint; None when absent or opaque."""
    if not isinstance(paint,dict):return None
    stops=paint.get('stops')
    if not isinstance(stops,list) or len(stops)<2:return None
    try:
        positions=np.array([float(stop['position']) for stop in stops],float)
        opacities=np.array([float(stop.get('opacity',1)) for stop in stops],float)
    except (KeyError,TypeError,ValueError):return None
    if not np.all(np.isfinite(positions)) or not np.all(np.isfinite(opacities)):return None
    if np.any(np.diff(positions)<0) or np.any(opacities<0) or np.any(opacities>1):return None
    return positions,opacities

def _unique_sorted(values,tol=1e-4):
    out=[]
    for value in sorted(float(v) for v in values):
        if not out or abs(value-out[-1])>tol:out.append(value)
    return out

def _merged_stops(best,alpha_positions,limit=10):
    """Fitted colour stops that also keep every original alpha breakpoint.

    PowerPoint interpolates stop opacity linearly between stops, so the source
    alpha curve is preserved exactly only when its breakpoints stay in the list.
    RGB is sampled from the fitted piecewise-linear colour model at the merged
    positions, which keeps the fitted colour function unchanged.
    """
    knots=np.asarray(best['knots'],float);colors=np.asarray(best['colors'],float)
    breaks=_unique_sorted([p for p in np.asarray(alpha_positions,float) if 0<=p<=1])[:limit]
    if len(breaks)<2:breaks=_unique_sorted(breaks+[0.,1.])[:limit]
    merged=_unique_sorted(list(knots)+breaks)
    if len(merged)>limit:
        combined=list(breaks)
        for knot in knots:
            if len(combined)>=limit:break
            if not any(abs(float(knot)-b)<1e-4 for b in combined):combined.append(float(knot))
        merged=_unique_sorted(combined)[:limit]
    merged=np.array(merged,float)
    rgb=np.stack([np.interp(merged,knots,colors[:,i]) for i in range(3)],1)
    return merged,np.clip(rgb,0,255)

def paint_coordinate(kind,xx,yy,element,angle=0,center=(.5,.5)):
    w,h=max(.01,element['w']),max(.01,element['h']);u=(xx-element['x'])/w;v=(yy-element['y'])/h
    if kind=='linear':
        dx,dy=np.cos(np.deg2rad(angle)),np.sin(np.deg2rad(angle));span=max(1e-6,abs(w*dx)+abs(h*dy))
        return np.clip(.5+((u-.5)*w*dx+(v-.5)*h*dy)/span,0,1)
    cx,cy=center
    if kind=='rectangular':
        return np.clip(np.maximum(abs(u-cx)/np.maximum(1e-6,np.where(u<cx,cx,1-cx)),abs(v-cy)/np.maximum(1e-6,np.where(v<cy,cy,1-cy))),0,1)
    # DrawingML circle: physical circumscribed circle, fillToRect is the focus.
    dx,dy=(u-cx)*w,(v-cy)*h;fx,fy=(cx-.5)*w,(cy-.5)*h
    den=max(1e-6,(w*w+h*h)/4-fx*fx-fy*fy);dot=fx*dx+fy*dy
    return np.clip((dot+np.sqrt(np.maximum(0,dot*dot+den*(dx*dx+dy*dy))))/den,0,1)

def predict_paint(paint,xx,yy,element,background=None):
    try:
        if not isinstance(paint,dict):
            value=str(paint).lstrip('#');return np.broadcast_to([int(value[i:i+2],16) for i in (0,2,4)],(len(xx),3)).astype(float)
        if paint.get('type') not in ('linear','radial','rectangular'):return None
        t=paint_coordinate(paint['type'],xx,yy,element,paint.get('angle',0),(paint.get('center',{}).get('x',.5),paint.get('center',{}).get('y',.5)))
        stops=paint['stops'];positions=[s['position'] for s in stops];colors=np.array([[int(s['color'].lstrip('#')[i:i+2],16) for i in (0,2,4)] for s in stops])
        rgb=np.stack([np.interp(t,positions,colors[:,i]) for i in range(3)],1);alpha=np.interp(t,positions,[s.get('opacity',1) for s in stops])
        if np.min(alpha)<.98:
            if background is None:return None
            rgb=rgb*alpha[:,None]+background*(1-alpha[:,None])
        return rgb
    except (KeyError,ValueError,TypeError,IndexError):return None

def _spline(t,knots):return np.stack([np.interp(t,knots,np.eye(len(knots))[i]) for i in range(len(knots))],1)


def composite_paint(paint,xx,yy,element,background):
    """Evaluate a known native fill, including both opacity levels once."""
    opaque={**paint,'stops':[{**s,'opacity':1} for s in paint['stops']]} if isinstance(paint,dict) else paint
    rgb=predict_paint(opaque,xx,yy,element)
    if rgb is None:return None
    alpha=np.full(len(xx),float(element.get('opacity',1))*float(element.get('fillOpacity',1)))
    if isinstance(paint,dict):
        t=paint_coordinate(paint['type'],xx,yy,element,paint.get('angle',0),(paint.get('center',{}).get('x',.5),paint.get('center',{}).get('y',.5)))
        alpha*=np.interp(t,[s['position'] for s in paint['stops']],[s.get('opacity',1) for s in paint['stops']])
    if np.min(alpha)<.98 and background is None:return None
    return rgb if background is None else alpha[:,None]*rgb+(1-alpha[:,None])*background

def spatial_samples(pixels,xx,yy,cell=10,background=None):
    ids=(yy.astype(int)//cell)*100000+(xx.astype(int)//cell);order=np.argsort(ids);_,starts=np.unique(ids[order],return_index=True);out=[];bg=[]
    for g in np.split(order,starts[1:]):
        # Keep sparse cells too: dropping them removes thin strokes and can
        # collapse a valid oblique grid below the minimum sample count.
        if len(g):
            out.append((np.median(pixels[g],axis=0),np.median(xx[g]),np.median(yy[g])))
            if background is not None:bg.append(np.median(background[g],axis=0))
    if len(out)<60:return (pixels,xx,yy,background) if background is not None else (pixels,xx,yy)
    pixels=np.array([v[0] for v in out]);xx=np.array([v[1] for v in out]);yy=np.array([v[2] for v in out])
    if background is None:return pixels,xx,yy
    # Background is aggregated over the exact same cells/order as the pixels.
    return pixels,xx,yy,np.array(bg)

def perceptual_error(a,b):
    a=cv2.cvtColor(np.clip(a,0,255).astype(np.float32).reshape(1,-1,3)/255,cv2.COLOR_RGB2LAB)[0]
    b=cv2.cvtColor(np.clip(b,0,255).astype(np.float32).reshape(1,-1,3)/255,cv2.COLOR_RGB2LAB)[0]
    return float(np.median(np.linalg.norm(a-b,axis=1)))

def validate_shared_paint(pixels,xx,yy,element,prototype):
    if float(element.get('opacity',1))*float(element.get('fillOpacity',1))<.98:return None
    # A translucent prototype/current needs the fitted background to de-mix; sharing
    # has no such evidence here, so it stays conservative and never shares.
    for paint in (element.get('gradient') or element.get('fill'),prototype):
        stops=_stop_alpha(paint)
        if stops is not None and float(np.min(stops[1]))<.98:return None
    baseline=predict_paint(element.get('gradient') or element.get('fill'),xx,yy,element);predicted=predict_paint(prototype,xx,yy,element)
    if baseline is None or predicted is None:return None
    before=float(np.mean(abs(baseline-pixels)));residual=np.mean(abs(predicted-pixels),axis=1);after=float(residual.mean());robust=float(np.sort(residual)[:max(1,int(len(residual)*.7))].mean());coverage=float((residual<16).mean())
    if before-after>=6 and robust<6 and coverage>=.65:return {'beforeError':round(before,3),'afterError':round(after,3),'robustError':round(robust,3),'confidence':round(coverage,3)}
    return None

def fit_native_paint(pixels,xx,yy,element,current,diagnostics=None,background=None):
    def reject(reason,**details):
        if diagnostics is not None:diagnostics.update(status='rejected',reason=reason,**details)
        return None
    if len(pixels)<80:return reject('insufficient-visible-samples',samples=len(pixels))
    alpha_stops=_stop_alpha(current)
    transparent=alpha_stops is not None and float(np.min(alpha_stops[1]))<.98
    global_alpha=float(element.get('fillOpacity',1))*float(element.get('opacity',1))
    if transparent or global_alpha<.98:
        # No background means the composite cannot be de-mixed; never guess.
        if background is None:return reject('background-required-for-alpha')
        if global_alpha<.15:return reject('opacity-not-identifiable')
    pixels=pixels.astype(float)
    if background is not None:
        background=np.asarray(background,float)
        pixels,xx,yy,background=spatial_samples(pixels,xx,yy,background=background)
    else:pixels,xx,yy=spatial_samples(pixels,xx,yy)
    step=max(1,len(pixels)//1400);pixels,xx,yy=pixels[::step],xx[::step],yy[::step]
    if background is not None:background=background[::step]
    # Solve in the observed composite domain. Do not clamp a de-mixed target:
    # clipping silently flattens bright/dark endpoints and changes the best angle.
    composited=transparent or global_alpha<.98
    observed=pixels
    def effective_alpha(t):
        stop=np.interp(t,alpha_stops[0],alpha_stops[1]) if transparent else np.ones(len(t))
        return np.clip(global_alpha*stop,0,1)
    opaque_current={**current,'stops':[{**stop,'opacity':1} for stop in current.get('stops',[])]} if isinstance(current,dict) else current
    baseline_colors=predict_paint(opaque_current,xx,yy,element)
    if baseline_colors is None:return reject('unsupported-current-paint')
    if composited:
        initial_t=paint_coordinate(current['type'],xx,yy,element,current.get('angle',0),(current.get('center',{}).get('x',.5),current.get('center',{}).get('y',.5))) if isinstance(current,dict) else np.zeros(len(xx))
        initial_alpha=effective_alpha(initial_t)
        if np.count_nonzero(initial_alpha>=.15)<max(80,int(.35*len(initial_alpha))):return reject('opacity-not-identifiable')
        baseline=initial_alpha[:,None]*baseline_colors+(1-initial_alpha[:,None])*background
    else:baseline=baseline_colors
    before=float(np.mean(abs(baseline-observed)))
    variance=float(np.mean((observed-observed.mean(0))**2))
    if before<2:return reject('already-close',beforeError=round(before,3))
    if variance<12:return reject('uniform-fill-use-solid-model')
    if max(np.ptp(xx)/max(1,element['w']),np.ptp(yy)/max(1,element['h']))<.35:return reject('insufficient-spatial-coverage')
    train=np.arange(len(observed))%5!=0;test=~train;candidates=[]
    def evaluate(kind,angle=0,center=(.5,.5),knots=None):
        t=np.asarray(paint_coordinate(kind,xx,yy,element,angle,center),float)
        if np.ptp(t)<.24:return None
        knots=np.array([0.,1.] if knots is None else knots);matrix=_spline(t,knots)
        if np.linalg.matrix_rank(matrix[train])<len(knots):return None
        effective=effective_alpha(t) if composited else np.ones(len(t))
        design=matrix*effective[:,None]
        offset=(1-effective[:,None])*background if composited else np.zeros_like(observed)
        target=observed-offset
        coef=np.linalg.lstsq(design[train],target[train],rcond=None)[0]
        for _ in range(4):
            residual=np.mean(abs(design[train]@coef-target[train]),axis=1);scale=max(2,float(np.median(residual))*1.5);weights=np.minimum(1,scale/np.maximum(.1,residual))**2
            coef=np.linalg.lstsq(design[train]*weights[:,None],target[train]*weights[:,None],rcond=None)[0]
        if coef.min() < -18 or coef.max()>273:return None
        colors=np.clip(coef,0,255);raw=matrix@colors
        # Error evaluation always happens against the observed composite.
        predicted=effective[:,None]*raw+offset
        res=np.mean(abs(predicted-observed),axis=1)
        error=float(np.mean(res[test]));robust=float(np.mean(np.sort(res[test])[:max(1,int(test.sum()*.85))]));r2=1-float(np.mean((predicted[test]-observed[test])**2))/max(1,variance)
        item=dict(kind=kind,angle=angle,center=center,colors=colors,knots=knots,error=error,robust=robust,r2=r2,score=robust*.65+error*.35+.5*(len(knots)-2)+(0 if kind=='linear' else .25),predicted=predicted,t=t)
        candidates.append(item);return item
    def coarse(kind,angle=0,center=(.5,.5)):
        options=[[0.,1.],[0.,.3,1.],[0.,.5,1.],[0.,.7,1.],[0.,.25,.5,.75,1.]]
        if isinstance(current,dict):options.append([s['position'] for s in current['stops']])
        for knots in options:evaluate(kind,angle,center,knots)
    def geometry_seeds(paint_kind,limit=3):
        seeds=[]
        for c in sorted((c for c in candidates if c['kind']==paint_kind),key=lambda c:c['score']):
            if paint_kind=='linear':
                close=lambda s:min(abs(c['angle']-s['angle'])%angle_period,angle_period-abs(c['angle']-s['angle'])%angle_period)<20
            else:close=lambda s:np.linalg.norm(np.asarray(c['center'])-s['center'])<.15
            if any(close(s) for s in seeds):continue
            seeds.append(c)
            if len(seeds)>=limit:break
        return seeds
    # Alpha breakpoints remain the same function of the candidate coordinate.
    # Candidate geometry is evidence-driven, not locked to the model's guess.
    angle_period=360 if transparent else 180
    for angle in range(0,angle_period,15):coarse('linear',angle)
    for paint_kind in ('radial','rectangular'):
        for x in (.05,.3,.5,.7,.95):
            for y in (.05,.3,.5,.7,.95):coarse(paint_kind,center=(x,y))
    if isinstance(current,dict):evaluate(current['type'],current.get('angle',0),(current.get('center',{}).get('x',.5),current.get('center',{}).get('y',.5)),[s['position'] for s in current.get('stops',[])])
    if not candidates:return reject('no-supported-paint-model')
    # Retain several direction/focus hypotheses: an early coarse winner can be
    # a reversed or displaced approximate solution with compensating colours.
    for first in [seed for kind in ('linear','radial','rectangular') for seed in geometry_seeds(kind)]:
        paint_kind=first['kind']
        if paint_kind=='linear':
            for a in np.arange(first['angle']-12,first['angle']+13,3):evaluate(paint_kind,float(a)%angle_period,knots=first['knots'])
        else:
            for dx in (-.1,-.05,0,.05,.1):
                for dy in (-.1,-.05,0,.05,.1):
                    trial=(first['center'][0]+dx,first['center'][1]+dy)
                    if min(trial)>=.01 and max(trial)<=.99:evaluate(paint_kind,center=trial,knots=first['knots'])
    # Greedy non-uniform stops restore broad light bands, not texture.
    seeds=[min([c for c in candidates if c['kind']==paint_kind],key=lambda c:c['score']) for paint_kind in ('linear','radial','rectangular') if any(c['kind']==paint_kind for c in candidates)]
    seeds+=[min([c for c in candidates if c['kind']==paint_kind and len(c['knots'])==count],key=lambda c:c['score']) for paint_kind in ('linear','radial','rectangular') for count in (2,3) if any(c['kind']==paint_kind and len(c['knots'])==count for c in candidates)]
    seeds+=sorted(candidates,key=lambda c:c['score'])[:2]
    for seed in seeds:
        knots=list(seed['knots']);best=seed
        for _ in range(max(0,5-len(knots))):
            choices=[]
            for t in np.arange(.1,.91,.1):
                if min(abs(t-np.array(knots)))<.06:continue
                q=evaluate(seed['kind'],seed['angle'],seed['center'],sorted(knots+[float(t)]))
                if q:choices.append(q)
            if not choices:break
            q=min(choices,key=lambda c:c['score'])
            if q['score']>=best['score']-.15:break
            best=q;knots=list(q['knots'])
        for i in range(1,len(knots)-1):
            for delta in np.arange(-.15,.151,.025):
                trial=knots.copy();trial[i]+=delta
                if trial[i-1]+.025<trial[i]<trial[i+1]-.025:
                    q=evaluate(seed['kind'],seed['angle'],seed['center'],trial)
                    if q and q['score']<best['score']:best=q;knots=trial
    for seed in [seed for kind in ('linear','radial','rectangular') for seed in geometry_seeds(kind,2)]:
        if seed['kind']=='linear':
            for a in np.arange(seed['angle']-2,seed['angle']+2.1,.5):evaluate('linear',float(a)%angle_period,knots=seed['knots'])
        else:
            for dx in (-.03,-.01,0,.01,.03):
                for dy in (-.03,-.01,0,.01,.03):
                    trial=(seed['center'][0]+dx,seed['center'][1]+dy)
                    if min(trial)>=.01 and max(trial)<=.99:evaluate(seed['kind'],center=trial,knots=seed['knots'])
    best=min(candidates,key=lambda c:c['score'])
    if transparent:
        # Re-evaluate the exported model after merging the original alpha
        # breakpoints so the reported error matches the written stops exactly.
        merged_knots,merged_colors=_merged_stops(best,alpha_stops[0])
        t=best['t'];merged_rgb=np.stack([np.interp(t,merged_knots,merged_colors[:,i]) for i in range(3)],1)
        effective=effective_alpha(t)
        predicted=effective[:,None]*merged_rgb+(1-effective[:,None])*background
        res=np.mean(abs(predicted-observed),axis=1)
        best=dict(best,knots=merged_knots,colors=merged_colors,predicted=predicted,error=float(np.mean(res[test])),robust=float(np.mean(np.sort(res[test])[:max(1,int(test.sum()*.85))])),r2=1-float(np.mean((predicted[test]-observed[test])**2))/max(1,variance))
    after=best['error'];coverage=float((np.mean(abs(best['predicted']-observed),axis=1)<=12).mean());improved=before-after>=max(2,before*.18)
    # A coherent majority may identify the base while disconnected highlights,
    # remaining glyphs/icons form a separate effect layer. Verify support across
    # quadrants; this is not permission to fit arbitrary texture/noisy pixels.
    inliers=np.mean(abs(best['predicted']-observed),axis=1)<=12
    quadrants=(xx>=np.median(xx)).astype(int)+2*(yy>=np.median(yy)).astype(int)
    distributed=all(np.mean(inliers[quadrants==i])>=.5 for i in range(4) if np.sum(quadrants==i)>=8)
    base_only=improved and coverage>=.7 and best['robust']<=5.5 and distributed and before-best['robust']>=6
    if not improved or (best['robust']>7 or after>12 or coverage<.78) and not base_only:
        return reject('residual-or-improvement',beforeError=round(before,3),afterError=round(after,3),robustError=round(best['robust'],3),coverage=round(coverage,3),r2=round(best['r2'],4))
    if transparent:
        # Preserve the original stop-alpha profile at the fitted stop positions;
        # global opacity stays on the element and is never baked into stops.
        alpha_knots=np.clip(np.interp(best['knots'],alpha_stops[0],alpha_stops[1]),0,1)
        stops=[{'position':round(float(t),4),'color':''.join(f'{int(round(c)):02X}' for c in color),'opacity':round(float(a),4)} for t,color,a in zip(best['knots'],best['colors'],alpha_knots)]
        gradient={'type':best['kind'],'stops':stops}
        if best['kind']=='linear':gradient['angle']=round(float(best['angle']),3)
        else:gradient['center']={'x':round(float(best['center'][0]),4),'y':round(float(best['center'][1]),4)}
    else:
        stops=[{'position':round(float(t),4),'color':''.join(f'{int(round(c)):02X}' for c in color),'opacity':1} for t,color in zip(best['knots'],best['colors'])]
        gradient={'type':best['kind'],'stops':stops}
        if gradient['type']=='linear':gradient['angle']=round(float(best['angle']),3)
        else:gradient['center']={'x':round(float(best['center'][0]),4),'y':round(float(best['center'][1]),4)}
    result={'gradient':gradient,'beforeError':round(before,3),'afterError':round(after,3),'r2':round(best['r2'],4),'confidence':round(coverage,3),'robustError':round(best['robust'],3),'scope':'base-fill' if base_only and (after>12 or coverage<.78) else 'full-fill','unexplainedFraction':round(1-coverage,3),'deltaE':round(perceptual_error(best['predicted'][test],observed[test]),3),'accepted':True,'alphaPreserved':transparent,'globalAlpha':round(global_alpha,4),'method':'powerpoint-calibrated-spatial-IRLS-adaptive-stops'+('-alpha-preserved' if transparent else ''),'samples':len(observed)}
    if diagnostics is not None:diagnostics.update(status='accepted',**result)
    return result
