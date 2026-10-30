"""Read original slide order, text frames, groups and geometry without executing OOXML."""
import hashlib
import posixpath
import zipfile
import xml.etree.ElementTree as ET

NS = {'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
      'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}


def relationships(z, part):
    name = posixpath.join(posixpath.dirname(part), '_rels', posixpath.basename(part)+'.rels')
    if name not in z.namelist():
        return {}
    return {r.get('Id'): {'part': posixpath.normpath(posixpath.join(posixpath.dirname(part), r.get('Target', ''))) if not r.get('Target', '').startswith('/') else r.get('Target').lstrip('/'), 'type': r.get('Type', '')}
            for r in ET.fromstring(z.read(name)) if r.get('TargetMode') != 'External'}


def paragraphs(node):
    result = []
    for paragraph in node.findall('a:p', NS):
        text = ''.join(e.text or '' if e.tag == '{'+NS['a']+'}t' else '\n' if e.tag == '{'+NS['a']+'}br' else '' for e in paragraph.iter() if e.tag.rsplit('}', 1)[-1] in ('t', 'br'))
        pr = paragraph.find('a:pPr', NS)
        runs = []
        for run in paragraph.findall('a:r', NS):
            rp = run.find('a:rPr', NS)
            style = dict(rp.attrib) if rp is not None else {}
            runs.append({'text': ''.join(run.itertext()), 'style': style})
        result.append({'text': text, 'level': int(pr.get('lvl', '0')) if pr is not None else 0, 'runs': runs})
    return result


def read_presentation(source):
    with zipfile.ZipFile(source) as z:
        relevant = [i for i in z.infolist() if i.filename.startswith('ppt/') and (i.filename.endswith('.xml') or i.filename.endswith('.rels'))]
        if sum(i.file_size for i in relevant) > 60_000_000:
            raise ValueError('PPTX 解压后的结构过大')
        presentation = ET.fromstring(z.read('ppt/presentation.xml'))
        size = presentation.find('p:sldSz', NS)
        width, height = int(size.get('cx')), int(size.get('cy'))
        refs = relationships(z, 'ppt/presentation.xml')
        parts = [refs[n.get('{'+NS['r']+'}id')]['part'] for n in presentation.findall('p:sldIdLst/p:sldId', NS)]
        pages = []
        for number, part in enumerate(parts, 1):
            root, rels = ET.fromstring(z.read(part)), relationships(z, part)
            layout = next((r['part'] for r in rels.values() if r['type'].endswith('/slideLayout')), None)
            placeholders = []
            if layout and layout in z.namelist():
                lr = ET.fromstring(z.read(layout))
                placeholders = [n for n in lr.findall('p:cSld/p:spTree/p:sp', NS) if n.find('p:nvSpPr/p:nvPr/p:ph', NS) is not None]
            objects = []

            def walk(container, parent=None, scale=(1, 1), offset=(0, 0)):
                for node in container:
                    tag = node.tag.rsplit('}', 1)[-1]
                    if tag not in ('sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp'):
                        continue
                    identity = node.find('.//p:cNvPr', NS)
                    key = identity.get('id') if identity is not None else str(len(objects)+1)
                    ph = node.find('.//p:ph', NS)
                    role = ph.get('type', 'body') if ph is not None else None
                    xf = node.find('p:grpSpPr/a:xfrm', NS) if tag == 'grpSp' else node.find('p:xfrm', NS) if tag == 'graphicFrame' else node.find('p:spPr/a:xfrm', NS)
                    if xf is None and ph is not None:
                        inherited = next((n for n in placeholders if n.find('p:nvSpPr/p:nvPr/p:ph', NS).get('idx', '0') == ph.get('idx', '0')), None)
                        if inherited is not None:
                            xf = inherited.find('p:spPr/a:xfrm', NS)
                    box = None
                    off = xf.find('a:off', NS) if xf is not None else None
                    ext = xf.find('a:ext', NS) if xf is not None else None
                    if off is not None and ext is not None:
                        x, y, w, h = (float(off.get('x', 0)), float(off.get('y', 0)), float(ext.get('cx', 0)), float(ext.get('cy', 0)))
                        box = {'x': round((x*scale[0]+offset[0])/width*1600, 3), 'y': round((y*scale[1]+offset[1])/height*900, 3), 'w': round(w*scale[0]/width*1600, 3), 'h': round(h*scale[1]/height*900, 3)}
                    record = {'id': key, 'name': identity.get('name', '') if identity is not None else '', 'type': tag, 'parentId': parent, 'z': len(objects), 'box': box, 'placeholder': role}
                    if xf is not None:
                        record['transform'] = dict(xf.attrib)
                    body = node.find('p:txBody', NS)
                    if body is not None:
                        record['paragraphs'] = paragraphs(body)
                        record['text'] = '\n'.join(p['text'] for p in record['paragraphs'])
                    table = node.find('a:graphic/a:graphicData/a:tbl', NS)
                    if table is not None:
                        record['table'] = [['\n'.join(p['text'] for p in paragraphs(c.find('a:txBody', NS))) for c in row.findall('a:tc', NS)] for row in table.findall('a:tr', NS)]
                        grid = [float(c.get('w', 0)) for c in table.findall('a:tblGrid/a:gridCol', NS)]
                        rows = table.findall('a:tr', NS)
                        heights = [float(row.get('h', 0)) for row in rows]
                        if box and sum(grid) and sum(heights):
                            record['cellBoxes'] = [[{'x': box['x']+box['w']*sum(grid[:c])/sum(grid), 'y':box['y']+box['h']*sum(heights[:r])/sum(heights), 'w':box['w']*grid[c]/sum(grid), 'h':box['h']*heights[r]/sum(heights)} for c in range(min(len(grid),len(row)))] for r,row in enumerate(record['table'])]
                    # A group/chart must not inherit its first child's picture.
                    blip = node.find('p:blipFill/a:blip', NS)
                    if blip is None:
                        blip = node.find('p:spPr/a:blipFill/a:blip', NS)
                    if blip is not None:
                        ref = rels.get(blip.get('{'+NS['r']+'}embed'))
                        if ref and ref['part'].startswith('ppt/media/') and ref['part'] in z.namelist():
                            record['mediaPart'] = ref['part']
                            if z.getinfo(ref['part']).file_size <= 20_000_000:
                                record['mediaHash'] = hashlib.sha256(z.read(ref['part'])).hexdigest()
                        crop = node.find('p:blipFill/a:srcRect', NS)
                        if crop is not None:
                            record['crop'] = dict(crop.attrib)
                    for endpoint in ('stCxn', 'endCxn'):
                        value = node.find('.//a:'+endpoint, NS)
                        if value is not None:
                            record[endpoint] = dict(value.attrib)
                    shape = node.find('p:spPr/a:prstGeom', NS)
                    if shape is not None:
                        record['shape'] = shape.get('prst')
                    objects.append(record)
                    if tag == 'grpSp':
                        co = xf.find('a:chOff', NS) if xf is not None else None
                        ce = xf.find('a:chExt', NS) if xf is not None else None
                        if off is not None and ext is not None and co is not None and ce is not None:
                            sx, sy = float(ext.get('cx'))/max(1, float(ce.get('cx'))), float(ext.get('cy'))/max(1, float(ce.get('cy')))
                            walk(node, key, (scale[0]*sx, scale[1]*sy), (offset[0]+scale[0]*(float(off.get('x'))-float(co.get('x'))*sx), offset[1]+scale[1]*(float(off.get('y'))-float(co.get('y'))*sy)))
                        else:
                            walk(node, key, scale, offset)
            walk(root.find('p:cSld/p:spTree', NS))
            text = '\n'.join(o.get('text', '') if 'text' in o else '\n'.join('\t'.join(row) for row in o['table']) if 'table' in o else '' for o in objects).strip()
            pages.append({'number': number, 'part': part, 'objects': objects, 'text': text})
        return {'version': 2, 'width': width, 'height': height, 'slides': pages}
