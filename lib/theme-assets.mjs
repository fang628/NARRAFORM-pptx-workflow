import {backgroundUsesForBrief} from './page-options.mjs';
import {rememberImage} from './image-history.mjs';
import {themeAssetPrompt,themeImagePromptVersion,themeAssetSubject,themeAssetSubjectRule,themeSubjectBriefGuidance} from './theme-image-prompts.mjs';
export {themeAssetPrompt} from './theme-image-prompts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {chat,parseJSON,generatedImage,visualModelConfig} from './provider.mjs';
import {runConcurrent,concurrencyLimit} from './concurrency.mjs';
import {reportTask} from './task-progress.mjs';
import {materialStamp,analysisCurrent} from './materials.mjs';
import {workflowLibraryVersion,workflowStyleContext,workflowDocument} from './workflow-library.mjs';
import {validateStyleDefinition,registerStyleDirections,requireStyleRegistration,registeredStyleContext,styleDefinitionSchema,describeStyle} from './style-registry.mjs';
import {themePlanningSchema,themePlanningPolicy,themeMaterialContext,validateThemePlanning} from './theme-planning.mjs';
import {presentationStylePolicyVersion} from './style-scope.mjs';
const digest=v=>crypto.createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
export const backgroundUses={'hero-image':'封面底图','toc-image':'目录底图','content-background':'内容页背景'};
export const themeAssetUses=p=>backgroundUsesForBrief(p.brief);
export const themeAssetsStamp=p=>digest({stylePolicy:presentationStylePolicyVersion,materials:materialStamp(p),analysis:analysisCurrent(p)?{summary:p.analysis.summary,outline:p.analysis.outline,notes:p.analysis.reviewNotes}:null,library:workflowLibraryVersion});
export const themeAssetsCurrent=p=>!!p.themeAssets&&p.themeAssets.stamp===themeAssetsStamp(p);
// Missing candidates are optional. Only images that exist must pass their own review.
export const themeAssetsReady=p=>themeAssetsCurrent(p)&&p.themeAssets.directions?.length===3&&p.themeAssets.directions.every(d=>themeAssetUses(p).every(use=>!d.assets?.[use]||d.assets[use].previewReview?.status==='passed'));
export const themeDirectionStyle=describeStyle;
const text=(v,key,max=2000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('三方向规划缺少有效的 '+key);return v.trim();};
export function validateThemeDirections(raw,p={},options={}){
  if(!Array.isArray(raw)||raw.length!==3)throw Error('底图规划必须返回 a/b/c 三个方向');
  return ['a','b','c'].map((id,i)=>{const r=raw[i];if(r?.id!==id)throw Error('底图规划的方向编号无效');
    return {id,...validateStyleDefinition(r,p),...(options.requirePlanning?validateThemePlanning(r,p):{}),...Object.fromEntries(['heroSubject','tocSubject','textArea'].map(k=>[k,text(r[k],k)])),...(r.contentSubject===undefined?{}:{contentSubject:text(r.contentSubject,'contentSubject')}),useContentBackground:true,assets:{}};
  });
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
  const answer=await chat(env.credentials.get(p.id).text,env.system,`更换单个底图方向：依据需求与材料，为方向 ${direction} 规划与原方向显著不同的新风格，随后会按新定义重新生成该方向全部底图。${themePlanningPolicy}工具界面风格不限制PPT。字段只写实际视觉选择；name用简短气质名，style用40–70字写配色，${themeSubjectBriefGuidance}主题对象使用短语，textArea按页型各一句位置与留白，不重复禁项或执行规范。只生成启用用途：${themeAssetUses(p).map(u=>backgroundUses[u]).join('、')}。每张底图都须有与主题相关的可辨识对象；封面与目录每张各自只能有一个明确且贴合主题的视觉主体，必须取自材料且明显可见；可搭配少量主题场景点缀，避免孤立，不形成竞争主体；简约或写实均可，主体须铺满预定视觉区的高度与宽度，不能缩成角落小物件或仅用纹理；内容页用低对比边角轮廓；封面、目录均启用时，各页从材料选一个明确对象，可用不同构图展示同一对象，未启用的对象字段填“不使用”，核心底色全组一致，文字区连续安静。输出 {direction:{${styleDefinitionSchema},${themePlanningSchema},heroSubject:"封面具体对象",tocSubject:"目录另一对象",contentSubject:"内容页具体主题元素",textArea:"文字预留位置"}}。\n用户要求：${instruction||'自动选择另一种适合材料与受众的风格'}\n指定参考：${referenceStyleId?JSON.stringify(reference?{id:reference.id,...reference.definition}:{id:referenceStyleId}):'只有完全符合主题的预设才必须采用；部分适合时可原创'}${referenceStyleId?'；referenceStyleId 必须使用这个编号':''}\n原方向：${JSON.stringify({...validateStyleDefinition(previous,p,{allowDeleted:true}),heroSubject:previous.heroSubject,tocSubject:previous.tocSubject,contentSubject:previous.contentSubject,textArea:previous.textArea})}\n其他方向：${JSON.stringify(p.themeAssets.directions.filter(d=>d.id!==direction).map(d=>validateStyleDefinition(d,p,{allowDeleted:true})))}\n需求：${JSON.stringify(p.brief)}\n材料理解：${JSON.stringify(p.analysis?{summary:p.analysis.summary,outline:p.analysis.outline,notes:p.analysis.reviewNotes}:null)}\n主体来源材料：${JSON.stringify(themeMaterialContext(p))}\n${workflowStyleContext()}`,signal);
  const raw=parseJSON(answer.text).direction,definition=validateStyleDefinition(raw,p),planning=validateThemePlanning(raw,p,{referenceStyleId});
  if(referenceStyleId&&definition.referenceStyleId!==referenceStyleId)throw Error('新风格未采用指定参考，请重试');
  const [next]=registerStyleDirections(p,[{id:direction,...definition,...planning,...Object.fromEntries(['heroSubject','tocSubject','textArea'].map(k=>[k,text(raw[k],k)])),...(raw.contentSubject===undefined?{}:{contentSubject:text(raw.contentSubject,'contentSubject')}),useContentBackground:previous.useContentBackground,assets:{}}],'theme-style-change');
  if(next.styleRegistrationId===previous.styleRegistrationId)throw Error('模型未提出新的风格，请补充修改要求后重试');
  if(signal.aborted)throw Error('任务已取消');
  const snapshot=structuredClone(previous);delete snapshot.revisionHistory;
  next.revisionHistory=[...(previous.revisionHistory||[]),{...snapshot,replacedAt:new Date().toISOString(),instruction,reason:'change-style'}];
  p.themeAssets.directions[index]=next;p.themeAssets.status='awaiting_confirmation';delete p.themeAssets.error;env.save(p);
  return next;
}
function cfg(env,p){const c=env.credentials.get(p.id);if(!c?.image?.key)throw Error('请配置通用生图 API，再生成三方向底图');if(!visualModelConfig(c))throw Error('底图检查需要支持视觉的主模型或选填视觉模型');return c;}
function persistRecord(p,env,r,status){
  const ledger=path.join(env.data,p.id,r.jobFile),job=JSON.parse(fs.readFileSync(ledger,'utf8'));
  fs.writeFileSync(ledger,JSON.stringify({...job,...(status?{status}:{}),record:r},null,2));env.save(p);
}
async function generateAsset(p,d,use,env,signal,fullPrompt,imageEdit){
  const prompt=imageEdit?.prompt||fullPrompt,editMeta=imageEdit?{imageEditMode:imageEdit.mode,redrawPrompt:imageEdit.redrawPrompt,parentSourceHash:imageEdit.target.sourceHash}:{};
  const references=imageEdit?.mode==='adjust'?[{file:imageEdit.target.sourceFile,sha256:imageEdit.target.sourceHash}]:[];
  requireStyleRegistration(p,d);
  const c=cfg(env,p),id=crypto.randomUUID(),folder=path.join(env.data,p.id,'theme-assets',p.themeAssets.id);fs.mkdirSync(folder,{recursive:true});fs.mkdirSync(path.join(env.data,p.id,'assets'),{recursive:true});
  const prefix=path.join(folder,id),source=prefix+'-provider.png',target=path.join(env.data,p.id,'assets',id+'.png'),ledger=prefix+'-job.json';
  const job={id,stage:'visual-foundations',styleId:d.id,styleRegistrationId:d.styleRegistrationId,intendedUse:use,subjectSources:d.subjectSources,styleSelection:d.styleSelection,prompt,promptVersion:themeImagePromptVersion,model:c.image.model,requestSize:'1920x1080',requiredAspect:'16:9',reference:references[0]||null,references,generationMode:references.length?'image-to-image':'text-to-image',...editMeta,status:'running',startedAt:new Date().toISOString()};fs.writeFileSync(ledger,JSON.stringify(job,null,2));
  try{
    const bytes=await generatedImage(c.image,prompt,signal,{size:'1920x1080',allowAutoSize:true,references:references.map(r=>({bytes:fs.readFileSync(path.join(env.data,p.id,r.file))})),onSizeFallback:size=>{job.actualRequestSize=size;fs.writeFileSync(ledger,JSON.stringify(job,null,2));}});fs.writeFileSync(source,bytes);
    job.source=path.relative(path.join(env.data,p.id),source);job.providerHash=digest(bytes);fs.writeFileSync(ledger,JSON.stringify(job,null,2));
    const python=process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    const dimensions=JSON.parse((await env.run(python,[path.join(env.root,'tools/visual_assets.py'),'normalize',source,target],{windowsHide:true,maxBuffer:200000,timeout:60000,signal})).stdout);
    const record={materialId:id,index:0,theme:d.id,styleRegistrationId:d.styleRegistrationId,intendedUse:use,stamp:p.themeAssets.stamp,file:path.relative(path.join(env.data,p.id),target),normalized:path.relative(path.join(env.data,p.id),target),source:job.source,jobFile:path.relative(path.join(env.data,p.id),ledger),previewHash:digest(fs.readFileSync(target)),providerHash:job.providerHash,prompt,promptVersion:themeImagePromptVersion,dimensions,reference:job.reference,references,generationMode:job.generationMode,...editMeta,model:c.image.model,at:new Date().toISOString(),previewReview:{status:'pending',issues:[]}};
    p.materials.push({id,file:id+'.png',name:d.name+' · '+backgroundUses[use],kind:'image',generated:true,purpose:'workflow-background',styleId:d.id,styleRegistrationId:d.styleRegistrationId,intendedUse:use,factualBoundary:'非事实主题视觉，仅供候选与风格参考；不替代原材料证据',prompt:fullPrompt,effectivePrompt:prompt,...editMeta,...(imageEdit?{parentImageId:imageEdit.target.sourceId}:{}),model:c.image.model,sha256:record.previewHash,size:fs.statSync(target).size,createdAt:record.at});
    fs.writeFileSync(ledger,JSON.stringify({...job,status:'generated',record},null,2));return record;
  }catch(e){fs.writeFileSync(ledger,JSON.stringify({...job,status:signal.aborted?'cancelled':'failed',error:String(e.message),finishedAt:new Date().toISOString()},null,2));throw e;}
}
async function reviewAsset(p,d,use,env,signal,r){
  try{
    const answer=await chat(visualModelConfig(cfg(env,p)),env.system,[{type:'text',text:`检查三方向底图：轻量检查当前${backgroundUses[use]}。主题：${p.brief.title}；主题对象：${themeAssetSubject(p,d,use)}；阅读区：${d.textArea}。${themeAssetSubjectRule(use)}。${use==='content-background'?'低对比边角轮廓可以，不要求大主体。':'主体须在分配的视觉区充分展开；不要求覆盖文字区或贴满整张画布，明显只剩微小角落图标或通用纹理视为主体缺失。一个整体的附属结构、低对比背景纹理不另计主体；少量主题场景、器物与环境点缀也不另计主体，不因有陪衬或主体不孤立而否决。'}只在${use==='content-background'?'':'存在多个竞争主体、拼贴或重复主视觉、'}主体明显并非材料对象、明显偏题或缺失符合用途的主题主体、阅读区被大面积遮挡、出现可读乱码或伪造事实图片/数据等严重问题时判不通过。配色差异、普通装饰、构图偏好仅建议，不否决。主体来源：${JSON.stringify(d.subjectSources?.[{'hero-image':'heroSubject','toc-image':'tocSubject','content-background':'contentSubject'}[use]]||null)}。仅依据登记来源和当前图检查对象身份，不推断分子细节或事实真实性；不核对底图是否齐全或跨图一致性。尺寸与比例已由程序检查。输出 {passed:true或false,issues:["严重问题，无则空数组"],notes:"一句看图依据"}。`},{type:'image_url',image_url:{url:'data:image/png;base64,'+fs.readFileSync(path.join(env.data,p.id,r.file)).toString('base64')}}],signal);
    const raw=parseJSON(answer.text);
    if(typeof raw.passed!=='boolean'||!Array.isArray(raw.issues)||typeof raw.notes!=='string'||!raw.notes.trim())throw Error('底图轻量检查未返回有效结论');
    const feedback=raw.issues.slice(0,4).map(v=>String(v).slice(0,600)),issues=raw.passed?[]:feedback.length?feedback:[raw.notes.slice(0,600)];
    r.review={...raw,mode:'lightweight'};r.previewReview={status:raw.passed?'passed':'needs_revision',mode:'lightweight',issues,...(raw.passed&&feedback.length?{suggestions:feedback}:{}),checkedAt:new Date().toISOString()};persistRecord(p,env,r,'done');
  }catch(e){r.previewReview={status:signal.aborted?'cancelled':'failed',issues:[String(e.message)]};persistRecord(p,env,r,signal.aborted?'cancelled':'failed');throw e;}
}
export async function planThemeAssets(p,env,signal,{force=false}={}){
  if(p.materials.some(m=>!m.generated)&&!analysisCurrent(p))throw Error('请先完成材料理解，再依据理解结果生成主题底图');
  if(!env.credentials.get(p.id)?.text?.key)throw Error('请配置主模型 API，再规划底图提示词');
  if(!themeAssetsCurrent(p)||force){
    p.themeAssets={id:crypto.randomUUID(),stamp:themeAssetsStamp(p),libraryVersion:workflowLibraryVersion,status:'planning',contentPlan:{title:p.brief.title,outline:p.slides.map(s=>({kind:s.kind,title:s.title,subtitle:s.subtitle,body:s.body})),materialOutline:p.analysis?.outline||[],factualBoundary:'已理解材料和逐页内容用于主题与用途规划，底图不承担事实证据'},directions:[]};env.save(p);
  }
  const set=p.themeAssets;
  delete set.error;
  try{
    if(!set.directions.length){
      const answer=await chat(env.credentials.get(p.id).text,env.system,`三方向底图规划：根据材料理解和预先保存的内容清单，选出三种贴合主题的视觉方向。每个方向仅为启用的用途生成：${themeAssetUses(p).map(u=>backgroundUses[u]).join('、')}，核心底色全组一致；未启用的封面或目录对象字段填“不使用”。每张底图均须规划可辨识且与材料主题相关的对象，不能仅用通用色块、网格或纹理。封面与目录每张各自只能有一个明确且贴合主题的视觉主体，必须取自材料且明显可见；可搭配少量主题场景点缀，避免孤立，不形成竞争主体；简约或写实均可；主体铺满预定视觉区的高度与宽度，不能缩成角落小物件；阅读区单独连续留白。内容页也必须有具体主题元素，低对比简化后放边角，保留正文阅读区。仅非事实主题视觉，不能伪造实验图片或数据。${themePlanningPolicy}原创时 referenceStyleId 填 null。完整风格定义将先自动登记，再开始生图。风格字段各写1–2个短句，只写实际视觉选择，不复述工作流、验收或其他字段。底图将采用约250–400字的单段提示词：name用简短气质名，style用40–70字只写配色及用途，${themeSubjectBriefGuidance}heroSubject/tocSubject/contentSubject各写一个简短对象与位置短语，textArea按封面/目录/内容页各一句位置与留白；不在这些字段重复比例、禁项与复杂度规则。参考风格可作题材适配，不强制照抄艺术字或光效，工具界面黑白黄不限制PPT。输出 {directions:[{id:"a|b|c（按a,b,c顺序）",${styleDefinitionSchema},${themePlanningSchema},heroSubject:"封面具体主题对象",tocSubject:"目录另一种具体主题对象",contentSubject:"内容页具体主题对象与边角位置",textArea:"根据预计文字体量描述标题与目录/正文预留位置，不写坐标"}]}。\n需求：${JSON.stringify(p.brief)}\n内容清单：${JSON.stringify(set.contentPlan)}\n已理解材料：${JSON.stringify(p.analysis?{summary:p.analysis.summary,readings:p.analysis.readings.map(r=>({summary:r.summary,keyPoints:r.keyPoints})),notes:p.analysis.reviewNotes}:null)}\n主体来源材料：${JSON.stringify(themeMaterialContext(p))}\n${workflowStyleContext()}\n${registeredStyleContext(p)}\n${workflowDocument('stages/12-content/steps/images.md')}`,signal);
      set.directions=validateThemeDirections(parseJSON(answer.text).directions,p,{requirePlanning:true});
    }
    set.directions=registerStyleDirections(p,set.directions,'theme-assets');env.save(p);
    stageThemePrompts(p);env.save(p);
    return set;
  }catch(e){set.status=signal.aborted?'cancelled':'failed';set.error=String(e.message).slice(0,2000);env.save(p);throw e;}
}
export function themePromptDraft(p,d,use){
  return d.promptDrafts?.[use]||{prompt:d.assets?.[use]?.redrawPrompt||d.assets?.[use]?.promptDraft||d.assets?.[use]?.prompt||themeAssetPrompt(p,d,use),revision:0,status:d.assets?.[use]?.previewReview?.status==='passed'?'generated':'pending'};
}
export function themePromptDrafts(p){
  return (p.themeAssets?.directions||[]).flatMap(d=>themeAssetUses(p).map(use=>({theme:d.id,use,...themePromptDraft(p,d,use)})));
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
    const reviewed=await runConcurrent(jobs.filter((_,i)=>generated[i].status==='fulfilled'),async({d,use})=>reviewAsset(p,d,use,env,signal,d.assets[use]),{signal,limit:concurrencyLimit(p.executionConcurrency),label:({d,use})=>'底图检查 · '+d.name+' · '+backgroundUses[use],settle:true});
    for(let i=0;i<jobs.length;i++){const {d,use}=jobs[i];d.promptDrafts[use].status=generated[i].status==='fulfilled'&&d.assets[use]?.previewReview?.status==='passed'?'generated':'pending';}
    const failed=[...generated,...reviewed].filter(r=>r.status==='rejected');
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
  const asset=use?d.assets?.[use]:null;return asset?.previewReview?.status==='passed'?asset:null;
}
export const themeUseForPage=(p,index)=>p.slides[index]?.kind==='cover'?'hero-image':p.slides[index]?.kind==='toc'?'toc-image':'content-background';
export function requireThemeAssetForPage(p,index,direction){
  const asset=themeAssetForPage(p,index,direction);
  if(!asset?.normalized)throw Error(`方向 ${String(direction).toUpperCase()} · 第 ${index+1} 页需要对应的${backgroundUses[themeUseForPage(p,index)]}，请在03底图区块确认风格与提示词、生成并检查后再生成预览`);
  return asset;
}
