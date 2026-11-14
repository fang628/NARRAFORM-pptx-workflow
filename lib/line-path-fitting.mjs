import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {buildObjectMasks} from './object-masks.mjs';
import {lineCommands,validateLinePath} from './line-path.mjs';
import {preparePaintContext,paintVisibilitySignature,paintCompositeSignature} from './paint-context.mjs';
const run=promisify(execFile);

export async function fitLinePaths(context){
 const {env,project,index,preview,elements,signal,targetKeys}=context;
 const targets=elements.filter(e=>e.type==='line'&&!e.managed&&!e.tableId&&!e.tableRole&&!e.key?.startsWith('nf-')&&(context.finalize||!targetKeys||targetKeys.includes(e.key)));
 if(!targets.length)return {elements,results:[]};
 const background=context.background||(project.visualPages?.[index]?.foundation?.file?path.join(env.data,project.id,project.visualPages[index].foundation.file):null);
 const previous=context.paintState?.visibleContext;
 const reusable=previous?.signature===paintVisibilitySignature(elements)&&previous?.compositeSignature===paintCompositeSignature(elements);
 const paint=context.styleOnly?(reusable?previous:await preparePaintContext({env,project,index,preview,elements,background,signal})):null;
 const masks=paint?.masks||await buildObjectMasks({elements:elements.filter(e=>e.type!=='line'),directory:path.join(env.data,project.id,'geometry-records','object-masks'),getImage:id=>env.getImage?.(project,id),signal});
 const occluders=Object.fromEntries(elements.map((e,index)=>[e.key,elements.slice(index+1).filter(o=>o.type!=='line'&&!o.managed).map(o=>o.key)]));
 const directory=path.join(env.data,project.id,'geometry-records','line-path',String(index),crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
 const input=path.join(directory,'input.json'),output=path.join(directory,'output.json');
 fs.writeFileSync(input,JSON.stringify({operation:context.styleOnly?'style':context.finalize?'finalize':'fit',editableKeys:targetKeys,scoped:targetKeys!=null,scene:elements,underlays:paint?.underlays,
  reference:preview,background,occluders,elements:targets.map(e=>({...e,linePath:{...e.linePath,version:1,commands:lineCommands(e)}})),objectMasks:masks}));
 await (env.run||run)(context.python||process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),[path.join(env.root,'tools','line_path_fit.py'),input,output],{windowsHide:true,timeout:30000,signal,maxBuffer:1000000});
 const payload=JSON.parse(fs.readFileSync(output,'utf8')),results=payload.results,byKey=new Map(results.map(r=>[r.key,r]));
 const merged=new Map((payload.scene||[]).map(e=>[e.key,e]));
 return {elements:elements.map(original=>{if(targetKeys&&!targetKeys.includes(original.key))return original;const e=context.finalize?merged.get(original.key)||original:original;const r=byKey.get(e.key);if(!r)return e;
   if(context.styleOnly)return {...original,...(r.accepted?r.style:{}),parameterEvidence:{...original.parameterEvidence,...(r.style?.parameterEvidence||{})},
    pathFitEvidence:{...original.pathFitEvidence,style:r.accepted?r.style:{},styleEvidence:r.evidence,styleAccepted:r.accepted},linePaintEvidence:r.evidence};
   const next={...e,...(r.accepted&&!context.finalize?r.geometry:{}),linePath:r.accepted&&!context.finalize?validateLinePath(r.geometry.linePath):{...e.linePath,version:1,commands:lineCommands(e)},
    pathFitEvidence:{source:'joint-path-fit',...r.evidence,accepted:r.accepted,style:r.style||{}},
    geometryEvidence:context.finalize?e.geometryEvidence:{source:'joint-path-fit',accepted:r.accepted,support:r.evidence?.support,boundaryP95:r.evidence?.p95},
    flipH:false,flipV:false};
   if(r.accepted&&!context.finalize)next.parameterEvidence={...e.parameterEvidence,slant:{confidence:Math.max(0,(r.evidence.support||0)*(1-(r.evidence.p95||0)/6)),independent:true,source:'path-boundary'}};
   if(r.accepted&&!context.finalize){
    for(const [i,c]of next.linePath.commands.entries())if(i&&c.op==='L')next.parameterEvidence['slant:'+i]={...(r.evidence.segments?.[i]||{confidence:0,independent:true}),source:'path-segment-boundary',observationId:e.key+':path-fit'};
   }
   return next;
 }),results,slantGroups:payload.slantGroups||[],directory};
}
