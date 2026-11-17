import fs from 'node:fs';
import JSZip from 'jszip';
import {chapterOrder} from './chapter-pages.mjs';

// Keep slide part names stable for saved measurements and incremental checks.
// Presentation order is defined by sldIdLst, independently of those filenames.
export async function orderChapterSlides(p,file){
  const order=chapterOrder(p);
  if(order.every((value,index)=>value===index))return false;
  const zip=await JSZip.loadAsync(fs.readFileSync(file)),part='ppt/presentation.xml',xml=await zip.file(part).async('string');
  const rels=await zip.file('ppt/_rels/presentation.xml.rels').async('string');
  const relationships=new Map([...rels.matchAll(/<Relationship\s[^>]+>/g)].map(m=>{const a=Object.fromEntries([...m[0].matchAll(/([\w:]+)="([^"]*)"/g)].map(v=>[v[1],v[2]]));return [a.Id,a.Target];}));
  const ids=new Map([...xml.matchAll(/<p:sldId\s[^>]*\/?\s*>/g)].map(match=>{const rid=match[0].match(/r:id="([^"]+)"/)?.[1],part=relationships.get(rid),number=part?.match(/slides\/slide(\d+)\.xml$/)?.[1];return [Number(number)-1,match[0]];}));
  if(ids.size!==order.length||order.some(i=>!ids.has(i)))throw Error('章节页导出顺序与实际页数不一致');
  zip.file(part,xml.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,'<p:sldIdLst>'+order.map(i=>ids.get(i)).join('')+'</p:sldIdLst>'));
  fs.writeFileSync(file,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));return true;
}
