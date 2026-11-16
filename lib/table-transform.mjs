// Local edits operate on the table coordinate system, never individual cells.
export function tableBounds(elements,id){
 if(typeof id!=='string'||!id.trim())throw Error('请提供有效tableId');
 const members=elements.filter(e=>e.tableId===id);
 if(!members.length)throw Error('表格不存在：'+id);
 const object=members.find(e=>e.tableObject)?.tableObject,outer=object?.outer;
 if(outer&&[outer.x,outer.y,outer.w,outer.h].every(Number.isFinite)&&outer.w>0&&outer.h>0)return {x:outer.x,y:outer.y,w:outer.w,h:outer.h};
 const x=Math.min(...members.map(e=>e.x)),y=Math.min(...members.map(e=>e.y));
 return {x,y,w:Math.max(...members.map(e=>e.x+e.w))-x,h:Math.max(...members.map(e=>e.y+e.h))-y};
}

export function transformTable(elements,change){
 const id=change.tableId,old=tableBounds(elements,id),box={...old};
 if(Object.keys(change).some(k=>!['tableId','x','y','w','h'].includes(k)))throw Error('整表只允许调整x、y、w、h');
 for(const k of ['x','y','w','h'])if(change[k]!==undefined)box[k]=change[k];
 if(!Object.values(box).every(Number.isFinite)||box.w<=0||box.h<=0||box.x<0||box.y<0||box.x+box.w>1600.1||box.y+box.h>900.1)throw Error('整表位置或尺寸无效');
 const sx=box.w/old.w,sy=box.h/old.h,scale=Math.min(sx,sy);
 const horizontal=new Set(['x','left','right','contentLeft','contentRight','inkLeft','inkRight','targetX','boundLeft']);
 const vertical=new Set(['y','top','bottom','contentTop','contentBottom','inkTop','inkBottom','targetY','boundTop']);
 const lengthsX=new Set(['w','boundWidth','centerOffset','inset']);
 const lengthsY=new Set(['h','boundHeight']);
 const map=(value,key='')=>{
  if(typeof value==='number')return horizontal.has(key)?box.x+(value-old.x)*sx:vertical.has(key)?box.y+(value-old.y)*sy:lengthsX.has(key)?value*sx:lengthsY.has(key)?value*sy:value;
  if(Array.isArray(value))return value.map(v=>map(v,key==='boundaries'?'y':key==='verticalBoundaries'?'x':''));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,map(v,k)]));
  return value;
 };
 return elements.map(e=>{
  if(e.tableId!==id)return e;
  const next={...e,x:box.x+(e.x-old.x)*sx,y:box.y+(e.y-old.y)*sy,w:e.w*sx,h:e.h*sy};
  for(const k of ['tableObject','tableAlignment','objectIdentity'])if(e[k])next[k]=map(e[k]);
  if(e.type==='text'){
   if(e.size!=null)next.size=e.size*scale;
   if(e.charSpacing!=null)next.charSpacing=e.charSpacing*sx;
   if(e.lineSpacing!=null)next.lineSpacing=e.lineSpacing*sy;
  }
  if(e.strokeWidth!=null)next.strokeWidth=e.strokeWidth*scale;
  for(const field of ['start','end','sourceBox'])if(e[field])next[field]=map(e[field]);
  delete next.referencePositionEvidence;
  next.tableTransform={version:1,tableId:id,from:old,to:box};
  return next;
 });
}

export function assertTablePatch(elements,patch){
 const byKey=new Map(elements.map(e=>[e.key,e]));
 for(const edit of patch.edits||[])if(byKey.get(edit.key)?.tableId)throw Error('表格成员不能单独修改；请用tables:[{tableId,x,y,w,h}]调整整张表');
 for(const key of patch.remove||[])if(byKey.get(key)?.tableId)throw Error('局部修正不能删除表格成员');
 for(const e of patch.add||[]){
  if(e.tableId||/-cell-\d+-\d+$/.test(e.nodeId||''))throw Error('局部修正不能新增或重排表格成员');
  if(['x','y','w','h'].every(k=>Number.isFinite(e[k])))for(const id of new Set(elements.map(e=>e.tableId).filter(Boolean))){
   const b=tableBounds(elements,id),cx=e.x+e.w/2,cy=e.y+e.h/2;
   if(cx>=b.x&&cx<=b.x+b.w&&cy>=b.y&&cy<=b.y+b.h)throw Error('局部修正不能在表格内部新增覆盖物或分隔元素');
  }
 }
 if(patch.order){
  for(const id of new Set(elements.map(e=>e.tableId).filter(Boolean))){
   const keys=elements.filter(e=>e.tableId===id).map(e=>e.key);
   if(JSON.stringify(patch.order.filter(k=>keys.includes(k)))!==JSON.stringify(keys))throw Error('局部修正不能改变表格内部层级');
  }
 }
}

export function assertAtomicTableEdits(before,after){
 const equivalent=(a,b)=>{
  if(typeof a==='number'&&typeof b==='number')return Math.abs(a-b)<=1e-7;
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
  const keys=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>k!=='tableTransform');
  return keys.every(k=>equivalent(a[k],b[k]));
 };
 for(const id of new Set(before.map(e=>e.tableId).filter(Boolean))){
  const original=before.filter(e=>e.tableId===id),next=after.filter(e=>e.tableId===id);
  if(original.length!==next.length||original.some(e=>!next.some(n=>n.key===e.key)))throw Error('局部修正不能增删表格成员');
  if(original.every(e=>JSON.stringify(e)===JSON.stringify(next.find(n=>n.key===e.key))))continue;
  const change=next[0].tableTransform;
  if(!change||change.tableId!==id)throw Error('表格只能整表平移或缩放，不能单独修改成员');
  const expected=transformTable(before,{tableId:id,...change.to});
  for(const e of original){
   const wanted=expected.find(n=>n.key===e.key),actual=next.find(n=>n.key===e.key);
   if(!equivalent(wanted,actual))throw Error('表格内部参数或相对位置不能单独改变：'+e.key);
  }
 }
}
