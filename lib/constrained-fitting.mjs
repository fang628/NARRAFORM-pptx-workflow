import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);
export function prototypeFamily(element){
  if(element.type==='line')return 'line';
  const kind=String(element.shape||element.type).toLowerCase();
  if(kind==='hexagon')return 'hexagon';
  if(['circle','ellipse'].includes(kind))return 'ellipse';
  if(['rect','roundrect','parallelogram','trapezoid'].includes(kind))return 'quad';
  if(kind==='freeform'&&(element.customGeometry?.points?.length===4||element.frameKind==='panel'||element.class==='freeform-panel'))return 'quad';
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
  fs.writeFileSync(input,JSON.stringify({reference:preview,elements,targetKeys:targets.map(element=>element.key)}));
  const python=context.python||process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const executor=env.run||run;
  await executor(python,[path.join(env.root,'tools','constrained_shapes.py'),input,output],{cwd:env.root,windowsHide:true,timeout:60000,signal,maxBuffer:1000000});
  const result=JSON.parse(fs.readFileSync(output,'utf8')),byKey=new Map(result.results.map(row=>[row.key,row]));
  const fitted=elements.map(element=>{
    const row=byKey.get(element.key);if(!row)return element;
    const accepted=row.status==='accepted';
    const label=accepted&&row.locatedDot?elements.filter(other=>other.type==='text'&&other.role==='body'
      &&other.x>=element.x+element.w+2&&other.x<=element.x+element.w+60
      &&Math.abs(other.y+other.h*.5-element.y-element.h*.5)<=32)
      .sort((a,b)=>Math.abs(a.y-element.y)-Math.abs(b.y-element.y))[0]:null;
    const next={...element,...(accepted?row.properties:{}),geometryEvidence:{source:'prototype-S3',family:row.family||prototypeFamily(element),accepted,
      boundaryP95:row.metrics?.p95,visibleCoverage:row.metrics?.coverage,support:row.metrics?.support,
      ...(row.cornerEvidence?{corners:row.cornerEvidence}:{}),
      ...(row.slantEvidence?{slant:row.slantEvidence}:{}),
      ...(label?{attachment:{key:label.key,x:label.x,y:label.y,dx:row.properties.x-element.x,dy:row.properties.y-element.y}}:{})},
      geometryConfidence:accepted?'high':'low',lowConfidenceGeometry:!accepted};
    if(accepted&&row.family!=='line'){
      next.rotate=0;
      if(next.customGeometry){delete next.shapeGeometry;delete next.adjustments;delete next.headDepth;delete next.slantSign;}
      const formulaChildren=elements.filter(child=>child.type==='formula'&&(child.carrierId===element.key||child.parentKey===element.key));
      if(formulaChildren.length)next.geometryEvidence.children=formulaChildren.map(child=>({key:child.key,x:child.x,y:child.y,dx:next.x-element.x,dy:next.y-element.y}));
    }
    for(const key of ['shapeGeometry','customGeometry','adjustments'])if(next[key]===null)delete next[key];
    return next;
  });
  return {elements:fitted,results:result.results,handled:eligible.map(element=>element.key),directory,elapsedMs:result.elapsedMs};
}
