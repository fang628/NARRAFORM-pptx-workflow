"""Extract source text and safe, offset-addressed typography (no executable HTML)."""
import sys, json, pathlib, zipfile, re, contextlib, xml.etree.ElementTree as ET

LIMIT = 120000
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
M = '{http://schemas.openxmlformats.org/officeDocument/2006/math}'


def math_node(tag, *children, text=None, **attributes):
    return {'tag':tag, **({'text':text} if text is not None else {}), **({'attributes':attributes} if attributes else {}), **({'children':list(children)} if children else {})}


def omml(node):
    """Convert Word equation structure to a restricted MathML tree."""
    name = node.tag.split('}')[-1]
    children = [e for e in node if not e.tag.endswith('Pr')]
    def part(key):
        element = node.find(M+key)
        return omml(element) if element is not None else math_node('mrow')
    if name == 't':
        value = node.text or ''
        return math_node('mn' if value.isdigit() else 'mi', text=value)
    if name == 'f':
        return math_node('mfrac', part('num'), part('den'))
    if name in ('sSup','sSub','sSubSup'):
        return math_node({'sSup':'msup','sSub':'msub','sSubSup':'msubsup'}[name], part('e'), *([part('sub')] if name in ('sSub','sSubSup') else []), *([part('sup')] if name in ('sSup','sSubSup') else []))
    if name == 'rad':
        degree = node.find(M+'deg')
        return math_node('mroot',part('e'),part('deg')) if degree is not None and ''.join(degree.itertext()).strip() else math_node('msqrt',part('e'))
    if name == 'd':
        pr = node.find(M+'dPr')
        def char(key, default):
            el = pr.find(M+key) if pr is not None else None
            return el.get(M+'val',default) if el is not None else default
        return math_node('mrow',math_node('mo',text=char('begChr','(')),*(omml(e) for e in children),math_node('mo',text=char('endChr',')')))
    if name in ('limLow','limUpp'):
        return math_node('munder' if name=='limLow' else 'mover',part('e'),part('lim'))
    if name == 'nary':
        pr = node.find(M+'naryPr')
        char = pr.find(M+'chr') if pr is not None else None
        return math_node('mrow',math_node('munderover',math_node('mo',text=char.get(M+'val','∫') if char is not None else '∫'),part('sub'),part('sup')),part('e'))
    if name == 'm':
        return math_node('mtable',*(math_node('mtr',*(math_node('mtd',omml(e)) for e in row.findall(M+'e'))) for row in node.findall(M+'mr')))
    if name in ('bar','acc'):
        pr = node.find(M+name+'Pr')
        char = pr.find(M+'chr') if pr is not None else None
        return math_node('mover',part('e'),math_node('mo',text=char.get(M+'val','¯') if char is not None else '¯'))
    return math_node('mrow',*(omml(e) for e in children))


def math_text(tree):
    children = tree.get('children',[])
    values = [math_text(c) for c in children]
    if tree['tag'] == 'mfrac':
        return '('+values[0]+')/('+values[1]+')'
    if tree['tag'] in ('msup','msub','msubsup'):
        return values[0]+('_{'+values[1]+'}' if tree['tag'] in ('msub','msubsup') else '^{'+values[1]+'}')+('^{'+values[2]+'}' if len(values)>2 else '')
    if tree['tag'] == 'msqrt':
        return '√('+''.join(values)+')'
    if tree['tag'] == 'mroot':
        return 'root('+','.join(values)+')'
    return tree.get('text','')+''.join(values)


def latex_math(expression):
    try:
        from latex2mathml.converter import convert
        root = ET.fromstring(convert(expression))
        def tree(node):
            return math_node(node.tag.split('}')[-1],*(tree(c) for c in node),text=node.text or None,**{k:v for k,v in node.attrib.items() if k in ('display','mathvariant','stretchy','fence','separator','columnalign','rowalign')})
        return tree(root)
    except Exception:
        return None


def units(text):
    return len(text.encode('utf-16-le')) // 2


class Document:
    def __init__(self, kind):
        self.parts, self.spans, self.length, self.chars = [], [], 0, 0
        self.kind, self.truncated, self.structures = kind, False, []

    def add(self, text, style=None):
        if not text:
            return
        remaining = LIMIT - self.chars
        if len(text) > remaining:
            self.truncated = True
            text = text[:max(0, remaining)]
        if not text:
            return
        start = self.length
        self.parts.append(text)
        self.chars += len(text)
        self.length += units(text)
        if style:
            span = {**style, 'start': start, 'end': self.length}
            if self.spans and self.spans[-1]['end'] == start and {k:v for k,v in self.spans[-1].items() if k not in ('start','end')} == style:
                self.spans[-1]['end'] = self.length
            else:
                self.spans.append(span)

    def result(self):
        return {'text': ''.join(self.parts), 'truncated': self.truncated,
                'richText': {'version': 1, 'format': self.kind, 'spans': self.spans, 'structures':self.structures}}

    def formula(self, text, tree, block=False):
        start = self.length
        self.add(text, {'fontSize':11})
        if self.length > start:
            self.structures.append({'type':'formula','start':start,'end':self.length,'math':tree,'block':block})


def word_properties(node):
    if node is None:
        return {}
    out = {}
    for tag, key in [('b','bold'), ('i','italic'), ('strike','strike')]:
        e = node.find(W+tag)
        if e is not None:
            out[key] = e.get(W+'val', 'true') not in ('0','false','off')
    sz = node.find(W+'sz')
    if sz is not None:
        try:
            out['fontSize'] = float(sz.get(W+'val')) / 2
        except (ValueError, TypeError):
            pass
    u = node.find(W+'u')
    if u is not None:
        out['underline'] = u.get(W+'val', 'single') not in ('none','0','false')
    vert = node.find(W+'vertAlign')
    if vert is not None and vert.get(W+'val') in ('subscript','superscript'):
        out['vertical'] = vert.get(W+'val')
    font = node.find(W+'rFonts')
    if font is not None:
        out['fontFamily'] = font.get(W+'eastAsia') or font.get(W+'ascii') or font.get(W+'hAnsi') or ''
    return out


def docx(source):
    doc = Document('docx')
    with zipfile.ZipFile(source) as z:
        if sum(z.getinfo(n).file_size for n in z.namelist() if n in ('word/document.xml','word/styles.xml')) > 30_000_000:
            raise ValueError('解压后的文档过大')
        root = ET.fromstring(z.read('word/document.xml'))
        styles = ET.fromstring(z.read('word/styles.xml')) if 'word/styles.xml' in z.namelist() else ET.Element('styles')
        records = {e.get(W+'styleId'):e for e in styles.findall(W+'style')}
        default_id = next((key for key,e in records.items() if e.get(W+'type') == 'paragraph' and e.get(W+'default') == '1'), None)
        defaults = {'fontSize':11, **word_properties(styles.find(W+'docDefaults/'+W+'rPrDefault/'+W+'rPr'))}

        def resolve(key, seen=None):
            seen = set() if seen is None else seen
            if not key or key in seen or key not in records:
                return {}
            seen.add(key)
            node = records[key]
            base = node.find(W+'basedOn')
            return {**resolve(base.get(W+'val') if base is not None else None, seen), **word_properties(node.find(W+'rPr'))}

        def paragraph(p):
            pr = p.find(W+'pPr')
            ps = pr.find(W+'pStyle') if pr is not None else None
            style = {**defaults, **resolve(ps.get(W+'val') if ps is not None else default_id)}
            def content(run):
                if run.tag == M+'oMath':
                    tree = omml(run)
                    doc.formula(math_text(tree),math_node('math',tree))
                    return
                if run.tag != W+'r':
                    for item in run:
                        content(item)
                    return
                rp = run.find(W+'rPr')
                rs = rp.find(W+'rStyle') if rp is not None else None
                current = {**style, **resolve(rs.get(W+'val') if rs is not None else None), **word_properties(rp)}
                for child in run:
                    if child.tag == W+'t':
                        doc.add(child.text or '', current)
                    elif child.tag == W+'tab':
                        doc.add('\t', current)
                    elif child.tag in (W+'br', W+'cr'):
                        doc.add('\n', current)
            for child in p:
                if child.tag != W+'pPr':
                    content(child)
            doc.add('\n')

        body = root.find(W+'body')
        for child in body if body is not None else []:
            if doc.chars >= LIMIT:
                doc.truncated = True
                break
            if child.tag == W+'tbl':
                table = {'type':'table','start':doc.length,'rows':[]}
                for row in child.findall(W+'tr'):
                    cells = row.findall(W+'tc')
                    ranges = []
                    for i,cell in enumerate(cells):
                        start = doc.length
                        for p in cell.iter(W+'p'):
                            paragraph(p)
                        tcpr = cell.find(W+'tcPr')
                        gridspan = tcpr.find(W+'gridSpan') if tcpr is not None else None
                        merge = tcpr.find(W+'vMerge') if tcpr is not None else None
                        ranges.append({'start':start,'end':doc.length,'colspan':int(gridspan.get(W+'val','1')) if gridspan is not None else 1, 'merge':merge.get(W+'val','continue') if merge is not None else None})
                        if i < len(cells)-1:
                            doc.add('\t')
                    table['rows'].append(ranges)
                    doc.add('\n')
                table['end'] = doc.length
                if table['end'] > table['start']:
                    doc.structures.append(table)
            else:
                for p in ([child] if child.tag == W+'p' else child.iter(W+'p')):
                    paragraph(p)
    return doc.result()


def pdf(source):
    import pymupdf
    doc = Document('pdf')
    missing = False
    with pymupdf.open(source) as pdf_file:
        if pdf_file.needs_pass:
            raise ValueError('PDF 已加密，请先解锁后上传')
        total = len(pdf_file)
        for i,page in enumerate(pdf_file):
            if doc.chars >= LIMIT:
                doc.truncated = True
                break
            doc.add('[第 %d 页]\n' % (i+1))
            found = False
            blocks = page.get_text('dict', flags=pymupdf.TEXTFLAGS_TEXT, sort=True)['blocks']
            lines = [line for block in blocks for line in block.get('lines',[])]
            def write_line(line):
                nonlocal found
                for span in line['spans']:
                    text, flags = span['text'], span['flags']
                    found |= bool(text.strip())
                    style = {'fontSize':round(span['size'],2), 'fontFamily':span['font'], 'bold':bool(flags & 16), 'italic':bool(flags & 2)}
                    if flags & 1:
                        style['vertical'] = 'superscript'
                    doc.add(text,style)
                doc.add('\n')
            try:
                tables = page.find_tables().tables
            except Exception:
                tables = []
            def contains(box, line):
                x0,y0,x1,y1 = line['bbox']
                return box and box[0] <= (x0+x1)/2 <= box[2] and box[1] <= (y0+y1)/2 <= box[3]
            events = [(line['bbox'][1],line['bbox'][0],'line',line) for line in lines if not any(contains(t.bbox,line) for t in tables)]
            events += [(t.bbox[1],t.bbox[0],'table',t) for t in tables]
            for _,_,kind,item in sorted(events,key=lambda e:(e[0],e[1])):
                if kind == 'line':
                    write_line(item)
                else:
                    table = {'type':'table','start':doc.length,'rows':[]}
                    values = item.extract()
                    for ri,row in enumerate(item.rows):
                        ranges = []
                        for ci,cell in enumerate(row.cells):
                            start = doc.length
                            cell_lines = [line for line in lines if contains(cell,line)]
                            for line in cell_lines:
                                write_line(line)
                            if not cell_lines:
                                text = values[ri][ci] or ''
                                found |= bool(text.strip())
                                doc.add(text,{'fontSize':11})
                            ranges.append({'start':start,'end':doc.length})
                            doc.add('\t')
                        table['rows'].append(ranges)
                        doc.add('\n')
                    table['end'] = doc.length
                    if table['end'] > table['start']:
                        doc.structures.append(table)
            missing |= not found
        return {**doc.result(), 'pageCount':total, 'needsOCR':missing}


def markdown(text, truncated=False):
    from markdown_it import MarkdownIt
    from mdit_py_plugins.dollarmath import dollarmath_plugin
    parser = MarkdownIt('commonmark', {'html':False}).enable('table').use(dollarmath_plugin)
    doc = Document('md')
    stack, lists, style, table, cell = [], [], {'fontSize':11}, None, None
    for token in parser.parse(text):
        if token.type == 'table_open':
            table = {'type':'table','start':doc.length,'rows':[]}
        elif token.type == 'table_close':
            table['end'] = doc.length
            if table['end'] > table['start']:
                doc.structures.append(table)
            table = None
        elif token.type == 'tr_open':
            table['rows'].append([])
        elif token.type in ('th_open','td_open'):
            cell = {'start':doc.length,'header':token.type=='th_open'}
        elif token.type in ('math_block','math_block_label'):
            doc.formula(token.content,latex_math(token.content),True)
            doc.add('\n\n')
        elif token.type == 'heading_open':
            stack.append(style)
            style = {'fontSize':{1:28,2:23,3:19,4:16,5:13,6:11}[int(token.tag[1])], 'bold':True}
        elif token.type == 'heading_close':
            style = stack.pop()
            doc.add('\n\n')
        elif token.type in ('bullet_list_open','ordered_list_open'):
            lists.append([token.type, int(token.attrGet('start') or 1)])
        elif token.type in ('bullet_list_close','ordered_list_close'):
            lists.pop()
        elif token.type == 'list_item_open':
            current = lists[-1]
            doc.add('  '*(len(lists)-1) + (str(current[1])+'. ' if current[0]=='ordered_list_open' else '• '), style)
            current[1] += 1
        elif token.type == 'paragraph_close':
            doc.add('\n' if lists else '\n\n')
        elif token.type in ('fence','code_block'):
            doc.add(token.content, {'fontSize':11,'code':True})
            doc.add('\n')
        elif token.type in ('th_close','td_close'):
            cell['end'] = doc.length
            table['rows'][-1].append(cell)
            doc.add('\t')
        elif token.type == 'tr_close':
            doc.add('\n')
        elif token.type == 'inline':
            current, inline_stack = style.copy(), []
            for child in token.children or []:
                if child.type in ('strong_open','em_open'):
                    inline_stack.append(current.copy())
                    current = {**current, 'bold' if child.type=='strong_open' else 'italic':True}
                elif child.type in ('strong_close','em_close'):
                    current = inline_stack.pop() if inline_stack else style.copy()
                elif child.type in ('softbreak','hardbreak'):
                    doc.add('\n', current)
                elif child.type == 'code_inline':
                    doc.add(child.content, {**current,'code':True})
                elif child.type == 'math_inline':
                    doc.formula(child.content,latex_math(child.content))
                elif child.type in ('text','image'):
                    doc.add(child.content, current)
    doc.truncated |= truncated
    return doc.result()


def read_text(source):
    try:
        with source.open(encoding='utf-8-sig') as stream:
            return stream.read(LIMIT+1)
    except UnicodeDecodeError:
        with source.open(encoding='gb18030') as stream:
            return stream.read(LIMIT+1)


def extract(source):
    ext = source.suffix.lower()
    if ext == '.docx':
        return docx(source)
    if ext == '.pdf':
        return pdf(source)
    if ext in ('.txt','.md','.csv','.json'):
        text = read_text(source)
        if ext == '.md':
            return markdown(text[:LIMIT], len(text)>LIMIT)
        return {'text':text[:LIMIT], 'truncated':len(text)>LIMIT}
    if ext == '.pptx':
        from presentation_structure import read_presentation
        presentation = read_presentation(source)
        text = '\n'.join('[%s]\n%s' % (p['part'], p['text']) for p in presentation['slides'])
        return {'text':text[:LIMIT], 'truncated':len(text)>LIMIT, 'presentation':presentation}
    raise ValueError('不支持的文档类型')


if __name__ == '__main__':
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = extract(pathlib.Path(sys.argv[1]))
        if len(sys.argv)>2:
            # Existing projects keep canonical evidence text and all old offsets.
            import difflib
            old = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8'))['text']
            new = result['text']
            old_offsets, new_offsets = [0], [0]
            for c in old:
                old_offsets.append(old_offsets[-1]+units(c))
            for c in new:
                new_offsets.append(new_offsets[-1]+units(c))
            result['sourceMap'] = [[old_offsets[a],new_offsets[b],old_offsets[a+n]-old_offsets[a]] for a,b,n in difflib.SequenceMatcher(None,old,new,autojunk=True).get_matching_blocks() if n]
        print(json.dumps(result, ensure_ascii=True))
    except Exception as e:
        message = '文件损坏或不是有效的 Word / PPTX 文件，请重新导出后发送。' if isinstance(e, zipfile.BadZipFile) else str(e)
        print(json.dumps({'error':message}, ensure_ascii=True))
        sys.exit(1)
