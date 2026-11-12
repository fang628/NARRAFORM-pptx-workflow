import {queuedPageTask,claimPageTask,finishPageTask} from './image-task-queue.mjs';
import {runPipelined} from './task-graph.mjs';
import {assetWorkerLimit,createOrderedFailureFlush,runBoundedTasks,runSettled,svgRenderLimit} from './visual-throughput.mjs';
import {renderSVG} from './render-pool.mjs';
import {applyRebuildQuality,rebuildPageIssues} from './rebuild-quality.mjs';
import {retainUnreviewedDraft} from './rebuild-draft.mjs';
import {localCutoutPlacement,localCutoutVersion} from './cutout-fallback.mjs';
import {prepareCompatibleCutout} from './compatible-cutout.mjs';
import {reusableCandidatePages,copyReusablePageFiles} from './candidate-page-cache.mjs';
import {svgColorVersion} from './svg-colors.mjs';
import {originalImageGeometry,originalPage,anchorOriginalElements} from './ppt-visual-optimization.mjs';
import {rebuildPageScope,markRebuildPages} from './rebuild-page-scope.mjs';
import {resolveArtisticTextKey,artisticMatteVersion} from './artistic-text.mjs';
import {unifyTitleFonts} from './title-fonts.mjs';
import {unifyPageBodyFonts,pageBodyFontRule} from './body-fonts.mjs';
import {unifyTitleAppearance} from './title-appearance.mjs';
import {unifyContentTitleColors,contentTitleColorRule} from './title-colors.mjs';
import {favoriteStyle,removeFavoriteStyle,importFavoriteStyle} from './style-favorites.mjs';
import {applyColorCalibration,measureColorCalibration} from './color-calibration.mjs';
import {colorAdjustmentRule} from './color-adjustment.mjs';
import {textSpacingRule} from './text-spacing.mjs';
import {prepareProgressReference} from './progress-reference.mjs';
import {prepareFooterReference} from './footer-page-number.mjs';
import {prepareElementFonts} from './automatic-fonts.mjs';
import {availableNativeFonts,nativeFontContext,resolveNativeFonts} from './native-fonts.mjs';
import {insertedInstanceManifest} from './rebuild-reuse.mjs';
import {themePhotoReference,themePhotoPlanningRule,selectedThemePhotoId,validatePhotoSubmissions} from './theme-photo-reference.mjs';
import {prepareRebuildPresentation,normalizeRebuildProgress,unifiedProgressRule,rebuildProgressAuditRule,rebuildProgressRegion,deliveryMotionPlan,deliveryMotionSettings,rebuildPresentationStamp} from './rebuild-progress.mjs';
import {normalizeVisualTreatment,visualTreatmentContext} from './visual-treatment.mjs';
import {saveEditRegionReference} from './image-edit-region.mjs';
import {reviewPreviewImage,previewReviewRepairLimit} from './preview-review.mjs';
import {textFieldValidator} from './text-retry.mjs';
import {contextualError} from './errors.mjs';
import {promptColorRule,promptColor,simplifyPromptColors} from './prompt-colors.mjs';
import {lightweightReviewRule} from './lightweight-review.mjs';
import {rebuildAppearanceRule,rebuildNumberRule,rebuildNumbersFor,rebuildHeadingBodyRule} from './rebuild-text-parts.mjs';
import {rebuildMethodRule,validateRebuildMethods} from './rebuild-methods.mjs';
import {createRebuildAssetStore,rebuildAssetIdentity} from './rebuild-reuse.mjs';
import {savedRebuildPages,incompleteRebuildPages,preservePartialElements} from './rebuild-page-state.mjs';
import {extractionScope} from './rebuild-region.mjs';
import {rememberRebuildEdit,rebuildUndoState,undoRebuildEdit} from './rebuild-undo.mjs';
import {visualTextStyle} from './visual-text-style.mjs';
import {auditedElements,auditRepairLimit} from './visual-audit-repair.mjs';
import {repairRebuiltPage} from './rebuild-tools.mjs';
import {rebuildReviewLoop,rebuildVisualRepairLimit} from './rebuild-review-loop.mjs';
import {reviewRenderedPage,renderReviewSchema,renderReviewRepairLimit} from './render-review.mjs';
import {startRebuildLive,publishRebuildPage,rebuildLiveCurrent,draftDownloadState,draftReviewReport,publishRebuildAssets,recoverRebuildScenes,rebuildAssetInventory,rebuildAssetImage,liveRebuildComparison} from './rebuild-output.mjs';
import {previewApprovalState,previewApprovalRecord} from './preview-approval.mjs';
import {rewriteSlidePromptRequest} from './slide-prompt-writing.mjs';
import {imageEditExecution,aiImageTarget} from './ai-image-edit.mjs';
import {crossThemeEdit,themeCrossStyleOptions,crossPreviewEdit,previewCrossStyleOptions} from './theme-cross-edit.mjs';
import {rememberImage,restoreImage} from './image-history.mjs';
import {slideImagePrompt,effectiveSlideImagePrompt,imagePromptVersion} from './slide-image-prompts.mjs';
import {presetPageColor} from './preset-design.mjs';
import {themeAssetSubjectRule,themeSubjectBriefGuidance,themePromptWritingRuleFor,validateSingleThemePrompt,themeDrawingPrompt} from './theme-image-prompts.mjs';
import {validateStyleDefinition,registerStyleDirections,requireStyleRegistration,registeredStyleContext,describeStyle,deleteRegisteredStyle} from './style-registry.mjs';
import {runConcurrent,projectWorkerLimit} from './concurrency.mjs';
import {reviewAndRepair,visualRepairLimit} from './visual-repair.mjs';
import {repairPlaceholders,placeholderCorrectionPrompt,placeholderRepairLimit,placeholderRatioTolerance,placeholderCountReport,placeholderCountRepairLimit} from './placeholder-review.mjs';
import {reportTask} from './task-progress.mjs';
import {themeAssetsCurrent,themeAssetsReady,requireThemeAssetForPage,generateThemeAssets,prepareThemeDirection,planThemeAssets,regenerateThemePrompts,stageThemePrompts,themePromptDraft,themePromptDrafts,validateThemePromptSubmission,checkThemePromptAtBoundary,checkThemePromptDrafts,themePromptCheckContext} from './theme-assets.mjs';
import {imagePromptCheck,finalizePromptDraft} from './image-prompt-check.mjs';
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
import {preferOriginalDecorationAssets} from './decoration-assets.mjs';
import {annotateTableObjects} from './table-objects.mjs';
import {executeRebuildStage,saveStagedPage,stagedRebuildEnabled,rebuildFittingMode,stageStatus} from './rebuild-stage-runner.mjs';
import {arrangeScene,foregroundVisibilityIssues,fitContentToParents,contentSafeAreas} from './scene-hierarchy.mjs';
import {fitFormulaScripts,rememberFormulaScriptRequest} from './formula-script-fit.mjs';
import {fittingTargetKeys} from './rebuild-incremental.mjs';
import {materialImageManifest} from './material-image-insertion.mjs';
import {buildVisualDeck} from './visual-build.mjs';
import {slideBackground} from './slide-background.mjs';
import {previewFoundationReference} from './preview-foundation.mjs';
import JSZip from 'jszip';
import {analyzeVisual} from './visual-analysis.mjs';
import {measureReferenceShapes,applyShapeRefinement,shapeRefinementInputs,reconstructionCorrespondence,beginReferenceTrial,settleReferenceTrial,referenceTrialRegions} from './reconstruction-refinement.mjs';
import {refineReferenceFonts} from './font-reference.mjs';
import {fitSVGReferenceStage,svgReferenceStageVersion,localRenderPolicy} from './svg-reference-stage.mjs';
import {restoreNativeFrames} from './native-frame-reference.mjs';
import {rebuildAuditPrompt,referenceEvidenceContext,sceneManifest,refinementTargets,auditDetailImages,measureElementQuality} from './rebuild-scene.mjs';
import {ensureSVGViewports} from './svg-viewport.mjs';
import {rebuildReferenceRule,designDiagnosticContext} from './rebuild-reference-policy.mjs';
import {optimizeTextLayout} from './text-layout.mjs';
import {refinePlaceholderGeometry} from './placeholder-geometry.mjs';
import {fittedImagePlans,imageMayStretch,repositionedImagePlans} from './image-geometry.mjs';
import {originalImagePlacementRule} from './image-placement-policy.mjs';
import {plannedImageGeometry,imagePlanningContext,prepareImageReadability} from './image-space-budget.mjs';
import {execFile} from 'node:child_process';

const actionNames=new Set(['favoriteStyle','removeFavoriteStyle','undoRebuildEdit','reviseRebuildElement','extractRebuildRegion','reviseRebuildAssets','deleteRegisteredStyle','restoreAIImage','generateThemeAssets','generateThemeAsset','regenerateThemeDirection','regenerateThemePrompts','changeThemeDirection','rewriteThemeAssetPrompt','setThemeBackgroundUse','concepts','selectTheme','generateFullPreview','generateConceptPage','checkVisualPage','reviewPreviewPage','approvePreview','reconstructPreview','repairRebuildPage','retryRebuildPage','setDeliveryMotion','discardReconstruction','build','reviewReleasePage','release','rewriteVisualPrompt','saveVisualPrompt']);
const checkNames=['visual','content','photos','editability','preview_match'];
const mime=file=>file.endsWith('.svg')?'image/svg+xml':file.endsWith('.jpg')?'image/jpeg':'image/png';
const dataURL=file=>'data:'+mime(file)+';base64,'+fs.readFileSync(file).toString('base64');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fileHash=file=>digest(fs.readFileSync(file));
const safeName=n=>/^[a-zA-Z0-9_.-]+$/.test(n);
function imageConfig(env,p){const cfg=env.credentials.get(p.id)?.image;if(!cfg?.key)throw Error('请先配置通用生图 API，三版方案和全篇预览均由该模型生成');return cfg;}
function cutoutConfig(env,p){const cfg=env.credentials.get(p.id)||{};return cfg.elementImage?.key?cfg.elementImage:cfg.image;}
function rebuildConfig(env,p){const cfg=visualModelConfig(env.credentials.get(p.id));if(!cfg)throw Error('请配置支持图片输入的主模型，或选填独立高性能视觉模型');return cfg;}
function python(env){const v=path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');return process.env.PPT_AGENT_PYTHON||(fs.existsSync(v)?v:'python');}
export async function assetTool(env,op,src,dest,signal,extra=[]){
  try{return JSON.parse((await env.run(python(env),[path.join(env.root,'tools','visual_assets.py'),op,src,dest,...extra],{windowsHide:true,maxBuffer:200000,timeout:60000,signal})).stdout);}
  catch(error){
    if(signal?.aborted||error.name==='AbortError')throw error;
    const detail=String(error.stderr||'').split(/\r?\n/).map(s=>s.trim()).reverse().find(s=>/^(?:ValueError|(?:xml\.etree\.ElementTree\.)?ParseError):/.test(s));
    if(!detail)throw error;
    throw Object.assign(new Error(`素材处理失败（${op}）：${detail.replace(/^[^:]+:\s*/,'')}`,{cause:error}),{code:'ASSET_VALIDATION_FAILED'});
  }
}
function invalidate(p){p.approvals.preview=null;p.previewApproval=null;p.output=null;p.candidate=null;p.reconstruction=null;}
function fullPagePromptCheckContext(p,index,direction,{originalPlan=[],references=[],imageEdit=null,foundation=null}={}){
  const original=originalPage(p,index),kind=p.slides[index].kind;
  return {title:p.slides[index].title,visualTreatment:p.visualTreatment,...(original?{originalPPTLayout:{preserve:true,nodeMap:original.nodeMap}}:{}),...(!original&&imageEdit?.region?{editRegion:imageEdit.region}:{}),coreColor:foundation?.coreColor||direction.coreColor,uniformBackgroundColor:direction.coreColor,background:foundation?.purpose||null,referenceImages:[...(references||[]),...(foundation?[foundation]:[])].filter((reference,position,all)=>all.findIndex(item=>item.materialId===reference.materialId&&item.purpose===reference.purpose)===position).map(reference=>({materialId:reference.materialId||null,role:reference.purpose,attachedToImageRequest:true})),registeredBackground:foundation?{materialId:foundation.materialId,subject:p.themeAssets?.directions.find(item=>item.id===direction.id)?.[kind==='cover'?'heroSubject':kind==='toc'?'tocSubject':'contentSubject'],coreColor:foundation.coreColor||direction.coreColor}:null,confirmedContent:canonicalTexts(p.slides[index],p,index),images:originalPlan.map(image=>({label:image.label,aspect:image.aspect,plannedSize:image.plannedSize})),retainOriginalPlaceholders:true};
}
function foundationReference(p,index,direction,env){
  const base=requireThemeAssetForPage(p,index,direction.id),file=path.join(env.data,p.id,base.normalized);
  if(!fs.existsSync(file)||fileHash(file)!==base.previewHash)throw Error('对应底图文件缺失或已被修改，请在03重新生成并检查底图');
  return {file:base.normalized,sha256:base.previewHash,purpose:base.intendedUse,materialId:base.materialId};
}
async function imagePlan(p,index,direction,env,signal,rendered,originals){
  const source=originals||plannedImages(p.slides[index]);if(!source.length&&!rendered)return [];
  if(!rendered&&originalPage(p,index))return originalImageGeometry(p,index,source).map(e=>({...e,label:p.materials.find(m=>m.id===e.id)?.name||'原稿内容图片'}));
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
export async function checkPagePromptAtBoundary(p,index,direction,env,signal,{prompt,originalPlan=[],references=[],imageEdit=null,foundation=null,repairOnly=false,manual=false,savedPromptCheck=null}={}){
  const context=fullPagePromptCheckContext(p,index,direction,{originalPlan,references,imageEdit,foundation});
  const protectedTexts=canonicalTexts(p.slides[index]).map(node=>node.text);
  const localPrompt=()=>finalizePromptDraft({stage:'整页预览',mode:imageEdit?.mode==='adjust'||repairOnly?'adjust':'generate',context,protectedTexts},prompt);
  // Persisted checks are metadata only (no prompt payload). Never let an archive
  // record swallow the current prompt: revalidate the live text locally and keep
  // the already-checked status without another remote review.
  const saved=imageEdit?.promptCheck||(savedPromptCheck&&savedPromptCheck.prompt===prompt?savedPromptCheck:null);
  if(saved)return {...saved,prompt:localPrompt().prompt};
  if(imageEdit||repairOnly||manual)return localPrompt();
  return imagePromptCheck({config:env.credentials.get(p.id)?.text,system:env.system,stage:'整页预览',mode:'generate',context,protectedTexts},signal)(prompt);
}
async function generatePage(p,index,direction,env,signal,folder,mode,override,{deferReview=false,editSource,imageEdit,repairOnly=false,redrawPrompt}={}){
  requireStyleRegistration(p,direction);
  const foundation=imageEdit||repairOnly?null:foundationReference(p,index,direction,env),stamp=pageStamp({...p,concepts:[direction]},index,direction.id);
  const previousPage=mode==='concept'?direction.representatives?.find(r=>r.index===index):p.visualPages?.[index];
  const recordedFoundation=foundation||((imageEdit||repairOnly)?previewFoundationReference(p,index,direction.id,previousPage):null);
  const originalPlan=await imagePlan(p,index,direction,env,signal);let prompt=imageEdit?imageEdit.prompt:repairOnly?override:effectiveSlideImagePrompt(p,index,direction,originalPlan,mode,override);
  // One check at the prompt-production boundary. Confirmed drafts, manual edits,
  // placeholder corrections and image-to-image edits use local validation only.
  const promptCheck=await checkPagePromptAtBoundary(p,index,direction,env,signal,{prompt,originalPlan,imageEdit,foundation,repairOnly,manual:!!override&&!imageEdit&&!repairOnly,savedPromptCheck:previousPage?.promptDraft===prompt?previousPage?.promptCheck:null});
  prompt=promptCheck.prompt;
  const prefix=mode+'-'+direction.id+'-'+index+'-'+crypto.randomUUID(),ledger=path.join(folder,prefix+'-job.json');
  const job={id:prefix,index,direction:direction.id,styleRegistrationId:direction.styleRegistrationId,stage:mode,stamp,...(imageEdit?.region?{editRegion:imageEdit.region}:{}),prompt,promptVersion:imagePromptVersion,factualBoundary:'事实原图以无字占位，比例复查后按登记参数本地回填；不生成替代证据',generationMode:imageEdit?.mode==='redraw'?'text-to-image':'image-to-image',foundation,model:imageConfig(env,p).model,requestSize:'1920x1080',actualRequestSize:'1920x1080',sizeFallback:'auto，仅在接口明确拒绝尺寸时使用',requiredAspect:'16:9',generationAttempts:[],...(promptCheck?{promptCheck:{...promptCheck,prompt:undefined}}:{}),status:'running',startedAt:new Date().toISOString()};
  const persist=()=>fs.writeFileSync(ledger,JSON.stringify(job,null,2));persist();
  try{
    const render=async(brief,currentFile,attempt,{repeatOriginal=false}={})=>{
      signal.throwIfAborted();if(foundation)foundationReference(p,index,direction,env);
      const references=repeatOriginal?structuredClone(job.generationAttempts[0].references):!attempt&&imageEdit?.references?imageEdit.references.map(r=>({...r,sha256:fileHash(path.join(env.data,p.id,r.file))})):[...(currentFile?[{file:currentFile,sha256:fileHash(path.join(env.data,p.id,currentFile)),purpose:attempt?'placeholder-repair-source':'repair-source'}]:[]),...(foundation?[foundation]:[])];
      const original=originalPage(p,index);
      if(!attempt&&original&&!references.some(r=>r.purpose==='original-ppt-layout')){const originalFile=path.join(env.data,p.id,original.reference);if(!fs.existsSync(originalFile)||fileHash(originalFile)!==original.referenceHash)throw Error('原PPT版式参考缺失，请在01重新理解材料');references.push({file:original.reference,sha256:original.referenceHash,purpose:'original-ppt-layout'});}
      if(!attempt&&imageEdit?.region)references.push(saveEditRegionReference(p,imageEdit,env,path.join(folder,prefix+'-region-hint.png')));
      const suffix=attempt?(repeatOriginal?'-count-':'-ratio-')+attempt:'',source=path.join(folder,prefix+suffix+'-provider.png'),normalized=path.join(folder,prefix+suffix+'-normalized.png');
      const entry={attempt,...(repeatOriginal?{retryReason:'placeholder-count'}:{}),generationMode:references.length?'image-to-image':'text-to-image',prompt:brief,...(!attempt?{promptCheck:{...promptCheck,prompt:undefined}}:{}),references,source:path.relative(path.join(env.data,p.id),source),normalized:path.relative(path.join(env.data,p.id),normalized),status:'running'};
      job.generationAttempts.push(entry);job.reference=references[0];job.references=references;persist();
      let bytes;
      try{bytes=await generatedImage(imageConfig(env,p),brief,signal,{size:'1920x1080',allowAutoSize:true,references:references.map(r=>({bytes:fs.readFileSync(path.join(env.data,p.id,r.file))})),onSizeFallback:size=>{job.actualRequestSize=size;entry.actualRequestSize=size;persist();}});}
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
    fs.writeFileSync(preview,await renderSVG(markup,{},signal));
    const record={index,theme:direction.id,...(recordedFoundation?{foundation:recordedFoundation}:{}),generationMode:job.generationMode,...(imageEdit?{...(imageEdit.region?{editRegion:imageEdit.region}:{}),imageEditMode:imageEdit.mode,parentSourceHash:imageEdit.target.sourceHash,...(imageEdit.crossStyle?{crossStyle:imageEdit.crossStyle}:{})}:{}),redrawPrompt:imageEdit?.redrawPrompt||redrawPrompt||prompt,styleRegistrationId:direction.styleRegistrationId,stamp,source:final.source,normalized:final.normalized,file:path.relative(path.join(env.data,p.id),preview),providerHash:final.providerHash,previewHash:fileHash(preview),dimensions:final.dimensions,prompt:final.prompt,promptCheck:final.promptCheck||job.promptCheck,promptVersion:imagePromptVersion,reference:final.references[0],references:final.references,placeholderReview:result.review,generationAttempts:job.generationAttempts,images:plan,previewReview:{status:'pending',issues:[]},jobFile:path.relative(path.join(env.data,p.id),ledger),model:imageConfig(env,p).model,at:new Date().toISOString()};
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
  fs.writeFileSync(file,await renderSVG(markup,{},signal));
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
async function rebuild(p,env,signal,{indices=null,resume=false,allowPartial=false}={}){
  // Progress-bar and footer reference lookups sample different files and fields;
  // they can overlap, and both finish before page reconstruction reads them.
  await runSettled([()=>prepareProgressReference(p,env,signal),()=>prepareFooterReference(p,env,signal)],{signal});
  prepareRebuildPresentation(p);
  reportTask(signal,{kind:'step',status:'done',message:(p.pageNumbers===true?'05已开启右下角小型粗体页码；':'')+(p.brief.progress===false?'05准备：页顶进度条已关闭，保留原生标题平滑切换与其他内容淡化':'05准备：已确定全篇统一的'+(p.deliveryMotion?.progressLayout==='bubble'?'气泡':'箭形')+'横列与章节文字，位置、颜色、阴影和描边取自同一张参考预览，由程序重建低矮单行横列并添加高亮滑动动画')});env.save(p);
  const cfg=rebuildConfig(env,p),stamp=visualStamp(p),seeds=indices||resume?savedRebuildPages(p):[],pages=structuredClone(seeds),auditRun=crypto.randomUUID();
  const installedFonts=await availableNativeFonts(),fontContext=nativeFontContext(installedFonts);
  const targets=indices||(resume?incompleteRebuildPages(p,seeds):p.slides.map((_,i)=>i));
  const reusableMaterials=[...p.materials,...(p.rebuildAssetPreview?.materials||[])];
  const previous=(indices||resume)&&p.rebuildAssetPreview?.stamp===stamp?p.rebuildAssetPreview:null;
  p.rebuildAssetPreview={stamp,version:p.version,revision:(previous?.revision||0)+1,pages:structuredClone(seeds.length?seeds:previous?.stamp===stamp?previous.pages:[]),materials:structuredClone(previous?.stamp===stamp?previous.materials||[]:[]),status:'extracting',...(indices?{retryIndices:[...indices]}:{})};env.save(p);
  const assetsDir=path.join(env.data,p.id,'assets');fs.mkdirSync(assetsDir,{recursive:true});const pending=[];
  const assetStore=createRebuildAssetStore({accept:m=>!m.localCutout||m.localCutoutVersion===localCutoutVersion,materials:reusableMaterials,getFile:m=>path.join(assetsDir,m.file)});
  let results,batchSettled=false;
  try{results=await runConcurrent(targets,async i=>{
    if(!fullPageCurrent(p,i))throw Error('请先生成并批准所有页面的完整预览');
    p.task.message=`拆解与重建 ${i+1}/${p.slides.length}`;env.save(p);
    const page=p.visualPages[i],source=visualFile(env,p,page),background=slideBackground(p,i),backgroundFile=env.getImage(p,background.id);
    if(!backgroundFile||fileHash(backgroundFile)!==background.sha256)throw Error('页面底图文件缺失或哈希不一致');
    const progressRegion=rebuildProgressRegion(p,i);

    const shapeReference=rebuildFittingMode(p)==='replace'?{status:'skipped',candidates:[],diagnostics:{method:'constrained-S3'}}:
      await measureReferenceShapes({env,project:p,index:i,reference:source,background:backgroundFile,exclude:[...(page.images||[]),...(progressRegion?[progressRegion]:[])],signal});
    const geometry={status:shapeReference.status,method:shapeReference.diagnostics?.method,candidates:shapeReference.candidates||[],record:shapeReference.record};
    const geometryHint=referenceEvidenceContext(shapeReference);
    const reuseNote=page.reused?'这张图是沿用的旧布局参考，图中文字可能属于旧版本。位置、形状、配色和图片沿用；所有原生文字必须用下方当前准确文案替换，新增或删除字段按当前内容树处理。尽量复用原有视觉素材，不为同步文字重新生成整页。\n':'';
    const prompt=rebuildAuditPrompt(p,i)+reuseNote;
    const acceptedPreviewIssues=p.previewApproval?.acceptedIssues?.length?'\n用户已确认继续的预览检查记录：'+JSON.stringify(p.previewApproval.acceptedIssues)+'。这些问题属于参考图的已知检查记录；重建以准确文案和登记素材为准，不宣称问题已经解决。':'';
    const backgroundInstruction=(progressRegion?'本项目顶部导航保留区：y='+progressRegion.y+'–'+(progressRegion.y+progressRegion.h)+'，正文与主标题置于该区域下方。':'本页不显示页顶进度条。')+acceptedPreviewIssues+`\n固定页面背景：${JSON.stringify(background)}。第二张图是已登记的无字底图，程序将原样写入 PPTX 的页面背景并铺满画布。只审计相对该底图新增的正文文字、内容承载、事实原图和装饰；不要重复拆解、裁剪、重画底图已有主体、渐变或纹理，不输出覆盖全页的底色块。新增元素须保留底图可见。第一张完整预览只用于排版对照，禁止用作页面背景。`;
    const auditRecords=[],auditDir=path.join(env.data,p.id,'audit-records',auditRun);
    let auditResult;const issues=[],failedElements=[],seed=seeds[i];
    if(indices&&previous?.stamp===stamp&&seed?.failedElements?.length&&seed.auditValidation?.status==='passed'&&Array.isArray(seed.audit)){
      try{
        const audit=validateAudit(normalizeRebuildProgress(p,i,seed.audit),p.slides[i],page.images,p,i);
        validateRebuildMethods(audit);
        auditResult={raw:{notes:seed.notes},audit,auditValidation:{...seed.auditValidation,reused:true}};
        auditRecords.push(...(seed.auditValidation.records||[]));
        reportTask(signal,{kind:'step',status:'done',message:'已复用本页通过的元素审计，重试未完成素材'});
      }catch{}
    }
    if(!auditResult)try{auditResult=await auditedElements({slide:p.slides[i],project:p,index:i,images:page.images,signal,
      inspect:async(elements,_raw,_attempt,options={})=>{
        if(rebuildFittingMode(p)==='replace'){
          const {stagedFit}=await import('./staged-fitting.mjs');
          return stagedFit({env,project:p,index:i,elements,reference:source,background:backgroundFile,signal,
            targetKeys:fittingTargetKeys(elements,options.targetKeys),python:python(env)});
        }
        return restoreNativeFrames({env,project:p,index:i,elements,reference:source,background:backgroundFile,exclude:progressRegion?[progressRegion]:[],signal,targetKeys:options.targetKeys,paintOnly:options.paintOnly});
      },
      request:async(correction,_attempt,detail={})=>{const closeups=await auditDetailImages(source,detail.regions||[],{signal});return chat(cfg,env.system,[{type:'text',text:(correction??prompt+backgroundInstruction+'\n重建修正意见：'+(p.rebuildInstructions||'无'))+geometryHint+'\n'+fontContext+(closeups.length?'\n附加局部图按以下1600×900区域顺序放大，仅辅助当前问题：'+JSON.stringify(detail.regions.slice(0,3)):'')},{type:'image_url',image_url:{url:dataURL(source)}},{type:'image_url',image_url:{url:dataURL(backgroundFile)}},...closeups],signal,{deferJSONValidation:true});},
      record:entry=>{fs.mkdirSync(auditDir,{recursive:true});const file=path.join('audit-records',auditRun,`page-${i+1}-attempt-${entry.attempt}.json`);fs.writeFileSync(path.join(env.data,p.id,file),JSON.stringify({index:i,previewHash:page.previewHash,stamp,model:cfg.model,...entry},null,2));auditRecords.push(file);},
      progress:message=>reportTask(signal,{kind:'step',status:'running',message})
    });}catch(error){
      if(signal.aborted)throw error;
      issues.push(error.message);auditResult={raw:{notes:'保留独立校验通过的元素，整页审计尚未通过'},audit:error.partialAudit||[],auditValidation:error.auditValidation||{status:'partial'}};
      if(rebuildFittingMode(p)==='replace'&&auditResult.audit.length){
        try{
          const {fitPartialAuditGeometry}=await import('./staged-fitting.mjs');
          const fitted=await fitPartialAuditGeometry({env,project:p,index:i,elements:auditResult.audit,reference:source,background:backgroundFile,signal,python:python(env)});
          auditResult.audit=fitted.elements;auditResult.auditValidation.nativeGeometry=fitted.report;
          reportTask(signal,{kind:'step',status:'done',message:'部分审计保留有效对象，已完成必要的S2/S3几何拟合；审计未通过状态保留'});
        }catch(fitError){
          if(signal.aborted)throw fitError;
          issues.push('部分审计对象S2/S3未完成：'+fitError.message);
          auditResult.auditValidation.geometryWarnings=[...(auditResult.auditValidation.geometryWarnings||[]),fitError.message];
        }
      }
    }
    const fontResult=await prepareElementFonts(p,env,auditResult.audit,signal,{index:i});
    const correspondence=reconstructionCorrespondence(auditResult.audit,{texts:canonicalTexts(p.slides[i],p,i).filter(n=>n.role!=='navigation'),images:page.images,frames:auditResult.auditValidation.frameInventory||[],candidates:shapeReference.candidates});
    {
      const decorated=preferOriginalDecorationAssets(anchorOriginalElements(p,i,normalizeRebuildProgress(p,i,fontResult.elements)),{project:p,index:i});
      // S2 table objects must survive the audit/font normalization: re-annotate (idempotent) so the
      // S3 table step and later paint/merge stages read the same single table object.
      try{auditResult.audit=annotateTableObjects(decorated,{project:p,index:i}).elements;}catch{auditResult.audit=decorated;}
    }auditResult.auditValidation.fontSubstitutions=fontResult.changes;
    const {raw,audit,auditValidation}=auditResult,assetTypes=['svg','cutout'];
    let elements=audit.filter(e=>!assetTypes.includes(e.type));
    const stagedMode=rebuildFittingMode(p);
    if(stagedMode==='replace'){
      // Replace mode: only decorative light-effect elements keep their measured appearance.
      // Every other element (including cards and the S2-measured title bands) goes through the
      // staged fitting stages.
      elements=elements.map(element=>{
        const decorative=element&&(String(element.role||'')==='effect'||element.effectOf
          ||String(element.visualKind||'')==='light-effect');
        return decorative?{...element,_stagedSkip:true}:element;
      });
    }
    if(stagedMode!=='replace'){
      // Incremental mode: keep committed native fitting and only touch raw shapes.
      elements=elements.map(element=>{
        if(!element||['text','image','svg','cutout'].includes(String(element.type)))return element;
        const committedNative=Boolean(element.shapeGeometry||element.customGeometry
          ||element.nativeRequired
          ||element.contourKind==='measured-title-band'
          ||element.role==='carrier'
          ||/^tcar-|title-plate/i.test(String(element.key||'')));
        return committedNative?{...element,_stagedSkip:true}:element;
      });
    }
    // Optional staged fitting (S2-complete -> S2r-route -> S3-shape -> S4/S5 paint -> S5b text
    // colour -> S6 merge). Production keeps its own audit (S1), PPTX build (S7), review (S8) and
    // delivery (S9); only the geometry/paint/merge stages are swapped in here.
    const fittingBase=structuredClone(elements);
    const fitNative=async()=>{
    let elements=fittingBase;
    if(stagedRebuildEnabled(p)){
      const stagedRunId=crypto.randomUUID(),records=[];
      try{
        const stages=await import('./rebuild-stages.mjs');
        const adapters=await import('./rebuild-adapters.mjs');
        const context={env,project:p,index:i,preview:source,elements,signal,gate:true,paintState:{},
          paintOccluders:audit.filter(element=>assetTypes.includes(element.type)),
          adapters:{fill:adapters.fillAdapter,stroke:adapters.strokeAdapter,merge:adapters.mergeAdapter}};
        const sequence=stagedMode==='replace'
          ?[['S5b-text-color',stages.textColorStage],['S4-fill',stages.fillStage],['S5-stroke',stages.strokeStage],['S6-merge',stages.mergeStage]]
          :[['S2-complete',stages.completeStage],['S2r-route',stages.routeStage],['S3-shape',stages.shapeStage],
            ['S5b-text-color',stages.textColorStage],['S4-fill',stages.fillStage],['S5-stroke',stages.strokeStage],['S6-merge',stages.mergeStage]];
        for(const [id,stage] of sequence){
          const output=await executeRebuildStage(id,stage,{...context,elements});
          elements=output.elements;
          records.push(output.record);
          if(output.record.status==='failed')break;
        }
        elements=adapters.normalizeStagedForRenderer(elements);
        // S8 refine for low-confidence geometries: render the page from native elements and
        // estimate a small local translation against the approved preview. The refine pass is
        // best-effort: unique per-attempt files, executor-first invocation and a bounded wait for
        // the result file so it can never break the page build.
        if(stagedMode!=='replace'&&stageStatus(records)!=='failed'&&elements.some(element=>element.lowConfidenceGeometry)){
          try{
            const {nativeSVG}=await import('./visual-model.mjs');
            const refineDir=path.join(env.data,p.id,'geometry-records','staged-refine','page-'+(i+1));
            fs.mkdirSync(refineDir,{recursive:true});
            const runTag=Date.now()+'-'+Math.random().toString(36).slice(2,8);
            const background=p.visualPages[i]?.foundation?.materialId?{id:p.visualPages[i].foundation.materialId}:null;
            const svg=nativeSVG(elements,id=>dataURL(env.getImage(p,id)),background);
            const renderedFile=path.join(refineDir,'S8-staged-render.png');
            fs.writeFileSync(renderedFile,await renderSVG(svg,{font:{loadSystemFonts:true}},signal));
            const refineInput=path.join(refineDir,'S8-refine-input-'+runTag+'.json');
            const refineOutput=path.join(refineDir,'S8-refine-'+runTag+'.json');
            fs.writeFileSync(refineInput,JSON.stringify({pageWidth:1600,pageHeight:900,
              elements:elements.filter(element=>element.lowConfidenceGeometry)},null,1));
            const command=[path.join(env.root,'tools','element_refine.py'),renderedFile,source,refineInput,refineOutput];
            try{
              if(typeof env.run==='function')await env.run(python(env),command,{windowsHide:true,maxBuffer:200000,timeout:120000,signal});
              else await execFile(python(env),command,{cwd:env.root,windowsHide:true,timeout:120000,signal});
            }catch(runError){
              records.push({stage:'S8-refine',status:'skipped',counts:{refined:0},
                note:'refine command failed: '+String(runError&&runError.message||runError).slice(0,160)});
            }
            let measured=null;
            for(let wait=0;wait<25;wait+=1){
              if(fs.existsSync(refineOutput)){
                try{measured=JSON.parse(fs.readFileSync(refineOutput,'utf8'));}catch{measured=null;}
                if(measured)break;
              }
              await new Promise(resolve=>setTimeout(resolve,100));
            }
            if(!measured){
              records.push({stage:'S8-refine',status:'skipped',counts:{refined:0},note:'no refine result file'});
            }else{
              try{fs.copyFileSync(refineOutput,path.join(refineDir,'S8-refine.json'));}catch{}
              const offsets=new Map((measured.results||[]).map(row=>[row.key,row]));
              if(offsets.size){
                elements=elements.map(element=>{
                  const offset=offsets.get(element.key);if(!offset)return element;
                  const dx=Math.max(-10,Math.min(10,Number(offset.dx)||0)),dy=Math.max(-10,Math.min(10,Number(offset.dy)||0));
                  return {...element,x:Math.round(Number(element.x)+dx),y:Math.round(Number(element.y)+dy),
                    refinedByS8:true,s8Offset:{dx:Math.round(dx*10)/10,dy:Math.round(dy*10)/10}};
                });
                records.push({stage:'S8-refine',status:'ok',counts:{refined:offsets.size}});
              }else{
                records.push({stage:'S8-refine',status:'ok',counts:{refined:0}});
              }
            }
          }catch(error){
            if(signal.aborted)throw error;
            records.push({stage:'S8-refine',status:'skipped',counts:{refined:0},
              note:String(error&&error.message||error).slice(0,200)});
          }
        }
        const result=saveStagedPage(p,i,stagedRunId,records);
        if(result.status!=='ok')issues.push('分阶段拟合未完整通过：'+records.filter(r=>r.status!=='ok').map(r=>r.stage+'：'+(r.error||r.reason||r.note||r.status)).join('；'));
        reportTask(signal,{kind:'step',status:result.status==='ok'?'done':'warning',message:result.status==='ok'?'分阶段拟合完成（S2–S6）':'分阶段拟合降级，保留最后有效元素并记录问题'});
      }catch(error){
        if(signal.aborted)throw error;
        const message=String(error&&error.message||error).slice(0,300);
        saveStagedPage(p,i,stagedRunId,records,message);issues.push('分阶段拟合失败：'+message);
      }
    }
    return elements;
    };
    // Audit geometry and ownership are frozen here. Independent assets may use the image/model
    // pool while native paint uses the local executor; combine both results in audit order.
    const fittingPromise=fitNative();
    fittingPromise.catch(()=>{});
    const publish=()=>{elements=arrangeScene(elements);publishRebuildAssets(p,env,i,preservePartialElements(seeds[i]?.elements||previous?.pages?.[i]?.elements||[],elements),pending,{status:issues.length?'partial':'extracting',issues,failedElements});};
    publish();
    const assetTasks=audit.filter(e=>assetTypes.includes(e.type));
    // Independent elements are prepared and generated concurrently; the shared
    // asset store still deduplicates identical in-flight elements into one material.
    // Failure records flush in audit order as soon as their earlier elements settle,
    // so one failed element shows its status without waiting for the whole page.
    const failedQueue=createOrderedFailureFlush(assetTasks.length,failed=>{issues.push(...failed.issues);failedElements.push(...failed.failedElements);});
    const assetPromise=runBoundedTasks(assetTasks,async(e,position)=>{
      let preparedCrop=null,attempted=null;
      const failed={issues:[],failedElements:[]};
      try{
      if(e.type==='cutout'){
        preparedCrop=await prepareCompatibleCutout({env,getImage:id=>env.getImage(p,id),assetTool,source,backgroundFile,sourceBox:e.sourceBox,elements:audit,targetKey:e.key,directory:assetsDir,signal,config:cutoutConfig(env,p),description:e.description||e.key,onProgress:message=>reportTask(signal,{kind:'step',status:'running',message:message+' · '+(e.description||e.key)})});
      }
      const identity=preparedCrop?.identity||rebuildAssetIdentity({method:e.type,svg:e.svg,geometry:{frameKind:e.frameKind,contourKind:e.contourKind,arrowRole:e.arrowRole}});
      const result=await assetStore.getOrCreate(identity,async()=>{
      const id=crypto.randomUUID(),file=id+(e.type==='svg'?'.svg':'.png'),target=path.join(assetsDir,file);attempted={id,file,target};let details={};
      if(e.type==='svg'){
        const temp=path.join(assetsDir,id+'.draft.svg');fs.writeFileSync(temp,e.svg);const vector=await assetTool(env,'svg',temp,target,signal,[String(Math.max(1,Math.min(1920,Math.ceil(e.w*1.2)))),String(Math.max(1,Math.min(1080,Math.ceil(e.h*1.2)))),JSON.stringify({frameKind:e.frameKind,contourKind:e.contourKind,arrowRole:e.arrowRole})]);await renderSVG(fs.readFileSync(target),{},signal);details={origin:'vector-rebuild',svg:true,...(vector.colorRepairs?.length?{colorRepairs:vector.colorRepairs}:{}),...(vector.geometryRepairs?.length?{geometryRepairs:vector.geometryRepairs}:{}),...(vector.lineEffectRepairs?.length?{lineEffectRepairs:vector.lineEffectRepairs}:{})};
      }else if(e.type==='cutout'){
        details=await preparedCrop.extract(target);
      }
      return {id,file,name:'重建素材 · '+(e.description||e.key),kind:'image',generated:true,reconstructed:true,purpose:'reconstruction',sha256:fileHash(target),size:fs.statSync(target).size,sourcePreviewHash:page.previewHash,sourceElement:e.key,...details,createdAt:new Date().toISOString()};
      });
      const m=result.asset;
      if(!p.materials.some(a=>a.id===m.id)&&!pending.some(a=>a.id===m.id))pending.push(m);
      elements.push({...e,type:'image',id:m.id,implementation:e.type,...(m.cutoutMethod?{cutoutMethod:m.cutoutMethod}:{}),...(m.localCutout?{cutoutMethod:'local-reference',...localCutoutPlacement(e,m)}:{}),svg:undefined,prompt:undefined,...(e.curveArrow?{sourceCurveArrow:e.curveArrow,curveArrow:undefined}:{}),...(result.reused?{reusedAsset:true}:{})});
      }catch(error){
        if(signal.aborted)throw error;
        const message=String(error.message).slice(0,2500);failed.issues.push(e.key+'：'+message);failed.failedElements.push({key:e.key,type:e.type,description:e.description||e.key,error:message});
        // A returned raster that failed a quality/alpha check is still useful to inspect.
        if(attempted?.file.endsWith('.png')&&!fs.existsSync(attempted.target)&&fs.existsSync(attempted.target+'.chroma-provider.png'))fs.copyFileSync(attempted.target+'.chroma-provider.png',attempted.target);
        if(attempted?.file.endsWith('.png')&&fs.existsSync(attempted.target))try{
          await assetTool(env,'inspect',attempted.target,attempted.target,signal);
          const m={id:attempted.id,file:attempted.file,name:'待调整素材 · '+(e.description||e.key),kind:'image',generated:true,reconstructed:true,purpose:'reconstruction',failedCandidate:true,sha256:fileHash(attempted.target),size:fs.statSync(attempted.target).size,sourcePreviewHash:page.previewHash,sourceElement:e.key,sourceCropPixels:preparedCrop?.pixels};
          pending.push(m);elements.push({...e,type:'image',id:m.id,implementation:e.type,svg:undefined,prompt:undefined,...(e.curveArrow?{sourceCurveArrow:e.curveArrow,curveArrow:undefined}:{}),needsAttention:true});
        }catch{}
      }finally{preparedCrop?.dispose();}
      return failed.issues.length?failed:undefined;
    },{limit:()=>assetWorkerLimit(projectWorkerLimit(p.executionConcurrency),targets.length),signal,onSettled:(outcome,position)=>{
      // Record then publish: a settled element updates the live scene immediately,
      // and a failure appears as soon as all earlier elements have settled.
      failedQueue.record(position,outcome.status==='fulfilled'?outcome.value:undefined);publish();
    }});
    const [fittingOutcome,assetOutcome]=await Promise.allSettled([fittingPromise,assetPromise]);
    if(fittingOutcome.status==='rejected')throw fittingOutcome.reason;
    if(assetOutcome.status==='rejected')throw assetOutcome.reason;
    const assetSettled=assetOutcome.value,assetKeys=new Set(assetTasks.map(e=>e.key));
    const completedAssets=new Map(elements.filter(e=>assetKeys.has(e.key)).map(e=>[e.key,e]));
    elements=arrangeScene([...fittingOutcome.value,...audit.filter(e=>assetKeys.has(e.key)).flatMap(e=>completedAssets.has(e.key)?[completedAssets.get(e.key)]:[])]);
    if(signal.aborted)throw Error('任务已取消');
    const rejectedAsset=assetSettled.find(outcome=>outcome.status==='rejected');if(rejectedAsset)throw rejectedAsset.reason;
    pages[i]={index:i,background,fontSubstitutions:fontResult.changes,elements:issues.length?preservePartialElements(seeds[i]?.elements||previous?.pages?.[i]?.elements||[],elements):elements,audit,geometry,referenceShapes:shapeReference,correspondence,auditValidation:{...auditValidation,records:auditRecords},notes:String(raw.notes||'').slice(0,2000)};
    pages[i].scene=sceneManifest(pages[i].elements,{raw:raw.elements||audit,layerInventory:auditValidation.layerInventory,previewHash:page.previewHash,background});
    if(issues.length)Object.assign(pages[i],{status:'partial',issues,failedElements});
    publishRebuildAssets(p,env,i,pages[i].elements,pending,{...pages[i],status:issues.length?'partial':'done',issues,failedElements});
    if(issues.length)throw Error(issues.join('；'));
  },{signal,limit:()=>projectWorkerLimit(p.executionConcurrency),label:i=>'拆解与重建 · 第 '+(i+1)+' 页',settle:true});batchSettled=true;
  }finally{
    p.materials.push(...pending.filter(m=>!p.materials.some(existing=>existing.id===m.id)));
    if(!batchSettled){p.rebuildAssetPreview.status=signal.aborted?'cancelled':'partial';env.save(p);}
  }
  const failures=results.flatMap((r,n)=>r.status==='rejected'?[{index:targets[n],message:r.reason.message}]:[]);
  if(failures.length){
    for(const f of failures){const page=p.rebuildAssetPreview.pages[f.index];if(!page||page.status!=='partial')publishRebuildAssets(p,env,f.index,page?.elements||[],pending,{...(page||{}),status:'partial',issues:[f.message],failedElements:page?.failedElements||[]});}
    p.rebuildAssetPreview.status='partial';env.save(p);
    if(!allowPartial)throw Error(failures.length+' 页未完成，已保留并展示成功元素与可查看的最后素材：'+failures.slice(0,3).map(f=>'第 '+(f.index+1)+' 页：'+f.message).join('；'));
    reportTask(signal,{kind:'step',status:'warning',message:failures.length+' 页拆解未通过，继续用本次成功元素组装可下载草稿，问题按页标记'});
    for(const i of targets)if(!pages[i])pages[i]={...p.rebuildAssetPreview.pages[i],index:i,background:slideBackground(p,i),elements:normalizeRebuildProgress(p,i,p.rebuildAssetPreview.pages[i]?.elements||[]),status:'partial',auditValidation:{status:'partial'},issues:p.rebuildAssetPreview.pages[i]?.issues||['本页拆解未完成']};
  }
  if(signal.aborted)throw Error('任务已取消');if(stamp!==visualStamp(p))throw Error('批准的预览已变化，请重新拆解');
  const missing=incompleteRebuildPages(p,pages);
  if(missing.length&&!allowPartial){p.rebuildAssetPreview.status='partial';env.save(p);p.task.completionMessage=(indices?'第 '+indices.map(i=>i+1).join('、')+' 页':'本批')+'拆解已完成；其余 '+missing.length+' 页仍待拆解或重试，已有结果保留';return null;}
  for(let i=0;i<p.slides.length;i++){
    if(!pages[i])pages[i]={index:i,background:slideBackground(p,i),elements:normalizeRebuildProgress(p,i,[]),status:'partial',auditValidation:{status:'partial'},issues:['本页尚未拆解']};
    if(!missing.includes(i)){delete pages[i].status;delete pages[i].issues;delete pages[i].failedElements;}
  }
  p.reconstruction={textPolicyVersion:'separate-numbers-v1',mode:'free',stamp,slides:pages,assets:[...new Set(pages.flatMap(page=>page.elements.filter(e=>e.type==='image'&&e.implementation).map(e=>e.id)))],at:new Date().toISOString(),model:cfg.model};p.rebuildAssetPreview.status=missing.length?'partial':'done';return p.reconstruction;
}
export function verifyCandidate(p,env,{downloadOnly=false}={}){
  const c=p.candidate;if(!c||c.version!==p.version||c.stamp!==visualStamp(p)||p.approvals.preview!==p.version||!downloadOnly&&!rebuiltCurrent(p))throw Error('候选交付已过期，请重新构建与渲染');
  if(p.rebuildPresentation&&c.presentationStamp!==rebuildPresentationStamp(p))throw Error('页面动画或进度条设置已变化，请重新构建');
  const root=path.resolve(env.data,p.id),base=path.resolve(root,c.dir);
  if(!base.startsWith(root+path.sep)||!safeName(c.file))throw Error('候选交付文件路径无效');
  const proofs=downloadOnly?c.proofs.filter(proof=>proof.file===c.file):c.proofs;
  if(downloadOnly&&!proofs.length)throw Error('PPTX 文件校验信息缺失');
  for(const proof of proofs){const file=path.join(base,proof.file);if(!safeName(proof.file)||!fs.existsSync(file)||fileHash(file)!==proof.sha256)throw Error('候选交付文件或验收工件已变化，禁止发布');}
  if(downloadOnly)return base;
  for(const m of p.materials.filter(m=>c.assetIds.includes(m.id))){const f=env.getImage(p,m.id);if(!f||!fs.existsSync(f)||fileHash(f)!==m.sha256)throw Error('登记原图或重建素材哈希不一致');}
  return base;
}
async function renderCandidate(p,env,signal,{allowLocalLayout=true,reusePrevious=true,retryIncomplete=true,pageIndices=[],onPageReview}={}){
  // Same independent reference lookups as rebuild(); overlap them before assembly.
  await runSettled([()=>prepareProgressReference(p,env,signal),()=>prepareFooterReference(p,env,signal)],{signal});
  const cfg=rebuildConfig(env,p);p.output=null;
  const incomplete=incompleteRebuildPages(p).filter(i=>!pageIndices.length||pageIndices.includes(i));
  if(!rebuiltCurrent(p)||retryIncomplete&&incomplete.length)await rebuild(p,env,signal,pageIndices.length?{indices:pageIndices,allowPartial:true}:{resume:true,allowPartial:true});
  prepareRebuildPresentation(p);
  // Normalize shared title paint before locking reusable pages. Pages whose
  // titles already match remain reusable; old inconsistent titles get rebuilt.
  p.reconstruction.slides.forEach(page=>{const unified=unifyTitleAppearance(p,page.elements);page.elements=unified.elements;if(unified.changes.length)page.fontSubstitutions=[...(page.fontSubstitutions||[]),...unified.changes];});
  const beforeReuse=reusePrevious?reusableCandidatePages(p,env):null;
  const locked=new Set(pageIndices.length?(beforeReuse?.indices||[]).filter(i=>!pageIndices.includes(i)):[]);
  const {fonts:installedFonts}=await prepareElementFonts(p,env,p.reconstruction.slides.flatMap((page,i)=>locked.has(i)?[]:page.elements),signal);
  p.reconstruction.slides.forEach((page,index)=>{if(locked.has(index))return;const resolved=resolveNativeFonts(page.elements.map(e=>e.type==='text'?{...e,...visualTextStyle(e,e.role)}:e),installedFonts);const body=unifyPageBodyFonts(p,resolved.elements,index);const unified=unifyTitleFonts(p,body.elements,installedFonts);const colored=unifyContentTitleColors(p,unified.elements,index);page.elements=normalizeRebuildProgress(p,index,colored.elements);page.fontSubstitutions=[...(page.fontSubstitutions||[]),...resolved.changes,...body.changes,...unified.changes,...colored.changes];page.instanceManifest=insertedInstanceManifest(page.elements);});
  const reuse=reusePrevious?reusableCandidatePages(p,env):null,reused=new Set(reuse?.indices||[]),targets=p.slides.map((_,i)=>i).filter(i=>!reused.has(i));
  if(!targets.length&&reuse){p.candidate=reuse.candidate;p.task.message='页面未变化，复用现有PPT与检查结果';env.save(p);return p.candidate;}
  const round=p.rebuildLive?.round||0;
  // Independent scene previews are rendered by the bounded SVG worker pool, so let
  // the pool feed all its threads instead of awaiting one page at a time. The
  // PowerPoint render below stays a single serial channel.
  const scenePages=[...p.reconstruction.slides.entries()].filter(([index])=>!reused.has(index));
  const scriptSettled=await runBoundedTasks(scenePages,async([index,page])=>{
    const scripts=await fitFormulaScripts({elements:page.elements,project:p,index,reference:visualFile(env,p,p.visualPages[index]),env,signal});
    page.elements=scripts.elements;page.formulaScriptFit=scripts.evidence;
  },{limit:2,signal});
  const scriptFailure=scriptSettled.find(result=>result.status==='rejected');if(scriptFailure)throw scriptFailure.reason;
  await ensureSVGViewports(p,env,scenePages,signal);
  const sceneSettled=await runBoundedTasks(scenePages,async([index,page])=>publishRebuildPage(p,env,{index,round,source:'scene',bytes:await renderSVG(nativeSVG(page.elements,id=>dataURL(env.getImage(p,id)),page.background),{font:{loadSystemFonts:true}},signal)}),{limit:svgRenderLimit(),signal});
  if(signal.aborted)throw Error('任务已取消');
  const sceneFailure=sceneSettled.find(outcome=>outcome.status==='rejected');if(sceneFailure)throw sceneFailure.reason;
  const finalizeAdapters=await import('./rebuild-adapters.mjs');
  const finalizePages=async pagesToFinalize=>{for(const pageOf of pagesToFinalize){if(!Array.isArray(pageOf?.elements))continue;pageOf.elements=finalizeAdapters.finalizeElements(pageOf.elements);}};
    for(const [index,page]of p.reconstruction.slides.entries())if(!reused.has(index))page.elements=fitContentToParents(page.elements);
    const candidateId=crypto.randomUUID(),dir=path.join(env.data,p.id,'exports',candidateId);fs.mkdirSync(dir,{recursive:true});
  if(reuse)copyReusablePageFiles(reuse,dir);
  const file='deck.pptx',deck=path.join(dir,file),textLayout=[],colorRecords=[],colorStates=p.slides.map(()=>({pending:new Map(),blocked:new Set()})),referenceRecords=[],referenceStates=p.slides.map((_,index)=>({pending:null,blocked:false}));let manifest;
  const sourceStamp=visualStamp(p);
  try{
  const stagedGeometry=rebuildFittingMode(p)==='replace';
  const {lastRound:lastLocalRound,textAdjustmentPasses}=localRenderPolicy(stagedGeometry),textPasses=new Map();
  for(let localRound=0;localRound<=lastLocalRound;localRound++){
    await finalizePages(p.reconstruction.slides.filter((pageOf,index)=>!reused.has(index)));
    if(localRound)await ensureSVGViewports(p,env,scenePages,signal);
    p.reconstruction.slides.forEach((page,index)=>{page.scene=sceneManifest(page.elements,{previous:page.scene,raw:page.audit,previewHash:p.visualPages[index]?.previewHash,background:page.background});});
    const spec={slides:p.reconstruction.slides.map(s=>s.elements),backgrounds:p.reconstruction.slides.map(s=>s.background),
      materialImages:p.reconstruction.slides.map((_,index)=>materialImageManifest(p,index,env.getImage))};fs.writeFileSync(path.join(dir,'deck-spec.json'),JSON.stringify(spec,null,2));
    const motionFile=path.join(dir,'motion-plan.json');fs.writeFileSync(motionFile,JSON.stringify(reuse?{...deliveryMotionPlan(p),pages:deliveryMotionPlan(p).pages.filter(page=>targets.includes(page.index))}:deliveryMotionPlan(p)));
    p.task.message=localRound?'本地调整或回退后复渲染 · '+localRound+'/'+lastLocalRound:reused.size?'复用 '+reused.size+' 页，组装 '+targets.length+' 个修改页':'组装原生 PPTX';env.save(p);await buildVisualDeck(p,deck,env.getImage,reuse?{reuse:{deck:path.join(reuse.base,reuse.candidate.file),indices:targets}}:{});
    await env.run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(env.root,'tools','render_deck.ps1'),'-DeckPath',deck,'-OutputDir',dir,'-MotionSpec',motionFile,...(reuse?['-PageIndices',targets.join(',')]:[])],{windowsHide:true,maxBuffer:1000000,timeout:240000,signal});
    manifest=JSON.parse(fs.readFileSync(path.join(dir,'render-manifest.json'),'utf8'));
    if(reuse){if(manifest.pages.length!==targets.length||manifest.pages.some(page=>!targets.includes(page.index))||new Set(manifest.pages.map(page=>page.index)).size!==targets.length)throw Error('增量渲染未返回完整的修改页清单');const changed=new Map(manifest.pages.map(page=>[page.index,page]));manifest.pages=p.slides.map((_,i)=>changed.get(i)||reuse.manifest.pages[i]);fs.writeFileSync(path.join(dir,'render-manifest.json'),JSON.stringify(manifest,null,2));}
    fs.writeFileSync(motionFile,JSON.stringify(deliveryMotionPlan(p)));
    if(manifest.pages.length!==p.slides.length||manifest.pptx_sha256!==fileHash(deck))throw Error('渲染页数或 PPTX 哈希不一致');
    let changed=false;const deferredLayout=new Set();
    if(allowLocalLayout){
      const referenceOutcomes=await runBoundedTasks(targets,async i=>{
        const page=p.reconstruction.slides[i],state=referenceStates[i],reference=visualFile(env,p,p.visualPages[i]),rendered=path.join(dir,manifest.pages[i].file),background=env.getImage(p,page.background.id);
        if(!state.pending&&localRound!==0)return;
        const exclusions=[...(p.visualPages[i].reused?page.elements.filter(e=>e.type==='text'):[]),...([rebuildProgressRegion(p,i)].filter(Boolean))];
        const diagnostics=await analyzeVisual(env,python(env),{operation:'difference',reference,rendered,background,elements:state.pending?.regions||page.elements,exclude:exclusions},path.join(env.data,p.id,'visual-diagnostics',candidateId,`reference-${i}-${localRound}`),signal);
        const quality=await measureElementQuality({env,project:p,index:i,elements:page.elements,reference,rendered,background,exclude:exclusions,signal});
        page.elementQuality=quality;
        const settled=settleReferenceTrial(page.elements,{...diagnostics,objectQuality:quality,measurements:manifest.pages[i].texts||[]},state);
        referenceRecords.push({index:i,round:localRound,status:settled.status,better:settled.better,worse:settled.worse,observed:settled.observed,...(settled.groupingRejections?.length?{groupingRejections:settled.groupingRejections}:{})});
        if(settled.changed){page.elements=settled.elements;if(settled.familyReverted&&state.bodyFontBefore!==undefined){p.rebuildBodyFonts||={};p.rebuildBodyFonts[i]=state.bodyFontBefore;delete state.bodyFontBefore;}page.correspondence=reconstructionCorrespondence(page.elements,{texts:canonicalTexts(p.slides[i],p,i).filter(n=>n.role!=='navigation'),images:p.visualPages[i].images,frames:page.auditValidation?.frameInventory,candidates:page.referenceShapes?.candidates});changed=true;deferredLayout.add(i);return;}
        if(localRound!==0||state.blocked||diagnostics.status!=='available')return;
        const localTargets=refinementTargets(diagnostics,page.elements,{quality});
        // Table geometry/fill is owned by tableStage: committed local refinement rounds must not
        // move bands/lines/cells again. Only explicit table marks are excluded so a page that is
        // half table / half text keeps normal refinement for its non-table half.
        const tableKeySet=new Set((page.elements||[]).filter(element=>element&&(element.tablePlaced
          ||element._tableStage||/^table|vline|hline|row-?\d|cell-/i.test(String(element.key||''))))
          .map(element=>element.key));
        for(const bucket of ['shape','svg','font']){const set=localTargets?.[bucket];
          if(set&&typeof set.delete==='function'){for(const key of [...set])if(tableKeySet.has(key))set.delete(key);}}

        page.localProblems=localTargets.issues;
        // The default path has already committed S3-S6. Only compatibility
        // diagnostics may run the earlier native/font refitters below.
        const nativeFrames=!stagedGeometry&&localTargets.shape.size?await restoreNativeFrames({env,project:p,index:i,elements:page.elements,reference,background,exclude:exclusions,targetKeys:[...localTargets.shape],signal}):{elements:page.elements,changes:[],report:{status:'skipped'}};
        page.nativeFrameFit=nativeFrames.report;
        const shapeInputs=stagedGeometry?nativeFrames.elements:shapeRefinementInputs(nativeFrames.elements,e=>fs.readFileSync(env.getImage(p,e.id),'utf8'));
        const shapes=!stagedGeometry&&localTargets.shape.size?await measureReferenceShapes({env,project:p,index:i,reference,background,elements:shapeInputs,targetKeys:[...localTargets.shape],exclude:[...(p.visualPages[i].images||[]),...([rebuildProgressRegion(p,i)].filter(Boolean))],signal}):{status:'skipped',proposals:[],paintProposals:[],candidates:[]};
        const fitted=stagedGeometry?{elements:shapeInputs,changes:[]}:applyShapeRefinement(shapeInputs,shapes),shapeChanges=new Map([...nativeFrames.changes,...fitted.changes].map(change=>[change.key,change.after]));
        fitted.elements=nativeFrames.elements.map(e=>shapeChanges.get(e.key)||e);fitted.changes=[...nativeFrames.changes,...fitted.changes];
        const vectors=await fitSVGReferenceStage({project:p,index:i,elements:fitted.elements,reference,background,env,signal,diagnostics,quality,targetKeys:[...localTargets.svg].filter(key=>!shapeChanges.has(key))});
        const fonts=stagedGeometry||p.visualPages[i].reused?{elements:vectors.elements,changes:[]}:await refineReferenceFonts({project:p,index:i,elements:vectors.elements,reference,background,env,signal,targetKeys:[...localTargets.font]});
        // Title family is a deck-wide decision; local fitting may adjust its
        // metrics but must not introduce a different family on one page.
        const bodyFontBefore=structuredClone(p.rebuildBodyFonts?.[i]||null);
        const normalized=stagedGeometry?vectors.elements:unifyTitleFonts(p,unifyPageBodyFonts(p,fonts.elements,i,{reselect:true,references:fonts.changes}).elements).elements;
        if(shapes.status!=='skipped')page.referenceShapes=shapes;
        page.correspondence=reconstructionCorrespondence(normalized,{texts:canonicalTexts(p.slides[i],p,i).filter(n=>n.role!=='navigation'),images:p.visualPages[i].images,frames:page.auditValidation?.frameInventory,candidates:shapes.candidates});
        const hasTrial=JSON.stringify(page.elements)!==JSON.stringify(normalized);
        const baseline=hasTrial?await analyzeVisual(env,python(env),{operation:'difference',reference,rendered,background,elements:referenceTrialRegions(page.elements,normalized),exclude:exclusions},path.join(env.data,p.id,'visual-diagnostics',candidateId,`reference-baseline-${i}`),signal):diagnostics;
        if(baseline.status==='available'&&beginReferenceTrial(page.elements,normalized,{...baseline,objectQuality:quality},state)){
          if(!stagedGeometry)state.bodyFontBefore=bodyFontBefore;
          page.elements=normalized;changed=true;deferredLayout.add(i);
          referenceRecords.push({index:i,round:localRound,status:'trial',shapes:fitted.changes.map(({before,after,...r})=>r),vectors:vectors.changes,vectorRecords:vectors.records,fonts:fonts.changes,shapeRecord:shapes.record,fontRecord:fonts.record});
          reportTask(signal,{kind:'step',message:`第 ${i+1} 页参考拟合：${fitted.changes.length} 个色块、${vectors.changes.length} 个复杂矢量、${fonts.changes.length} 个文字对象，等待实际渲染复核`});
        }else{
          referenceRecords.push({index:i,round:localRound,status:hasTrial?'trial-unavailable':'unchanged',vectors:vectors.changes,vectorRecords:vectors.records,vectorStage:{status:vectors.status,reason:vectors.reason,targetKeys:vectors.targetKeys}});
          if(hasTrial&&!stagedGeometry){p.rebuildBodyFonts||={};p.rebuildBodyFonts[i]=bodyFontBefore;}
        }
      },{limit:()=>projectWorkerLimit(p.executionConcurrency),signal});
      const referenceFailure=referenceOutcomes.find(result=>result.status==='rejected');
      if(referenceFailure){
        if(signal.aborted)throw referenceFailure.reason;
        for(const [position,outcome] of referenceOutcomes.entries())if(outcome.status==='rejected'){
          const index=targets[position],state=referenceStates[index];
          if(state.pending){const page=p.reconstruction.slides[index],settled=settleReferenceTrial(page.elements,{status:'unavailable'},state);page.elements=settled.elements;if(state.bodyFontBefore!==undefined){p.rebuildBodyFonts||={};p.rebuildBodyFonts[index]=state.bodyFontBefore;}state.blocked=true;changed=true;deferredLayout.add(index);referenceRecords.push({index,round:localRound,status:'reverted',reason:'measurement_unavailable',groupingRejections:settled.groupingRejections});}
        }
        reportTask(signal,{kind:'step',status:'warning',message:'本地参考拟合暂未完成，保留已生成页面：'+String(referenceFailure.reason?.message||referenceFailure.reason).slice(0,300)});
      }
    }
    for(const [i,page] of p.reconstruction.slides.entries()){
      if(reused.has(i))continue;
      const result=optimizeTextLayout(page.elements,manifest.pages[i].texts||[],{safeAreas:contentSafeAreas(page.elements)});
      const applied=allowLocalLayout&&!deferredLayout.has(i)&&localRound<lastLocalRound&&(textPasses.get(i)||0)<textAdjustmentPasses&&result.changes.length>0;
      textLayout.push({index:i,round:localRound,measured:manifest.pages[i].texts?.length||0,applied,changes:result.changes,issues:result.issues,measurementErrors:manifest.pages[i].measurementErrors||[]});
      if(applied){page.elements=result.elements;textPasses.set(i,(textPasses.get(i)||0)+1);changed=true;}
    }
    if(allowLocalLayout&&!stagedGeometry&&localRound<=2){
      const measured=await measureColorCalibration(env,python(env),targets.map(index=>{const page=p.reconstruction.slides[index];return {reference:visualFile(env,p,p.visualPages[index]),rendered:path.join(dir,manifest.pages[index].file),elements:page.elements,assetFiles:Object.fromEntries(page.elements.filter(e=>e.type==='image'&&e.implementation==='cutout').map(e=>[e.id,env.getImage(p,e.id)]))};}),path.join(env.data,p.id,'visual-diagnostics',candidateId,'color-round-'+localRound),signal);
      for(const [position,index]of targets.entries()){
        if(deferredLayout.has(index))continue;
        const page=p.reconstruction.slides[index],measurement=measured.pages[position];
        const result=applyColorCalibration(page,measurement,colorStates[index],{allowProposals:localRound<Math.min(2,lastLocalRound)});
        colorRecords.push({index,round:localRound,status:measurement?.status,error:measured.error,records:result.records,record:path.join('visual-diagnostics',candidateId,'color-round-'+localRound)});
        if(result.changed)changed=true;
      }
    }
    for(const [index,page]of manifest.pages.entries())if(!reused.has(index))publishRebuildPage(p,env,{index,round,source:'powerpoint',bytes:fs.readFileSync(path.join(dir,page.file))});
    if(!changed)break;
  }
  p.reconstruction.assets=[...new Set(p.reconstruction.slides.flatMap(page=>page.elements.filter(e=>e.type==='image'&&e.implementation).map(e=>e.id)))];
  fs.writeFileSync(path.join(dir,'color-calibration.json'),JSON.stringify(colorRecords,null,2));
  fs.writeFileSync(path.join(dir,'text-layout.json'),JSON.stringify(textLayout,null,2));
  fs.writeFileSync(path.join(dir,'reference-fitting.json'),JSON.stringify(referenceRecords,null,2));
  if(reuse)fs.writeFileSync(path.join(dir,'reused-structure.json'),JSON.stringify(reuse.structure));
  let structure;try{structure=JSON.parse((await env.run(python(env),[path.join(env.root,'tools','release_check.py'),deck,path.join(dir,'deck-spec.json'),...(reuse?['--pages',targets.join(','),'--baseline',path.join(dir,'reused-structure.json')]:[])],{windowsHide:true,maxBuffer:1000000,timeout:60000,signal})).stdout);}catch(error){if(signal.aborted)throw error;try{structure=JSON.parse(error.stdout);}catch{structure={passed:false,errors:['结构检验未完成：'+String(error.stderr||error.message).slice(-800)],slides:[]};}}
  if(!structure||typeof structure.passed!=='boolean'||structure.errors!==undefined&&!Array.isArray(structure.errors))structure={passed:false,errors:['结构检验未返回有效结果'],slides:[]};
  if(manifest.pages.length!==p.slides.length||manifest.pptx_sha256!==fileHash(deck))throw Error('渲染页数或 PPTX 哈希不一致');
  const reviews=p.slides.map((_,index)=>reused.has(index)?{...structuredClone(reuse.candidate.review.pages[index]),reusedFrom:reuse.candidate.id}:({index,pending:true,passed:false,checks:{},designChecks:null,issues:rebuildPageIssues(p,index,structure),deviations:[],notes:'',manual:null})),proofs=[];
  const compareTasks=targets;
  const compareSettled=await runBoundedTasks(compareTasks,async i=>{
    const rendered=path.join(dir,manifest.pages[i].file),reference=visualFile(env,p,p.visualPages[i]),elements=p.reconstruction.slides[i].elements;
    const rebuilt=await renderSVG(nativeSVG(elements,id=>dataURL(env.getImage(p,id)),p.reconstruction.slides[i].background),{font:{loadSystemFonts:true}},signal);fs.writeFileSync(path.join(dir,`rebuilt-${i}.png`),rebuilt);fs.copyFileSync(reference,path.join(dir,`approved-${i}.png`));
    const compare=`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="590"><rect width="1920" height="590" fill="#e4e6dd"/><text x="20" y="30" font-size="18" font-family="Microsoft YaHei">已批准预览 / APPROVED</text><text x="980" y="30" font-size="18" font-family="Microsoft YaHei">实际 PowerPoint 渲染 / RENDERED</text><image href="${dataURL(reference)}" x="0" y="50" width="960" height="540"/><image href="${dataURL(rendered)}" x="960" y="50" width="960" height="540"/></svg>`;fs.writeFileSync(path.join(dir,`compare-${i}.png`),await renderSVG(compare,{font:{loadSystemFonts:true}},signal));
    publishRebuildPage(p,env,{index:i,round,source:'powerpoint',bytes:fs.readFileSync(rendered)});
  },{limit:svgRenderLimit(),signal});
  if(signal.aborted)throw Error('任务已取消');
  const compareFailure=compareSettled.find(outcome=>outcome.status==='rejected');if(compareFailure)throw compareFailure.reason;
  const review={candidateId,at:new Date().toISOString(),model:cfg.model,pages:reviews};
  const svgReferenceStageVersions=Object.fromEntries(p.slides.map((_,i)=>[i,reused.has(i)?reuse.candidate.svgReferenceStageVersions?.[i]??reuse.candidate.svgReferenceStageVersion??0:svgReferenceStageVersion]));
  const candidate={id:candidateId,svgColorVersion,svgReferenceStageVersion,svgReferenceStageVersions,presentationStamp:rebuildPresentationStamp(p),version:p.version,stamp:visualStamp(p),dir:path.relative(path.join(env.data,p.id),dir),file,renderer:manifest.renderer,rendererVersion:manifest.version,structure,review,proofs,pageReuse:{source:reuse?.candidate.id||null,reused:[...reused],rebuilt:targets},assetHashes:Object.fromEntries(p.materials.filter(m=>m.kind==='image').map(m=>[m.id,m.sha256])),assetIds:[...new Set(p.reconstruction.slides.flatMap(s=>[s.background.id,...s.elements.filter(e=>e.type==='image').map(e=>e.id)]))],colorCalibration:{file:'color-calibration.json',accepted:colorRecords.flatMap(r=>r.records).filter(r=>r.status==='accepted').length,reverted:colorRecords.flatMap(r=>r.records).filter(r=>r.status==='reverted').length},status:'reviewing',at:new Date().toISOString()};
  const renderedReconstruction=structuredClone(p.reconstruction),proofCache=new Map();
  const checkpoint=()=>{
    candidate.designStandards=designAcceptance(p,reviews);review.designStandards=candidate.designStandards;
    fs.writeFileSync(path.join(dir,'qa-review.json'),JSON.stringify(review,null,2));
    candidate.proofs=fs.readdirSync(dir).filter(file=>!file.startsWith('~$')&&!/\.tmp$/i.test(file)&&/\.(?:pptx|pdf|json|md|png|svg|zip)$/i.test(file)).flatMap(file=>{
      const absolute=path.join(dir,file),stat=fs.statSync(absolute);if(!stat.isFile())return [];
      // Rendered images and the assembled deck are immutable during reviews.
      // Mutable reports are always rehashed, even within one filesystem tick.
      const signature=stat.size+':'+stat.mtimeMs,cached=proofCache.get(file),immutable=/\.(?:png|svg|pptx|pdf|zip)$/i.test(file);
      const sha256=immutable&&cached?.signature===signature?cached.sha256:fileHash(absolute);proofCache.set(file,{signature,sha256});return [{file,sha256}];
    });p.candidate=candidate;p.stage=6;env.save(p,{immediate:true,results:true});
  };
  fs.writeFileSync(path.join(dir,'structure-report.json'),JSON.stringify(structure,null,2));checkpoint();
  await runConcurrent(targets,async i=>{
    p.task.message=`渲染对照验收 · 第 ${i+1} 页（本次 ${targets.indexOf(i)+1}/${targets.length} 页）`;env.save(p);const rendered=path.join(dir,manifest.pages[i].file),reference=visualFile(env,p,p.visualPages[i]),elements=p.reconstruction.slides[i].elements;
    const diagnosticDir=path.join(env.data,p.id,'visual-diagnostics',candidateId,`page-${i+1}`);
    const diagnostics=await analyzeVisual(env,python(env),{operation:'difference',reference,rendered,background:env.getImage(p,p.reconstruction.slides[i].background.id),elements,exclude:[...(p.visualPages[i].reused?elements.filter(e=>e.type==='text'):[]),...([rebuildProgressRegion(p,i)].filter(Boolean))]},diagnosticDir,signal);
    const heatmap=path.join(dir,`difference-${i}.png`);
    if(diagnostics.status==='available')fs.copyFileSync(path.join(diagnosticDir,'difference.png'),heatmap);
    fs.writeFileSync(path.join(dir,`analysis-${i}.json`),JSON.stringify(diagnostics,null,2));
    const pageLayout=textLayout.filter(r=>r.index===i);let geometry=p.reconstruction.slides[i].geometry;
    let geometryImage=geometry?.record&&path.join(env.data,p.id,geometry.record,'geometry.png');
    // Older projects can acquire diagnostics without changing their saved scene.
    if(geometry?.status!=='available'){
      const geometryDir=path.join(diagnosticDir,'geometry');
      geometry=await analyzeVisual(env,python(env),{operation:'geometry',reference,background:env.getImage(p,p.reconstruction.slides[i].background.id),exclude:[...(p.visualPages[i].images||[]),...([rebuildProgressRegion(p,i)].filter(Boolean))]},geometryDir,signal);
      geometryImage=path.join(geometryDir,'geometry.png');
    }
    if(geometryImage&&fs.existsSync(geometryImage))fs.copyFileSync(geometryImage,path.join(dir,`geometry-${i}.png`));
    const elementQuality=await measureElementQuality({env,project:p,index:i,elements,reference,rendered,background:env.getImage(p,p.reconstruction.slides[i].background.id),exclude:[...([rebuildProgressRegion(p,i)].filter(Boolean))],signal});
    p.reconstruction.slides[i].elementQuality=elementQuality;
    p.reconstruction.slides[i].scene=sceneManifest(elements,{previous:p.reconstruction.slides[i].scene,previewHash:p.visualPages[i].previewHash,background:p.reconstruction.slides[i].background,quality:elementQuality});
    fs.writeFileSync(path.join(dir,`element-quality-${i}.json`),JSON.stringify(elementQuality,null,2));
    const diagnosticSummary={...diagnostics,elementQuality,regions:diagnostics.regions?.slice(0,12),correspondence:p.reconstruction.slides[i].correspondence,referenceFitting:referenceRecords.filter(r=>r.index===i),geometryAvailable:!!geometryImage&&fs.existsSync(geometryImage),geometryCandidates:geometry?.candidates?.length||0,geometricCandidates:geometry?.candidates?.slice(0,20)||[],textLayout:{...pageLayout.at(-1),appliedChanges:pageLayout.filter(r=>r.applied).reduce((n,r)=>n+r.changes.length,0)}};
    const prompt=`渲染对照验收：第一张是用户批准的AI完整预览，第二张是真实PowerPoint渲染。${rebuildReferenceRule}逐页实际看图，不能仅依据结构清单判通过。${pageBodyFontRule}${p.rebuildPresentation?.version===1?unifiedProgressRule+'05统一后的导航样式允许与AI参考不同，不将这一明确改动判为不相似或要求还原旧导航。':''}${rebuildAppearanceRule}${contentTitleColorRule} 用户明确指定的书法字抠图（对象artisticText=true）允许作为透明图片字形保留，核对字迹完整性与准确文字，不要求转回原生字体。 ${textSpacingRule} ${colorAdjustmentRule} 分别评价美观度、排版质量与预览接近程度：以批准预览的构图、相对位置、留白、色阶和视觉重心为目标；不能因为文字齐全就判版式美观或预览相似。检查整体美观/版式/渐变/装饰/留白/层级、准确文字/条件/数据/可读性、登记原图身份与完整性、是否忠实还原设计。AI预览文字可能有误，准确文案以下方清单为准。${p.visualPages[i].reused?'当前参考图沿用了旧布局，新文案已在原生对象中同步；文字变化是用户主动选择，不能因与旧参考文字不同而否决，须检查最新文字是否完整、可读且无重叠。':''}明显遗漏、整页扁平化、错图、出框、文字重叠或无法确认均判失败。允许合理位置优化但须列明 deviations。只输出完整JSON验收对象。设计规范：${designRulesFor(p,i,'review')}。准确文字：${JSON.stringify(canonicalTexts(p.slides[i],p,i))}\n预览框体清点（逐个核对全部框体的轮廓、描边、填充、渐变与位置，遗漏时补回，不用删除来解决格式错误）：${JSON.stringify(p.reconstruction.slides[i].auditValidation?.frameInventory||[])}\n遮挡分层（分别核对前后对象及完整轮廓，不能合成一个剪影）：${JSON.stringify(p.reconstruction.slides[i].auditValidation?.layerInventory||[])}\n预览独立数字清点（逐个核对，缺失时用工具补回原生文字）：${JSON.stringify(p.reconstruction.slides[i].auditValidation?.numberInventory||[])}\n预览审计的相同元素数量与位置：${JSON.stringify(p.reconstruction.slides[i].auditValidation?.instanceGroups||[])}\n实际相同素材实例（逐一核对数量和位置，不以素材ID去重）：${JSON.stringify(insertedInstanceManifest(elements).groups.filter(g=>g.count>1))}\n原生对象清单：${JSON.stringify(elements.map(({svg,...e})=>({...e,...(svg?{vectorGeometry:"独立SVG几何，按实际图核对"}:{})})))}\n结构检查：${JSON.stringify(structure.slides[i])}`;
    const records=[];
    reviews[i]=await reviewRenderedPage({project:p,index:i,structure,signal,
      request:async correction=>{const regions=[...(elementQuality.unexplainedInteriorRegions||[]),...(elementQuality.objects||[]).filter(e=>e.issues?.length).map(e=>elements.find(n=>n.key===e.key)).filter(Boolean),...(elementQuality.unexplainedRegions||[])].filter(e=>e.w*e.h<1600*900*.5).slice(0,2);const closeups=[];for(const region of regions){closeups.push(...await auditDetailImages(reference,[region],{signal}),...await auditDetailImages(rendered,[region],{signal}));}return chat(cfg,env.system,[{type:'text',text:prompt+'\n本地视觉诊断（不作为通过门槛；相似度不能衡量语义或美观，红色只表示局部差异；新文案可能与旧参考不同）：'+JSON.stringify(designDiagnosticContext(diagnosticSummary))+'\n框内未解释边界需核对是遗漏色块还是多余描边，不能因已在大框内就忽略。\n如有第三张图，它是局部差异热力图；之后为问题局部图，每对依次是参考与实际渲染，区域顺序：'+JSON.stringify(regions.map(e=>({key:e.key,x:e.x,y:e.y,w:e.w,h:e.h})))+'.\n返回严格合法JSON，所有键加双引号；使用以下字段结构，布尔值据实际画面判断：'+renderReviewSchema+'。只返回验收结论，不重复文案、对象清单或SVG；notes与reason各不超过160字。'+(correction||'')},...[reference,rendered,...(diagnostics.status==='available'?[heatmap]:[])].map(f=>({type:'image_url',image_url:{url:dataURL(f)}})),...closeups],signal,{deferJSONValidation:true,includeSummary:false})},
      record:entry=>{const file=`review-page-${i+1}-attempt-${entry.attempt}.json`;fs.writeFileSync(path.join(dir,file),JSON.stringify({index:i,model:cfg.model,...entry},null,2));records.push(file);},
      progress:message=>{p.task.message=message;reportTask(signal,{kind:'retry',status:'running',message});env.save(p);}
    });reviews[i].responseValidation.records=records;reviews[i].diagnostics=diagnosticSummary;
    // Real overflow is actionable geometry, unlike an advisory similarity score.
    // It enters this same step's existing repair loop; draft download remains available.
    for(const m of manifest.pages[i].texts||[]){
      const e=elements.find(e=>['text','formula'].includes(e.type)&&e.key===m.key);
      if(e&&(m.boundWidth>e.w+2||m.boundHeight>e.h+2)){
        reviews[i].issues.push(`文字实测超出文本框：${e.key}，实测 ${m.boundWidth.toFixed(1)}×${m.boundHeight.toFixed(1)}，文本框 ${e.w.toFixed(1)}×${e.h.toFixed(1)}`);
        reviews[i].passed=false;
      }
    }
    for(const issue of foregroundVisibilityIssues(elements)){
      reviews[i].issues.push('内容被非预期承载遮挡：'+issue.key+' ← '+issue.covering);reviews[i].passed=false;
    }
    reviews[i]=applyRebuildQuality(p,i,reviews[i],structure);checkpoint();onPageReview?.(structuredClone(reviews[i]));
  },{signal,limit:()=>projectWorkerLimit(p.executionConcurrency),label:i=>'渲染对照验收 · 第 '+(i+1)+' 页'});
  fs.writeFileSync(path.join(dir,'style-registry.json'),JSON.stringify(p.styleRegistry||[],null,2));
  fs.writeFileSync(path.join(dir,'content.json'),JSON.stringify({brief:p.brief,slides:p.slides,pageDesigns:p.pageDesigns,previewApproval:p.previewApproval||null,styleRegistry:p.styleRegistry||[],concepts:p.concepts,visualPages:p.visualPages,reconstruction:renderedReconstruction,materials:p.materials.map(({text,ocr,...m})=>m)},null,2));
  if(p.brief.speaker)fs.writeFileSync(path.join(dir,'speaker-notes.md'),p.slides.map((s,i)=>`## 第 ${i+1} 页 ${s.title}\n\n${s.notes||''}`).join('\n\n'));
  if(signal.aborted)throw Error('任务已取消');
  candidate.status=reviews.every(r=>r.passed)?'awaiting_review':'failed';checkpoint();
  return p.candidate;
  }catch(error){
    if(signal.aborted||sourceStamp!==visualStamp(p))throw error;
    const draft=await retainUnreviewedDraft(p,env,dir,{issue:'构建后渲染或检验未完成：'+String(error.stderr||error.message).slice(-800)});
    if(draft)return draft;throw error;
  }
}
async function buildCandidate(p,env,signal,{feedback=[],repairLimit=rebuildVisualRepairLimit,preserveReconstruction=false,freshAssembly=false,manualRepair=false}={}){
  for(const request of feedback)rememberFormulaScriptRequest(p,request.index,request.instruction,
    request.targetKey?[request.targetKey]:request.regionScope?[]:null);
  if(feedback.length)markRebuildPages(p,feedback.map(f=>f.index));
  const scopeIndices=rebuildPageScope(p)?.indices||[];
  const stamp=visualStamp(p),repairBatch=crypto.randomUUID(),recordDir=path.join(env.data,p.id,'rebuild-repairs',repairBatch);
  const assetStore=createRebuildAssetStore({accept:m=>(!m.localCutout||m.localCutoutVersion===localCutoutVersion)&&(!m.artisticText||m.artisticMatteVersion===artisticMatteVersion),materials:p.materials,getFile:m=>path.join(env.data,p.id,'assets',m.file)});
  p.output=null;if(freshAssembly){p.candidate=null;p.rebuildLive=null;}startRebuildLive(p,env);
  if(!scopeIndices.length&&!preserveReconstruction&&!feedback.length&&p.reconstruction&&(p.reconstruction.model!==rebuildConfig(env,p).model||p.reconstruction.textPolicyVersion!=='separate-numbers-v1'))p.reconstruction=null;
  await rebuildReviewLoop({signal,feedback,scopeIndices,limit:repairLimit,allowUnreviewedFeedback:manualRepair,
    render:async (round,pipeline)=>{if(stamp!==visualStamp(p))throw Error('预览已变化，停止自动重建修正');p.rebuildLive.round=round;p.task.message=`实际渲染与视觉复查 · ${round?'修正第'+round+'轮':'初版'}`;env.save(p);return renderCandidate(p,env,signal,{allowLocalLayout:!feedback.length&&!preserveReconstruction,reusePrevious:!(freshAssembly&&round===0),retryIncomplete:round===0&&!feedback.length&&!preserveReconstruction,pageIndices:scopeIndices,onPageReview:pipeline?.onPageReview});},
    progress:message=>{p.task.message=message;reportTask(signal,{kind:'repair',status:'running',message});env.save(p);},
    save:candidate=>{const file='visual-repair-history.json',base=path.join(env.data,p.id,candidate.dir);fs.writeFileSync(path.join(base,file),JSON.stringify(candidate.visualRepair,null,2));const proof=candidate.proofs.find(e=>e.file===file);if(proof)proof.sha256=fileHash(path.join(base,file));else candidate.proofs.push({file,sha256:fileHash(path.join(base,file))});env.save(p);},
    repair:async(failed,round)=>{
      const results=await runConcurrent(failed,async review=>{
        const i=review.index,originalPage=structuredClone(p.reconstruction.slides[i]),page=p.visualPages[i],source=visualFile(env,p,page),base=path.join(env.data,p.id,p.candidate.dir),backgroundFile=env.getImage(p,originalPage.background.id);
        return repairRebuiltPage({p,index:i,review,round,env,signal,reference:dataURL(source),rendered:dataURL(path.join(base,`S${String(i+1).padStart(2,'0')}.png`)),background:dataURL(backgroundFile),...(review.diagnostics?.status==='available'?{heatmap:dataURL(path.join(base,`difference-${i}.png`))}:{}),
          createAsset:async args=>{
            let preparedCrop=null;
            if(args.method==='cutout'){
              const current=review.targetKey===args.key?originalPage.elements.find(e=>e.key===args.key&&e.type==='image'&&e.implementation):null;
              let referenceImage;
              if(current){const file=env.getImage(p,current.id),bytes=fs.readFileSync(file);referenceImage={bytes:file.toLowerCase().endsWith('.svg')?await renderSVG(bytes,{},signal):bytes,mime:'image/png'};}
              preparedCrop=await prepareCompatibleCutout({env,referenceImage,adjustment:referenceImage?review.userInstruction:undefined,getImage:id=>env.getImage(p,id),assetTool,source,backgroundFile,sourceBox:args.sourceBox,elements:originalPage.elements,targetKey:args.key,artistic:!!args.artisticText,textIdentity:args.artisticText?{nodeId:args.nodeId,text:args.text}:undefined,directory:path.join(env.data,p.id,'assets'),signal,config:cutoutConfig(env,p),description:args.description||args.key,onProgress:message=>reportTask(signal,{kind:'repair',status:'running',message:message+' · '+(args.description||args.key)})});
            }
            const identity=preparedCrop?.identity||rebuildAssetIdentity({method:args.method,svg:args.svg,geometry:{frameKind:args.frameKind,contourKind:args.contourKind,arrowRole:args.arrowRole}});
            try{const {asset}=await assetStore.getOrCreate(identity,async()=>{
            const id=crypto.randomUUID(),assetsDir=path.join(env.data,p.id,'assets'),target=path.join(assetsDir,id+(args.method==='svg'?'.svg':'.png'));fs.mkdirSync(assetsDir,{recursive:true});let details={};
            if(args.method==='svg'){
              const temp=path.join(assetsDir,id+'.draft.svg');fs.writeFileSync(temp,String(args.svg||''));const vector=await assetTool(env,'svg',temp,target,signal,[String(Math.max(1,Math.min(1920,Math.ceil(args.w*1.2)))),String(Math.max(1,Math.min(1080,Math.ceil(args.h*1.2)))),JSON.stringify({frameKind:args.frameKind,contourKind:args.contourKind,arrowRole:args.arrowRole})]);await renderSVG(fs.readFileSync(target),{},signal);details={origin:'vector-rebuild',svg:true,...(vector.colorRepairs?.length?{colorRepairs:vector.colorRepairs}:{}),...(vector.geometryRepairs?.length?{geometryRepairs:vector.geometryRepairs}:{}),...(vector.lineEffectRepairs?.length?{lineEffectRepairs:vector.lineEffectRepairs}:{})};
            }else if(args.method==='cutout'){
              details=await preparedCrop.extract(target);
            }else throw Error('重建素材仅支持SVG或纯色底去底／参考底图本地分离');
            return {id,file:path.basename(target),name:'工具重建 · '+String(args.description||args.key).slice(0,300),kind:'image',generated:true,reconstructed:true,purpose:'reconstruction',sha256:fileHash(target),size:fs.statSync(target).size,sourcePreviewHash:page.previewHash,sourceElement:args.key,...(args.artisticText?{artisticText:true,nodeId:args.nodeId,text:args.text,artisticMatteVersion}:{}),...details,createdAt:new Date().toISOString()};
            });return asset;}finally{preparedCrop?.dispose();}
          },
          renderScene:async(draft,assets)=>{const imageURL=id=>dataURL(assets.some(a=>a.id===id)?path.join(env.data,p.id,'assets',assets.find(a=>a.id===id).file):env.getImage(p,id)),bytes=await renderSVG(nativeSVG(draft.elements,imageURL,draft.background),{font:{loadSystemFonts:true}},signal);publishRebuildPage(p,env,{index:i,round,source:'scene',bytes});return 'data:image/png;base64,'+bytes.toString('base64');},
          record:entry=>{fs.mkdirSync(recordDir,{recursive:true});fs.writeFileSync(path.join(recordDir,`page-${i+1}-round-${round}.json`),JSON.stringify(entry,null,2));}
        });
      },{signal,limit:()=>projectWorkerLimit(p.executionConcurrency),label:r=>'主模型工具修正 · 第 '+(r.index+1)+' 页 · 第 '+round+' 轮',settle:true});
      env.save(p);return {changed:results.some(r=>r.status==='fulfilled'&&r.value.changed),changedIndices:results.flatMap((r,n)=>r.status==='fulfilled'&&r.value.changed?[failed[n].index]:[]),errors:[...new Set(results.flatMap(r=>r.status==='rejected'?[r.reason.message]:r.value.errors||[]))]};
    }
  });
  if(!p.candidate.renderUnavailable)delete p.rebuildPageChanges;
  p.rebuildLive.status='done';p.rebuildLive.revision++;env.save(p);
  p.task.completionMessage=p.candidate.visualRepair.status==='stalled'&&p.candidate.visualRepair.errors?.length?'自动修正未完成：'+p.candidate.visualRepair.errors.slice(0,2).join('；')+'；已保留原页面及可下载的最后结果':p.candidate.status==='awaiting_review'&&p.candidate.visualRepair.status==='passed'?`实际渲染与视觉对照通过${p.candidate.visualRepair.rounds?'，自动修正 '+p.candidate.visualRepair.rounds+' 轮':''}，可下载最新PPT，继续按页调整`:p.candidate.visualRepair.status==='review_unavailable'?'已保留 PPT、实际渲染与返回记录；部分页面视觉验收未完成，请重新验收':`已保留实际渲染、视觉问题与工具记录；自动修正 ${p.candidate.visualRepair.rounds}/${repairLimit} 轮，仍需修改`;
}
function representativePages(p){
  const eligible=confirmedPages(p),cover=eligible.find(i=>p.slides[i].kind==='cover'),toc=eligible.find(i=>p.slides[i].kind==='toc'),complex=eligible.filter(i=>!['cover','toc'].includes(p.slides[i].kind)).sort((a,b)=>canonicalTexts(p.slides[b]).length-canonicalTexts(p.slides[a]).length)[0];
  const indices=[...new Set([cover,toc,complex].filter(i=>i!==undefined))];return indices.length?indices:eligible.slice(0,1);
}
function conceptFoundationReadiness(p){
  const issues=[];
  if(!confirmedPages(p).length)issues.push('尚无可用的已完成设计稿；请在02保存内容与设计，实际修改过的页面需同步文案或更新设计稿');
  if(!themeAssetsCurrent(p)||p.themeAssets.directions?.length!==3)issues.push('请在03视觉方案先确认三种风格并生成对应底图');
  else for(const d of p.themeAssets.directions)for(const i of representativePages(p))try{requireThemeAssetForPage(p,i,d.id);}catch(e){issues.push(e.message);}
  return {passed:!issues.length,issues};
}
export async function visualAction(p,b,env){
  if(!actionNames.has(b.action))return false;
  const {ensure,launch,event,save}=env;
  if(b.action==='favoriteStyle'){favoriteStyle(p,env.data,b.styleId);event(p,'已收藏风格，可在其他项目的更换风格中选用');return true;}
  if(b.action==='removeFavoriteStyle'){removeFavoriteStyle(env.data,b.favoriteId);event(p,'已取消收藏，已采用此风格的项目保留');return true;}
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
      validatePhotoSubmissions(p,[{d,use:b.use,photoMaterialId:next.photoReference?.materialId||null}]);
      d.assets[b.use]=next;d.promptDrafts||={};
      d.photoReferences||={};d.photoReferences[b.use]=next.photoReference?.materialId||null;
      d.promptDrafts[b.use]={prompt:next.redrawPrompt||next.promptDraft||next.prompt,photoMaterialId:next.photoReference?.materialId||null,revision:draft.revision+1,status:next.previewReview?.status==='passed'?'generated':'pending',updatedAt:new Date().toISOString()};
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
    const instruction=b.instruction??'';let referenceStyleId=b.referenceStyleId??null;
    ensure(p,typeof instruction==='string'&&instruction.length<=3000,'风格要求不超过 3000 字');
    ensure(p,!!env.credentials.get(p.id)?.text?.key,'请先连接主模型 API');
    if(typeof referenceStyleId==='string'&&referenceStyleId.startsWith('FAVORITE-'))referenceStyleId=importFavoriteStyle(p,env.data,referenceStyleId);
    ensure(p,referenceStyleId===null||typeof referenceStyleId==='string'&&(/^[A-F]$/.test(referenceStyleId)||(p.styleRegistry||[]).some(r=>r.id===referenceStyleId&&!r.deletedAt)),'参考风格不存在');
    const changeStyle=b.action==='changeThemeDirection';
    launch(p,changeStyle?'更换方向底图风格':'准备底图重生提示词',async signal=>{
      const prepared=await prepareThemeDirection(p,env,signal,{direction:b.theme,changeStyle,instruction:instruction.trim(),referenceStyleId});
      stageThemePrompts(p,b.theme);save(p);await checkThemePromptDrafts(p,env,signal,{direction:b.theme});save(p);
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
    const submissions=b.action==='generateThemeAsset'?[{theme:b.theme,use:b.use,prompt:imageEdit?.redrawPrompt||b.prompt,revision:b.revision,...(Object.prototype.hasOwnProperty.call(b,'photoMaterialId')?{photoMaterialId:b.photoMaterialId}:{}),...(b.photoSourceHash?{photoSourceHash:b.photoSourceHash}:{})}]:b.prompts;
    validateThemePromptSubmission(p,submissions,b.confirmed,{imageEdit});
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
    const photoMaterialId=Object.prototype.hasOwnProperty.call(b,'photoMaterialId')?b.photoMaterialId:selectedThemePhotoId(d,b.use);validatePhotoSubmissions(p,[{d,use:b.use,photoMaterialId}]);
    const photo=themePhotoReference(p,b.use,photoMaterialId,env,{expectedHash:b.photoSourceHash});
    launch(p,'改写底图提示词',async signal=>{
      const rewritePrompt=`按自然语言修改无字主题底图提示词。${photo?themePhotoPlanningRule+'本次使用随附照片中的主体替换原艺术意象，简短描述照片主体，保留所选风格。':''}${themePromptWritingRuleFor(b.use)}${visualTreatmentContext(p)}以当前稿为依据，以用户意见替换对应旧要求，每项视觉要求只出现一次，不拼接示例或历史版本；输出一份可独立生成的完整新提示词，替换旧稿；不附原稿、修改记录或追加说明。保持主题与全篇材料共同主线，艺术意象可以调整，不要求材料实物；封面与目录在主体、形态或视觉效果上至少一项不同；保留已选预设的视觉语言与主题点缀、核心底色 ${promptColor(presetPageColor(d,b.use))}、16:9（1920×1080）、阅读留白及非事实边界。${promptColorRule}${themeSubjectBriefGuidance}主体要求：${themeAssetSubjectRule(b.use)}。不加文字、图注、文本框或占位框。输出 {prompt:"完整新提示词"}。\n主体来源：${JSON.stringify(d.subjectSources?.[{'hero-image':'heroSubject','toc-image':'tocSubject','content-background':'contentSubject'}[b.use]]||{})}\n主题灵感材料：${JSON.stringify(themeMaterialContext(p))}\n用户意见：${instruction}\n原提示词：${prompt}`;
      const rewriteUser=photo?[{type:'text',text:rewritePrompt},{type:'image_url',image_url:{url:dataURL(path.join(env.data,p.id,photo.file))}}]:rewritePrompt;
      const answer=await chat(env.credentials.get(p.id)?.text,env.system,rewriteUser,signal,{validate:raw=>{textFieldValidator('prompt',{min:11,max:30000})(raw);validateSingleThemePrompt(raw.prompt);return raw;}});
      const rawPrompt=parseJSON(answer.text).prompt;const next=typeof rawPrompt==='string'?themeDrawingPrompt(simplifyPromptColors(rawPrompt)):rawPrompt;ensure(p,typeof next==='string'&&next.trim().length>10&&next.length<=30000,'改写底图提示词无效');
      const check=await checkThemePromptAtBoundary(p,d,b.use,env,signal,{prompt:next,stage:'单张底图',mode:'generate',photoReference:photo||null});
      d.promptDrafts||={};d.photoReferences||={};d.photoReferences[b.use]=photoMaterialId||null;d.promptDrafts[b.use]={prompt:check.prompt,photoMaterialId:photoMaterialId||null,revision:draft.revision+1,status:'pending',promptCheck:{...check,prompt:undefined},updatedAt:new Date().toISOString(),checkedAt:check.checkedAt};
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
      const jobs=concepts.flatMap(c=>representatives.map(index=>({c,index}))),claimed=new Map();
      const {generated,reviewed}=await runPipelined(jobs,async({c,index})=>{
        const joined=claimPageTask(p,index,c.id,'concept');if(joined)claimed.set(c.id+':'+index,joined);
        try{const record=await generatePage(p,index,c,env,signal,folder,'concept',joined?.request.prompt,{deferReview:true});
          if(signal.aborted)throw Error('任务已取消');
          if(record.stamp!==pageStamp(p,index,c.id))throw Error('本页设计已变化，已保存旧图为历史但不覆盖当前结果');
          c.representatives.push(record);save(p,{immediate:true,results:true});return record;
        }catch(error){finishPageTask(joined,error);throw error;}
      },async({c,index},record)=>{let error;try{return await reviewAndRepairPage(p,index,c,env,signal,record,'concept');}catch(e){error=e;throw e;}finally{finishPageTask(claimed.get(c.id+':'+index),error);save(p,{immediate:true,results:true});}},{signal,priority:({c,index})=>queuedPageTask(p,index,c.id,'concept')?100:10,limit:()=>projectWorkerLimit(p.executionConcurrency),label:({c,index})=>'方向 '+c.id.toUpperCase()+' · 第 '+(index+1)+' 页',reviewLabel:({c,index})=>'方案检查 · 方向 '+c.id.toUpperCase()+' · 第 '+(index+1)+' 页'});
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
      const targets=indices.filter(i=>!fullPageCurrent(p,i)||b.force||b.index!==undefined),claimed=new Map();
      const {generated,reviewed}=await runPipelined(targets,async i=>{
        const joined=imageEdit?null:claimPageTask(p,i,theme.id,'full');if(joined)claimed.set(i,joined);
        try{const next=await generatePage(p,i,theme,env,signal,folder,'full',joined?.request.prompt??b.prompt,{deferReview:true,imageEdit});if(signal.aborted)throw Error('任务已取消');
          if(next.stamp!==pageStamp(p,i,theme.id))throw Error('本页设计已变化，已保存旧图为历史但不覆盖当前结果');
          pages[i]=rememberImage(pages[i],next);p.visualPages={...pages};invalidate(p);save(p,{immediate:true,results:true});return pages[i];
        }catch(error){finishPageTask(joined,error);throw error;}
      },async(i,record)=>{let error;try{return await reviewAndRepairPage(p,i,theme,env,signal,record,'full');}catch(e){error=e;throw e;}finally{finishPageTask(claimed.get(i),error);p.visualPages={...pages};save(p,{immediate:true,results:true});}},{signal,priority:i=>queuedPageTask(p,i,theme.id,'full')?100:10,limit:()=>projectWorkerLimit(p.executionConcurrency),label:i=>'完整预览 · 第 '+(i+1)+' 页',reviewLabel:i=>'预览检查 · 第 '+(i+1)+' 页'});
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
  if(b.action==='discardReconstruction'){delete p.rebuildPageChanges;p.reconstruction=null;p.candidate=null;p.output=null;event(p,'已清除重建结果，下次构建将重新拆解');return true;}
  if(b.action==='undoRebuildEdit'){const index=Number(b.index);ensure(p,Number.isInteger(index)&&!!p.slides[index]&&rebuildUndoState(p,index).available,'本页没有可撤回的修改，或版本已变化');const restored=undoRebuildEdit(p,index);event(p,'已撤回：'+restored.label);if(restored.requiresRender)launch(p,'撤回第 '+(index+1)+' 页修改并更新导出',async signal=>{await buildCandidate(p,env,signal,{repairLimit:0,preserveReconstruction:true});p.task.completionMessage='已撤回第 '+(index+1)+' 页并更新导出，其他页面保持不变';});return true;}
  if(b.action==='reviseRebuildElement'||b.action==='extractRebuildRegion'){
    const index=Number(b.index),instruction=String(b.instruction||'').trim()||(b.action==='extractRebuildRegion'?'提取框选区域中的完整目标并自动选择重建方式':'');
    ensure(p,Number.isInteger(index)&&!!p.slides[index]&&rebuiltCurrent(p)&&p.approvals.preview===p.version,'请先完成当前版本素材拆解并确认完整预览');
    ensure(p,instruction.length>=2&&instruction.length<=6000,'请填写元素描述或修改要求（最多6000字）');
    const page=p.reconstruction.slides[index],target=b.action==='reviseRebuildElement'?page.elements.find(e=>e.key===b.key):null;
    if(b.action==='reviseRebuildElement'){ensure(p,!!target,'指定元素已不存在，请刷新素材清单');ensure(p,!b.targetStamp||b.targetStamp===digest(target),'此元素已变化，请刷新后重新提交修改');}
    if(b.action==='extractRebuildRegion')ensure(p,b.previewHash===p.visualPages[index].previewHash,'预览已变化，请重新框选补拆区域');
    const regionScope=b.action==='extractRebuildRegion'?extractionScope(b.region,page.elements,resolveArtisticTextKey(page.elements,b.region,instruction,b.artisticTextKey),{automaticTarget:true}):null;
    rememberRebuildEdit(p,regionScope?'第 '+(index+1)+' 页补拆元素':'第 '+(index+1)+' 页修改元素 '+target.key,index);
    const recordKey=regionScope?'region-'+crypto.randomUUID():index+':'+target.key,feedback={index,instruction,...(target?{targetKey:target.key}:{regionScope})};
    p.rebuildElementFeedback??={};p.rebuildElementFeedback[recordKey]={index,key:target?.key||regionScope?.artisticText?.key||null,...(regionScope?.artisticText?{artisticText:regionScope.artisticText}:{}),instruction,status:'pending',at:new Date().toISOString()};
    launch(p,regionScope?'框选区域补拆与渲染':'单元素修改与渲染',async signal=>{
      await buildCandidate(p,env,signal,{feedback:[feedback]});
      if(regionScope?.artisticText)Object.assign(p.rebuildElementFeedback[recordKey],{key:regionScope.artisticText.key,artisticText:regionScope.artisticText});
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
  if(b.action==='repairRebuildPage'){
    const index=b.index,instruction=String(b.instruction||'').trim()||'对照本页批准预览和实际渲染，逐项修正已有检查问题及明显的排版、形状、箭头和文字样式偏差；保留准确文字、原图与其他页面。若视觉验收暂不可用，请直接看图判断，不把接口错误当作页面问题。';
    ensure(p,Number.isInteger(index)&&!!p.slides[index],'请选择有效的单页工具修正目标');
    ensure(p,p.task?.status!=='running','请等待当前任务结束后再进行本页工具修正');
    ensure(p,p.approvals.preview===p.version&&fullPageCurrent(p,index)&&rebuiltCurrent(p),'请先确认当前预览并完成素材拆解');
    ensure(p,!!p.reconstruction.slides[index]?.elements?.length,'本页尚无重建元素，请先拆解本页');
    ensure(p,instruction.length<=6000,'本页工具修正意见最多6000字');rebuildConfig(env,p);
    rememberRebuildEdit(p,'第 '+(index+1)+' 页工具修正',index);
    launch(p,'第 '+(index+1)+' 页工具修正',async signal=>{
      await buildCandidate(p,env,signal,{feedback:[{index,instruction}],repairLimit:1,preserveReconstruction:true,manualRepair:true});
      p.task.completionMessage='第 '+(index+1)+' 页工具修正已结束；'+p.task.completionMessage.replaceAll('自动修正','工具修正');
    });return true;
  }
  if(b.action==='retryRebuildPage'){
    const index=b.index;
    ensure(p,Number.isInteger(index)&&!!p.slides[index],'请选择有效的单页拆解目标');
    ensure(p,p.approvals.preview===p.version&&fullPageCurrent(p,index),'请先确认当前版本的完整预览');rebuildConfig(env,p);
    rememberRebuildEdit(p,'第 '+(index+1)+' 页素材拆解重试',index);markRebuildPages(p,[index]);
    launch(p,'重试第 '+(index+1)+' 页素材拆解',async signal=>{
      p.output=null;p.candidate=null;
      const result=await rebuild(p,env,signal,{indices:[index]});
      if(result)p.task.completionMessage='第 '+(index+1)+' 页素材拆解已更新，其他页面结果保持，可继续构建 PPT';
      save(p);
    });return true;
  }
  if(b.action==='setDeliveryMotion'){
    delete p.rebuildPageChanges;p.deliveryMotion=deliveryMotionSettings(b.settings);prepareRebuildPresentation(p);p.output=null;p.candidate=null;event(p,'已更新进度条版式与动画，重新构建后生效');return true;
  }
  if(b.action==='reconstructPreview'||b.action==='build'){
    ensure(p,p.approvals.preview===p.version&&p.slides.every((s,i)=>fullPageCurrent(p,i)),'请先批准当前版本完整生图预览');rebuildConfig(env,p);
    if(b.instruction!==undefined){const instruction=String(b.instruction).trim();ensure(p,instruction.length<=6000,'重建意见最多 6000 字');p.rebuildInstructions=instruction;if(instruction){delete p.rebuildPageChanges;p.reconstruction=null;}}
    launch(p,b.action==='build'?'重建、渲染与交付验收':'拆解复杂视觉并重建素材',async signal=>{if(b.action==='build')await buildCandidate(p,env,signal,{freshAssembly:!rebuildPageScope(p)});else{delete p.rebuildPageChanges;p.output=null;p.candidate=null;p.reconstruction=null;p.rebuildLive=null;p.rebuildAssetPreview=null;startRebuildLive(p,env);await rebuild(p,env,signal);}});return true;
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
    if(b.action==='saveVisualPrompt'){const local=finalizePromptDraft({stage:'整页预览',mode:'generate',context:{title:p.slides[i].title,visualTreatment:p.visualTreatment},protectedTexts:canonicalTexts(p.slides[i]).map(node=>node.text)},prompt);page.promptDraft=local.prompt;page.promptCheck={...local,prompt:undefined};event(p,'整页提示词草稿已保存');return true;}
    const instruction=String(b.instruction||'').trim();ensure(p,instruction.length>0&&instruction.length<3000,'请填写修改意见');launch(p,'改写整页生图提示词',async signal=>{const direction=p.concepts.find(c=>c.id===(b.kind==='concept'?b.theme:p.selectedTheme)),mode=b.kind==='concept'?'concept':'full';const r=await chat(env.credentials.get(p.id)?.text,env.system,rewriteSlidePromptRequest(p,prompt,instruction),signal,{validate:textFieldValidator('prompt',{min:11,max:30000})});const rawPrompt=parseJSON(r.text).prompt;const next=typeof rawPrompt==='string'?simplifyPromptColors(rawPrompt):rawPrompt;ensure(p,typeof next==='string'&&next.length>10&&next.length<=30000,'提示词无效');if(signal.aborted)throw Error('任务已取消');const boundary=await checkPagePromptAtBoundary(p,i,direction,env,signal,{prompt:effectiveSlideImagePrompt(p,i,direction,page.images||[],mode,next),originalPlan:page.images||[],manual:false});page.promptDraft=boundary.prompt;page.promptCheck={...boundary,prompt:undefined};});return true;
  }
  return false;
}
export function visualPublic(p,env){recoverRebuildScenes(p,env);return {openFontSupportMode:'automatic',visualTreatmentOptionsEnabled:true,singleElementEditing:true,regionExtraction:true,rebuildUndo:rebuildUndoState(p),rebuildAssets:rebuildAssetInventory(p,env),rebuildPageChecks:p.slides.map((_,index)=>({index,issues:rebuildPageIssues(p,index,p.candidate?.structure)})),rebuildLive:rebuildLiveCurrent(p)?p.rebuildLive:null,candidateDownload:draftDownloadState(p),previewReviewRepairLimit,renderReviewRepairLimit,rebuildVisualRepairLimit,rebuildToolEditing:true,rebuildAssetTools:true,rebuildPageRepairEnabled:true,rebuildPageRetryEnabled:true,unifiedRebuildProgress:true,deliveryMotion:deliveryMotionSettings(p.deliveryMotion),visualTextStyleNormalization:true,nativeGradients:true,elementAuditRepairLimit:auditRepairLimit,visualColorNormalization:true,previewApprovalEnabled:true,previewApprovalState:previewApprovalState(p),styleRegistryDeletion:true,postPasteGeometryOnly:true,originalImageAspectAdjustmentEnabled:true,nestedContentPrompts:true,imagePromptVersion,aiImageEditModes:true,aiImageUndo:true,atomicContentConfirmation:true,previewImageToImage:true,placeholderRepairLimit,placeholderRatioTolerance,placeholderCountRepairLimit,conceptFoundationReadiness:conceptFoundationReadiness(p),themeDirectionActions:true,previewCrossStyleEditing:true,previewCrossStyleOptions:previewCrossStyleOptions(p),themeCrossStyleEditing:true,themeCrossStyleOptions:themeCrossStyleOptions(p),themePromptConfirmation:true,themePhotoReferenceEnabled:true,themeAutoContinue:false,themeBackgroundReview:false,themePromptRegeneration:true,themeAssetPrompts:themePromptDrafts(p),themeAssetsQualityBlocked:themeAssetsCurrent(p)&&p.themeAssets.directions?.length===3&&!themeAssetsReady(p),workflowLibrary:workflowLibrarySummary,themeAssetsCurrent:themeAssetsCurrent(p),themeAssetsReady:themeAssetsReady(p),automaticVisualRepairLimit:visualRepairLimit,conceptReadiness:Object.fromEntries(p.concepts.filter(c=>c.mode==='ai').map(c=>[c.id,conceptReadiness(p,c)])),designStandards:designAcceptance(p,p.slides.map((s,i)=>fullPageCurrent(p,i)?p.visualPages[i]:null)),confirmedVisualPages:confirmedPages(p),fullPreviewPages:p.slides.map((s,i)=>fullPageCurrent(p,i)),visualReconstructionCurrent:rebuiltCurrent(p)&&!incompleteRebuildPages(p).length,releaseCurrent:releaseCurrent(p)};}
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
    const type=url.searchParams.get('type')||'pptx',base=verifyCandidate(p,env,{downloadOnly:type==='pptx'});
    res.setHeader('x-ppt-agent-status','review-required');
    if(type==='report'){
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','content-disposition':'attachment; filename="deck-review-required-report.json"'});res.end(JSON.stringify(draftReviewReport(p),null,2));return true;
    }
    ensure(p,['pptx','pdf'].includes(type),'下载类型不存在');
    sendFile(res,path.join(base,type==='pptx'?p.candidate.file:'deck.pdf'),type==='pptx'?'application/vnd.openxmlformats-officedocument.presentationml.presentation':'application/pdf','deck-review-required.'+type);return true;
  }
  if(parts[3]==='preview'&&p.visualMode==='ai'){
    const i=Number(url.searchParams.get('slide')||0),theme=url.searchParams.get('theme');let page;
    if(theme)page=p.concepts.find(c=>c.id===theme)?.representatives?.find(r=>r.index===i);else page=p.visualPages?.[i];
    const revision=url.searchParams.get('revision');if(revision){const old=page?.repairHistory?.find(r=>r.jobFile===revision);ensure(p,!!old,'历史版本不存在');page=old;}
    if(page?.file&&page.previewHash){
      const file=visualFile(env,p,page),root=path.resolve(env.data,p.id);
      ensure(p,path.resolve(file).startsWith(root+path.sep)&&fs.existsSync(file)&&fileHash(file)===page.previewHash,'已保存的预览图片缺失或已变化');
      // Viewing a saved result must not silently approve stale content or rules.
      const current=theme?page.stamp===pageStamp(p,i,theme)&&!!pageDesignState(p,i)?.approvedCurrent:fullPageCurrent(p,i);
      res.setHeader('x-preview-status',revision?'history':current?'current':'stale');
      sendFile(res,file,'image/png');return true;
    }
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
