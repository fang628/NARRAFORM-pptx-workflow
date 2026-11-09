import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {validateCustomGeometry} from './native-shapes.mjs';
import {visualGradient} from './visual-gradient.mjs';
import {baseShapePoints,shapeGeometry} from './shape-geometry.mjs';
import {reconstructionCorrespondence,matchReferenceObjects} from './object-correspondence.mjs';
import {buildObjectMasks} from './object-masks.mjs';
import {revokeRecognitionParameters} from './recognition-groups.mjs';
import {changedSharedParameters} from './group-fit-evidence.mjs';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex').slice(0,24);
export async function measureReferenceShapes({env,project,index,reference,background,elements=[],exclude=[],targetKeys,signal}){
  elements=elements.map(e=>{const hints=project.reconstruction?.slides?.[index]?.scene?.objects?.find(o=>o.instanceId===e.key)?.shapeCandidates;return hints?.length?{...e,shapeCandidates:hints}:e;});
  const objectMasks=await buildObjectMasks({elements,directory:path.join(env.data,project.id,'geometry-records','object-masks'),getImage:id=>env.getImage?.(project,id),signal});
  const algorithm=hash(fs.readFileSync(path.join(env.root,'tools','shape_reference.py'),'utf8')+['native_frame_fit.py','native_line_fit.py','shape_paint.py','paint_models.py'].map(n=>fs.readFileSync(path.join(env.root,'tools',n),'utf8')).join(''));
  const spec={reference,background,elements,exclude,objectMasks,targetKeys,coarse:!elements.length},stamp=hash(JSON.stringify([11,algorithm,spec,fs.statSync(reference).mtimeMs,fs.statSync(background).mtimeMs]));
  const directory=path.join(env.data,project.id,'geometry-records','shape-reference',String(index)+'-'+stamp),record=path.relative(path.join(env.data,project.id),directory);
  fs.mkdirSync(directory,{recursive:true});const input=path.join(directory,'input.json'),output=path.join(directory,'result.json');
  if(fs.existsSync(output))try{return {...JSON.parse(fs.readFileSync(output,'utf8')),record};}catch{}
  fs.writeFileSync(input,JSON.stringify(spec));
  try{
    const python=process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    const result=JSON.parse((await env.run(python,[path.join(env.root,'tools','shape_reference.py'),input,directory],{windowsHide:true,timeout:45000,maxBuffer:3000000,signal})).stdout);
    fs.writeFileSync(output,JSON.stringify(result));return {...result,record};
  }catch(error){if(signal?.aborted)throw error;return {status:'unavailable',record,error:String(error.stderr||error.message).slice(-1000),candidates:[],proposals:[]};}
}
// Already registered simple SVG carriers can be fitted too. Rich vectors,
// multi-part icons, transforms, holes and lighting stay on their SVG path.
export function shapeRefinementInputs(elements,loadSVG){
  return elements.map(e=>{
    if(e.type!=='image'||e.implementation!=='svg'||!e.frameKind&&!/色块|color.block/i.test(e.description||''))return e;
    let svg;try{svg=loadSVG(e);}catch{return e;}
    if(typeof svg!=='string'||/<(?:g|defs|filter|pattern|image|linearGradient|radialGradient|style|use|text)\b|\b(?:style|transform|fill-rule|clip-path|mask)\s*=/i.test(svg))return e;
    const geometries=[...svg.matchAll(/<(path|polygon|rect|ellipse)\b([^>]*)>/g)];if(geometries.length!==1)return e;
    const attrs=Object.fromEntries([...geometries[0][2].matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1],m[2]]));
    if(attrs.d&&(attrs.d.match(/[mM]/g)||[]).length!==1)return e;
    const color=v=>/^#?[\da-f]{6}$/i.test(v||'')?v.replace('#',''):null;
    const fill=color(attrs.fill);if(!fill)return e;
    const stroke=attrs.stroke&&attrs.stroke!=='none'?color(attrs.stroke):null;if(attrs.stroke&&attrs.stroke!=='none'&&!stroke)return e;
    const view=svg.match(/viewBox\s*=\s*["']([^"']+)["']/)?.[1].trim().split(/[\s,]+/).map(Number);
    if(!view||view.length!==4||!view.every(Number.isFinite)||view[2]<=0||view[3]<=0||Math.abs(e.w/view[2]-e.h/view[3])>.02)return e;
    const strokeWidth=stroke?Number(attrs['stroke-width']||1)*e.w/view[2]:0,opacity=Number(attrs.opacity??e.opacity??1);
    if(!Number.isFinite(strokeWidth)||strokeWidth<0||!Number.isFinite(opacity)||opacity<0||opacity>1)return e;
    if(attrs['fill-opacity']||attrs['stroke-opacity']||/\bopacity\s*=/i.test(svg.slice(0,svg.indexOf('>'))))return e;
    return {...e,type:'svg',svg,fill,color:stroke||fill,strokeWidth,opacity};
  });
}
// A measured primitive is used only when its generated outline agrees with the
// observed prototype. Rotated/asymmetric variants retain the measured contour.
export function primitiveShape(profile,box){
  if(!profile||profile.score<.96||profile.confidence<.7)return null;
  const kind=profile.kind,q=profile.parameters||{},g={};
  for(const key of ['headDepth','notchDepth','cornerRadius','cutCorner','innerRadius','rotation'])if(Number.isFinite(q[key]))g[key]=q[key];
  if(['parallelogram','trapezoid'].includes(kind)&&q.slantAngle>=5&&q.slantAngle<=85)g.slantAngle=q.slantAngle;
  if(kind==='parallelogram'&&Math.abs(q.slantSign)===1)g.slantSign=q.slantSign;
  if(Number.isFinite(q.shaftThickness))g.shaftRatio=q.shaftThickness;
  let result;
  if(['circle','ellipse'].includes(kind))return Math.abs(q.rotation||0)%90<2?{type:'ellipse'}:null;
  if(['rectangle','roundedRectangle'].includes(kind)){result={type:'rect',shape:'rect'};if(kind==='roundedRectangle'&&!g.cornerRadius)return null;}
  else if(['hexagon','pentagon','star5','triangle','parallelogram','trapezoid'].includes(kind))result={type:'shape',shape:kind,contourKind:['hexagon','parallelogram'].includes(kind)?kind:'other'};
  else if(['notchedArrow','flatArrow','shaftArrow'].includes(kind))result={type:'shape',shape:'rightArrow',contourKind:'arrow',arrowTail:{notchedArrow:'notched',flatArrow:'flat',shaftArrow:'shaft'}[kind],arrowDirection:q.direction||'right'};
  else return null;
  if(!['star5'].includes(kind))delete g.rotation;
  try{result.shapeGeometry=shapeGeometry(g);}catch{return null;}
  const expected=baseShapePoints({...box,...result}),measured=profile.points;
  if(!expected||!Array.isArray(measured)||measured.length<3)return null;
  const distance=(p,a,b)=>{const dx=(b[0]-a[0])*box.w,dy=(b[1]-a[1])*box.h,px=(p[0]-a[0])*box.w,py=(p[1]-a[1])*box.h,t=Math.max(0,Math.min(1,(px*dx+py*dy)/(dx*dx+dy*dy||1)));return Math.hypot(px-t*dx,py-t*dy)/Math.min(box.w,box.h);};
  const error=(a,b)=>Math.max(...a.map(p=>Math.min(...b.map((v,i)=>distance(p,v,b[(i+1)%b.length])))));
  if(Math.max(error(expected,measured),error(measured,expected))>.045)return null;
  return result;
}
export function applyShapeRefinement(elements,report){
  const changes=[],byKey=new Map((report?.proposals||[]).map(p=>[p.key,p]));
  const matches=Array.isArray(report?.candidates)?new Map(matchReferenceObjects(elements,report.candidates).matches.map(m=>[m.key,m.reference])):null;
  const output=elements.map(e=>{
    const p=byKey.get(e.key);if(!p||e.managed||!['rect','ellipse','shape','svg'].includes(e.type)||e.role==='background'||e.arrowRole==='connector'||e.lineEffect)return e;
    // An image-space contour contains only the visible portion of an overflowing
    // object. It cannot replace the full native geometry with a clipped outline.
    if(e.x<0||e.y<0||e.x+e.w>1600||e.y+e.h>900)return e;
    if(!(p.confidence>=.8&&Number.isFinite(p.beforeScore)&&Number.isFinite(p.afterScore)&&p.afterScore>p.beforeScore+.015))return e;
    // Complex material/lighting effects stay SVG. Only a measured flat carrier
    // can become an editable native outline; never discard an SVG's effects.
    if(e.type==='svg'&&(/<(?:filter|pattern|image|linearGradient|radialGradient)\b/i.test(e.svg||'')||p.confidence<.9))return e;
    const properties=p.properties;
    const assigned=matches?.get(e.key);
    if(matches&&(!assigned||['x','y','w','h'].some(k=>Math.abs(assigned[k]-properties?.[k])>2)))return e;
    if(!properties||!['x','y','w','h'].every(k=>Number.isFinite(properties[k]))||properties.x<0||properties.y<0||properties.w<4||properties.h<4||properties.x+properties.w>1601||properties.y+properties.h>901)return e;
    let customGeometry;try{customGeometry=validateCustomGeometry(properties.customGeometry);}catch{return e;}
    const {svg,id,implementation,arrowTail,arrowDirection,rotate,flipH,flipV,curveArrow,adjustments,shapeGeometry:oldGeometry,...rest}=e;
    const box={x:properties.x,y:properties.y,w:properties.w,h:properties.h},primitive=primitiveShape(p.primitive,box);
    const next={...rest,type:'shape',shape:'freeform',contourKind:'other',...box,customGeometry,...(p.primitive?{baseGeometry:{kind:p.primitive.kind,confidence:p.primitive.confidence}}:{})};
    if(primitive){delete next.customGeometry;Object.assign(next,primitive);}
    if(e.type==='svg'){const fill=e.fill||properties.fill;if(!/^[\da-f]{6}$/i.test(fill||''))return e;Object.assign(next,{fill,color:e.color||fill,strokeWidth:e.strokeWidth||0,...(id?{sourceAssetId:id}:{})});}
    changes.push({key:e.key,before:structuredClone(e),after:structuredClone(next),beforeScore:p.beforeScore,afterScore:p.afterScore,reason:p.reason||'按参考轮廓拟合'});return next;
  });
  const paints=new Map((report?.paintProposals||[]).map(p=>[p.key,p]));
  const painted=output.map(e=>{
    const p=paints.get(e.key);if(!p||e.managed||!['shape','rect','ellipse'].includes(e.type))return e;
    const properties={};for(const [field,kind]of [['gradient','fill'],['strokeGradient','stroke']]){
      const m=p.measurements?.[kind];if(!m||!((m.r2>=.8||m.accepted===true&&(m.confidence>=.78&&m.robustError<=7||kind==='fill'&&m.scope==='base-fill'&&m.confidence>=.7&&m.robustError<=5.5||kind==='fill'&&m.scope==='group-base-fill'&&m.referenceSource&&m.confidence>=.65&&m.robustError<6))&&Number.isFinite(m.beforeError)&&Number.isFinite(m.afterError)&&m.beforeError-m.afterError>=2))continue;
      try{properties[field]=visualGradient(p.properties?.[field],{key:e.key});}catch{}
    }
    const outline=p.measurements?.outline;
    if(outline?.presence==='absent'&&outline.confidence>=.95&&outline.samples>=24&&!e.glow&&!e.shadow&&e.role!=='effect'){
      properties.strokeWidth=0;properties.strokeGradient=undefined;properties.colorOpacity=0;
    }
    if(outline?.confidence>=.9&&outline.samples>=12&&Number.isFinite(outline.width)&&outline.width>=1&&outline.width<=8){
      if(Math.abs(outline.width-(e.strokeWidth||0))>=.8)properties.strokeWidth=outline.width;
      if(!e.strokeGradient&&/^[\da-f]{6}$/i.test(outline.color)){
        const a=String(e.color||'000000').replace('#',''),b=outline.color,difference=Math.hypot(...[0,2,4].map(i=>parseInt(a.slice(i,i+2),16)-parseInt(b.slice(i,i+2),16)));
        if(difference>=8)properties.color=outline.color;
      }
    }
    const solid=p.measurements?.solidFill;
    if(solid?.confidence>=.9&&solid.samples>=80&&solid.beforeError-solid.afterError>=4&&solid.afterError<=3.5&&/^[\da-f]{6}$/i.test(solid.color)){properties.fill=solid.color;properties.gradient=undefined;}
    if(!Object.keys(properties).length)return e;const next={...e,...properties},existing=changes.find(c=>c.key===e.key);
    if(existing){existing.after=structuredClone(next);existing.paint=p.measurements;}else changes.push({key:e.key,before:structuredClone(elements.find(n=>n.key===e.key)),after:structuredClone(next),reason:'按参考图独立拟合原生填充/描边渐变',paint:p.measurements});return next;
  });return {elements:painted,changes};
}
export {reconstructionCorrespondence};

// Compare the same padded union before and after a move/resize; a smaller crop
// must not hide an error and incorrectly appear to improve reconstruction.
export function referenceTrialRegions(elements,next){
  return elements.map((e,i)=>{
    const n=next[i];if(!n||e.key!==n.key||JSON.stringify(e)===JSON.stringify(n))return e;
    const x=Math.max(0,Math.min(e.x,n.x)-8),y=Math.max(0,Math.min(e.y,n.y)-8);
    return {...e,x,y,w:Math.min(1600,Math.max(e.x+e.w,n.x+n.w)+8)-x,h:Math.min(900,Math.max(e.y+e.h,n.y+n.h)+8)-y};
  });
}

// One tentative local candidate per page. Keep the original scene until an
// actual PowerPoint render demonstrates improvement; worsening trials rollback.
export function settleReferenceTrial(elements,report,state){
  if(!state.pending)return {elements,changed:false,status:'idle'};
  const pending=state.pending;state.pending=null;
  const scores=new Map((report?.regions||[]).map(r=>[r.key,r]));
  let better=0,worse=0,observed=0;const revert=new Set(),contradictions=[];
  const originals=new Map(pending.before.map(e=>[e.key,e])),currentElements=new Map(elements.map(e=>[e.key,e]));
  for(const key of pending.keys){const a=pending.baseline.get(key),b=scores.get(key);if(!a||!b||!a.samples||!b.samples||![a.ssim,b.ssim,a.edgeDistance??0,b.edgeDistance??0].every(Number.isFinite)){revert.add(key);continue;}observed++;
    const score=r=>r.ssim-Math.min(20,r.edgeDistance||0)*.01;
    const diff=score(b)-score(a);if(diff>.003)better++;else revert.add(key);if(diff<-.006)worse++;
    const previous=(pending.objectQuality?.objects||[]).find(e=>e.key===key),current=(report.objectQuality?.objects||[]).find(e=>e.key===key);
    const paintGain=pending.paintKeys?.includes(key)&&previous?.status==='available'&&current?.status==='available'&&Number.isFinite(previous.appearanceMAE)&&Number.isFinite(current.appearanceMAE)&&previous.appearanceMAE-current.appearanceMAE>2&&Number.isFinite(previous.boundaryP95)&&Number.isFinite(current.boundaryP95)&&current.boundaryP95<=Math.max(2,previous.boundaryP95+.75);
    if(paintGain&&diff>=-.015){revert.delete(key);if(diff<=.003)better++;}
    if(previous?.status==='available'&&current?.status==='available'&&((Number.isFinite(previous.boundaryP95)&&current.boundaryP95>Math.max(5,previous.boundaryP95+1.5))||(Number.isFinite(previous.appearanceMAE)&&current.appearanceMAE>previous.appearanceMAE+3)))revert.add(key);
    const measuredWorse=previous?.status==='available'&&current?.status==='available'&&(Number.isFinite(previous.appearanceMAE)&&Number.isFinite(current.appearanceMAE)&&current.appearanceMAE>previous.appearanceMAE+3||Number.isFinite(previous.boundaryP95)&&Number.isFinite(current.boundaryP95)&&current.boundaryP95>previous.boundaryP95+2);
    if(revert.has(key)&&(diff<-.015||measuredWorse))for(const parameter of changedSharedParameters(originals.get(key),currentElements.get(key)))contradictions.push({key,parameter,contradicts:true,confidence:.95,reason:`实际PowerPoint渲染反对该共享参数调整：参考对照分差${diff.toFixed(4)}${measuredWorse?'，局部颜色或边界误差明显增大':''}`});
  }
  const familyReverted=(pending.fontFamilyKeys||[]).some(key=>revert.has(key));
  if(familyReverted)for(const key of pending.fontFamilyKeys)revert.add(key);
  for(const group of pending.geometryGroups||[])if(group.some(key=>revert.has(key)))for(const key of group)revert.add(key);
  if(revert.size){
    state.blocked=true;
    // Rolling back a visual trial must not roll back independently measured
    // contrary evidence. Keep it even if this particular candidate was poor.
    const fittedEvidence=elements.flatMap(e=>(e.recognitionRejections||[]).map(r=>({...r,key:e.key,contradicts:true})));
    const rolledBack=elements.map(e=>revert.has(e.key)?originals.get(e.key):e),revoked=revokeRecognitionParameters(rolledBack,[...fittedEvidence,...contradictions]);
    return {elements:revoked.elements,groupingRejections:revoked.decisions,changed:true,status:better?'partially-accepted':'reverted',better,worse,observed,familyReverted};
  }
  return {elements,changed:false,status:'accepted',better,worse,observed};
}
export function beginReferenceTrial(elements,next,report,state){
  if(state.blocked||state.pending)return false;
  const keys=next.filter((e,i)=>JSON.stringify(e)!==JSON.stringify(elements[i])).map(e=>e.key);if(!keys.length||elements.length!==next.length)return false;
  const groups=new Map();for(const e of next){const group=e.carrierGroup||e.effectOf;if(group){if(!groups.has(group))groups.set(group,[]);groups.get(group).push(e.key);}}
  const paintKeys=next.filter((e,i)=>['fill','color','gradient','strokeGradient','fillOpacity','colorOpacity'].some(k=>JSON.stringify(e[k])!==JSON.stringify(elements[i]?.[k]))).map(e=>e.key);
  state.pending={before:structuredClone(elements),keys,paintKeys,geometryGroups:[...groups.values()].map(group=>group.filter(key=>keys.includes(key))).filter(group=>group.length>1),fontFamilyKeys:next.filter((e,i)=>e.type==='text'&&e.fontFace!==elements[i]?.fontFace).map(e=>e.key),regions:referenceTrialRegions(elements,next),baseline:new Map((report?.regions||[]).map(r=>[r.key,r])),objectQuality:report.objectQuality};return true;
}
