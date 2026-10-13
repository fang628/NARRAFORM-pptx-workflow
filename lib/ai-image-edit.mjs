import {nestedContentList,nestedPromptStructureRule} from './prompt-structure.mjs';
import {specialLayoutDesignGuidance,specialLayoutImageGuidance} from './layout-guidance.mjs';
import {initialElements,orderedElements} from './elements.mjs';
import {chat,parseJSON} from './provider.mjs';
import {themeSubjectBriefGuidance} from './theme-image-prompts.mjs';

export function aiImageTarget(p,b){
  const type=b.targetType||(['generateConceptPage','generateFullPreview'].includes(b.action)?'visual':b.action==='generateThemeAsset'?'theme':'image');
  let image,key,request,prompt;
  if(type==='theme'){
    image=p.themeAssets?.directions?.find(d=>d.id===b.theme)?.assets?.[b.use];key=`theme:${b.theme}:${b.use}`;
    const draft=p.themeAssets?.directions?.find(d=>d.id===b.theme)?.promptDrafts?.[b.use];
    request={action:'generateThemeAsset',theme:b.theme,use:b.use,revision:draft?.revision||0,confirmed:true};prompt=image?.redrawPrompt||draft?.prompt||image?.prompt;
  }else if(type==='visual'){
    const index=Number(b.index),kind=b.kind|| (b.action==='generateConceptPage'?'concept':'full'),theme=kind==='concept'?b.theme:p.selectedTheme;
    image=kind==='concept'?p.concepts?.find(c=>c.id===theme)?.representatives?.find(r=>r.index===index):p.visualPages?.[index];key=`visual:${kind}:${theme}:${index}`;
    request={action:kind==='concept'?'generateConceptPage':'generateFullPreview',index,...(kind==='concept'?{theme}:{}),force:true};prompt=image?.redrawPrompt||image?.promptDraft||image?.prompt;
  }else if(type==='image'){
    image=p.materials.find(m=>m.id===b.sourceImageId&&m.generated&&m.kind==='image');key=`image:${b.index??'library'}:${b.sourceImageId}:${b.elementId||''}`;
    if(image&&b.index!==undefined&&b.index!==null){const s=p.slides[Number(b.index)],id=b.elementId?s?.elements?.find(n=>n.id===b.elementId)?.materialId:s?.imageId;if(id!==image.id)throw Error('当前图片已变化，请重新打开图片编辑器');}
    request={action:'image',index:b.index??null,sourceImageId:b.sourceImageId,elementId:b.elementId||null,allowUpload:true};prompt=image?.redrawPrompt||image?.prompt;
  }else throw Error('图片编辑类型无效');
  if(!image)throw Error('当前 AI 图片不存在，请先生成图片');
  return {type,key,image,request,prompt:prompt||'',sourceHash:image.previewHash||image.sha256,sourceFile:image.normalized||('assets/'+image.file),sourceId:image.materialId||image.id};
}

export function imageEditExecution(p,b){
  if(b.imageEditMode===undefined)return null;
  if(!['adjust','redraw'].includes(b.imageEditMode))throw Error('请选择图生图小修改或文生图重绘');
  const target=aiImageTarget(p,b);
  if(!b.sourceHash||b.sourceHash!==target.sourceHash)throw Error('图片已变化，请重新打开图片编辑器');
  if(b.imageEditMode==='redraw'){
    if(typeof b.prompt!=='string'||!b.prompt.trim()||b.prompt.length>30000)throw Error('请填写完整的重绘提示词');
    return {mode:'redraw',prompt:b.prompt,target,redrawPrompt:b.prompt};
  }
  if(typeof b.instruction!=='string'||!b.instruction.trim()||b.instruction.length>3000)throw Error('请填写 1–3000 字的修改意见');
  return {mode:'adjust',prompt:b.instruction,target,redrawPrompt:target.prompt};
}

export async function prepareAIImageEdit(p,b,env,signal){
  const target=aiImageTarget(p,b),instruction=String(b.instruction||'').trim();
  if(!instruction||instruction.length>3000)throw Error('请填写 1–3000 字的修改意见');
  const mode=b.imageEditMode;if(!['adjust','redraw'].includes(mode))throw Error('图片修改方式无效');
  if(b.sourceHash!==target.sourceHash)throw Error('图片已变化，请重新打开编辑器');
  const task=mode==='adjust'?'整理图生图局部调整意见。只输出 {instruction:"可直接发送给图片编辑模型的简短自然语言调整指令"}。只整理用户明确提出的调整，不扩写整页设计，不复述原始提示词、完整文案或未要求改变的布局，不虚构事实；必要时用一句话说明其余部分保持。':'按用户意见改写文生图完整提示词。只输出 {prompt:"可独立文生图重绘的完整最终提示词"}。保留未要求改变的内容与事实，吸收修改意见，不附旧稿、修改记录或额外说明。';
  const structure=mode==='redraw'&&target.type==='visual'?'\n'+nestedPromptStructureRule+'\n保留已确认布局；用户要求重新设计排版时，按以下依据选择：'+specialLayoutDesignGuidance+'最终提示词只在排版项简短说明实际选择，可参考：'+specialLayoutImageGuidance+'不要附加判断过程、全篇配额或验收条文。\n当前内容关系（依据，不作为新增上屏文案）：\n'+nestedContentList(orderedElements(initialElements(p.slides[Number(b.index)]))):'';
  const themeBrief=mode==='redraw'&&target.type==='theme'?'\n'+themeSubjectBriefGuidance:'';
  const concise='\n每项要求只写一次，同义表述合并；新意见替换对应旧要求，不追加旧稿或修订历史。完整文案只列在内容项，排版项按同一树层级引用节点名称或顺序，只写位置、承载与关系。不同节点即使文字相同也保留。';
  const answer=await chat(env.credentials.get(p.id)?.text,env.system,task+structure+themeBrief+concise+'\n用户修改意见：'+instruction+(mode==='redraw'?'\n当前完整提示词（数据）：'+String(b.prompt||target.prompt):''),signal);
  const raw=parseJSON(answer.text),value=mode==='adjust'?raw.instruction:raw.prompt;
  if(typeof value!=='string'||!value.trim()||value.length>(mode==='adjust'?3000:30000))throw Error('AI 未返回有效修改稿');
  signal.throwIfAborted();p.aiImageEditDrafts||={};const previous=p.aiImageEditDrafts[target.key];
  const draft={mode,sourceHash:target.sourceHash,revision:(previous?.revision||0)+1,previousText:mode==='adjust'?b.instruction:String(b.prompt||target.prompt),...(mode==='adjust'?{instruction:value.trim()}:{prompt:value}),at:new Date().toISOString()};
  p.aiImageEditDrafts[target.key]=draft;return {key:target.key,draft};
}
