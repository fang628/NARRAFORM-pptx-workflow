"""Web release adapter: validate OOXML, exact native text, object inventory and hashes."""
import json, sys, zipfile, hashlib, posixpath
from collections import Counter
from pathlib import Path
import xml.etree.ElementTree as ET

P='http://schemas.openxmlformats.org/presentationml/2006/main'
A='http://schemas.openxmlformats.org/drawingml/2006/main'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
def check(deck, spec, pages=None, baseline=None):
    errors=[]
    if pages is not None and baseline:
        import re
        errors.extend(e for e in baseline.get('errors',[]) if (match:=re.match(r'^S(\d+):',e)) and int(match.group(1))-1 not in pages)
    with zipfile.ZipFile(deck) as z:
        names=z.namelist()
        if z.testzip() or len(names)!=len(set(names)): errors.append('ZIP integrity failure')
        xml={n:ET.fromstring(z.read(n)) for n in names if n.endswith(('.xml','.rels'))}
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
            expected=Counter(e['text'] for e in elements if e['type']=='text')
            actual=Counter(''.join(s.itertext()) for s in r.findall(f'.//{{{P}}}sp/{{{P}}}txBody/{{{A}}}p/{{{A}}}r/{{{A}}}t'))
            # Multi-line text can contain separate runs; compare each native text shape.
            actual=Counter(''.join(t.text or '' for t in s.findall(f'.//{{{A}}}t')) for s in r.findall(f'.//{{{P}}}sp') if s.find(f'{{{P}}}txBody') is not None)
            def normalize(counts):
                normalized=Counter()
                for text,count in counts.items():
                    normalized[text.replace('\n','').replace('\r','')]+=count
                return normalized
            if normalize(expected)!=normalize(actual):errors.append(f'S{i+1}: exact native text mismatch')
            tree=r.find(f'{{{P}}}cSld/{{{P}}}spTree')
            objects=[s for s in tree if s.tag in {f'{{{P}}}sp',f'{{{P}}}pic',f'{{{P}}}cxnSp',f'{{{P}}}graphicFrame'}]
            if len(objects)!=len(elements):errors.append(f'S{i+1}: object inventory mismatch')
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
