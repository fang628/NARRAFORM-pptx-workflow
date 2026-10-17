import {selectedPaletteId,presetPaletteRule} from './preset-design.mjs';
import {sourceMaterials} from './materials.mjs';
import {backgroundUsesForBrief} from './page-options.mjs';
import {workflowStyles} from './workflow-library.mjs';
import {backgroundSubjectRule,backgroundVariationRule} from './theme-subject-policy.mjs';

export const styleSelectionSchema='styleSelection:{matchingPresetIds:["仅填风格库中符合材料主题、用途和受众的风格预设 A-F；按字体、装饰与图像语言判断，不是配色或版式样例；排除不合适者，均不适合时留空"],fullyMatchingPresetIds:["可选的匹配程度记录，属于 matchingPresetIds；不作为是否采用风格预设的门槛"],matchingPaletteIds:["可选；单独评估符合主题的 A-F 预设配色，不要求整套装饰与字体也相符，按优先级排列"],reason:"一句话说明材料主题、受众与所选风格或配色如何相符"}';
export const themePlanningSchema=styleSelectionSchema+',subjectSources:{heroSubject:{kind:"artistic",element:"封面艺术意象，可抽象或具象，不要求材料中存在",inspiration:"概述艺术意象如何符合主题、代表全篇材料主线，不需材料实物证据",materialId:"可选，明确引用材料时才填真实编号",evidenceId:"可选，不要求证据"},tocSubject:{kind:"artistic",element:"与封面主体、形态或效果有所不同的目录意象",inspiration:"沿用全篇主线，并说明与封面在主体、形态或视觉效果上的区别"},contentSubject:{kind:"artistic",element:"内容背景边角艺术图形",inspiration:"呼应全材料共同主线"}}';
export const themePlanningPolicy='PPT风格只依据材料主题与受众，工具网页的工业风不限制PPT。预设专指风格库 A–F 的风格预设，原样采用其配色、渐变、字体、字效、框形、装饰及页型版式规则，只替换当前材料的内容与主体，不改写预设设计。风格选择按主题适配规则执行：风格预设符合材料主题且与用途、受众不冲突时必须采用 matchingPresetIds 中的预设，不能为凑三方向色差改色、改框形或重新设计预设，也不能以需调整原设计为由冒称已经采用预设；只有均不适合或用户明确另选时才原创并登记。艺术底图与事实配图分开处理；subjectSources 可记录艺术灵感，不强制材料证据来源，不将艺术画面冒充材料证据。'+backgroundSubjectRule+backgroundVariationRule+presetPaletteRule;

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
  const palettes=selection.matchingPaletteIds;
  if(palettes!==undefined&&(!Array.isArray(palettes)||palettes.some(id=>!workflowStyles.some(s=>s.id===id&&!s.deletedAt))))throw Error('预设配色适配判断无效');
  const selectedPalette=selectedPaletteId(raw,p);
  if(selectedPalette&&!workflowStyles.some(s=>s.id===selectedPalette&&!s.deletedAt))throw Error('预设配色编号不存在');
  if(selectedPalette&&palettes&&!palettes.includes(selectedPalette))throw Error('所选预设配色不在贴合主题的配色范围内');
  const paletteOnly=p.visualTreatment==='flat'&&!!selectedPalette;
  const matchingPresetIds=[...new Set(selection.matchingPresetIds)];
  const full=selection.fullyMatchingPresetIds??[];
  if(!Array.isArray(full)||full.some(id=>!matchingPresetIds.includes(id)))throw Error('完全匹配预设必须属于适配预设范围');
  const fullyMatchingPresetIds=[...new Set(full)];
  const selectedPreset=presetOf(p,raw.referenceStyleId);
  if(selectedPreset&&!matchingPresetIds.includes(selectedPreset))throw Error('所选参考风格 '+selectedPreset+' 不在贴合主题的预设范围内，请改选适合材料主题的风格；'+selection.reason.trim().slice(0,300));
  if(!referenceStyleId&&!paletteOnly&&matchingPresetIds.length&&!matchingPresetIds.includes(selectedPreset)){const error=Error('已有符合主题的预设风格，请采用并登记该预设');error.code='STYLE_PRESET_REQUIRED';throw error;}
  return {matchingPresetIds,fullyMatchingPresetIds,...(palettes?{matchingPaletteIds:[...new Set(palettes)]}:{}),reason:selection.reason.trim().slice(0,1000)};
}

export function validateThemePlanning(raw,p,options={}){
  const styleSelection=validateStyleSelection(raw,p,options);
  const sources=themeMaterialContext(p),subjectSources={};
  const fields={'hero-image':'heroSubject','toc-image':'tocSubject','content-background':'contentSubject'};
  for(const use of backgroundUsesForBrief(p.brief)){
    const field=fields[use],s=raw.subjectSources?.[field],element=typeof s?.element==='string'&&s.element.trim()?s.element.trim().slice(0,200):String(raw[field]||'').slice(0,200);
    const material=sources.find(m=>m.id===s?.materialId),evidence=material?.evidence.find(e=>e.id===s?.evidenceId);
    subjectSources[field]={kind:'artistic',element,...(typeof s?.inspiration==='string'?{inspiration:s.inspiration.trim().slice(0,500)}:{}),...(material&&evidence?{materialId:material.id,evidenceId:evidence.id,evidence}:{})};
  }
  return {styleSelection,subjectSources};
}
