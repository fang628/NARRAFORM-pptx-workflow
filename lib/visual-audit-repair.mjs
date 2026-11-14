import {applyLayerInventory} from './overlap-layers.mjs';
import {routeRebuildRepresentations} from './rebuild-representation.mjs';
import {auditFrameInventory} from './frame-inventory.mjs';
import {shapeAdjustmentRule} from './shape-adjustments.mjs';
import {canonicalTexts,validateAudit} from './visual-model.mjs';
import {parseJSON} from './provider.mjs';
import {normalizeRebuildProgress,stripRebuildProgress,rebuildProgressAuditRule} from './rebuild-progress.mjs';
import {visualTextStyleRule} from './visual-text-style.mjs';
import {rebuildMethodRule,validateRebuildMethods} from './rebuild-methods.mjs';
import {rebuildNumberRule,rebuildAppearanceRule,auditNumberInventory} from './rebuild-text-parts.mjs';
import {deduplicateAuditElements,auditInstanceGroups} from './rebuild-reuse.mjs';
import {rebuildReferenceRule} from './rebuild-reference-policy.mjs';
import {prepareRecognitionGroups,recognitionGroupRule} from './recognition-groups.mjs';
import {normalizeNativeParameters} from './native-parameter-groups.mjs';
import {lightRecognitionRule,absorbFrameHighlights} from './light-effects.mjs';
import {ensureMaterialImages} from './material-image-insertion.mjs';
import {geometryChangedKeys,fittingTargetKeys} from './rebuild-incremental.mjs';
import {normalizeAuditIdentities} from './audit-identities.mjs';
import {registerLocalComponents} from './local-components.mjs';

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
    if(!e||!['text','formula'].includes(e.type))return e;
    if(e.part||e.role==='toc-number'||e.role==='visual-number')return e;
    const exact=byText.get(e.text),node=byId.get(e.nodeId);
    if(node){
      // A valid id whose text belongs to another node is ambiguous: ask the
      // model to repair the mapping instead of silently swapping content.
      if(node.role==='formula'){if(e.type!=='formula'||e.latex!==node.latex)changes.push({key:e.key,nodeId:node.nodeId,action:'restore-native-formula'});return {...e,type:'formula',latex:node.latex,text:undefined};}
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
  const patchable=Array.isArray(raw?.elements)&&raw.elements.every(e=>e&&typeof e.key==='string');
  return `修正当前页的元素审计JSON，只修正本轮问题，保留正确对象与位置。${patchable?'返回 {patch:{upsert:[需要替换或新增的完整元素],removeKeys:[明确重复或无效的key]},frameInventory,numberInventory,layerInventory}；未变的清单省略。程序将合并补丁并重新校验全页，不重新输出正确SVG。':'原返回不完整，返回完整 {frameInventory,numberInventory,layerInventory,elements:[...],notes:"..."}。'}\n本轮校验问题：${error.message}\n坐标/sourceBox/线宽用1600×900逻辑单位；水平或竖直line可单轴为0。\n${visualTextStyleRule}\n${rebuildAppearanceRule}\n${rebuildMethodRule}\n${rebuildNumberRule}\n准确文字（唯一来源，每个nodeId完整覆盖一次；允许number/label或准确标签/正文label/body分框）：${JSON.stringify(texts)}\n登记原图（身份与位置原样保留）：${JSON.stringify(images)}\n上次审计结果：${JSON.stringify(raw)}\n不删内容、原图或必要框体来通过检查；补回遗漏节点时参考随附完整预览定位，歧义结构结合附加局部图核对。`;
}

export function mergeAuditPatch(previous,response){
  const inherit=element=>{const old=previous?.elements?.find(e=>e?.key===element?.key);if(!old?.recognitionRejections?.length)return element;return {...element,recognitionRejections:[...new Map([...old.recognitionRejections,...(element.recognitionRejections||[])].map(r=>[r.parameter+'|'+r.groupId,r])).values()]};};
  if(!response?.patch)return response?.elements?{...response,elements:response.elements.map(inherit)}:response;
  const {upsert=[],removeKeys=[]}=response.patch;
  if(!Array.isArray(previous?.elements)||previous.elements.some(e=>!e||typeof e.key!=='string')||!Array.isArray(upsert)||!Array.isArray(removeKeys)||upsert.length>220||removeKeys.length>220)throw Error('元素修正补丁格式无效；缺少稳定编号时须返回完整elements');
  const existing=new Set(previous.elements.map(e=>e.key));
  if(removeKeys.some(key=>!existing.has(key)||upsert.some(e=>e?.key===key))||new Set(removeKeys).size!==removeKeys.length||upsert.some(e=>!e?.key)||new Set(upsert.map(e=>e.key)).size!==upsert.length)throw Error('元素补丁含未知删除项或重复key');
  const replaced=new Map(upsert.map(e=>[e.key,inherit(e)])),removed=new Set(removeKeys);
  const elements=previous.elements.filter(e=>!removed.has(e.key)).map(e=>replaced.get(e.key)||e);
  for(const e of upsert)if(!elements.some(n=>n.key===e.key))elements.push(e);
  const {patch,...metadata}=response;
  const merged={...previous,...metadata,elements};
  if(response.layerInventory===undefined&&previous.layerInventory)merged.layerInventory=previous.layerInventory.filter(e=>!removed.has(e.key)).map(e=>({...e,frontOf:e.frontOf.filter(k=>!removed.has(k))}));
  return merged;
}

function correctionScope(raw,error,slide,images,project,index){
  const bad=[];
  for(const e of Array.isArray(raw?.elements)?raw.elements:[]){
    try{validateRebuildMethods([e]);validateAudit([e],slide,images,project,index,{allowPartial:true});}
    catch{bad.push(e);}
  }
  if(!bad.length)for(const e of raw?.elements||[])if(error.message.includes(e.key))bad.push(e);
  return {keys:bad.filter(e=>typeof e?.key==='string').map(e=>e.key),regions:bad.filter(e=>e&&['x','y','w','h'].every(k=>Number.isFinite(e[k]))).slice(0,3).map(e=>({key:e.key,x:e.x,y:e.y,w:e.w,h:e.h}))};
}

// Runs inside the existing per-page worker; correction never increases the
// request concurrency and never generates/replaces the approved slide image.
export async function auditedElements({slide,project,index,images,request,inspect,record=()=>{},progress=()=>{},signal}){
  const texts=canonicalTexts(slide,project,index).filter(n=>project?.rebuildPresentation?.version!==1||n.role!=='navigation'),history=[],partial=new Map();
  const partialResult=()=>({partialAudit:[...partial.values()].filter((e,i,all)=>all.findIndex(n=>n.key===e.key)===i),auditValidation:{status:'partial',limit:auditRepairLimit,attempts:Math.max(0,history.length-1),numberInventory:structuredClone(numberInventory),frameInventory:structuredClone(frameInventory),history:history.map(({response,...e})=>e)}});
  function preservePartial(elements){
    for(const element of stripRebuildProgress(project,index,Array.isArray(elements)?elements.slice(0,220):[])){
      // Unsafe crops wait for a complete audit. Native/text/SVG objects validate independently.
      if(!['text','formula','image','rect','ellipse','line','shape','svg'].includes(element?.type))continue;
      try{
        validateRebuildMethods([element]);
        const [valid]=validateAudit([element],slide,images,project,index,{allowPartial:true});
        const identity=['text','formula'].includes(valid.type)?'text:'+valid.nodeId+':'+(valid.part||'whole'):valid.type==='image'?'image:'+valid.nodeId:'element:'+valid.key;
        partial.set(identity,valid);
      }catch{}
    }
  }
  let correction=null,lastError,repeatedElements,lastRaw,detail={},numberInventory=[],frameInventory=[],localGeometry,fallbackAudit,recognitionGroups=[],inspectedElements;
  const groupingDecisions=[];
  // Diagnostics: lets the next real rebuild show whether recognition/parameter
  // grouping actually fired, without re-deriving it from prompt text.
  const groupingSummary=()=>({groups:recognitionGroups.length,decisions:groupingDecisions.length,grouped:groupingDecisions.filter(d=>d.action==='grouped').length,ignored:groupingDecisions.filter(d=>d.action==='ignored').length,attempts:history.length});
  const groupRecognized=raw=>{if(!Array.isArray(raw?.elements))return raw;const p=prepareRecognitionGroups(raw,{previousGroups:recognitionGroups});recognitionGroups=p.groups;groupingDecisions.push(...p.changes);const grouped=normalizeNativeParameters(p.raw.elements,{allowedParameters:['fill','stroke','strokeWidth','strokeColor','gradientAngle','gradientCenter','gradientStops']});groupingDecisions.push(...grouped.decisions);return {...p.raw,elements:grouped.elements};};
  const keepValid=(warning)=>({...fallbackAudit,auditValidation:{...fallbackAudit.auditValidation,recognitionGroups,groupingDecisions,groupingSummary:groupingSummary(),geometryWarnings:[warning],history:history.map(({response,...e})=>e)}});
  for(let attempt=0;attempt<=auditRepairLimit;attempt++){
    if(signal?.aborted)throw Error('任务已取消');
    let answer;try{answer=await request(correction,attempt,detail);}catch(error){if(signal?.aborted)throw error;if(fallbackAudit)return keepValid('叠层核对未完成，已保留有效原生结果：'+error.message);throw Object.assign(Error(error.message,{cause:error}),partialResult());}
    if(signal?.aborted)throw Error('任务已取消');
    let raw,changes=[],audit;
    try{
      raw=normalizeAuditIdentities(mergeAuditPatch(lastRaw,parseJSON(answer.text)),lastRaw);
      if(Array.isArray(raw.elements)){
        const absorbed=absorbFrameHighlights(raw.elements);raw.elements=absorbed.elements;
        if(absorbed.removed.size){
          frameInventory=frameInventory.filter(e=>!absorbed.removed.has(e.key));
          if(raw.frameInventory)raw.frameInventory=raw.frameInventory.filter(e=>!absorbed.removed.has(e.key));
          if(raw.layerInventory)raw.layerInventory=raw.layerInventory.filter(e=>!absorbed.removed.has(e.key)).map(e=>({...e,frontOf:(e.frontOf||[]).filter(k=>!absorbed.removed.has(k))}));
        }
      }
      frameInventory=frameInventory.filter(f=>!raw.elements?.some(e=>e.key===f.key&&(e.type==='line'||e.arrowRole==='connector'||e.role==='effect')));
      const renames=new Map((lastRaw?.elements||[]).filter(e=>e.role==='visual-number'&&!raw.elements?.some(n=>n.key===e.key)).flatMap(e=>{
        const candidates=raw.elements?.filter(n=>n.role==='visual-number'&&n.forNodeId===e.forNodeId&&n.text===e.text)||[];
        return candidates.length===1?[[e.key,candidates[0].key]]:[];
      }));
      numberInventory=numberInventory.map(n=>({...n,key:renames.get(n.key)||n.key}));
      if(Array.isArray(raw?.elements)){
        const registered=ensureMaterialImages(raw.elements,images||[]);
        raw.elements=registered.elements;
        changes.push(...registered.inserted.map(e=>({...e,action:'insert-registered-original'})));
      }
      if(Array.isArray(raw.elements)){
        const kept=stripRebuildProgress(project,index,raw.elements),keys=new Set(kept.map(e=>e?.key)),removed=new Set(raw.elements.filter(e=>!keys.has(e?.key)).map(e=>e?.key));
        raw.elements=kept;
        if(Array.isArray(raw.frameInventory))raw.frameInventory=raw.frameInventory.filter(f=>!removed.has(f.key));
        if(Array.isArray(raw.layerInventory))raw.layerInventory=raw.layerInventory.filter(f=>!removed.has(f.key)).map(f=>({...f,frontOf:Array.isArray(f.frontOf)?f.frontOf.filter(k=>!removed.has(k)):f.frontOf}));
      }
      if(raw.layerInventory===undefined&&lastRaw?.layerInventory)raw.layerInventory=lastRaw.layerInventory;
      const declaredFrames=new Map([...frameInventory,...(Array.isArray(raw.frameInventory)?raw.frameInventory:[])].map(f=>[f.key,f]));
      if(Array.isArray(raw.elements))raw.elements=raw.elements.map(e=>declaredFrames.has(e?.key)?{...e,frameKind:declaredFrames.get(e.key).kind||'frame'}:e);
      if(raw.repeatedElements!==undefined)repeatedElements=raw.repeatedElements;
      else if(repeatedElements)raw.repeatedElements=repeatedElements;
      if(Array.isArray(raw.elements))raw.elements=routeRebuildRepresentations(raw.elements);
      if(Array.isArray(raw.elements)){
        const merged=new Map(raw.elements.flatMap(e=>(e.endpointDotKeys||[]).map(key=>[key,e.key])));
        if(merged.size){
          if(Array.isArray(raw.frameInventory))raw.frameInventory=raw.frameInventory.filter(e=>!merged.has(e.key));
          frameInventory=frameInventory.filter(e=>!merged.has(e.key));
          if(Array.isArray(raw.layerInventory))raw.layerInventory=raw.layerInventory.filter(e=>!merged.has(e.key))
            .map(e=>({...e,frontOf:[...new Set((e.frontOf||[]).map(key=>merged.get(key)||key))].filter(key=>key!==e.key)}));
          changes.push(...[...merged].map(([key,lineKey])=>({key,lineKey,action:'native-line-oval-terminal'})));
        }
      }
      const restored=restoreAuditTexts(raw,texts);raw=restored.raw;changes.push(...restored.changes);
      preservePartial(raw?.elements);
      if(Array.isArray(raw?.elements))raw.elements=stripRebuildProgress(project,index,raw.elements);
      const unique=deduplicateAuditElements(raw);raw=unique.raw;changes.push(...unique.changes);
      raw=groupRecognized(raw);
      const layers=applyLayerInventory(raw.elements,raw.layerInventory,{allowUncertainGeometry:!!inspect});raw.elements=layers.elements;raw.layerInventory=layers.inventory;
      const inventoryErrors=[];
      try{frameInventory=auditFrameInventory(raw,frameInventory);}catch(error){if(error.frameInventory)frameInventory=error.frameInventory;inventoryErrors.push(error.message);}
      try{numberInventory=auditNumberInventory(raw,numberInventory,{texts});}catch(error){if(error.numberInventory)numberInventory=error.numberInventory;inventoryErrors.push(error.message);}
      raw.frameInventory=frameInventory;raw.numberInventory=numberInventory;
      if(inventoryErrors.length)throw Object.assign(Error(inventoryErrors.join('；')),{frameInventory,numberInventory});
      auditInstanceGroups(raw);
      if(Array.isArray(raw?.elements))raw.elements=normalizeRebuildProgress(project,index,raw.elements);
      preservePartial(raw?.elements);
      validateRebuildMethods(raw?.elements);
      audit=validateAudit(raw?.elements,slide,images,project,index);
      audit=registerLocalComponents(audit,{nodes:slide.elements||[],previous:inspectedElements||[]});
      raw.elements=audit;
      if(inspect){
        const targetKeys=inspectedElements?fittingTargetKeys(audit,geometryChangedKeys(inspectedElements,audit),{previous:inspectedElements}):null;
        const inspection=targetKeys?.length===0?{elements:audit,report:localGeometry}:await inspect(audit,raw,attempt,targetKeys==null?{}:{targetKeys});localGeometry=inspection?.report;
        if(inspection?.elements){preservePartial(inspection.elements);audit=validateAudit(inspection.elements,slide,images,project,index);raw.elements=audit;changes.push(...(inspection.changes||[]).map(e=>({key:e.key,action:'reference-native-geometry-fit'})));}
        inspectedElements=structuredClone(audit);
        if(attempt===auditRepairLimit){
          // A model may miss an obvious clipped title plate even after looking
          // again. Only a traced independent edge with strong pixel support can
          // complete it locally; a bounding box/color change alone never can.
          const measured=(localGeometry?.unresolved||[]).filter(e=>e.kind==='missing-title-carrier'&&e.measuredCarrier?.geometryEvidence?.visibleCoverage>=.8&&!audit.some(n=>n.key===e.measuredCarrier.key));
          for(const issue of measured){const plate=issue.measuredCarrier,at=audit.findIndex(e=>e.key===issue.key);if(at<0)continue;audit.splice(at+1,0,plate);changes.push({key:plate.key,action:'measured-independent-title-carrier'});}
          if(measured.length){
            raw=groupRecognized({...raw,elements:audit});audit=validateAudit(raw.elements,slide,images,project,index);raw.elements=audit;frameInventory=auditFrameInventory({...raw,frameInventory},frameInventory);raw.frameInventory=frameInventory;
            const completed=measured.map(e=>e.measuredCarrier.key),targetKeys=[...new Set([...measured.map(e=>e.key),...completed])];
            localGeometry={...localGeometry,unresolved:localGeometry.unresolved.filter(e=>!measured.includes(e)),completedTitleCarriers:completed};
            // The new upper plates now provide actual occlusion masks. Refit
            // only those plates and their parents once; otherwise the parent's
            // gradient can absorb the plate's distinct colour as a false band.
            try{
              const fitted=await inspect(audit,raw,attempt,{targetKeys,paintOnly:true});
              if(fitted?.elements){audit=validateAudit(fitted.elements,slide,images,project,index);raw.elements=audit;changes.push(...(fitted.changes||[]).map(e=>({key:e.key,action:'layer-aware-paint-refit'})));}
              if(fitted?.report)localGeometry={...fitted.report,completedTitleCarriers:completed,postLayerRefit:true,unresolved:(fitted.report.unresolved||[]).filter(e=>!completed.includes(e.measuredCarrier?.key))};
            }catch(error){if(signal?.aborted)throw error;localGeometry.postLayerPaintWarning=error.message;}
          }
        }
        const ambiguous=(localGeometry?.unresolved||[]).filter(e=>['overlapping-frame','missing-title-carrier'].includes(e.comparison?.preferred)||e.kind==='low-confidence-geometry'&&(e.reason?.p95??0)>12).sort((a,b)=>(b.kind==='missing-title-carrier')-(a.kind==='missing-title-carrier'));
        if(ambiguous.length&&attempt<auditRepairLimit){fallbackAudit={raw:structuredClone(raw),audit:structuredClone(audit),auditValidation:{status:'passed',limit:auditRepairLimit,attempts:attempt,instanceGroups:auditInstanceGroups(raw),layerInventory:raw.layerInventory,numberInventory:structuredClone(numberInventory),frameInventory:structuredClone(frameInventory),nativeGeometry:localGeometry}};lastError=Error('参考轮廓与登记位置存在差异：先逐个核对列出的对象坐标、宽高、斜边和对应文字位置，不把弱拟合几何当作已确认轮廓。独立承载必须有完整边界证据，不能仅凭色差增加底板。'+JSON.stringify(ambiguous.slice(0,3)));audit=undefined;}
        if(audit){raw=groupRecognized({...raw,elements:audit});audit=validateAudit(raw.elements,slide,images,project,index);const verified=applyLayerInventory(audit,raw.layerInventory);audit=verified.elements;raw.elements=audit;raw.layerInventory=verified.inventory;}
      }
    }catch(error){audit=undefined;if(error.numberInventory)numberInventory=error.numberInventory;if(error.frameInventory)frameInventory=error.frameInventory;lastError=error;if(raw&&numberInventory.length)raw.numberInventory=numberInventory;if(raw&&frameInventory.length)raw.frameInventory=frameInventory;if(!raw)preservePartial(completeAuditEntries(answer.text));}
    if(Array.isArray(raw?.elements))lastRaw=raw;
    const entry={attempt,at:new Date().toISOString(),status:audit?'passed':'needs_revision',response:answer.text,changes,...(!audit?{error:lastError.message}:{})};
    history.push(entry);await record(entry);
    if(audit){
      if(attempt||changes.length)progress(`元素审计已通过：自动纠正 ${attempt} 次，原文回填 ${changes.length} 项`);
      const warnings=(localGeometry?.unresolved||[]).filter(e=>e.comparison?.preferred==='missing-title-carrier'||e.kind==='low-confidence-geometry'&&(e.reason?.p95??0)>12).map(e=>'待视觉复核：'+(e.headingKey||e.key)+' 的位置或轮廓仍有歧义');
      return {raw,audit,auditValidation:{status:'passed',...(warnings.length?{geometryWarnings:warnings}:{}),limit:auditRepairLimit,attempts:attempt,instanceGroups:auditInstanceGroups(raw),layerInventory:raw.layerInventory,numberInventory,frameInventory,nativeGeometry:localGeometry,recognitionGroups,groupingDecisions,groupingSummary:groupingSummary(),localChanges:history.flatMap(e=>e.changes),history:history.map(({response,...e})=>e)}};
    }
    if(attempt===auditRepairLimit)break;
    progress(`元素审计自动纠正 ${attempt+1}/${auditRepairLimit}：${lastError.message}`);
    detail=correctionScope(lastRaw,lastError,slide,images,project,index);
    const contentRaw=lastRaw?{...lastRaw,elements:stripRebuildProgress(project,index,lastRaw.elements).map(e=>!e||typeof e!=='object'||detail.keys.includes(e.key)?e:Object.fromEntries(Object.entries(e).filter(([k])=>!['svg','mask'].includes(k))))}:raw;
    correction=auditCorrectionPrompt(lastError,contentRaw??{unparsedResponse:answer.text},texts,images)+'\n'+rebuildReferenceRule+'\n'+shapeAdjustmentRule+'\n'+recognitionGroupRule+'\n'+lightRecognitionRule+'\n保留已清点框体、数字、重复实例与前后关系；'+(detail.keys.length?'本轮重点对象：'+detail.keys.join('、'):'对照问题补回缺失内容')+(project?.rebuildPresentation?.version===1?'\n'+rebuildProgressAuditRule:'');
  }
  if(fallbackAudit)return keepValid('叠层核对达到两次预算，已保留有效原生结果：'+lastError.message);
  throw Object.assign(Error(`元素审计自动纠正 ${auditRepairLimit} 次仍未通过，已保存返回与检查记录：${lastError.message}`),partialResult(),{auditIssue:lastError.message});
}
