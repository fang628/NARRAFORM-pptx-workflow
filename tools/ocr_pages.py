import sys, json, pathlib
import pymupdf
source, destination = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
destination.mkdir(parents=True, exist_ok=True)
with pymupdf.open(source) as document:
    if document.needs_pass: raise ValueError('PDF 已加密，请先解锁后上传')
    pages=[]
    for i in range(min(len(document),30)):
        page=document[i]
        scale=min(1.5,2048/max(page.rect.width,page.rect.height,1))
        file=destination/('page-%03d.png'%(i+1))
        page.get_pixmap(matrix=pymupdf.Matrix(scale,scale),alpha=False).save(file)
        pages.append({'page':i+1,'path':str(file)})
    print(json.dumps({'pages':pages,'total':len(document),'partial':len(document)>30}))
