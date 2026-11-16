import {parameterBlocked} from './parameter-group-policy.mjs';

const rgb=value=>/^[\da-f]{6}$/i.test(value||'')?[0,2,4].map(i=>parseInt(value.slice(i,i+2),16)):null;
const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
const confidence=run=>run.consensus?.inherited?0:run.source==='reference-glyphs'?Math.max(0,Math.min(1,Number(run.evidence?.confidence)||0)):0;

// Content siblings define parallelism. A visual carrier or equal y position does
// not establish it, and an accent group never creates a run on plain text.
export function mergeParallelTextAccents(elements,{nodes=[],targetKeys=null,referenceHash}={}){
 const byId=new Map(nodes.map(n=>[n.id,n])),groups=new Map(),updates=new Map(),records=[];
 for(const e of elements){
  if(e.type!=='text'||e.managed||!e.textColorRuns?.length||parameterBlocked(e,'textColor')||parameterBlocked(e,'textAccentColor'))continue;
  const node=byId.get(e.nodeId),parent=byId.get(node?.parentId);
  if(!parent||parent.childRelation==='sequence'||!['group','text'].includes(parent.type))continue;
  const id=parent.id+':'+e.role+':'+(e.visualState||e.emphasis||'normal');
  const list=groups.get(id)||[];
  for(const [index,run]of e.textColorRuns.entries()){
   if(run.text!==e.text||!run.charRanges?.length||run.source==='user')continue;
   if(run.source==='reference-glyphs'&&(!run.referenceHash||referenceHash&&run.referenceHash!==referenceHash))continue;
   const color=rgb(run.consensus?.measuredColor||run.color);if(!color||run.color.toUpperCase()===String(e.color).toUpperCase())continue;
   list.push({e,run,index,color,weight:confidence(run)});
  }
  groups.set(id,list);
 }
 for(const [id,all]of groups){
  // A measurement of another reference version cannot supply today's colour.
  for(const hash of new Set(all.map(r=>r.run.referenceHash))){
  const entries=all.filter(r=>r.run.referenceHash===hash);
  const reliable=entries.filter(r=>r.weight>=.55).sort((a,b)=>b.weight-a.weight||a.e.key.localeCompare(b.e.key));
  const used=new Set();
  for(const seed of reliable){
   if(used.has(seed))continue;
   const cluster=[seed];used.add(seed);
   // Complete linkage prevents intermediate yellow/orange colours bridging
   // two intentionally different accent palettes.
   for(const r of reliable)if(!used.has(r)&&cluster.every(c=>distance(c.color,r.color)<=32)){cluster.push(r);used.add(r);}
   const independent=[...new Map(cluster.map(r=>[r.e.key,r])).values()];
   const representative=independent.reduce((best,r)=>{
    const cost=independent.reduce((s,c)=>s+c.weight*distance(r.color,c.color),0);
    return !best||cost<best.cost?{r,cost}:best;
   },null).r;
   const members=entries.filter(r=>cluster.includes(r)||r.weight<.55&&cluster.every(c=>distance(c.color,r.color)<=32));
   if(new Set(members.map(r=>r.e.key)).size<2)continue;
   const sources=independent.map(r=>r.e.key),color=(representative.run.consensus?.measuredColor||representative.run.color).toUpperCase();
   let changed=0;
   for(const member of members){
    if(targetKeys&&!targetKeys.includes(member.e.key))continue;
    const runs=updates.get(member.e.key)||member.e.textColorRuns.map(r=>({...r}));
    runs[member.index]={...member.run,color,consensus:{group:id,sources,
      inherited:member.weight<.55,measuredColor:member.run.consensus?.measuredColor||member.run.color}};
    updates.set(member.e.key,runs);if(member.run.color.toUpperCase()!==color)changed++;
   }
   records.push({group:id,color,keys:[...new Set(members.map(r=>r.e.key))],sources,changed});
  }
  }
 }
 return {elements:elements.map(e=>updates.has(e.key)?{...e,textColorRuns:updates.get(e.key)}:e),records};
}
