"""Local image normalization, safe SVG validation and isolated decorative crops."""
import json, sys, math
from pathlib import Path
from PIL import Image, ImageDraw
import xml.etree.ElementTree as ET

Image.MAX_IMAGE_PIXELS = 40_000_000

def main():
    op, source, target = sys.argv[1:4]
    if op == 'svg':
        text = Path(source).read_text(encoding='utf-8')
        if '<!' in text or '<?' in text or len(text) > 180000:
            raise ValueError('SVG contains declarations or is too large')
        root = ET.fromstring(text)
        tags = {'svg','g','defs','path','rect','circle','ellipse','line','polyline','polygon','linearGradient','radialGradient','stop','clipPath','mask'}
        attrs = {'viewBox','width','height','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','d','points','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','fill-rule','clip-rule','opacity','fill-opacity','stroke-opacity','transform','id','offset','stop-color','stop-opacity','gradientUnits','gradientTransform','fx','fy','clip-path','mask','preserveAspectRatio','version'}
        if root.tag != '{http://www.w3.org/2000/svg}svg':
            raise ValueError('SVG needs an SVG namespace')
        vb = [float(v) for v in root.get('viewBox','').replace(',',' ').split()]
        if len(vb) != 4 or not all(math.isfinite(v) for v in vb) or min(vb[2:]) <= 0:
            raise ValueError('SVG needs a valid viewBox')
        for node in root.iter():
            if node.tag.rsplit('}',1)[-1] not in tags or (node.text or '').strip() or (node.tail or '').strip():
                raise ValueError('SVG may only contain non-text vector geometry')
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
    if op == 'alpha':
        extrema=image.getchannel('A').getextrema()
        print(json.dumps({'width':image.width,'height':image.height,'hasTransparency':extrema[0]<255,'hasVisiblePixels':extrema[1]>0}))
    elif op == 'inspect':
        print(json.dumps({'width':image.width,'height':image.height}))
    elif op == 'normalize':
        w,h = image.size
        if w*9 != h*16:
            raise ValueError(f'整页生图必须返回 16:9；收到 {w}x{h}，请调整生图比例')
        image.resize((1920,1080),Image.Resampling.LANCZOS).save(target)
        print(json.dumps({'sourceWidth':w,'sourceHeight':h,'width':1920,'height':1080,'upscaled':w<1920}))
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
        print(json.dumps({'width':image.width,'height':image.height,'masked':bool(spec.get('mask'))}))

if __name__ == '__main__':
    main()
