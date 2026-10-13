import io, pathlib, sys, zipfile
from PIL import Image, ImageDraw
import pymupdf
dest=pathlib.Path(sys.argv[1]);dest.mkdir(parents=True,exist_ok=True)
image=Image.new('RGB',(200,100),'#fff238');ImageDraw.Draw(image).rectangle((100,0,199,99),fill='#353535');image.save(dest/'source.png')
with pymupdf.open() as doc:
    for _ in range(2):
        page=doc.new_page(width=400,height=300);page.insert_text((20,25),'Reference chart');page.insert_image(pymupdf.Rect(100,75,300,175),filename=str(dest/'source.png'))
    doc.save(dest/'source.pdf')
ns='http://schemas.openxmlformats.org/drawingml/2006/main';rn='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
for kind in ('docx','pptx'):
    part='word/document.xml' if kind=='docx' else 'ppt/slides/slide1.xml'
    rel='word/_rels/document.xml.rels' if kind=='docx' else 'ppt/slides/_rels/slide1.xml.rels'
    media='word/media/figure.png' if kind=='docx' else 'ppt/media/figure.png'
    target='media/figure.png' if kind=='docx' else '../media/figure.png'
    with zipfile.ZipFile(dest/('source.'+kind),'w') as z:
        z.writestr(part,f'<a:root xmlns:a="{ns}" xmlns:r="{rn}"><a:t>Source document</a:t><a:blip r:embed="rId1"/></a:root>')
        z.writestr(rel,f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{rn}/image" Target="{target}"/></Relationships>')
        z.writestr(media,(dest/'source.png').read_bytes())
