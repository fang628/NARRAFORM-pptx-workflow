import {visualTreatmentText} from './visual-treatment.mjs';
import {promptColor,visualColors} from './prompt-colors.mjs';
import {themeAssetPrompt} from './theme-image-prompts.mjs';
import {imageStyle} from './image-prompts.mjs';
import {crossThemePrompt,crossPreviewPrompt} from '../public/theme-cross-model.js';

export const themeCrossStyleOptions=p=>(p.themeAssets?.directions||[]).map(d=>{
  const palette=(String(d.style||'').match(/#[\da-f]{6}\b/gi)||[]).join(' ')||d.style;
  const colors=[...new Set([promptColor(d.coreColor),...visualColors(palette)].map(c=>c.endsWith('色')?c:c+'色'))];
  return {id:d.id,name:d.name,styleId:d.styleRegistrationId,background:promptColor(d.coreColor),colors,rendering:visualTreatmentText(p.visualTreatment)};
});
export const previewCrossStyleOptions=p=>themeCrossStyleOptions({visualTreatment:p.visualTreatment,themeAssets:{directions:p.concepts||[]}});

export function crossPreviewEdit(p,b){
  if(!b.crossStyleSource)return null;
  if(b.imageEditMode!==undefined)throw Error('交叉修改不能同时提交其他图片修改模式');
  const index=Number(b.index),sourceDirection=p.concepts.find(d=>d.id===b.crossStyleSource.theme),direction=p.concepts.find(d=>d.id===b.theme);
  const source=sourceDirection?.representatives.find(r=>r.index===index),target=direction?.representatives.find(r=>r.index===index);
  if(!source?.normalized||sourceDirection.id===direction?.id||direction?.mode!=='ai')throw Error('请选择不同方向的同页预览与目标风格');
  if(source.previewHash!==b.crossStyleSource.sourceHash)throw Error('来源预览图已变化，请重新打开');
  if(direction.styleRegistrationId!==b.crossStyleTargetStyleId||(target?.previewHash??null)!==(b.crossStyleTargetHash??null))throw Error('目标风格或预览图已变化，请重新打开');
  if(typeof b.instruction!=='string'||b.instruction.trim().length>3000)throw Error('交叉修改意见最多3000字');
  const references=[{file:source.normalized,purpose:'cross-layout-source'}];
  if(target?.normalized)references.push({file:target.normalized,purpose:'cross-style-only'});
  const style=previewCrossStyleOptions(p).find(d=>d.id===direction.id);
  return {mode:'adjust',prompt:crossPreviewPrompt({...style,hasStyleReference:references.length>1,instruction:b.instruction}),references,
    target:{sourceFile:source.normalized,sourceHash:source.previewHash},redrawPrompt:String(source.redrawPrompt||source.prompt).replace(/^- \*\*风格要求\*\*：[\s\S]*?(?=^- \*\*|$)/gm,'- **风格要求**：'+imageStyle(direction,{visualTreatment:p.visualTreatment})+'。\n'),
    crossStyle:{sourceDirection:sourceDirection.id,sourceStamp:source.stamp,sourceHash:source.previewHash,targetDirection:direction.id,targetStyleId:direction.styleRegistrationId,targetPreviousHash:target?.previewHash??null,index}};
}

export function crossThemeEdit(p,b){
  if(!b.crossStyleSource)return null;
  if(b.imageEditMode!==undefined)throw Error('交叉修改不能同时提交其他图片修改模式');
  const sourceDirection=p.themeAssets?.directions.find(d=>d.id===b.crossStyleSource.theme);
  const direction=p.themeAssets?.directions.find(d=>d.id===b.theme);
  const source=sourceDirection?.assets?.[b.use],target=direction?.assets?.[b.use];
  if(!direction||!source||!source.normalized||sourceDirection.id===direction.id)throw Error('请选择不同方向的有效底图和目标风格');
  if(source.previewHash!==b.crossStyleSource.sourceHash)throw Error('结构来源图片已变化，请重新打开交叉修改');
  if(b.crossStyleTargetStyleId!==direction.styleRegistrationId||(b.crossStyleTargetHash??null)!==(target?.previewHash??null))throw Error('目标风格或底图已变化，请重新打开交叉修改');
  if(typeof b.instruction!=='string'||b.instruction.trim().length>3000)throw Error('交叉修改意见最多3000字');
  const references=[{file:source.normalized,sha256:source.previewHash,role:'structure'}];
  if(target?.normalized)references.push({file:target.normalized,sha256:target.previewHash,role:'style-only'});
  const prompt=crossThemePrompt({...themeCrossStyleOptions(p).find(d=>d.id===direction.id),hasStyleReference:references.length>1,instruction:b.instruction});
  const field={'hero-image':'heroSubject','toc-image':'tocSubject','content-background':'contentSubject'}[b.use];
  if(!field)throw Error('底图用途无效');
  return {mode:'adjust',prompt,references,...(source.photoReference?{photoReference:source.photoReference}:{}),target:{sourceHash:source.previewHash,sourceFile:source.normalized,sourceId:source.materialId},
    redrawPrompt:themeAssetPrompt(p,{...direction,[field]:sourceDirection[field],textArea:sourceDirection.textArea},b.use),
    crossStyle:{sourceDirection:sourceDirection.id,sourceHash:source.previewHash,targetDirection:direction.id,targetStyleId:direction.styleRegistrationId,targetPreviousHash:target?.previewHash??null}};
}
