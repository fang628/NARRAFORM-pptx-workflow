// Visibility rules for extracted composite figures.
//
// A whole figure may be retained as an internal source (file, provenance, crop source) while its
// reliable panels are the only usable image materials. A partial split must keep the complete whole
// figure visible so no un-split panel information is hidden. Original user uploads are never
// deleted; when a reliable split makes them a source container they are marked excluded instead.
const panelIndex=m=>Number.isInteger(m?.documentFigure?.panelIndex)?m.documentFigure.panelIndex:null;
const panelKey=m=>{
  const index=panelIndex(m);
  if(index===null)return null;
  const parentBox=m.documentFigure?.parentBox;
  return (parentBox?JSON.stringify(parentBox):'group')+':'+index;
};
const parentHash=parent=>parent?.sourceMaterialHash||parent?.sha256||null;
function validPanelChildren(parent,children){
  const hash=parentHash(parent),seen=new Set(),valid=[],duplicates=[];
  for(const child of children||[]){
    if(!child||child.kind!=='image')continue;
    if(child.parentImageId!==parent.id&&child.documentFigure?.parentImageId!==parent.id)continue;
    const key=panelKey(child);if(key===null)continue;
    // Old/duplicate registrations must share the source original hash to count as this parent's
    // panel; a repeated panelIndex is never two panels.
    if(child.sourceMaterialHash&&hash&&child.sourceMaterialHash!==hash)continue;
    if(seen.has(key)){duplicates.push(child);continue;}
    seen.add(key);valid.push(child);
  }
  return {valid,duplicates};
}
export function compositeVisibilityState(parent,children){
  const expected=Number(parent?.documentFigure?.panelCount||parent?.panelCount||parent?.documentFigure?.partialSplit?.expected||0)||0;
  const {valid,duplicates}=validPanelChildren(parent,children),generated=valid.length;
  const complete=expected>=2&&generated>=expected;
  return {expected,generated,complete,partial:expected>=2&&generated>0&&generated<expected,valid,duplicates};
}
export function normalizeCompositeMaterialVisibility(materials){
  let changed=false;
  for(const parent of materials||[]){
    if(!parent||parent.kind!=='image')continue;
    const children=(materials||[]).filter(m=>m.parentImageId===parent.id||m.documentFigure?.parentImageId===parent.id);
    const marked=!!(parent.compositeFigure||parent.documentFigure?.compositeFigure||parent.documentFigure?.panelCount||parent.documentFigure?.partialSplit||parent.panelCount);
    if(!children.length&&!marked)continue;
    const state=compositeVisibilityState(parent,children);
    // Repeated old registrations of the same panel keep their files but not separate visibility.
    for(const duplicate of state.duplicates)if(!duplicate.excludedFromContent){duplicate.excludedFromContent=true;changed=true;}
    if(state.complete){
      if(!parent.excludedFromContent){parent.excludedFromContent=true;changed=true;}
    }else if(state.partial){
      // A partial split keeps the whole figure usable, as un-split panels may still be needed.
      if(parent.excludedFromContent&&(parent.documentFigure?.partialSplit||parent.partialSplit)){delete parent.excludedFromContent;changed=true;}
    }
  }
  return changed;
}
