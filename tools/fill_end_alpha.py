"""One additional alpha-only fit for surfaces with a measured fill termination."""
import math
import cv2
import numpy as np
from paint_models import predict_paint,composite_paint,paint_coordinate,spatial_holdout
from shape_reference import seed_polygon
from parameter_confidence import parameter_blocked

def alpha_fit(pixels,bg,ink,t,current,global_alpha,xx=None,yy=None):
    contrast=ink-bg;den=np.sum(contrast*contrast,axis=1)
    eligible=den>64
    if eligible.sum()<40:return None,{'status':'unobservable','reason':'colour-alpha-ambiguous'}
    raw_alpha=np.sum((pixels-bg)*contrast,axis=1)/np.maximum(den,1)/max(.01,global_alpha)
    mixture=bg+contrast*np.clip(raw_alpha*global_alpha,0,1)[:,None]
    colour_residual=np.mean(np.abs(mixture-pixels),axis=1)
    eligible &= (colour_residual<12)&(raw_alpha>-.15)&(raw_alpha<1.25)
    if eligible.sum()<40:return None,{'status':'unobservable','reason':'alpha-mixture-not-supported'}
    alpha=np.clip(raw_alpha,0,1)
    knots=np.array([0.,.5,1.]);basis=np.column_stack([np.interp(t,knots,np.eye(3)[i]) for i in range(3)])
    # Hold out whole coordinate strips rather than alternating adjacent pixels.
    if xx is not None and yy is not None:
        fitted_train,fitted_test,_=spatial_holdout(xx[eligible],yy[eligible])
        test=np.zeros(len(t),bool);test[np.flatnonzero(eligible)[fitted_test]]=True
    else:test=eligible&((np.floor(np.clip(t,0,.999)*24).astype(int)%3)==1)
    train=eligible&~test
    if test.sum()<12 or np.ptp(t[train])<.55 or np.ptp(t[test])<.5:return None,{'status':'unobservable','reason':'alpha-spatial-coverage'}
    weights=np.sqrt(den[train]);coef=np.linalg.lstsq(basis[train]*weights[:,None],alpha[train]*weights,rcond=None)[0]
    for _ in range(4):
        residual=np.abs(basis[train]@coef-alpha[train]);robust=np.minimum(1,.12/np.maximum(.01,residual))
        weights=np.sqrt(den[train])*robust
        coef=np.linalg.lstsq(basis[train]*weights[:,None],alpha[train]*weights,rcond=None)[0]
    coef=np.clip(coef,0,1);fitted=np.clip(basis@coef,0,1)*global_alpha
    prediction=bg+(ink-bg)*fitted[:,None]
    before=float(np.mean(np.abs(current[test]-pixels[test])));errors=np.mean(np.abs(prediction[test]-pixels[test]),axis=1);after=float(np.mean(errors))
    robust_error=float(np.mean(np.sort(errors)[:max(1,int(len(errors)*.8))]));coverage=float(np.mean(errors<12))
    if (after>8 and (after>14 or robust_error>7 or coverage<.7)) or after>before-.25:return None,{'status':'kept','reason':'alpha-no-supported-improvement','beforeError':round(before,3),'afterError':round(after,3),'robustError':round(robust_error,3),'coverage':round(coverage,3)}
    return (knots,coef),{'status':'accepted','beforeError':round(before,3),'afterError':round(after,3),'confidence':round(max(.55,1-after/20),4),'samples':int(eligible.sum()),'independent':True}

def fit_fill_end_alpha(reference,element,lower,front=None,exclude=()):
    structure=(element.get('geometryEvidence') or {}).get('structure') or {}
    kinds=structure.get('boundaryKinds') or [];points=structure.get('points')
    if 'fill-end' not in kinds:return {},{'status':'not-applicable'}
    if lower is None:return {},{'status':'unobservable','reason':'lower-composite-unavailable'}
    polygon=seed_polygon(element)
    if not polygon or len(polygon)<3 or not points or len(kinds)!=len(polygon):return {},{'status':'unobservable','reason':'fill-end-geometry-unavailable'}
    polygon=np.asarray(polygon,float);edge_index=kinds.index('fill-end')
    edge=polygon[(edge_index+1)%len(polygon)]-polygon[edge_index];normal=np.array([-edge[1],edge[0]])/max(1,np.linalg.norm(edge))
    boundary=np.mean(polygon[[edge_index,(edge_index+1)%len(polygon)]],axis=0);center=polygon.mean(0)
    if np.dot(center-boundary,normal)>0:normal=-normal
    projection=polygon@normal;lo,hi=float(projection.min()),float(projection.max());span=max(1.,hi-lo)
    angle=math.degrees(math.atan2(normal[1],normal[0]))%360
    mask=np.zeros(reference.shape[:2],np.uint8);cv2.fillPoly(mask,[np.rint(polygon).astype(np.int32)],255)
    hidden=np.zeros(mask.shape,bool) if front is None else front>8
    for a,b,c,d in exclude:hidden[max(0,b):min(900,d),max(0,a):min(1600,c)]=True
    yy,xx=np.nonzero((cv2.erode(mask,np.ones((9,9),np.uint8))>0)&~hidden)
    stride=max(1,len(xx)//4500);xx,yy=xx[::stride],yy[::stride];patch={};evidence={}
    fill=element.get('gradient') or element.get('fill');opaque={**fill,'stops':[{**s,'opacity':1} for s in fill['stops']]} if isinstance(fill,dict) else fill
    if parameter_blocked(element,'fill'):
        evidence['fill']={'status':'kept','reason':'fill-parameter-locked'}
    elif len(xx)>=80:
        ink=predict_paint(opaque,xx+.5,yy+.5,element);bg=lower[yy,xx].astype(float);pixels=reference[yy,xx].astype(float)
        current=composite_paint(fill,xx+.5,yy+.5,element,bg);t=np.clip(((xx+.5)*normal[0]+(yy+.5)*normal[1]-lo)/span,0,1)
        if ink is not None and current is not None:
            varying=np.max(np.std(ink,axis=0))>=4
            if varying and isinstance(fill,dict):
                # Keep the existing colour function and coordinate intact;
                # only its alpha coefficients may change.
                focus=fill.get('center') or {}
                t=paint_coordinate(fill['type'],xx+.5,yy+.5,element,fill.get('angle',0),(focus.get('x',.5),focus.get('y',.5)))
            color=np.median(ink,axis=0)
            fitted,detail=alpha_fit(pixels,bg,ink if varying else np.broadcast_to(color,ink.shape),t,current,float(element.get('opacity',1))*float(element.get('fillOpacity',1)),xx,yy)
            evidence['fill']=detail
            if fitted:
                knots,alpha=fitted
                if varying and isinstance(fill,dict):
                    positions=sorted(set([s['position'] for s in fill['stops']]+knots.tolist()))
                    rgb=np.array([[int(s['color'][i:i+2],16) for i in (0,2,4)] for s in fill['stops']]);source=[s['position'] for s in fill['stops']]
                    patch['gradient']={**fill,'stops':[{'position':float(k),'color':''.join(f'{round(np.interp(k,source,rgb[:,i])):02X}' for i in range(3)),'opacity':round(float(np.interp(k,knots,alpha)),4)} for k in positions]}
                else:
                    hexcolor=''.join(f'{round(v):02X}' for v in color)
                    patch['gradient']={'type':'linear','angle':angle,'stops':[{'position':float(k),'color':hexcolor,'opacity':round(float(a),4)} for k,a in zip(knots,alpha)]}
        else:evidence['fill']={'status':'kept','reason':'colour-function-unavailable'}
    # Trace true contour centres; unlike a colour ridge, this includes the weak
    # lower edge rather than discarding precisely the fading pixels.
    width=float(element.get('strokeWidth') or 0)
    if parameter_blocked(element,'stroke'):
        evidence['stroke']={'status':'kept','reason':'stroke-parameter-locked'}
    elif width>=.5 and not element.get('shadow'):
        samples=[]
        for a,b in zip(polygon,np.roll(polygon,-1,axis=0)):
            samples.extend(np.linspace(a,b,max(15,round(np.linalg.norm(b-a))))[3:-3])
        q=np.asarray(samples);sx=np.clip(np.rint(q[:,0]).astype(int),0,1599);sy=np.clip(np.rint(q[:,1]).astype(int),0,899);keep=~hidden[sy,sx];sx,sy=sx[keep],sy[keep]
        if len(sx)>=60:
            bg=lower[sy,sx].astype(float);base=composite_paint(patch.get('gradient') or fill,sx+.5,sy+.5,element,bg)
            bg=(bg+base)*.5 if base is not None else bg;pixels=reference[sy,sx].astype(float)
            colors=element.get('strokeGradient');raw=colors or element.get('color')
            # A stable chromatic core provides the ink; low-contrast lower
            # contour pixels only identify opacity, never a background-colour stop.
            hsv=cv2.cvtColor(np.clip(pixels,0,255).astype(np.uint8).reshape(1,-1,3),cv2.COLOR_RGB2HSV)[0]
            strong=hsv[:,1]>max(55,float(np.percentile(hsv[:,1],70))*.8)
            if strong.sum()>=20:
                color=np.median(pixels[strong],axis=0);ink=np.broadcast_to(color,pixels.shape)
                current=composite_paint(raw,sx+.5,sy+.5,{**element,'fillOpacity':element.get('colorOpacity',1)},bg)
                t=np.clip(((sx+.5)*normal[0]+(sy+.5)*normal[1]-lo)/span,0,1)
                if current is not None:
                    fitted,detail=alpha_fit(pixels,bg,ink,t,current,float(element.get('opacity',1))*float(element.get('colorOpacity',1)),sx,sy);evidence['stroke']=detail
                    if fitted:
                        knots,alpha=fitted;hexcolor=''.join(f'{round(v):02X}' for v in color)
                        patch['strokeGradient']={'type':'linear','angle':angle,'stops':[{'position':float(k),'color':hexcolor,'opacity':round(float(a),4)} for k,a in zip(knots,alpha)]}
    evidence.setdefault('fill',{'status':'unobservable','reason':'insufficient-fill-evidence'})
    evidence.setdefault('stroke',{'status':'unobservable' if width>=.5 else 'not-applicable','reason':'insufficient-stroke-evidence' if width>=.5 else 'no-stroke'})
    return patch,{'status':'measured','axis':round(angle,3),'parameters':evidence}
