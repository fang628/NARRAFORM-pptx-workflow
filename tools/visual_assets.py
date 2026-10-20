"""Local image normalization, safe SVG validation and isolated decorative crops."""
import json, sys, math
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

def main():
    op, source, target = sys.argv[1:4]
    if op == 'svg':
        text = Path(source).read_text(encoding='utf-8')
        if '<!' in text or '<?' in text or len(text) > 180000:
            raise ValueError('SVG contains declarations or is too large')
        root = ET.fromstring(text)
        tags = {'svg','g','defs','path','rect','circle','ellipse','line','polyline','polygon','linearGradient','radialGradient','stop','clipPath','mask','pattern'}
        attrs = {'viewBox','width','height','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','d','points','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','fill-rule','clip-rule','opacity','fill-opacity','stroke-opacity','transform','id','offset','stop-color','stop-opacity','gradientUnits','gradientTransform','fx','fy','clip-path','mask','preserveAspectRatio','version'}
        attrs.update({'patternUnits','patternContentUnits','patternTransform'})
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
                if 'url(' in val and not __import__('re').fullmatch(r'url\(#[A-Za-z0-9_-]+\)', val):
                    raise ValueError('SVG references must be local')
        ET.register_namespace('', 'http://www.w3.org/2000/svg')
        width,height=[int(v) for v in sys.argv[4:6]]
        if not 1<=width<=1920 or not 1<=height<=1080:raise ValueError('Invalid vector raster bounds')
        root.set('width',str(width));root.set('height',str(height))
        Path(target).write_text(ET.tostring(root,encoding='unicode'), encoding='utf-8')
        print(json.dumps({'valid':True}))
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
        image, report = prepare_cutout(image)
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
