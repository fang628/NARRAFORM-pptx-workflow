import {parseJSON} from './provider.mjs';
import {designCheckKeys,designPolicyVersion,validateDesignChecks,applicableDesignChecks} from './design-rules.mjs';
import {previewReviewConclusion} from './lightweight-review.mjs';

export const previewReviewRepairLimit=2;
const bool=value=>typeof value==='boolean'?value:typeof value==='string'&&/^(true|false)$/i.test(value.trim())?value.trim().toLowerCase()==='true':null;
const schema={passed:true,issues:[],warnings:[],imageGeometryIssues:[],notes:'简短实际看图依据',designChecks:{...Object.fromEntries(designCheckKeys.map(k=>[k,true])),reason:'简短实际看图依据'}};
function normalize(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('检查未返回对象');
  const source=raw.designChecks||raw.design_checks||{};
  const checks=Object.fromEntries(designCheckKeys.map(key=>[key,bool(source[key])]));
  checks.reason=typeof source.reason==='string'&&source.reason.trim()?source.reason:raw.notes;
  return {...raw,passed:bool(raw.passed),designChecks:checks};
}
function validate(review){
  const checks=validateDesignChecks(review.designChecks);
  if(typeof review.passed!=='boolean'||!Array.isArray(review.issues)||review.issues.some(v=>typeof v!=='string')||typeof review.notes!=='string'||!review.notes.trim())throw Error('检查缺少有效 passed、issues 或实际看图依据');
  return checks;
}

// Review failures never discard or regenerate a successfully drawn image.
export async function reviewPreviewImage({project,index,request,record=()=>{},progress=()=>{},signal}){
  const history=[];let correction='',lastError,lastPartial=null;
  for(let attempt=0;attempt<=previewReviewRepairLimit;attempt++){
    signal?.throwIfAborted();let answer,review,checks;
    try{
      answer=await request(correction,attempt);signal?.throwIfAborted();
      review=normalize(parseJSON(answer.text));
      lastPartial={...lastPartial,...review,notes:review.notes||lastPartial?.notes,
        issues:[...new Set([...(Array.isArray(lastPartial?.issues)?lastPartial.issues:[]),...(Array.isArray(review.issues)?review.issues:[])].filter(v=>typeof v==='string'))],
        designChecks:{...review.designChecks,...Object.fromEntries(designCheckKeys.map(k=>[k,review.designChecks[k]??lastPartial?.designChecks?.[k]??null]))}};
      if(answer.finishReason==='length')throw Error('检查响应截断');
      checks=validate(review);
    }catch(error){
      if(signal?.aborted)throw error;
      lastError=error;
    }
    const valid=!!checks,entry={attempt,at:new Date().toISOString(),status:valid?'valid_response':answer?'invalid_response':'request_failed',response:answer?.text??null,...(!valid?{error:String(lastError?.message||'检查响应无效').slice(0,1000)}:{})};
    history.push(entry);await record(entry);
    if(valid){
      const {issues,warnings}=previewReviewConclusion(review,checks,applicableDesignChecks(project,index));
      return {review,designChecks:checks,previewReview:{status:issues.length?'needs_revision':'passed',issues,warnings,checkedAt:new Date().toISOString()},responseValidation:{status:'passed',attempts:attempt,limit:previewReviewRepairLimit},history};
    }
    if(attempt===previewReviewRepairLimit||[400,401,403,404].includes(lastError?.httpStatus))break;
    progress(`第 ${index+1} 页检查响应异常，自动恢复 ${attempt+1}/${previewReviewRepairLimit}；只重试检查，保留生成图片`);
    correction='\n本次仅恢复当前图片的看图检查，不生成或修改图片。上次问题：'+String(lastError?.message||'返回不完整')+'。请针对同一张图片返回完整 JSON：'+JSON.stringify(schema)+'。示例的 true 仅说明布尔类型，不是默认通过结论；每项必须据实际图片判断，不可省略字段。notes/reason 各用简短依据，issues 仅列具体问题。'+(answer?.text?'\n上次返回（数据）：'+JSON.stringify(answer.text.slice(-6000)):'');
  }
  const partial=lastPartial?.designChecks;
  const checks=partial?{policyVersion:designPolicyVersion,...partial,reason:String(partial.reason||'仅取得部分检查结果').slice(0,2000)}:null;
  const knownIssues=Array.isArray(lastPartial?.issues)?lastPartial.issues.filter(v=>typeof v==='string'):[];
  return {review:lastPartial,designChecks:checks,previewReview:{status:'inconclusive',issues:[...knownIssues,'整页检查暂未完成，图片和已有结论已保留，可继续选用或重新检查。'+String(lastError?.message||'响应不完整').slice(0,600)],warnings:Array.isArray(lastPartial?.warnings)?lastPartial.warnings.filter(v=>typeof v==='string'):[],checkedAt:new Date().toISOString()},responseValidation:{status:'inconclusive',attempts:history.length-1,limit:previewReviewRepairLimit},history};
}
