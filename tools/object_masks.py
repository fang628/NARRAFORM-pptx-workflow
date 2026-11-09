"""Object alpha evidence. Never equate a hollow/unknown object with its bbox."""
from functools import lru_cache
import math
import cv2
import numpy as np
from PIL import Image


@lru_cache(maxsize=8)
def _read_alpha(file, size):
    with Image.open(file) as im:
        return np.asarray(im.convert('RGBA').getchannel('A').resize(size, Image.Resampling.BILINEAR))


def object_alpha(element, entries=None, size=(1600, 900), polygon=None):
    entry=(entries or {}).get(element.get('key'))
    if entry and entry.get('file'):
        try:return _read_alpha(entry['file'],tuple(size))
        except (OSError, ValueError):return None
    if element.get('type') not in ('rect','ellipse','shape','line'):
        return None
    if polygon is None:
        if element.get('type') in ('rect','ellipse'):
            x,y,w,h=[float(element.get(k,0)) for k in ('x','y','w','h')]
            polygon=([[x,y],[x+w,y],[x+w,y+h],[x,y+h]] if element['type']=='rect' else
                     [[x+w/2+w/2*math.cos(t),y+h/2+h/2*math.sin(t)] for t in np.linspace(0,2*math.pi,96,endpoint=False)])
        elif element.get('type')=='shape':
            # Shared seed geometry is a fallback for standalone CLI callers;
            # the application supplies exact masks from its native renderer.
            from shape_reference import seed_polygon
            polygon=seed_polygon(element)
        else:
            x,y,w,h=[float(element.get(k,0)) for k in ('x','y','w','h')]
            polygon=[[x,y],[x+w,y+h]]
    if not polygon:return None
    sx,sy=size[0]/1600,size[1]/900
    points=np.rint(np.array(polygon)*[sx,sy]).astype(np.int32).reshape(-1,1,2)
    mask=np.zeros(size[::-1],np.uint8)
    opacity=float(element.get('opacity',1))
    fill=float(element.get('fillOpacity',1))*opacity
    width=float(element.get('strokeWidth',0))
    if element.get('type')!='line' and fill>0:
        cv2.fillPoly(mask,[points],int(np.clip(fill*255,0,255)))
    if width>0:
        stroke=np.zeros_like(mask)
        cv2.polylines(stroke,[points],element.get('type')!='line',int(np.clip(float(element.get('colorOpacity',1))*opacity*255,0,255)),max(1,round(width*(sx+sy)/2)))
        mask=np.maximum(mask,stroke)
    return mask


def mask_entries(spec):
    return {entry['key']:entry for entry in spec.get('objectMasks',[]) if isinstance(entry,dict) and entry.get('key')}


def crop_alpha(mask, region, size):
    x,y,w,h=[region[k] for k in ('x','y','w','h')]
    return np.asarray(Image.fromarray(mask).resize(size,Image.Resampling.BILINEAR,
        box=(x*mask.shape[1]/1600,y*mask.shape[0]/900,(x+w)*mask.shape[1]/1600,(y+h)*mask.shape[0]/900)))
