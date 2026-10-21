import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import {digest,visualStamp} from './visual-model.mjs';
import {rebuildPresentationStamp} from './rebuild-progress.mjs';
import {rebuildPageIssues} from './rebuild-quality.mjs';

// A successfully assembled deck remains a usable draft if rendering/checking
// fails. Keep quality failure separate from file identity and version checks.
export async function retainUnreviewedDraft(p,env,dir,{issue,structure}={}){
  const file='deck.pptx',deck=path.join(dir,file);
  if(!fs.existsSync(deck)||fs.statSync(deck).size<4)return null;
  const bytes=fs.readFileSync(deck);if(bytes.readUInt32LE(0)!==0x04034b50)return null;
  try{const zip=await JSZip.loadAsync(bytes);if(!zip.file('ppt/presentation.xml')||!zip.file('[Content_Types].xml'))return null;}catch{return null;}
  const id=crypto.randomUUID(),at=new Date().toISOString();
  structure||={passed:false,errors:[issue||'构建后检验未完成'],slides:[]};
  const pages=p.slides.map((_,index)=>({index,pending:false,passed:false,reviewUnavailable:true,checks:{},issues:[...new Set([issue||'渲染或检验未完成',...rebuildPageIssues(p,index,structure)])],deviations:[],notes:'已保留本次实际组装的 PPTX，检查未通过不影响下载。',manual:null}));
  const review={candidateId:id,at,pages};
  fs.writeFileSync(path.join(dir,'qa-review.json'),JSON.stringify(review,null,2));
  fs.writeFileSync(path.join(dir,'structure-report.json'),JSON.stringify(structure,null,2));
  const proofs=fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile()).map(e=>({file:e.name,sha256:digest(fs.readFileSync(path.join(dir,e.name)))}));
  p.candidate={id,version:p.version,stamp:visualStamp(p),presentationStamp:rebuildPresentationStamp(p),dir:path.relative(path.join(env.data,p.id),dir),file,renderer:'unavailable',renderUnavailable:true,status:'failed',structure,review,proofs,assetIds:[...new Set(p.reconstruction.slides.flatMap(s=>[s.background.id,...s.elements.filter(e=>e.type==='image').map(e=>e.id)]))],at};
  p.stage=6;env.save(p);return p.candidate;
}
