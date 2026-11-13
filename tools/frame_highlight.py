"""Fit a frame-owned edge highlight as a native fill colour profile."""
import numpy as np


def fit_frame_highlight(reference,element,lower,front=None):
    hint=element.get('edgeHighlight') or {};edge=hint.get('edge')
    if edge not in ('top','bottom','left','right'):return {},{'status':'not-applicable'}
    if 'fill' in element.get('keepParameters',[]):return {},{'status':'kept','reason':'fill-locked'}
    if float(element.get('opacity',1))*float(element.get('fillOpacity',1))<.98:
        return {},{'status':'kept','reason':'transparent-frame-requires-demixing'}
    x,y,w,h=[float(element[k]) for k in ('x','y','w','h')]
    vertical=edge in ('top','bottom');span=h if vertical else w
    positions=sorted(set([0.,min(.025,2/max(1,span)),min(.08,6/max(1,span)),.15,.35,.65,.85,1.]))
    if edge in ('bottom','right'):positions=sorted(1-t for t in positions)
    rows=[];brightness=[]
    for t in positions:
        u=np.linspace(.15,.85,100)
        xx=np.rint(x+(u*w if vertical else np.full_like(u,t*w))).astype(int)
        yy=np.rint(y+(np.full_like(u,t*h) if vertical else u*h)).astype(int)
        xx=np.clip(xx,0,1599);yy=np.clip(yy,0,899)
        keep=np.ones(len(xx),bool) if front is None else front[yy,xx]<8
        if keep.sum()<30:return {},{'status':'kept','reason':'edge-occluded'}
        pixels=reference[yy[keep],xx[keep]].astype(float)
        color=np.median(pixels,axis=0);brightness.append(float(np.dot(color,[.2126,.7152,.0722])))
        rows.append({'position':float(t),'color':''.join(f'{round(v):02X}' for v in color),'opacity':1})
    target=0 if edge in ('top','left') else -1
    # S3's contour is a geometric boundary, while the bright ridge can lie a
    # few pixels inside it. Search its own normal profile rather than the seed row.
    ridge=[]
    u=np.linspace(.15,.85,100)
    for offset in np.arange(-2,7,.5):
        at=offset if target==0 else span-offset
        xx=np.rint(x+(u*w if vertical else np.full_like(u,at))).astype(int)
        yy=np.rint(y+(np.full_like(u,at) if vertical else u*h)).astype(int)
        xx=np.clip(xx,0,1599);yy=np.clip(yy,0,899)
        keep=np.ones(len(xx),bool) if front is None else front[yy,xx]<8
        if keep.sum()<30:continue
        color=np.median(reference[yy[keep],xx[keep]],axis=0)
        ridge.append((float(np.dot(color,[.2126,.7152,.0722])),color))
    if ridge:
        brightness[target],color=max(ridge,key=lambda item:item[0])
        rows[target]['color']=''.join(f'{round(v):02X}' for v in color)
    if brightness[target]<np.median(brightness)+12:return {},{'status':'kept','reason':'no-bright-edge-evidence'}
    # A frame highlight is baked into the frame's fill, never an added line or SVG.
    return {'gradient':{'type':'linear','angle':90 if vertical else 0,'stops':rows},'fillOpacity':1}, {'status':'accepted','edge':edge,'source':'frame-reference-profile'}
