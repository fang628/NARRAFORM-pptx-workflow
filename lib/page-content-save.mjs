import {isDeepStrictEqual} from 'node:util';
import {validateSlides as defaultValidateSlides} from './scene.mjs';
import {validateSourceReferences as defaultValidateReferences} from './source-references.mjs';
import {checkContentPages as defaultCheckContentPages} from './content-check.mjs';
import {syncFormulaDesign as defaultSyncFormulaDesign} from './formula-design-sync.mjs';

const isObject=value=>value&&typeof value==='object'&&!Array.isArray(value);

// Save exactly one existing page from the 02 editor. The server merges the incoming page into its
// current slides; a whole old slides array is never accepted or used to overwrite other pages.
// `baseSlide` is an optional optimistic lock for THIS page only: another page changing (and thus
// changing the project version) must not block this save. Dependencies are injected by the server
// under their real names so a future test/mock cannot be silently ignored.
export function savePageContentAction(p,payload,{
  validateSlides=defaultValidateSlides,
  validReferences=defaultValidateReferences,
  checkContentPages=defaultCheckContentPages,
  syncFormulaDesign=defaultSyncFormulaDesign,
  contentChanged=null
}={}){
  const index=payload?.index;
  if(!Number.isInteger(index)||index<0||index>=p.slides.length)throw Error('页面不存在或页码无效');
  if(!isObject(payload?.slide))throw Error('单页内容格式无效');
  const before=p.slides[index];
  if(payload.baseSlide!=null){
    if(!isObject(payload.baseSlide))throw Error('单页基线格式无效');
    if(!isDeepStrictEqual(payload.baseSlide,before))throw Error('本页内容已在其他位置更新，请刷新本页后重试');
  }
  // Merge only the current page. Missing fields keep the current server page (e.g. unchanged notes
  // or progressSectionId); other pages are never replaced by the request.
  const candidate={...before,...structuredClone(payload.slide)};
  const [validated]=validateSlides([candidate],p.brief||{});
  validReferences(p,[validated]);
  const design=syncFormulaDesign(p,index,validated);
  if(isDeepStrictEqual(validated,before)&&!design)return {changed:false,index,slide:before,design:null};
  // Run the per-page check on a working copy first: a rejected check must not leave the live
  // project with a half-applied page or partially updated contentChecks.
  const working={...p,slides:p.slides.map((slide,i)=>i===index?validated:slide),contentChecks:structuredClone(p.contentChecks||{})};
  checkContentPages(working,{indices:[index]});
  // Validation and checking have succeeded; only now mutate the live server project.
  p.slides[index]=validated;
  p.contentChecks=working.contentChecks;
  if(contentChanged)contentChanged(p);
  else{p.version=(p.version||0)+1;p.approvals??={};p.approvals.content=null;p.approvals.preview=null;p.output=null;p.candidate=null;}
  if(design){p.pageDesigns??={};p.pageDesigns[index]=design;}
  return {changed:true,index,slide:validated,design};
}

// Edit one already-published page of the running content pipeline draft. This never touches the
// user's current project slides/version/stamp and never approves content; only the draft page is
// replaced. The existing design object is kept so a text-only edit can reuse its layout (the public
// projection marks designCurrent=false / needsDesignSync=true instead of presenting it as current).
export function savePipelinePageContentAction(p,payload,{
  validateSlides=defaultValidateSlides,
  validReferences=defaultValidateReferences
}={}){
  const draft=p.contentPipelineDraft;
  if(!draft||!Array.isArray(draft.pages))throw Error('当前没有逐页生成草稿可编辑');
  const index=payload?.index;
  if(!Number.isInteger(index)||index<0||index>=draft.pages.length)throw Error('页面不存在或页码无效');
  if(!isObject(payload?.slide))throw Error('单页内容格式无效');
  const entry=draft.pages[index];
  if(!entry?.slide)throw Error('本页内容尚未生成完成，暂不能编辑');
  if(payload.baseSlide!=null){
    if(!isObject(payload.baseSlide))throw Error('单页基线格式无效');
    if(!isDeepStrictEqual(payload.baseSlide,entry.slide))throw Error('本页内容已在其他位置更新，请刷新本页后重试');
  }
  // Keep the draft's own page identity and structure defaults; only the current page changes.
  const candidate={...entry.slide,...structuredClone(payload.slide)};
  const [validated]=validateSlides([candidate],p.brief||{});
  validReferences(p,[validated]);
  if(isDeepStrictEqual(validated,entry.slide))return {changed:false,index,slide:entry.slide};
  entry.slide=structuredClone(validated);
  delete entry.error;
  if(entry.design){entry.designPending=true;}
  // A previously finished page is no longer fully finished after a text/structure edit; keep the
  // content editable and let the public projection report its design as needing sync/rework.
  if(entry.status==='done')entry.status='content-ready';
  return {changed:true,index,slide:entry.slide};
}
