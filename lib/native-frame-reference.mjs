import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {buildObjectMasks} from './object-masks.mjs';
import {routeRebuildRepresentations} from './rebuild-representation.mjs';
import {isTextCarrier,assertNativeCarriers,nativeCarrierVersion} from './native-carriers.mjs';
import {validateCustomGeometry} from './native-shapes.mjs';
import {shapeGeometry} from './shape-geometry.mjs';
import {applyShapeRefinement} from './reconstruction-refinement.mjs';
import {normalizeNativeParameters} from './native-parameter-groups.mjs';
import {revokeRecognitionParameters} from './recognition-groups.mjs';
import {groupFitContradictions} from './group-fit-evidence.mjs';

export async function restoreNativeFrames({env,project,index,elements,reference,background,exclude=[],signal,targetKeys,paintOnly=false}){
  const targets=targetKeys?new Set(targetKeys):null;
  const inputs=elements.map(e=>{
    if(targets&&!targets.has(e.key))return e;
    if(e.type==='image'&&e.implementation==='svg'&&isTextCarrier(e)){
      const file=env.getImage(project,e.id);if(file)return {...e,type:'svg',svg:fs.readFileSync(file,'utf8')};
    }return e;
  });
  const compatibilityWarnings=[];
  let output=targets?inputs.flatMap(e=>{
    if(!targets.has(e.key))return [e];
    try{return routeRebuildRepresentations([e]);}catch(error){const original=elements.find(n=>n.key===e.key);if(original?.type==='image'&&original.implementation==='svg'){compatibilityWarnings.push({key:e.key,issue:'旧素材需要重新审计，已保留当前可下载对象：'+error.message});return [original];}throw error;}
  }):routeRebuildRepresentations(inputs);assertNativeCarriers(output,elements,{allowUnchanged:!!targets});
  if(!output.some(e=>!e.managed&&e.role!=='background'&&(['rect','ellipse','shape','line'].includes(e.type)||e.effectKind==='lit-stroke')))return {elements:output,changes:[],report:{status:'skipped',reason:'no-native-carriers',compatibilityWarnings}};
  const root=path.join(env.data,project.id,'geometry-records','native-frames');fs.mkdirSync(root,{recursive:true});
  const selected=output;
  const masks=await buildObjectMasks({elements:selected,directory:path.join(root,'masks'),getImage:id=>env.getImage(project,id),signal});
  const headingNodeIds=(project.slides?.[index]?.elements||[]).filter(e=>e.type==='group'||e.role==='heading').map(e=>e.id);
  const spec={reference,background,elements:selected,exclude,objectMasks:masks,targetKeys,headingNodeIds,paintOnly};
  const algorithm=crypto.createHash('sha256');for(const name of ['tools/native_frame_fit.py','tools/light_profiles.py','tools/title_carriers.py','tools/native_line_fit.py','tools/shape_paint.py','tools/paint_models.py','lib/native-parameter-groups.mjs','lib/recognition-groups.mjs','lib/group-fit-evidence.mjs','lib/light-effects.mjs','lib/visual-gradient.mjs'])algorithm.update(fs.readFileSync(path.join(env.root,name)));
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify([nativeCarrierVersion,algorithm.digest('hex'),spec,fs.statSync(reference).mtimeMs,fs.statSync(background).mtimeMs])).digest('hex');
  const directory=path.join(root,index+'-'+fingerprint),file=path.join(directory,'result.json');fs.mkdirSync(directory,{recursive:true});let report;
  if(fs.existsSync(file))try{report=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  if(!report){
    const input=path.join(directory,'input.json');fs.writeFileSync(input,JSON.stringify(spec));
    const python=process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    try{report=JSON.parse((await env.run(python,[path.join(env.root,'tools','native_frame_fit.py'),input],{windowsHide:true,timeout:45000,maxBuffer:3000000,signal})).stdout);}
    catch(error){if(signal?.aborted)throw error;try{report=JSON.parse(String(error.stdout));}catch{report={status:'unavailable',error:String(error.stderr||error.message).slice(-1000),proposals:[]};}}
    fs.writeFileSync(file,JSON.stringify(report));
  }
  const proposals=new Map((report.proposals||[]).map(p=>[p.key,p])),changes=[];
  output=output.map(e=>{
    const proposal=proposals.get(e.key);if(!proposal||!['rect','ellipse','shape'].includes(e.type)||e.managed)return e;
    try{
      const properties=proposal.properties,g=properties.customGeometry?validateCustomGeometry(properties.customGeometry):null;
      const next={...e,...properties,...(g?{customGeometry:g}:{}),geometryEvidence:{method:proposal.method,beforeError:proposal.beforeError,afterError:proposal.afterError,visibleCoverage:proposal.visibleCoverage,samples:proposal.samples,extendsCanvas:proposal.extendsCanvas,fullVertices:proposal.fullVertices},...(isTextCarrier(e)?{nativeRequired:true}:{})};
      if(!g)delete next.customGeometry;if(properties.shapeGeometry)next.shapeGeometry=shapeGeometry(properties.shapeGeometry);else delete next.shapeGeometry;delete next.adjustments;
      changes.push({key:e.key,before:e,after:next});return next;
    }catch{return e;}
  });
  const unresolved=report.unresolved||[];
  const paints=applyShapeRefinement(output,{paintProposals:report.paintProposals||[]});output=paints.elements;
  for(const paint of paints.changes){const prior=changes.find(c=>c.key===paint.key);if(prior){prior.after=paint.after;prior.paint=paint.paint;}else changes.push(paint);}
  for(const proposal of report.lineProposals||[]){const i=output.findIndex(e=>e.key===proposal.key&&e.type==='line'&&!e.managed);if(i<0)continue;const before=output[i],after={...before,...proposal.properties};output[i]=after;changes.push({key:before.key,before,after,reason:'按理想中心线恢复线条与渐变'});}
  output=output.map(e=>{const m=(report.paintProposals||[]).find(p=>p.key===e.key)?.measurements?.fill;return m?{...e,paintEvidence:{confidence:m.confidence??m.r2,afterError:m.afterError}}:e;});
  const revoked=revokeRecognitionParameters(output,groupFitContradictions(selected,output,report));output=revoked.elements;report.groupingRejections=revoked.decisions.filter(d=>d.action==='revoked');
  const lightEvidence=new Map((report.lightEvidence||[]).map(e=>[e.key,e]));
  output=output.map(e=>{const m=lightEvidence.get(e.key);if(!m||m.coreConfirmed||m.confidence<.85||targets&&!targets.has(e.key))return e;return {...e,effectKind:'halo',lighting:{coreConfirmed:false,evidence:m.reason},lightEvidence:m};});
  output=targets?output.flatMap(e=>targets.has(e.key)?routeRebuildRepresentations([e]):[e]):routeRebuildRepresentations(output);
  const grouped=normalizeNativeParameters(output,{targetKeys});output=grouped.elements;report.parameterDecisions=grouped.decisions;
  for(const change of grouped.changes){const prior=changes.find(c=>c.key===change.key);if(prior)prior.after=change.after;else changes.push(change);}
  output=output.map(e=>{const own=unresolved.filter(issue=>issue.key===e.key);return own.length?{...e,unresolved:own.map(i=>'待核对叠层：'+JSON.stringify(i.region))}:e;});
  // Include metadata-only revocations and light corrections in the audit trail.
  for(const after of output){const before=selected.find(e=>e.key===after.key);if(!before||JSON.stringify(before)===JSON.stringify(after))continue;const prior=changes.find(c=>c.key===after.key);if(prior)prior.after=after;else changes.push({key:after.key,before,after,reason:'拟合反证或光晕识别修正'});}
  fs.writeFileSync(file,JSON.stringify(report));
  return {elements:output,changes,report:{...report,...(compatibilityWarnings.length?{compatibilityWarnings}:{}),record:path.relative(path.join(env.data,project.id),file)}};
}
