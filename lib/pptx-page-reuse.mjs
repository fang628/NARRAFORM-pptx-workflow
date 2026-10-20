import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';

const relFile=part=>path.posix.join(path.posix.dirname(part),'_rels',path.posix.basename(part)+'.rels');
const attrs=text=>Object.fromEntries([...text.matchAll(/([\w:]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
const relationships=xml=>[...xml.matchAll(/<Relationship\s+([^>]+)\/?\s*>/g)].map(m=>({raw:m[0],...attrs(m[1])}));
const resolve=(part,target)=>target.startsWith('/')?target.slice(1):path.posix.normalize(path.posix.join(path.posix.dirname(part),target));

// Import changed slide dependency graphs into the previously delivered package.
// Unchanged slides and their relationship parts remain byte-for-byte untouched.
export async function mergePptxPages(previous,fresh,indices){
  const base=await JSZip.loadAsync(previous),source=await JSZip.loadAsync(fresh),prefix='ppt/nf-patch-'+crypto.randomUUID()+'/';
  let types=await base.file('[Content_Types].xml').async('string');
  const sourceTypes=await source.file('[Content_Types].xml').async('string');
  const overrides=new Map([...sourceTypes.matchAll(/<Override\s+([^>]+)\/?\s*>/g)].map(m=>{const a=attrs(m[1]);return [a.PartName.slice(1),a.ContentType];}));
  for(const m of sourceTypes.matchAll(/<Default\s+([^>]+)\/?\s*>/g)){const a=attrs(m[1]);if(!types.includes('Extension="'+a.Extension+'"'))types=types.replace('</Types>',m[0]+'</Types>');}
  // These are the fixed NARRAFORM/PptxGenJS templates. PowerPoint normalizes
  // their XML on save; keep the original master/layout instead of importing a
  // second notes master or duplicate layout IDs. Page objects carry explicit styles.
  const inherited=new Set(['ppt/slideLayouts/slideLayout1.xml','ppt/slideMasters/slideMaster1.xml','ppt/notesMasters/notesMaster1.xml'].filter(part=>source.file(part)&&base.file(part)));
  const mapped=new Map(indices.map(i=>['ppt/slides/slide'+(i+1)+'.xml','ppt/slides/slide'+(i+1)+'.xml'])),copied=new Set(),equality=new Map(),masters=[];
  async function identical(part,visiting=new Set()){
    if(equality.has(part))return equality.get(part);if(visiting.has(part))return true;
    const a=source.file(part),b=base.file(part);if(!a||!b)return false;
    if(!(await a.async('nodebuffer')).equals(await b.async('nodebuffer')))return false;
    const r=relFile(part),ar=source.file(r),br=base.file(r);if(!!ar!==!!br)return false;
    if(!ar){equality.set(part,true);return true;}
    const ax=await ar.async('string');if(ax!==await br.async('string'))return false;
    const next=new Set(visiting).add(part);
    for(const rel of relationships(ax))if(rel.TargetMode!=='External'&&!await identical(resolve(part,rel.Target),next))return false;
    equality.set(part,true);return true;
  }
  async function copy(part){
    if(inherited.has(part))return part;
    if(!mapped.has(part)){
      if(await identical(part))return part;
      mapped.set(part,prefix+part);
    }
    const destination=mapped.get(part);if(copied.has(part))return destination;copied.add(part);
    const file=source.file(part);if(!file)throw Error('增量PPT依赖缺失：'+part);
    base.file(destination,await file.async('nodebuffer'));
    const contentType=overrides.get(part);if(contentType){types=types.replace(new RegExp('<Override\\s+[^>]*PartName="/'+destination.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'"[^>]*/>'),'');types=types.replace('</Types>',`<Override PartName="/${destination}" ContentType="${contentType}"/></Types>`);}
    const rels=source.file(relFile(part));
    if(rels){let xml=await rels.async('string');for(const rel of relationships(xml))if(rel.TargetMode!=='External'){
      const target=await copy(resolve(part,rel.Target));
      xml=xml.replace(rel.raw,rel.raw.replace(/Target="[^"]*"/,'Target="'+path.posix.relative(path.posix.dirname(destination),target)+'"'));
    }base.file(relFile(destination),xml);}else base.remove(relFile(destination));
    if(/presentationml\.(slideMaster|notesMaster)\+xml$/.test(contentType||'')&&destination!==part)masters.push({destination,notes:contentType.includes('notesMaster')});
    return destination;
  }
  for(const i of indices)await copy('ppt/slides/slide'+(i+1)+'.xml');
  if(masters.length){
    let presentation=await base.file('ppt/presentation.xml').async('string'),rels=await base.file('ppt/_rels/presentation.xml.rels').async('string');
    let rid=Math.max(0,...[...rels.matchAll(/Id="rId(\d+)"/g)].map(m=>+m[1])),mid=Math.max(2147483647,...[...presentation.matchAll(/<p:sldMasterId\b[^>]*\bid="(\d+)"/g)].map(m=>+m[1]));
    for(const master of masters){const id='rId'+(++rid),kind=master.notes?'notesMaster':'slideMaster';rels=rels.replace('</Relationships>',`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${path.posix.relative('ppt',master.destination)}"/></Relationships>`);
      const tag=master.notes?'notesMasterId':'sldMasterId',entry=`<p:${tag}${master.notes?'':` id="${++mid}"`} r:id="${id}"/>`,list=`p:${tag}Lst`;
      presentation=presentation.includes(`</${list}>`)?presentation.replace(`</${list}>`,entry+`</${list}>`):presentation.replace('<p:sldIdLst>',`<${list}>${entry}</${list}><p:sldIdLst>`);
    }
    base.file('ppt/presentation.xml',presentation);base.file('ppt/_rels/presentation.xml.rels',rels);
  }
  // Drop dependencies no longer referenced by any slide/master, so repeated
  // single-page edits do not accumulate obsolete media inside the PPTX itself.
  const reachable=new Set(['[Content_Types].xml']);
  async function visit(part){
    if(part&&reachable.has(part))return;if(part)reachable.add(part);
    const name=relFile(part),rels=base.file(name);if(!rels)return;reachable.add(name);
    for(const rel of relationships(await rels.async('string')))if(rel.TargetMode!=='External')await visit(resolve(part,rel.Target));
  }
  await visit('');
  for(const name of Object.keys(base.files))if(!base.files[name].dir&&!reachable.has(name))base.remove(name);
  types=types.replace(/<Override\s+([^>]+)\/?\s*>/g,(raw,attributes)=>base.file(attrs(attributes).PartName.slice(1))?raw:'');
  base.file('[Content_Types].xml',types);
  return base.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
