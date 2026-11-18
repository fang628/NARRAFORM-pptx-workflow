// Missing cover preserves the behavior of projects created before this option.
export const hasTitlePage=brief=>brief.cover!==false;
export const backgroundUsesForBrief=brief=>Number(brief.pages)===1?[hasTitlePage(brief)?'hero-image':'content-background',...(brief.chapterPages?['toc-image']:[])]:[...(hasTitlePage(brief)?['hero-image']:[]),...(brief.toc||brief.chapterPages?['toc-image']:[]),'content-background'];
export const isTOCPage=(slide,index,brief={})=>slide?.kind==='toc'||!!brief.toc&&index===(hasTitlePage(brief)?1:0);
export const isThanksPage=slide=>slide?.kind==='thanks'||/^(?:致谢|结束致谢|感谢聆听|感谢观看|谢谢(?:大家|聆听|观看)?|thank\s*you|thanks)(?:[!！。\s]*)$/i.test(String(slide?.title||'').trim());
export const pageDisallowsImages=(slide,index,brief={})=>!!slide?.generatedChapter||isTOCPage(slide,index,brief)||isThanksPage(slide);
export const specialPageVisualRule='目录页和致谢页禁止新增或插入内容图片、照片、插画及图片占位节点；仅使用文字、必要的原生几何和既定无字底图，不将缺图列为缺口。致谢页不显示进度条。';
export function assertPageImages(slide,index,brief={}){
  if(!pageDisallowsImages(slide,index,brief))return;
  const hasImage=node=>node?.type==='image'||!!node?.imageId||(node?.elements||node?.children||[]).some(hasImage);
  if(hasImage(slide))throw Error((slide?.generatedChapter?'章节页':isThanksPage(slide)?'致谢页':'目录页')+'不允许添加图片，请移除图片节点及配图');
}
export function pageStructurePrompt(brief){
  const chapters=brief.chapterPages?'章节页由程序根据进度章节在04/05额外派生，不计目标页数，02不生成kind=section或章节过渡内容。':'';
  if(Number(brief.pages)===1)return `只生成 1 页独立${hasTitlePage(brief)?'封面，kind=cover':'内容页，kind=content'}，将本次要求的内容集中在这一页；不添加目录、章节页、致谢页或第二页。${chapters}`;
  return `${hasTitlePage(brief)?'包含标题页（封面），第一页 kind=cover，其余页不得重复封面':'不包含标题页或封面，所有页面禁止 kind=cover，不以开场页替代封面'}；${brief.toc?'包含目录，目录位于'+(hasTitlePage(brief)?'第二页':'第一页')+'，kind=toc':'不包含目录页'}；${brief.thanks?'包含唯一结束致谢，最后一页 kind=thanks':'不包含致谢或独立结束页'}。${chapters}${specialPageVisualRule}总页数包含所有已选页面，不能在目标页数之外再追加封面、目录或致谢；先分配总页数，提交前核对 slides 数量。`;
}
// TOC/thanks decoration is native-only: text plus necessary native geometry on the registered
// wordless background. S2 registration, audit validation, reuse normalization and assembly share
// this one policy so legacy auto-registered SVG light effects never reach export.
export const specialPageNativeOnly=(slide,index,brief={})=>!slide?.generatedChapter&&(isTOCPage(slide,index,brief)||isThanksPage(slide));
export const legacySpecialPageDecoration=element=>{
  if(!element)return false;
  const representation=element.type==='svg'||element.type==='image'&&element.implementation==='svg';
  return representation&&(element.role==='effect'||!!element.effectOf||element.visualKind==='light-effect'||element.effectKind==='lit-stroke'||/^auto-(?:line|arc)-\d+x*$/.test(String(element.key||'')));
};
export function normalizeSpecialPageElements(slide,index,elements=[],brief={}){
  if(!specialPageNativeOnly(slide,index,brief))return {elements,removed:[]};
  const kept=[],removed=[];
  for(const element of elements||[])(legacySpecialPageDecoration(element)?removed:kept).push(element);
  return {elements:kept,removed};
}
const relationKey=item=>typeof item==='string'?item:item?.key??item?.instanceId??null;
function withoutRemoved(list,gone){return Array.isArray(list)?list.filter(item=>!gone.has(relationKey(item))):list;}
function pruneLayers(list,gone){
  return Array.isArray(list)?list.filter(layer=>!gone.has(relationKey(layer))).map(layer=>Array.isArray(layer.frontOf)?{...layer,frontOf:layer.frontOf.filter(key=>!gone.has(key))}:layer):list;
}
function pruneComponentSnapshot(snapshot,gone){
  if(!snapshot)return snapshot;
  const next={...snapshot};
  if(next.objects)next.objects=Object.fromEntries(Object.entries(next.objects).filter(([key])=>!gone.has(key)));
  if(next.parameters)next.parameters=Object.fromEntries(Object.entries(next.parameters).filter(([key])=>!gone.has(key)));
  if(Array.isArray(next.components))next.components=next.components.filter(component=>!gone.has(component?.anchor)).map(component=>({...component,members:(component.members||[]).filter(key=>!gone.has(key))}));
  return next;
}
// Strip references to removed decorations from the page's derived metadata (audit copies, scene
// layers, inventories, component snapshots, correspondence). Those records otherwise keep dangling
// keys that review/repair reads as missing objects and may try to restore, retrying the page.
export function pruneSpecialPageRelations(page,removed=[]){
  const gone=new Set((removed||[]).map(relationKey).filter(Boolean));
  if(!page||!gone.size)return page;
  if(Array.isArray(page.audit))page.audit=withoutRemoved(page.audit,gone);
  if(page.scene){
    const scene={...page.scene};
    if(Array.isArray(scene.objects))scene.objects=scene.objects.filter(object=>!gone.has(object?.instanceId));
    if(scene.layerInventory)scene.layerInventory=pruneLayers(scene.layerInventory,gone);
    if(scene.localComponents)scene.localComponents=pruneComponentSnapshot(scene.localComponents,gone);
    page.scene=scene;
  }
  if(page.localComponents)page.localComponents=pruneComponentSnapshot(page.localComponents,gone);
  if(page.auditValidation){
    const validation={...page.auditValidation};
    if(validation.layerInventory)validation.layerInventory=pruneLayers(validation.layerInventory,gone);
    if(Array.isArray(validation.frameInventory))validation.frameInventory=withoutRemoved(validation.frameInventory,gone);
    if(Array.isArray(validation.numberInventory))validation.numberInventory=withoutRemoved(validation.numberInventory,gone);
    if(Array.isArray(validation.instanceGroups))validation.instanceGroups=validation.instanceGroups.map(group=>Array.isArray(group?.keys)?{...group,keys:group.keys.filter(key=>!gone.has(key))}:group);
    page.auditValidation=validation;
  }
  if(page.correspondence){
    const correspondence={...page.correspondence};
    if(Array.isArray(correspondence.matches))correspondence.matches=withoutRemoved(correspondence.matches,gone);
    for(const field of ['unmatchedElements','missingFrames'])if(Array.isArray(correspondence[field]))correspondence[field]=correspondence[field].filter(key=>!gone.has(key));
    if(Array.isArray(correspondence.warnings))correspondence.warnings=correspondence.warnings.filter(warning=>![...gone].some(key=>String(warning).includes(key)));
    page.correspondence=correspondence;
  }
  if(page.elementQuality&&Array.isArray(page.elementQuality.objects))page.elementQuality={...page.elementQuality,objects:withoutRemoved(page.elementQuality.objects,gone)};
  if(Array.isArray(page.textMeasurements))page.textMeasurements=withoutRemoved(page.textMeasurements,gone);
  if(Array.isArray(page.failedElements))page.failedElements=page.failedElements.filter(item=>!gone.has(relationKey(item)));
  if(Array.isArray(page.localProblems))page.localProblems=page.localProblems.filter(item=>!gone.has(relationKey(item)));
  if(Array.isArray(page.issues))page.issues=page.issues.filter(issue=>{
    const match=typeof issue==='string'&&issue.match(/^元素未完成：([^\s]+)(?: · .*)?$/u);
    return !match||!gone.has(match[1]);
  });
  if(page.instanceManifest&&Array.isArray(page.instanceManifest.groups)){
    const groups=page.instanceManifest.groups.map(group=>({...group,instances:(group.instances||[]).filter(instance=>!gone.has(relationKey(instance)))})).filter(group=>group.instances.length).map(group=>({...group,count:group.instances.length}));
    page.instanceManifest={...page.instanceManifest,count:groups.reduce((sum,group)=>sum+group.count,0),groups};
  }
  return page;
}
// Shared special-page normalization: filter the native-only decoration and keep derived page
// relations consistent in the same step, so reuse/review sees a clean page instead of retrying it.
export function normalizeSpecialPage(page,slide,index,brief={}){
  const normalized=normalizeSpecialPageElements(slide,index,page?.elements||[],brief);
  if(normalized.removed.length&&page){
    page.elements=normalized.elements;
    pruneSpecialPageRelations(page,normalized.removed);
  }
  return normalized;
}
export const specialPageNativeDecorationRule='目录页和致谢页只允许文字、必要的原生几何（矩形、椭圆、原生图形、直线）与既定无字底图：真实分隔线按原生line登记；不登记SVG光效、光条、图片、插画、抠图或生成素材，也不把缺图列为缺口。';
export function assertSpecialPageDecoration(slide,index,elements=[],brief={}){
  if(!specialPageNativeOnly(slide,index,brief))return;
  const allowed=new Set(['text','formula','rect','ellipse','line','shape']);
  // Authorized artisticText keeps its existing exception: it is a text substitute validated by the
  // audit's authorization branch, not a content image or a decorative SVG.
  const unsupported=(elements||[]).filter(element=>!element||(!allowed.has(element.type)&&!(element.type==='image'&&element.artisticText===true)));
  if(unsupported.length)throw Error('目录页和致谢页只允许文字与原生装饰，不支持SVG、图片、插画、抠图或生成素材：'+unsupported.map(element=>element?.key||element?.type||'未命名').join('、'));
}
export function validateGeneratedTitlePage(slides,brief){
  const coverIndices=slides.flatMap((s,i)=>s.kind==='cover'?[i]:[]);
  if(hasTitlePage(brief)?coverIndices.length!==1||coverIndices[0]!==0:coverIndices.length!==0)throw Error(hasTitlePage(brief)?'模型未按要求在第一页生成唯一标题页，请重试':'已关闭标题页，但模型仍返回封面，请重试');
}
