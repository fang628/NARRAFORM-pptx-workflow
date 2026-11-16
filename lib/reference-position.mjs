import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildObjectMasks} from './object-masks.mjs';

const run=promisify(execFile);
export async function relocateReferenceElements(context){
 const {env,project,index,preview,elements,signal,targetKeys}=context;
 if(!preview||!fs.existsSync(preview))return {elements,records:[]};
 const script=path.join(env.root,'tools','reference_position.py');
 const algorithm=crypto.createHash('sha256').update(fs.readFileSync(script)).update(fs.readFileSync(path.join(env.root,'lib','styled-text.mjs'))).update(fs.readFileSync(path.join(env.root,'lib','visual-model.mjs'))).digest('hex');
 const previewHash=crypto.createHash('sha256').update(fs.readFileSync(preview)).digest('hex');
 const circleElements=elements.filter(e=>e.type==='ellipse'&&!e.managed&&!e.tableId&&!e.tableRole&&!e.effectOf&&e.role!=='effect'&&Math.max(e.w,e.h)<=80);
 const circleEntry=e=>[e.key,e.x,e.y,e.w,e.h,e.strokeWidth,e.rotate,e.visualState,e.emphasis,e.fillOpacity,e.opacity,e.objectIdentity?.sourceBox];
 const circleSignature=circleElements.map(circleEntry);
 const fingerprint=e=>crypto.createHash('sha256').update(JSON.stringify([algorithm,previewHash,e.type==='ellipse'?circleSignature:null,e.type,e.x,e.y,e.w,e.h,e.text,e.latex,e.fontFace,e.size,e.bold,e.italic,e.lineSpacing,e.charSpacing,e.align,e.color,e.textColorRuns,e.boldRuns,e.svg,e.id,e.shape,e.shapeGeometry,e.customGeometry])).digest('hex');
 const targets=elements.filter(e=>!e.managed&&e.role!=='navigation'&&!/^nf-(progress|footer)-/.test(e.key||'')&&!e.tableId&&!e.tableRole&&!e.tablePlaced&&!e._tableStage
  &&e.referencePositionEvidence?.fingerprint!==fingerprint(e)
  &&(!targetKeys||targetKeys.includes(e.key))&&!e.keepParameters?.some(p=>['position','x','y'].includes(p))
  &&['text','formula','svg','cutout','image','shape','rect','ellipse'].includes(e.type)
  // Planned material originals keep the approved image placement.
  &&!(e.type==='image'&&!e.implementation)&&e.w>0&&e.h>0);
 if(!targets.length)return {elements,records:[]};
 const masks=await buildObjectMasks({elements:targets,directory:path.join(env.data,project.id,'geometry-records','object-masks'),getImage:id=>env.getImage?.(project,id),signal});
 const foundation=project.visualPages?.[index]?.foundation?.file;
 const background=context.background||(foundation?path.join(env.data,project.id,foundation):null);
 const spec={reference:preview,elements:targets,circleElements,objectMasks:masks,...(background&&fs.existsSync(background)?{background}:{})};
 const hash=crypto.createHash('sha256').update(JSON.stringify(spec)).update(fs.readFileSync(script)).update(fs.readFileSync(preview));
 if(spec.background)hash.update(fs.readFileSync(spec.background));
 for(const mask of masks)if(mask.file)hash.update(fs.readFileSync(mask.file));
 const dir=path.join(env.data,project.id,'geometry-records','reference-position',String(index)+'-'+hash.digest('hex').slice(0,20));
 fs.mkdirSync(dir,{recursive:true});const input=path.join(dir,'input.json'),output=path.join(dir,'output.json');
 fs.writeFileSync(input,JSON.stringify(spec));
 if(!fs.existsSync(output))await (env.run||run)(context.python||process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),[script,input,output],{windowsHide:true,timeout:30000,signal,maxBuffer:1000000});
 const result=JSON.parse(fs.readFileSync(output,'utf8')),byKey=new Map(result.results.map(r=>[r.key,r]));
 const locatedElements=elements.map(e=>{const r=byKey.get(e.key);return r?.accepted?{...e,x:r.x,y:r.y}:e;});
 const locatedCircleSignature=locatedElements.filter(e=>circleElements.some(c=>c.key===e.key)).map(circleEntry);
 circleSignature.splice(0,circleSignature.length,...locatedCircleSignature);
 return {elements:locatedElements.map(e=>{const r=byKey.get(e.key);if(!r)return e;const next={...e};
  return {...next,referencePositionEvidence:{...r,source:'preview-object-registration',fingerprint:fingerprint(next)}};}),records:result.results,directory:dir};
}
