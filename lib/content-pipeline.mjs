import {chat,parseJSON} from './provider.mjs';
import {runTaskGraph} from './task-graph.mjs';
import {concurrencyLimit,projectWorkerLimit} from './concurrency.mjs';
import {initialElements} from './elements.mjs';
import {pageStructurePrompt,validateGeneratedTitlePage} from './page-options.mjs';
import {progressSectionsOf,assignProgressSections} from './progress-navigation.mjs';
import {pageDesignState} from './page-design.mjs';
import {reportTask} from './task-progress.mjs';
import {readingIndexOverview} from './material-chunks.mjs';
import {analysisCurrent,materialStamp} from './materials.mjs';
import {materialTextLimit} from '../public/material-text-policy.js';

export const contentPipelineVersion=1;
export function validateContentPlan(value,p){
  if(!Array.isArray(value?.pages)||value.pages.length!==p.brief.pages)throw Error('全篇规划须严格覆盖目标页数，每页一项');
  const materials=new Map(p.materials.filter(m=>!m.excludedFromContent&&m.documentFigure?.kind!=='table'&&!m.reconstructed&&m.purpose!=='workflow-background'&&m.purpose!=='reconstruction').map(m=>[m.id,m]));
  const usedImages=new Set(),sections=new Set(progressSectionsOf(p).map(s=>s.id));
  const pages=value.pages.map((page,index)=>{
    if(!page||!['cover','toc','content','section'].includes(page.kind)||typeof page.title!=='string'||!page.title.trim()||page.title.length>60)throw Error(`全篇规划第 ${index+1} 页缺少有效页型或标题`);
    if(typeof page.objective!=='string'||!page.objective.trim()||page.objective.length>800)throw Error(`全篇规划第 ${index+1} 页须给出简短内容任务`);
    if(!Array.isArray(page.materialIds)||!Array.isArray(page.imageIds))throw Error('规划须逐页分配材料与图片编号，无则空数组');
    const materialIds=[...new Set(page.materialIds)],imageIds=[...new Set(page.imageIds)];
    if(materialIds.some(id=>!materials.has(id)))throw Error('全篇规划引用不存在或已排除的材料');
    const sourceBlocks=Array.isArray(page.sourceBlocks)?page.sourceBlocks:[];
    for(const source of sourceBlocks){
      const reading=p.analysis?.readings?.find(r=>r.id===source.materialId),valid=reading?.informationIndex?.blocks||[];
      if(!materialIds.includes(source.materialId)||!Array.isArray(source.blockIds)||!source.blockIds.length||source.blockIds.some(id=>!valid.some(b=>b.id===id)))throw Error('页面取证分块须引用完整索引中的真实编号');
    }
    for(const id of materialIds)if((materials.get(id).text?.length||0)>materialTextLimit&&p.analysis?.readings?.find(r=>r.id===id)?.informationIndex&&!sourceBlocks.some(s=>s.materialId===id))throw Error('长文档页面必须选择支撑本页的sourceBlocks，不把整份原文重复塞入每页');
    for(const id of imageIds){
      const m=materials.get(id);if(m?.kind!=='image')throw Error('规划配图必须使用登记图片编号');
      const identity=m.sha256||m.file||m.id;
      if(usedImages.has(identity))throw Error('全篇规划配图重复，请将同一图片分配给最贴切的一页，其他页选互补图片或不配图');
      usedImages.add(identity);
    }
    if(p.brief.toc?(index===(p.brief.cover!==false?1:0)&&page.kind!=='toc'):(page.kind==='toc'))throw Error('全篇规划的目录页位置与需求不一致');
    if(page.kind==='toc'&&index!==(p.brief.cover!==false?1:0))throw Error('全篇规划不能重复添加目录页');
    if(page.progressSectionId&&!sections.has(page.progressSectionId))throw Error('规划必须使用实际页顶章节编号');
    return {index,kind:page.kind,title:page.title.trim(),objective:page.objective.trim(),materialIds:[...new Set([...materialIds,...imageIds])],imageIds,...(sourceBlocks.length?{sourceBlocks:sourceBlocks.map(s=>({materialId:s.materialId,blockIds:[...new Set(s.blockIds)]}))}:{}),...(page.progressSectionId?{progressSectionId:page.progressSectionId}:{})};
  });
  validateGeneratedTitlePage(pages,p.brief);
  if(p.brief.pages===1&&pages[0].kind!==(p.brief.cover!==false?'cover':'content'))throw Error('单页规划须遵循标题页开关');
  return pages;
}

export function contentPlanPrompt(p){
  p={...p,analysis:p.analysis?{...p.analysis,readings:p.analysis.readings?.map(readingIndexOverview)}:null};
  const relationContext='用户制作要求：'+JSON.stringify(p.materialInstruction||'')+'\n材料整体关系：'+JSON.stringify(p.analysis?.materialRelations||null)+'\n'+
    '每页额外返回sourceBlocks:[{materialId:"所选材料id",blockIds:["完整信息索引中的真实C编号"]}]，按本页问题选择所有需要的证据块；长文档必填。不删完整索引，只决定本页调取范围；跨块论点与条件须一同选择。\n';
  return `先规划整套PPT。\n${relationContext}规划页序、主题、材料与配图分配，暂不写内容树或设计稿。恰好 ${p.brief.pages} 页。${pageStructurePrompt(p.brief)}每页一个明确主题，相关页承接，全篇覆盖关键内容，避免重复。已有合适照片、示意图或流程图应主动分配给最相关的一页；同一图片（含重复文件）全篇只分配一次，不为凑图挤入无关图片。表格使用可编辑表格数据，不分配表格截图。页顶章节沿用给定真实编号。输出 {pages:[{kind:"cover|toc|content|section",title:"本页简短标题",objective:"本页应呈现的关键内容、与前后页的承接及必要数据范围，短语即可",materialIds:["支撑本页的实际材料id"],imageIds:["必须插入的登记图片id，无则空数组"],progressSectionId:"已有章节id或null"}]}。只输出精简的规划JSON，不提前写全文。\n需求：${JSON.stringify(p.brief)}\n章节：${JSON.stringify(progressSectionsOf(p))}\n材料理解与提纲：${JSON.stringify(p.analysis?{summary:p.analysis.summary,outline:p.analysis.outline,reviewNotes:p.analysis.reviewNotes,readings:p.analysis.readings?.map(r=>({id:r.id,summary:r.summary,keyPoints:r.keyPoints,facts:r.facts,tables:r.tables,formulas:r.formulas,suggestedUse:r.suggestedUse,informationIndex:r.informationIndex}))}:null)}`;
}

function skeleton(spec){return {kind:spec.kind,title:spec.title,subtitle:'',body:[],notes:'',sources:[],sourceLinks:[],imageId:null,...(spec.progressSectionId?{progressSectionId:spec.progressSectionId}:{}),elements:[{id:'title',type:'text',role:'title',text:spec.title,parentId:null}]};}

// A page request only needs the materials assigned to that page. The global outline/summary and
// the page's own excerpts stay, while readings for unrelated materials are omitted from the
// repeated prompt. This cuts request length without reducing the page's evidence pool.
export function pageGenerationSubset(p,ids,{sourceBlocks=[]}={}){
  const selected=new Set(ids||[]);
  const subset={
    ...p,
    materials:(p.materials||[]).filter(m=>selected.has(m.id)).map(m=>{
      const requested=sourceBlocks.filter(s=>s.materialId===m.id).flatMap(s=>s.blockIds),blocks=p.analysis?.readings?.find(r=>r.id===m.id)?.informationIndex?.blocks;
      return requested.length&&blocks?{...m,promptExcerptIds:blocks.filter(b=>requested.includes(b.id)).flatMap(b=>b.excerptIds||[])}:m;
    }),
    ...(p.analysis?{analysis:{...p.analysis,readings:(p.analysis.readings||[]).filter(reading=>selected.has(reading.id)).map(r=>{
      const requested=sourceBlocks.filter(s=>s.materialId===r.id).flatMap(s=>s.blockIds);
      return requested.length&&r.informationIndex?{...r,informationIndex:{...r.informationIndex,blocks:r.informationIndex.blocks.filter(b=>requested.includes(b.id))}}:r;
    })}}:{})
  };
  if(p.analysis&&analysisCurrent(p))subset.analysis={...subset.analysis,stamp:materialStamp(subset)};
  return subset;
}

// Keep drafts separate from the user's current deck until every content page is
// valid. Each page can nevertheless start its design while others generate.
export async function generateContentPipeline(p,{stamp,config,system,signal,planContext='',save=()=>{},generatePage,designPage,validatePage,generatedPagesValidated=false,request=chat}){
  let draft=p.contentPipelineDraft;
  if(draft?.stamp!==stamp||draft.version!==contentPipelineVersion){
    draft=p.contentPipelineDraft={version:contentPipelineVersion,stamp,status:'planning',pages:[],startedAt:new Date().toISOString()};save(p);
  }
  let specs;
  if(draft.plan)specs=validateContentPlan({pages:draft.plan},p);
  else{
    reportTask(signal,{kind:'step',message:'先确定全篇页序、材料和配图分配，再并发生成各页内容与设计'});
    let answer;
    try{answer=await request(config,system,contentPlanPrompt(p)+'\n材料与可用配图：'+planContext,signal,{validate:raw=>{validateContentPlan(raw,p);return raw;}});}
    catch(error){draft.status=signal?.aborted?'cancelled':'failed';save(p);throw error;}
    signal?.throwIfAborted();specs=validateContentPlan(answer.value||parseJSON(answer.text),p);draft.plan=specs;p.lastUsage=answer.usage;save(p);
  }
  const working={...p,slides:specs.map(skeleton),pageDesigns:{}};
  assignProgressSections(working);
  const sectionIds=working.slides.map(s=>s.progressSectionId);
  const place=(slide,index,resumed=false)=>({...validatePage(slide,resumed?{...specs[index],title:slide.title,kind:slide.kind}:specs[index]),...(sectionIds[index]?{progressSectionId:sectionIds[index]}:{})});
  draft.pages=specs.map((spec,index)=>({...draft.pages[index],index,title:spec.title,status:'queued'}));draft.status='running';
  for(const entry of draft.pages)if(entry.slide){
    try{working.slides[entry.index]=place(entry.slide,entry.index,true);if(entry.design)working.pageDesigns[entry.index]=structuredClone(entry.design);}
    catch{delete entry.slide;delete entry.design;}
  }
  save(p);
  const nodes=specs.flatMap((spec,index)=>[
    {id:'content-'+index,label:'逐页内容 · 第 '+(index+1)+' 页',priority:30,run:async()=>{
      const entry=draft.pages[index];entry.status='generating';delete entry.error;save(p);
      try{
        const slide=entry.slide||await generatePage(spec,index,working,specs);
        signal?.throwIfAborted();
        // The server's contentWithEvidence already validates each generated page. Other callers
        // retain the validation gate by default; resumed drafts always pass through place().
        working.slides[index]=!entry.slide&&generatedPagesValidated?{...slide,...(sectionIds[index]?{progressSectionId:sectionIds[index]}:{})}:place(slide,index,!!entry.slide);
        entry.slide=structuredClone(working.slides[index]);entry.status='content-ready';delete entry.designPending;save(p,{results:true});return entry.slide;
      }catch(error){entry.status=signal?.aborted?'cancelled':'failed';entry.error=String(error.message).slice(0,700);save(p);throw error;}
    }},
    // Content stays above design at the scheduler too. A design request for an early page must not
    // occupy the project/account request slot while the next page's content is ready; design fills
    // spare capacity when content requests are not ready. This keeps 02 pages appearing in order.
    {id:'design-'+index,label:'单页设计 · 第 '+(index+1)+' 页',dependsOn:['content-'+index],priority:20,run:async()=>{
      const entry=draft.pages[index];
      // A page may have been edited from its published draft after content-ready but before this
      // design worker actually starts: always put the newest draft slide into working first.
      if(entry.slide)working.slides[index]=structuredClone(entry.slide);
      if(pageDesignState(working,index)?.current){entry.status='done';entry.designSlideJson=JSON.stringify(entry.slide);save(p);return;}
      const designBaseJson=JSON.stringify(entry.slide);
      entry.status='designing';save(p);
      try{
        await designPage(working,index,()=>{entry.design=structuredClone(working.pageDesigns[index]);save(p,{results:true});});
        signal?.throwIfAborted();
        const latestJson=JSON.stringify(entry.slide);
        if(latestJson!==designBaseJson){
          // The user edited this page while design was generating. Keep their newest content and
          // keep the generated layout only as a stale draft for reuse/sync; it must not become the
          // current design for the edited slide.
          working.slides[index]=structuredClone(entry.slide);
          entry.design=structuredClone(working.pageDesigns[index]);
          entry.designSlideJson=designBaseJson;
          entry.designPending=true;
          entry.status='content-ready';
          save(p,{results:true});
          return;
        }
        working.slides[index]=structuredClone(entry.slide);
        entry.design=structuredClone(working.pageDesigns[index]);
        entry.designSlideJson=latestJson;
        entry.designPending=false;
        entry.status='done';
        save(p,{results:true});
      }catch(error){entry.design=structuredClone(working.pageDesigns[index]);entry.status=signal?.aborted?'cancelled':'design-failed';entry.error=String(error.message).slice(0,700);save(p);throw error;}
    }}
  ]);
  // Ready-worker window: manual project caps get twice the window for content/design
  // overlap, auto uses the whole service window. Display keeps the project setting (null=auto).
  const workerWindow=()=>Math.min(12,Math.max(2,projectWorkerLimit(p.executionConcurrency)*2));
  let results;
  try{results=await runTaskGraph(nodes,{signal,limit:workerWindow,reportLimit:()=>concurrencyLimit(p.executionConcurrency)});}
  catch(error){draft.status=signal?.aborted?'cancelled':'failed';save(p);throw error;}
  const failedContent=results.filter(r=>r.id.startsWith('content-')&&r.status!=='fulfilled');
  const failedDesign=results.filter(r=>r.id.startsWith('design-')&&r.status==='rejected');
  draft.status=failedContent.length?'partial':'done';draft.finishedAt=new Date().toISOString();save(p);
  if(failedContent.length)throw Error(`${failedContent.length} 页内容暂未完成；已保留 ${draft.pages.filter(e=>e.slide).length} 页有效内容及设计，下次继续只补缺页：${failedContent.map(r=>'第 '+(+r.id.slice(8)+1)+' 页：'+r.reason?.message).join('；').slice(0,1200)}`);
  // User edits made while the pipeline was running live in draft.pages[i].slide; the final deck
  // must use those newest pages, not the older local working copy.
  const finalSlides=specs.map((_,index)=>draft.pages[index]?.slide?structuredClone(draft.pages[index].slide):working.slides[index]);
  const finalDesigns={};
  for(const [index,entry] of draft.pages.entries()){
    if(entry.design)finalDesigns[index]=structuredClone(entry.design);
  }
  return {slides:finalSlides,pageDesigns:finalDesigns,report:{completed:draft.pages.filter(e=>e.status==='done').map(e=>e.index),failed:failedDesign.map(r=>({index:+r.id.slice(7),message:r.reason.message})),at:new Date().toISOString()}};
}

function pipelineDesignCurrent(entry){
  return !!(entry?.slide&&entry?.design&&entry.designSlideJson===JSON.stringify(entry.slide));
}

export function contentPipelinePublic(p,stamp){
  const d=p.contentPipelineDraft;if(!d||d.stamp!==stamp)return null;
  return {status:d.status,total:p.brief.pages,contentReady:d.pages.filter(e=>e.slide).length,designReady:d.pages.filter(e=>pipelineDesignCurrent(e)&&e.status==='done').length,pages:d.pages.map(e=>{
    const slide=e.slide?structuredClone(e.slide):null,design=e.design?structuredClone(e.design):null,designCurrent=pipelineDesignCurrent(e);
    return {index:e.index,title:e.title,status:e.status,error:e.error,editable:!!slide,...(slide?{slide,nodes:initialElements(slide)}:{}),...(design?{design,designCurrent,needsDesignSync:!designCurrent}:{})};
  })};
}
