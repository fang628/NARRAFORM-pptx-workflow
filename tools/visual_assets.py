"""Local image normalization, safe SVG validation and isolated decorative crops."""
import json, sys, math, re
from pathlib import Path
from PIL import Image, ImageDraw
import xml.etree.ElementTree as ET

Image.MAX_IMAGE_PIXELS = 40_000_000
ASPECT_RATIO_TOLERANCE = .005

# Node decodes subprocess output as UTF-8; Windows Python otherwise emits GBK
# on redirected stderr, turning useful validation messages into replacement glyphs.
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8', errors='backslashreplace')


def normalize_page(image):
    w,h = image.size
    error = abs(w*9-h*16)/(h*16)
    if error > ASPECT_RATIO_TOLERANCE+1e-12:
        raise ValueError(f'整页生图需接近 16:9；收到 {w}x{h}，比例偏差 {error:.2%} 超过 {ASPECT_RATIO_TOLERANCE:.1%}，请调整生图比例')
    scale = min(1920/w,1080/h)
    rw,rh = min(1920,max(1,round(w*scale))),min(1080,max(1,round(h*scale)))
    resized = image.resize((rw,rh),Image.Resampling.LANCZOS)
    x,y = (1920-rw)//2,(1080-rh)//2
    if (rw,rh)==(1920,1080):
        normalized=resized
    else:
        # Preserve the whole picture at a uniform scale. Extend only boundary
        # pixels into the tiny remaining margins; never crop/stretch the content.
        normalized=Image.new('RGBA',(1920,1080))
        normalized.paste(resized,(x,y))
        if x:normalized.paste(resized.crop((0,0,1,rh)).resize((x,rh)),(0,y))
        right=1920-x-rw
        if right:normalized.paste(resized.crop((rw-1,0,rw,rh)).resize((right,rh)),(x+rw,y))
        if y:normalized.paste(normalized.crop((0,y,1920,y+1)).resize((1920,y)),(0,0))
        bottom=1080-y-rh
        if bottom:normalized.paste(normalized.crop((0,y+rh-1,1920,y+rh)).resize((1920,bottom)),(0,y+rh))
    return normalized,{'sourceWidth':w,'sourceHeight':h,'width':1920,'height':1080,
                       'upscaled':scale>1,'aspectRelativeError':error,
                       'normalization':'contain-edge-pad' if (rw,rh)!=(1920,1080) else 'resize',
                       'contentBox':{'x':x,'y':y,'w':rw,'h':rh}}


def validate_svg_filters(root, view_box, raster_size):
    """Bound local vector effects; never allow feImage or external inputs."""
    primitives = {'feGaussianBlur','feDropShadow','feOffset','feFlood','feComposite','feBlend','feColorMatrix','feMerge','feMergeNode'}
    filters = [n for n in root.iter() if n.tag.rsplit('}',1)[-1] == 'filter']
    if len(filters) > 16 or sum(len(list(f.iter())) for f in filters) > 128:
        raise ValueError('SVG 滤镜数量过多')
    for f in filters:
        if f.get('filterUnits', 'objectBoundingBox') not in {'objectBoundingBox', 'userSpaceOnUse'} or f.get('primitiveUnits', 'userSpaceOnUse') not in {'objectBoundingBox', 'userSpaceOnUse'}:
            raise ValueError('SVG 滤镜坐标单位无效')
        from svg_line_effects import length
        pixels={}
        for attr, axis, default in [('x',0,'-10%'),('y',1,'-10%'),('width',0,'120%'),('height',1,'120%')]:
            number,unit=length(f.get(attr,default))
            if unit=='%' or f.get('filterUnits','objectBoundingBox')=='objectBoundingBox':
                if unit=='px':
                    raise ValueError('SVG objectBoundingBox 区域不能使用px')
                pixels[attr]=number/(100 if unit=='%' else 1)*raster_size[axis]
            else:
                origin=view_box[axis] if attr in {'x','y'} else 0
                pixels[attr]=(number-origin)/view_box[axis+2]*raster_size[axis]
            if abs(pixels[attr])>8192 or attr in {'width','height'} and pixels[attr]<=0:
                raise ValueError('SVG 滤镜区域过大或无效（按实际渲染尺寸核对）')
        if pixels['width']*pixels['height']>32_000_000:
            raise ValueError('SVG 滤镜像素区域过大')
        for node in f.iter():
            tag = node.tag.rsplit('}',1)[-1]
            if node is not f and tag not in primitives:
                raise ValueError('SVG 滤镜仅支持本地模糊、投影、颜色与合成效果')
            if tag == 'feMerge' and any(n.tag.rsplit('}',1)[-1] != 'feMergeNode' for n in node):
                raise ValueError('SVG feMerge 子节点无效')
            if tag in {'feGaussianBlur','feDropShadow'}:
                try:
                    values = [float(v) for v in node.get('stdDeviation','0').replace(',', ' ').split()]
                except ValueError:
                    raise ValueError('SVG 模糊半径无效')
                if not 1 <= len(values) <= 2 or any(not math.isfinite(v) or v < 0 or v > min(64, max(view_box[2:]) / 4) for v in values):
                    raise ValueError('SVG 模糊半径过大或无效')
            for attr in ('in','in2','result'):
                if node.get(attr) and not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]*', node.get(attr)):
                    raise ValueError('SVG 滤镜输入必须是本地结果')

def main():
    op, source, target = sys.argv[1:4]
    if op == 'svg':
        text = Path(source).read_text(encoding='utf-8')
        if '<!' in text or '<?' in text or len(text) > 180000:
            raise ValueError('SVG contains declarations or is too large')
        root = ET.fromstring(text)
        tags = {'svg','g','defs','path','rect','circle','ellipse','line','polyline','polygon','linearGradient','radialGradient','stop','clipPath','mask','pattern'}
        tags.update({'filter','feGaussianBlur','feDropShadow','feOffset','feFlood','feComposite','feBlend','feColorMatrix','feMerge','feMergeNode'})
        attrs = {'viewBox','width','height','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','d','points','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','fill-rule','clip-rule','opacity','fill-opacity','stroke-opacity','transform','id','offset','stop-color','stop-opacity','gradientUnits','gradientTransform','fx','fy','clip-path','mask','preserveAspectRatio','version'}
        attrs.update({'patternUnits','patternContentUnits','patternTransform'})
        attrs.update({'filter','filterUnits','primitiveUnits','color-interpolation-filters','in','in2','result','stdDeviation','dx','dy','flood-color','flood-opacity','operator','k1','k2','k3','k4','mode','type','values'})
        if root.tag != '{http://www.w3.org/2000/svg}svg':
            raise ValueError('SVG needs an SVG namespace')
        vb = [float(v) for v in root.get('viewBox','').replace(',',' ').split()]
        if len(vb) != 4 or not all(math.isfinite(v) for v in vb) or min(vb[2:]) <= 0:
            raise ValueError('SVG needs a valid viewBox')
        for node in root.iter():
            tag = node.tag.rsplit('}',1)[-1]
            if node.tag != '{http://www.w3.org/2000/svg}'+tag or tag not in tags:
                raise ValueError(f'SVG 包含不支持的标签：{tag}；仅允许非文字矢量图形')
            if (node.text or '').strip() or (node.tail or '').strip():
                raise ValueError('SVG 素材不得包含文字内容')
            for key, val in node.attrib.items():
                if key not in attrs or any(v in val.lower() for v in ['javascript:', 'data:', 'http:', 'https:', '@import', 'expression(', 'file:']):
                    raise ValueError('SVG contains unsafe attributes or external resources')
                if 'url(' in val and not re.fullmatch(r'url\(#[A-Za-z0-9_-]+\)', val):
                    raise ValueError('SVG references must be local')
        from svg_colors import normalize_svg_colors
        color_repairs=normalize_svg_colors(root)
        width,height=[int(v) for v in sys.argv[4:6]]
        if not 1<=width<=1920 or not 1<=height<=1080:raise ValueError('Invalid vector raster bounds')
        validate_svg_filters(root, vb, (width,height))
        from svg_line_effects import normalize_svg_line_effects
        line_repairs=normalize_svg_line_effects(root)
        if line_repairs:
            validate_svg_filters(root, vb, (width,height))
        from svg_geometry import normalize_svg_hexagons
        geometry_repairs = normalize_svg_hexagons(root, json.loads(sys.argv[6]) if len(sys.argv)>6 else {})
        ET.register_namespace('', 'http://www.w3.org/2000/svg')
        root.set('width',str(width));root.set('height',str(height))
        Path(target).write_text(ET.tostring(root,encoding='unicode'), encoding='utf-8')
        print(json.dumps({'valid':True, **({'colorRepairs':color_repairs} if color_repairs else {}), **({'geometryRepairs':geometry_repairs} if geometry_repairs else {}), **({'lineEffectRepairs':line_repairs} if line_repairs else {})}))
        return
    with Image.open(source) as raw:
        raw.load()
        image = raw.convert('RGBA')
    if op == 'reference-cutout':
        from reference_cutout import reference_cutout
        with Image.open(sys.argv[4]) as background:
            background.load()
            image, report = reference_cutout(image, background, len(sys.argv)>5 and sys.argv[5]=='artistic')
        image.save(target)
        print(json.dumps(report))
    elif op == 'cutout':
        from cutout_alpha import prepare_cutout
        image, report = prepare_cutout(image, len(sys.argv)>4 and sys.argv[4]=='artistic')
        image.save(target)
        print(json.dumps(report))
    elif op == 'alpha':
        extrema=image.getchannel('A').getextrema()
        print(json.dumps({'width':image.width,'height':image.height,'hasTransparency':extrema[0]<255,'hasVisiblePixels':extrema[1]>0}))
    elif op == 'inspect':
        print(json.dumps({'width':image.width,'height':image.height}))
    elif op == 'normalize':
        normalized,report=normalize_page(image)
        normalized.save(target)
        print(json.dumps(report))
    elif op == 'copy':
        image.save(target)
        print(json.dumps({'width':image.width,'height':image.height}))
    elif op == 'crop':
        spec=json.loads(Path(sys.argv[4]).read_text(encoding='utf-8'))
        x,y,w,h=spec['box']; sx,sy=image.width/1600,image.height/900
        image=image.crop((round(x*sx),round(y*sy),round((x+w)*sx),round((y+h)*sy)))
        if spec.get('mask'):
            mask=Image.new('L', image.size,0)
            ImageDraw.Draw(mask).polygon([(round(a*image.width),round(b*image.height)) for a,b in spec['mask']], fill=255)
            image.putalpha(mask)
        image.save(target)
        import hashlib
        pixel_hash=hashlib.sha256(f'{image.width}x{image.height}:RGBA:'.encode()+image.tobytes()).hexdigest()
        print(json.dumps({'width':image.width,'height':image.height,'masked':bool(spec.get('mask')),'pixelHash':pixel_hash}))

if __name__ == '__main__':
    main()
