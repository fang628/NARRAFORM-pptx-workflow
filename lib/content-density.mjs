import {initialElements} from './elements.mjs';
import {pageContentDensity,contentDensityRule} from './content-writing.mjs';
import {reportTask} from './task-progress.mjs';

const images=slide=>initialElements(slide).filter(n=>n.type==='image'&&n.materialId).map(n=>n.materialId).sort();
const tables=slide=>initialElements(slide).filter(n=>n.type==='table').map(n=>[n.id,n.headers.length,n.rows.length]).sort((a,b)=>a[0].localeCompare(b[0]));
const bodyCount=slide=>initialElements(slide).filter(n=>n.type==='text'&&(!n.role||n.role==='body')).length;
const visibleText=slide=>initialElements(slide).flatMap(n=>n.type==='text'?[n.text]:n.type==='group'?[n.label]:n.type==='table'?[...n.headers,...n.rows.flat()]:[]).join('\n');
const numbers=slide=>new Set(visibleText(slide).match(/\d+(?:[.,]\d+)*(?:[%‰])?/g)||[]);
// Rewrite only generated drafts in 02. Confirmed/user-edited text is never truncated.
export async function fitGeneratedContent({slides,request,validate,signal,pageOffset=0,brief}){
  let current=structuredClone(slides),lastError='';
  for(let round=1;round<=2;round++){
    const issues=current.flatMap((slide,index)=>{const density=pageContentDensity(slide);return density.score?[{index,page:index+pageOffset+1,...density}]:[];});
    if(!issues.length)return current;
    signal?.throwIfAborted();
    reportTask(signal,{kind:'step',message:`02有 ${issues.length} 页长段或文字量偏多，正在精简 ${round}/2，保留关键事实与配图`});
    try{
      const answer=await request(`精简02逐页内容草稿。${contentDensityRule}只修改下列页面；不增删页面、不改变页型。保留图片材料id及数量、表格行列、主副标题归属、独立观点和多层关系；不是把全部正文合并为摘要。保留关键结论、数字、单位与必要条件，不造新事实。可改写短语或拆成短项，每个新文本或表格的sourceLinks沿用支持其内容的原材料id和excerptId，不自行写quote；不要把内部label当小标题。输出 {pages:[{index:给定索引,slide:该页完整对象}]}，每个待调整页面恰好一次。${lastError?'上一轮问题：'+lastError+'；请定位并修正，不能重复返回同一无效结果。':''}\n用户需求：${JSON.stringify(brief||{})}\n待调整指标：${JSON.stringify(issues)}\n待调整页面：${JSON.stringify(issues.map(({index})=>({index,slide:current[index]})))}`);
      signal?.throwIfAborted();
      const patches=answer?.pages;
      if(!Array.isArray(patches)||patches.length!==issues.length||new Set(patches.map(p=>p.index)).size!==issues.length)throw Error('只返回完整的待调整页面，不增删或重复索引');
      const pending=new Set(issues.map(i=>i.index)),candidate=structuredClone(current);
      for(const patch of patches){
        if(!Number.isInteger(patch.index)||!pending.delete(patch.index)||!patch.slide)throw Error('调整页面索引或完整内容无效');
        const before=current[patch.index],after=patch.slide;
        if((before.kind||'content')!==(after.kind||'content'))throw Error('精简时不能改变页型');
        if(JSON.stringify(images(before))!==JSON.stringify(images(after)))throw Error('精简时不得遗漏、增加或替换登记图片');
        if(JSON.stringify(tables(before))!==JSON.stringify(tables(after)))throw Error('精简时不得删除表格或减少数据行列');
        if(bodyCount(after)<bodyCount(before))throw Error('精简时不得合并或删除原有独立分点');
        const afterNumbers=numbers(after);if([...numbers(before)].some(value=>!afterNumbers.has(value)))throw Error('精简时不得遗漏或改写已有数字');
        candidate[patch.index]={...after,...(before.progressSectionId?{progressSectionId:before.progressSectionId}:{})};
        // These are derived from the previous wording; genuine excerpt references
        // are checked again by validate(), rather than left incorrectly stale.
        for(const link of candidate[patch.index].sourceLinks||[])for(const field of ['boundText','stale','location','materialHash'])delete link[field];
      }
      try{validate(structuredClone(candidate));}catch(error){if(error.code!=='SOURCE_EVIDENCE_MISMATCH')throw error;}
      const improved=issues.every(({index,score})=>pageContentDensity(candidate[index]).score<=score)&&issues.some(({index,score})=>pageContentDensity(candidate[index]).score<score);
      if(!improved)throw Error('字数或长字段没有减少，请精简赘述并保留独立信息');
      current=candidate;lastError='';
    }catch(error){if(signal?.aborted)throw error;lastError=error.message;}
  }
  const remaining=current.filter(s=>pageContentDensity(s).score).length;
  if(remaining)reportTask(signal,{kind:'step',message:`02文字精简已结束；${remaining} 页仍偏密，保留最后有效内容，并在本步标记供修改，不中断后续流程`});
  return current;
}
