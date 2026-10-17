import {normalizeVisualTreatment,visualTreatmentContext} from './visual-treatment.mjs';
import {saveEditRegionReference} from './image-edit-region.mjs';
import {reviewPreviewImage,previewReviewRepairLimit} from './preview-review.mjs';
import {textFieldValidator} from './text-retry.mjs';
import {contextualError} from './errors.mjs';
import {promptColorRule,promptColor,simplifyPromptColors} from './prompt-colors.mjs';
import {lightweightReviewRule} from './lightweight-review.mjs';
import {placeholderAspectRewriteRule} from './image-placeholder-rules.mjs';
import {rebuildAppearanceRule,rebuildNumberRule,rebuildHeadingBodyRule} from './rebuild-text-parts.mjs';
import {rebuildMethodRule} from './rebuild-methods.mjs';
import {extractionScope} from './rebuild-region.mjs';
import {rememberRebuildEdit,rebuildUndoState,undoRebuildEdit} from './rebuild-undo.mjs';
import {visualColorRule} from './visual-color.mjs';
import {visualTextStyleRule} from './visual-text-style.mjs';
import {auditedElements,auditRepairLimit} from './visual-audit-repair.mjs';
import {repairRebuiltPage} from './rebuild-tools.mjs';
import {rebuildReviewLoop,rebuildVisualRepairLimit} from './rebuild-review-loop.mjs';
import {reviewRenderedPage,renderReviewSchema,renderReviewRepairLimit} from './render-review.mjs';
import {startRebuildLive,publishRebuildPage,rebuildLiveCurrent,draftDownloadState,draftReviewReport,publishRebuildAssets,rebuildAssetInventory,rebuildAssetImage,liveRebuildComparison} from './rebuild-output.mjs';
import {previewApprovalState,previewApprovalRecord} from './preview-approval.mjs';
import {nestedPromptStructureRule,slidePromptConcisenessRule} from './prompt-structure.mjs';
import {creativePromptWritingRule} from './layout-guidance.mjs';
import {imageEditExecution,aiImageTarget} from './ai-image-edit.mjs';
import {crossThemeEdit,themeCrossStyleOptions,crossPreviewEdit,previewCrossStyleOptions} from './theme-cross-edit.mjs';
import {rememberImage,restoreImage} from './image-history.mjs';
import {slideImagePrompt,effectiveSlideImagePrompt,imagePromptVersion,backgroundUse} from './slide-image-prompts.mjs';
import {presetPageColor} from './preset-design.mjs';
import {themeAssetSubjectRule,themeSubjectBriefGuidance,themePromptWritingRuleFor,singleImagePromptRule,validateSingleThemePrompt} from './theme-image-prompts.mjs';
import {validateStyleDefinition,registerStyleDirections,requireStyleRegistration,registeredStyleContext,describeStyle,deleteRegisteredStyle} from './style-registry.mjs';
import {runConcurrent,concurrencyLimit} from './concurrency.mjs';
import {reviewAndRepair,visualRepairLimit} from './visual-repair.mjs';
import {repairPlaceholders,placeholderCorrectionPrompt,placeholderRepairLimit,placeholderRatioTolerance,placeholderCountReport,placeholderCountRepairLimit} from './placeholder-review.mjs';
import {reportTask} from './task-progress.mjs';
import {themeAssetsCurrent,themeAssetsReady,requireThemeAssetForPage,generateThemeAssets,prepareThemeDirection,planThemeAssets,regenerateThemePrompts,stageThemePrompts,themePromptDraft,themePromptDrafts,validateThemePromptSubmission} from './theme-assets.mjs';
import {imagePromptCheck} from './image-prompt-check.mjs';
import {themeMaterialContext} from './theme-planning.mjs';
import {workflowLibrarySummary} from './workflow-library.mjs';
import {analysisCurrent} from './materials.mjs';
import {designRulesFor,applicableDesignChecks,designCheckSchema,designAcceptance} from './design-rules.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Resvg} from '@resvg/resvg-js';
import {chat,parseJSON,generatedImage,visualModelConfig} from './provider.mjs';
import {pageDesignState} from './page-design.mjs';
import {themes} from './scene.mjs';
import {confirmedPages,pageStamp,fullPageCurrent,visualStamp,rebuiltCurrent,releaseCurrent,canonicalTexts,plannedImages,validateImagePlan,validateAudit,nativeSVG,digest} from './visual-model.mjs';
import {buildVisualDeck} from './visual-build.mjs';
import {slideBackground} from './slide-background.mjs';
import JSZip from 'jszip';
import {analyzeVisual} from './visual-analysis.mjs';
import {optimizeTextLayout} from './text-layout.mjs';
import {refinePlaceholderGeometry} from './placeholder-geometry.mjs';
import {fittedImagePlans,imageMayStretch,repositionedImagePlans} from './image-geometry.mjs';
import {originalImagePlacementRule} from './image-placement-policy.mjs';
import {plannedImageGeometry,imagePlanningContext,prepareImageReadability} from './image-space-budget.mjs';

const actionNames=new Set(['undoRebuildEdit','reviseRebuildElement','extractRebuildRegion','reviseRebuildAssets','deleteRegisteredStyle','restoreAIImage','generateThemeAssets','generateThemeAsset','regenerateThemeDirection','regenerateThemePrompts','changeThemeDirection','rewriteThemeAssetPrompt','setThemeBackgroundUse','concepts','selectTheme','generateFullPreview','generateConceptPage','checkVisualPage','reviewPreviewPage','approvePreview','reconstructPreview','discardReconstruction','build','reviewReleasePage','release','rewriteVisualPrompt','saveVisualPrompt']);
const checkNames=['visual','content','photos','editability','preview_match'];
const mime=file=>file.endsWith('.svg')?'image/svg+xml':file.endsWith('.jpg')?'image/jpeg':'image/png';
const dataURL=file=>'data:'+mime(file)+';base64,'+fs.readFileSync(file).toString('base64');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fileHash=file=>digest(fs.readFileSync(file));
const safeName=n=>/^[a-zA-Z0-9_.-]+$/.test(n);
function imageConfig(env,p){const cfg=env.credentials.get(p.id)?.image;if(!cfg?.key)throw Error('请先配置通用生图 API，三版方案和全篇预览均由该模型生成');return cfg;}
function rebuildConfig(env,p){const cfg=visualModelConfig(env.credentials.get(p.id));if(!cfg)throw Error('请配置支持图片输入的主模型，或选填独立高性能视觉模型');return cfg;}
function python(env){const v=path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');return process.env.PPT_AGENT_PYTHON||(fs.existsSync(v)?v:'python');}
async function assetTool(env,op,src,dest,signal,extra=[]){return JSON.parse((await env.run(python(env),[path.join(env.root,'tools','visual_assets.py'),op,src,dest,...extra],{windowsHide:true,maxBuffer:200000,timeout:60000,signal})).stdout);}
function invalidate(p){p.approvals.preview=null;p.previewApproval=null;p.output=null;p.candidate=null;p.reconstruction=null;}
function foundationReference(p,index,direction,env){
  const base=requireThemeAssetForPage(p,index,direction.id),file=path.join(env.data,p.id,base.normalized);
  if(!fs.existsSync(file)||fileHash(file)!==base.previewHash)throw Error('对应底图文件缺失或已被修改，请在03重新生成并检查底图');
  return {file:base.normalized,sha256:base.previewHash,purpose:base.intendedUse,materialId:base.materialId};
}
async function imagePlan(p,index,direction,env,signal,rendered,originals){
  const source=originals||plannedImages(p.slides[index]);if(!source.length&&!rendered)return [];
  if(!rendered)await prepareImageReadability(p,env,signal);
  if(!originals)for(const item of source){
    const file=env.getImage(p,item.id),size=file?.endsWith('.svg')?new Resvg(fs.readFileSync(file)):await assetTool(env,'inspect',file,file,signal);
    Object.assign(item,{pixelWidth:size.width,pixelHeight:size.height,aspect:size.width/size.height,label:p.materials.find(m=>m.id===item.id)?.name||'登记配图'});
    const material=p.materials.find(m=>m.id===item.id);if(material){material.width=size.width;material.height=size.height;}
  }
  if(!rendered){const planned=plannedImageGeometry(p,index,source);source.forEach((e,i)=>Object.assign(e,{plannedSize:planned[i].plannedSize,minimumReadableSize:planned[i].minimumReadableSize}));}
  const cfg=rendered?rebuildConfig(env,p):env.credentials.get(p.id)?.text;
  const instruction=rendered?'定位图片预留区：根据已确认的节点身份、所属内容分组和图文位置确定各原图对应的占位框，不按原图宽高比匹配。按实际生成画面测量每张登记图片的干净预留区边界，不得覆盖已有文字或图形。必须如实返回实际框的宽高，不能为了符合登记原图比例而虚报或内缩边界；这里只测量，不修正比例。':'图片计划：为本页所有登记图片安排等比本地插入区域。图片位宽高比接近登记原图 aspect，按设计稿而非固定模板安排。';
  const countInstruction=rendered?'先独立清点实际画面中所有图片占位框，包括多余框或重复框；不得用登记图片数量或返回的 images 长度代替实际清点。不把文本框、色块、装饰或底图主体计为图片占位框；无登记图片时也要检查是否多画了图片占位框。只输出 {placeholderCount:实际整数,countEvidence:"实际看图依据",images:[{nodeId,id,x,y,w,h}]}。原设计应有 '+source.length+' 个图片占位框；数量不一致时 images 返回空数组，不虚构缺失框，不忽略多余框，不强行为每张图片分配坐标。数量一致后才按节点身份定位，每张登记图片恰好一次。':'只输出 {images:[{nodeId,id,x,y,w,h}]}。每张图片恰好一次。';
  const prompt=instruction+countInstruction+'坐标使用1600×900画布，身份不变，不互相覆盖，保留图注与文字空间。'+(!rendered?' plannedSize 是1920×1080画布中的目标像素尺寸，换算到1600×900坐标时宽高除以1.2；图片位置按本页内容关系安排，避免侵占文字区。\n'+imagePlanningContext(p,p.slides[index]):'')+'\n登记图片：'+JSON.stringify(source)+'\n视觉方向：'+direction.style+'\n设计稿：'+pageDesignState(p,index).markdown;
  try{
  const r=await chat(cfg,env.system,rendered?[{type:'text',text:prompt},{type:'image_url',image_url:{url:dataURL(rendered)}}]:prompt,signal,{validate:raw=>{const countReport=rendered?placeholderCountReport(raw,source.length):null;return {countReport,images:countReport&&!countReport.passed?[]:validateImagePlan(raw.images,p.slides[index])};}});
  const located=r.value.images.map(e=>{
    const original=source.find(n=>n.nodeId===e.nodeId);
    return {...e,aspect:original.aspect,pixelWidth:original.pixelWidth,pixelHeight:original.pixelHeight,label:original.label,plannedSize:original.plannedSize,minimumReadableSize:original.minimumReadableSize};
  });
  return rendered?{images:located,countReport:r.value.countReport}:plannedImageGeometry(p,index,located);
  }catch(error){throw contextualError(error,`方向 ${direction.id.toUpperCase()} · 第 ${index+1} 页 · ${rendered?'占位框定位':'配图布局规划'}`);}
}
async function generatePage(p,index,direction,env,signal,folder,mode,override,{deferReview=false,editSource,imageEdit,repairOnly=false,redrawPrompt}={}){
  requireStyleRegistration(p,direction);
  const foundation=imageEdit||repairOnly?null:foundationReference(p,index,direction,env),stamp=pageStamp({...p,concepts:[direction]},index,direction.id);
  const originalPlan=await imagePlan(p,index,direction,env,signal);let prompt=imageEdit?imageEdit.prompt:repairOnly?override:effectiveSlideImagePrompt(p,index,direction,originalPlan,mode,override);
  const prefix=mode+'-'+direction.id+'-'+index+'-'+crypto.randomUUID(),ledger=path.join(folder,prefix+'-job.json');
  const job={id:prefix,index,direction:direction.id,styleRegistrationId:direction.styleRegistrationId,stage:mode,stamp,...(imageEdit?.region?{editRegion:imageEdit.region}:{}),prompt,promptVersion:imagePromptVersion,factualBoundary:'事实原图以无字占位，比例复查后按登记参数本地回填；不生成替代证据',generationMode:imageEdit?.mode==='redraw'?'text-to-image':'image-to-image',foundation,model:p.provider.image.model,requestSize:'1920x1080',actualRequestSize:'1920x1080',sizeFallback:'auto，仅在接口明确拒绝尺寸时使用',requiredAspect:'16:9',generationAttempts:[],status:'running',startedAt:new Date().toISOString()};
  const persist=()=>fs.writeFileSync(ledger,JSON.stringify(job,null,2));persist();
  try{
    const render=async(brief,currentFile,attempt,{repeatOriginal=false}={})=>{
      signal.throwIfAborted();if(foundation)foundationReference(p,index,direction,env);
      const references=repeatOriginal?structuredClone(job.generationAttempts[0].references):!attempt&&imageEdit?.references?imageEdit.references.map(r=>({...r,sha256:fileHash(path.join(env.data,p.id,r.file))})):[...(currentFile?[{file:currentFile,sha256:fileHash(path.join(env.data,p.id,currentFile)),purpose:attempt?'placeholder-repair-source':'repair-source'}]:[]),...(foundation?[foundation]:[])];
      if(!attempt&&imageEdit?.region)references.push(saveEditRegionReference(p,imageEdit,env,path.join(folder,prefix+'-region-hint.png')));
      const suffix=attempt?(repeatOriginal?'-count-':'-ratio-')+attempt:'',source=path.join(folder,prefix+suffix+'-provider.png'),normalized=path.join(folder,prefix+suffix+'-normalized.png');
      const entry={attempt,...(repeatOriginal?{retryReason:'placeholder-count'}:{}),generationMode:references.length?'image-to-image':'text-to-image',prompt:brief,references,source:path.relative(path.join(env.data,p.id),source),normalized:path.relative(path.join(env.data,p.id),normalized),status:'running'};
      job.generationAttempts.push(entry);job.reference=references[0];job.references=references;persist();
      let bytes;
      try{bytes=await generatedImage(imageConfig(env,p),brief,signal,{size:'1920x1080',allowAutoSize:true,checkPrompt:repeatOriginal?undefined:imagePromptCheck({config:env.credentials.get(p.id)?.text,system:env.system,stage:'整页预览',mode:attempt||repairOnly||imageEdit?.mode==='adjust'?'adjust':'generate',context:{title:p.slides[index].title,visualTreatment:p.visualTreatment,...(!attempt&&imageEdit?.region?{editRegion:imageEdit.region}:{}),coreColor:foundation?.coreColor||direction.coreColor,uniformBackgroundColor:direction.coreColor,background:foundation?.purpose||null,referenceImages:references.map(r=>({materialId:r.materialId||null,role:r.purpose,attachedToImageRequest:true})),registeredBackground:foundation?{materialId:foundation.materialId,subject:p.themeAssets?.directions.find(d=>d.id===direction.id)?.[p.slides[index].kind==='cover'?'heroSubject':p.slides[index].kind==='toc'?'tocSubject':'contentSubject'],coreColor:foundation.coreColor||direction.coreColor}:null,confirmedContent:canonicalTexts(p.slides[index],p,index),images:originalPlan.map(im=>({label:im.label,aspect:im.aspect,plannedSize:im.plannedSize})),retainOriginalPlaceholders:true},protectedTexts:canonicalTexts(p.slides[index]).map(n=>n.text)},signal),onPromptChecked:check=>{entry.prompt=check.prompt;entry.promptCheck={...check,prompt:undefined};if(!attempt&&!repairOnly&&imageEdit?.mode!=='adjust'){prompt=check.prompt;job.prompt=prompt;if(imageEdit)imageEdit.redrawPrompt=prompt;}persist();},references:references.map(r=>({bytes:fs.readFileSync(path.join(env.data,p.id,r.file))})),onSizeFallback:size=>{job.actualRequestSize=size;entry.actualRequestSize=size;persist();}});}
      catch(error){entry.status=signal.aborted?'cancelled':'failed';entry.error=String(error.message).slice(0,2000);persist();throw contextualError(error,`方向 ${direction.id.toUpperCase()} · 第 ${index+1} 页 · 生图请求`);}
      fs.writeFileSync(source,bytes);entry.providerHash=fileHash(source);persist();
      try{entry.dimensions=await assetTool(env,'normalize',source,normalized,signal);}catch(error){entry.status=signal.aborted?'cancelled':'failed';entry.error=String(error.message).slice(0,2000);persist();throw error;}entry.status='generated';persist();return entry;
    };
    const initial=await render(editSource&&foundation?prompt+'\n【参考图顺序】图片1是待修正整页，图片2是对应底图；在图片2基础上保留并修改图片1。':prompt,imageEdit?.mode==='adjust'?imageEdit.target.sourceFile:editSource,0);
    const result=await repairPlaceholders({initial,signal,
      inspect:async entry=>{
        const file=path.join(env.data,p.id,entry.normalized),inspection=await imagePlan(p,index,direction,env,signal,file,originalPlan);
        entry.placeholderCount=inspection.countReport;persist();
        if(!inspection.countReport.passed)return inspection;
        const coarse=inspection.images;
        reportTask(signal,{kind:'placeholder',status:'checking',message:`第 ${index+1} 页 · 本地测量占位框边界与多图匹配`});
        const refined=await refinePlaceholderGeometry(env,python(env),file,coarse,signal);entry.placeholderLocalization=refined.report;persist();
        reportTask(signal,{kind:'placeholder',status:'done',message:`第 ${index+1} 页 · 占位框精定位 ${refined.report.refined}/${refined.report.total}${refined.report.refined<refined.report.total?'，其余保留AI定位':''}`});
        return {images:refined.images,countReport:inspection.countReport};
      },
      regenerate:(entry,checks,attempt)=>render(placeholderCorrectionPrompt(checks,{foundation:!!foundation}),entry.normalized,attempt),
      regenerateCount:(_,count,attempt)=>render(initial.prompt,undefined,attempt,{repeatOriginal:true}),
      saveCheck:(entry,check)=>{entry.placeholderCheck=check;persist();},
      progress:(status,message)=>reportTask(signal,{kind:'placeholder',status,message:(mode==='concept'?'方向 '+direction.id.toUpperCase()+' · ':'')+'第 '+(index+1)+' 页 · '+message})
    });
    signal.throwIfAborted();const final=result.candidate,plan=fittedImagePlans(result.images),preview=path.join(folder,prefix+'.png');
    job.placeholderReview=result.review;job.placeholderLocalization=final.placeholderLocalization;job.reference=final.references[0];job.references=final.references;job.status='compositing';persist();
    const markup='<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1600 900"><image href="'+dataURL(path.join(env.data,p.id,final.normalized))+'" width="1600" height="900"/>'+plan.map(e=>'<image href="'+dataURL(env.getImage(p,e.id))+'" x="'+e.x+'" y="'+e.y+'" width="'+e.w+'" height="'+e.h+'" preserveAspectRatio="'+(imageMayStretch(e)?'none':'xMidYMid meet')+'"/>').join('')+'</svg>';
    fs.writeFileSync(preview,new Resvg(markup).render().asPng());
    const record={index,theme:direction.id,generationMode:job.generationMode,...(imageEdit?{...(imageEdit.region?{editRegion:imageEdit.region}:{}),imageEditMode:imageEdit.mode,parentSourceHash:imageEdit.target.sourceHash,...(imageEdit.crossStyle?{crossStyle:imageEdit.crossStyle}:{})}:{}),redrawPrompt:imageEdit?.redrawPrompt||redrawPrompt||prompt,styleRegistrationId:direction.styleRegistrationId,stamp,source:final.source,normalized:final.normalized,file:path.relative(path.join(env.data,p.id),preview),providerHash:final.providerHash,previewHash:fileHash(preview),dimensions:final.dimensions,prompt:final.prompt,promptCheck:final.promptCheck,promptVersion:imagePromptVersion,reference:final.references[0],references:final.references,placeholderReview:result.review,generationAttempts:job.generationAttempts,images:plan,previewReview:{status:'pending',issues:[]},jobFile:path.relative(path.join(env.data,p.id),ledger),model:p.provider.image.model,at:new Date().toISOString()};
    record.placeholderLocalization=final.placeholderLocalization;
    fs.writeFileSync(path.join(folder,prefix+'-generation.json'),JSON.stringify(record,null,2));job.status='generated';job.record=record;persist();
    return deferReview?record:await reviewGeneratedPage(p,index,direction,env,signal,record,mode);
  }catch(error){const saved=JSON.parse(fs.readFileSync(ledger,'utf8'));fs.writeFileSync(ledger,JSON.stringify({...saved,status:signal.aborted?'cancelled':'failed',error:String(error.message).slice(0,2000),finishedAt:new Date().toISOString()},null,2));throw error;}
}
async function reviewGeneratedPage(p,index,direction,env,signal,record,mode){
  const ledger=path.join(env.data,p.id,record.jobFile),job=JSON.parse(fs.readFileSync(ledger,'utf8')),reviewConfig=rebuildConfig(env,p);
  try{
  const prompt=`检查生图整页成品：查看实际画面，核对信息结构、可读性、配图位置、文字空间和原图完整性。当前${mode==='concept'?'为已本地插入全部登记原图的方向代表页':'为已本地插入全部登记原图的正式预览'}。文字排印以语义与体量为参考，不要求AI逐字准确；不得编造数据或改变语义。${lightweightReviewRule}不合格就返回具体问题。特殊分块仅为创作建议，不检查形状、分类或数量，不因普通布局而判不合格。逐项核对以下设计规范，不适用的检查项返回 true 并在 reason 说明；不能仅凭提示词或清单认定已落实。贴回原图后的自动修正只允许本地调整图片大小与位置；底稿、文字和其他元素不变。imageGeometryIssues 只列可通过移动或缩放原图解决的问题，其余问题仅列入 issues。只输出 {imageGeometryIssues:["图片位置或大小问题，无则空数组"],passed:true或false,issues:["明显问题，无则空数组"],warnings:["轻微建议，不影响通过"],notes:"实际看图依据",${designCheckSchema}}。规范：${designRulesFor(p,index,'review')}。最终内容：${JSON.stringify(canonicalTexts(p.slides[index],p,index))}；图片计划：${JSON.stringify(record.images)}；风格：${direction.style}`;
  const result=await reviewPreviewImage({project:p,index,signal,
    request:correction=>chat(reviewConfig,env.system,[{type:'text',text:prompt+correction},{type:'image_url',image_url:{url:dataURL(visualFile(env,p,record))}}],signal,{deferJSONValidation:true}),
    record:entry=>{record.previewReviewHistory||=[];record.previewReviewHistory.push(entry);job.reviewResponses=record.previewReviewHistory;fs.writeFileSync(ledger,JSON.stringify({...job,record},null,2));},
    progress:message=>reportTask(signal,{kind:'retry',status:'running',message})
  });
  job.review=result.review;record.review=result.review;record.designChecks=result.designChecks;
  record.previewReview=result.previewReview;record.reviewResponseValidation=result.responseValidation;
  if(record.placeholderReview?.countReport?.passed===false){
    record.previewReview={...record.previewReview,status:'needs_revision',issues:[...new Set([...record.previewReview.issues,record.placeholderReview.error||'占位框数量与原设计不一致，暂未贴回原图'])]};
  }
  if(record.autoRepair&&record.previewReview.status==='passed')record.autoRepair={...record.autoRepair,status:'passed',issues:[]};
  if(signal.aborted)throw Error('任务已取消');
  fs.writeFileSync(ledger.replace(/-job\.json$/,'-generation.json'),JSON.stringify(record,null,2));fs.writeFileSync(ledger,JSON.stringify({...job,status:'done',finishedAt:new Date().toISOString(),record},null,2));return record;
  }catch(error){error=contextualError(error,`方向 ${direction.id.toUpperCase()} · 第 ${index+1} 页 · 成品检查`);record.previewReview={status:signal.aborted?'cancelled':'failed',issues:[String(error.message).slice(0,2000)]};fs.writeFileSync(ledger,JSON.stringify({...job,status:signal.aborted?'cancelled':'failed',error:record.previewReview.issues[0],record,finishedAt:new Date().toISOString()},null,2));throw error;}
}
function saveVisualRecord(p,env,record){
  const ledger=path.join(env.data,p.id,record.jobFile),job=JSON.parse(fs.readFileSync(ledger,'utf8'));
  fs.writeFileSync(ledger.replace(/-job\.json$/,'-generation.json'),JSON.stringify(record,null,2));
  fs.writeFileSync(ledger,JSON.stringify({...job,record},null,2));env.save(p);
}
export function postPasteGeometryIssues(record){
  if(Array.isArray(record.review?.imageGeometryIssues))return record.review.imageGeometryIssues.filter(v=>typeof v==='string'&&v.trim());
  // Compatibility for providers returning the earlier review schema.
  return (record.previewReview?.issues||[]).filter(v=>/遮挡|重叠|图片.*(?:大小|位置|比例|越界)|配图.*(?:大小|位置|比例|越界)/.test(v));
}
export async function repositionPastedImages(p,index,direction,env,signal,record){
  const issues=postPasteGeometryIssues(record);
  if(!record.images?.length||!issues.length)throw Error('当前问题不能通过调整原图大小与位置解决');
  const prompt='贴回原图后的几何修正：只返回 {images:[{nodeId,id,x,y,w,h}]}。画布1600×900；只能移动或缩放已登记原图，保持图片身份、顺序与全部内容，不裁切、不重绘、不替换。'+originalImagePlacementRule+'不修改底稿、文字、图注或其他元素，不新增对象。已有 placeholderBox 是实际占位区，调整后的图片必须完整位于对应框内，不能移动到正文或框外。所有原图恰好一次，不能相互覆盖或覆盖已有文字；非图片几何问题不处理。只给出实际需要调整的坐标，其他图片保持。\n当前原图：'+JSON.stringify(record.images)+'\n本轮图片几何问题：'+JSON.stringify(issues);
  const response=await chat(rebuildConfig(env,p),env.system,[{type:'text',text:prompt},{type:'image_url',image_url:{url:dataURL(visualFile(env,p,record))}}],signal,{validate:raw=>validateImagePlan(raw.images,p.slides[index])});
  const validated=response.value;
  const plan=repositionedImagePlans(record.images,validated);
  signal.throwIfAborted();
  const base=path.join(env.data,p.id,record.normalized);
  if(!fs.existsSync(base))throw Error('原图贴回前的底稿不存在');
  const folder=path.dirname(path.join(env.data,p.id,record.jobFile)),prefix='geometry-'+crypto.randomUUID(),file=path.join(folder,prefix+'.png'),jobFile=path.join(folder,prefix+'-job.json');
  const markup='<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1600 900"><image href="'+dataURL(base)+'" width="1600" height="900"/>'+plan.map(e=>'<image href="'+dataURL(env.getImage(p,e.id))+'" x="'+e.x+'" y="'+e.y+'" width="'+e.w+'" height="'+e.h+'" preserveAspectRatio="'+(imageMayStretch(e)?'none':'xMidYMid meet')+'"/>').join('')+'</svg>';
  fs.writeFileSync(file,new Resvg(markup).render().asPng());
  const next={...structuredClone(record),images:plan,file:path.relative(path.join(env.data,p.id),file),previewHash:fileHash(file),jobFile:path.relative(path.join(env.data,p.id),jobFile),manualReview:null,previewReview:{status:'pending',issues:[]},geometryAdjustment:{mode:'local-composite',issues,prompt,at:new Date().toISOString()},at:new Date().toISOString()};
  delete next.autoRepair;delete next.repairHistory;delete next.editHistory;delete next.designChecks;delete next.review;
  const priorJob=JSON.parse(fs.readFileSync(path.join(env.data,p.id,record.jobFile),'utf8'));
  fs.writeFileSync(jobFile,JSON.stringify({...priorJob,id:prefix,status:'generated',record:next,geometryAdjustment:next.geometryAdjustment},null,2));
  return next;
}
function reviewAndRepairPage(p,index,direction,env,signal,record,mode){
  return reviewAndRepair(record,{
    signal,review:r=>reviewGeneratedPage(p,index,direction,env,signal,r,mode),
    canRepair:r=>!!r.images?.length&&postPasteGeometryIssues(r).length>0,
    generate:()=>repositionPastedImages(p,index,direction,env,signal,record),
    save:r=>saveVisualRecord(p,env,r),
    progress:(status,message)=>reportTask(signal,{kind:'repair',status,message:`${mode==='concept'?'方向 '+direction.id.toUpperCase()+' · ':''}第 ${index+1} 页 · 仅调整原图大小与位置 · ${message}`})
  });
}
function finishVisualChecks(p,pages,label){
  const revise=pages.filter(r=>r.previewReview?.status==='needs_revision'),repaired=pages.filter(r=>r.autoRepair?.attempts&&r.previewReview?.status==='passed');
  const recovered=pages.filter(r=>r.placeholderReview?.status==='fallback');
  const incomplete=pages.filter(r=>r.previewReview?.status==='inconclusive');
  p.task.completionMessage=label+'已生成'+(incomplete.length?'':'并完成本步检查')+(repaired.length?'；'+repaired.length+' 页自动修正后通过':'')+(revise.length?'；'+revise.length+' 页仍需修改，图片已保留，请在当前步骤查看检查结果':'，等待复核')+(recovered.length?'；'+recovered.length+' 页修正接口异常，已使用上一张已定位底稿贴回原图':'')+(incomplete.length?'；'+incomplete.length+' 页检查暂未完成，保留图片可继续选用或复查':'');
}
function conceptReadiness(p,c){
  const indices=c.expectedPages||c.representatives.map(r=>r.index),blocking=[],reviewIssues=[];
  if(!indices.length)blocking.push('代表页尚未生成');
  for(const i of indices){const r=c.representatives.find(r=>r.index===i);if(!r){blocking.push(`第 ${i+1} 页尚未生成`);continue;}if(!r.file||!r.previewHash)blocking.push(`第 ${i+1} 页没有有效成品图片`);if(!pageDesignState(p,i)?.approvedCurrent||r.stamp!==pageStamp(p,i,c.id))blocking.push(`第 ${i+1} 页设计已过期`);if(r.previewReview?r.previewReview.status!=='passed':r.review?.passed!==true||r.review?.issues?.length||!r.designChecks||applicableDesignChecks(p,i).some(k=>!r.designChecks[k]))reviewIssues.push(`第 ${i+1} 页视觉检查待完成或修改`);}
  const issues=[...blocking,...reviewIssues];
  return {passed:issues.length===0,selectable:blocking.length===0,issues,blockingIssues:blocking,reviewIssues};
}

export function reuseConceptPreviews(p,env){
  const direction=p.concepts.find(c=>c.id===p.selectedTheme),indices=[];
  if(direction?.mode!=='ai')return indices;
  p.visualPages||={};
  for(const page of direction.representatives||[]){
    const i=page.index;
    if(fullPageCurrent(p,i)||!pageDesignState(p,i)?.approvedCurrent||page.stamp!==pageStamp(p,i,direction.id))continue;
    if(!conceptReadiness(p,{...direction,expectedPages:[i]}).selectable)continue;
    const file=page.file&&path.join(env.data,p.id,page.file);
    if(!file||!fs.existsSync(file)||fileHash(file)!==page.previewHash)continue;
    p.visualPages[i]={...structuredClone(page),manualReview:null,conceptSource:{theme:direction.id,index:i,previewHash:page.previewHash,jobFile:page.jobFile}};
    indices.push(i);
  }
  if(indices.length)invalidate(p);
  return indices;
}

function visualFile(env,p,page){return path.join(env.data,p.id,page.file);}
async function rebuild(p,env,signal){
  const cfg=rebuildConfig(env,p),stamp=visualStamp(p),pages=[],auditRun=crypto.randomUUID();
  p.rebuildAssetPreview={stamp,version:p.version,revision:0,pages:[],materials:[],status:'extracting'};env.save(p);
  const assetsDir=path.join(env.data,p.id,'assets');fs.mkdirSync(assetsDir,{recursive:true});const pending=[];
  await runConcurrent(p.slides.map((_,i)=>i),async i=>{
    if(!fullPageCurrent(p,i))throw Error('请先生成并批准所有页面的完整预览');
    p.task.message=`拆解与重建 ${i+1}/${p.slides.length}`;env.save(p);
    const page=p.visualPages[i],source=visualFile(env,p,page),background=slideBackground(p,i),backgroundFile=env.getImage(p,background.id);
    if(!backgroundFile||fileHash(backgroundFile)!==background.sha256)throw Error('页面底图文件缺失或哈希不一致');
    const geometryDir=path.join(env.data,p.id,'geometry-records',auditRun,`page-${i+1}`);
    const geometry=await analyzeVisual(env,python(env),{operation:'geometry',reference:source,background:backgroundFile,exclude:page.images||[]},geometryDir,signal);
    const geometryHint='\n本地背景差分几何候选（只作定位辅助，不是完整元素清单，不强制采用；backgroundDrift表示背景变化较大，低置信候选须忽略）：'+JSON.stringify({...geometry,candidates:geometry.candidates?.slice(0,20)});
    const reuseNote=page.reused?'这张图是沿用的旧布局参考，图中文字可能属于旧版本。位置、形状、配色和图片沿用；所有原生文字必须用下方当前准确文案替换，新增或删除字段按当前内容树处理。尽量复用原有视觉素材，不为同步文字重新生成整页。\n':'';
    const prompt=`自由元素审计：${reuseNote}逐个拆解这张已批准的完整设计。原生文字、背景、异形色块、线条、图标、渐变、纹理、装饰、图表与图片都必须独立登记。不能把整页底稿贴成背景、叠字或拼大块截图。可新增任意数量的重建元素，不受旧程序版式清单限制。按叠放顺序输出完整 elements 数组。画布坐标1600×900，图片本身1920×1080。${visualColorRule} ${rebuildMethodRule} ${rebuildNumberRule} ${rebuildHeadingBodyRule}\n类型：text {key,type,nodeId,text,x,y,w,h,size,fontFace,color,bold,italic,align}；rect/ellipse/line {key,type,x,y,w,h,fill,color,strokeWidth,opacity}；shape {key,type:"shape",shape:"roundRect|triangle|rtTriangle|diamond|hexagon|pentagon|chevron|parallelogram|trapezoid",x,y,w,h,fill,color,strokeWidth,opacity} 可编辑PPT原生图形；svg {key,type,x,y,w,h,svg:"仅非文字几何，SVG命名空间、viewBox，支持路径/渐变/图案逐项绘制，禁止脚本/图片/外链/text"}；cutout {key,type,x,y,w,h,sourceBox:{x,y,w,h},prompt,nonFactual:true,description} 先裁取预览局部，再附图以图生图方式抠成独立透明素材；image {key,type,nodeId,id,x,y,w,h} 必须直接使用登记原件，不改身份或位置。复杂流程图/图表必须以独立可编辑文字和独立图形/SVG路径重建，禁止截图保留文字或数据。背景渐变可用纯几何SVG独立层；不能把可见页面排版烘焙进背景。禁止漏项，禁止杜撰图表数据。准确文案通常每个nodeId恰好一次，编号按独立拆分规则输出number/label两项；其他文案完整原样，不得合并。重点对照字体、字号与字重；区分文字原本有无可见承载，保持无框文字无框，有框的矩形/圆角/异形承载以独立原生图形或SVG置于文字下方，不把全部文字强制放入矩形框。对比两张图片，补齐仅完整预览中新增、底图里没有的色块、分隔、图标与复杂视觉元素；不要误当底图已有内容而漏掉。复杂的非事实装饰若适合保留原有细节和轮廓，可优先考虑cutout图生图抠图；规则几何用原生图形或SVG，含文字/事实数据的复杂图表分别重建文字和图形。\n准确文字：${JSON.stringify(canonicalTexts(p.slides[i],p,i))}\n登记原图计划：${JSON.stringify(page.images)}\n设计稿：${pageDesignState(p,i).markdown}\n只输出 {elements:[...],notes:"审计说明"}。`;
    const acceptedPreviewIssues=p.previewApproval?.acceptedIssues?.length?'\n用户已确认继续的预览检查记录：'+JSON.stringify(p.previewApproval.acceptedIssues)+'。这些问题属于参考图的已知检查记录；重建以准确文案和登记素材为准，不宣称问题已经解决。':'';
    const backgroundInstruction=acceptedPreviewIssues+`\n固定页面背景：${JSON.stringify(background)}。第二张图是已登记的无字底图，程序将原样写入 PPTX 的页面背景并铺满画布。只审计相对该底图新增的文字、内容承载、导航、事实原图和装饰；不要重复拆解、裁剪、重画底图已有主体、渐变或纹理，不输出覆盖全页的底色块。新增元素须保留底图可见。第一张完整预览只用于排版对照，禁止用作页面背景。`;
    const auditRecords=[],auditDir=path.join(env.data,p.id,'audit-records',auditRun);
    const {raw,audit,auditValidation}=await auditedElements({slide:p.slides[i],project:p,index:i,images:page.images,signal,
      request:correction=>chat(cfg,env.system,[{type:'text',text:(correction??prompt+backgroundInstruction+'\n'+visualTextStyleRule+'\n'+rebuildMethodRule+'\n'+rebuildNumberRule+'\n'+designRulesFor(p,i,'rebuild')+'\n重建修正意见（保持准确文案和原图）：'+(p.rebuildInstructions||'无'))+geometryHint},{type:'image_url',image_url:{url:dataURL(source)}},{type:'image_url',image_url:{url:dataURL(backgroundFile)}}],signal,{deferJSONValidation:true}),
      record:entry=>{fs.mkdirSync(auditDir,{recursive:true});const file=path.join('audit-records',auditRun,`page-${i+1}-attempt-${entry.attempt}.json`);fs.writeFileSync(path.join(env.data,p.id,file),JSON.stringify({index:i,previewHash:page.previewHash,stamp,model:cfg.model,...entry},null,2));auditRecords.push(file);},
      progress:message=>reportTask(signal,{kind:'step',status:'running',message})
    }),elements=[];
    for(const e of audit){
      if(signal.aborted)throw Error('任务已取消');
      if(!['svg','crop','generate','cutout'].includes(e.type)){elements.push(e);continue;}
      const id=crypto.randomUUID(),file=id+(e.type==='svg'?'.svg':'.png'),target=path.join(assetsDir,file);let details={};
      if(e.type==='svg'){
        const temp=path.join(assetsDir,id+'.draft.svg');fs.writeFileSync(temp,e.svg);await assetTool(env,'svg',temp,target,signal,[String(Math.max(1,Math.min(1920,Math.ceil(e.w*1.2)))),String(Math.max(1,Math.min(1080,Math.ceil(e.h*1.2))))]);new Resvg(fs.readFileSync(target)).render().asPng();details={origin:'vector-rebuild',svg:true};
      }else if(e.type==='crop'){
        const spec=path.join(assetsDir,id+'.crop.json');fs.writeFileSync(spec,JSON.stringify({box:[e.sourceBox.x,e.sourceBox.y,e.sourceBox.w,e.sourceBox.h],mask:e.mask}));details={...await assetTool(env,'crop',source,target,signal,[spec]),origin:'preview-crop',sourceBox:e.sourceBox,mask:e.mask};
      }else if(e.type==='cutout'){
        const crop=path.join(assetsDir,id+'.source.png'),spec=path.join(assetsDir,id+'.crop.json');fs.writeFileSync(spec,JSON.stringify({box:[e.sourceBox.x,e.sourceBox.y,e.sourceBox.w,e.sourceBox.h]}));await assetTool(env,'crop',source,crop,signal,[spec]);
        const cfgImage=env.credentials.get(p.id)?.elementImage||imageConfig(env,p);let prompt=e.prompt+'\n对随附局部装饰用图生图抠图，保持主体轮廓、颜色、纹理和内部细节，移除背景，输出透明背景的独立主体。仅非事实元素，禁止文字、数字、图表数据或材料证据；不添加新主体。';
        const bytes=await generatedImage(cfgImage,prompt,signal,{checkPrompt:imagePromptCheck({config:env.credentials.get(p.id)?.text,system:env.system,stage:'复杂元素抠图',mode:'cutout',context:{title:p.slides[i].title,description:e.description}},signal),onPromptChecked:check=>{prompt=check.prompt;details.promptCheck={...check,prompt:undefined};},size:'1920x1080',references:[{bytes:fs.readFileSync(crop),mime:'image/png'}]}),provider=path.join(assetsDir,id+'.provider');fs.writeFileSync(provider,bytes);await assetTool(env,'copy',provider,target,signal);
        const alpha=await assetTool(env,'alpha',target,target,signal);if(!alpha.hasTransparency||!alpha.hasVisiblePixels)throw Error('图生图抠图未返回有效透明主体，请改用SVG或重新抠图');
        details={...details,origin:'ai-cutout',sourceBox:e.sourceBox,prompt,effectivePrompt:prompt,model:cfgImage.model,alpha};
      }else{
        const cfgImage=env.credentials.get(p.id)?.elementImage||imageConfig(env,p);let prompt=e.prompt+'\n仅生成独立非事实视觉元素，无文字、数字、图表、照片证据，透明背景。';
        const bytes=await generatedImage(cfgImage,prompt,signal,{checkPrompt:imagePromptCheck({config:env.credentials.get(p.id)?.text,system:env.system,stage:'重建独立素材',context:{title:p.slides[i].title,description:e.description}},signal),onPromptChecked:check=>{prompt=check.prompt;details.promptCheck={...check,prompt:undefined};}});if(bytes[0]!==137&&!(bytes[0]===255&&bytes[1]===216))throw Error('重建生图未返回有效图片');const provider=path.join(assetsDir,id+'.provider');fs.writeFileSync(provider,bytes);await assetTool(env,'copy',provider,target,signal);details={...details,origin:'generated-rebuild',prompt,effectivePrompt:prompt,model:cfgImage.model};
      }
      const m={id,file,name:'重建素材 · '+(e.description||e.key),kind:'image',generated:true,reconstructed:true,purpose:'reconstruction',sha256:fileHash(target),size:fs.statSync(target).size,sourcePreviewHash:page.previewHash,sourceElement:e.key,...details,createdAt:new Date().toISOString()};pending.push(m);elements.push({...e,type:'image',id,implementation:e.type,svg:undefined,prompt:undefined});
    }
    pages[i]={index:i,background,elements,audit,geometry:{...geometry,record:path.relative(path.join(env.data,p.id),geometryDir)},auditValidation:{...auditValidation,records:auditRecords},notes:String(raw.notes||'').slice(0,2000)};
    publishRebuildAssets(p,env,i,elements,pending);
  },{signal,limit:concurrencyLimit(p.executionConcurrency),label:i=>'拆解与重建 · 第 '+(i+1)+' 页'});
  if(signal.aborted)throw Error('任务已取消');if(stamp!==visualStamp(p))throw Error('批准的预览已变化，请重新拆解');
  p.materials.push(...pending);p.reconstruction={textPolicyVersion:'separate-numbers-v1',mode:'free',stamp,slides:pages,assets:pending.map(m=>m.id),at:new Date().toISOString(),model:cfg.model};p.rebuildAssetPreview.status='done';return p.reconstruction;
}
function verifyCandidate(p,env){
  const c=p.candidate;if(!c||c.version!==p.version||c.stamp!==visualStamp(p)||p.approvals.preview!==p.version||!rebuiltCurrent(p))throw Error('候选交付已过期，请重新构建与渲染');
  const base=path.join(env.data,p.id,c.dir);
  for(const proof of c.proofs){const file=path.join(base,proof.file);if(!fs.existsSync(file)||fileHash(file)!==proof.sha256)throw Error('候选交付文件或验收工件已变化，禁止发布');}
  for(const m of p.materials.filter(m=>c.assetIds.includes(m.id))){const f=env.getImage(p,m.id);if(!f||!fs.existsSync(f)||fileHash(f)!==m.sha256)throw Error('登记原图或重建素材哈希不一致');}
  return base;
}
async function renderCandidate(p,env,signal,{allowLocalLayout=true}={}){
  const cfg=rebuildConfig(env,p);p.output=null;
  if(!rebuiltCurrent(p))await rebuild(p,env,signal);
  const round=p.rebuildLive?.round||0;
  for(const [index,page] of p.reconstruction.slides.entries())publishRebuildPage(p,env,{index,round,source:'scene',bytes:new Resvg(nativeSVG(page.elements,id=>dataURL(env.getImage(p,id)),page.background),{font:{loadSystemFonts:true}}).render().asPng()});
  const candidateId=crypto.randomUUID(),dir=path.join(env.data,p.id,'exports',candidateId);fs.mkdirSync(dir,{recursive:true});
  const file='deck.pptx',deck=path.join(dir,file),textLayout=[];let manifest;
  for(let localRound=0;localRound<=2;localRound++){
    const spec={slides:p.reconstruction.slides.map(s=>s.elements),backgrounds:p.reconstruction.slides.map(s=>s.background)};fs.writeFileSync(path.join(dir,'deck-spec.json'),JSON.stringify(spec,null,2));
    p.task.message=localRound?'文字实测局部修正后重新渲染 · '+localRound+'/2':'组装原生 PPTX';env.save(p);await buildVisualDeck(p,deck,env.getImage);
    try{await env.run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(env.root,'tools','render_deck.ps1'),'-DeckPath',deck,'-OutputDir',dir],{windowsHide:true,maxBuffer:1000000,timeout:240000,signal});}catch(error){throw Error('PowerPoint 实际渲染失败，下载保持关闭：'+String(error.stderr||error.message).slice(-600));}
    manifest=JSON.parse(fs.readFileSync(path.join(dir,'render-manifest.json'),'utf8'));
    if(manifest.pages.length!==p.slides.length||manifest.pptx_sha256!==fileHash(deck))throw Error('渲染页数或 PPTX 哈希不一致');
    let changed=false;
    for(const [i,page] of p.reconstruction.slides.entries()){
      const result=optimizeTextLayout(page.elements,manifest.pages[i].texts||[]);
      const applied=allowLocalLayout&&localRound<2&&result.changes.length>0;
      textLayout.push({index:i,round:localRound,measured:manifest.pages[i].texts?.length||0,applied,changes:result.changes,issues:result.issues,measurementErrors:manifest.pages[i].measurementErrors||[]});
      if(applied){page.elements=result.elements;changed=true;}
    }
    if(!changed)break;
  }
  fs.writeFileSync(path.join(dir,'text-layout.json'),JSON.stringify(textLayout,null,2));
  const structure=JSON.parse((await env.run(python(env),[path.join(env.root,'tools','release_check.py'),deck,path.join(dir,'deck-spec.json')],{windowsHide:true,maxBuffer:1000000,timeout:60000,signal})).stdout);
  if(manifest.pages.length!==p.slides.length||manifest.pptx_sha256!==fileHash(deck))throw Error('渲染页数或 PPTX 哈希不一致');
  const reviews=p.slides.map((_,index)=>({index,pending:true,passed:false,checks:{},designChecks:null,issues:[],deviations:[],notes:'',manual:null})),proofs=[];
  for(const i of p.slides.keys()){
    const rendered=path.join(dir,manifest.pages[i].file),reference=visualFile(env,p,p.visualPages[i]),elements=p.reconstruction.slides[i].elements;
    const rebuilt=new Resvg(nativeSVG(elements,id=>dataURL(env.getImage(p,id)),p.reconstruction.slides[i].background),{font:{loadSystemFonts:true}}).render().asPng();fs.writeFileSync(path.join(dir,`rebuilt-${i}.png`),rebuilt);fs.copyFileSync(reference,path.join(dir,`approved-${i}.png`));
    const compare=`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="590"><rect width="1920" height="590" fill="#e4e6dd"/><text x="20" y="30" font-size="18" font-family="Microsoft YaHei">已批准预览 / APPROVED</text><text x="980" y="30" font-size="18" font-family="Microsoft YaHei">实际 PowerPoint 渲染 / RENDERED</text><image href="${dataURL(reference)}" x="0" y="50" width="960" height="540"/><image href="${dataURL(rendered)}" x="960" y="50" width="960" height="540"/></svg>`;fs.writeFileSync(path.join(dir,`compare-${i}.png`),new Resvg(compare,{font:{loadSystemFonts:true}}).render().asPng());
    publishRebuildPage(p,env,{index:i,round,source:'powerpoint',bytes:fs.readFileSync(rendered)});
  }
  const review={candidateId,at:new Date().toISOString(),model:cfg.model,pages:reviews};
  const candidate={id:candidateId,version:p.version,stamp:visualStamp(p),dir:path.relative(path.join(env.data,p.id),dir),file,renderer:manifest.renderer,rendererVersion:manifest.version,structure,review,proofs,assetIds:[...new Set(p.reconstruction.slides.flatMap(s=>[s.background.id,...s.elements.filter(e=>e.type==='image').map(e=>e.id)]))],status:'reviewing',at:new Date().toISOString()};
  const checkpoint=()=>{
    candidate.designStandards=designAcceptance(p,reviews);review.designStandards=candidate.designStandards;
    fs.writeFileSync(path.join(dir,'qa-review.json'),JSON.stringify(review,null,2));
    candidate.proofs=fs.readdirSync(dir).map(file=>({file,sha256:fileHash(path.join(dir,file))}));p.candidate=candidate;p.stage=6;env.save(p);
  };
  fs.writeFileSync(path.join(dir,'structure-report.json'),JSON.stringify(structure,null,2));checkpoint();
  await runConcurrent(p.slides.map((_,i)=>i),async i=>{
    p.task.message=`渲染对照验收 ${i+1}/${p.slides.length}`;env.save(p);const rendered=path.join(dir,manifest.pages[i].file),reference=visualFile(env,p,p.visualPages[i]),elements=p.reconstruction.slides[i].elements;
    const diagnosticDir=path.join(env.data,p.id,'visual-diagnostics',candidateId,`page-${i+1}`);
    const diagnostics=await analyzeVisual(env,python(env),{operation:'difference',reference,rendered,background:env.getImage(p,p.reconstruction.slides[i].background.id),elements,exclude:p.visualPages[i].reused?elements.filter(e=>e.type==='text'):[]},diagnosticDir,signal);
    const heatmap=path.join(dir,`difference-${i}.png`);
    if(diagnostics.status==='available')fs.copyFileSync(path.join(diagnosticDir,'difference.png'),heatmap);
    fs.writeFileSync(path.join(dir,`analysis-${i}.json`),JSON.stringify(diagnostics,null,2));
    const pageLayout=textLayout.filter(r=>r.index===i);let geometry=p.reconstruction.slides[i].geometry;
    let geometryImage=geometry?.record&&path.join(env.data,p.id,geometry.record,'geometry.png');
    // Older projects can acquire diagnostics without changing their saved scene.
    if(geometry?.status!=='available'){
      const geometryDir=path.join(diagnosticDir,'geometry');
      geometry=await analyzeVisual(env,python(env),{operation:'geometry',reference,background:env.getImage(p,p.reconstruction.slides[i].background.id),exclude:p.visualPages[i].images||[]},geometryDir,signal);
      geometryImage=path.join(geometryDir,'geometry.png');
    }
    if(geometryImage&&fs.existsSync(geometryImage))fs.copyFileSync(geometryImage,path.join(dir,`geometry-${i}.png`));
    const diagnosticSummary={...diagnostics,regions:diagnostics.regions?.slice(0,12),geometryAvailable:!!geometryImage&&fs.existsSync(geometryImage),geometryCandidates:geometry?.candidates?.length||0,geometricCandidates:geometry?.candidates?.slice(0,20)||[],textLayout:{...pageLayout.at(-1),appliedChanges:pageLayout.filter(r=>r.applied).reduce((n,r)=>n+r.changes.length,0)}};
    const prompt=`渲染对照验收：第一张是用户批准的AI完整预览，第二张是真实PowerPoint渲染，第三张是重建场景。逐页实际看图，不能仅依据结构清单判通过。${rebuildAppearanceRule} 分别评价美观度、排版质量与预览接近程度：以批准预览的构图、相对位置、留白、色阶和视觉重心为目标；不能因为文字齐全就判版式美观或预览相似。检查整体美观/版式/渐变/装饰/留白/层级、准确文字/条件/数据/可读性、登记原图身份与完整性、是否忠实还原设计。AI预览文字可能有误，准确文案以下方清单为准。${p.visualPages[i].reused?'当前参考图沿用了旧布局，新文案已在原生对象中同步；文字变化是用户主动选择，不能因与旧参考文字不同而否决，须检查最新文字是否完整、可读且无重叠。':''}明显遗漏、整页扁平化、错图、出框、文字重叠或无法确认均判失败。允许合理位置优化但须列明 deviations。只输出完整JSON验收对象。设计规范：${designRulesFor(p,i,'review')}。准确文字：${JSON.stringify(canonicalTexts(p.slides[i],p,i))}\n原生对象清单：${JSON.stringify(elements.map(({svg,...e})=>({...e,...(svg?{vectorGeometry:"独立SVG几何，按实际图核对"}:{})})))}\n结构检查：${JSON.stringify(structure.slides[i])}`;
    const records=[];
    reviews[i]=await reviewRenderedPage({project:p,index:i,structure,signal,
      request:correction=>chat(cfg,env.system,[{type:'text',text:prompt+'\n本地视觉诊断（不作为通过门槛；相似度不能衡量语义或美观，红色只表示局部差异；新文案可能与旧参考不同）：'+JSON.stringify(diagnosticSummary)+'\n如有第四张图，它是局部差异热力图。\n返回严格合法JSON，所有键加双引号；使用以下字段结构，布尔值据实际画面判断：'+renderReviewSchema+'。只返回验收结论，不重复文案、对象清单或SVG；notes与reason各不超过160字。'+(correction||'')},...[reference,rendered,path.join(dir,`rebuilt-${i}.png`),...(diagnostics.status==='available'?[heatmap]:[])].map(f=>({type:'image_url',image_url:{url:dataURL(f)}}))],signal,{deferJSONValidation:true,includeSummary:false}),
      record:entry=>{const file=`review-page-${i+1}-attempt-${entry.attempt}.json`;fs.writeFileSync(path.join(dir,file),JSON.stringify({index:i,model:cfg.model,...entry},null,2));records.push(file);},
      progress:message=>{p.task.message=message;reportTask(signal,{kind:'retry',status:'running',message});env.save(p);}
    });reviews[i].responseValidation.records=records;reviews[i].diagnostics=diagnosticSummary;
    // Real overflow is actionable geometry, unlike an advisory similarity score.
    // It enters this same step's existing repair loop; draft download remains available.
    for(const m of manifest.pages[i].texts||[]){
      const e=elements.find(e=>e.type==='text'&&e.key===m.key);
      if(e&&(m.boundWidth>e.w+2||m.boundHeight>e.h+2)){
        reviews[i].issues.push(`文字实测超出文本框：${e.key}，实测 ${m.boundWidth.toFixed(1)}×${m.boundHeight.toFixed(1)}，文本框 ${e.w.toFixed(1)}×${e.h.toFixed(1)}`);
        reviews[i].passed=false;
      }
    }
    checkpoint();
  },{signal,limit:concurrencyLimit(p.executionConcurrency),label:i=>'渲染对照验收 · 第 '+(i+1)+' 页'});
  fs.writeFileSync(path.join(dir,'style-registry.json'),JSON.stringify(p.styleRegistry||[],null,2));
  fs.writeFileSync(path.join(dir,'content.json'),JSON.stringify({brief:p.brief,slides:p.slides,pageDesigns:p.pageDesigns,previewApproval:p.previewApproval||null,styleRegistry:p.styleRegistry||[],concepts:p.concepts,visualPages:p.visualPages,reconstruction:p.reconstruction,materials:p.materials.map(({text,ocr,...m})=>m)},null,2));
  if(p.brief.speaker)fs.writeFileSync(path.join(dir,'speaker-notes.md'),p.slides.map((s,i)=>`## 第 ${i+1} 页 ${s.title}\n\n${s.notes||''}`).join('\n\n'));
  if(signal.aborted)throw Error('任务已取消');
  candidate.status=reviews.every(r=>r.passed)?'awaiting_review':'failed';checkpoint();
  return p.candidate;
}
async function buildCandidate(p,env,signal,{feedback=[],repairLimit=rebuildVisualRepairLimit,preserveReconstruction=false}={}){
  const stamp=visualStamp(p),repairBatch=crypto.randomUUID(),recordDir=path.join(env.data,p.id,'rebuild-repairs',repairBatch);
  p.output=null;startRebuildLive(p,env);
  if(!preserveReconstruction&&!feedback.length&&p.reconstruction&&(p.reconstruction.model!==rebuildConfig(env,p).model||p.reconstruction.textPolicyVersion!=='separate-numbers-v1'))p.reconstruction=null;
  await rebuildReviewLoop({signal,feedback,limit:repairLimit,
    render:async round=>{if(stamp!==visualStamp(p))throw Error('预览已变化，停止自动重建修正');p.rebuildLive.round=round;p.task.message=`实际渲染与视觉复查 · ${round?'修正第'+round+'轮':'初版'}`;env.save(p);return renderCandidate(p,env,signal,{allowLocalLayout:!feedback.length&&!preserveReconstruction});},
    progress:message=>{p.task.message=message;reportTask(signal,{kind:'repair',status:'running',message});env.save(p);},
    save:candidate=>{const file='visual-repair-history.json',base=path.join(env.data,p.id,candidate.dir);fs.writeFileSync(path.join(base,file),JSON.stringify(candidate.visualRepair,null,2));const proof=candidate.proofs.find(e=>e.file===file);if(proof)proof.sha256=fileHash(path.join(base,file));else candidate.proofs.push({file,sha256:fileHash(path.join(base,file))});env.save(p);},
    repair:async(failed,round)=>{
      const results=await runConcurrent(failed,async review=>{
        const i=review.index,page=p.visualPages[i],source=visualFile(env,p,page),base=path.join(env.data,p.id,p.candidate.dir),backgroundFile=env.getImage(p,p.reconstruction.slides[i].background.id);
        return repairRebuiltPage({p,index:i,review,round,env,signal,reference:dataURL(source),rendered:dataURL(path.join(base,`S${String(i+1).padStart(2,'0')}.png`)),background:dataURL(backgroundFile),...(review.diagnostics?.status==='available'?{heatmap:dataURL(path.join(base,`difference-${i}.png`))}:{}),
          createAsset:async args=>{
            const id=crypto.randomUUID(),assetsDir=path.join(env.data,p.id,'assets'),target=path.join(assetsDir,id+(args.method==='svg'?'.svg':'.png'));fs.mkdirSync(assetsDir,{recursive:true});let details={};
            if(args.method==='svg'){
              const temp=path.join(assetsDir,id+'.draft.svg');fs.writeFileSync(temp,String(args.svg||''));await assetTool(env,'svg',temp,target,signal,[String(Math.max(1,Math.min(1920,Math.ceil(args.w*1.2)))),String(Math.max(1,Math.min(1080,Math.ceil(args.h*1.2))))]);new Resvg(fs.readFileSync(target)).render().asPng();details={origin:'vector-rebuild',svg:true};
            }else{
              if(typeof args.prompt!=='string'||args.prompt.trim().length<10||args.prompt.length>6000)throw Error('生图/抠图须提供简洁且足够明确的提示词');
              const cfg=env.credentials.get(p.id)?.elementImage||imageConfig(env,p),references=[];
              if(args.method==='cutout'){
                const current=review.targetKey&&p.reconstruction.slides[i].elements.find(e=>e.key===review.targetKey&&e.type==='image'&&e.implementation);
                if(current){const file=env.getImage(p,current.id);references.push({bytes:file.endsWith(".svg")?new Resvg(fs.readFileSync(file)).render().asPng():fs.readFileSync(file),mime:file.endsWith(".svg")?"image/png":mime(file)});details.parentAssetId=current.id;}
                else{const crop=path.join(assetsDir,id+'.source.png'),spec=path.join(assetsDir,id+'.crop.json');fs.writeFileSync(spec,JSON.stringify({box:['x','y','w','h'].map(k=>args.sourceBox[k])}));await assetTool(env,'crop',source,crop,signal,[spec]);references.push({bytes:fs.readFileSync(crop),mime:'image/png'});details.sourceBox=args.sourceBox;}
              }
              let prompt=args.prompt+'\n仅独立非事实视觉元素，禁止文字、数字、图表数据或材料证据。透明背景。'+(details.parentAssetId?'仅按调整意见编辑随附的当前独立素材，其余细节保持，输出透明主体。':'对随附局部装饰抠图，保持主体轮廓、颜色、内部细节，不添加或改变主体。');
              const bytes=await generatedImage(cfg,prompt,signal,{checkPrompt:imagePromptCheck({config:env.credentials.get(p.id)?.text,system:env.system,stage:'工具重建素材',mode:args.method==='cutout'?'cutout':details.parentAssetId?'adjust':'generate',context:{title:p.slides[i].title,description:args.description,sourceBoxHintOnly:true}},signal),onPromptChecked:check=>{prompt=check.prompt;details.promptCheck={...check,prompt:undefined};},size:'1920x1080',references}),provider=path.join(assetsDir,id+'.provider');fs.writeFileSync(provider,bytes);await assetTool(env,'copy',provider,target,signal);
              if(args.method==='cutout'){const alpha=await assetTool(env,'alpha',target,target,signal);if(!alpha.hasTransparency||!alpha.hasVisiblePixels)throw Error('AI抠图未返回有效透明主体，请重新抠图或改用SVG');details.alpha=alpha;}
              details={...details,origin:args.method==='cutout'?'ai-cutout':'generated-rebuild',prompt,model:cfg.model};
            }
            return {id,file:path.basename(target),name:'工具重建 · '+String(args.description||args.key).slice(0,300),kind:'image',generated:true,reconstructed:true,purpose:'reconstruction',sha256:fileHash(target),size:fs.statSync(target).size,sourcePreviewHash:page.previewHash,sourceElement:args.key,...details,createdAt:new Date().toISOString()};
          },
          renderScene:async(draft,assets)=>{const imageURL=id=>dataURL(assets.some(a=>a.id===id)?path.join(env.data,p.id,'assets',assets.find(a=>a.id===id).file):env.getImage(p,id)),bytes=new Resvg(nativeSVG(draft.elements,imageURL,draft.background),{font:{loadSystemFonts:true}}).render().asPng();publishRebuildPage(p,env,{index:i,round,source:'scene',bytes});return 'data:image/png;base64,'+bytes.toString('base64');},
          record:entry=>{fs.mkdirSync(recordDir,{recursive:true});fs.writeFileSync(path.join(recordDir,`page-${i+1}-round-${round}.json`),JSON.stringify(entry,null,2));}
        });
      },{signal,limit:concurrencyLimit(p.executionConcurrency),label:r=>'主模型工具修正 · 第 '+(r.index+1)+' 页 · 第 '+round+' 轮',settle:true});
      env.save(p);return {changed:results.some(r=>r.status==='fulfilled'&&r.value.changed),changedIndices:results.flatMap((r,n)=>r.status==='fulfilled'&&r.value.changed?[failed[n].index]:[]),errors:results.filter(r=>r.status==='rejected').map(r=>r.reason.message)};
    }
  });
  p.rebuildLive.status='done';p.rebuildLive.revision++;env.save(p);
  p.task.completionMessage=p.candidate.status==='awaiting_review'&&p.candidate.visualRepair.status==='passed'?`实际渲染与视觉对照通过${p.candidate.visualRepair.rounds?'，自动修正 '+p.candidate.visualRepair.rounds+' 轮':''}，可下载最新PPT，继续按页调整`:p.candidate.visualRepair.status==='review_unavailable'?'已保留 PPT、实际渲染与返回记录；部分页面视觉验收未完成，请重新验收':`已保留实际渲染、视觉问题与工具记录；自动修正 ${p.candidate.visualRepair.rounds}/${rebuildVisualRepairLimit} 轮，仍需修改`;
}
function representativePages(p){
  const eligible=confirmedPages(p),cover=eligible.find(i=>p.slides[i].kind==='cover'),toc=eligible.find(i=>p.slides[i].kind==='toc'),complex=eligible.filter(i=>!['cover','toc'].includes(p.slides[i].kind)).sort((a,b)=>canonicalTexts(p.slides[b]).length-canonicalTexts(p.slides[a]).length)[0];
  const indices=[...new Set([cover,toc,complex].filter(i=>i!==undefined))];return indices.length?indices:eligible.slice(0,1);
}
function conceptFoundationReadiness(p){
  const issues=[];
  if(!themeAssetsCurrent(p)||p.themeAssets.directions?.length!==3)issues.push('请在03视觉方案先确认三种风格并生成对应底图');
  else for(const d of p.themeAssets.directions)for(const i of representativePages(p))try{requireThemeAssetForPage(p,i,d.id);}catch(e){issues.push(e.message);}
  return {passed:!issues.length,issues};
}
export async function visualAction(p,b,env){
  if(!actionNames.has(b.action))return false;
  const {ensure,launch,event,save}=env;
  if(b.action==='deleteRegisteredStyle'){deleteRegisteredStyle(p,b.styleId);event(p,'已删除登记风格，既有方案与历史来源保留');return true;}
  if(b.action==='restoreAIImage'){
    ensure(p,['theme','visual'].includes(b.targetType),'仅支持撤回预览图或底图');
    const target=aiImageTarget(p,b);ensure(p,b.sourceHash===target.sourceHash&&b.sourceRevision===(target.image.jobFile||target.image.file),'图片已变化，请重新打开修改窗口');
    const next=restoreImage(target.image,b.direction);
    ensure(p,next.stamp===target.image.stamp&&next.styleRegistrationId===target.image.styleRegistrationId,'历史图片的内容或风格已变化，不能恢复到当前页面');
    const file=next.file&&path.join(env.data,p.id,next.file),source=next.normalized&&path.join(env.data,p.id,next.normalized);
    ensure(p,file&&source&&fs.existsSync(file)&&fs.existsSync(source)&&fileHash(file)===next.previewHash,'历史图片文件缺失或已变化，未执行恢复');
    if(target.type==='theme'){
      const d=p.themeAssets.directions.find(d=>d.id===b.theme),draft=themePromptDraft(p,d,b.use);
      d.assets[b.use]=next;d.promptDrafts||={};
      d.promptDrafts[b.use]={prompt:next.redrawPrompt||next.promptDraft||next.prompt,revision:draft.revision+1,status:next.previewReview?.status==='passed'?'generated':'pending',updatedAt:new Date().toISOString()};
      p.themeAssets.status=themeAssetsReady(p)?'ready':'awaiting_confirmation';delete p.themeAssets.error;
    }else if(b.kind==='concept'){
      const c=p.concepts.find(c=>c.id===b.theme);c.representatives=c.representatives.map(r=>r.index===Number(b.index)?next:r);
      if(p.selectedTheme===c.id&&p.visualPages?.[b.index]?.conceptSource){delete p.visualPages[b.index];reuseConceptPreviews(p,env);}
    }else p.visualPages[b.index]=next;
    delete p.aiImageEditDrafts?.[target.key];invalidate(p);
    event(p,(b.direction==='undo'?'已撤回':'已重做')+(target.type==='theme'?'底图':'预览图')+'修改，恢复对应提示词与检查记录');return true;
  }
  if(b.action==='regenerateThemeDirection'||b.action==='changeThemeDirection'){
    ensure(p,themeAssetsCurrent(p),'底图已过期，请先重新规划三方向底图');
    ensure(p,p.themeAssets.directions.some(d=>d.id===b.theme),'底图方向不存在');
    const instruction=b.instruction??'',referenceStyleId=b.referenceStyleId??null;
    ensure(p,typeof instruction==='string'&&instruction.length<=3000,'风格要求不超过 3000 字');
    ensure(p,referenceStyleId===null||typeof referenceStyleId==='string'&&(/^[A-F]$/.test(referenceStyleId)||(p.styleRegistry||[]).some(r=>r.id===referenceStyleId&&!r.deletedAt)),'参考风格不存在');
    ensure(p,!!env.credentials.get(p.id)?.text?.key,'请先连接主模型 API');
    const changeStyle=b.action==='changeThemeDirection';
    launch(p,changeStyle?'更换方向底图风格':'准备底图重生提示词',async signal=>{
      const prepared=await prepareThemeDirection(p,env,signal,{direction:b.theme,changeStyle,instruction:instruction.trim(),referenceStyleId});
      stageThemePrompts(p,b.theme);save(p);
      p.task.completionMessage='方向 '+b.theme.toUpperCase()+(changeStyle?(prepared.styleSource==='preset'?' 已引用预设 '+prepared.styleRegistrationId+'，完整提示词已同步':' 的新主色 '+prepared.coreColor+' 与原创风格已登记，完整提示词已同步'):' 的完整提示词已准备')+'，请核对确认后生成；其他方向保留';
    });return true;
  }
  if(b.action==='regenerateThemePrompts'){
    const visualTreatment=b.visualTreatment===undefined?p.visualTreatment:normalizeVisualTreatment(b.visualTreatment);
    ensure(p,p.slides.length>0&&themeAssetsCurrent(p),'请先在03规划当前需求的三方向风格');
    ensure(p,!p.materials.some(m=>!m.generated)||analysisCurrent(p),'请先完成材料理解');
    ensure(p,!!env.credentials.get(p.id)?.text?.key,'请先连接主模型 API');
    launch(p,'重新规划三种风格与提示词',async signal=>{
      await regenerateThemePrompts(p,env,signal,{visualTreatment});
      p.task.completionMessage='三种新风格与对应提示词已重新规划；旧底图保留在风格历史中，请核对确认后生成新底图';
    });return true;
  }
  if(b.action==='generateThemeAssets'||b.action==='generateThemeAsset'){
    ensure(p,p.slides.length>0,'请先在02生成逐页内容，再到03确认三种风格与底图');
    ensure(p,!p.materials.some(m=>!m.generated)||analysisCurrent(p),'请先完成材料理解，再规划底图提示词');
    if(b.action==='generateThemeAssets'&&b.prompts===undefined){
      const visualTreatment=normalizeVisualTreatment(b.visualTreatment??p.visualTreatment);
      ensure(p,!!env.credentials.get(p.id)?.text?.key,'请先连接主模型 API');
      launch(p,'规划三方向底图提示词',async signal=>{if(themeAssetsCurrent(p)&&p.themeAssets.directions?.length===3&&visualTreatment!==p.visualTreatment)await regenerateThemePrompts(p,env,signal,{visualTreatment});else await planThemeAssets(p,env,signal,{force:!!b.force,visualTreatment});p.task.completionMessage='三种风格与底图提示词已准备，请在03核对、修改并确认后生成底图，再生成预览';});return true;
    }
    const imageEdit=crossThemeEdit(p,b)||imageEditExecution(p,b);
    const submissions=b.action==='generateThemeAsset'?[{theme:b.theme,use:b.use,prompt:imageEdit?.redrawPrompt||b.prompt,revision:b.revision}]:b.prompts;
    validateThemePromptSubmission(p,submissions,b.confirmed);
    imageConfig(env,p);
    launch(p,'生成三方向主题底图',async signal=>{
      if(!imageEdit){p.concepts=[];p.selectedTheme=null;p.visualPages={};}invalidate(p);
      await generateThemeAssets(p,env,signal,{prompts:submissions,confirmed:true,imageEdit});
      p.task.completionMessage='底图已生成并保存；点击“生成三版预览”继续，不进行底图自动检查或修正';
    });return true;
  }
  if(b.action==='rewriteThemeAssetPrompt'){
    const d=p.themeAssets?.directions.find(d=>d.id===b.theme);
    ensure(p,themeAssetsCurrent(p)&&!!d&&['hero-image','toc-image','content-background'].includes(b.use),'底图方向或用途不存在或已过期');
    ensure(p,themePromptDrafts(p).some(r=>r.theme===b.theme&&r.use===b.use),'该页型未启用');
    const draft=themePromptDraft(p,d,b.use),instruction=String(b.instruction||'').trim(),prompt=b.prompt??draft.prompt;
    ensure(p,typeof prompt==='string'&&instruction.length>0&&instruction.length<=3000&&prompt.length<=30000,'请填写有效的底图修改意见');
    ensure(p,b.revision===draft.revision,'提示词已更新，请重新打开后修改');
    launch(p,'改写底图提示词',async signal=>{
      const answer=await chat(env.credentials.get(p.id)?.text,env.system,`按自然语言修改无字主题底图提示词。${themePromptWritingRuleFor(b.use)}${visualTreatmentContext(p)}以当前稿为依据，以用户意见替换对应旧要求，每项视觉要求只出现一次，不拼接示例或历史版本；输出一份可独立生成的完整新提示词，替换旧稿；不附原稿、修改记录或追加说明。保持主题与全篇材料共同主线，艺术意象可以调整，不要求材料实物；封面与目录在主体、形态或视觉效果上至少一项不同；保留已选预设的视觉语言与主题点缀、核心底色 ${promptColor(presetPageColor(d,b.use))}、16:9（1920×1080）、阅读留白及非事实边界。${promptColorRule}${themeSubjectBriefGuidance}主体要求：${themeAssetSubjectRule(b.use)}。不加文字、图注、文本框或占位框。输出 {prompt:"完整新提示词"}。\n主体来源：${JSON.stringify(d.subjectSources?.[{'hero-image':'heroSubject','toc-image':'tocSubject','content-background':'contentSubject'}[b.use]]||{})}\n主题灵感材料：${JSON.stringify(themeMaterialContext(p))}\n用户意见：${instruction}\n原提示词：${prompt}`,signal,{validate:raw=>{textFieldValidator('prompt',{min:11,max:30000})(raw);validateSingleThemePrompt(raw.prompt);return raw;}});
      const rawPrompt=parseJSON(answer.text).prompt;const next=typeof rawPrompt==='string'?simplifyPromptColors(rawPrompt):rawPrompt;ensure(p,typeof next==='string'&&next.trim().length>10&&next.length<=30000,'改写底图提示词无效');
      d.promptDrafts||={};d.promptDrafts[b.use]={prompt:next,revision:draft.revision+1,status:'pending',updatedAt:new Date().toISOString()};
      p.themeAssets.status='awaiting_confirmation';p.task.completionMessage='完整提示词已改写，请核对并确认后生成图片';
    });return true;
  }
  if(b.action==='setThemeBackgroundUse'){
    ensure(p,themeAssetsCurrent(p)&&typeof b.enabled==='boolean','请先生成当前底图');const d=p.themeAssets.directions.find(d=>d.id===b.theme);ensure(p,!!d,'方向不存在');d.useContentBackground=true;event(p,'AI预览固定使用对应内容底图进行图生图');return true;
  }
  if(b.action==='concepts'){
    const eligible=confirmedPages(p);ensure(p,eligible.length>0,'请先确认至少一页单页设计稿；只为已确认页面生成视觉方案');imageConfig(env,p);
    const foundationState=conceptFoundationReadiness(p);ensure(p,foundationState.passed,foundationState.issues.join('；'));
    const representatives=representativePages(p);for(const d of p.themeAssets.directions)for(const i of representatives)foundationReference(p,i,d,env);
    launch(p,'生图生成三版视觉方案',async signal=>{
      let raw=p.themeAssets.directions.map(d=>({...d}));
      raw=registerStyleDirections(p,raw,'concepts');save(p);
      const folder=path.join(env.data,p.id,'visual',crypto.randomUUID());fs.mkdirSync(folder,{recursive:true});const concepts=[];
      for(let n=0;n<3;n++)concepts.push({...themes[n],...validateStyleDefinition(raw[n],p,{allowDeleted:true}),styleRegistrationId:raw[n].styleRegistrationId,presetDesign:raw[n].presetDesign,...(raw[n].paletteSource?{paletteSource:raw[n].paletteSource}:{}),styleSelection:raw[n].styleSelection,styleSummary:raw[n].style,id:['a','b','c'][n],name:raw[n].name,description:raw[n].description,style:describeStyle(raw[n]),mode:'ai',expectedPages:representatives,representatives:[]});
      p.concepts=concepts;p.visualMode='ai';p.selectedTheme=null;p.visualPages={};invalidate(p);p.stage=4;save(p);
      const jobs=concepts.flatMap(c=>representatives.map(index=>({c,index})));
      const generated=await runConcurrent(jobs,async({c,index})=>{c.representatives.push(await generatePage(p,index,c,env,signal,folder,'concept',undefined,{deferReview:true}));save(p);},{signal,limit:concurrencyLimit(p.executionConcurrency),label:({c,index})=>'方向 '+c.id.toUpperCase()+' · 第 '+(index+1)+' 页',settle:true});
      const reviewed=await runConcurrent(jobs.filter(({c,index})=>c.representatives.some(r=>r.index===index)),async({c,index})=>{try{return await reviewAndRepairPage(p,index,c,env,signal,c.representatives.find(r=>r.index===index),'concept');}finally{save(p);}},{signal,limit:concurrencyLimit(p.executionConcurrency),label:({c,index})=>'方案检查 · 方向 '+c.id.toUpperCase()+' · 第 '+(index+1)+' 页',settle:true});
      concepts.forEach(c=>c.representatives.sort((a,b)=>a.index-b.index));
      if(signal.aborted)throw Error('任务已取消');p.concepts=concepts;p.visualMode='ai';p.selectedTheme=null;p.visualPages={};invalidate(p);p.stage=4;
      const failed=[...generated,...reviewed].filter(r=>r.status==='rejected');if(failed.length)throw Error('本步有 '+failed.length+' 个请求失败，已保留生成图片与检查记录：'+failed.map(r=>r.reason.message).join('；'));
      finishVisualChecks(p,concepts.flatMap(c=>c.representatives),'三版视觉方案');
    });return true;
  }
  if(b.action==='selectTheme'){
    ensure(p,p.concepts.some(c=>c.id===b.id),'视觉方案不存在');ensure(p,p.concepts.find(c=>c.id===b.id)?.mode==='ai','旧模板方案不能进入新的交付管线，请先确认单页设计稿并重新生图');
    const direction=p.concepts.find(c=>c.id===b.id),readiness=conceptReadiness(p,direction);
    ensure(p,readiness.selectable,readiness.blockingIssues.join('；'));
    for(const i of direction.expectedPages||direction.representatives.map(r=>r.index)){
      const page=direction.representatives.find(r=>r.index===i),file=path.join(env.data,p.id,page.file);
      ensure(p,fs.existsSync(file)&&fileHash(file)===page.previewHash,'代表页图片不存在或已变化，请重新生成该页');
    }
    p.visualDirectionSelection={theme:b.id,at:new Date().toISOString(),acceptedReviewIssues:readiness.reviewIssues,pages:direction.representatives.map(r=>({index:r.index,previewHash:r.previewHash,reviewStatus:r.previewReview?.status||'unchecked'}))};
    if(p.selectedTheme!==b.id){p.selectedTheme=b.id;p.visualPages={};invalidate(p);}const reused=reuseConceptPreviews(p,env);p.stage=5;event(p,'已选择生图视觉方向'+(reused.length?'，'+reused.length+' 张代表页已直接用于全篇预览':'')+'，其余已确认页面可继续生成');return true;
  }
  if(b.action==='generateConceptPage'){
    const i=Number(b.index),c=p.concepts.find(c=>c.id===b.theme);ensure(p,c?.mode==='ai'&&(c.expectedPages||c.representatives.map(r=>r.index)).includes(i),'代表页不存在');ensure(p,pageDesignState(p,i)?.approvedCurrent,'只能生成已确认页面');imageConfig(env,p);
    const imageEdit=crossPreviewEdit(p,b)||imageEditExecution(p,b);if(imageEdit?.crossStyle)ensure(p,imageEdit.crossStyle.sourceStamp===pageStamp(p,i,imageEdit.crossStyle.sourceDirection),'来源预览已过期，请先更新同页预览');if(!imageEdit)foundationReference(p,i,c,env);
    launch(p,'重新生图视觉代表页',async signal=>{const folder=path.join(env.data,p.id,'visual',crypto.randomUUID());fs.mkdirSync(folder,{recursive:true});const next=await generatePage(p,i,c,env,signal,folder,'concept',b.prompt, {deferReview:true,imageEdit});rememberImage(c.representatives.find(r=>r.index===i),next);c.representatives=[...c.representatives.filter(r=>r.index!==i),next].sort((a,b)=>a.index-b.index);if(p.selectedTheme===c.id){delete p.visualPages?.[i];invalidate(p);}p.stage=4;save(p);try{await reviewAndRepairPage(p,i,c,env,signal,next,'concept');finishVisualChecks(p,[next],'视觉代表页');}finally{if(p.selectedTheme===c.id)reuseConceptPreviews(p,env);save(p);}});return true;
  }
  if(b.action==='generateFullPreview'){
    ensure(p,!!p.selectedTheme,'请先选择生图视觉方向');const indices=b.index===undefined?confirmedPages(p):[Number(b.index)];ensure(p,indices.length>0&&indices.every(i=>pageDesignState(p,i)?.approvedCurrent),'只能生成已确认设计稿的页面');imageConfig(env,p);
    const imageEdit=imageEditExecution(p,b);ensure(p,!imageEdit||b.index!==undefined,'修改图片时请选择单页');
    reuseConceptPreviews(p,env);
    if(!imageEdit)for(const i of indices.filter(i=>!fullPageCurrent(p,i)||b.force||b.index!==undefined))foundationReference(p,i,p.concepts.find(c=>c.id===p.selectedTheme),env);
    launch(p,'生图生成完整预览',async signal=>{
      const theme=p.concepts.find(c=>c.id===p.selectedTheme),folder=path.join(env.data,p.id,'visual',crypto.randomUUID());fs.mkdirSync(folder,{recursive:true});const pages={...p.visualPages};
      const targets=indices.filter(i=>!fullPageCurrent(p,i)||b.force||b.index!==undefined),generated=await runConcurrent(targets,async i=>{
        const next=await generatePage(p,i,theme,env,signal,folder,'full',b.prompt,{deferReview:true,imageEdit});if(signal.aborted)throw Error('任务已取消');pages[i]=rememberImage(pages[i],next);p.visualPages={...pages};invalidate(p);save(p);
      },{signal,limit:concurrencyLimit(p.executionConcurrency),label:i=>'完整预览 · 第 '+(i+1)+' 页',settle:true});
      const reviewed=await runConcurrent(targets.filter((i,n)=>generated[n].status==='fulfilled'),async i=>{try{return await reviewAndRepairPage(p,i,theme,env,signal,pages[i],'full');}finally{p.visualPages={...pages};save(p);}},{signal,limit:concurrencyLimit(p.executionConcurrency),label:i=>'预览检查 · 第 '+(i+1)+' 页',settle:true});
      if(signal.aborted)throw Error('任务已取消');p.visualPages=pages;invalidate(p);p.stage=5;
      const failed=[...generated,...reviewed].filter(r=>r.status==='rejected');if(failed.length)throw Error('本步有 '+failed.length+' 个请求失败，已保留生成图片与检查记录：'+failed.map(r=>r.reason.message).join('；'));finishVisualChecks(p,Object.values(pages),'完整预览');
    });return true;
  }
  if(b.action==='checkVisualPage'){
    const i=Number(b.index),concept=b.kind==='concept',direction=p.concepts.find(c=>c.id===(concept?b.theme:p.selectedTheme)),page=concept?direction?.representatives.find(r=>r.index===i):p.visualPages?.[i];
    ensure(p,!!page?.jobFile&&!!direction&&pageDesignState(p,i)?.approvedCurrent&&page.stamp===pageStamp(p,i,direction.id),'本页图片未生成或已过期，请先生成当前版本');rebuildConfig(env,p);
    launch(p,'复查已有图片',async signal=>{if(!concept)invalidate(p);page.previewReview={status:'pending',issues:[]};save(p);try{await reviewGeneratedPage(p,i,direction,env,signal,page,concept?'concept':'full');finishVisualChecks(p,[page],'图片复查');}finally{save(p);}});return true;
  }
  if(b.action==='reviewPreviewPage'){
    const i=Number(b.index);ensure(p,fullPageCurrent(p,i),'本页预览已过期或未生成');ensure(p,b.checked===true,'请先实际查看该页文案结构、图片与版式');p.visualPages[i].manualReview={previewHash:p.visualPages[i].previewHash,at:new Date().toISOString()};event(p,`第 ${i+1} 页完整预览已检查`);return true;
  }
  if(b.action==='approvePreview'){
    const approval=previewApprovalRecord(p,b);
    for(const r of p.slides.map((s,i)=>p.visualPages[i])){const file=r.file&&visualFile(env,p,r);ensure(p,file&&fs.existsSync(file)&&fileHash(file)===r.previewHash,'预览图片文件缺失或已变化，请重新生成当前图片');}
    if(b.confirmAllPages===true)for(const r of p.slides.map((s,i)=>p.visualPages[i]))r.manualReview={previewHash:r.previewHash,at:approval.at,confirmedVia:'preview-approval'};
    p.previewApproval=approval;p.approvals.preview=p.version;p.candidate=null;p.output=null;p.stage=6;event(p,approval.acceptedIssues.length?'已确认接受预览检查问题，进入05拆解、重建与验收':'已批准完整预览，进入05拆解、重建与验收');return true;
  }
  if(b.action==='discardReconstruction'){p.reconstruction=null;p.candidate=null;p.output=null;event(p,'已清除重建结果，下次构建将重新拆解');return true;}
  if(b.action==='undoRebuildEdit'){const index=Number(b.index);ensure(p,Number.isInteger(index)&&!!p.slides[index]&&rebuildUndoState(p,index).available,'本页没有可撤回的修改，或版本已变化');const restored=undoRebuildEdit(p,index);event(p,'已撤回：'+restored.label);if(restored.requiresRender)launch(p,'撤回第 '+(index+1)+' 页修改并更新导出',async signal=>{await buildCandidate(p,env,signal,{repairLimit:0,preserveReconstruction:true});p.task.completionMessage='已撤回第 '+(index+1)+' 页并更新导出，其他页面保持不变';});return true;}
  if(b.action==='reviseRebuildElement'||b.action==='extractRebuildRegion'){
    const index=Number(b.index),instruction=String(b.instruction||'').trim();
    ensure(p,Number.isInteger(index)&&!!p.slides[index]&&rebuiltCurrent(p)&&p.approvals.preview===p.version,'请先完成当前版本素材拆解并确认完整预览');
    ensure(p,instruction.length>=2&&instruction.length<=6000,'请填写元素描述或修改要求（最多6000字）');
    const page=p.reconstruction.slides[index],target=b.action==='reviseRebuildElement'?page.elements.find(e=>e.key===b.key):null;
    if(b.action==='reviseRebuildElement'){ensure(p,!!target,'指定元素已不存在，请刷新素材清单');ensure(p,!b.targetStamp||b.targetStamp===digest(target),'此元素已变化，请刷新后重新提交修改');}
    if(b.action==='extractRebuildRegion')ensure(p,b.previewHash===p.visualPages[index].previewHash,'预览已变化，请重新框选补拆区域');
    const regionScope=b.action==='extractRebuildRegion'?extractionScope(b.region,page.elements):null;
    rememberRebuildEdit(p,regionScope?'第 '+(index+1)+' 页补拆元素':'第 '+(index+1)+' 页修改元素 '+target.key,index);
    const recordKey=regionScope?'region-'+crypto.randomUUID():index+':'+target.key,feedback={index,instruction,...(target?{targetKey:target.key}:{regionScope})};
    p.rebuildElementFeedback??={};p.rebuildElementFeedback[recordKey]={index,key:target?.key||null,instruction,status:'pending',at:new Date().toISOString()};
    launch(p,regionScope?'框选区域补拆与渲染':'单元素修改与渲染',async signal=>{
      await buildCandidate(p,env,signal,{feedback:[feedback]});
      p.rebuildElementFeedback[recordKey].status=p.candidate.visualRepair.pendingFeedback.some(f=>f.index===index)?'pending':'applied';save(p);
    });return true;
  }
  if(b.action==='reviseRebuildAssets'){
    const index=Number(b.index),instruction=String(b.instruction||'').trim();
    ensure(p,Number.isInteger(index)&&!!p.slides[index]&&rebuiltCurrent(p),'请先完成当前页素材拆解');
    ensure(p,instruction.length>=2&&instruction.length<=6000,'请填写素材增删或调整意见（最多6000字）');
    ensure(p,p.approvals.preview===p.version,'请先确认当前版本完整预览');
    rememberRebuildEdit(p,'第 '+(index+1)+' 页素材增删',index);p.rebuildAssetFeedback??={};p.rebuildAssetFeedback[index]={instruction,status:'pending',at:new Date().toISOString()};
    launch(p,'按素材增删意见重建与渲染',async signal=>{
      await buildCandidate(p,env,signal,{feedback:[{index,instruction}]});
      p.rebuildAssetFeedback[index].status=p.candidate.visualRepair.pendingFeedback.some(f=>f.index===index)?'pending':'applied';save(p);
    });return true;
  }
  if(b.action==='reconstructPreview'||b.action==='build'){
    ensure(p,p.approvals.preview===p.version&&p.slides.every((s,i)=>fullPageCurrent(p,i)),'请先批准当前版本完整生图预览');rebuildConfig(env,p);
    if(b.instruction!==undefined){const instruction=String(b.instruction).trim();ensure(p,instruction.length<=6000,'重建意见最多 6000 字');p.rebuildInstructions=instruction;if(instruction)p.reconstruction=null;}
    launch(p,b.action==='build'?'重建、渲染与交付验收':'拆解复杂视觉并重建素材',async signal=>{if(b.action==='build')await buildCandidate(p,env,signal);else{p.output=null;p.candidate=null;await rebuild(p,env,signal);}});return true;
  }
  if(b.action==='reviewReleasePage'){
    const base=verifyCandidate(p,env),i=Number(b.index),review=p.candidate.review.pages[i];ensure(p,!!review&&review.passed,'本页自动视觉验收尚未通过，请修正并重新构建');
    ensure(p,checkNames.every(k=>b.checks?.[k]===true),'请逐项核对版面、准确内容、原图、可编辑性及预览一致性');
    const notes=String(b.notes||'').trim();ensure(p,notes.length>=4&&notes.length<=3000,'请填写本页实际审阅说明');ensure(p,!review.deviations.length||b.acceptDeviations===true,'请明确确认列出的设计偏差');
    review.manual={checks:Object.fromEntries(checkNames.map(k=>[k,true])),notes,acceptedDeviations:b.acceptDeviations===true,at:new Date().toISOString()};
    const file=path.join(base,'qa-review.json');fs.writeFileSync(file,JSON.stringify(p.candidate.review,null,2));p.candidate.proofs.find(x=>x.file==='qa-review.json').sha256=fileHash(file);p.output=null;event(p,`第 ${i+1} 页渲染对照已复核`);return true;
  }
  if(b.action==='release'){
    const base=verifyCandidate(p,env),c=p.candidate;const standards=designAcceptance(p,c.review.pages);ensure(p,standards.passed,standards.issues.join('；'));ensure(p,c.structure.passed&&c.review.pages.length===p.slides.length&&c.review.pages.every(r=>r.passed&&r.manual&&checkNames.every(k=>r.manual.checks[k])),'release 未通过：必须逐页通过视觉验收并完成人工对照复核');
    c.proofs=c.proofs.filter(item=>!['delivery.zip','release-report.json','qa-report.md'].includes(item.file));
    const report={passed:true,designStandards:standards,mode:'web-release',candidateId:c.id,version:p.version,stamp:c.stamp,pptx_sha256:fileHash(path.join(base,c.file)),renderer:c.renderer,rendererVersion:c.rendererVersion,checks:{structure:true,exactNativeText:true,elementInventory:true,assetHashes:true,renderedPages:true,visualComparison:true,perPageReview:true},pages:c.review.pages,at:new Date().toISOString()};
    fs.writeFileSync(path.join(base,'release-report.json'),JSON.stringify(report,null,2));c.proofs.push({file:'release-report.json',sha256:fileHash(path.join(base,'release-report.json'))});
    fs.writeFileSync(path.join(base,'qa-report.md'),`# 交付验收报告\n\n渲染器：${c.renderer} ${c.rendererVersion}\n\n${c.review.pages.map(r=>`## S${String(r.index+1).padStart(2,'0')}\n\n模型：${r.notes}\n\n人工：${r.manual.notes}\n\n偏差：${r.deviations.join('；')||'无'}\n`).join('\n')}`);c.proofs.push({file:'qa-report.md',sha256:fileHash(path.join(base,'qa-report.md'))});
    const bundle=new JSZip();for(const item of c.proofs)bundle.file(item.file,fs.readFileSync(path.join(base,item.file)));for(const id of c.assetIds){const m=p.materials.find(m=>m.id===id);bundle.file('assets/'+m.file,fs.readFileSync(env.getImage(p,id)));}for(const [i,page] of Object.entries(p.visualPages)){bundle.file(`generation/S${String(+i+1).padStart(2,'0')}.json`,JSON.stringify(page,null,2));bundle.file(`generation/S${String(+i+1).padStart(2,'0')}-provider.png`,fs.readFileSync(path.join(env.data,p.id,page.source)));}fs.writeFileSync(path.join(base,'delivery.zip'),await bundle.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));c.proofs.push({file:'delivery.zip',sha256:fileHash(path.join(base,'delivery.zip'))});
    c.status='released';p.output={file:c.file,dir:c.dir,version:p.version,stamp:c.stamp,release:report,at:report.at};p.stage=7;event(p,'release 验收通过，已开放下载');return true;
  }
  if(b.action==='rewriteVisualPrompt'||b.action==='saveVisualPrompt'){
    const i=Number(b.index),page=b.kind==='concept'?p.concepts.find(c=>c.id===b.theme)?.representatives.find(r=>r.index===i):p.visualPages?.[i];ensure(p,!!page&&pageDesignState(p,i)?.approvedCurrent&&(b.kind==='concept'||fullPageCurrent(p,i)),'本页预览已过期或未生成');const prompt=String(b.prompt||page.promptDraft||page.redrawPrompt||page.prompt).trim();ensure(p,prompt.length>10&&prompt.length<=30000,'提示词长度须为 10–30000 字');
    if(b.action==='saveVisualPrompt'){page.promptDraft=prompt;event(p,'整页提示词草稿已保存');return true;}
    const instruction=String(b.instruction||'').trim();ensure(p,instruction.length>0&&instruction.length<3000,'请填写修改意见');launch(p,'改写整页生图提示词',async signal=>{const direction=p.concepts.find(c=>c.id===(b.kind==='concept'?b.theme:p.selectedTheme)),mode=b.kind==='concept'?'concept':'full';const r=await chat(env.credentials.get(p.id)?.text,env.system,`按用户要求修改以下整页生图提示词。${visualTreatmentContext(p)}${singleImagePromptRule}沿用七项Markdown顶层列表与分点结构：比例、内容、排版、底图与配图/图片占位框比例、风格、进度条、视觉关系。不单列“原图保真要求”；原图的平坦无字占位、等比贴回及主体完整要求写入底图与配图/图片占位框比例。文案逐字保留，其他说明从简，不设置凑字数的下限；排版段通常150–300字，只给大致分区和主要组的区域，不逐个描述文字框位置、相对大小、对齐细节或形状。${nestedPromptStructureRule}${slidePromptConcisenessRule}${placeholderAspectRewriteRule}${promptColorRule}${backgroundUse}保留已确认的分块选择及其表达作用，用户要求调整排版时按内容适配，${creativePromptWritingRule}层级完整保留在内容项，排版项仅概述主要分组和阅读方向，具体形状、装饰与局部组合由生图AI发挥。共用风格、框形与配色集中说明一次；风格要求尽量简短，只写气质、页面可用颜色、字体与层级、共同承载及少量装饰，不复述宏观布局、不罗列创意口号；具体特殊形态写入所属排版节点，不在风格项重复。复杂明确要求可合理加长，不删必要样式。不保留“简约要求”“紧密排版要求”或“可读性要求”等通用分点。只保留本页实际选择与用户修改意图，不附加验收条文、内部编号、精确位置坐标或具体字号；图片占位框的宽×高像素尺寸必须保留。全部文案、主副标题归属、原图身份与比例及页顶导航保持完整，不改变事实。输出 {prompt:"完整新提示词"}。\n用户要求：${instruction}\n原提示词：${prompt}`,signal,{validate:textFieldValidator('prompt',{min:11,max:30000})});const rawPrompt=parseJSON(r.text).prompt;const next=typeof rawPrompt==='string'?simplifyPromptColors(rawPrompt):rawPrompt;ensure(p,typeof next==='string'&&next.length>10&&next.length<=30000,'提示词无效');if(signal.aborted)throw Error('任务已取消');page.promptDraft=effectiveSlideImagePrompt(p,i,direction,page.images||[],mode,next);});return true;
  }
  return false;
}
export function visualPublic(p){return {visualTreatmentOptionsEnabled:true,singleElementEditing:true,regionExtraction:true,rebuildUndo:rebuildUndoState(p),rebuildAssets:rebuildAssetInventory(p),rebuildLive:rebuildLiveCurrent(p)?p.rebuildLive:null,candidateDownload:draftDownloadState(p),previewReviewRepairLimit,renderReviewRepairLimit,rebuildVisualRepairLimit,rebuildToolEditing:true,rebuildAssetTools:true,visualTextStyleNormalization:true,elementAuditRepairLimit:auditRepairLimit,visualColorNormalization:true,previewApprovalEnabled:true,previewApprovalState:previewApprovalState(p),styleRegistryDeletion:true,postPasteGeometryOnly:true,originalImageAspectAdjustmentEnabled:true,nestedContentPrompts:true,imagePromptVersion,aiImageEditModes:true,aiImageUndo:true,atomicContentConfirmation:true,previewImageToImage:true,placeholderRepairLimit,placeholderRatioTolerance,placeholderCountRepairLimit,conceptFoundationReadiness:conceptFoundationReadiness(p),themeDirectionActions:true,previewCrossStyleEditing:true,previewCrossStyleOptions:previewCrossStyleOptions(p),themeCrossStyleEditing:true,themeCrossStyleOptions:themeCrossStyleOptions(p),themePromptConfirmation:true,themeAutoContinue:false,themeBackgroundReview:false,themePromptRegeneration:true,themeAssetPrompts:themePromptDrafts(p),themeAssetsQualityBlocked:themeAssetsCurrent(p)&&p.themeAssets.directions?.length===3&&!themeAssetsReady(p),workflowLibrary:workflowLibrarySummary,themeAssetsCurrent:themeAssetsCurrent(p),themeAssetsReady:themeAssetsReady(p),automaticVisualRepairLimit:visualRepairLimit,conceptReadiness:Object.fromEntries(p.concepts.filter(c=>c.mode==='ai').map(c=>[c.id,conceptReadiness(p,c)])),designStandards:designAcceptance(p,p.slides.map((s,i)=>fullPageCurrent(p,i)?p.visualPages[i]:null)),confirmedVisualPages:confirmedPages(p),fullPreviewPages:p.slides.map((s,i)=>fullPageCurrent(p,i)),visualReconstructionCurrent:rebuiltCurrent(p),releaseCurrent:releaseCurrent(p)};}
export function visualRoute(p,parts,url,res,env){
  const {sendFile,ensure}=env;
  if(parts[3]==='rebuild-live-compare'){
    const index=Number(url.searchParams.get('index'));ensure(p,Number.isInteger(index)&&index>=0&&index<p.slides.length&&p.approvals.preview===p.version,'对比页不存在或预览已变化');
    const bytes=liveRebuildComparison(p,env,index);res.writeHead(200,{'content-type':'image/png','cache-control':'no-store'});res.end(bytes);return true;
  }
  if(parts[3]==='rebuild-asset-image'){
    const index=Number(url.searchParams.get('index')),key=url.searchParams.get('key');ensure(p,Number.isInteger(index)&&index>=0&&index<p.slides.length,'素材页不存在');
    const bytes=rebuildAssetImage(p,env,index,key);res.writeHead(200,{'content-type':'image/png','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(bytes);return true;
  }
  if(parts[3]==='rebuild-live-image'){
    const index=Number(url.searchParams.get('index')),page=p.rebuildLive?.pages?.[index];
    ensure(p,rebuildLiveCurrent(p)&&url.searchParams.get('run')===p.rebuildLive.id&&Number.isInteger(index)&&!!page,'实时重建图已过期或尚未生成');
    const file=path.join(env.data,p.id,page.file);ensure(p,fs.existsSync(file)&&fileHash(file)===page.sha256,'实时重建图不存在或已变化');sendFile(res,file,'image/png');return true;
  }
  if(parts[3]==='candidate-download'){
    ensure(p,draftDownloadState(p).available,'最后完成渲染的版本尚未就绪，请等待当前任务结束');
    ensure(p,url.searchParams.get('candidate')===p.candidate.id,'下载版本已变化，请刷新后下载最后一版');
    const base=verifyCandidate(p,env),type=url.searchParams.get('type')||'pptx';
    res.setHeader('x-ppt-agent-status','review-required');
    if(type==='report'){
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','content-disposition':'attachment; filename="deck-review-required-report.json"'});res.end(JSON.stringify(draftReviewReport(p),null,2));return true;
    }
    ensure(p,['pptx','pdf'].includes(type),'下载类型不存在');
    sendFile(res,path.join(base,type==='pptx'?p.candidate.file:'deck.pdf'),type==='pptx'?'application/vnd.openxmlformats-officedocument.presentationml.presentation':'application/pdf','deck-review-required.'+type);return true;
  }
  if(parts[3]==='preview'&&p.visualMode==='ai'){
    const i=Number(url.searchParams.get('slide')||0),theme=url.searchParams.get('theme');let page;
    if(theme)page=p.concepts.find(c=>c.id===theme)?.representatives?.find(r=>r.index===i);else if(fullPageCurrent(p,i))page=p.visualPages[i];
    const revision=url.searchParams.get('revision');if(revision){const old=page?.repairHistory?.find(r=>r.jobFile===revision);ensure(p,!!old,'历史版本不存在');page=old;}
    if(page){sendFile(res,visualFile(env,p,page),'image/png');return true;}
    const message=pageDesignState(p,i)?.approvedCurrent?'设计稿已确认 · 等待整页生图':'本页待编辑与确认';res.writeHead(200,{'content-type':'image/svg+xml','cache-control':'no-store'});res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#e4e6dd"/><text x="120" y="540" font-size="46" font-family="Microsoft YaHei" fill="#858975">${message}</text></svg>`);return true;
  }
  if(parts[3]==='review-image'){
    const index=Number(url.searchParams.get('index'));
    if(url.searchParams.get('kind')==='compare'&&p.task?.status==='running'&&rebuildLiveCurrent(p)&&p.rebuildLive.pages?.[index]){const bytes=liveRebuildComparison(p,env,index);res.writeHead(200,{'content-type':'image/png','cache-control':'no-store'});res.end(bytes);return true;}
    const base=verifyCandidate(p,env),i=Number(url.searchParams.get('index')),kind=url.searchParams.get('kind');ensure(p,Number.isInteger(i)&&i>=0&&i<p.slides.length,'审阅页不存在');const files={compare:`compare-${i}.png`,approved:`approved-${i}.png`,rebuilt:`rebuilt-${i}.png`,difference:`difference-${i}.png`,geometry:`geometry-${i}.png`,render:`S${String(i+1).padStart(2,'0')}.png`};ensure(p,!!files[kind]&&fs.existsSync(path.join(base,files[kind])),'审阅图类型不存在或尚未生成');sendFile(res,path.join(base,files[kind]),'image/png');return true;
  }
  if(parts[3]==='download'){
    ensure(p,releaseCurrent(p),'当前版本尚未通过渲染对照与 release 验收，下载未开放');const base=verifyCandidate(p,env),types={content:'content.json',notes:'speaker-notes.md',release:'release-report.json',qa:'qa-report.md',pdf:'deck.pdf',manifest:'render-manifest.json',bundle:'delivery.zip'},type=url.searchParams.get('type'),file=type?types[type]:p.output.file;ensure(p,!!file&&safeName(file)&&(!type||type!=='notes'||p.brief.speaker),'交付文件不存在');
    sendFile(res,path.join(base,file),file.endsWith('.pptx')?'application/vnd.openxmlformats-officedocument.presentationml.presentation':file.endsWith('.zip')?'application/zip':file.endsWith('.pdf')?'application/pdf':file.endsWith('.json')?'application/json':'text/markdown; charset=utf-8',file);return true;
  }
  return false;
}
