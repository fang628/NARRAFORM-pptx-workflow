import {canonicalTexts,validateAudit} from './visual-model.mjs';
import {parseJSON} from './provider.mjs';
import {normalizeRebuildProgress,stripRebuildProgress,rebuildProgressAuditRule} from './rebuild-progress.mjs';
import {visualTextStyleRule} from './visual-text-style.mjs';
import {rebuildMethodRule,validateRebuildMethods} from './rebuild-methods.mjs';
import {rebuildNumberRule,rebuildHeadingBodyRule} from './rebuild-text-parts.mjs';
import {deduplicateAuditElements,auditInstanceGroups,rebuildReuseRule} from './rebuild-reuse.mjs';

export const auditRepairLimit=2;

// For inspection only: read complete element objects preceding a truncated tail.
// The strict whole-page JSON/audit must still pass before a reconstruction is usable.
export function completeAuditEntries(text){
  const input=String(text||'').slice(0,2_000_000),match=/"elements"\s*:\s*\[/.exec(input),elements=[];
  if(!match)return elements;
  let start=-1,depth=0,quoted=false,escaped=false;
  for(let i=match.index+match[0].length;i<input.length&&elements.length<220;i++){
    const c=input[i];
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;continue;}
    if(start<0){if(/[\s,]/.test(c))continue;if(c!=="{")break;start=i;depth=1;continue;}
    if(c==='{'||c==='[')depth++;
    else if(c==='}'||c===']'){
      if(--depth===0){try{elements.push(JSON.parse(input.slice(start,i+1)));}catch{}start=-1;}
    }
  }
  return elements;
}

export function restoreAuditTexts(raw,texts){
  if(!raw||!Array.isArray(raw.elements))return {raw,changes:[]};
  const byId=new Map(texts.map(n=>[n.nodeId,n])),byText=new Map(),changes=[];
  for(const n of texts)byText.set(n.text,[...(byText.get(n.text)||[]),n]);
  const elements=raw.elements.map(e=>{
    if(!e||e.type!=='text')return e;
    if(e.part||e.role==='toc-number')return e;
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
  return `修正当前页的元素审计JSON，保留已正确的布局和独立素材，只修正本轮问题。返回完整 {elements:[...],notes:"..."}，不要返回补丁。\n本轮校验问题：${error.message}\n所有坐标（尤其sourceBox）均为1600×900逻辑坐标，不能混用1920×1080图片像素；像素坐标须除以1.2。水平/竖直line允许一轴为0，但不能两轴均为0。\n${visualTextStyleRule}\n${rebuildMethodRule}\n${rebuildNumberRule}\n${rebuildHeadingBodyRule}\n准确文字（唯一来源，每个nodeId恰好一次）：${JSON.stringify(texts)}\n登记原图（身份与位置原样保留）：${JSON.stringify(images)}\n上次审计结果：${JSON.stringify(raw)}\n补回遗漏节点时参考随附完整预览定位；不删除正文或图注来通过检查，不把文字烘焙进SVG或图片，不重复拆解无字底图。`;
}

// Runs inside the existing per-page worker; correction never increases the
// request concurrency and never generates/replaces the approved slide image.
export async function auditedElements({slide,project,index,images,request,record=()=>{},progress=()=>{},signal}){
  const texts=canonicalTexts(slide,project,index).filter(n=>project?.rebuildPresentation?.version!==1||n.role!=='navigation'),history=[],partial=new Map();
  const partialResult=()=>({partialAudit:[...partial.values()].filter((e,i,all)=>all.findIndex(n=>n.key===e.key)===i),auditValidation:{status:'partial',limit:auditRepairLimit,attempts:Math.max(0,history.length-1),history:history.map(({response,...e})=>e)}});
  function preservePartial(elements){
    for(const element of stripRebuildProgress(project,index,Array.isArray(elements)?elements.slice(0,220):[])){
      // Unsafe crops wait for a complete audit. Native/text/SVG objects validate independently.
      if(!['text','image','rect','ellipse','line','shape','svg'].includes(element?.type))continue;
      try{
        validateRebuildMethods([element]);
        const [valid]=validateAudit([element],slide,images,project,index,{allowPartial:true});
        const identity=valid.type==='text'?'text:'+valid.nodeId+':'+(valid.part||'whole'):valid.type==='image'?'image:'+valid.nodeId:'element:'+valid.key;
        partial.set(identity,valid);
      }catch{}
    }
  }
  let correction=null,lastError,repeatedElements;
  for(let attempt=0;attempt<=auditRepairLimit;attempt++){
    if(signal?.aborted)throw Error('任务已取消');
    let answer;try{answer=await request(correction,attempt);}catch(error){throw Object.assign(Error(error.message,{cause:error}),partialResult());}
    if(signal?.aborted)throw Error('任务已取消');
    let raw,changes=[],audit;
    try{
      raw=parseJSON(answer.text);
      if(raw.repeatedElements!==undefined)repeatedElements=raw.repeatedElements;
      else if(repeatedElements)raw.repeatedElements=repeatedElements;
      // Verify declared appearances before collapsing accidental duplicate recognitions.
      preservePartial(raw?.elements);auditInstanceGroups(raw);
      ({raw,changes}=restoreAuditTexts(raw,texts));
      if(Array.isArray(raw?.elements))raw.elements=stripRebuildProgress(project,index,raw.elements);
      const unique=deduplicateAuditElements(raw);raw=unique.raw;changes.push(...unique.changes);
      if(Array.isArray(raw?.elements))raw.elements=normalizeRebuildProgress(project,index,raw.elements);
      preservePartial(raw?.elements);
      validateRebuildMethods(raw?.elements);
      audit=validateAudit(raw?.elements,slide,images,project,index);
    }catch(error){lastError=error;if(!raw)preservePartial(completeAuditEntries(answer.text));}
    const entry={attempt,at:new Date().toISOString(),status:audit?'passed':'needs_revision',response:answer.text,changes,...(!audit?{error:lastError.message}:{})};
    history.push(entry);await record(entry);
    if(audit){
      if(attempt||changes.length)progress(`元素审计已通过：自动纠正 ${attempt} 次，原文回填 ${changes.length} 项`);
      return {raw,audit,auditValidation:{status:'passed',limit:auditRepairLimit,attempts:attempt,instanceGroups:auditInstanceGroups(raw),localChanges:history.flatMap(e=>e.changes),history:history.map(({response,...e})=>e)}};
    }
    if(attempt===auditRepairLimit)break;
    progress(`元素审计自动纠正 ${attempt+1}/${auditRepairLimit}：${lastError.message}`);
    const contentRaw=Array.isArray(raw?.elements)?{...raw,elements:stripRebuildProgress(project,index,raw.elements)}:raw;
    correction=auditCorrectionPrompt(lastError,contentRaw??{unparsedResponse:answer.text},texts,images)+'\n'+rebuildReuseRule+'保留已有repeatedElements清单，逐处补齐缺失实例，不通过减少count来隐藏遗漏。'+(project?.rebuildPresentation?.version===1?'\n'+rebuildProgressAuditRule:'');
  }
  throw Object.assign(Error(`元素审计自动纠正 ${auditRepairLimit} 次仍未通过，已保存返回与检查记录：${lastError.message}`),partialResult(),{auditIssue:lastError.message});
}
