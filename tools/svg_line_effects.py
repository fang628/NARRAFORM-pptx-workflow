"""Use non-degenerate user-space paint regions for stroked SVG lines."""
import copy
import math
import re

NS = '{http://www.w3.org/2000/svg}'
LOCAL = re.compile(r'url\(#([A-Za-z0-9_-]+)\)')


def length(value):
    match = re.fullmatch(r'\s*([-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?)\s*(%|px)?\s*', str(value))
    if not match or not math.isfinite(float(match[1])):
        raise ValueError('SVG 效果区域长度无效')
    return float(match[1]), match[2] or ''


def bbox_length(value, origin, extent, coordinate=False):
    number, unit = length(value)
    if unit == 'px':
        raise ValueError('SVG objectBoundingBox 区域不能使用px')
    return (origin if coordinate else 0) + number / (100 if unit == '%' else 1) * extent


def normalize_svg_line_effects(root):
    by_id = {n.get('id'): n for n in root.iter() if n.get('id')}
    parents={child:parent for parent in root.iter() for child in parent}
    def inherited(node,attr,default):
        while node is not None:
            if attr in node.attrib:
                return node.get(attr)
            node=parents.get(node)
        return default
    defs = root.find(NS+'defs')
    repairs=[]
    for line in list(root.iter()):
        tag=line.tag.rsplit('}',1)[-1]
        if tag not in {'line','path','polyline'}:
            continue
        try:
            if tag=='line':
                points=[tuple(float(line.get(k,'0')) for k in pair) for pair in [('x1','y1'),('x2','y2')]]
            elif tag=='path':
                from svg_geometry import path_points
                points=path_points(line.get('d',''),require_closed=False)
            else:
                from svg_geometry import NUMBER
                value=line.get('points','')
                values=re.findall(NUMBER,value)
                points=list(zip(map(float,values[::2]),map(float,values[1::2]))) if len(values)%2==0 and not re.sub(NUMBER+r'|[\s,]','',value) else None
            if not points or len(points)<2 or any(not math.isfinite(n) for p in points for n in p):
                continue
            xs,ys=zip(*points)
            x1,y1,x2,y2=min(xs),min(ys),max(xs),max(ys)
            stroke=float(inherited(line,'stroke-width','1'))
        except ValueError:
            continue
        if not all(math.isfinite(n) for n in (x1,y1,x2,y2,stroke)) or stroke<=0 or x1==x2 and y1==y2 or x1!=x2 and y1!=y2:
            continue
        x,y,w,h=min(x1,x2),min(y1,y2),abs(x2-x1),abs(y2-y1)
        if not w: x-=stroke/2; w=stroke
        if not h: y-=stroke/2; h=stroke
        for attr in ('stroke','filter'):
            match=LOCAL.fullmatch(inherited(line,attr,'') if attr=='stroke' else line.get(attr,''))
            source=by_id.get(match[1]) if match else None
            if source is None:
                continue
            tag=source.tag.rsplit('}',1)[-1]
            if attr=='stroke' and (tag!='linearGradient' or source.get('gradientUnits','objectBoundingBox')!='objectBoundingBox'):
                continue
            if attr=='filter' and (tag!='filter' or source.get('filterUnits','objectBoundingBox')!='objectBoundingBox' or source.get('primitiveUnits','userSpaceOnUse')!='userSpaceOnUse'):
                continue
            # Clone the definition: another object may share the original paint.
            clone=copy.deepcopy(source)
            ident='line-effect-'+str(len(repairs))
            while ident in by_id: ident+='-local'
            clone.set('id',ident)
            if attr=='stroke':
                clone.set('gradientUnits','userSpaceOnUse')
                for key,origin,extent,default in [('x1',x,w,'0%'),('x2',x,w,'100%'),('y1',y,h,'0%'),('y2',y,h,'0%')]:
                    clone.set(key,str(bbox_length(source.get(key,default),origin,extent,True)))
            else:
                clone.set('filterUnits','userSpaceOnUse')
                for key,origin,extent,default,coord in [('x',x,w,'-10%',True),('y',y,h,'-10%',True),('width',0,w,'120%',False),('height',0,h,'120%',False)]:
                    clone.set(key,str(bbox_length(source.get(key,default),origin,extent,coord)))
            if defs is None:
                import xml.etree.ElementTree as ET
                defs=ET.SubElement(root,NS+'defs')
            defs.append(clone);by_id[ident]=clone
            line.set(attr,'url(#'+ident+')')
            repairs.append({'kind':'nondegenerate-line-'+attr,'source':match[1],'id':ident})
    return repairs
