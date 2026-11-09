export const overlapLayerRule='先按对象而非连通色区拆层：相接或重叠的框、徽标、箭头与装饰仍分别登记独立key，完整轮廓与前后顺序；不能把叠加剪影当成一个新几何形状。结合可见直边、对称性、同类实例和语义判断遮挡后的基础几何；缺少证据不臆造隐蔽细节。文字和承载框分别登记。附layerInventory:[{key,frontOf:[被它遮挡的对象key]}]，只登记有视觉证据的遮挡，不用它表达语义流程。原生主体与复杂光效可拆成独立叠放对象，不将多件重叠物体合成一张素材。';

export function extractionLayerContext(elements=[],targetKey,sourceBox){
  if(!sourceBox)return '';
  const at=elements.findIndex(e=>e.key===targetKey);
  const neighbors=elements.flatMap((e,i)=>e.key===targetKey||Math.min(e.x+e.w,sourceBox.x+sourceBox.w)<=Math.max(e.x,sourceBox.x)||Math.min(e.y+e.h,sourceBox.y+sourceBox.h)<=Math.max(e.y,sourceBox.y)?[]:[{key:e.key,type:e.type,description:e.description||e.frameKind||e.shape||e.role||e.key,relativeOrder:at<0?'unknown':i>at?'front':'back'}]).slice(0,16);
  return neighbors.length?' 该目标与其他独立对象重叠。只提取目标本身，不能将它们粘成一个素材。其他对象（应移除，前后关系仅辅助识别）：'+JSON.stringify(neighbors):'';
}

// Optional legacy-compatible evidence. Stable topological order preserves model
// order among unrelated objects, and never deduplicates overlapping instances.
export function applyLayerInventory(elements,inventory,{allowUncertainGeometry=false}={}){
  if(inventory===undefined)return {elements,inventory:[]};
  if(!Array.isArray(inventory)||inventory.length>220)throw Error('遮挡分层清单无效');
  const byKey=new Map(elements.map(e=>[e.key,e])),seen=new Set(),edges=new Map(elements.map(e=>[e.key,new Set()])),counts=new Map(elements.map(e=>[e.key,0]));
  const normalized=inventory.map(item=>{
    if(!item||!byKey.has(item.key)||seen.has(item.key)||!Array.isArray(item.frontOf)||item.frontOf.length>220)throw Error('遮挡分层清单含重复或不存在的对象');
    seen.add(item.key);const frontOf=[...new Set(item.frontOf)];
    for(const back of frontOf){
      if(!byKey.has(back)||back===item.key)throw Error('遮挡分层引用无效');
      const a=byKey.get(item.key),b=byKey.get(back);
      // Fitted outlines can share an antialiased edge; subpixel rounding must
      // not turn a valid touching/stacked composition into a stage failure.
      if(!allowUncertainGeometry&&(Math.min(a.x+a.w,b.x+b.w)<Math.max(a.x,b.x)-1||Math.min(a.y+a.h,b.y+b.h)<Math.max(a.y,b.y)-1))throw Error('遮挡分层对象没有空间交叠，请检查前后关系');
      if(!edges.get(back).has(item.key)){edges.get(back).add(item.key);counts.set(item.key,counts.get(item.key)+1);}
    }
    return {key:item.key,frontOf};
  });
  const result=[],used=new Set();
  while(result.length<elements.length){const next=elements.find(e=>!used.has(e.key)&&counts.get(e.key)===0);if(!next)throw Error('遮挡分层存在循环，须按真实前后顺序修正');used.add(next.key);result.push(next);for(const key of edges.get(next.key))counts.set(key,counts.get(key)-1);}
  return {elements:result,inventory:normalized};
}
