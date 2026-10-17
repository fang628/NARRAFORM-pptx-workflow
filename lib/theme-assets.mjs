import {normalizeVisualTreatment,visualTreatmentContext} from './visual-treatment.mjs';
import {saveEditRegionReference} from './image-edit-region.mjs';
import {backgroundUsesForBrief} from './page-options.mjs';
import {rememberImage} from './image-history.mjs';
import {themeAssetPrompt,themeImagePromptVersion,themeAssetSubject,themeSubjectBriefGuidance,themePromptWritingRule,themeReadingArea} from './theme-image-prompts.mjs';
export {themeAssetPrompt} from './theme-image-prompts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {chat,parseJSON,generatedImage} from './provider.mjs';
import {runConcurrent,concurrencyLimit} from './concurrency.mjs';
import {reportTask} from './task-progress.mjs';
import {materialStamp,analysisCurrent} from './materials.mjs';
import {workflowLibraryVersion,workflowStyleContext} from './workflow-library.mjs';
import {validateStyleDefinition,registerStyleDirections,requireStyleRegistration,registeredStyleContext,styleDefinitionSchema,describeStyle} from './style-registry.mjs';
import {themePlanningSchema,themePlanningPolicy,themeMaterialContext,validateThemePlanning} from './theme-planning.mjs';
import {presentationStylePolicyVersion} from './style-scope.mjs';
import {themeDirectionConsistencyRule,harmonizeThemeDirections} from './theme-direction-consistency.mjs';
import {presetPageColor,presetPreservationRule,preserveReferencedDesign} from './preset-design.mjs';
import {imagePromptCheck} from './image-prompt-check.mjs';
const digest=v=>crypto.createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
export const backgroundUses={'hero-image':'封面底图','toc-image':'目录底图','content-background':'内容页背景'};
export const themeAssetUses=p=>backgroundUsesForBrief(p.brief);
export const themeAssetsStamp=p=>digest({stylePolicy:presentationStylePolicyVersion,materials:materialStamp(p),visualTreatment:p.visualTreatment||null,analysis:analysisCurrent(p)?{summary:p.analysis.summary,outline:p.analysis.outline,notes:p.analysis.reviewNotes}:null,library:workflowLibraryVersion});
export const themeAssetsCurrent=p=>!!p.themeAssets&&p.themeAssets.stamp===themeAssetsStamp(p);
// Missing candidates are optional. Only images that exist must pass their own review.
export const themeAssetAvailable=asset=>!!(asset?.normalized&&asset?.previewHash);
export const themeAssetsReady=p=>themeAssetsCurrent(p)&&p.themeAssets.directions?.length===3&&p.themeAssets.directions.every(d=>themeAssetUses(p).every(use=>!d.assets?.[use]||themeAssetAvailable(d.assets[use])));
export const themeDirectionStyle=describeStyle;
const text=(v,key,max=2000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('三方向规划缺少有效的 '+key);return v.trim();};
export function validateThemeDirections(raw,p={},options={}){
  if(!Array.isArray(raw)||raw.length!==3)throw Error('底图规划必须返回 a/b/c 三个方向');
  const directions=['a','b','c'].map((id,i)=>{const r=raw[i];if(r?.id!==id)throw Error('底图规划的方向编号无效');
    const visual=preserveReferencedDesign(r,p);
    return {id,...validateStyleDefinition(visual,p),...(visual.presetDesign?{presetDesign:visual.presetDesign}:{}),...(visual.paletteSource?{paletteSource:visual.paletteSource}:{}),...(options.requirePlanning?validateThemePlanning(r,p,options):{}),...Object.fromEntries(['heroSubject','tocSubject','textArea'].map(k=>[k,text(r[k],k)])),...(r.contentSubject===undefined?{}:{contentSubject:text(r.contentSubject,'contentSubject')}),useContentBackground:true,assets:{}};
  });
  return options.requirePlanning?harmonizeThemeDirections(directions,p):directions;
}
function validatePlanningOutput(value,p,options,{single=false,deferKnown=false}={}){
  try{
    if(single){const raw=value?.direction;validateStyleDefinition(raw?preserveReferencedDesign(raw,p):raw,p);validateThemePlanning(raw,p,options);for(const key of ['heroSubject','tocSubject','textArea'])text(raw[key],key);}
    else validateThemeDirections(value?.directions,p,options);
  }catch(error){if(!deferKnown||error.code!=='STYLE_PRESET_REQUIRED')throw error;}
  return value;
}
export async function prepareThemeDirection(p,env,signal,{direction,changeStyle=false,instruction='',referenceStyleId=null}){
  if(!env.credentials.get(p.id)?.text?.key)throw Error('请配置主模型 API，再规划底图提示词');
  if(!themeAssetsCurrent(p))throw Error('底图已过期，请先重新规划三种风格');
  const index=p.themeAssets.directions.findIndex(d=>d.id===direction),previous=p.themeAssets.directions[index];
  if(!previous)throw Error('底图方向不存在');
  requireStyleRegistration(p,previous);
  if(!changeStyle)return previous;
  reportTask(signal,{kind:'step',message:'为方向 '+direction.toUpperCase()+' 规划新风格，其他方向底图保留'});
  const reference=referenceStyleId?(p.styleRegistry||[]).find(r=>r.id===referenceStyleId):null;
  const answer=await chat(env.credentials.get(p.id).text,env.system,`更换单个底图方向：依据需求与材料，为方向 ${direction} 规划与原方向显著不同的新风格，随后会按新定义重新生成该方向全部底图。选择参考时原样复用所选风格定义；原创时新主色避开其他方向。${themePlanningPolicy}${visualTreatmentContext(p)}${themeDirectionConsistencyRule}字段只写实际视觉选择；name用简短气质名，style用40–70字写配色，${themeSubjectBriefGuidance}艺术意象使用短语，textArea按页型各一句位置与留白，不重复禁项或执行规范。只生成启用用途：${themeAssetUses(p).map(u=>backgroundUses[u]).join('、')}。文字预留区须连续安静，主体位置与之避让。输出 {direction:{${styleDefinitionSchema},${themePlanningSchema},heroSubject:"符合主题、贯穿全材料的封面艺术意象与形态",tocSubject:"代表全篇主线的目录艺术意象，主体、形态或效果至少一项与封面不同",contentSubject:"呼应全篇主题的边角艺术图形",textArea:"文字预留位置"}}。\n用户要求：${instruction||'自动选择另一种适合材料与受众的风格'}\n指定参考：${referenceStyleId?JSON.stringify(reference?{id:reference.id,...reference.definition}:{id:referenceStyleId}):'符合主题的预设必须采用；均不适合时才原创'}${referenceStyleId?'；referenceStyleId 必须使用这个编号':''}\n原方向：${JSON.stringify({...validateStyleDefinition(previous,p,{allowDeleted:true}),heroSubject:previous.heroSubject,tocSubject:previous.tocSubject,contentSubject:previous.contentSubject,textArea:previous.textArea})}\n其他方向：${JSON.stringify(p.themeAssets.directions.filter(d=>d.id!==direction).map(d=>validateStyleDefinition(d,p,{allowDeleted:true})))}\n需求：${JSON.stringify(p.brief)}\n材料理解：${JSON.stringify(p.analysis?{summary:p.analysis.summary,outline:p.analysis.outline,notes:p.analysis.reviewNotes}:null)}\n主题灵感材料：${JSON.stringify(themeMaterialContext(p))}\n全篇内容：${JSON.stringify({title:p.brief.title,summary:p.analysis?.summary,outline:p.analysis?.outline,slides:(p.slides||[]).map(s=>({kind:s.kind,title:s.title,subtitle:s.subtitle,elements:s.elements,body:s.body}))})}\n${workflowStyleContext({catalogOnly:true})}`,signal,{validate:value=>validatePlanningOutput(value,p,{referenceStyleId},{single:true,deferKnown:true})});
  const raw=parseJSON(answer.text).direction,definition=validateStyleDefinition(preserveReferencedDesign(raw,p),p),planning=validateThemePlanning(raw,p,{referenceStyleId});
  if(referenceStyleId&&definition.referenceStyleId!==referenceStyleId)throw Error('新风格未采用指定参考，请重试');
  const others=p.themeAssets.directions.filter(d=>d.id!==direction);
  const updated=harmonizeThemeDirections([{id:direction,...definition,...planning,...Object.fromEntries(['heroSubject','tocSubject','textArea'].map(k=>[k,text(raw[k],k)])),...(raw.contentSubject===undefined?{}:{contentSubject:text(raw.contentSubject,'contentSubject')}),useContentBackground:previous.useContentBackground,assets:{}}],p,{reservedColors:others.map(d=>d.coreColor),previousColor:previous.coreColor});
  const [next]=registerStyleDirections(p,updated,'theme-style-change');
  if(next.styleRegistrationId===previous.styleRegistrationId){if(referenceStyleId)return previous;throw Error('模型未提出新的风格，请补充修改要求后重试');}
  if(signal.aborted)throw Error('任务已取消');
  const snapshot=structuredClone(previous);delete snapshot.revisionHistory;
  next.revisionHistory=[...(previous.revisionHistory||[]),{...snapshot,replacedAt:new Date().toISOString(),instruction,reason:'change-style'}];
  p.themeAssets.directions[index]=next;p.themeAssets.status='awaiting_confirmation';delete p.themeAssets.error;env.save(p);
  return next;
}
function cfg(env,p){const c=env.credentials.get(p.id);if(!c?.image?.key)throw Error('请配置通用生图 API，再生成三方向底图');return c;}
async function generateAsset(p,d,use,env,signal,fullPrompt,imageEdit){
  let prompt=imageEdit?.prompt||fullPrompt;const editMeta=imageEdit?{...(imageEdit.region?{editRegion:imageEdit.region}:{}),imageEditMode:imageEdit.mode,redrawPrompt:imageEdit.redrawPrompt,parentSourceHash:imageEdit.target.sourceHash,...(imageEdit.crossStyle?{crossStyle:imageEdit.crossStyle}:{})}:{};
  const references=imageEdit?.references||(imageEdit?.mode==='adjust'?[{file:imageEdit.target.sourceFile,sha256:imageEdit.target.sourceHash}]:[]);
  if(imageEdit?.crossStyle)for(const reference of references){
    const file=path.join(env.data,p.id,reference.file);
    if(!fs.existsSync(file)||digest(fs.readFileSync(file))!==reference.sha256)throw Error('交叉修改参考图片文件已变化，请重新核对');
  }
  const structureDirection=imageEdit?.crossStyle?p.themeAssets.directions.find(item=>item.id===imageEdit.crossStyle.sourceDirection):d;
  requireStyleRegistration(p,d);
  const c=cfg(env,p),id=crypto.randomUUID(),folder=path.join(env.data,p.id,'theme-assets',p.themeAssets.id);fs.mkdirSync(folder,{recursive:true});fs.mkdirSync(path.join(env.data,p.id,'assets'),{recursive:true});
  const prefix=path.join(folder,id),source=prefix+'-provider.png',target=path.join(env.data,p.id,'assets',id+'.png'),ledger=prefix+'-job.json';
  const regionReference=saveEditRegionReference(p,imageEdit,env,prefix+'-region-hint.png');if(regionReference)references.push(regionReference);
  const job={id,stage:'visual-foundations',styleId:d.id,styleRegistrationId:d.styleRegistrationId,intendedUse:use,subjectSources:d.subjectSources,styleSelection:d.styleSelection,prompt,promptVersion:themeImagePromptVersion,model:c.image.model,requestSize:'1920x1080',requiredAspect:'16:9',reference:references[0]||null,references,generationMode:references.length?'image-to-image':'text-to-image',...editMeta,status:'running',startedAt:new Date().toISOString()};fs.writeFileSync(ledger,JSON.stringify(job,null,2));
  try{
    const bytes=await generatedImage(c.image,prompt,signal,{size:'1920x1080',allowAutoSize:true,checkPrompt:imagePromptCheck({config:c.text,system:env.system,stage:'单张底图',mode:imageEdit?.mode==='adjust'?'adjust':'generate',context:{title:p.brief.title,visualTreatment:p.visualTreatment,use,...(imageEdit?.region?{editRegion:imageEdit.region}:{}),coreColor:presetPageColor(d,use),uniformBackgroundColor:d.coreColor,subject:themeAssetSubject(p,structureDirection,use),subjectSource:structureDirection.subjectSources?.[{'hero-image':'heroSubject','toc-image':'tocSubject','content-background':'contentSubject'}[use]],textArea:themeReadingArea(structureDirection,use),noVisibleText:true}},signal),onPromptChecked:check=>{prompt=check.prompt;if(imageEdit?.mode!=='adjust'){fullPrompt=prompt;if(imageEdit)editMeta.redrawPrompt=prompt;if(d.promptDrafts?.[use])d.promptDrafts[use].prompt=prompt;}job.prompt=prompt;job.promptCheck={...check,prompt:undefined};fs.writeFileSync(ledger,JSON.stringify(job,null,2));},references:references.map(r=>({bytes:fs.readFileSync(path.join(env.data,p.id,r.file))})),onSizeFallback:size=>{job.actualRequestSize=size;fs.writeFileSync(ledger,JSON.stringify(job,null,2));}});fs.writeFileSync(source,bytes);
    job.source=path.relative(path.join(env.data,p.id),source);job.providerHash=digest(bytes);fs.writeFileSync(ledger,JSON.stringify(job,null,2));
    const python=process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    const dimensions=JSON.parse((await env.run(python,[path.join(env.root,'tools/visual_assets.py'),'normalize',source,target],{windowsHide:true,maxBuffer:200000,timeout:60000,signal})).stdout);
    const record={materialId:id,index:0,theme:d.id,styleRegistrationId:d.styleRegistrationId,intendedUse:use,stamp:p.themeAssets.stamp,file:path.relative(path.join(env.data,p.id),target),normalized:path.relative(path.join(env.data,p.id),target),source:job.source,jobFile:path.relative(path.join(env.data,p.id),ledger),previewHash:digest(fs.readFileSync(target)),providerHash:job.providerHash,prompt,promptCheck:job.promptCheck,promptVersion:themeImagePromptVersion,dimensions,coreColor:presetPageColor(d,use),reference:job.reference,references,generationMode:job.generationMode,...editMeta,model:c.image.model,at:new Date().toISOString(),previewReview:{status:'not_required',mode:'none',issues:[]}};
    p.materials.push({id,file:id+'.png',name:d.name+' · '+backgroundUses[use],kind:'image',generated:true,purpose:'workflow-background',styleId:d.id,styleRegistrationId:d.styleRegistrationId,intendedUse:use,factualBoundary:'非事实主题视觉，仅供候选与风格参考；不替代原材料证据',prompt:fullPrompt,effectivePrompt:prompt,...editMeta,...(imageEdit?{parentImageId:imageEdit.target.sourceId}:{}),model:c.image.model,sha256:record.previewHash,size:fs.statSync(target).size,createdAt:record.at});
    fs.writeFileSync(ledger,JSON.stringify({...job,status:'generated',record},null,2));return record;
  }catch(e){fs.writeFileSync(ledger,JSON.stringify({...job,status:signal.aborted?'cancelled':'failed',error:String(e.message),finishedAt:new Date().toISOString()},null,2));throw e;}
}
const themeVisualKey=d=>JSON.stringify(['style','coreColor','typography','frames','decoration','layoutLanguage'].map(k=>k==='coreColor'?d[k]?.toUpperCase():d[k]));
export const freshThemeDirections=(previous,next)=>next.every(d=>!previous.some(old=>themeVisualKey(old)===themeVisualKey(d)));
export async function planThemeAssets(p,env,signal,{force=false,previousDirections=[],visualTreatment}={}){
  if(visualTreatment!==undefined){const selected=normalizeVisualTreatment(visualTreatment);force=force||p.visualTreatment!==selected;p.visualTreatment=selected;}
  if(p.materials.some(m=>!m.generated)&&!analysisCurrent(p))throw Error('请先完成材料理解，再依据理解结果生成主题底图');
  if(!env.credentials.get(p.id)?.text?.key)throw Error('请配置主模型 API，再规划底图提示词');
  if(!themeAssetsCurrent(p)||force){
    p.themeAssets={id:crypto.randomUUID(),stamp:themeAssetsStamp(p),libraryVersion:workflowLibraryVersion,status:'planning',contentPlan:{title:p.brief.title,outline:p.slides.map(s=>({kind:s.kind,title:s.title,subtitle:s.subtitle,body:s.body})),materialOutline:p.analysis?.outline||[],factualBoundary:'已理解材料和逐页内容用于主题与用途规划，底图不承担事实证据'},directions:[]};env.save(p);
  }
  const set=p.themeAssets;
  delete set.error;
  try{
    if(!set.directions.length){
      const validation={requirePlanning:true};
      const answer=await chat(env.credentials.get(p.id).text,env.system,`三方向底图规划：根据材料理解和预先保存的内容清单，选出三种贴合主题的视觉方向。每个方向仅为启用的用途生成：${themeAssetUses(p).map(u=>backgroundUses[u]).join('、')}，未启用的封面或目录对象字段填“不使用”。内容页主题元素以低对比简化轮廓置于边角；文字预留区连续安静，主体位置与之避让。${themePlanningPolicy}${visualTreatmentContext(p)}${themeDirectionConsistencyRule}原创时 referenceStyleId 填 null。预设直接引用库中原定义，不额外登记；原创风格登记后再开始生图。风格字段各写1–2个短句，只写实际视觉选择，不复述工作流、验收或其他字段。${themePromptWritingRule}底图字段：name用简短气质名，style用40–70字只写配色及用途，${themeSubjectBriefGuidance}heroSubject/tocSubject/contentSubject分别写简短艺术意象、形态或视觉效果及位置，textArea按封面/目录/内容页各一句位置与留白；不在这些字段重复比例、禁项与复杂度规则。${presetPreservationRule}输出 {directions:[{id:"a|b|c（按a,b,c顺序）",${styleDefinitionSchema},${themePlanningSchema},heroSubject:"符合主题、贯穿全材料的封面艺术意象与形态",tocSubject:"代表全篇主线的目录艺术意象，主体、形态或效果至少一项与封面不同",contentSubject:"呼应全篇主题的艺术图形与边角位置",textArea:"根据预计文字体量描述标题与目录/正文预留位置，不写坐标"}]}。${previousDirections.length?'\n本次为整组重生成：三个方向均须重新选择视觉风格并生成新提示词，不仅润色旧稿、改名称或调换顺序；每个方向须与原组三方向有实际视觉差异。符合主题的预设仍必须采用，可重新选择适合主题的其他预设，不能改写所选预设原设计；以全篇材料共同主线选择艺术意象，不锁定旧主体；每个方向的封面与目录在主体、形态或视觉效果上至少一项不同。原三方向（需要替换）：'+JSON.stringify(previousDirections.map(d=>({...validateStyleDefinition(d,p,{allowDeleted:true}),heroSubject:d.heroSubject,tocSubject:d.tocSubject,contentSubject:d.contentSubject,subjectSources:d.subjectSources}))) :''}\n需求：${JSON.stringify(p.brief)}\n内容清单：${JSON.stringify(set.contentPlan)}\n已理解材料：${JSON.stringify(p.analysis?{summary:p.analysis.summary,readings:p.analysis.readings.map(r=>({summary:r.summary,keyPoints:r.keyPoints})),notes:p.analysis.reviewNotes}:null)}\n主题灵感材料：${JSON.stringify(themeMaterialContext(p))}\n全篇内容：${JSON.stringify({title:p.brief.title,summary:p.analysis?.summary,outline:p.analysis?.outline,slides:(p.slides||[]).map(s=>({kind:s.kind,title:s.title,subtitle:s.subtitle,elements:s.elements,body:s.body}))})}\n${workflowStyleContext({catalogOnly:true})}\n${registeredStyleContext(p)}`,signal,{validate:value=>validatePlanningOutput(value,p,validation,{deferKnown:true})});
      let raw=parseJSON(answer.text).directions;
      try{set.directions=validateThemeDirections(raw,p,validation);}
      catch(error){
        if(error.code!=='STYLE_PRESET_REQUIRED'||signal.aborted)throw error;
        reportTask(signal,{kind:'step',message:'已有贴合主题的预设，正在修正选型并保留艺术意象与配色要求'});
        const corrected=await chat(env.credentials.get(p.id).text,env.system,`修正底图预设选型：采用适配预设或单独借用适合的预设配色，保留艺术意象与全篇主线。${themePlanningPolicy}${visualTreatmentContext(p)}${themeDirectionConsistencyRule}输出 {directions:[三个完整方向]}。\n原规划（数据）：${JSON.stringify(raw)}\n主题灵感材料：${JSON.stringify(themeMaterialContext(p))}\n全篇内容：${JSON.stringify({title:p.brief.title,summary:p.analysis?.summary,outline:p.analysis?.outline,slides:(p.slides||[]).map(s=>({kind:s.kind,title:s.title,subtitle:s.subtitle,elements:s.elements,body:s.body}))})}\n需求：${JSON.stringify(p.brief)}\n${workflowStyleContext({catalogOnly:true})}`,signal,{validate:value=>validatePlanningOutput(value,p,validation)});
        raw=parseJSON(corrected.text).directions;set.directions=validateThemeDirections(raw,p,validation);
      }
      if(previousDirections.length&&!freshThemeDirections(previousDirections,set.directions)){
        reportTask(signal,{kind:'step',message:'部分方向沿用了旧风格，正在重新选择整组三方向'});
        const corrected=await chat(env.credentials.get(p.id).text,env.system,`重新选择三方向底图风格：当前方案仍沿用旧风格。为 A/B/C 分别设计不同于原整组三方向的新视觉定义，不仅改名称、描述或排列顺序。符合主题的预设仍必须采用，须选择其他适合主题的预设并原样复用其设计，原创风格才允许重新设计。${themeDirectionConsistencyRule}${themePlanningPolicy}${visualTreatmentContext(p)}保留全篇主题主线，允许艺术主体、形态或效果变化，封面与目录保持差异。输出 {directions:[三个完整方向，字段沿用当前方案]}。\n原三方向：${JSON.stringify(previousDirections.map(d=>({...validateStyleDefinition(d,p,{allowDeleted:true}),heroSubject:d.heroSubject,tocSubject:d.tocSubject,contentSubject:d.contentSubject,subjectSources:d.subjectSources})))}\n当前方案：${JSON.stringify(raw)}\n需求：${JSON.stringify(p.brief)}\n${workflowStyleContext({catalogOnly:true})}`,signal,{validate:value=>validatePlanningOutput(value,p,validation)});
        set.directions=validateThemeDirections(parseJSON(corrected.text).directions,p,validation);
        if(!freshThemeDirections(previousDirections,set.directions))throw Error('模型仍返回原有风格，已保留旧风格、提示词和底图，请重试');
      }
    }
    set.directions=registerStyleDirections(p,set.directions,'theme-assets');env.save(p);
    stageThemePrompts(p);env.save(p);
    return set;
  }catch(e){set.status=signal.aborted?'cancelled':'failed';set.error=String(e.message).slice(0,2000);env.save(p);throw e;}
}
export function themePromptDraft(p,d,use){
  return d.promptDrafts?.[use]||{prompt:d.assets?.[use]?.redrawPrompt||d.assets?.[use]?.promptDraft||d.assets?.[use]?.prompt||themeAssetPrompt(p,d,use),revision:0,status:themeAssetAvailable(d.assets?.[use])?'generated':'pending'};
}
export function themePromptDrafts(p){
  return (p.themeAssets?.directions||[]).flatMap(d=>themeAssetUses(p).map(use=>({theme:d.id,use,...themePromptDraft(p,d,use)})));
}
export async function regenerateThemePrompts(p,env,signal,{visualTreatment}={}){
  if(!themeAssetsCurrent(p)||p.themeAssets.directions.length!==3)throw Error('请先规划当前需求的三方向风格');
  const selected=visualTreatment===undefined?p.visualTreatment:normalizeVisualTreatment(visualTreatment),changed=selected!==p.visualTreatment;
  const previous=structuredClone(p.themeAssets),candidate={...p,visualTreatment:selected,themeAssets:null,styleRegistry:structuredClone(p.styleRegistry||[])};
  // Isolate mutable planning fields; large source documents remain read-only references.
  await planThemeAssets(candidate,{...env,save(){}},signal,{force:true,previousDirections:changed?[]:previous.directions});
  if(signal.aborted)throw Error('任务已取消');
  for(const d of candidate.themeAssets.directions){
    const old=previous.directions.find(old=>old.id===d.id),snapshot=structuredClone(old);delete snapshot.revisionHistory;
    d.revisionHistory=[...(old.revisionHistory||[]),{...snapshot,replacedAt:new Date().toISOString(),reason:changed?'change-visual-treatment':'regenerate-all-styles',visualTreatment:p.visualTreatment||null}];
    for(const use of themeAssetUses(candidate)){
      const draft=themePromptDraft(p,old,use);
      d.promptDrafts[use].revision=draft.revision+1;d.promptDrafts[use].previousPrompt=draft.prompt;
    }
  }
  p.visualTreatment=candidate.visualTreatment;p.styleRegistry=candidate.styleRegistry;p.themeAssets=candidate.themeAssets;env.save(p);
}
export function stageThemePrompts(p,direction){
  for(const d of p.themeAssets.directions.filter(d=>!direction||d.id===direction)){
    d.promptDrafts||={};
    for(const use of themeAssetUses(p)){
      const old=themePromptDraft(p,d,use);
      d.promptDrafts[use]={prompt:old.prompt,revision:old.revision+1,status:'pending',updatedAt:new Date().toISOString()};
    }
  }
  p.themeAssets.status='awaiting_confirmation';
}
export function validateThemePromptSubmission(p,submissions,confirmed){
  if(!themeAssetsCurrent(p))throw Error('材料或需求已变化，请重新规划底图提示词');
  if(confirmed!==true)throw Error('请先核对并确认底图提示词');
  if(!Array.isArray(submissions)||!submissions.length||submissions.length>9)throw Error('请选择要确认生成的底图提示词');
  const seen=new Set();
  return submissions.map(entry=>{
    const d=p.themeAssets.directions.find(d=>d.id===entry?.theme),key=entry?.theme+':'+entry?.use;
    if(!d||!themeAssetUses(p).includes(entry?.use)||seen.has(key))throw Error('底图方向或用途无效或重复');
    seen.add(key);
    if(typeof entry.prompt!=='string'||entry.prompt.trim().length<=10||entry.prompt.length>30000)throw Error('底图提示词须为 10–30000 字');
    if(entry.revision!==themePromptDraft(p,d,entry.use).revision)throw Error('底图提示词已更新，请重新打开并核对后确认');
    return {d,use:entry.use,prompt:entry.prompt,revision:entry.revision};
  });
}
export async function generateThemeAssets(p,env,signal,{prompts,confirmed,imageEdit}={}){
  const jobs=validateThemePromptSubmission(p,prompts,confirmed),set=p.themeAssets;
  cfg(env,p);
  for(const {d,use,prompt,revision} of jobs){d.promptDrafts||={};d.promptDrafts[use]={prompt,revision,status:'generating',confirmedAt:new Date().toISOString()};}
  set.status='generating';delete set.error;env.save(p);
  try{
    const generated=await runConcurrent(jobs,async({d,use,prompt})=>{
      const old=d.assets[use],next=await generateAsset(p,d,use,env,signal,prompt,imageEdit);
      if(old){const previous=structuredClone(old);delete previous.repairHistory;delete previous.autoRepair;next.repairHistory=[...(old.repairHistory||[]),previous];}
      d.assets[use]=rememberImage(old,next);env.save(p);
    },{signal,limit:concurrencyLimit(p.executionConcurrency),label:({d,use})=>'底图 · '+d.name+' · '+backgroundUses[use],settle:true});
    for(let i=0;i<jobs.length;i++){const {d,use}=jobs[i];d.promptDrafts[use].status=generated[i].status==='fulfilled'?'generated':'pending';}
    const failed=generated.filter(r=>r.status==='rejected');
    set.status=themePromptDrafts(p).some(d=>d.status!=='generated')?'awaiting_confirmation':themeAssetsReady(p)?'ready':'needs_revision';
    set.errors=failed.map(r=>r.reason.message);env.save(p);
    if(failed.length)throw Error('底图请求失败，已保留完成图片与提示词，请核对后重试：'+set.errors.join('；'));
    return set;
  }catch(e){
    for(const {d,use} of jobs)if(d.promptDrafts[use].status==='generating')d.promptDrafts[use].status='pending';
    set.status=signal.aborted?'cancelled':'awaiting_confirmation';set.error=String(e.message).slice(0,2000);env.save(p);throw e;
  }
}
export function themeAssetForPage(p,index,direction){
  if(!themeAssetsCurrent(p))return null;const d=p.themeAssets.directions.find(d=>d.id===direction);if(!d)return null;
  const use=themeUseForPage(p,index);
  const asset=use?d.assets?.[use]:null;return themeAssetAvailable(asset)?asset:null;
}
export const themeUseForPage=(p,index)=>p.slides[index]?.kind==='cover'?'hero-image':p.slides[index]?.kind==='toc'?'toc-image':'content-background';
export function requireThemeAssetForPage(p,index,direction){
  const asset=themeAssetForPage(p,index,direction);
  if(!asset?.normalized)throw Error(`方向 ${String(direction).toUpperCase()} · 第 ${index+1} 页需要对应的${backgroundUses[themeUseForPage(p,index)]}，请在03底图区块确认风格与提示词、生成后点击生成三版预览`);
  return asset;
}
