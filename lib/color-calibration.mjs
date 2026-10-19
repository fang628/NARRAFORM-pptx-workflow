import fs from 'node:fs';import path from 'node:path';
import {colorAdjustment} from './color-adjustment.mjs';
// Changes are tentative until the next actual PowerPoint render improves DeltaE.
export function applyColorCalibration(page,report,state={pending:new Map(),blocked:new Set()},{allowProposals=true}={}){
 const records=[],targets=new Map([['__background__',page.background],...page.elements.map(e=>[e.key,e])]);let changed=false;
 for(const region of report?.regions||[]){
  const target=targets.get(region.key);if(!target||region.key.startsWith('nf-progress-')||region.key!=='__background__'&&!(target.type==='image'&&target.implementation==='cutout'))continue;
  const prior=state.pending.get(region.key);
  if(prior){
   if(!Number.isFinite(region.error)||region.error>prior.error- Math.max(.5,prior.error*.05)){
    if(prior.before===undefined)delete target.colorAdjustment;else target.colorAdjustment=prior.before;
    state.blocked.add(region.key);records.push({key:region.key,status:'reverted',beforeError:prior.error,afterError:region.error});changed=true;
   }else records.push({key:region.key,status:'accepted',beforeError:prior.error,afterError:region.error});
   state.pending.delete(region.key);
  }
  if(!allowProposals||state.blocked.has(region.key)||region.status!=='proposed')continue;
  const before=target.colorAdjustment===undefined?undefined:structuredClone(target.colorAdjustment),old=before||{saturation:1,brightness:0};
  const next=colorAdjustment({saturation:Math.max(.7,Math.min(1.3,old.saturation*region.saturation)),brightness:Math.max(-.12,Math.min(.12,old.brightness+region.brightness))});
  if(Math.abs(next.saturation-old.saturation)<.001&&Math.abs(next.brightness-old.brightness)<.001)continue;
  target.colorAdjustment=next;state.pending.set(region.key,{before,error:region.error});records.push({...region,applied:next,status:'pending'});changed=true;
 }
 // Missing samples after a change cannot prove improvement. Restore safely.
 for(const [key,prior]of [...state.pending])if(!(report?.regions||[]).some(r=>r.key===key)){
  const target=targets.get(key);if(target){if(prior.before===undefined)delete target.colorAdjustment;else target.colorAdjustment=prior.before;changed=true;}
  state.pending.delete(key);state.blocked.add(key);records.push({key,status:'reverted',reason:'missing_samples'});
 }
 return {changed,records,state};
}
export async function measureColorCalibration(env,python,pages,directory,signal){
 fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'input.json');
 try{fs.writeFileSync(file,JSON.stringify({pages}));
 return JSON.parse((await env.run(python,[path.join(env.root,'tools/color_calibration.py'),file],{windowsHide:true,timeout:60000,maxBuffer:2000000,signal})).stdout);}
 catch(error){if(signal?.aborted)throw error;return {pages:pages.map(()=>({status:'unavailable',regions:[]})),error:String(error.stderr||error.message).slice(-700)};}
}
