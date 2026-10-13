// Image files are immutable. History stores the record and its provenance only.
const snapshot=record=>{
  const {editHistory,...value}=record;
  return structuredClone(value);
};
export function imageHistory(record){
  return record.editHistory||{past:(record.repairHistory||[]).map(snapshot),future:[]};
}
export function rememberImage(previous,next){
  if(previous){const history=imageHistory(previous);next.editHistory={past:[...history.past,snapshot(previous)],future:[]};}
  return next;
}
export function restoreImage(record,direction){
  if(!['undo','redo'].includes(direction))throw Error('撤回方式无效');
  const history=structuredClone(imageHistory(record)),from=direction==='undo'?'past':'future',to=direction==='undo'?'future':'past';
  if(!history[from].length)throw Error(direction==='undo'?'没有可撤回的图片修改':'没有可重做的图片修改');
  const previous=history[from].pop();history[to].push(snapshot(record));
  return {...previous,editHistory:history};
}
