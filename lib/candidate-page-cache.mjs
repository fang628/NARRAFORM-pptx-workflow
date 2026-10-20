import fs from 'node:fs';
import path from 'node:path';
import {digest,visualStamp} from './visual-model.mjs';
import {deliveryMotionPlan} from './rebuild-progress.mjs';

export function reusableCandidatePages(p,env){
  const c=p.candidate;
  if(!c||c.version!==p.version||c.stamp!==visualStamp(p)||!c.review?.pages?.length)return null;
  const base=path.resolve(env.data,p.id,c.dir),root=path.resolve(env.data,p.id)+path.sep;
  if(!base.startsWith(root))return null;
  try{
    const proofs=new Map(c.proofs.map(f=>[f.file,f.sha256]));
    const verify=file=>{const full=path.join(base,file);return proofs.has(file)&&fs.existsSync(full)&&digest(fs.readFileSync(full))===proofs.get(file);};
    if(!['deck-spec.json','motion-plan.json','render-manifest.json','structure-report.json','qa-review.json',c.file].every(verify))return null;
    const read=file=>JSON.parse(fs.readFileSync(path.join(base,file),'utf8'));
    const spec=read('deck-spec.json'),motion=read('motion-plan.json'),manifest=read('render-manifest.json'),structure=read('structure-report.json'),currentMotion=deliveryMotionPlan(p);
    if(spec.slides.length!==p.slides.length||manifest.pages.length!==p.slides.length)return null;
    const oldMaterials=verify('content.json')?read('content.json').materials:[],assetHashes=c.assetHashes||Object.fromEntries(oldMaterials.map(m=>[m.id,m.sha256]));
    const indices=[];
    for(const [i,page]of p.reconstruction.slides.entries()){
      const review=c.review.pages[i],rendered=manifest.pages[i];
      if(!review||review.pending||review.reviewUnavailable||!structure.slides?.[i]||!rendered)continue;
      if(digest([spec.slides[i],spec.backgrounds?.[i],motion.pages?.[i],motion.settings])!==digest([page.elements,page.background,currentMotion.pages[i],currentMotion.settings]))continue;
      if(!verify(rendered.file)||!verify(`approved-${i}.png`)||digest(fs.readFileSync(path.join(base,`approved-${i}.png`)))!==p.visualPages[i].previewHash)continue;
      if(![`rebuilt-${i}.png`,`compare-${i}.png`].every(verify))continue;
      if([page.background,...page.elements.filter(e=>e.type==='image')].some(e=>{const id=e.id,m=p.materials.find(m=>m.id===id),file=env.getImage(p,id);return !m||!file||!fs.existsSync(file)||digest(fs.readFileSync(file))!==m.sha256||m.sha256!==(assetHashes[id]|| (id===page.background.id?page.background.sha256:null));}))continue;
      indices.push(i);
    }
    return {base,candidate:structuredClone(c),indices,manifest,structure,proofs};
  }catch{return null;}
}
export function copyReusablePageFiles(reuse,dir){
  for(const i of reuse.indices){
    const files=[reuse.manifest.pages[i].file,`approved-${i}.png`,`rebuilt-${i}.png`,`compare-${i}.png`,`difference-${i}.png`,`analysis-${i}.json`,`geometry-${i}.png`,...(reuse.candidate.review.pages[i].responseValidation?.records||[])];
    for(const file of files){if(path.basename(file)!==file)continue;const from=path.join(reuse.base,file);if(reuse.proofs.has(file)&&fs.existsSync(from)&&digest(fs.readFileSync(from))===reuse.proofs.get(file))fs.copyFileSync(from,path.join(dir,file));}
  }
}
