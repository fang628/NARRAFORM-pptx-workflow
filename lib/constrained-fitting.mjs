import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {circleGroups} from './repeated-circles.mjs';
import {measureStructuralReference} from './structural-reference.mjs';

const run=promisify(execFile);
export function prototypeFamily(element){
  if(element.type==='line')return 'line';
  const kind=String(element.shape||element.type).toLowerCase();
  if(kind==='hexagon')return 'hexagon';
  if(['circle','ellipse'].includes(kind))return 'ellipse';
  if(['rect','roundrect','parallelogram','trapezoid'].includes(kind))return 'quad';
  const commands=element.customGeometry?.commands;
  const quadCommands=commands?.filter(c=>c.op!=='Z');
  if(kind==='freeform'&&(element.customGeometry?.points?.length===4||quadCommands?.length===4&&quadCommands.every((c,i)=>c.op===(i?'L':'M')&&c.points?.length===1)||element.frameKind==='panel'||element.class==='freeform-panel'))return 'quad';
  return null;
}

export async function fitConstrainedShapes(context){
  const {env,project,index,preview,elements,signal}=context;
  const eligible=elements.filter(element=>prototypeFamily(element)&&!element.managed
    && !String(element.key||'').startsWith('nf-')
    && (!element.tableId||element.tableRole==='icon')&&!element._stagedSkip&&element.role!=='effect'&&!element.effectOf
    && (!context.targetKeys||context.targetKeys.includes(element.key)));
  const targets=eligible;
  if(!targets.length)return {elements,results:[],handled:eligible.map(element=>element.key)};
  const directory=path.join(env.data,project.id,'geometry-records','prototype','page-'+(index+1),crypto.randomUUID());
  fs.mkdirSync(directory,{recursive:true});
  const input=path.join(directory,'input.json'),output=path.join(directory,'result.json');
  const foundation=project.visualPages?.[index]?.foundation?.file;
  const needsStructure=targets.some(e=>['freeform','parallelogram','trapezoid'].includes(e.shape));
  const structural=needsStructure?await measureStructuralReference({env,project,index,reference:preview,background:context.background||(foundation?path.join(env.data,project.id,foundation):null),exclude:[...(project.visualPages?.[index]?.images||[]),...elements.filter(e=>e.managed)],signal}):{panels:[]};
  fs.writeFileSync(input,JSON.stringify({reference:preview,elements,structural,circleGroups:circleGroups(elements),targetKeys:targets.map(element=>element.key)}));
  const python=context.python||process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const executor=env.run||run;
  await executor(python,[path.join(env.root,'tools','constrained_shapes.py'),input,output],{cwd:env.root,windowsHide:true,timeout:60000,signal,maxBuffer:1000000});
  const result=JSON.parse(fs.readFileSync(output,'utf8')),byKey=new Map(result.results.map(row=>[row.key,row]));
  const fitted=elements.map(element=>{
    const row=byKey.get(element.key);if(!row)return element;
    const accepted=row.status==='accepted';
    const next={...element,...(accepted||row.sharedDiameter?row.properties:{}),...(row.sharedCorners?{shape:row.properties.shape,customGeometry:row.properties.customGeometry,shapeGeometry:row.properties.shapeGeometry}:{}),geometryEvidence:{source:'prototype-S3',family:row.family||prototypeFamily(element),accepted,
      boundaryP95:row.metrics?.p95,visibleCoverage:row.metrics?.coverage,support:row.metrics?.support,
      ...(row.cornerEvidence?{corners:row.cornerEvidence}:{}),
      ...(row.slantEvidence?{slant:row.slantEvidence}:{}),
      ...(row.sharedDiameter?{sharedDiameter:row.sharedDiameter}:{})},
      geometryConfidence:accepted?'high':'low',lowConfidenceGeometry:!accepted};
    if(row.parameterEvidence)next.parameterEvidence={...element.parameterEvidence,...row.parameterEvidence};
    if(row.structuralEvidence)next.geometryEvidence.structure=row.structuralEvidence;
    if(accepted&&row.family!=='line'){
      next.rotate=0;
      if(next.customGeometry){delete next.shapeGeometry;delete next.adjustments;delete next.headDepth;delete next.slantSign;}
      const formulaChildren=elements.filter(child=>child.type==='formula'&&(child.carrierId===element.key||child.parentKey===element.key));
      if(formulaChildren.length)next.geometryEvidence.children=formulaChildren.map(child=>({key:child.key,x:child.x,y:child.y,dx:next.x-element.x,dy:next.y-element.y}));
    }
    for(const key of ['shapeGeometry','customGeometry','adjustments'])if(next[key]===null)delete next[key];
    return next;
  });
  const anchored=fitted.map(element=>{
    if(element.objectIdentity?.component)return element;
    if(element.type!=='text'||element.role!=='visual-number'||context.targetKeys&&!context.targetKeys.includes(element.key))return element;
    const previous=elements.find(e=>e.key===element.key),source=element.sourceBox||previous;
    const badges=elements.filter(e=>e.type==='ellipse'&&e.x<=source.x+source.w/2&&e.x+e.w>=source.x+source.w/2&&e.y<=source.y+source.h/2&&e.y+e.h>=source.y+source.h/2);
    if(badges.length!==1)return element;
    const badge=fitted.find(e=>e.key===badges[0].key);
    if(!badge?.geometryEvidence?.accepted)return element;
    return {...element,x:badge.x,y:badge.y,w:badge.w,h:badge.h,align:'center',valign:'mid'};
  });
  return {elements:anchored,results:result.results,handled:result.results.filter(row=>row.status==='accepted'||row.sharedDiameter||row.family==='capsule'
    ||row.family==='ellipse'&&(()=>{const e=elements.find(e=>e.key===row.key);return e&&Math.max(e.w,e.h)/Math.min(e.w,e.h)<=1.18;})()).map(row=>row.key),directory,elapsedMs:result.elapsedMs};
}
