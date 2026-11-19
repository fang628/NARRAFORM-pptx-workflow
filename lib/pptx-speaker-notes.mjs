import path from 'node:path';
import JSZip from 'jszip';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';

const P='http://schemas.openxmlformats.org/presentationml/2006/main';
const A='http://schemas.openxmlformats.org/drawingml/2006/main';
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG='http://schemas.openxmlformats.org/package/2006/relationships';
const elements=(node,ns,name)=>Array.from(node.getElementsByTagNameNS(ns,name));
const children=(node,ns,name)=>Array.from(node.childNodes).filter(child=>child.namespaceURI===ns&&child.localName===name);

async function xmlPart(zip,part){
  const entry=zip.file(part);
  if(!entry)throw Error('PPTX 缺少备注所需的部件：'+part);
  return new DOMParser().parseFromString(await entry.async('string'),'application/xml');
}
async function relationships(zip,part){
  const directory=path.posix.dirname(part);
  const doc=await xmlPart(zip,path.posix.join(directory,'_rels',path.posix.basename(part)+'.rels'));
  return elements(doc,PKG,'Relationship').filter(rel=>rel.getAttribute('TargetMode')!=='External').map(rel=>{
    const target=rel.getAttribute('Target');
    return {id:rel.getAttribute('Id'),type:rel.getAttribute('Type'),part:target.startsWith('/')?target.slice(1):path.posix.join(directory,target)};
  });
}
function writeBody(doc,notes,part){
  const shape=elements(doc,P,'sp').find(sp=>elements(sp,P,'ph').some(ph=>ph.getAttribute('type')==='body'));
  const body=shape&&children(shape,P,'txBody')[0];
  if(!body)throw Error('PPTX 备注正文占位符缺失：'+part);
  const paragraphs=children(body,A,'p');
  const source=paragraphs.flatMap(p=>elements(p,A,'t').map(t=>t.textContent).join('').split(/\r?\n/)).map(line=>line.trim()).filter(Boolean).at(-1);
  const text=source?.startsWith('来源材料：')?notes+'\n\n'+source:notes;
  for(const p of paragraphs)body.removeChild(p);
  for(const line of text.split(/\r\n?|\n/)){
    const p=doc.createElementNS(A,'a:p');
    if(line){
      const run=doc.createElementNS(A,'a:r'),t=doc.createElementNS(A,'a:t');
      t.appendChild(doc.createTextNode(line));run.appendChild(t);p.appendChild(run);
    }
    body.appendChild(p);
  }
}

export async function embedSpeakerNotes(bytes,pageNotes){
  const zip=await JSZip.loadAsync(bytes),presentation='ppt/presentation.xml';
  const doc=await xmlPart(zip,presentation),slides=elements(doc,P,'sldId');
  if(slides.length!==pageNotes.length)throw Error('PPTX 实际放映页数与讲稿不一致');
  const slideParts=new Map((await relationships(zip,presentation)).filter(rel=>rel.type===R+'/slide').map(rel=>[rel.id,rel.part]));
  const serializer=new XMLSerializer(),seen=new Set();
  for(const [i,slide] of slides.entries()){
    if(pageNotes[i]===null)continue;
    const slidePart=slideParts.get(slide.getAttributeNS(R,'id'));
    if(!slidePart)throw Error(`PPTX 第${i+1}页的幻灯片关系缺失`);
    const part=(await relationships(zip,slidePart)).find(rel=>rel.type===R+'/notesSlide')?.part;
    if(!part||seen.has(part))throw Error(`PPTX 第${i+1}页的备注关系缺失或重复`);
    seen.add(part);
    const notesDoc=await xmlPart(zip,part);
    writeBody(notesDoc,pageNotes[i],part);
    zip.file(part,serializer.serializeToString(notesDoc));
  }
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
