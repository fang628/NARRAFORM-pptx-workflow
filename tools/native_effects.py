"""Mask-aware exterior glow/shadow detection, bounded to a local object ROI.

Fits one exterior effect, never an extra scene element. Uses the real lower
composite and excludes later objects, so nested carriers cannot become shadows.
"""
import math
import cv2
import numpy as np
from shape_reference import seed_polygon


def geometry_mask(element, shape):
    mask=np.zeros(shape,np.uint8)
    x,y,w,h=[float(element.get(k) or 0) for k in ('x','y','w','h')]
    if element.get('type')=='line':
        a=(round(x+w if element.get('flipH') else x),round(y+h if element.get('flipV') else y))
        b=(round(x if element.get('flipH') else x+w),round(y if element.get('flipV') else y+h))
        cv2.line(mask,a,b,255,max(1,round(float(element.get('strokeWidth') or 1))))
        return mask
    points=seed_polygon(element)
    if not points:return None
    points=np.asarray(points,float)
    if element.get('flipH'):points[:,0]=2*x+w-points[:,0]
    if element.get('flipV'):points[:,1]=2*y+h-points[:,1]
    if element.get('rotate'):
        angle=math.radians(element['rotate']);rotation=np.array([[math.cos(angle),-math.sin(angle)],[math.sin(angle),math.cos(angle)]])
        center=np.array([x+w/2,y+h/2]);points=(points-center)@rotation.T+center
    cv2.fillPoly(mask,[np.round(points).astype(np.int32)],255)
    return mask


def detect_native_effects(reference,element,underlay,front_alpha=None,exclude=(),own_alpha=None):
    def uncertain(reason):return {},{'status':'unobservable','reason':reason}
    if underlay is None:return uncertain('lower-composite-unavailable')
    mask=geometry_mask(element,reference.shape[:2])
    if own_alpha is not None and not element.get('glow') and not element.get('shadow') and float(element.get('opacity',1))*float(element.get('fillOpacity',1))>=.98:
        mask=(own_alpha>=128).astype(np.uint8)*255
    if mask is None or not mask.any():return uncertain('geometry-unavailable')
    yy,xx=np.where(mask>0);pad=28
    x0,x1=max(0,int(xx.min())-pad),min(mask.shape[1],int(xx.max())+pad+1)
    y0,y1=max(0,int(yy.min())-pad),min(mask.shape[0],int(yy.max())+pad+1)
    if x0==0 or y0==0 or x1==mask.shape[1] or y1==mask.shape[0]:return uncertain('clipped-exterior')
    own=mask[y0:y1,x0:x1]>0
    distance=cv2.distanceTransform((~own).astype(np.uint8),cv2.DIST_L2,5)
    guard=max(3,min(12,float(element.get('strokeWidth') or 0)/2+2))
    eligible=(distance>guard)&(distance<22)
    if front_alpha is not None:eligible &= front_alpha[y0:y1,x0:x1]<8
    for a,b,c,d in exclude:
        eligible[max(0,b-y0):max(0,d-y0),max(0,a-x0):max(0,c-x0)]=False
    sy,sx=np.where(eligible)
    if len(sx)<80:return uncertain('exterior-occluded')
    # Require evidence on multiple separated contour sectors.
    center=np.array([np.mean(xx)-x0,np.mean(yy)-y0])
    sectors=((np.arctan2(sy-center[1],sx-center[0])+math.pi)/(math.pi/2)).astype(int)%4
    if len(np.unique(sectors))<3:return uncertain('exterior-coverage')
    order=np.linspace(0,len(sx)-1,min(1800,len(sx))).astype(int);sy,sx,sectors=sy[order],sx[order],sectors[order]
    bg=underlay[y0:y1,x0:x1][sy,sx].astype(float)
    observed=reference[y0:y1,x0:x1][sy,sx].astype(float);delta=observed-bg
    far=distance[sy,sx]>16
    if far.sum()<20:return uncertain('background-support-missing')
    noise=float(np.sqrt(np.mean(delta[far]**2)))
    if noise>3:return uncertain('lower-composite-mismatch')
    if np.max(np.std(bg,axis=0))>8:return uncertain('textured-lower-composite')
    energy=float(np.sqrt(np.mean(delta**2)))
    if energy<(.65 if element.get('type')=='line' else 1.3):return {'glow':None,'shadow':None},{'status':'absent','rmse':round(energy,2)}
    train=np.arange(len(sx))%3!=0;test=~train
    source=own.astype(np.float32)
    best=None;centered=None;count=0
    shifts=[(0,0)]+[(round(r*math.cos(a)),round(r*math.sin(a))) for r in (2,4,6,8) for a in np.arange(8)*math.pi/4]
    for sigma in (1,2,3,4,6):
        blurred=cv2.GaussianBlur(source,(0,0),sigma)
        for dx,dy in shifts:
            shifted=cv2.warpAffine(blurred,np.float32([[1,0,dx],[0,1,dy]]),(source.shape[1],source.shape[0]))
            t=shifted[sy,sx].astype(float);denom=float(np.sum(t[train]**2))
            if denom<.001:continue
            coef=np.sum(delta[train]*t[train,None],axis=0)/denom
            prediction=t[:,None]*coef
            error=float(np.sqrt(np.mean((delta[test]-prediction[test])**2)))
            count+=1
            if dx==dy==0 and (centered is None or error<centered[0]):centered=(error,sigma,dx,dy,coef,prediction)
            if best is None or error<best[0]:best=(error,sigma,dx,dy,coef,prediction)
    if best is None:return uncertain('tail-not-resolved')
    if centered and centered[0]<=best[0]+.3 and centered[4]@np.array([.2126,.7152,.0722])>0:best=centered
    error,sigma,dx,dy,coef,prediction=best
    if error>max(1.5,energy*.3):return uncertain('not-one-native-soft-effect')
    # Reject tails supported by only one ridge or a foreground decoration.
    supported=sum(float(np.sqrt(np.mean(prediction[sectors==s]**2)))>(.5 if element.get('type')=='line' else 1) for s in np.unique(sectors))
    light=float(coef@np.array([.2126,.7152,.0722]))
    kind='glow' if light>0 and dx==dy==0 else 'shadow' if light<0 else None
    if not kind or (kind=='glow' and supported<(2 if element.get('type')=='line' else 3)):return uncertain('directional-light-or-insufficient-contour-support')
    baseline=np.mean(bg,axis=0)
    opacity=float(np.max(np.where(coef>=0,coef/np.maximum(255-baseline,1),-coef/np.maximum(baseline,1))))
    if not .03<opacity<=1.15:return uncertain('effect-color-opacity-not-supported')
    color=''.join(f'{v:02X}' for v in np.clip(np.round(baseline+coef/max(opacity,.01)),0,255).astype(int))
    params={'color':color,'opacity':round(min(1,opacity),3)}
    if kind=='glow':params['radius']=sigma*2
    else:params.update(type='outer',blur=sigma*2,offset=round(math.hypot(dx,dy),2),angle=round(math.degrees(math.atan2(dy,dx))%360,2))
    return {kind:params,'shadow' if kind=='glow' else 'glow':None},{'status':'present','kind':kind,'rmse':round(error,2),
        'samples':len(sx),'candidates':count,'estimated':True,'parameterAmbiguity':'color-opacity-from-flattened-image'}


def without_soft_exterior(reference,element,underlay,effects,own_alpha=None):
    """Remove only the fitted exterior tail before the independent hard-rim fit."""
    effect=effects.get('glow') or effects.get('shadow')
    if not effect or underlay is None:return reference
    mask=geometry_mask(element,reference.shape[:2])
    if own_alpha is not None and not element.get('glow') and not element.get('shadow') and float(element.get('opacity',1))*float(element.get('fillOpacity',1))>=.98:
        mask=(own_alpha>=128).astype(np.uint8)*255
    if mask is None:return reference
    yy,xx=np.where(mask>0);pad=28
    x0,x1=max(0,int(xx.min())-pad),min(mask.shape[1],int(xx.max())+pad+1)
    y0,y1=max(0,int(yy.min())-pad),min(mask.shape[0],int(yy.max())+pad+1)
    own=mask[y0:y1,x0:x1]>0
    sigma=(effect.get('radius') or effect.get('blur') or 0)/2
    if sigma<=0:return reference
    tail=cv2.GaussianBlur(own.astype(np.float32),(0,0),sigma)
    if effects.get('shadow'):
        angle=math.radians(effect.get('angle',90));offset=effect.get('offset',0)
        tail=cv2.warpAffine(tail,np.float32([[1,0,math.cos(angle)*offset],[0,1,math.sin(angle)*offset]]),(tail.shape[1],tail.shape[0]))
    color=np.array([int(effect['color'][i:i+2],16) for i in (0,2,4)])
    correction=(color-underlay[y0:y1,x0:x1])*tail[:,:,None]*effect['opacity']
    exterior=(1-own_alpha[y0:y1,x0:x1].astype(float)/255) if own_alpha is not None and not element.get('glow') and not element.get('shadow') else (~own).astype(float)
    corrected=reference.copy();region=corrected[y0:y1,x0:x1]
    region[:]=np.clip(np.round(region-correction*exterior[:,:,None]),0,255).astype(np.uint8)
    return corrected
