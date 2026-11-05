"""Render PDF analysis pages; extract PPTX media directly from the package."""
import contextlib
import io
import json
import pathlib
import sys
import zipfile
from PIL import Image


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
                pages.append({'number': i+1, 'file':file.name, 'objects':objects, 'text':page.get_text(), 'tables':pdf_tables(page)})
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
