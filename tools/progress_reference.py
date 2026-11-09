"""Header-only contact sheet and observed PNG colors for native navigation."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw
import cv2
import numpy as np


def palette(image):
    quantized = image.convert('RGB').quantize(colors=96)
    colors = quantized.getpalette()
    return [(count, tuple(colors[index*3:index*3+3])) for count, index in sorted(quantized.getcolors(), reverse=True)]


def clamp(value):
    return max(0.0, min(1.0, float(value)))


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
                candidates.append({'index': page['index'], **nav, 'colors': ['%02X%02X%02X' % c for _, c in colors[:96]], 'accent': '%02X%02X%02X' % (colorful[0][1] if colorful else colors[min(1,len(colors)-1)][1])})
        sheet.save(output)
        print(json.dumps({'candidates': candidates}))
    else:
        with Image.open(spec['file']) as source:
            source = source.convert('RGB')
            x, y, w, h = spec.get('box', [0, 0, 1, .18])
            crop = source.crop((round(x*source.width), round(y*source.height), round((x+w)*source.width), round((y+h)*source.height)))
            colors = [c for _, c in palette(crop)]
            snapped = {}
            for key, value in spec['colors'].items():
                target = tuple(int(value[i:i+2],16) for i in (0,2,4))
                color = min(colors, key=lambda c: sum((a-b)**2 for a,b in zip(c,target)))
                snapped[key] = '%02X%02X%02X' % color
            crop.save(output)
            print(json.dumps({'colors': snapped}))


if __name__ == '__main__':
    main()
