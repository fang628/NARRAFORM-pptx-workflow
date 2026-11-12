"""Header-only contact sheet and observed PNG colors for native navigation."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw
import cv2
import numpy as np
from progress_effects import observed_effects


def palette(image):
    quantized = image.convert('RGB').quantize(colors=96)
    colors = quantized.getpalette()
    return [(count, tuple(colors[index*3:index*3+3])) for count, index in sorted(quantized.getcolors(), reverse=True)]


def clamp(value):
    return max(0.0, min(1.0, float(value)))


def fill_palette(image):
    """Broad interior surfaces, excluding thin glyphs, dividers and highlights."""
    rgb=np.asarray(image.convert('RGB'))
    if min(rgb.shape[:2])<5:return palette(image)
    smooth=cv2.medianBlur(rgb,9)
    detail=np.max(np.abs(rgb.astype(np.int16)-smooth.astype(np.int16)),axis=2)>22
    detail=cv2.dilate(detail.astype(np.uint8),np.ones((3,3),np.uint8))>0
    margin_y=max(1,round(rgb.shape[0]*.15));margin_x=max(1,round(rgb.shape[1]*.03))
    usable=~detail;usable[:margin_y]=False;usable[-margin_y:]=False
    usable[:,:margin_x]=False;usable[:,-margin_x:]=False
    pixels=rgb[usable]
    if len(pixels)<12:return palette(image)
    return palette(Image.fromarray(pixels.reshape(1,-1,3)))


def observed_outline(image, box, count, active):
    """Require narrow, continuous bright ridges at both outer horizontal edges.

    Use overscan so a tight navigation box does not clip off its bright stroke.
    A solid fill transition, text, or a one-sided highlight is not an outline.
    """
    if not 1 <= count <= 12 or not 0 <= active < count:
        return None
    x,y,w,h=box
    padding=max(5,round(h*.18))
    left=max(0,round(x));right=min(image.width,round(x+w))
    top=max(0,round(y)-padding);bottom=min(image.height,round(y+h)+padding)
    pixels=np.asarray(image.crop((left,top,right,bottom)),np.float32)
    if min(pixels.shape[:2])<8:
        return None
    offset=y-top
    widths=[];borders={};evidence=[]
    weights=np.array([.2126,.7152,.0722])
    for index in range(count):
        start=round((index+.22)*(right-left)/count);end=round((index+.78)*(right-left)/count)
        strip=pixels[:,start:end]
        if strip.shape[1]<8:continue
        # Robust row medians suppress glyph columns and vertical separators.
        profile=np.median(strip@weights,axis=1)
        candidates=[]
        for edge in (offset,offset+h):
            lo=max(2,round(edge-padding));hi=min(len(profile)-2,round(edge+padding)+1)
            if hi<=lo:continue
            peak=lo+int(np.argmax(profile[lo:hi]))
            radius=max(3,min(padding,6))
            if peak-radius<0 or peak+radius>=len(profile):continue
            base=max(profile[peak-radius],profile[peak+radius])
            prominence=float(profile[peak]-base)
            if prominence<9:continue
            coverage=float(((strip[peak]@weights)-base>prominence*.5).mean())
            if coverage<.55:continue
            high=base+prominence*.5;a=b=peak
            while a>0 and profile[a-1]>=high:a-=1
            while b+1<len(profile) and profile[b+1]>=high:b+=1
            width=b-a+1
            if width>max(8,h*.16):continue
            colour=np.median(strip[peak],axis=0)
            candidates.append((width,colour,prominence,coverage))
        if len(candidates)!=2:continue
        width=float(np.median([c[0] for c in candidates]))*1600/image.width
        colour=np.median([c[1] for c in candidates],axis=0).round().astype(int)
        state='activeBorder' if index==active else 'completedBorder' if index<active else 'border'
        borders.setdefault(state,[]).append(colour);widths.append(width)
        evidence.append({'segment':index,'state':state,'width':round(width,3),
                         'support':round(min(c[3] for c in candidates),3)})
    if not widths:return None
    result={key:'%02X%02X%02X'%tuple(np.median(values,axis=0).round().astype(int)) for key,values in borders.items()}
    # An absent state may reuse an observed outline, but never a text/fill colour.
    fallback=result.get('border') or result.get('completedBorder') or result.get('activeBorder')
    for key in ('border','completedBorder','activeBorder'):result.setdefault(key,fallback)
    return {**result,'strokeWidth':round(min(3,max(.3,float(np.median(widths)))),3),
            'evidence':evidence}


def sampled_appearance(crop,spec):
    all_colours=[c for _,c in palette(crop)]
    fills=[c for _,c in fill_palette(crop)]
    def rgb(value):return tuple(int(value[i:i+2],16) for i in (0,2,4))
    def hexa(value):return '%02X%02X%02X'%tuple(value)
    def nearest(value,pool):
        target=rgb(value);chosen=min(pool or all_colours,key=lambda c:sum((a-b)**2 for a,b in zip(c,target)))
        # Quantisation assists observation; it cannot replace a valid inferred
        # state with an unrelated surface merely because that state is absent.
        return hexa(chosen) if sum((a-b)**2 for a,b in zip(chosen,target))<=55**2 else value
    def luminance(c):
        values=[v/255 for v in c];linear=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in values]
        return sum(a*b for a,b in zip(linear,(.2126,.7152,.0722)))
    def contrast(a,b):
        first,second=luminance(a),luminance(b)
        return (max(first,second)+.05)/(min(first,second)+.05)
    result={}
    fill_keys={'accent','track','completedFill'}
    for key,value in spec['colors'].items():
        pool=fills if key in fill_keys else all_colours
        if key in ('ink','muted','indicatorInk'):
            fill=spec['colors'].get('accent' if key=='indicatorInk' else 'track')
            if fill:
                text=[c for c in all_colours if contrast(c,rgb(fill))>=4.5]
                if text:pool=text
        result[key]=nearest(value,pool)
    appearance=None
    count=int(spec.get('sectionCount') or 0);active=int(spec.get('currentIndex',-1))
    if spec.get('inferStates') and 0<=active<count<=12:
        surfaces=[]
        for i in range(count):
            segment=crop.crop((round((i+.12)*crop.width/count),0,round((i+.88)*crop.width/count),crop.height))
            surfaces.append(fill_palette(segment)[0][1])
        # Missing states reuse another observed segment surface; no pale default.
        track=surfaces[min(count-1,active+1)] if active<count-1 else surfaces[max(0,active-1)]
        complete=surfaces[active-1] if active>0 else track
        accent=surfaces[active]
        def ink(surface):return hexa(max(all_colours,key=lambda c:contrast(c,surface)))
        appearance={**result,'accent':hexa(accent),'track':hexa(track),'completedFill':hexa(complete),
                    'ink':ink(track),'muted':ink(track),'indicatorInk':ink(accent),
                    'border':hexa(track),'completedBorder':hexa(complete),'activeBorder':hexa(accent)}
    return {'colors':result,'appearance':appearance,
            'sampling':'interior-fill-glyph-exclusion-and-state-regions'}


def shape_features(contour, height):
    """Shape language cues: rounded bubbles are convex and fill their box;
    chevrons/arrows have concave notches and a lower solidity/fill ratio."""
    area = abs(cv2.contourArea(contour))
    hull = cv2.convexHull(contour)
    hull_area = abs(cv2.contourArea(hull))
    solidity = clamp(area / hull_area) if hull_area else 1.0
    concavity = 0.0
    defects = 0
    try:
        hull_index = cv2.convexHull(contour, returnPoints=False)
        if hull_index is not None and len(hull_index) >= 4 and len(contour) >= 4:
            defect = cv2.convexityDefects(contour, hull_index)
            if defect is not None:
                depths = [float(item[0][3]) / 256.0 for item in defect]
                concavity = min(1.0, max(depths, default=0.0) / max(1.0, height))
                defects = sum(1 for depth in depths if depth / max(1.0, height) > .06)
    except cv2.error:
        pass
    try:
        x, y, w, h = cv2.boundingRect(contour)
        fill = clamp(area / max(1.0, w*h))
    except Exception:
        fill = 0.0
    vertices = len(cv2.approxPolyDP(contour, cv2.arcLength(contour, True)*.02, True))
    return {'solidity': solidity, 'concavity': concavity, 'defects': defects,
            'sharp_vertices': vertices, 'fill': fill}


def navigation_score(header, full_size, layout):
    edges = cv2.Canny(np.array(header.convert('L')), 35, 110)
    # Close anti-aliased sharp polygon corners before contouring. Without this,
    # filled chevrons/arrows often yield thin open edge fragments while rounded
    # bubbles remain closed loops, which would bias shape matching.
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if h < header.height*.08 or w < header.width*.055 or w/h < 1.4 or h > header.height*.65:
            continue
        vertices = len(cv2.approxPolyDP(contour, cv2.arcLength(contour, True)*.02, True))
        if not 3 <= vertices <= 14:
            continue
        if not any(abs(x-a)+abs(y-b)+abs(w-c)+abs(h-d)<12 for a,b,c,d in boxes):
            boxes.append((x,y,w,h))
    # Detect a repeated horizontal row first, then rank that row by requested
    # shape language. A high raw contour count of unrelated header shapes must not
    # outrank a real chevron/bubble row.
    rows = []
    for seed in boxes:
        center = seed[1]+seed[3]/2
        aligned = [b for b in boxes if abs(b[1]+b[3]/2-center) <= max(4, seed[3]*.25)
                   and .65 <= b[3]/seed[3] <= 1.5]
        # Edge detection often returns both the inner and outer outline.
        segments = []
        for b in sorted(aligned, key=lambda b: b[2]*b[3], reverse=True):
            if not any(min(b[0]+b[2], a[0]+a[2])-max(b[0], a[0]) > min(b[2], a[2])*.6 for a in segments):
                segments.append(b)
        if len(segments) < 3:
            continue
        left, top = min(b[0] for b in segments), min(b[1] for b in segments)
        right, bottom = max(b[0]+b[2] for b in segments), max(b[1]+b[3] for b in segments)
        if right-left < full_size[0]*.2:
            continue
        features = []
        for b in segments:
            contour = next((c for c in contours if tuple(cv2.boundingRect(c)) == b), None)
            if contour is None:
                continue
            features.append(shape_features(contour, b[3]))
        if len(features) < 3:
            continue
        avg = {key: sum(f[key] for f in features)/len(features) for key in features[0]}
        bubble_fit = clamp(0.46 + (avg['solidity'] - .88) * 2.4 + (1 - min(1, avg['concavity']/.12)) * .42 - abs(avg['fill'] - .9) * .28)
        chevron_fit = clamp(.32 + min(1, avg['concavity']/.16) * .55 + min(1, avg['defects']/2) * .13 + min(1, avg['sharp_vertices']/6) * .08)
        requested = chevron_fit if layout == 'chevron' else bubble_fit
        detected = 'chevron' if chevron_fit > bubble_fit else 'bubble'
        coverage = min(1, (right-left)/(full_size[0]*.55))
        confidence = requested * min(1, len(features)/4) * (.82 + .18*coverage)
        rows.append({'segments': len(segments), 'x': left, 'y': top, 'w': right-left, 'h': bottom-top,
                     'match': requested, 'confidence': confidence, 'detected': detected,
                     'bubbleFit': bubble_fit, 'chevronFit': chevron_fit})
    if not rows:
        return {'score': 0, 'box': None, 'matchScore': 0, 'detectedLayout': None, 'segmentCount': 0, 'rowConfidence': 0}
    best = max(rows, key=lambda r: (r['confidence'], r['segments'], r['w'], -r['y']))
    # score remains an integer ranking value used by the existing fallback sort;
    # matchScore exposes the normalized shape fit for newer callers.
    return {'score': int(round(best['confidence']*100)), 'box': [best['x']/full_size[0], best['y']/full_size[1], best['w']/full_size[0], best['h']/full_size[1]],
            'matchScore': round(best['match']*100, 1), 'detectedLayout': best['detected'],
            'segmentCount': best['segments'], 'rowConfidence': round(best['confidence']*100, 1),
            'bubbleFit': round(best['bubbleFit']*100, 1), 'chevronFit': round(best['chevronFit']*100, 1)}



def main():
    spec = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    output = Path(sys.argv[2])
    if spec['operation'] == 'montage':
        columns, width, height = 2, 960, 213
        sheet = Image.new('RGB', (columns*width, ((len(spec['pages'])+1)//columns)*height), '#eeeeee')
        draw = ImageDraw.Draw(sheet)
        candidates = []
        for n, page in enumerate(spec['pages']):
            with Image.open(page['file']) as source:
                source = source.convert('RGB')
                header = source.crop((0, 0, source.width, round(source.height*.35)))
                tile = header.resize((width, height-24))
                x, y = n % columns*width, n // columns*height
                sheet.paste(tile, (x, y+24))
                draw.text((x+8, y+5), 'P'+str(page['index']+1), fill='#222222')
                nav = navigation_score(header, source.size, spec.get('layout','chevron'))
                palette_source = header
                if nav.get('box'):
                    bx, by, bw, bh = nav['box']
                    box_px = (round(bx*source.width), round(by*source.height),
                              round((bx+bw)*source.width), round((by+bh)*source.height))
                    if box_px[2] - box_px[0] >= 12 and box_px[3] - box_px[1] >= 6:
                        palette_source = source.crop(box_px)
                colors = palette(palette_source)
                # A local fallback uses one source page and the detected row region,
                # never the full header title/decor palette.
                colorful = [(count, color) for count, color in colors if max(color)-min(color)>30]
                candidates.append({'index': page['index'], **nav, 'colors': ['%02X%02X%02X' % c for _, c in colors[:96]],
                                   'fillColors':['%02X%02X%02X'%c for _,c in fill_palette(palette_source)],
                                   'accent': '%02X%02X%02X' % (colorful[0][1] if colorful else colors[min(1,len(colors)-1)][1])})
        sheet.save(output)
        print(json.dumps({'candidates': candidates}))
    else:
        with Image.open(spec['file']) as source:
            source = source.convert('RGB')
            x, y, w, h = spec.get('box', [0, 0, 1, .18])
            crop = source.crop((round(x*source.width), round(y*source.height), round((x+w)*source.width), round((y+h)*source.height)))
            crop.save(output)
            sampled=sampled_appearance(crop,spec)
            effects,evidence=observed_effects(source,(x*source.width,y*source.height,w*source.width,h*source.height),
                                               int(spec.get('sectionCount') or 0),int(spec.get('currentIndex',-1)))
            sampled['effects']=effects;sampled['effectEvidence']=evidence
            if spec.get('inferStates'):
                outline=observed_outline(source,(x*source.width,y*source.height,w*source.width,h*source.height),
                                         int(spec.get('sectionCount') or 0),int(spec.get('currentIndex',-1)))
                if outline:
                    patch={key:value for key,value in outline.items() if key!='evidence'}
                    if sampled['appearance'] is not None:sampled['appearance'].update(patch)
                    sampled['outlineEvidence']=outline['evidence']
            print(json.dumps(sampled))


if __name__ == '__main__':
    main()
