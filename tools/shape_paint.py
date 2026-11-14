"""Conservative native fill/outline gradient fitting on the measured contour.

The contour (from S3) is the search ROI. Optional evidence from S2/S3 object masks refines
where the object is actually visible:

    visible_alpha  per-object predicted alpha (uint8, full page). The measured fill interior
                   stays inside this support and is eroded from the antialiased boundary and
                   from the measured stroke rim, so a slightly large seed polygon cannot pull
                   neighbour/background colour into the fill.
    excluded_alpha union of objects painted after the target plus mapped glyphs (uint8, full
                   page). Pixels covered by it are never sampled. Exterior stroke evidence is
                   *not* gated by the object's own alpha: the outer half of a centred stroke
                   lies outside the object mask, and the normal profile needs those pixels to
                   find the colour ridge at all.

Both masks are optional: without them the committed polygon + box behaviour is unchanged.
Solid fills take a cheap uniform fast path before any gradient search; real gradients still
use the committed model ladder. Stroke colour is measured on the detected boundary colour
ridge with the correct per-pixel background (fill inside the object, lower composite outside),
so a translucent bright rim over a dark backdrop is de-mixed instead of rejected.
"""
import cv2
import numpy as np

def _color(value):
    try:
        v=str(value).lstrip('#')
        return np.array([int(v[i:i+2],16) for i in (0,2,4)],np.float64) if len(v)==6 else None
    except (ValueError,TypeError):
        return None

from paint_models import fit_native_paint, predict_paint, composite_paint

MASK_SUPPORT = 8
HIDDEN_THRESHOLD = 16
SOLID_RANGE = 14.0
MIN_SAMPLES = 80
MIN_STROKE_SAMPLES = 24


def _hex(color):
    return ''.join(f'{int(max(0,min(255,round(float(v))))):02X}' for v in np.asarray(color,float)[:3])


def _translucent_paint(paint):
    if not isinstance(paint,dict):return False
    for stop in paint.get('stops') or []:
        try:
            if float(stop.get('opacity',1))<.98:return True
        except (TypeError,ValueError,AttributeError):continue
    return False


def _spatial_range(pixels):
    """Largest 5-95 percentile spread over RGB: near zero for a solid fill."""
    pixels = np.asarray(pixels, float)
    if pixels.ndim != 2 or len(pixels) < 8:
        return 1e9
    spread = np.percentile(pixels, 95, axis=0) - np.percentile(pixels, 5, axis=0)
    return float(np.max(spread)) if spread.size else 1e9


def _crop_mask(values, oy, ox, h, w):
    array = np.asarray(values)
    if array.ndim == 3:
        array = array[..., 0]
    if array.shape[0] < oy + h or array.shape[1] < ox + w:
        return None
    return array[oy:oy + h, ox:ox + w]


def solid_paint(pixels,xx,yy,element,current):
    if len(pixels)<MIN_SAMPLES:return None
    step=max(1,len(pixels)//3000);pixels=pixels[::step].astype(float);xx=xx[::step];yy=yy[::step]
    baseline=predict_paint(current,xx,yy,element)
    if baseline is None:return None
    color=np.median(pixels,axis=0);residual=np.mean(abs(pixels-color),axis=1);before=float(np.mean(abs(baseline-pixels)));after=float(np.mean(residual))
    if before-after<4 or after>3.5 or np.percentile(residual,90)>8:return None
    return {'color':_hex(color),'beforeError':round(before,3),'afterError':round(after,3),'confidence':float((residual<=8).mean()),'samples':len(pixels),'method':'robust-uniform-visible-color','accepted':True}

def _fit(pixels, xx, yy, element, current):
    return fit_native_paint(pixels, xx, yy, element, current)


def outline_profile(ref,contour,mask,valid):
    """Boundary-normal stroke profile; returns (profile, ridge_mask).

    `valid` must only exclude foreground occluders/explicit boxes, never the object's own
    alpha: the exterior side of the boundary is needed to tell a real colour ridge from a
    plain antialiased fill edge. `ridge_mask` marks the accepted ridge pixels inside the ROI
    so the stroke paint model can be fitted on the actual stroke instead of a fixed band.
    """
    points=contour[:,0,:].astype(float)
    if len(points)<8:return None,None
    widths=[];colors=[];peak_offsets=[];clear_edges=0;tested_edges=0;eligible_edges=0
    ridge_mask=np.zeros(mask.shape,np.uint8)
    limit=mask.shape
    for i in np.linspace(0,len(points)-1,min(900,len(points)),dtype=int):
        tangent=points[(i+2)%len(points)]-points[(i-2)%len(points)]
        length=np.linalg.norm(tangent)
        if length<1:continue
        normal=np.array([-tangent[1],tangent[0]])/length;p=points[i]
        def sample(q):
            x,y=np.rint(q).astype(int)
            return (x,y) if 0<=x<limit[1] and 0<=y<limit[0] else None
        probe=sample(p+normal*3)
        if probe is None or not mask[probe[1],probe[0]]:normal=-normal
        sample_offsets=np.arange(-8,14.01,.5)
        positions=[sample(p+normal*d) for d in sample_offsets]
        if any(q is None or not valid[q[1],q[0]] for q in positions):continue
        values=np.array([ref[y,x] for x,y in positions],float)
        outside=values[sample_offsets<=-4];inside=values[sample_offsets>=10]
        if np.mean(np.std(outside,axis=0))>13 or np.mean(np.std(inside,axis=0))>13:continue
        a=np.median(outside,axis=0);b=np.median(inside,axis=0);direction=b-a
        eligible_edges+=1
        t=np.clip((values-a)@direction/max(1,np.dot(direction,direction)),0,1)
        # A true outline is a color ridge beyond a simple antialiased fill edge.
        ridge=np.linalg.norm(values-(a+t[:,None]*direction),axis=1)
        if np.linalg.norm(direction)>=20:
            tested_edges+=1
            if ridge.max()<9:clear_edges+=1
        peak=int(np.argmax(ridge))
        if ridge[peak]<14 or sample_offsets[peak]<-3 or sample_offsets[peak]>9:continue
        active=ridge>=ridge[peak]*.7;left=right=peak
        while left>0 and active[left-1]:left-=1
        while right<len(active)-1 and active[right+1]:right+=1
        width=(right-left+1)*.5
        if not .75<=width<=12:continue
        widths.append(width);colors.append(np.median(values[left:right+1],axis=0));peak_offsets.append(float(sample_offsets[peak]))
        for x,y in positions[left:right+1]:
            if 0<=x<limit[1] and 0<=y<limit[0]:ridge_mask[y,x]=1
    if tested_edges>=24 and clear_edges/tested_edges>=.95:
        return {'width':0,'presence':'absent','confidence':clear_edges/tested_edges,'samples':tested_edges,'method':'boundary-normal-no-colour-ridge'},None
    if len(widths)<12:return None,None
    width=float(np.median(widths));agreement=float((abs(np.array(widths)-width)<=1).mean())
    if agreement<.8:return None,None
    color=np.median(colors,axis=0)
    coverage=len(widths)/max(1,eligible_edges)
    offset_mad=float(np.median(abs(np.asarray(peak_offsets)-np.median(peak_offsets))))
    confidence=agreement*min(1.,coverage/.45)*max(0.,1-offset_mad/4)
    confidence*=max(0.,1-max(0.,abs(float(np.median(peak_offsets)))-2)/4)
    profile={'width':width,'color':_hex(color),'confidence':confidence,'samples':len(widths),
             'coverage':round(coverage,4),'offsetSpread':round(offset_mad,3),
             'offset':round(float(np.median(peak_offsets)),2),'method':'boundary-normal-colour-profile'}
    return profile,ridge_mask


def _fill_evidence_detail(detail, solid, method):
    if detail is None:
        return
    detail.update({'status': 'accepted', 'accepted': True,
                   'beforeError': solid.get('beforeError'), 'afterError': solid.get('afterError'),
                   'confidence': solid.get('confidence'), 'method': method,
                   'candidatesEvaluated': 0, 'elapsedMs': 0.0})


def fit_shape_paint(ref, contour, element, excluded, excluded_alpha=None, diagnostics=None, background=None, visible_alpha=None):
    if element.get('type') not in ('shape','rect','ellipse') or element.get('managed'):
        return {}
    page_height, page_width = ref.shape[:2]
    x,y,bw,bh=cv2.boundingRect(contour);ox=max(0,x-16);oy=max(0,y-16)
    right=min(page_width,x+bw+16);bottom=min(page_height,y+bh+16);w=right-ox;h=bottom-oy
    if w<4 or h<4:
        return {}
    ref=ref[oy:bottom,ox:right]
    contour=contour-np.array([[[ox,oy]]],dtype=np.int32)
    mask=np.zeros((h,w),np.uint8);cv2.drawContours(mask,[contour],-1,1,-1)
    filled=mask.astype(bool)
    # A rectangular contour can fill its entire ROI. Give distanceTransform a
    # real outside boundary or it returns an infinite distance for every pixel.
    distance=cv2.distanceTransform(np.pad(mask,1),cv2.DIST_L2,3)[1:-1,1:-1]
    outside=cv2.distanceTransform(np.pad(1-mask,1),cv2.DIST_L2,3)[1:-1,1:-1]
    # Signed distance to the contour: >0 inside, <0 outside.
    signed=distance-outside
    width=float(element.get('strokeWidth') or 0)
    sampling={'polygonPixels':int(filled.sum())}

    support=None
    if visible_alpha is not None:
        own=_crop_mask(visible_alpha,oy,ox,h,w)
        if own is not None:
            support=own>MASK_SUPPORT
            sampling['supportPixels']=int((support&filled).sum())
    # Foreground evidence: occluders and explicit boxes only. Own alpha is intentionally
    # not part of it, otherwise the exterior half of a real stroke (and every normal-profile
    # sample outside the polygon) is discarded and no edge can be found.
    evidence=np.ones(mask.shape,bool)
    if excluded_alpha is not None:
        hidden=_crop_mask(excluded_alpha,oy,ox,h,w)
        if hidden is not None:
            hidden=hidden>HIDDEN_THRESHOLD
            sampling['frontPixels']=int(hidden.sum())
            covered=filled&hidden&(support if support is not None else True)
            sampling['frontFraction']=round(float(covered.sum())/max(1,int((filled&(support if support is not None else True)).sum())),4)
            evidence&=~hidden
    for left,top,right_edge,bottom_edge in excluded:
        x0,y0=max(0,left-ox),max(0,top-oy);x1,y1=min(w,right_edge-ox),min(h,bottom_edge-oy)
        if x1>x0 and y1>y0:evidence[y0:y1,x0:x1]=False
    yy,xx=np.indices(mask.shape);xx=xx+ox;yy=yy+oy
    result={}
    dense_contours=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_NONE)[0]
    dense_contour=max(dense_contours,key=cv2.contourArea) if dense_contours else contour
    outline,ridge=outline_profile(ref,dense_contour,mask,evidence)
    if outline:result['outline']=outline
    sampling['outlineDetected']=bool(outline and outline.get('width',0)>0)
    if outline and outline.get('width'):
        sampling['outlineWidth']=round(float(outline['width']),2)
        sampling['outlineOffset']=outline.get('offset')
    stroke_margin=0.0
    if outline and float(outline.get('width') or 0)>0:
        stroke_margin=max(0.0,float(outline.get('offset') or 0)+float(outline['width'])*.5)
    # Fill sampling: evidence + own alpha + polygon, eroded past the outline and a
    # size-aware interior margin so the rim/shadow of a small object cannot colour the fill.
    valid=evidence.copy()
    if support is not None:valid&=support
    valid&=filled
    interior=max(3.0,min(8.0,.10*min(max(1.0,float(element.get('w') or 0)),max(1.0,float(element.get('h') or 0)))),
                 width+1.0,stroke_margin+1.5)
    inner=filled&(distance>interior)
    if int(inner.sum())<200:
        # Small/thin objects cannot afford a large erosion; keep a minimal interior instead.
        inner=filled&(distance>max(1.5,width*.5+1.0))
    sampling['innerPixels']=int(inner.sum())
    fill_sample=valid&inner
    sampling['visiblePixels']=int(fill_sample.sum())
    sampling['excludedFraction']=round(float((~valid&filled).sum())/max(1,int(filled.sum())),4)
    if sampling['visiblePixels']<MIN_SAMPLES:
        sampling['reason']='insufficient-visible-samples'
    elif sampling.get('frontFraction',0)>=.8:
        sampling['mostlyOccluded']=True

    current_paint=element.get('gradient') or element.get('fill')
    fill_opaque=float(element.get('fillOpacity',1))*float(element.get('opacity',1))>=.98
    if not element.get('tableFittedFill') and (fill_opaque or background is not None) and sampling['visiblePixels']>=MIN_SAMPLES:
        detail={} if diagnostics is not None else None
        pixels=ref[fill_sample]
        background_pixels=background[oy:oy+h,ox:ox+w][fill_sample] if background is not None else None
        spatial_range=_spatial_range(pixels)
        sampling['spatialRange']=round(spatial_range,3)
        solid=solid_paint(pixels,xx[fill_sample],yy[fill_sample],element,current_paint) if fill_opaque else None
        if solid is not None and spatial_range<=SOLID_RANGE:
            # Uniform visible pixels: a solid fill explains them, so no gradient search runs.
            result['solidFill']={**solid,'method':'solid-fast-path'}
            _fill_evidence_detail(detail,result['solidFill'],'solid-fast-path')
        else:
            fill=fit_native_paint(pixels,xx[fill_sample],yy[fill_sample],element,current_paint,diagnostics=detail,background=background_pixels)
            if fill:result['fill']=fill
            elif solid is not None:
                result['solidFill']=solid
                _fill_evidence_detail(detail,solid,solid.get('method') or 'robust-uniform-visible-color')
        if diagnostics is not None:diagnostics['fill']=detail
    elif diagnostics is not None:
        detail=diagnostics.setdefault('fill',{})
        detail.setdefault('status','skipped')
        if sampling['visiblePixels']<MIN_SAMPLES:
            detail['reason']='insufficient-visible-samples'
            detail['samples']=sampling['visiblePixels']
        elif not fill_opaque and background is None:
            detail['reason']='background-required-for-alpha'

    stroke_opaque=float(element.get('colorOpacity',1))*float(element.get('opacity',1))>=.98
    detected=outline is not None and float(outline.get('width') or 0)>=.7
    if float(element.get('colorOpacity',1))*float(element.get('opacity',1))>=.15 and (width>=.7 or detected):
        stroke_width=max(width,float((outline or {}).get('width') or 0) if detected else 0.0)
        if ridge is not None and int(ridge.sum())>=MIN_STROKE_SAMPLES:
            band=ridge.astype(bool)&evidence
            sampling['strokeMethod']='colour-ridge'
        else:
            # An audited width locates a search, not evidence that these pixels
            # contain a stroke. A fixed band can be entirely fill/background.
            band=np.zeros(evidence.shape,bool)
            sampling['strokeMethod']='unresolved-ridge'
        # Prefer the inner half of the stroke: it is painted over this object's own fill, so a
        # single known background (the fill composite) de-mixes it. Only use the mixed outer
        # half when the detected ridge is too thin to provide enough interior samples.
        inner_band=band&(signed>=0)
        mixed_background=False
        if int(inner_band.sum())>=MIN_STROKE_SAMPLES:
            band=inner_band
        else:
            mixed_background=True
        sampling['strokePixels']=int(band.sum())
        sampling['ridgeConfidence']=float((outline or {}).get('confidence',0))
        if sampling['strokePixels']>=MIN_STROKE_SAMPLES:
            detail={} if diagnostics is not None else None
            pixels=ref[band]
            background_pixels=background[oy:oy+h,ox:ox+w][band] if background is not None else None
            base_paint=result.get('fill',{}).get('gradient') if isinstance(result.get('fill'),dict) else None
            if base_paint is None and isinstance(result.get('solidFill'),dict):
                base_paint=result['solidFill'].get('color')
            if base_paint is None:
                base_paint=element.get('gradient') or element.get('fill')
            if not mixed_background:
                under=composite_paint(base_paint,xx[band],yy[band],element,background_pixels) if base_paint is not None else None
            elif base_paint is not None and background_pixels is not None:
                fill_composite=composite_paint(base_paint,xx[band],yy[band],element,background_pixels)
                under=np.where((signed[band]>=0)[:,None],fill_composite,background_pixels) if fill_composite is not None else background_pixels
            elif base_paint is not None:
                under=composite_paint(base_paint,xx[band],yy[band],element,None)
            else:
                under=background_pixels
            stroke_element={**element,'fillOpacity':element.get('colorOpacity',1)}
            current_stroke=element.get('strokeGradient') or element.get('color')
            stroke_alpha=float(element.get('colorOpacity',1))*float(element.get('opacity',1))
            if under is not None and .15<=stroke_alpha<.98:
                recovered=(pixels-(1-stroke_alpha)*under)/stroke_alpha
                median=np.median(recovered,axis=0)
                residual=np.mean(abs(recovered-median),axis=1)
                if (residual<8).mean()>=.85 and np.all(median>=-4) and np.all(median<=259):
                    predicted=np.clip(median,0,255)*stroke_alpha+under*(1-stroke_alpha)
                    after=float(np.mean(abs(predicted-pixels)))
                    if after<=4:
                        result['strokeSolid']={'color':_hex(median),'confidence':float((residual<8).mean()),
                            'afterError':after,'samples':len(pixels),'accepted':True,'method':'ridge-alpha-unmixed-solid'}
                        _fill_evidence_detail(detail,result['strokeSolid'],'ridge-alpha-unmixed-solid')
            spatial_range=_spatial_range(pixels)
            sampling['strokeRange']=round(spatial_range,3)
            solid=solid_paint(pixels,xx[band],yy[band],stroke_element,current_stroke) if stroke_opaque else None
            if 'strokeSolid' in result:
                pass
            elif solid is not None and spatial_range<=SOLID_RANGE:
                result['strokeSolid']={**solid,'method':'solid-fast-path'}
                _fill_evidence_detail(detail,result['strokeSolid'],'solid-fast-path')
            else:
                stroke=fit_native_paint(pixels,xx[band],yy[band],stroke_element,current_stroke,diagnostics=detail,background=under)
                if stroke:result['stroke']=stroke
                elif solid is not None:
                    result['strokeSolid']=solid
                    _fill_evidence_detail(detail,solid,solid.get('method') or 'robust-uniform-visible-color')
            if detail is not None:
                detail.setdefault('samples',sampling['strokePixels'])
                diagnostics['stroke']=detail
        elif diagnostics is not None:
            detail=diagnostics.setdefault('stroke',{})
            detail.setdefault('status','skipped')
            detail['reason']='insufficient-stroke-samples'
            detail['samples']=sampling['strokePixels']

    if diagnostics is not None:
        diagnostics['sampling']=sampling
    return result
