import {canonicalTexts,validateAudit} from './visual-model.mjs';
import {parseJSON} from './provider.mjs';
import {visualTextStyleRule} from './visual-text-style.mjs';
import {rebuildMethodRule,validateRebuildMethods} from './rebuild-methods.mjs';

export const auditRepairLimit=2;

export function restoreAuditTexts(raw,texts){
  if(!raw||!Array.isArray(raw.elements))return {raw,changes:[]};
  const byId=new Map(texts.map(n=>[n.nodeId,n])),byText=new Map(),changes=[];
  for(const n of texts)byText.set(n.text,[...(byText.get(n.text)||[]),n]);
  const elements=raw.elements.map(e=>{
    if(!e||e.type!=='text')return e;
    const exact=byText.get(e.text),node=byId.get(e.nodeId);
    if(node){
      // A valid id whose text belongs to another node is ambiguous: ask the
      // model to repair the mapping instead of silently swapping content.
      if(e.text===node.text||exact?.some(n=>n.nodeId!==node.nodeId))return e;
      changes.push({key:e.key,nodeId:node.nodeId,action:'restore-canonical-text'});
      return {...e,text:node.text};
    }
    if(exact?.length===1){changes.push({key:e.key,nodeId:exact[0].nodeId,action:'restore-node-id'});return {...e,nodeId:exact[0].nodeId};}
    return e;
  });
  return {raw:{...raw,elements},changes};
}

export function auditCorrectionPrompt(error,raw,texts,images){
  return `修正当前页的元素审计JSON，保留已正确的布局和独立素材，只修正本轮问题。返回完整 {elements:[...],notes:"..."}，不要返回补丁。\n本轮校验问题：${error.message}\n${visualTextStyleRule}\n${rebuildMethodRule}\n准确文字（唯一来源，每个nodeId恰好一次）：${JSON.stringify(texts)}\n登记原图（身份与位置原样保留）：${JSON.stringify(images)}\n上次审计结果：${JSON.stringify(raw)}\n补回遗漏节点时参考随附完整预览定位；不删除正文或图注来通过检查，不把文字烘焙进SVG或图片，不重复拆解无字底图。`;
}

// Runs inside the existing per-page worker; correction never increases the
// request concurrency and never generates/replaces the approved slide image.
export async function auditedElements({slide,project,index,images,request,record=()=>{},progress=()=>{},signal}){
  const texts=canonicalTexts(slide,project,index),history=[];
  let correction=null,lastError;
  for(let attempt=0;attempt<=auditRepairLimit;attempt++){
    if(signal?.aborted)throw Error('任务已取消');
    const answer=await request(correction,attempt);
    if(signal?.aborted)throw Error('任务已取消');
    let raw,changes=[],audit;
    try{
      raw=parseJSON(answer.text);
      ({raw,changes}=restoreAuditTexts(raw,texts));
      validateRebuildMethods(raw?.elements);
      audit=validateAudit(raw?.elements,slide,images,project,index);
    }catch(error){lastError=error;}
    const entry={attempt,at:new Date().toISOString(),status:audit?'passed':'needs_revision',response:answer.text,changes,...(!audit?{error:lastError.message}:{})};
    history.push(entry);await record(entry);
    if(audit){
      if(attempt||changes.length)progress(`元素审计已通过：自动纠正 ${attempt} 次，原文回填 ${changes.length} 项`);
      return {raw,audit,auditValidation:{status:'passed',limit:auditRepairLimit,attempts:attempt,localChanges:history.flatMap(e=>e.changes),history:history.map(({response,...e})=>e)}};
    }
    if(attempt===auditRepairLimit)break;
    progress(`元素审计自动纠正 ${attempt+1}/${auditRepairLimit}：${lastError.message}`);
    correction=auditCorrectionPrompt(lastError,raw??{unparsedResponse:answer.text},texts,images);
  }
  throw Error(`元素审计自动纠正 ${auditRepairLimit} 次仍未通过，已保存返回与检查记录：${lastError.message}`);
}
