import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {preparePaintContext,paintVisibilitySignature,paintCompositeSignature,paintSampleHash} from './paint-context.mjs';
import {arrangeScene} from './scene-hierarchy.mjs';

const run=promisify(execFile);
export async function mergeMeasuredPaint(context){
  const {env,project,index,preview,signal}=context;
  const originals=context.elements||[],keys=new Set(originals.map(element=>element.key));
  const elements=arrangeScene([...originals,...(context.paintOccluders||[]).filter(element=>!keys.has(element.key)).map(element=>({...element,_stagedSkip:true}))]).map(element=>{
    const {paintConsensus,...next}=element;return next;
  });
  if(!preview||!fs.existsSync(preview)||!elements.some(element=>element.gradient||element.fill))return {elements:originals,records:[]};
  const directory=path.join(env.data,project.id,'geometry-records','paint-consensus','page-'+(index+1),crypto.randomUUID());
  fs.mkdirSync(directory,{recursive:true});
  const foundation=project.visualPages?.[index]?.foundation?.file,background=foundation?path.join(env.data,project.id,foundation):null;
  const previous=context.paintState?.visibleContext;
  const compositeSignature=paintCompositeSignature(elements);
  const reusable=previous?.signature===paintVisibilitySignature(elements)
    &&(!Object.keys(previous.underlays||{}).length||previous.compositeSignature===compositeSignature);
  const paint=reusable?previous:
    await preparePaintContext({env,project,index,preview,elements,background,signal});
  const input=path.join(directory,'input.json'),output=path.join(directory,'output.json');
  const signature=paintVisibilitySignature(elements),sample=context.paintState?.sampleEvidence;
  const samplesValid=sample?.signature===signature&&fs.existsSync(sample.file)
    &&sample.sourceHash===paintSampleHash(preview,paint)
    &&(!Object.keys(paint.underlays||{}).length||sample.compositeSignature===compositeSignature);
  const spec={reference:preview,elements:elements.map(e=>({...e,_verticalGradientOnly:['shape','rect','ellipse','line'].includes(e.type)})),masks:paint.masks,underlays:paint.underlays,...(samplesValid?{samplesFile:sample.file}:{})};
  const digest=crypto.createHash('sha256').update(JSON.stringify({...spec,samplesFile:undefined}));
  for(const file of [preview,background,...['tools/paint_consensus.py','tools/paint_models.py','tools/shape_reference.py','lib/paint-consensus.mjs'].map(file=>path.join(env.root,file)),
    ...(paint.masks||[]).map(mask=>mask.file).filter(Boolean),...Object.values(paint.underlays||{})])if(file&&fs.existsSync(file))digest.update(fs.readFileSync(file));
  for(const element of elements)if(element.type==='image'){const file=env.getImage?.(project,element.id);if(file)digest.update(fs.readFileSync(file));}
  const cacheFile=path.join(path.dirname(directory),'cache-'+digest.digest('hex')+'.json');
  fs.writeFileSync(input,JSON.stringify(spec));
  const python=context.python||process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  let result;
  try{result=JSON.parse(fs.readFileSync(cacheFile,'utf8'));}catch{}
  if(!result){
    await (env.run||run)(python,[path.join(env.root,'tools/paint_consensus.py'),input,output],{windowsHide:true,timeout:60000,signal,maxBuffer:1000000});
    result=JSON.parse(fs.readFileSync(output,'utf8'));
    const temp=cacheFile+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(result));
    try{fs.renameSync(temp,cacheFile);}catch{fs.rmSync(temp,{force:true});}
  }
  const measured=new Map(result.elements.map(element=>[element.key,element]));
  const paintFields=['fill','gradient','color','strokeGradient','paintConsensus'];
  return {...result,elements:originals.map(original=>{
    if(context.targetKeys&&!context.targetKeys.includes(original.key))return original;
    const next={...original},candidate=measured.get(original.key);
    if(candidate)for(const field of paintFields){if(candidate[field]!==undefined)next[field]=candidate[field];else delete next[field];}
    return next;
  }),directory};
}
