import {designAcceptance} from './design-rules.mjs';
import {fullPageCurrent,visualStamp,digest} from './visual-model.mjs';

export function previewApprovalState(p){
  const standards=designAcceptance(p),issues=[...standards.issues],pages=p.slides.map((s,index)=>{
    const r=p.visualPages?.[index];
    const reported=new Set(r?.previewReview?.issues||[]);
    for(const issue of r?.review?.issues||[])if(!reported.has(issue))issues.push(`第 ${index+1} 页：${issue}`);
    if(r?.review?.passed===false&&!r.review.issues?.length)issues.push(`第 ${index+1} 页模型检查未通过：${r.review.notes||'请核对预览'}`);
    return {index,previewHash:r?.previewHash,status:r?.previewReview?.status||'unchecked',checks:r?.designChecks||null,issues:r?.previewReview?.issues||[]};
  });
  const unique=[...new Set(issues)];
  return {ready:p.slides.length>0&&p.slides.every((s,i)=>fullPageCurrent(p,i)),contentConfirmed:p.approvals?.content===p.version,
    allReviewed:p.slides.length>0&&p.slides.every((s,i)=>!!p.visualPages?.[i]?.previewHash&&p.visualPages[i].manualReview?.previewHash===p.visualPages[i].previewHash),
    requiresAcceptance:unique.length>0,issues:unique,pages,stamp:digest({version:p.version,visual:visualStamp(p),pages,issues:unique})};
}

export function previewApprovalRecord(p,b){
  const state=previewApprovalState(p);
  if(!state.ready)throw Error('请补齐所有页面的当前设计稿确认与生图预览，再确认进入05');
  if(!state.contentConfirmed)throw Error('请先确认当前内容版本');
  if(b.confirmAllPages!==true&&!state.allReviewed)throw Error('请逐页检查预览，或确认已查看全部预览');
  if((b.confirmAllPages===true||state.requiresAcceptance)&&b.approvalStamp!==state.stamp)throw Error('预览图片或检查记录已变化，请重新打开确认窗口');
  if(state.requiresAcceptance&&b.acceptIssues!==true)throw Error('预览检查未通过，请明确确认接受当前检查问题后进入05');
  return {version:p.version,stamp:visualStamp(p),approvalStamp:state.stamp,acceptedIssues:state.requiresAcceptance?state.issues:[],pageChecks:structuredClone(state.pages),confirmedAllPages:b.confirmAllPages===true,at:new Date().toISOString()};
}
