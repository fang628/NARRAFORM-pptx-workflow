"""Web release adapter: validate OOXML, exact native text, object inventory and hashes."""
import json, sys, zipfile, hashlib, posixpath, re, io
from collections import Counter
from pathlib import Path
import xml.etree.ElementTree as ET

P='http://schemas.openxmlformats.org/presentationml/2006/main'
A='http://schemas.openxmlformats.org/drawingml/2006/main'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
M='http://schemas.openxmlformats.org/officeDocument/2006/math'
A14='http://schemas.microsoft.com/office/drawing/2010/main'
MC='http://schemas.openxmlformats.org/markup-compatibility/2006'

def effective_xml(data):
    """Inspect the Office 2010+ active branch, never count its fallback twice."""
    # iterparse returns (event, (prefix, URI)); retain document-local aliases.
    namespaces={prefix:uri for _,(prefix,uri) in ET.iterparse(io.BytesIO(data),events=('start-ns',))}
    supported={A14,A,P,M,R,'http://schemas.microsoft.com/office/powerpoint/2010/main'}
    root=ET.fromstring(data)
    def resolve(parent):
        for child in list(parent):
            if child.tag!=f'{{{MC}}}AlternateContent':
                resolve(child)
                continue
            choice=next((branch for branch in child.findall(f'{{{MC}}}Choice')
                         if branch.get('Requires') and all(namespaces.get(prefix) in supported for prefix in branch.get('Requires').split())),None)
            if choice is None:choice=child.find(f'{{{MC}}}Fallback')
            if choice is None:raise ValueError('Unsupported AlternateContent without fallback')
            resolve(choice)
            position=list(parent).index(child)
            for offset,node in enumerate(list(choice)):parent.insert(position+offset,node)
            parent.remove(child)
    resolve(root)
    return root

def original_shape_name(shape):
    node=shape.find(f'.//{{{P}}}cNvPr')
    name=node.get('name','') if node is not None else ''
    return re.sub(r'^!!nf-page-\d+--','',name)
# Saved prose may embed inline math as \(...\). Native PPTX stores that part as
# a14:m/m:oMath next to the ordinary runs, so text comparison removes the saved
# math marker here and the inline math signature is checked separately.
INLINE_MATH_PATTERN=re.compile(r'\\\((.+?)\\\)',re.S)
INLINE_DOLLAR_PATTERN=re.compile(r'(?<![\\$])\$(?!\$)([^\n$]+?)\$(?!\$)')
INLINE_MATH_SIGNAL=re.compile(r'\\[a-zA-Z]+|[\^_{}]|√|(?:[A-Za-z0-9)\]]\s*[=<>+\-*/×÷±≤≥≠≈]\s*[A-Za-z0-9(\[])')
def inline_math_latex(text):
    source=str(text);found=[]
    for match in INLINE_MATH_PATTERN.finditer(source):found.append((match.start(),match.end(),match.group(1)))
    for match in INLINE_DOLLAR_PATTERN.finditer(source):
        body=match.group(1)
        if INLINE_MATH_SIGNAL.search(body):found.append((match.start(),match.end(),body))
    found.sort()
    return [latex for _,_,latex in found]
def strip_inline_math(text):
    source=str(text);spans=[]
    for match in INLINE_MATH_PATTERN.finditer(source):spans.append((match.start(),match.end()))
    for match in INLINE_DOLLAR_PATTERN.finditer(source):
        if INLINE_MATH_SIGNAL.search(match.group(1)):spans.append((match.start(),match.end()))
    for start,end in sorted(spans,reverse=True):source=source[:start]+source[end:]
    return source
# Saved text may carry lightweight sup/sub markup; native PPTX stores the same
# content as runs with positive/negative baseline. Compare readable text only:
# strip the markup, then map exactly the Unicode superscript/subscript characters
# that public/inline-text.js converts to native baseline runs. Every other
# character (minus sign, units, fullwidth/compatibility forms) stays exact, so no
# global NFKC normalization is applied and real text edits cannot be masked.
INLINE_UNICODE_SCRIPTS={
 '⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9',
 '⁺':'+','⁻':'-','⁼':'=','⁽':'(','⁾':')','ⁱ':'i','ⁿ':'n','ʰ':'h','ʲ':'j','ˡ':'l','ˢ':'s','ʳ':'r','ʷ':'w','ˣ':'x','ʸ':'y',
 'ᵃ':'a','ᵇ':'b','ᶜ':'c','ᵈ':'d','ᵉ':'e','ᶠ':'f','ᵍ':'g','ᵏ':'k','ᵐ':'m','ᵒ':'o','ᵖ':'p','ᵗ':'t','ᵘ':'u','ᵛ':'v','ᶻ':'z',
 '₀':'0','₁':'1','₂':'2','₃':'3','₄':'4','₅':'5','₆':'6','₇':'7','₈':'8','₉':'9',
 '₊':'+','₋':'-','₌':'=','₍':'(','₎':')','ₐ':'a','ₑ':'e','ₒ':'o','ₓ':'x','ₔ':'ə','ₕ':'h','ₖ':'k','ₗ':'l','ₘ':'m','ₙ':'n','ₚ':'p','ₛ':'s','ₜ':'t','ᵢ':'i','ᵣ':'r','ᵤ':'u','ᵥ':'v','ⱼ':'j',
}
def plain_inline(text):
    source=re.sub(r'</?(?:sup|sub)>', '', str(text), flags=re.I)
    return ''.join(INLINE_UNICODE_SCRIPTS.get(char, char) for char in source)

def expected_scripts(text):
    source=strip_inline_math(text)
    result=[]
    def append(value,script=0):
        for char in value:
            if char in '\r\n':continue
            kind=script
            if not kind and char in INLINE_UNICODE_SCRIPTS:
                kind=-1 if char in '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₔₕₖₗₘₙₚₛₜᵢᵣᵤᵥⱼ' else 1
            result.append((INLINE_UNICODE_SCRIPTS.get(char,char),kind))
    start=0
    for match in re.finditer(r'<(sup|sub)>([^<]*)</\1>',source,re.I):
        append(source[start:match.start()]);append(match[2],-1 if match[1].lower()=='sub' else 1)
        start=match.end()
    append(source[start:])
    return result

def actual_scripts(shape):
    result=[]
    for run in shape.findall(f'.//{{{A}}}r'):
        properties=run.find(f'{{{A}}}rPr')
        baseline=float(properties.get('baseline',0)) if properties is not None else 0
        kind=-1 if baseline<0 else 1 if baseline>0 else 0
        result.extend((char,kind) for char in ''.join(t.text or '' for t in run.findall(f'{{{A}}}t')) if char not in '\r\n')
    return result

def picture_name(pic):
    node=pic.find(f'.//{{{P}}}cNvPr')
    return re.sub(r'^!!nf-page-\d+--','',node.get('name','')) if node is not None else ''

def material_image_errors(deck,names,xml,rels,shapes,spec,index):
    """Optional material ORIGINAL image identity check.
    spec.materialImages[index] is [{key,id,sha256}], produced by
    lib/material-image-insertion.mjs materialImageManifest(project,index,getImage).
    Each key must resolve to exactly one picture; the embedded bytes (original SVG through
    asvg:svgBlip, raster through a:blip) must match the registered sha256. Two keys sharing one
    material are two independent picture objects and are both checked.
    """
    expected=(spec.get('materialImages') or [])
    if not expected:return []
    if not isinstance(expected,list) or index>=len(expected) or not isinstance(expected[index],list):
        return [f'S{index+1}: materialImages page entries missing']
    errors=[];seen=set();pics=shapes.findall(f'.//{{{P}}}pic')
    for item in expected[index]:
        if not isinstance(item,dict) or not all(isinstance(item.get(field),str) and item.get(field) for field in ('key','id','sha256')):
            errors.append(f'S{index+1}: invalid materialImages entry');continue
        key=item['key']
        if key in seen:errors.append(f'S{index+1}: duplicate materialImages key '+key);continue
        seen.add(key)
        matches=[pic for pic in pics if picture_name(pic)==key]
        if len(matches)!=1:
            errors.append(f'S{index+1}: material image object count mismatch '+key+f' ({len(matches)})');continue
        pic=matches[0]
        embed=None
        for node in pic.iter():
            local=node.tag.rsplit('}',1)[-1]
            if local=='svgBlip' and node.get(f'{{{R}}}embed'):embed=node.get(f'{{{R}}}embed');break
            if local=='blip' and node.get(f'{{{R}}}embed') and embed is None:embed=node.get(f'{{{R}}}embed')
        target=next((rel for rel in rels if rel.get('Id')==embed),None) if rels is not None and embed else None
        if target is None:
            errors.append(f'S{index+1}: material image has no media relationship '+key);continue
        media=posixpath.normpath(posixpath.join('ppt/slides',target.get('Target','')))
        if media not in names:
            errors.append(f'S{index+1}: material image media missing '+key);continue
        if hashlib.sha256(deck.read(media)).hexdigest()!=item['sha256']:
            errors.append(f'S{index+1}: material image bytes mismatch '+key)
    return errors
def check(deck, spec, pages=None, baseline=None):
    errors=[]
    if pages is not None and baseline:
        import re
        errors.extend(e for e in baseline.get('errors',[]) if (match:=re.match(r'^S(\d+):',e)) and int(match.group(1))-1 not in pages)
    with zipfile.ZipFile(deck) as z:
        names=z.namelist()
        if z.testzip() or len(names)!=len(set(names)): errors.append('ZIP integrity failure')
        xml={n:effective_xml(z.read(n)) for n in names if n.endswith(('.xml','.rels'))}
        for n,r in xml.items():
            if not n.endswith('.rels'): continue
            base=posixpath.dirname(posixpath.dirname(n)) if n!='_rels/.rels' else ''
            for rel in r:
                if rel.get('TargetMode')=='External': errors.append('External relationship forbidden');continue
                target=posixpath.normpath(posixpath.join(base,rel.get('Target','')))
                if target not in names: errors.append('Missing relationship '+target)
        size=xml['ppt/presentation.xml'].find(f'{{{P}}}sldSz')
        if size is None or abs(int(size.get('cx'))/int(size.get('cy'))-16/9)>0.0001: errors.append('Canvas mismatch')
        slide_names=[n for n in names if __import__('re').fullmatch(r'ppt/slides/slide\d+\.xml',n)]
        if len(slide_names)!=len(spec['slides']):errors.append('Slide count mismatch')
        audits=[]
        for i,elements in enumerate(spec['slides']):
            if pages is not None and i not in pages:
                if not baseline or i>=len(baseline.get('slides',[])): raise ValueError('Missing verified page baseline')
                audits.append(baseline['slides'][i]);continue
            r=xml.get(f'ppt/slides/slide{i+1}.xml')
            if r is None:errors.append('Missing slide');continue
            text_elements=[e for e in elements if e['type']=='text']
            expected=Counter(strip_inline_math(e['text']) for e in text_elements)
            # Multi-line text can contain separate runs; compare each native text
            # shape. Standalone formulas use oMathPara and carry no sentence text.
            text_shapes=[s for s in r.findall(f'.//{{{P}}}sp') if s.find(f'{{{P}}}txBody') is not None and s.find(f'.//{{{M}}}oMathPara') is None]
            actual=Counter(''.join(t.text or '' for t in s.findall(f'.//{{{A}}}r/{{{A}}}t')) for s in text_shapes)
            def normalize(counts):
                # Runs may split on sup/sub and carry ± baseline; readable text is the
                # same, so compare plain text after stripping light tags and folding
                # Unicode script glyphs to their base characters.
                normalized=Counter()
                for text,count in counts.items():
                    normalized[plain_inline(text).replace('\n','').replace('\r','')]+=count
                return normalized
            if normalize(expected)!=normalize(actual):errors.append(f'S{i+1}: exact native text mismatch')
            by_name={original_shape_name(shape):shape for shape in text_shapes}
            unused_shapes=list(text_shapes)
            for element in text_elements:
                wanted=expected_scripts(element['text'])
                shape=by_name.get(element.get('key'))
                if shape is None and not element.get('key'):
                    expected_text=plain_inline(strip_inline_math(element['text'])).replace('\n','').replace('\r','')
                    shape=next((candidate for candidate in unused_shapes
                                if ''.join(char for char,_ in actual_scripts(candidate))==expected_text),None)
                if shape in unused_shapes:unused_shapes.remove(shape)
                if any(kind for _,kind in wanted) and (shape is None or actual_scripts(shape)!=wanted):
                    errors.append(f'S{i+1}: native subscript/superscript mismatch '+str(element.get('key') or element['text'][:40]))
            def signature(math):
                import unicodedata
                text=unicodedata.normalize('NFKC',''.join(t.text or '' for t in math.findall(f'.//{{{M}}}t'))).replace(' ','')
                constructors=Counter(e.tag for e in math.iter() if e.tag.rsplit('}',1)[-1] in ('f','rad','sSup','sSub','sSubSup','nary','m','d','limLow','limUpp'))
                return text,constructors
            formulas=[e for e in elements if e['type']=='formula']
            math_shapes=[s for s in r.findall(f'.//{{{P}}}sp') if s.find(f'.//{{{M}}}oMathPara') is not None]
            if len(math_shapes)!=len(formulas):errors.append(f'S{i+1}: native formula count mismatch')
            if formulas:
                from formula_omml import convert
                for equation in formulas:
                    shape=next((s for s in math_shapes if original_shape_name(s)==equation['key']),None)
                    if shape is None or signature(shape.find(f'.//{{{M}}}oMath'))!=signature(ET.fromstring(convert(equation['latex']))):errors.append(f'S{i+1}: native formula mismatch '+equation['key'])
            expected_inline=[latex for e in text_elements for latex in inline_math_latex(e['text'])]
            if expected_inline:
                from formula_omml import convert
                actual_inline=[]
                for shape in text_shapes:
                    for wrapper in shape.findall(f'.//{{{A14}}}m'):
                        math=wrapper.find(f'{{{M}}}oMath')
                        if math is not None:actual_inline.append(math)
                if len(actual_inline)!=len(expected_inline):errors.append(f'S{i+1}: inline math count mismatch')
                else:
                    for latex,math in zip(expected_inline,actual_inline):
                        if signature(math)!=signature(ET.fromstring(convert(latex))):errors.append(f'S{i+1}: inline math mismatch '+latex[:60])
            tree=r.find(f'{{{P}}}cSld/{{{P}}}spTree')
            objects=[s for s in tree.iter() if s.tag in {f'{{{P}}}sp',f'{{{P}}}pic',f'{{{P}}}cxnSp',f'{{{P}}}graphicFrame'}]
            if len(objects)!=len(elements):errors.append(f'S{i+1}: object inventory mismatch')
            errors.extend(material_image_errors(z,names,r,xml.get(f'ppt/slides/_rels/slide{i+1}.xml.rels'),tree,spec,i))
            background=(spec.get('backgrounds') or [None]*len(spec['slides']))[i]
            if background:
                blip=r.find(f'{{{P}}}cSld/{{{P}}}bg/{{{P}}}bgPr/{{{A}}}blipFill/{{{A}}}blip')
                rid=blip.get(f'{{{R}}}embed') if blip is not None else None
                rels=xml.get(f'ppt/slides/_rels/slide{i+1}.xml.rels')
                target=next((rel.get('Target') for rel in rels if rel.get('Id')==rid),None) if rels is not None else None
                media=posixpath.normpath(posixpath.join('ppt/slides',target)) if target else None
                if not media or media not in names or hashlib.sha256(z.read(media)).hexdigest()!=background['sha256']:errors.append(f'S{i+1}: registered background mismatch')
            audits.append({'index':i,'objects':len(objects),'texts':sum(actual.values()),'pictures':len(r.findall(f'.//{{{P}}}pic')),'background':background['id'] if background else None})
    return {'passed':not errors,'errors':errors,'slides':audits,'pptx_sha256':hashlib.sha256(Path(deck).read_bytes()).hexdigest()}
if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('deck');parser.add_argument('spec');parser.add_argument('--pages');parser.add_argument('--baseline');args=parser.parse_args()
    result=check(args.deck,json.loads(Path(args.spec).read_text(encoding='utf-8')),set(map(int,args.pages.split(','))) if args.pages else None,json.loads(Path(args.baseline).read_text(encoding='utf-8')) if args.baseline else None)
    print(json.dumps(result,ensure_ascii=False))
    sys.exit(0 if result['passed'] else 1)
