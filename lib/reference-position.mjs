import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildObjectMasks} from './object-masks.mjs';
import {fileDigest} from './file-digest.mjs';

const run=promisify(execFile);
export async function relocateReferenceElements(context){
 const {env,project,index,preview,elements,signal,targetKeys}=context;
 if(!preview||!fs.existsSync(preview))return {elements,records:[]};
 const script=path.join(env.root,'tools','reference_position.py');
 const foundation=project.visualPages?.[index]?.foundation?.file;
 const background=context.background||(foundation?path.join(env.data,project.id,foundation):null);
 const sources=[script,path.join(env.root,'tools','repeated_panel_position.py'),...['styled-text','visual-model','object-masks','reference-position'].map(name=>path.join(env.root,'lib',name+'.mjs')),preview];
 if(background&&fs.existsSync(background))sources.push(background);
 const sourceHash=crypto.createHash('sha256').update(sources.map(fileDigest).join('')).digest('hex');
 const circleElements=elements.filter(e=>e.type==='ellipse'&&!e.managed&&!e.tableId&&!e.tableRole&&!e.effectOf&&e.role!=='effect'&&Math.max(e.w,e.h)<=80);
 const circleEntry=e=>[e.key,e.x,e.y,e.w,e.h,e.fill,e.strokeWidth,e.rotate,e.visualState,e.emphasis,e.fillOpacity,e.opacity,e.objectIdentity?.sourceBox];
 const circleSignature=circleElements.map(circleEntry);
 const badges=elements.filter(e=>e.type==='text'&&e.role==='visual-number'&&e.carrierId&&e.forNodeId).flatMap(number=>{
  const circle=circleElements.find(e=>e.key===number.carrierId);
  const heading=elements.find(e=>e.type==='text'&&e.role==='heading'&&e.nodeId===number.forNodeId);
  const band=heading&&elements.find(e=>e.key===heading.carrierId&&['rect','shape'].includes(e.type)&&!e.tableId);
  return circle&&band?[{number,heading,band,circle}]:[];
 });
 const badgeContext=new Map(badges.flatMap(({number,heading,band,circle})=>[number,heading,band].map(e=>[e.key,[circle.key,number.key,heading.key,band.key,band.fill,band.w,band.h,heading.color,heading.size,number.color,number.size]])));
 const carriers=new Set(elements.filter(e=>e.type==='text'&&e.carrierId).map(e=>e.carrierId));
 const panels=elements.filter(e=>carriers.has(e.key)&&['rect','shape'].includes(e.type)&&['rect','roundRect'].includes(e.shape||e.type)&&e.parameterGroups?.shape&&e.w>=120&&e.h>=75&&!e.rotate&&!e.tableId&&!e.tableRole&&!e.managed);
 const panelSignature=panels.map(e=>[e.key,e.parameterGroups.shape,e.objectIdentity?.sourceBox||[e.x,e.y,e.w,e.h]]);
 const assetDigest=id=>{const file=id&&env.getImage?.(project,id);if(!file)return null;
  if(file.startsWith('data:'))return crypto.createHash('sha256').update(file).digest('hex');
  return fs.existsSync(file)?fileDigest(file):null;};
 const fingerprint=e=>crypto.createHash('sha256').update(JSON.stringify([sourceHash,(e.carrierId||carriers.has(e.key)||e.type==='ellipse')?[e.carrierId,panelSignature]:null,e.type==='ellipse'||badgeContext.has(e.key)?circleSignature:null,badgeContext.get(e.key),e.type,e.x,e.y,e.w,e.h,e.text,e.latex,e.fontFace,e.size,e.bold,e.italic,e.lineSpacing,e.charSpacing,e.align,e.color,e.fill,e.textColorRuns,e.boldRuns,e.svg,e.id,e.shape,e.shapeGeometry,e.customGeometry,e.strokeWidth,e.rotate,e.flipH,e.flipV,e.objectIdentity?.sourceBox,e.type==='image'?assetDigest(e.id):null])).digest('hex');
 const targets=elements.filter(e=>!e.managed&&e.role!=='navigation'&&!/^nf-(progress|footer)-/.test(e.key||'')&&!e.tableId&&!e.tableRole&&!e.tablePlaced&&!e._tableStage
  &&(!targetKeys||targetKeys.includes(e.key))&&!e.keepParameters?.some(p=>['position','x','y'].includes(p))
  &&['text','formula','svg','cutout','image','shape','rect','ellipse'].includes(e.type)
  // Planned material originals keep the approved image placement.
  &&!(e.type==='image'&&!e.implementation)&&e.w>0&&e.h>0&&e.referencePositionEvidence?.fingerprint!==fingerprint(e));
 if(!targets.length)return {elements,records:[]};
 const masks=await buildObjectMasks({elements:targets,directory:path.join(env.data,project.id,'geometry-records','object-masks'),getImage:id=>env.getImage?.(project,id),signal});
 const spec={reference:preview,elements:targets,circleElements,panels,badges:badges.filter(g=>[g.number,g.heading,g.band].some(e=>targets.includes(e))),objectMasks:masks,...(background&&fs.existsSync(background)?{background}:{})};
 const hash=crypto.createHash('sha256').update(JSON.stringify(spec)).update(sourceHash);
 for(const mask of masks)if(mask.file)hash.update(fileDigest(mask.file));
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
