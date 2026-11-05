import {chat,parseJSON} from './provider.mjs';
import {runTaskGraph} from './task-graph.mjs';
import {concurrencyLimit} from './concurrency.mjs';
import {initialElements} from './elements.mjs';
import {pageStructurePrompt,validateGeneratedTitlePage} from './page-options.mjs';
import {progressSectionsOf,assignProgressSections} from './progress-navigation.mjs';
import {pageDesignState} from './page-design.mjs';
import {reportTask} from './task-progress.mjs';

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
    for(const id of imageIds){
      const m=materials.get(id);if(m?.kind!=='image')throw Error('规划配图必须使用登记图片编号');
      const identity=m.sha256||m.file||m.id;
      if(usedImages.has(identity))throw Error('全篇规划配图重复，请将同一图片分配给最贴切的一页，其他页选互补图片或不配图');
      usedImages.add(identity);
    }
    if(p.brief.toc?(index===(p.brief.cover!==false?1:0)&&page.kind!=='toc'):(page.kind==='toc'))throw Error('全篇规划的目录页位置与需求不一致');
    if(page.kind==='toc'&&index!==(p.brief.cover!==false?1:0))throw Error('全篇规划不能重复添加目录页');
    if(page.progressSectionId&&!sections.has(page.progressSectionId))throw Error('规划必须使用实际页顶章节编号');
    return {index,kind:page.kind,title:page.title.trim(),objective:page.objective.trim(),materialIds:[...new Set([...materialIds,...imageIds])],imageIds,...(page.progressSectionId?{progressSectionId:page.progressSectionId}:{})};
  });
  validateGeneratedTitlePage(pages,p.brief);
  if(p.brief.pages===1&&pages[0].kind!==(p.brief.cover!==false?'cover':'content'))throw Error('单页规划须遵循标题页开关');
  return pages;
}

export function contentPlanPrompt(p){
  return `先规划整套PPT的页序、主题、材料与配图分配，暂不写内容树或设计稿。恰好 ${p.brief.pages} 页。${pageStructurePrompt(p.brief)}每页一个明确主题，相关页承接，全篇覆盖关键内容，避免重复。已有合适照片、示意图或流程图应主动分配给最相关的一页；同一图片（含重复文件）全篇只分配一次，不为凑图挤入无关图片。表格使用可编辑表格数据，不分配表格截图。页顶章节沿用给定真实编号。输出 {pages:[{kind:"cover|toc|content|section",title:"本页简短标题",objective:"本页应呈现的关键内容、与前后页的承接及必要数据范围，短语即可",materialIds:["支撑本页的实际材料id"],imageIds:["必须插入的登记图片id，无则空数组"],progressSectionId:"已有章节id或null"}]}。只输出精简的规划JSON，不提前写全文。\n需求：${JSON.stringify(p.brief)}\n章节：${JSON.stringify(progressSectionsOf(p))}\n材料理解与提纲：${JSON.stringify(p.analysis?{summary:p.analysis.summary,outline:p.analysis.outline,reviewNotes:p.analysis.reviewNotes,readings:p.analysis.readings?.map(r=>({id:r.id,summary:r.summary,keyPoints:r.keyPoints,facts:r.facts,tables:r.tables,formulas:r.formulas,suggestedUse:r.suggestedUse}))}:null)}`;
}

function skeleton(spec){return {kind:spec.kind,title:spec.title,subtitle:'',body:[],notes:'',sources:[],sourceLinks:[],imageId:null,...(spec.progressSectionId?{progressSectionId:spec.progressSectionId}:{}),elements:[{id:'title',type:'text',role:'title',text:spec.title,parentId:null}]};}

// Keep drafts separate from the user's current deck until every content page is
// valid. Each page can nevertheless start its design while others generate.
export async function generateContentPipeline(p,{stamp,config,system,signal,planContext='',save=()=>{},generatePage,designPage,validatePage,request=chat}){
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
  const place=(slide,index)=>({...validatePage(slide,specs[index]),...(sectionIds[index]?{progressSectionId:sectionIds[index]}:{})});
  draft.pages=specs.map((spec,index)=>({...draft.pages[index],index,title:spec.title,status:'queued'}));draft.status='running';
  for(const entry of draft.pages)if(entry.slide){
    try{working.slides[entry.index]=place(entry.slide,entry.index);if(entry.design)working.pageDesigns[entry.index]=structuredClone(entry.design);}
    catch{delete entry.slide;delete entry.design;}
  }
  save(p);
  const nodes=specs.flatMap((spec,index)=>[
    {id:'content-'+index,label:'逐页内容 · 第 '+(index+1)+' 页',priority:10,run:async()=>{
      const entry=draft.pages[index];entry.status='generating';delete entry.error;save(p);
      try{
        const slide=entry.slide||await generatePage(spec,index,working,specs);
        signal?.throwIfAborted();working.slides[index]=place(slide,index);entry.slide=structuredClone(working.slides[index]);entry.status='content-ready';save(p,{results:true});return entry.slide;
      }catch(error){entry.status=signal?.aborted?'cancelled':'failed';entry.error=String(error.message).slice(0,700);save(p);throw error;}
    }},
    {id:'design-'+index,label:'单页设计 · 第 '+(index+1)+' 页',dependsOn:['content-'+index],priority:20,run:async()=>{
      const entry=draft.pages[index];
      if(pageDesignState(working,index)?.current){entry.status='done';save(p);return;}
      entry.status='designing';save(p);
      try{
        await designPage(working,index,()=>{entry.design=structuredClone(working.pageDesigns[index]);save(p,{results:true});});
        signal?.throwIfAborted();entry.design=structuredClone(working.pageDesigns[index]);entry.status='done';save(p,{results:true});
      }catch(error){entry.design=structuredClone(working.pageDesigns[index]);entry.status=signal?.aborted?'cancelled':'design-failed';entry.error=String(error.message).slice(0,700);save(p);throw error;}
    }}
  ]);
  let results;
  try{results=await runTaskGraph(nodes,{signal,limit:()=>Math.min(12,concurrencyLimit(p.executionConcurrency)*2),reportLimit:()=>concurrencyLimit(p.executionConcurrency)});}
  catch(error){draft.status=signal?.aborted?'cancelled':'failed';save(p);throw error;}
  const failedContent=results.filter(r=>r.id.startsWith('content-')&&r.status!=='fulfilled');
  const failedDesign=results.filter(r=>r.id.startsWith('design-')&&r.status==='rejected');
  draft.status=failedContent.length?'partial':'done';draft.finishedAt=new Date().toISOString();save(p);
  if(failedContent.length)throw Error(`${failedContent.length} 页内容暂未完成；已保留 ${draft.pages.filter(e=>e.slide).length} 页有效内容及设计，下次继续只补缺页：${failedContent.map(r=>'第 '+(+r.id.slice(8)+1)+' 页：'+r.reason?.message).join('；').slice(0,1200)}`);
  return {slides:working.slides,pageDesigns:working.pageDesigns,report:{completed:draft.pages.filter(e=>e.status==='done').map(e=>e.index),failed:failedDesign.map(r=>({index:+r.id.slice(7),message:r.reason.message})),at:new Date().toISOString()}};
}

export function contentPipelinePublic(p,stamp){
  const d=p.contentPipelineDraft;if(!d||d.stamp!==stamp)return null;
  return {status:d.status,total:p.brief.pages,contentReady:d.pages.filter(e=>e.slide).length,designReady:d.pages.filter(e=>e.status==='done').length,pages:d.pages.map(e=>({index:e.index,title:e.title,status:e.status,error:e.error,...(e.slide?{nodes:initialElements(e.slide)}:{})}))};
}
