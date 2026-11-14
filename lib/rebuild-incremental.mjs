// Measurement dependencies may be wider than the editable objects. Commit scopes stay explicit.
const overlaps=(a,b)=>a&&b&&a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
const native=e=>['rect','shape','ellipse','line'].includes(e?.type)&&!e.managed&&e.role!=='effect'&&!e.effectOf;
const signature=e=>JSON.stringify(e);

export function changedRebuildKeys(before,after){
  const previous=new Map((before||[]).map(e=>[e.key,e]));
  return (after||[]).filter(e=>signature(previous.get(e.key))!==signature(e)).map(e=>e.key);
}

const geometrySignature=element=>JSON.stringify(element&&Object.fromEntries([
  'key','type','x','y','w','h','shape','shapeGeometry','customGeometry','rotate','flipH','flipV',
  'text','latex','size','fontFace','bold','italic','charSpacing','lineSpacing','outline','shadow','glow','id','svg','tableId',
].map(field=>[field,element[field]])));
export function geometryChangedKeys(before,after){
  const previous=new Map(before.map(e=>[e.key,e])),next=new Map(after.map(e=>[e.key,e]));
  return [...new Set([...previous.keys(),...next.keys()])].filter(key=>geometrySignature(previous.get(key))!==geometrySignature(next.get(key)));
}

export function fittingTargetKeys(elements,requested,{previous=[]}={}){
  if(requested==null)return null;
  const keys=new Set(requested),byKey=new Map(elements.map(e=>[e.key,e]));
  const originals=new Map(previous.map(e=>[e.key,e]));
  for(const key of requested){
    const element=byKey.get(key),old=originals.get(key);
    // The full scene is still passed for masks. Only intersecting lower/native carriers need
    // another measurement when a glyph, image or contour moves or changes.
    for(const candidate of elements){
      if(!native(candidate))continue;
      if(overlaps(candidate,element)||overlaps(candidate,old))keys.add(candidate.key);
    }
    if(element?.tableId)for(const candidate of elements)if(candidate.tableId===element.tableId)keys.add(candidate.key);
  }
  for(const key of [...keys]){
    const component=byKey.get(key)?.objectIdentity?.component?.id;
    if(component)for(const element of elements)if(element.objectIdentity?.component?.id===component)keys.add(element.key);
  }
  return [...keys].filter(key=>byKey.has(key));
}

export function commitRebuildTargets(before,after,targetKeys){
  if(targetKeys==null)return after;
  const targets=new Set(targetKeys),updates=new Map(after.map(e=>[e.key,e]));
  return before.map(element=>targets.has(element.key)?updates.get(element.key)||element:element);
}

export function preserveExplicitPaint(before,after){
  const previous=new Map(before.map(e=>[e.key,e]));
  return after.map(element=>{
    const old=previous.get(element.key);
    if(!old||!native(element))return element;
    const locks=new Set(element.keepParameters||[]);
    if(['fill','gradient','fillOpacity','opacity'].some(field=>signature(old[field])!==signature(element[field])))locks.add('fill');
    if(['color','strokeWidth','strokeGradient','colorOpacity','opacity'].some(field=>signature(old[field])!==signature(element[field])))locks.add('stroke');
    return locks.size?{...element,keepParameters:[...locks]}:element;
  });
}

export async function settleRebuildEdit({before,elements,review={},context,adapters}){
  const changed=changedRebuildKeys(before,elements);
  if(!changed.length)return {elements,records:[]};
  const changedSet=new Set(changed),oldKeys=new Set(before.map(e=>e.key));
  const editable=review.targetKey?changed.filter(key=>key===review.targetKey):review.regionScope
    ?changed.filter(key=>!review.regionScope.lockedElements.some(e=>e.key===key)):changed;
  if(!editable.length)return {elements,records:[]};
  const {executeRebuildStage}=await import('./rebuild-stage-runner.mjs');
  const stages=await import('./rebuild-stages.mjs');
  const paint=adapters||await import('./rebuild-adapters.mjs');
  const changedGeometry=new Set(elements.filter(e=>{
    const old=before.find(o=>o.key===e.key);
    return native(e)&&editable.includes(e.key)&&(!old||['x','y','w','h','shape','shapeGeometry','customGeometry','rotate','flipH','flipV'].some(k=>signature(old[k])!==signature(e[k])));
  }).map(e=>e.key));
  const geometryTargets=[...changedGeometry];
  const newNative=elements.filter(e=>changedGeometry.has(e.key)&&!oldKeys.has(e.key)).map(e=>e.key);
  let current=elements;
  const records=[],paintState={};
  const execute=async(id,stage,targetKeys)=>{
    const output=await executeRebuildStage(id,stage,{...context,elements:current,targetKeys,paintState,
      adapters:{fill:paint.fillAdapter,stroke:paint.strokeAdapter,merge:paint.mergeAdapter}});
    records.push(output.record);
    if(output.record.status==='failed')throw Error('局部拟合失败：'+output.record.error);
    current=commitRebuildTargets(current,output.elements,targetKeys);
  };
  if(geometryTargets.length)await execute('S3-shape',adapters?.shapeStage||stages.shapeStage,geometryTargets);
  if(newNative.length){
    await execute('S4-fill',paint.fillAdapter,newNative);
    await execute('S5-stroke',paint.strokeAdapter,newNative);
  }
  // An explicit user paint patch must not be repainted by the reference fitter. Unchanged peers
  // can supply consensus evidence but are never committed by this incremental operation.
  const locked=preserveExplicitPaint(before,current);
  current=locked;
  await execute('S6-merge',paint.mergeAdapter,editable);
  const originals=new Map(elements.map(e=>[e.key,e]));
  current=current.map(e=>{
    if(!changedSet.has(e.key))return originals.get(e.key)||e;
    const next={...e};
    if(originals.get(e.key)?.keepParameters)next.keepParameters=originals.get(e.key).keepParameters;
    else delete next.keepParameters;
    return next;
  });
  return {elements:commitRebuildTargets(elements,current,editable),records};
}
