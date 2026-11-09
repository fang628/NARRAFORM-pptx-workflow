import {nativeGroupParameters} from './native-parameter-groups.mjs';

// Recognition-stage groups are hypotheses for the model to declare, not verified
// truth. Local fitting may later contradict single parameters of a group.
export const recognitionGroupRule='识别同类框时返回 recognitionGroups:[{id,keys,parameters,referenceKey,evidence,confidence}]；只共享有依据的参数，不同位置/尺寸/强调/独立层保留；本组仅为假设，后续拟合可反证并仅撤销有差异参数；已有recognitionRejections不得重新加组。';

const knownParameters=new Set(nativeGroupParameters);
const dimensionParameters=new Set(['width','height']);
const nativeTypes=new Set(['rect','shape','ellipse']);

const clone=value=>{try{return structuredClone(value)}catch{return JSON.parse(JSON.stringify(value))}};
const charCount=value=>[...String(value??'').trim()].length;
const rgb=value=>{const text=String(value??'').replace('#','');return /^[\da-f]{6}$/i.test(text)?[0,2,4].map(i=>parseInt(text.slice(i,i+2),16)):null;};
const family=element=>element?.customGeometry?'custom':element?.shape==='rect'||element?.type==='rect'?'rect':element?.shape||element?.type;
const phaseOf=element=>element?.progressState||element?.visualState||element?.state||element?.emphasis||'normal';
const frameKindOf=element=>String(element?.frameKind??element?.role??'');
const isEffect=element=>element?.role==='effect'||element?.effectOf!=null||element?.visualKind==='light-effect';
const isCarrier=element=>!element?.managed&&(element?.role==='carrier'||element?.role==='frame'||!!element?.frameKind||element?.nativeRequired===true);
const isEligibleCarrier=element=>Boolean(element)&&nativeTypes.has(element.type)&&isCarrier(element)&&!isEffect(element)&&Number.isFinite(element.x)&&Number.isFinite(element.y)&&Number.isFinite(element.w)&&Number.isFinite(element.h)&&element.w>0&&element.h>0&&Math.min(element.w,element.h)>=24&&element.w*element.h>=1600;
const blockedByKeep=(keep,parameter)=>{if(!Array.isArray(keep))return false;if(keep.includes(parameter))return true;if(parameter.startsWith('stroke')&&keep.includes('stroke'))return true;if(parameter.startsWith('gradient')&&keep.includes('fill'))return true;if(parameter==='stroke'&&keep.some(name=>String(name).startsWith('stroke')))return true;if(parameter==='fill'&&keep.some(name=>String(name).startsWith('gradient')))return true;return false;};
const rejectedParameter=(element,parameter)=>Array.isArray(element?.recognitionRejections)&&element.recognitionRejections.some(rejection=>rejection&&rejection.parameter===parameter);
const colourSignature=element=>{
 const stops=element?.gradient?.stops;
 if(Array.isArray(stops)&&stops.length){const sampled=[0,.25,.5,.75,1].map(t=>{let i=stops.findIndex(stop=>stop.position>=t);if(i<0)i=stops.length-1;const lo=stops[Math.max(0,i-1)],hi=stops[i],f=Math.max(0,Math.min(1,(t-lo.position)/((hi.position-lo.position)||1))),a=rgb(lo?.color),b=rgb(hi?.color);return a&&b?a.map((v,j)=>v+(b[j]-v)*f):null;}).filter(Boolean);return sampled.length?sampled:null;}
 const solid=rgb(element?.fill)||rgb(element?.color);return solid?Array.from({length:5},()=>solid):null;
};
const colourDistance=(a,b)=>{const x=colourSignature(a),y=colourSignature(b);if(!x||!y)return Infinity;let total=0;for(let i=0;i<5;i++)total+=Math.hypot(x[i][0]-y[i][0],x[i][1]-y[i][1],x[i][2]-y[i][2]);return total/5;};
const sizeRatio=(a,b)=>Math.max(a.w/b.w,b.w/a.w,a.h/b.h,b.h/a.h);
const sameAxis=(a,b)=>{const row=Math.abs((a.y+a.h/2)-(b.y+b.h/2))<=Math.max(10,.3*Math.min(a.h,b.h));const column=Math.abs((a.x+a.w/2)-(b.x+b.w/2))<=Math.max(10,.3*Math.min(a.w,b.w));return row||column;};
const compatibleCarrier=(a,b)=>{
 if(family(a)!==family(b)||frameKindOf(a)!==frameKindOf(b)||phaseOf(a)!==phaseOf(b))return false;
 if(Boolean(a.gradient)!==Boolean(b.gradient))return false;
 if(sizeRatio(a,b)>1.35)return false;
 if(!sameAxis(a,b))return false;
 return colourDistance(a,b)<=40;
};
const slug=value=>String(value||'group').replace(/[^\w-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,24)||'group';
const hash=value=>{let h=2166136261;for(const character of String(value)){h^=character.codePointAt(0);h=Math.imul(h,16777619)>>>0;}return h.toString(36);};
const shareableParameters=members=>{
 const list=[];
 if(members.every(member=>member.gradient||member.fill||member.color))list.push('fill');
 if(members.every(member=>Number(member.strokeWidth)>0)){list.push('stroke');list.push('strokeWidth');}
 if(members.every(member=>Number(member.strokeWidth)>0&&!member.strokeGradient&&rgb(member.color)))list.push('strokeColor');
 if(members.every(member=>member.gradient?.type==='linear'))list.push('gradientAngle');
 if(members.every(member=>Array.isArray(member.gradient?.stops)&&member.gradient.stops.length>=2&&member.gradient.stops.every(stop=>stop.opacity===undefined||stop.opacity>=.98)))list.push('gradientStops');
 if(members.every(member=>member.shape==='parallelogram'&&(member.shapeGeometry?.headDepth!=null||member.shapeGeometry?.slantAngle!=null)))list.push('slant');
 if(members.every(member=>member.shapeGeometry&&['rect','roundRect','parallelogram','trapezoid'].includes(member.shape)))list.push('corners');
 return list.filter(parameter=>knownParameters.has(parameter));
};
const fallbackEvidence=(members,parameters,colour,ratio)=>{
 const kind=frameKindOf(members[0])||family(members[0]),axis=Math.abs((members[0].y+members[0].h/2)-(members[1].y+members[1].h/2))<=Math.max(10,.3*Math.min(members[0].h,members[1].h))?'同排':'同列';
 return `识别阶段保守假设：同frameKind「${kind}」下${members.length}个${family(members[0])}承载框，尺寸比≤${ratio.toFixed(2)}、${axis}、颜色样本平均RGB距离${colour.toFixed(1)}，共享${parameters.join('/')}参数；尚未拟合验证。`;
};
const fallbackConfidence=(members,colour,ratio)=>{
 let confidence=.62+.03*Math.min(6,members.length)+.08*Math.max(0,1-colour/120)+.05*Math.max(0,1-(ratio-1)/.35);
 return Math.round(Math.min(.82,confidence)*100)/100;
};

const parameterOrder=new Map(nativeGroupParameters.map((parameter,index)=>[parameter,index]));
const parameterRank=parameter=>parameterOrder.has(parameter)?parameterOrder.get(parameter):nativeGroupParameters.length;
const sortParameters=parameters=>[...parameters].sort((a,b)=>parameterRank(a)-parameterRank(b)||String(a).localeCompare(String(b)));
const isFallbackEligible=(element,reusableFallbackIds)=>{
 const mappings=Object.values(element?.parameterGroups||{});
 return mappings.length===0||mappings.every(id=>reusableFallbackIds.has(id)||String(id).startsWith('rg-'));
};

function refreshRecognitionEvidence(element,group,ownedParameters){
 const existing=element.recognitionEvidence&&typeof element.recognitionEvidence==='object'?element.recognitionEvidence:null;
 const previousTop=existing&&typeof existing.id==='string'?existing:null;
 const byParameter=existing?.byParameter&&typeof existing.byParameter==='object'?{...existing.byParameter}:{};
 for(const parameter of ownedParameters)byParameter[parameter]={id:group.id,confidence:group.confidence,referenceKey:group.referenceKey,evidence:group.evidence,provisional:true,stage:'recognition'};
 for(const parameter of Object.keys(byParameter)){
  const entry=byParameter[parameter];
  if(!entry||typeof entry!=='object'||element.parameterGroups?.[parameter]!==entry.id){delete byParameter[parameter];continue;}
  if(entry.provisional!==true||entry.stage!=='recognition')byParameter[parameter]={...entry,provisional:true,stage:'recognition'};
 }
 for(const [parameter,id] of Object.entries(element.parameterGroups||{})){
  if(byParameter[parameter])continue;
  if(previousTop&&previousTop.id===id&&Array.isArray(previousTop.parameters)&&previousTop.parameters.includes(parameter))byParameter[parameter]={id,confidence:previousTop.confidence,referenceKey:previousTop.referenceKey||'',evidence:previousTop.evidence||'',provisional:true,stage:'recognition'};
 }
 const parameters=sortParameters(Object.keys(byParameter));
 if(!parameters.length){
  if(element.recognitionEvidence!==undefined){delete element.recognitionEvidence;return true;}
  return false;
 }
 const first=byParameter[parameters[0]];
 const evidence={id:first.id,confidence:first.confidence,referenceKey:first.referenceKey,parameters,evidence:first.evidence,provisional:true,stage:'recognition',byParameter:Object.fromEntries(parameters.map(parameter=>[parameter,byParameter[parameter]]))};
 if(JSON.stringify(existing)!==JSON.stringify(evidence)){element.recognitionEvidence=evidence;return true;}
 return false;
}

function applySharedGroup(elements,byKey,group){
 const parameterKeys={};let mutated=false;const applied=new Set(),owned=new Set();
 for(const parameter of group.parameters){
  const keysFor=[];
  for(const key of group.keys){
   const element=byKey.get(key);if(!element)continue;
   if(blockedByKeep(element.keepParameters,parameter)||rejectedParameter(element,parameter))continue;
   const current=element.parameterGroups?.[parameter];
   if(current!==undefined){if(current===group.id){keysFor.push(key);owned.add(parameter);}continue;}
   element.parameterGroups={...(element.parameterGroups||{}),[parameter]:group.id};
   keysFor.push(key);applied.add(parameter);owned.add(parameter);mutated=true;
  }
  parameterKeys[parameter]=keysFor;
 }
 for(const key of group.keys){
  const element=byKey.get(key);if(!element)continue;
  const ownedParameters=Object.entries(element.parameterGroups||{}).filter(([,id])=>id===group.id).map(([parameter])=>parameter);
  if(ownedParameters.length&&refreshRecognitionEvidence(element,group,ownedParameters))mutated=true;
 }
 return {parameterKeys,mutated,appliedParameters:[...owned]};
}

function normalizeDeclarations(rawGroups,byKey,changes){
 const declarations=[],seenIds=new Set();
 if(rawGroups===undefined)return declarations;
 if(!Array.isArray(rawGroups)){changes.push({action:'ignored',reason:'recognitionGroups-not-array'});return declarations;}
 for(const item of rawGroups){
  const id=item?.id;
  if(typeof id!=='string'||!id.trim()){changes.push({action:'ignored',reason:'invalid-group-id'});continue;}
  const groupId=id.trim();
  if(seenIds.has(groupId)){changes.push({action:'ignored',id:groupId,reason:'duplicate-group-id'});continue;}
  if(!Array.isArray(item.keys)||item.keys.length<2){changes.push({action:'ignored',id:groupId,reason:'insufficient-members'});continue;}
  const uniqueKeys=[...new Set(item.keys.map(key=>String(key)))];
  if(uniqueKeys.length!==item.keys.length){changes.push({action:'ignored',id:groupId,reason:'duplicate-member-keys'});continue;}
  if(uniqueKeys.some(key=>!byKey.has(key))){changes.push({action:'ignored',id:groupId,reason:'unknown-member-keys'});continue;}
  if(!Array.isArray(item.parameters)){changes.push({action:'ignored',id:groupId,reason:'invalid-parameters'});continue;}
  const requested=[...new Set(item.parameters.filter(parameter=>typeof parameter==='string'))];
  const invalid=requested.filter(parameter=>!knownParameters.has(parameter));
  if(invalid.length){changes.push({action:'ignored',id:groupId,reason:'invalid-parameters:'+invalid.join(',')});continue;}
  const trimmed=requested.filter(parameter=>dimensionParameters.has(parameter));
  const shareable=requested.filter(parameter=>!dimensionParameters.has(parameter));
  if(!shareable.length){changes.push({action:'ignored',id:groupId,reason:'no-shareable-parameters'});continue;}
  const confidence=item.confidence===undefined?0.8:Number(item.confidence);
  if(!Number.isFinite(confidence)||confidence<0||confidence>1){changes.push({action:'ignored',id:groupId,reason:'invalid-confidence'});continue;}
  const evidence=typeof item.evidence==='string'?item.evidence.trim():'';
  if(charCount(evidence)<8){changes.push({action:'ignored',id:groupId,reason:'evidence-too-weak'});continue;}
  const members=uniqueKeys.map(key=>byKey.get(key));
  const families=[...new Set(members.map(family))];
  if(families.length>1){changes.push({action:'ignored',id:groupId,reason:'family-mismatch:'+families.join('/')});continue;}
  const states=[...new Set(members.map(phaseOf))];
  if(states.length>1){changes.push({action:'ignored',id:groupId,reason:'state-mismatch:'+states.join('/')});continue;}
  const referenceKey=item.referenceKey===undefined?uniqueKeys[0]:item.referenceKey;
  if(typeof referenceKey!=='string'||!uniqueKeys.includes(referenceKey)){changes.push({action:'ignored',id:groupId,reason:'reference-not-member'});continue;}
  if(trimmed.length)changes.push({action:'trimmed',id:groupId,parameters:trimmed,reason:'width-height-not-shared-at-recognition'});
  seenIds.add(groupId);
  declarations.push({id:groupId,keys:uniqueKeys,parameters:shareable,referenceKey,evidence,confidence});
 }
 return declarations;
}

function fallbackGroupId(cluster,previousGroups,usedIds){
 const keys=cluster.map(element=>element.key);
 const reusable=(Array.isArray(previousGroups)?previousGroups:[]).filter(group=>Array.isArray(group?.keys)&&group.keys.length>=2&&group.source==='fallback'&&group.keys.every(key=>keys.includes(key))).sort((a,b)=>b.keys.length-a.keys.length)[0];
 if(reusable&&typeof reusable.id==='string'&&reusable.id.trim()&&!usedIds.has(reusable.id))return reusable.id;
 const base='rg-'+slug(frameKindOf(cluster[0])||family(cluster[0]))+'-'+hash(keys.slice().sort().join('|'));
 const previousIds=new Set((Array.isArray(previousGroups)?previousGroups:[]).map(group=>group?.id).filter(id=>typeof id==='string'));
 let id=base,index=2;while(usedIds.has(id)||previousIds.has(id))id=base+'-'+index++;
 return id;
}

function fallbackGroups(elements,byKey,previousGroups,usedIds,changes){
 const reusableFallbackIds=new Set((Array.isArray(previousGroups)?previousGroups:[]).filter(group=>group?.source==='fallback'&&typeof group.id==='string').map(group=>group.id));
 const buckets=new Map();
 for(const element of elements.filter(element=>isEligibleCarrier(element)&&isFallbackEligible(element,reusableFallbackIds))){
  const bucket=`${family(element)}\u0000${frameKindOf(element)}\u0000${phaseOf(element)}`;
  if(!buckets.has(bucket))buckets.set(bucket,[]);
  buckets.get(bucket).push(element);
 }
 const groups=[];
 for(const bucket of [...buckets.keys()].sort()){
  const members=[...buckets.get(bucket)].sort((a,b)=>(a.y-b.y)||(a.x-b.x)||String(a.key).localeCompare(String(b.key)));
  if(members.length<2)continue;
  const used=new Set();
  for(const anchor of members){
   if(used.has(anchor.key))continue;
   used.add(anchor.key);
   const cluster=[anchor];
   for(const candidate of members){
    if(used.has(candidate.key)||candidate===anchor)continue;
    if(cluster.every(member=>compatibleCarrier(member,candidate))){cluster.push(candidate);used.add(candidate.key);}
   }
   if(cluster.length<2)continue;
   const id=fallbackGroupId(cluster,previousGroups,usedIds);usedIds.add(id);
   const parameters=shareableParameters(cluster).filter(parameter=>cluster.some(member=>!blockedByKeep(member.keepParameters,parameter)&&!rejectedParameter(member,parameter)&&(member.parameterGroups?.[parameter]===undefined||member.parameterGroups?.[parameter]===id)));
   if(!parameters.length)continue;
   let colour=0;for(let i=0;i<cluster.length;i++)for(let j=i+1;j<cluster.length;j++)colour+=colourDistance(cluster[i],cluster[j]);
   colour/=Math.max(1,cluster.length*(cluster.length-1)/2);
   const ratio=Math.max(...cluster.map((member,index)=>index?sizeRatio(cluster[0],member):1));
   const confidence=fallbackConfidence(cluster,colour,ratio);
   const group={id,keys:cluster.map(element=>element.key),parameters,referenceKey:cluster[0].key,evidence:fallbackEvidence(cluster,parameters,colour,ratio),confidence,source:'fallback'};
   const applied=applySharedGroup(elements,byKey,group);
   if(!applied.appliedParameters.length){changes.push({action:'ignored',kind:'fallback',id:group.id,reason:'no-element-can-share-parameters'});continue;}
   group.parameterKeys=applied.parameterKeys;
   if(applied.mutated)changes.push({action:'grouped',kind:'fallback',id:group.id,keys:group.keys,parameters:group.parameters,parameterKeys:applied.parameterKeys});
   groups.push(group);
  }
 }
 return groups;
}

export function prepareRecognitionGroups(raw,{previousGroups=[]}={}){
 const changes=[];
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return {raw:raw??{},groups:[],changes:[{action:'skipped',reason:'raw-unavailable'}]};
 if(!Array.isArray(raw.elements))return {raw,groups:[],changes:[{action:'skipped',reason:'elements-unavailable'}]};
 const out=clone(raw);
 const elements=out.elements,byKey=new Map();
 for(const element of elements){
  if(!element||typeof element!=='object')continue;
  // A correction may resend the old parameterGroups verbatim. Cached contrary
  // evidence wins even when there is no new group declaration to validate.
  for(const parameter of Object.keys(element.parameterGroups||{}))if(rejectedParameter(element,parameter)){
   delete element.parameterGroups[parameter];
   if(element.recognitionEvidence?.byParameter)delete element.recognitionEvidence.byParameter[parameter];
  }
  if(element.parameterGroups&&!Object.keys(element.parameterGroups).length)delete element.parameterGroups;
 }
 for(const element of elements)if(element&&typeof element.key==='string')byKey.set(element.key,element);
 const declarations=normalizeDeclarations(out.recognitionGroups,byKey,changes);
 const groups=[],kept=[],claimed=new Map();
 for(const group of declarations){
  let conflict=null;
  for(const key of group.keys){for(const parameter of group.parameters){const slot=key+'|'+parameter;if(claimed.has(slot)){conflict={slot,other:claimed.get(slot)};break;}}if(conflict)break;}
  if(conflict){changes.push({action:'ignored',id:group.id,reason:'conflicting-parameter:'+conflict.slot+':'+conflict.other});continue;}
  for(const key of group.keys)for(const parameter of group.parameters)claimed.set(key+'|'+parameter,group.id);
  kept.push(group);
  const applied=applySharedGroup(elements,byKey,group);
  if(!applied.appliedParameters.length){changes.push({action:'ignored',id:group.id,reason:'no-element-can-share-parameters'});continue;}
  group.parameterKeys=applied.parameterKeys;
  if(applied.mutated)changes.push({action:'grouped',kind:'model',id:group.id,keys:group.keys,parameters:group.parameters,parameterKeys:applied.parameterKeys});
  groups.push({...group,source:'model'});
 }
 // Fallback also runs when model groups exist: only elements not already covered by
 // explicit model parameters (or by a previous fallback group) are eligible, so
 // newly added undeclared instances still get grouped without touching explicit ids.
 const usedIds=new Set(groups.map(group=>group.id));
 groups.push(...fallbackGroups(elements,byKey,previousGroups,usedIds,changes));
 out.recognitionGroups=kept.map(({id,keys,parameters,referenceKey,evidence,confidence})=>({id,keys,parameters,referenceKey,evidence,confidence}));
 return {raw:out,groups,changes};
}

export function revokeRecognitionParameters(elements,evidence,{groups=[]}={}){
 const decisions=[];
 const outElements=Array.isArray(elements)?clone(elements):[];
 const outGroups=Array.isArray(groups)?clone(groups):[];
 if(!Array.isArray(elements))decisions.push({action:'skipped',reason:'elements-not-array'});
 if(!Array.isArray(groups))decisions.push({action:'skipped',reason:'groups-not-array'});
 const byKey=new Map(outElements.filter(element=>element&&typeof element.key==='string').map(element=>[element.key,element]));
 for(const item of Array.isArray(evidence)?evidence:[]){
  const key=item?.key,parameter=item?.parameter;
  if(typeof key!=='string'||!byKey.has(key)){decisions.push({action:'ignored',key,parameter,reason:'unknown-element-key'});continue;}
  if(typeof parameter!=='string'||!knownParameters.has(parameter)){decisions.push({action:'ignored',key,parameter,reason:'unknown-parameter'});continue;}
  if(item?.contradicts!==true){decisions.push({action:'ignored',key,parameter,reason:'not-a-contradiction'});continue;}
  const confidence=Number(item?.confidence);
  if(!Number.isFinite(confidence)||confidence<0||confidence>1){decisions.push({action:'ignored',key,parameter,reason:'invalid-confidence'});continue;}
  const reason=typeof item?.reason==='string'?item.reason.trim():'';
  if(charCount(reason)<8){decisions.push({action:'ignored',key,parameter,reason:'reason-too-weak'});continue;}
  if(confidence<.85){decisions.push({action:'ignored',key,parameter,reason:'confidence-below-threshold',confidence});continue;}
  const element=byKey.get(key),groupId=element.parameterGroups?.[parameter];
  if(groupId===undefined){decisions.push({action:'noop',key,parameter,reason:'parameter-not-shared'});continue;}
  delete element.parameterGroups[parameter];
  if(!Object.keys(element.parameterGroups).length)delete element.parameterGroups;
  const rejections=Array.isArray(element.recognitionRejections)?element.recognitionRejections:[];
  if(!rejections.some(rejection=>rejection&&rejection.parameter===parameter&&rejection.groupId===groupId))element.recognitionRejections=[...rejections,{parameter,groupId,reason,confidence}];
  if(element.recognitionEvidence&&typeof element.recognitionEvidence==='object'){
   const previous=element.recognitionEvidence;
   const byParameter=previous.byParameter&&typeof previous.byParameter==='object'?{...previous.byParameter}:{};
   if(!Object.keys(byParameter).length&&Array.isArray(previous.parameters))for(const name of previous.parameters)if(name!==parameter&&element.parameterGroups?.[name]===previous.id)byParameter[name]={id:previous.id,confidence:previous.confidence,referenceKey:previous.referenceKey||'',evidence:previous.evidence||'',provisional:true,stage:'recognition'};
   delete byParameter[parameter];
   const parameters=sortParameters(Object.keys(byParameter));
   if(!parameters.length)delete element.recognitionEvidence;
   else{
    const first=byParameter[parameters[0]];
    element.recognitionEvidence={id:first.id,confidence:first.confidence,referenceKey:first.referenceKey,parameters,evidence:first.evidence,provisional:true,stage:'recognition',byParameter:Object.fromEntries(parameters.map(name=>[name,byParameter[name]]))};
   }
  }
  decisions.push({action:'revoked',key,parameter,groupId,reason,confidence,...(item.measuredValue===undefined?{}:{measuredValue:item.measuredValue})});
 }
 for(const group of outGroups){
  if(!group||typeof group!=='object')continue;
  const baseKeys=Array.isArray(group.keys)?group.keys.filter(key=>byKey.has(key)):[];
  const declared=Array.isArray(group.parameters)?group.parameters:[];
  const parameterKeys={},union=new Set();
  for(const parameter of declared){
   const keysFor=baseKeys.filter(key=>byKey.get(key)?.parameterGroups?.[parameter]===group.id);
   parameterKeys[parameter]=keysFor;keysFor.forEach(key=>union.add(key));
  }
  group.parameterKeys=parameterKeys;
  if(union.size)group.keys=[...union];
  else if(baseKeys.length)group.keys=baseKeys;
 }
 return {elements:outElements,groups:outGroups,decisions};
}
