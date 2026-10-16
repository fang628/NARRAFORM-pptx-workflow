export function crossThemeRequest(p,{sourceTheme,targetTheme,use,sourceHash,targetStyleId,targetHash,instruction=''}){
  const source=p.themeAssets?.directions.find(d=>d.id===sourceTheme)?.assets?.[use],d=p.themeAssets?.directions.find(d=>d.id===targetTheme);
  if(!p.themeAssetsCurrent||!source||!d||targetTheme===sourceTheme)throw Error('底图或方向已变化，请重新打开');
  if(source.previewHash!==sourceHash||d.styleRegistrationId!==targetStyleId||(d.assets?.[use]?.previewHash??null)!==targetHash)throw Error('图片或目标风格已变化，请重新打开交叉修改');
  const draft=p.themeAssetPrompts.find(r=>r.theme===targetTheme&&r.use===use);
  if(!draft)throw Error('目标底图用途未启用');
  return {theme:targetTheme,use,confirmed:true,revision:draft.revision,prompt:draft.prompt,instruction,crossStyleSource:{theme:sourceTheme,sourceHash},crossStyleTargetStyleId:targetStyleId,crossStyleTargetHash:targetHash};
}

export function crossImageChoices(p,target){
  return target.targetType==='theme'?(p.themeCrossStyleOptions||[]):target.targetType==='visual'&&target.kind==='concept'?(p.previewCrossStyleOptions||[]):[];
}
export function crossImageTarget(p,target,id){
  return target.targetType==='theme'?{targetType:'theme',theme:id,use:target.use}:{targetType:'visual',kind:'concept',theme:id,index:target.index};
}
export function crossImageSelection(p,target,referenceTheme,currentHash){
  const image=id=>target.targetType==='theme'?p.themeAssets?.directions.find(d=>d.id===id)?.assets?.[target.use]:p.concepts?.find(d=>d.id===id)?.representatives.find(r=>r.index===target.index);
  const reference=image(referenceTheme),current=image(target.theme),style=crossImageChoices(p,target).find(d=>d.id===target.theme);
  if(referenceTheme===target.theme||!reference||!current||!style)throw Error('请选择另一方向的有效同页图片作为结构参考');
  if(current.previewHash!==currentHash)throw Error('当前图片已变化，请重新打开修改窗口');
  return {sourceTheme:referenceTheme,use:target.use,sourceHash:reference.previewHash,targetTheme:target.theme,targetStyleId:style.styleId,targetHash:currentHash};
}
export function crossImageRequest(p,target,state,instruction=''){
  if(state.targetTheme!==target.theme||state.sourceTheme===target.theme)throw Error('交叉修改须保留当前方向风格，参考另一方向结构');
  if(target.targetType==='theme')return {action:'generateThemeAsset',...crossThemeRequest(p,{...state,instruction})};
  const source=p.concepts.find(c=>c.id===state.sourceTheme)?.representatives.find(r=>r.index===target.index),direction=p.concepts.find(c=>c.id===state.targetTheme),image=direction?.representatives.find(r=>r.index===target.index);
  if(!source||source.previewHash!==state.sourceHash||direction?.styleRegistrationId!==state.targetStyleId||(image?.previewHash??null)!==state.targetHash)throw Error('来源或目标预览已变化，请重新打开');
  return {action:'generateConceptPage',theme:state.targetTheme,index:target.index,force:true,instruction,crossStyleSource:{theme:state.sourceTheme,sourceHash:state.sourceHash},crossStyleTargetStyleId:state.targetStyleId,crossStyleTargetHash:state.targetHash};
}
