"""Conservative native fill/outline gradient fitting on the measured contour."""
import cv2
import numpy as np

def _color(value):
    try:
        v=str(value).lstrip('#')
        return np.array([int(v[i:i+2],16) for i in (0,2,4)],np.float64) if len(v)==6 else None
    except ValueError:
        return None

from paint_models import fit_native_paint, predict_paint, composite_paint


def solid_paint(pixels,xx,yy,element,current):
    if len(pixels)<80:return None
    step=max(1,len(pixels)//3000);pixels=pixels[::step].astype(float);xx=xx[::step];yy=yy[::step]
    baseline=predict_paint(current,xx,yy,element)
    if baseline is None:return None
    color=np.median(pixels,axis=0);residual=np.mean(abs(pixels-color),axis=1);before=float(np.mean(abs(baseline-pixels)));after=float(np.mean(residual))
    if before-after<4 or after>3.5 or np.percentile(residual,90)>8:return None
    return {'color':''.join(f'{int(round(v)):02X}' for v in color),'beforeError':round(before,3),'afterError':round(after,3),'confidence':float((residual<=8).mean()),'samples':len(pixels),'method':'robust-uniform-visible-color'}

def _fit(pixels, xx, yy, element, current):
    return fit_native_paint(pixels, xx, yy, element, current)


def outline_profile(ref,contour,mask,valid):
    points=contour[:,0,:].astype(float)
    if len(points)<8:return None
    widths=[];colors=[];clear_edges=0;tested_edges=0
    for i in np.linspace(0,len(points)-1,min(100,len(points)),dtype=int):
        tangent=points[(i+2)%len(points)]-points[(i-2)%len(points)]
        length=np.linalg.norm(tangent)
        if length<1:continue
        normal=np.array([-tangent[1],tangent[0]])/length;p=points[i]
        def sample(q):
            x,y=np.rint(q).astype(int)
            return (x,y) if 0<=x<mask.shape[1] and 0<=y<mask.shape[0] else None
        probe=sample(p+normal*3)
        if probe is None or not mask[probe[1],probe[0]]:normal=-normal
        offsets=np.arange(-8,14.01,.5)
        positions=[sample(p+normal*d) for d in offsets]
        if any(q is None or not valid[q[1],q[0]] for q in positions):continue
        values=np.array([ref[y,x] for x,y in positions],float)
        outside=values[offsets<=-4];inside=values[offsets>=10]
        if np.mean(np.std(outside,axis=0))>13 or np.mean(np.std(inside,axis=0))>13:continue
        a=np.median(outside,axis=0);b=np.median(inside,axis=0);direction=b-a
        t=np.clip((values-a)@direction/max(1,np.dot(direction,direction)),0,1)
        # A true outline is a color ridge beyond a simple antialiased fill edge.
        ridge=np.linalg.norm(values-(a+t[:,None]*direction),axis=1)
        if np.linalg.norm(direction)>=20:
            tested_edges+=1
            if ridge.max()<9:clear_edges+=1
        peak=int(np.argmax(ridge))
        if ridge[peak]<14 or offsets[peak]<-3 or offsets[peak]>9:continue
        active=ridge>=ridge[peak]*.7;left=right=peak
        while left>0 and active[left-1]:left-=1
        while right<len(active)-1 and active[right+1]:right+=1
        width=(right-left+1)*.5
        if not .75<=width<=12:continue
        widths.append(width);colors.append(np.median(values[left:right+1],axis=0))
    if tested_edges>=24 and clear_edges/tested_edges>=.95:
        return {'width':0,'presence':'absent','confidence':clear_edges/tested_edges,'samples':tested_edges,'method':'boundary-normal-no-colour-ridge'}
    if len(widths)<12:return None
    width=float(np.median(widths));agreement=float((abs(np.array(widths)-width)<=1).mean())
    if agreement<.8:return None
    color=np.median(colors,axis=0)
    return {'width':width,'color':''.join(f'{int(round(v)):02X}' for v in color),'confidence':agreement,'samples':len(widths),'method':'boundary-normal-colour-profile'}


def fit_shape_paint(ref, contour, element, excluded, excluded_alpha=None, diagnostics=None, background=None):
    if element.get('type') not in ('shape','rect','ellipse') or element.get('managed'):
        return {}
    x,y,bw,bh=cv2.boundingRect(contour);ox=max(0,x-16);oy=max(0,y-16);right=min(ref.shape[1],x+bw+16);bottom=min(ref.shape[0],y+bh+16);w=right-ox;h=bottom-oy;ref=ref[oy:bottom,ox:right]
    contour=contour-np.array([[[ox,oy]]],dtype=np.int32)
    mask=np.zeros((h,w),np.uint8);cv2.drawContours(mask,[contour],-1,1,-1)
    # A rectangular contour can fill its entire ROI. Give distanceTransform a
    # real outside boundary or it returns an infinite distance for every pixel.
    distance=cv2.distanceTransform(np.pad(mask,1),cv2.DIST_L2,3)[1:-1,1:-1]
    valid=np.ones(mask.shape,bool)
    if excluded_alpha is not None:
        valid &= excluded_alpha[oy:oy+h,ox:ox+w] <= 16
    for left,top,right,bottom in excluded:
        x0,y0,x1,y1=max(0,left-ox),max(0,top-oy),min(w,right-ox),min(h,bottom-oy)
        if x1>x0 and y1>y0:valid[y0:y1,x0:x1]=False
    width=float(element.get('strokeWidth') or 0)
    yy,xx=np.indices(mask.shape);xx=xx+ox;yy=yy+oy
    result={}
    outline=outline_profile(ref,contour,mask,valid)
    if outline:result['outline']=outline
    valid &= mask.astype(bool)
    if float(element.get('fillOpacity',1))*float(element.get('opacity',1))>=.98 or background is not None:
        sample=valid&(distance>max(3,width+1))
        bg=background[oy:oy+h,ox:ox+w][sample] if background is not None else None
        detail={} if diagnostics is not None else None
        fill=fit_native_paint(ref[sample],xx[sample],yy[sample],element,element.get('gradient') or element.get('fill'),diagnostics=detail,background=bg)
        if diagnostics is not None:diagnostics['fill']=detail
        if fill:result['fill']=fill
        else:
            solid=solid_paint(ref[sample],xx[sample],yy[sample],element,element.get('gradient') or element.get('fill')) if float(element.get('fillOpacity',1))*float(element.get('opacity',1))>=.98 else None
            if solid:result['solidFill']=solid
    if width>=.7 and float(element.get('colorOpacity',1))*float(element.get('opacity',1))>=.15:
        # Sample the inside half of the actual stroke, not a band reaching into
        # the fill. Transparent strokes need the painted fill beneath them.
        sample=valid&(distance>=.5)&(distance<=max(1.2,width*.45))
        bg=background[oy:oy+h,ox:ox+w][sample] if background is not None else None
        base_paint=result.get('fill',{}).get('gradient') or result.get('solidFill',{}).get('color') or element.get('gradient') or element.get('fill')
        under_stroke=composite_paint(base_paint,xx[sample],yy[sample],element,bg) if base_paint else bg
        detail={} if diagnostics is not None else None
        stroke=fit_native_paint(ref[sample],xx[sample],yy[sample],{**element,'fillOpacity':element.get('colorOpacity',1)},element.get('strokeGradient') or element.get('color'),diagnostics=detail,background=under_stroke)
        if diagnostics is not None:diagnostics['stroke']=detail
        if stroke:result['stroke']=stroke
    return result
