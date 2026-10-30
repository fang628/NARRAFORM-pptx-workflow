"""Render PDF analysis pages; extract PPTX media directly from the package."""
import contextlib
import io
import json
import pathlib
import sys
import zipfile
from PIL import Image


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
                pix = page.get_pixmap(matrix=pymupdf.Matrix(1920/max(page.rect.width, page.rect.height), 1920/max(page.rect.width, page.rect.height)), alpha=False)
                file = target/('S%02d.png' % (i+1))
                pix.save(file)
                objects = [{'type':'text', 'text':b[4], 'box':{'x':b[0]/page.rect.width*1600, 'y':b[1]/page.rect.height*900, 'w':(b[2]-b[0])/page.rect.width*1600, 'h':(b[3]-b[1])/page.rect.height*900}} for b in page.get_text('blocks') if b[6] == 0]
                pages.append({'number': i+1, 'file':file.name, 'objects':objects, 'text':page.get_text()})
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
