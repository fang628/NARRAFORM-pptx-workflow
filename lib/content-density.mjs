import {initialElements} from './elements.mjs';
import {pageContentDensity,contentDensityRule,contentPhrasingRule} from './content-writing.mjs';
import {reportTask} from './task-progress.mjs';

const images=slide=>initialElements(slide).filter(n=>n.type==='image'&&n.materialId).map(n=>n.materialId).sort();
// Table cells are facts, not shape: every cell text must stay identical.
const tables=slide=>initialElements(slide).filter(n=>n.type==='table').map(n=>[n.id,JSON.stringify(n.headers),JSON.stringify(n.rows)]).sort((a,b)=>a[0].localeCompare(b[0]));
// Formulas are reproduced verbatim; the latex itself must never change.
const formulas=slide=>initialElements(slide).filter(n=>n.type==='formula').map(n=>[n.id,n.latex]).sort((a,b)=>a[0].localeCompare(b[0]));
const isBody=node=>node.type==='text'&&(!node.role||node.role==='body');
const bodyItems=slide=>initialElements(slide).filter(isBody);
const bodyCount=slide=>bodyItems(slide).length;
// Image titles/captions and group headings are confirmed structure: keep text, role and parent.
const annotations=slide=>initialElements(slide).filter(n=>n.type==='text'&&(n.role==='imageTitle'||n.role==='caption')).map(n=>[n.id,n.parentId??null,n.role,n.text]).sort((a,b)=>a[0].localeCompare(b[0]));
const groups=slide=>initialElements(slide).filter(n=>n.type==='group').map(n=>[n.id,n.parentId??null,n.label]).sort((a,b)=>a[0].localeCompare(b[0]));
const visibleText=slide=>initialElements(slide).flatMap(n=>n.type==='formula'?[n.latex]:n.type==='text'?[n.text]:n.type==='group'?[n.label]:n.type==='table'?[...n.headers,...n.rows.flat()]:[]).join('\n');
const numbers=slide=>new Set(visibleText(slide).match(/\d+(?:[.,]\d+)*(?:[%‰])?/g)||[]);
// Rewriting may rephrase text, but never replace titles or slide-level identity.
const scaffold=slide=>{
  const nodes=initialElements(slide),textOf=role=>nodes.find(n=>n.type==='text'&&n.role===role)?.text||'';
  return {title:textOf('title')+'|'+String(slide.title||''),subtitle:textOf('subtitle')+'|'+String(slide.subtitle||'')};
};
const phrasingOf=slide=>pageContentDensity(slide).phrasing;
const metric=slide=>{const density=pageContentDensity(slide);return {score:density.score,phrasing:density.phrasing.length};};
// No node may be removed, merged or re-parented to make a paragraph look shorter: the same
// split-sentence nodes must be phrased in place so no independent point can disappear.
function guardPhrasing(before,after){
  const afterItems=new Map(bodyItems(after).map(n=>[n.id,n]));
  for(const item of bodyItems(before)){
    const next=afterItems.get(item.id);
    if(!next)throw Error('句子改写必须保留原有正文节点，不能按标点删点或合并');
    if((next.parentId??null)!==(item.parentId??null))throw Error('句子改写不得改变正文节点的归属层级');
  }
}
const same=(a,b,message)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(message);};
// Rewrite only generated drafts in 02. Confirmed/user-edited text is never truncated, and the
// original-PPT visual-optimization path bypasses this entry entirely (see content-evidence).
export async function fitGeneratedContent({slides,request,validate,signal,pageOffset=0,brief}){
  let current=structuredClone(slides),lastError='';
  for(let round=1;round<=2;round++){
    const issues=current.flatMap((slide,index)=>{const density=pageContentDensity(slide);return density.score||density.phrasing.length?[{index,page:index+pageOffset+1,characters:density.characters,maxCharacters:density.maxCharacters,longFields:density.longFields,phrasing:density.phrasing.map(({texts,...issue})=>issue),score:density.score,phrasingCount:density.phrasing.length}]:[];});
    if(!issues.length)return current;
    signal?.throwIfAborted();
    reportTask(signal,{kind:'step',message:`02有 ${issues.length} 页长段、句子平铺或文字量偏多，正在精简 ${round}/2，保留关键事实与配图`});
    try{
      const answer=await request(`精简02逐页内容草稿。${contentDensityRule}${contentPhrasingRule}只修改下列页面；不增删页面、不改变页型。保留原有正文节点id与parentId、图片材料id及数量、表格全部单元格原文、图片标题与图注、小标题文字及归属、公式原文、主副标题归属和独立观点，不能通过删点或合并来变短。保留关键结论、数字、单位与必要条件，不造新事实。同组多条完整叙述句被平铺时，在原节点上改写为信息短语或只保留一句简短关键结论，不按标点机械切句、不强行删除谓语，不把带句号的短语标签、数据标签或独立短分点当成错误；不能为了短语删除事实、独立分点，或把必要上屏信息只写进notes。可改写短语或拆成短项，每个新文本或表格的sourceLinks沿用支持其内容的原材料id和excerptId，不自行写quote；不要把内部label当小标题。输出 {pages:[{index:给定索引,slide:该页完整对象}]}，每个待调整页面恰好一次。${lastError?'上一轮问题：'+lastError+'；请定位并修正，不能重复返回同一无效结果。':''}\n用户需求：${JSON.stringify(brief||{})}\n待调整指标：${JSON.stringify(issues)}\n待调整页面：${JSON.stringify(issues.map(({index})=>({index,slide:current[index]})))}`);
      signal?.throwIfAborted();
      const patches=answer?.pages;
      if(!Array.isArray(patches)||patches.length!==issues.length||new Set(patches.map(p=>p.index)).size!==issues.length)throw Error('只返回完整的待调整页面，不增删或重复索引');
      const pending=new Set(issues.map(i=>i.index)),candidate=structuredClone(current);
      for(const patch of patches){
        if(!Number.isInteger(patch.index)||!pending.delete(patch.index)||!patch.slide)throw Error('调整页面索引或完整内容无效');
        const before=current[patch.index],after=patch.slide;
        if((before.kind||'content')!==(after.kind||'content'))throw Error('精简时不能改变页型');
        const shapeBefore=scaffold(before),shapeAfter=scaffold(after);
        if(shapeBefore.title!==shapeAfter.title)throw Error('精简时不得改写标题');
        if(shapeBefore.subtitle!==shapeAfter.subtitle)throw Error('精简时不得改写副标题');
        same(groups(before),groups(after),'精简时不得改写小标题文字、增删分组或改变归属');
        same(annotations(before),annotations(after),'精简时不得删除或改写图片标题与图注');
        same(images(before),images(after),'精简时不得遗漏、增加或替换登记图片');
        same(tables(before),tables(after),'精简时不得删除表格或改动任何单元格原文');
        same(formulas(before),formulas(after),'精简时不得删除、改写或拆断公式');
        if(bodyCount(after)<bodyCount(before))throw Error('精简时不得合并或删除原有独立分点');
        guardPhrasing(before,after);
        const afterNumbers=numbers(after);if([...numbers(before)].some(value=>!afterNumbers.has(value)))throw Error('精简时不得遗漏或改写已有数字');
        candidate[patch.index]={...after,...(before.progressSectionId?{progressSectionId:before.progressSectionId}:{})};
        // These are derived from the previous wording; genuine excerpt references
        // are checked again by validate(), rather than left incorrectly stale.
        for(const link of candidate[patch.index].sourceLinks||[])for(const field of ['boundText','stale','location','materialHash'])delete link[field];
      }
      try{validate(structuredClone(candidate));}catch(error){if(error.code!=='SOURCE_EVIDENCE_MISMATCH')throw error;}
      const improved=issues.every(({index,score,phrasingCount})=>{const now=metric(candidate[index]);return now.score<=score&&now.phrasing<=phrasingCount;})&&issues.some(({index,score,phrasingCount})=>{const now=metric(candidate[index]);return now.score<score||now.phrasing<phrasingCount;});
      if(!improved)throw Error('字数、长段或句子平铺没有减少，请改为信息短语并保留全部独立信息');
      current=candidate;lastError='';
    }catch(error){if(signal?.aborted)throw error;lastError=error.message;}
  }
  const remaining=current.filter(s=>{const density=pageContentDensity(s);return density.score||density.phrasing.length;}).length;
  if(remaining)reportTask(signal,{kind:'step',message:`02文字精简已结束；${remaining} 页仍偏密或存在句子平铺，保留最后有效内容，并在本步标记供修改，不中断后续流程`});
  return current;
}
