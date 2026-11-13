import {nativeGroupParameters} from './native-parameter-groups.mjs';
import {measuredSlant,slantAngleDelta,groupMeasuredSlants} from './slant-groups.mjs';
import {parameterRejected,parameterBlocked} from './parameter-group-policy.mjs';

// Recognition-stage groups are hypotheses for the model to declare, not verified
// truth. Local fitting may later contradict single parameters of a group.
export const recognitionGroupRule='所有参数按独立实测置信度加权归并：可靠成员提供参数，弱成员继承；继承值不作为独立投票；可靠成员冲突拆组，全组无可靠证据保持待定。识别同类框时返回 recognitionGroups:[{id,keys,parameters,referenceKey,evidence,confidence}]；只共享有依据的参数，不同位置/尺寸/强调/独立层保留；本组仅为假设，后续拟合可反证并仅撤销有差异参数；已有recognitionRejections不得重新加组。';

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
const isEligibleCarrier=element=>Boolean(element)&&nativeTypes.has(element.type)&&isCarrier(element)&&!isEffect(element)&&Number.isFinite(element.x)&&Number.isFinite(element.y)&&Number.isFinite(element.w)&&Number.isFinite(element.h)&&element.w>0&&element.h>0&&(element.type==='ellipse'&&Math.min(element.w,element.h)>=4||element.class==='divider'&&Math.min(element.w,element.h)>=3&&Math.max(element.w,element.h)>=20||Math.min(element.w,element.h)>=24&&element.w*element.h>=1600);
const rejectedParameter=parameterRejected;
const colourSignature=element=>{
 const stops=element?.gradient?.stops;
 if(Array.isArray(stops)&&stops.length){const sampled=[0,.25,.5,.75,1].map(t=>{let i=stops.findIndex(stop=>stop.position>=t);if(i<0)i=stops.length-1;const lo=stops[Math.max(0,i-1)],hi=stops[i],f=Math.max(0,Math.min(1,(t-lo.position)/((hi.position-lo.position)||1))),a=rgb(lo?.color),b=rgb(hi?.color);return a&&b?a.map((v,j)=>v+(b[j]-v)*f):null;}).filter(Boolean);return sampled.length?sampled:null;}
 const solid=rgb(element?.fill)||rgb(element?.color);return solid?Array.from({length:5},()=>solid):null;
};
const colourDistance=(a,b)=>{const x=colourSignature(a),y=colourSignature(b);if(!x||!y)return Infinity;let total=0;for(let i=0;i<5;i++)total+=Math.hypot(x[i][0]-y[i][0],x[i][1]-y[i][1],x[i][2]-y[i][2]);return total/5;};
const sizeRatio=(a,b)=>Math.max(a.w/b.w,b.w/a.w,a.h/b.h,b.h/a.h);
const sameAxis=(a,b)=>{const row=Math.abs((a.y+a.h/2)-(b.y+b.h/2))<=Math.max(10,.3*Math.min(a.h,b.h));const column=Math.abs((a.x+a.w/2)-(b.x+b.w/2))<=Math.max(10,.3*Math.min(a.w,b.w));return row||column;};
const strokeElement=e=>({...e,fill:e.color,gradient:e.strokeGradient});
const compatibleCarrier=(a,b,parameter)=>{
 if(family(a)!==family(b)||frameKindOf(a)!==frameKindOf(b)||phaseOf(a)!==phaseOf(b))return false;
 if(sizeRatio(a,b)>1.35)return false;
 if(!sameAxis(a,b))return false;
 if(parameter==='slant')return slantAngleDelta(measuredSlant(a),measuredSlant(b))<=2;
 if(parameter==='strokeWidth')return Math.abs(a.strokeWidth-b.strokeWidth)<=Math.max(.4,Math.min(a.strokeWidth,b.strokeWidth)*.15);
 if(parameter==='strokeColor')return colourDistance(strokeElement(a),strokeElement(b))<=40;
 if(parameter==='stroke')return compatibleCarrier(a,b,'strokeWidth')&&compatibleCarrier(a,b,'strokeColor');
 if(parameter==='gradientAngle'){
  const d=Math.abs(a.gradient.angle-b.gradient.angle)%360;return Math.min(d,360-d)<=5;
 }
 if(parameter==='gradientCenter')return a.gradient?.type===b.gradient?.type&&Math.hypot(a.gradient.center.x-b.gradient.center.x,a.gradient.center.y-b.gradient.center.y)<=.05;
 if(Boolean(a.gradient)!==Boolean(b.gradient))return false;
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
 if(members.every(member=>member.gradient?.center))list.push('gradientCenter');
 if(members.every(member=>Array.isArray(member.gradient?.stops)&&member.gradient.stops.length>=2&&member.gradient.stops.every(stop=>stop.opacity===undefined||stop.opacity>=.98)))list.push('gradientStops');
 if(members.every(member=>measuredSlant(member))&&members.every(member=>slantAngleDelta(measuredSlant(member),measuredSlant(members[0]))<=2))list.push('slant');
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
const isFallbackEligible=(element,parameter,reusableFallbackIds)=>{
 const id=element?.parameterGroups?.[parameter];
 return !parameterBlocked(element,parameter)&&(id===undefined||reusableFallbackIds.has(id)
  ||element.recognitionEvidence?.byParameter?.[parameter]?.source==='fallback');
};

function refreshRecognitionEvidence(element,group,ownedParameters){
 const existing=element.recognitionEvidence&&typeof element.recognitionEvidence==='object'?element.recognitionEvidence:null;
 const previousTop=existing&&typeof existing.id==='string'?existing:null;
 const byParameter=existing?.byParameter&&typeof existing.byParameter==='object'?{...existing.byParameter}:{};
 for(const parameter of ownedParameters)byParameter[parameter]={id:group.id,confidence:group.confidence,referenceKey:group.referenceKey,evidence:group.evidence,provisional:true,stage:'recognition',...(group.source==='fallback'?{source:'fallback'}:{})};
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
   if(parameterBlocked(element,parameter))continue;
   const current=element.parameterGroups?.[parameter];
   if(current!==undefined){if(current===group.id){keysFor.push(key);owned.add(parameter);}continue;}
   element.parameterGroups={...(element.parameterGroups||{}),[parameter]:group.id};
   keysFor.push(key);applied.add(parameter);owned.add(parameter);mutated=true;
  }
  parameterKeys[parameter]=keysFor;
 }
 for(const key of group.keys){
  const element=byKey.get(key);if(!element)continue;
  const ownedParameters=group.parameters.filter(parameter=>element.parameterGroups?.[parameter]===group.id);
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
  let shareable=requested.filter(parameter=>!dimensionParameters.has(parameter));
  if(shareable.includes('shape')&&!shareable.includes('corners'))shareable.push('corners');
  if(!shareable.length){changes.push({action:'ignored',id:groupId,reason:'no-shareable-parameters'});continue;}
  const confidence=item.confidence===undefined?0.8:Number(item.confidence);
  if(!Number.isFinite(confidence)||confidence<0||confidence>1){changes.push({action:'ignored',id:groupId,reason:'invalid-confidence'});continue;}
  const evidence=typeof item.evidence==='string'?item.evidence.trim():'';
  if(charCount(evidence)<8){changes.push({action:'ignored',id:groupId,reason:'evidence-too-weak'});continue;}
  const members=uniqueKeys.map(key=>byKey.get(key));
  const families=[...new Set(members.map(family))];
  if(families.length>1&&!shareable.includes('shape')){
   const slopes=members.map(measuredSlant);
   if(!shareable.includes('slant')||!slopes.every(Boolean)||!slopes.every(s=>slantAngleDelta(s,slopes[0])<=2)){
    changes.push({action:'ignored',id:groupId,reason:'family-mismatch:'+families.join('/')});continue;
   }
   const removed=shareable.filter(p=>p!=='slant');
   if(removed.length)changes.push({action:'trimmed',id:groupId,parameters:removed,reason:'cross-family-shares-only-slant'});
   shareable=['slant'];
  }
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

function fallbackGroupId(cluster,parameter,previousGroups,reservedIds,usedSlots){
 const keys=cluster.map(element=>element.key);
 const existing=cluster.find(element=>element.parameterGroups?.[parameter]);
 if(existing&&!reservedIds.has(existing.parameterGroups[parameter])&&!usedSlots.has(existing.parameterGroups[parameter]+'|'+parameter))return existing.parameterGroups[parameter];
 const reusable=(Array.isArray(previousGroups)?previousGroups:[]).filter(group=>{
  const members=group?.parameterKeys?.[parameter]||group?.keys;
  return group?.source==='fallback'&&group.parameters?.includes(parameter)&&members?.length>=2&&members.every(key=>keys.includes(key));
 }).sort((a,b)=>b.keys.length-a.keys.length)[0];
 if(reusable&&typeof reusable.id==='string'&&reusable.id.trim()&&!reservedIds.has(reusable.id)&&!usedSlots.has(reusable.id+'|'+parameter))return reusable.id;
 const base='rg-'+slug(frameKindOf(cluster[0])||family(cluster[0]))+'-'+hash(keys.slice().sort().join('|'));
 let id=base,index=2;while(reservedIds.has(id)||usedSlots.has(id+'|'+parameter))id=base+'-'+index++;
 return id;
}

function fallbackGroups(elements,byKey,previousGroups,reservedIds,changes,claimed){
 const reusableFallbackIds=new Set((Array.isArray(previousGroups)?previousGroups:[]).filter(group=>group?.source==='fallback'&&typeof group.id==='string').map(group=>group.id));
 const buckets=new Map();
 for(const element of elements.filter(isEligibleCarrier)){
  const bucket=`${family(element)}\u0000${frameKindOf(element)}\u0000${phaseOf(element)}`;
  if(!buckets.has(bucket))buckets.set(bucket,[]);
  buckets.get(bucket).push(element);
 }
 const grouped=new Map(),usedSlots=new Set();
 for(const bucket of [...buckets.keys()].sort()){
  const all=buckets.get(bucket);
  for(const parameter of nativeGroupParameters.filter(name=>!dimensionParameters.has(name)&&name!=='corners'&&name!=='slant')){
  const members=all.filter(element=>!claimed.has(element.key+'|'+parameter)&&isFallbackEligible(element,parameter,reusableFallbackIds)&&shareableParameters([element]).includes(parameter))
   .sort((a,b)=>Number(!a.parameterGroups?.[parameter])-Number(!b.parameterGroups?.[parameter])||(a.y-b.y)||(a.x-b.x)||String(a.key).localeCompare(String(b.key)));
  const used=new Set();
  for(const anchor of members){
   if(used.has(anchor.key))continue;
   used.add(anchor.key);
   const cluster=[anchor];
   for(const candidate of members){
    if(used.has(candidate.key)||candidate===anchor)continue;
    const label=cluster.find(member=>member.parameterGroups?.[parameter])?.parameterGroups[parameter];
    if(label&&candidate.parameterGroups?.[parameter]&&candidate.parameterGroups[parameter]!==label)continue;
    if(cluster.every(member=>compatibleCarrier(member,candidate,parameter))){cluster.push(candidate);used.add(candidate.key);}
   }
   if(cluster.length<2)continue;
   const id=fallbackGroupId(cluster,parameter,previousGroups,reservedIds,usedSlots);
   usedSlots.add(id+'|'+parameter);
   for(const element of cluster)if(element.parameterGroups?.[parameter]&&element.parameterGroups[parameter]!==id){
    delete element.parameterGroups[parameter];
    if(element.recognitionEvidence?.byParameter)delete element.recognitionEvidence.byParameter[parameter];
   }
   if(!grouped.has(id))grouped.set(id,{id,keys:[],parameters:[],parameterKeys:{},source:'fallback'});
   const group=grouped.get(id);
   group.parameters.push(parameter);group.parameterKeys[parameter]=cluster.map(element=>element.key);
   group.keys=[...new Set([...group.keys,...group.parameterKeys[parameter]])];
  }
  }
 }
 const groups=[...grouped.values()];
 for(const group of groups){
  group.keys.sort((a,b)=>{const x=byKey.get(a),y=byKey.get(b);return x.y-y.y||x.x-y.x||a.localeCompare(b);});
  group.parameters=sortParameters([...new Set(group.parameters)]);
  const members=group.keys.map(key=>byKey.get(key));
  const ratio=Math.max(...members.map(member=>sizeRatio(members[0],member)));
  const colours=members.map(member=>colourDistance(members[0],member)).filter(Number.isFinite);
  const colour=colours.reduce((sum,value)=>sum+value,0)/Math.max(1,colours.length);
  Object.assign(group,{referenceKey:group.keys[0],confidence:fallbackConfidence(members,colour,ratio),
   evidence:fallbackEvidence(members,group.parameters,colour,ratio)});
  const parameterKeys=group.parameterKeys,before=JSON.stringify(members);
  for(const parameter of group.parameters){
   const keys=parameterKeys[parameter];
   const own=keys.map(key=>byKey.get(key)),paint=parameter.startsWith('stroke')?strokeElement:element=>element;
   const distances=['fill','gradientStops','stroke','strokeColor'].includes(parameter)
    ?own.map(element=>colourDistance(paint(own[0]),paint(element))).filter(Number.isFinite):[];
   const delta=distances.reduce((sum,value)=>sum+value,0)/Math.max(1,distances.length);
   const size=Math.max(...own.map(element=>sizeRatio(own[0],element)));
   const applied=applySharedGroup(elements,byKey,{...group,parameters:[parameter],keys,
    referenceKey:keys[0],confidence:fallbackConfidence(own,delta,size),evidence:fallbackEvidence(own,[parameter],delta,size)});
   group.parameterKeys[parameter]=applied.parameterKeys[parameter];
  }
  group.parameters=group.parameters.filter(parameter=>group.parameterKeys[parameter].length>=2);
  group.parameterKeys=Object.fromEntries(group.parameters.map(parameter=>[parameter,group.parameterKeys[parameter]]));
  group.keys=group.keys.filter(key=>group.parameters.some(parameter=>group.parameterKeys[parameter].includes(key)));
  if(before!==JSON.stringify(members))changes.push({action:'grouped',kind:'fallback',id:group.id,keys:group.keys,parameters:group.parameters,parameterKeys:group.parameterKeys});
 }
 return groups.filter(group=>group.parameters.length);
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
  const parameters=group.parameters.filter(parameter=>{
   const key=group.keys.find(key=>claimed.has(key+'|'+parameter));
   if(key!==undefined){changes.push({action:'ignored',id:group.id,parameters:[parameter],reason:'conflicting-parameter:'+key+'|'+parameter+':'+claimed.get(key+'|'+parameter)});return false;}
   return true;
  });
  if(!parameters.length)continue;
  group.parameters=parameters;
  for(const key of group.keys)for(const parameter of group.parameters)claimed.set(key+'|'+parameter,group.id);
  kept.push(group);
  const applied=applySharedGroup(elements,byKey,group);
  if(!applied.appliedParameters.length){changes.push({action:'ignored',id:group.id,reason:'no-element-can-share-parameters'});continue;}
  group.parameterKeys=applied.parameterKeys;
  if(applied.mutated)changes.push({action:'grouped',kind:'model',id:group.id,keys:group.keys,parameters:group.parameters,parameterKeys:applied.parameterKeys});
  groups.push({...group,source:'model'});
 }
 // Explicit ownership applies per parameter, never to the whole object.
 const usedIds=new Set(groups.map(group=>group.id));
 groups.push(...fallbackGroups(elements,byKey,previousGroups,usedIds,changes,claimed));
 // Slant compares physical edges across object kinds; paint buckets stay scoped.
 const slantCandidates=elements.filter(e=>!e.managed&&!isEffect(e)&&!parameterBlocked(e,'slant')
   &&(!e.parameterGroups?.slant||e.recognitionEvidence?.byParameter?.slant?.source==='fallback')&&!claimed.has(e.key+'|slant'));
 for(const candidate of groupMeasuredSlants(slantCandidates)){
  const labels=[...new Set(candidate.keys.map(key=>byKey.get(key).parameterGroups?.slant).filter(Boolean))];
  if(labels.length>1)continue;
  const group={...candidate,id:labels[0]||candidate.id,parameters:['slant'],referenceKey:candidate.keys[0],confidence:.8,source:'fallback'};
  const applied=applySharedGroup(elements,byKey,group);
  groups.push({...group,parameterKeys:applied.parameterKeys});
  if(applied.mutated)changes.push({action:'grouped',kind:'fallback',id:group.id,keys:group.keys,parameters:['slant'],parameterKeys:applied.parameterKeys});
 }
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
