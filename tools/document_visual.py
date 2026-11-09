"""Render PDF analysis pages; extract PPTX media directly from the package."""
import contextlib
import io
import json
import pathlib
import re
import sys
import zipfile
from PIL import Image

FIGURE_CAPTION = re.compile(r'^\s*(?:(?:图|圖)\s*[0-9]|(?:figure|fig\.?)\s*[0-9])', re.I)
TABLE_CAPTION = re.compile(r'^\s*(?:表|table|tab\.?)\s*[0-9]', re.I)
PANEL_LABEL = re.compile(r'^\s*(?:[（(]\s*(?:[a-zA-Z]|[0-9]{1,2}|[ivxIVX]{1,4})\s*[)）]|[a-zA-Z][)）]|[a-zA-Z](?:[.、])?)\s*[:：.]?\s*\S{0,30}$')


def _norm_box(x0, y0, x1, y1, width, height):
    x = min(1000.0, max(0.0, x0 / width * 1000))
    y = min(1000.0, max(0.0, y0 / height * 1000))
    return {'x': round(x, 2), 'y': round(y, 2),
            'w': round(min(1000.0 - x, max(0.0, (x1 - x0) / width * 1000)), 2),
            'h': round(min(1000.0 - y, max(0.0, (y1 - y0) / height * 1000)), 2)}


def pdf_text_anchors(page):
    """Real figure-caption anchors and short panel labels from the PDF text layer.

    Only anchors are returned: nearby body text is never collected here. Table captions are
    excluded so they cannot be mistaken for figures. A real caption often wraps to following
    lines or separate text blocks (e.g. "(a) treatment / (b) control"); consecutive lines are
    collected by line gap, horizontal alignment and bounded length so multi-panel evidence is
    not lost. Long body lines never join a caption.
    """
    width, height = max(1.0, page.rect.width), max(1.0, page.rect.height)
    captions, panels = [], []
    try:
        data = page.get_text('dict')
    except Exception:
        return captions, panels
    lines = []
    for block in data.get('blocks', []):
        if block.get('type') != 0:
            continue
        for line in block.get('lines', []):
            text = ''.join(span.get('text', '') for span in line.get('spans', [])).strip()
            bbox = line.get('bbox')
            if text and bbox and len(bbox) == 4:
                box = [float(value) for value in bbox]
                lines.append((text, box, max(1.0, box[3] - box[1])))
    lines.sort(key=lambda item: (round(item[1][1], 1), item[1][0]))
    consumed = set()
    index = 0
    while index < len(lines):
        text, bbox, line_height = lines[index]
        if TABLE_CAPTION.match(text) or not FIGURE_CAPTION.match(text):
            index += 1
            continue
        collected, total = [(text, bbox)], len(text)
        consumed.add(index)
        index += 1
        while index < len(lines) and len(collected) < 8 and total < 700:
            next_text, next_bbox, next_height = lines[index]
            if FIGURE_CAPTION.match(next_text) or TABLE_CAPTION.match(next_text):
                break
            if len(next_text) > 160:
                break
            gap = next_bbox[1] - collected[-1][1][3]
            if gap > line_height * 2.2:
                break
            overlap = min(bbox[2], next_bbox[2]) - max(bbox[0], next_bbox[0])
            if overlap / max(1.0, min(bbox[2] - bbox[0], next_bbox[2] - next_bbox[0])) < 0.2:
                break
            collected.append((next_text, next_bbox))
            consumed.add(index)
            total += len(next_text)
            index += 1
        x0 = min(item[1][0] for item in collected)
        y0 = min(item[1][1] for item in collected)
        x1 = max(item[1][2] for item in collected)
        y1 = max(item[1][3] for item in collected)
        captions.append({'text': ' '.join(item[0] for item in collected)[:900], 'box': _norm_box(x0, y0, x1, y1, width, height)})
    # Standalone short panel labels are still useful when they are not part of a caption block.
    for index, (text, bbox, _line_height) in enumerate(lines):
        if index in consumed or TABLE_CAPTION.match(text) or FIGURE_CAPTION.match(text):
            continue
        if PANEL_LABEL.match(text) and len(text) <= 48:
            panels.append({'text': text[:80], 'box': _norm_box(*bbox, width, height)})
    return captions[:40], panels[:80]


def _has_mask(document, xref):
    try:
        kind, value = document.xref_get_key(xref, 'SMask')
        return kind != 'null' and bool(value)
    except Exception:
        return False


def pdf_images(page):
    """Placed embedded images with placement bbox, so vision half-boxes can be completed."""
    width, height = max(1.0, page.rect.width), max(1.0, page.rect.height)
    document = page.parent
    try:
        infos = page.get_image_info(xrefs=True)
    except Exception:
        return []
    images, seen = [], set()
    for info in infos[:80]:
        xref, bbox = info.get('xref'), info.get('bbox')
        if not xref or xref <= 0 or not bbox or len(bbox) != 4:
            continue
        x0, y0, x1, y1 = [float(v) for v in bbox]
        if x1 - x0 < 8 or y1 - y0 < 8:
            continue
        box = _norm_box(x0, y0, x1, y1, width, height)
        key = (int(xref), box['x'], box['y'], box['w'], box['h'])
        if key in seen:
            continue
        seen.add(key)
        # A separate soft mask means bare extract_image bytes may lose transparency;
        # the complete figure is then rendered from the page instead.
        images.append({'xref': int(xref), 'width': int(info.get('width') or 0), 'height': int(info.get('height') or 0), 'box': box, 'hasMask': bool(document and _has_mask(document, int(xref))) })
    return images[:60]



def _table_cell(value, limit=600):
    return '' if value is None else str(value).strip()[:limit]


def pdf_tables(page, limit=12, max_rows=40, max_columns=16):
    """Native PDF table cells with normalized boxes.

    Vision reading only covers pages/tables without this native structure; table cells are
    returned as data, so no table screenshot has to be saved as an image material.
    """
    try:
        # pymupdf prints a layout hint on stdout; keep the tool's JSON channel clean.
        with contextlib.redirect_stdout(sys.stderr):
            found = page.find_tables().tables
    except Exception:
        return []
    width, height = max(1.0, page.rect.width), max(1.0, page.rect.height)
    tables = []
    for table in found[:limit]:
        try:
            values = table.extract() or []
        except Exception:
            continue
        rows = [[_table_cell(cell) for cell in row] for row in values if row]
        rows = [row[:max_columns] for row in rows if any(row)][:max_rows]
        if len(rows) < 2 or max(len(row) for row in rows) < 2:
            continue
        # Keep the per-page structure JSON bounded; analysis keeps the first complete rows.
        budget, bounded = 24000, []
        for row in rows:
            cost = sum(len(cell) for cell in row) + 2 * len(row)
            if cost > budget:
                break
            budget -= cost
            bounded.append(row)
        rows = bounded
        if len(rows) < 2:
            continue
        x0, y0, x1, y1 = [float(v) for v in table.bbox]
        x = min(1000.0, max(0.0, x0 / width * 1000))
        y = min(1000.0, max(0.0, y0 / height * 1000))
        tables.append({'rows': rows, 'box': {
            'x': round(x, 2), 'y': round(y, 2),
            'w': round(min(1000.0 - x, max(0.0, (x1 - x0) / width * 1000)), 2),
            'h': round(min(1000.0 - y, max(0.0, (y1 - y0) / height * 1000)), 2)}})
    return tables


def main():
    op, source, target = sys.argv[1:4]
    source, target = pathlib.Path(source), pathlib.Path(target)
    if op == 'structure':
        from presentation_structure import read_presentation
        print(json.dumps(read_presentation(source), ensure_ascii=True))
    elif op == 'pdf':
        import pymupdf
        target.mkdir(parents=True, exist_ok=True)
        pages = []
        with pymupdf.open(source) as doc:
            if doc.needs_pass:
                raise ValueError('PDF 已加密，请先解锁')
            for i in range(min(len(doc), 100)):
                page = doc[i]
                file = target/('S%02d.png' % (i+1))
                # Cached pages for this exact source hash are never rendered twice.
                if not file.exists():
                    pix = page.get_pixmap(matrix=pymupdf.Matrix(1920/max(page.rect.width, page.rect.height), 1920/max(page.rect.width, page.rect.height)), alpha=False)
                    pix.save(file)
                objects = [{'type':'text', 'text':b[4], 'box':{'x':b[0]/page.rect.width*1600, 'y':b[1]/page.rect.height*900, 'w':(b[2]-b[0])/page.rect.width*1600, 'h':(b[3]-b[1])/page.rect.height*900}} for b in page.get_text('blocks') if b[6] == 0]
                captions, panels = pdf_text_anchors(page)
                pages.append({'number': i+1, 'file':file.name, 'width':round(page.rect.width,2), 'height':round(page.rect.height,2), 'objects':objects, 'text':page.get_text(), 'tables':pdf_tables(page), 'images':pdf_images(page), 'captions':captions, 'panels':panels})
            print(json.dumps({'pages':pages, 'totalPages':len(doc), 'partial':len(doc)>len(pages)}, ensure_ascii=True))
    elif op == 'embedded':
        part = sys.argv[4]
        if not part.startswith('ppt/media/') or '..' in part.split('/'):
            raise ValueError('图片部件无效')
        with zipfile.ZipFile(source) as z:
            if z.getinfo(part).file_size > 20_000_000:
                raise ValueError('图片部件过大')
            raw = z.read(part)
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            if image.width*image.height > 40_000_000:
                raise ValueError('图片像素过大')
            # Crop/rotation on the slide never changes the source material.
            suffix = '.png' if image.format == 'PNG' else '.jpg' if image.format == 'JPEG' else '.png'
            target = target.with_suffix(suffix)
            if image.format in ('PNG', 'JPEG'):
                target.write_bytes(raw)
            else:
                image.convert('RGBA').save(target)
        print(json.dumps({'width':image.width,'height':image.height,'file':target.name}))
    elif op == 'pdf-image':
        # Extract one embedded PDF image unchanged, used instead of cropping a half page.
        import pymupdf
        xref = int(sys.argv[4])
        with pymupdf.open(source) as doc:
            if xref <= 0 or xref >= doc.xref_length():
                raise ValueError('PDF图片编号无效')
            info = doc.extract_image(xref)
        raw = info.get('image') if info else None
        if not raw:
            raise ValueError('PDF图片无法读取')
        if len(raw) > 20_000_000:
            raise ValueError('图片过大')
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            if image.width * image.height > 40_000_000:
                raise ValueError('图片像素过大')
            width, height, fmt = image.width, image.height, image.format
        suffix = '.png' if fmt == 'PNG' else '.jpg' if fmt == 'JPEG' else '.png'
        target = target.with_suffix(suffix)
        if fmt in ('PNG', 'JPEG'):
            target.write_bytes(raw)
        else:
            with Image.open(io.BytesIO(raw)) as image:
                image.convert('RGBA').save(target)
        print(json.dumps({'width': width, 'height': height, 'file': target.name}))
    elif op == 'crop':
        box = json.loads(sys.argv[4])
        with Image.open(source) as image:
            x,y,w,h = [box[k] for k in ('x','y','w','h')]
            if min(x,y)<0 or min(w,h)<=0 or x+w>1000.01 or y+h>1000.01:
                raise ValueError('图片区域超出原页')
            crop = image.crop((round(x*image.width/1000),round(y*image.height/1000),round((x+w)*image.width/1000),round((y+h)*image.height/1000)))
            crop.convert('RGBA').save(target)
            print(json.dumps({'width':crop.width,'height':crop.height}))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'error':str(e)},ensure_ascii=True));sys.exit(1)
