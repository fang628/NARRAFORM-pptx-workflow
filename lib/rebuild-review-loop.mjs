export const rebuildVisualRepairLimit=2;
export async function rebuildReviewLoop({render,repair,save=()=>{},progress=()=>{},signal,limit=rebuildVisualRepairLimit,feedback=[],scopeIndices,allowUnreviewedFeedback=false}){
  const history=[],pendingFeedback=new Map(feedback.map(f=>[f.index,f.instruction])),targetScopes=new Map(feedback.filter(f=>f.targetKey||f.regionScope).map(f=>[f.index,f]));
  const scope=new Set(scopeIndices||feedback.map(f=>f.index));
  for(let round=0;round<=limit;round++){
    if(signal?.aborted)throw Error('任务已取消');
    const candidate=await render(round),failed=candidate.review.pages.filter(r=>(!scope.size||scope.has(r.index))&&(!r.passed||pendingFeedback.has(r.index))).map(r=>({...r,...(pendingFeedback.has(r.index)?{userInstruction:pendingFeedback.get(r.index),issues:[...r.issues,'用户素材增删意见：'+pendingFeedback.get(r.index)]}:{}),...(targetScopes.has(r.index)?{targetKey:targetScopes.get(r.index).targetKey,regionScope:targetScopes.get(r.index).regionScope,userInstruction:targetScopes.get(r.index).instruction}:{})}));
    history.push({round,candidateId:candidate.id,dir:candidate.dir,at:new Date().toISOString(),pages:candidate.review.pages.map(r=>({index:r.index,passed:r.passed,issues:r.issues,visualAssessment:r.visualAssessment,...(r.reviewUnavailable?{reviewUnavailable:true}:{})})),failed:failed.map(r=>r.index)});
    candidate.visualRepair={limit,rounds:round,status:failed.length?(round===limit?'exhausted':'repairing'):'passed',history:structuredClone(history),pendingFeedback:[...pendingFeedback].map(([index,instruction])=>({index,instruction}))};await save(candidate);
    if(!failed.length){if(scope.size&&candidate.review.pages.some(r=>!r.passed)){candidate.visualRepair.status='scope_complete';await save(candidate);}return candidate;}
    if(failed.some(r=>r.reviewUnavailable)&&!(allowUnreviewedFeedback&&failed.every(r=>!r.reviewUnavailable||pendingFeedback.has(r.index)))){
      candidate.visualRepair.status='review_unavailable';candidate.visualRepair.errors=failed.filter(r=>r.reviewUnavailable).flatMap(r=>r.issues);await save(candidate);
      progress('部分页面未取得有效视觉验收，保留实际渲染；不据格式错误修改页面，请重新验收');return candidate;
    }
    if(round===limit)return candidate;
    progress(`实际渲染发现 ${failed.length} 页需修改，开始第 ${round+1}/${limit} 轮工具修正`);
    const result=await repair(failed,round+1);
    if(!result.changed){candidate.visualRepair.status='stalled';candidate.visualRepair.attemptedRounds=round+1;candidate.visualRepair.errors=result.errors||[];await save(candidate);progress(candidate.visualRepair.errors.length?'本轮自动修正未完成：'+candidate.visualRepair.errors.slice(0,2).join('；')+'；已保留原页面与工具记录':'主模型未完成有效修改，保留实际渲染和工具记录，等待继续修正');return candidate;}
    for(const index of result.changedIndices??failed.map(r=>r.index))pendingFeedback.delete(index);
  }
}
