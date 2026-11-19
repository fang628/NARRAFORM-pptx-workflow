"""Locate approved preview navigation and sample only the selected row."""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

from progress_geometry import HIGH_CONFIDENCE, locate_progress


def registered_background(page, size):
    if not page.get('background'):
        return None
    try:
        with Image.open(page['background']) as image:
            if abs(image.width / image.height - size[0] / size[1]) > .005:
                return None
            return image.convert('RGB').resize(size, Image.Resampling.BILINEAR)
    except OSError:
        return None


def locate_pages(pages, layout, output):
    candidates = []
    for page in pages:
        try:
            with Image.open(page['file']) as source:
                background = registered_background(page, source.size)
                geometry = locate_progress(source, layout, page['labels'], page['active'], background)
        except OSError:
            continue
        candidates.append({'index': page['index'], 'geometry': geometry})
    by_index = {page['index']: page for page in pages}

    def rank(candidate):
        page = by_index[candidate['index']]
        confidence = (candidate['geometry'] or {}).get('confidence', 0)
        all_states = 0 < page['active'] < len(page['labels']) - 1
        return (confidence >= HIGH_CONFIDENCE, confidence + .06*all_states, -page['pageNumber'])

    candidates.sort(key=rank, reverse=True)
    shortlist = candidates[:4]
    if shortlist and not rank(shortlist[0])[0]:
        width, height = 960, 200
        sheet = Image.new('RGB', (width, height*len(shortlist)), '#eeeeee')
        draw = ImageDraw.Draw(sheet)
        for row, candidate in enumerate(shortlist):
            page = by_index[candidate['index']]
            with Image.open(page['file']) as source:
                header = source.crop((0, 0, source.width, round(source.height*.35)))
                sheet.paste(header.resize((width, height-24)), (0, row*height+24))
            draw.text((8, row*height+5), f"P{page['pageNumber']} | index {page['index']} | active {page['active']+1}/{len(page['labels'])}", fill='#222222')
        sheet.save(output)
    return {'candidates': candidates, 'shortlist': [candidate['index'] for candidate in shortlist]}


def measure_page(page, layout, output, geometry=None, hint=None):
    from progress_sampling import measure_progress

    with Image.open(page['file']) as source:
        source = source.convert('RGB')
        background = registered_background(page, source.size)
        geometry = geometry or locate_progress(source, layout, page['labels'], page['active'], background, hint)
        if geometry is None:
            return {}
        x, y, w, h = geometry['box']
        source.crop((round(x*source.width), round(y*source.height), round((x+w)*source.width), round((y+h)*source.height))).save(output)
        return {'geometry': geometry, **measure_progress(source, geometry, page['active'], background)}


def main():
    spec = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    output = Path(sys.argv[2])
    if spec['operation'] == 'locate':
        result = locate_pages(spec['pages'], spec['layout'], output)
    elif spec['operation'] == 'measure':
        result = measure_page(spec['page'], spec['layout'], output, spec.get('geometry'), spec.get('hint'))
    else:
        raise ValueError('Unknown progress reference operation')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
