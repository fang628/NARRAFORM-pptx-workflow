"""Extract document originals, or crop identified regions without regenerating pixels."""
import hashlib, io, json, pathlib, posixpath, sys, zipfile
import xml.etree.ElementTree as ET
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS = 40_000_000

def main():
    op, source, destination = sys.argv[1:4]
    source, destination = pathlib.Path(source), pathlib.Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    images, warnings, seen = [], [], {}
    def store(raw, location, label='图片', unique=False):
        if len(raw)>20_000_000:
            warnings.append('跳过超过 20 MB 的图片'); return
        digest=hashlib.sha256(raw).hexdigest()
        key=digest+json.dumps(location,sort_keys=True) if unique else digest
        if key in seen:
            seen[key]['locations'].append(location); return
        if len(images)>=100:
            if '最多提取前 100 张不同图片' not in warnings: warnings.append('最多提取前 100 张不同图片')
            return
        try:
            im=Image.open(io.BytesIO(raw)); im.load()
            if im.width*im.height>40_000_000: raise ValueError('图片像素过大')
            fmt=im.format
            if fmt in ('PNG','JPEG'): suffix='.png' if fmt=='PNG' else '.jpg'; content=raw
            else:
                buf=io.BytesIO(); im.convert('RGBA').save(buf,format='PNG'); suffix='.png';content=buf.getvalue()
            if len(content)>20_000_000: raise ValueError('解码后的图片过大')
            file='image-%03d%s'%(len(images)+1,suffix); (destination/file).write_bytes(content)
            item={'file':file,'width':im.width,'height':im.height,'originalHash':digest,'locations':[location],'label':label}
            images.append(item);seen[key]=item
        except Exception:
            warnings.append('跳过无法解码的图片：'+str(location.get('part',location.get('page','未知位置'))))
    if op=='crop':
        spec=json.loads(pathlib.Path(sys.argv[4]).read_text(encoding='utf-8'))
        with Image.open(source) as im:
            im.load();im=ImageOps.exif_transpose(im)
            for r in spec:
                b=r['box'];x,y,w,h=[float(b[k]) for k in ['x','y','w','h']]
                if min(x,y)<0 or min(w,h)<=0 or x+w>1000 or y+h>1000: raise ValueError('裁片坐标超出原图')
                box=(round(x*im.width/1000),round(y*im.height/1000),round((x+w)*im.width/1000),round((y+h)*im.height/1000))
                if box[2]<=box[0] or box[3]<=box[1]: raise ValueError('裁片区域为空')
                buf=io.BytesIO(); im.crop(box).convert('RGBA').save(buf,format='PNG')
                store(buf.getvalue(),{'page':r.get('page',1),'box':b,'coordinateSystem':'1000x1000'},r['label'],unique=r.get('manual',False))
    elif op=='embedded' and source.suffix.lower()=='.pdf':
        import pymupdf
        with pymupdf.open(source) as doc:
            if doc.needs_pass: raise ValueError('PDF 已加密，请先解锁')
            if len(doc)>30: warnings.append('仅提取 PDF 前 30 页，剩余请拆分上传')
            for i in range(min(30,len(doc))):
                page=doc[i]
                for img in page.get_images(full=True):
                    xref,smask=img[:2]
                    try:
                        info=doc.extract_image(xref); raw=info['image'];rects=page.get_image_rects(xref)
                        if smask:
                            pix=pymupdf.Pixmap(pymupdf.Pixmap(doc,xref),pymupdf.Pixmap(doc,smask));raw=pix.tobytes('png')
                        location={'page':i+1,'xref':xref,'boxes':[[r.x0,r.y0,r.x1,r.y1] for r in rects],'coordinateSystem':'pdf-points'}
                        if rects and max(r.get_area()/max(1,page.rect.get_area()) for r in rects)>.9:
                            warnings.append('第 %d 页含整页图片，需用“AI 识别分离”拆出其中图表'%(i+1))
                        store(raw,location)
                    except Exception: warnings.append('第 %d 页有无法提取的图片'%(i+1))
    elif op=='embedded' and source.suffix.lower() in ('.docx','.pptx'):
        with zipfile.ZipFile(source) as z:
            is_doc=source.suffix.lower()=='.docx'
            parts=[n for n in z.namelist() if (n.startswith('word/') if is_doc else n.startswith('ppt/slides/slide')) and n.endswith('.xml') and '/_rels/' not in n]
            budget=0
            for part in sorted(parts):
                info=z.getinfo(part);budget+=info.file_size
                if budget>60_000_000: raise ValueError('解压后的文档过大')
                rel=posixpath.join(posixpath.dirname(part),'_rels',posixpath.basename(part)+'.rels')
                if rel not in z.namelist(): continue
                budget+=z.getinfo(rel).file_size
                if budget>60_000_000: raise ValueError('解压后的文档过大')
                refs={}
                for r in ET.fromstring(z.read(rel)):
                    if r.get('TargetMode')=='External' or not r.get('Type','').endswith('/image'): continue
                    target=r.get('Target',''); target=posixpath.normpath(posixpath.join(posixpath.dirname(part),target)) if not target.startswith('/') else target.lstrip('/')
                    if target in z.namelist() and (target.startswith('word/media/') or target.startswith('ppt/media/')): refs[r.get('Id')]=target
                root=ET.fromstring(z.read(part))
                for e in root.iter():
                    for attr,value in e.attrib.items():
                        if not (attr.endswith('}embed') or attr.endswith('}id')) or value not in refs: continue
                        target=refs[value];zi=z.getinfo(target)
                        if zi.file_size>20_000_000: warnings.append('跳过超过 20 MB 的图片');continue
                        budget+=zi.file_size
                        if budget>150_000_000: raise ValueError('解压后的图片总量过大')
                        location={'part':part,'media':target}
                        if not is_doc:
                            location['page']=int(posixpath.basename(part).removeprefix('slide').removesuffix('.xml'));location['unit']='slide'
                        store(z.read(target),location)
            if is_doc: warnings.append('Word 无固定页码，按文档部件与图片编号追溯')
    else: raise ValueError('本地提取支持 PDF、DOCX 和 PPTX；扫描图请用 AI 识别分离')
    print(json.dumps({'images':images,'warnings':list(dict.fromkeys(warnings))},ensure_ascii=True))

if __name__=='__main__':
    try: main()
    except Exception as e:
        print(json.dumps({'error':str(e)},ensure_ascii=True));sys.exit(1)
