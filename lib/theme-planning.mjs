import {sourceMaterials} from './materials.mjs';
import {backgroundUsesForBrief} from './page-options.mjs';
import {workflowStyles} from './workflow-library.mjs';
import {concreteBackgroundSubjectRule,deckWideBackgroundSubjectRule,validateConcreteBackgroundSubjects,validateDeckSubjectScope} from './theme-subject-policy.mjs';

export const styleSelectionSchema='styleSelection:{matchingPresetIds:["仅填风格库中符合材料主题、用途和受众的风格预设 A-F；按字体、装饰与图像语言判断，不是配色或版式样例；排除不合适者，均不适合时留空"],fullyMatchingPresetIds:["可选的匹配程度记录，属于 matchingPresetIds；不作为是否采用风格预设的门槛"],reason:"一句话说明材料主题、受众与所选风格的具体视觉语言如何相符"}';
export const themePlanningSchema=styleSelectionSchema+',subjectSources:{heroSubject:{materialId:"来源材料编号",evidenceId:"该材料提供的证据编号",element:"证据中实际存在的简短对象名，不扩写细节",scope:"whole-deck|section-only",scopeReason:"根据全篇总述、章节和逐页内容说明代表性"},tocSubject:{materialId:"来源材料编号",evidenceId:"证据编号",element:"实际存在的简短对象名",scope:"whole-deck|section-only",scopeReason:"说明为何是贯穿全篇的核心对象"},contentSubject:{materialId:"来源材料编号",evidenceId:"证据编号",element:"实际存在的简短主题对象名",scope:"whole-deck|section-only（内容页可选）",scopeReason:"可选的一句话范围说明"}}';
export const themePlanningPolicy='PPT风格只依据材料主题与受众，工具网页的工业风不限制PPT。预设专指风格库 A–F 的风格预设，采用其字体气质、装饰语言与图像表现，不强制照搬固定配色或版式样例。风格选择按主题适配规则执行：风格预设符合材料主题且与用途、受众不冲突时必须采用 matchingPresetIds 中的预设，不能以还需调整配色或构图为由改为无参考原创；只有均不适合或用户明确另选时才原创并登记。主体必须是来源材料中实际提及或图中可见的对象，不能凭主题联想虚构主体；用 subjectSources 登记来源编号与对象。示意可以重新演绎，不能冒充实验原图、真实构象或数据；只有无材料项目可依据明确需求选题，不声称来自材料。'+concreteBackgroundSubjectRule+deckWideBackgroundSubjectRule;

// Supply existing analysis and original excerpts, never generated backgrounds as evidence.
export function themeMaterialContext(p){
  return sourceMaterials(p).map(m=>{
    const r=p.analysis?.readings?.find(r=>r.id===m.id);
    const excerpt=String(m.text||'').slice(0,1800);
    const evidence=(r?.facts||[]).map((f,i)=>({id:'F'+(i+1),claim:f.claim,quote:f.quote}));
    if(excerpt)evidence.push({id:'T1',quote:excerpt});
    if(r?.summary)evidence.push({id:'R1',summary:r.summary,keyPoints:r.keyPoints});
    return {id:m.id,name:m.name,kind:m.kind,evidence};
  });
}

function presetOf(p,id,seen=new Set()){
  if(workflowStyles.some(s=>s.id===id))return id;
  if(!id||seen.has(id))return null;
  seen.add(id);return presetOf(p,p.styleRegistry?.find(s=>s.id===id)?.definition?.referenceStyleId,seen);
}

export function validateStyleSelection(raw,p,{referenceStyleId=null}={}){
  const selection=raw?.styleSelection;
  if(!selection||!Array.isArray(selection.matchingPresetIds)||selection.matchingPresetIds.some(id=>!workflowStyles.some(s=>s.id===id))||typeof selection.reason!=='string'||!selection.reason.trim())throw Error('底图规划缺少有效的预设风格适配判断');
  const matchingPresetIds=[...new Set(selection.matchingPresetIds)];
  const full=selection.fullyMatchingPresetIds??[];
  if(!Array.isArray(full)||full.some(id=>!matchingPresetIds.includes(id)))throw Error('完全匹配预设必须属于适配预设范围');
  const fullyMatchingPresetIds=[...new Set(full)];
  const selectedPreset=presetOf(p,raw.referenceStyleId);
  if(selectedPreset&&!matchingPresetIds.includes(selectedPreset))throw Error('所选参考风格 '+selectedPreset+' 不在贴合主题的预设范围内，请改选适合材料主题的风格；'+selection.reason.trim().slice(0,300));
  if(!referenceStyleId&&matchingPresetIds.length&&!matchingPresetIds.includes(selectedPreset)){const error=Error('已有符合主题的预设风格，请采用并登记该预设');error.code='STYLE_PRESET_REQUIRED';throw error;}
  return {matchingPresetIds,fullyMatchingPresetIds,reason:selection.reason.trim().slice(0,1000)};
}

export function validateThemePlanning(raw,p,options={}){
  const styleSelection=validateStyleSelection(raw,p,options);
  validateConcreteBackgroundSubjects(raw,p.brief);
  validateDeckSubjectScope(raw,p.brief,{required:options.requireDeckScope===true});
  const sources=themeMaterialContext(p),subjectSources={};
  const fields={'hero-image':'heroSubject','toc-image':'tocSubject','content-background':'contentSubject'};
  if(sources.length)for(const use of backgroundUsesForBrief(p.brief)){
    const field=fields[use],s=raw.subjectSources?.[field];
    if(!s||!sources.some(m=>m.id===s.materialId)||typeof s.element!=='string'||!s.element.trim()||s.element.length>200)throw Error('底图 '+field+' 必须登记有效的材料主体来源');
    const evidence=sources.find(m=>m.id===s.materialId).evidence.find(e=>e.id===s.evidenceId);
    if(!evidence)throw Error('底图 '+field+' 的主体证据编号不存在');
    subjectSources[field]={materialId:s.materialId,evidenceId:evidence.id,element:s.element.trim(),evidence,...(s.scope!==undefined?{scope:s.scope}:{}),...(typeof s.scopeReason==='string'?{scopeReason:s.scopeReason.trim().slice(0,1000)}:{})};
  }
  return {styleSelection,subjectSources};
}
