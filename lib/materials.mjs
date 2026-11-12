import {validateFormulaContent} from './formula-content.mjs';
import crypto from 'node:crypto';
import {findQuote,evidenceCatalog} from './sources.mjs';
import {validateTableContent} from './table-content.js';
import {normalizePhotoAssessment} from './photo-assessment.mjs';
export {evidenceCatalog} from './sources.mjs';

export const sourceMaterials=p=>p.materials.filter(m=>!m.generated&&!m.excludedFromContent&&!(m.extracted&&m.documentFigure?.kind==='table'));
export function materialStamp(p) {
  return crypto.createHash('sha256').update(JSON.stringify({brief:p.brief,...(p.materialInstruction?{materialInstruction:p.materialInstruction}:{}),materials:sourceMaterials(p).map(m=>({id:m.id,sha256:m.sha256,ocrText:(m.ocrTextApprovedAt||m.ocr?.approvedAt)?m.text:undefined,...(m.textRecovery?{textRecovery:m.textRecovery.hash}:{})}))})).digest('hex');
}
export const analysisCurrent=p=>!!p.analysis&&p.analysis.stamp===materialStamp(p);
export function editedOutline(outline,titles){
  if(titles===undefined)return outline;
  if(!Array.isArray(titles)||titles.length!==outline.length)throw Error('建议内容主题数量不匹配，请刷新后重试');
  return outline.map((item,i)=>{
    const title=typeof titles[i]==='string'?titles[i].trim():'';
    if(!title||title.length>150)throw Error('第 '+(i+1)+' 个内容主题须为 1–150 字');
    return {...item,title};
  });
}
const text=(v,max=1500)=>typeof v==='string'?v.trim().slice(0,max):'';
function list(v,max=12) {if(!Array.isArray(v))throw Error('材料分析缺少列表字段，请重试');return v.slice(0,max).map(x=>text(x)).filter(Boolean);}
function evidenceError(message,index,quote){const error=Error(message);error.code='EVIDENCE_MISMATCH';error.factIndex=index+1;error.quote=quote.slice(0,200);return error;}
export function validateReading(raw,m,examinedText,catalog=evidenceCatalog(examinedText)) {
  if(!raw||!text(raw.summary))throw Error('模型未返回有效的材料摘要');
  if((raw.facts?.length||0)>256||(raw.keyPoints?.length||0)>256||(raw.questions?.length||0)>256||(raw.tables?.length||0)>20||(raw.formulas?.length||0)>60)throw Error('单块信息索引过大，请缩小分块后重试，不截断信息');
  const facts=(Array.isArray(raw.facts)?raw.facts:[]).map((f,index)=>{
    const claim=text(f.claim,6000);let quote=text(f.quote,6000),location=null,excerptId;
    if(String(f.claim||'').length>6000)throw Error('单条事实过长，请分块保留，不截断条件');
    if(m.kind!=='image'&&f.excerptId!==undefined){
      const entry=catalog.find(e=>e.id===f.excerptId);
      if(!entry)throw evidenceError('模型选择的原文片段编号不存在',index,String(f.excerptId));
      excerptId=entry.id;quote=examinedText.slice(entry.start,entry.end);location={start:entry.start,end:entry.end};
    }
    if(!claim||!quote)throw evidenceError('关键证据必须包含结论和原文摘录',index,quote);
    if(m.kind!=='image'&&!location){location=findQuote(examinedText,quote);if(!location)throw evidenceError('模型返回的证据摘录无法在原文中定位',index,quote);quote=examinedText.slice(location.start,location.end);}
    return {claim,quote,...(excerptId?{excerptId}:{}),...(location?{location}:{})};
  });
  const questions=list(raw.questions,256),tables=[];
  for(const [i,table] of (Array.isArray(raw.tables)?raw.tables.slice(0,20):[]).entries()){
    try{tables.push({...validateTableContent(table),tableId:text(table.tableId,40)||null,suggestedUse:text(table.suggestedUse,500)});}
    catch{questions.push('识别到第 '+(i+1)+' 个表格，但行列不完整或体量较大；逐页规划时请按原材料选取相关数据。');}
  }
  const formulas=[];
  for(const item of (Array.isArray(raw.formulas)?raw.formulas:[]).slice(0,60)){
    try{const formula=validateFormulaContent(item),entry=item.excerptId?catalog.find(e=>e.id===item.excerptId):null;
      if(item.excerptId&&!entry){questions.push('一条公式的来源编号待核对，已保留其他识别结果');continue;}
      formulas.push({...formula,formulaId:text(item.formulaId,40)||null,meaning:text(item.meaning,500),suggestedUse:text(item.suggestedUse,500),...(entry?{excerptId:entry.id,location:{start:entry.start,end:entry.end}}:{})});
    }catch{questions.push('一条公式无法完整识别，未猜测补齐；可查看原文后编辑公式');}
  }
  const photoAssessment=normalizePhotoAssessment(raw.photoAssessment,m);
  if(!Array.isArray(raw.keyPoints))throw Error('材料分析缺少信息列表');
  if(raw.keyPoints.some(v=>typeof v==='string'&&v.length>6000))throw Error('单项信息过长，请分块保留，不截断内容');
  const keyPoints=raw.keyPoints.map(v=>text(v,6000)).filter(Boolean),summary=text(raw.summary),suggestedUse=text(raw.suggestedUse,1000);
  const informationIndex={version:1,blocks:[{summary:String(raw.summary).trim(),keyPoints,facts,tables,formulas,questions,suggestedUse}]};
  return {id:m.id,category:text(raw.category,80)||'待分类',summary,keyPoints:keyPoints.slice(0,12),facts:facts.slice(0,12),suggestedUse,questions:questions.slice(0,12),informationIndex,...(tables.length?{tables}:{}),...(formulas.length?{formulas}:{}),...(photoAssessment?{photoAssessment}:{})};
}
export function validateSynthesis(raw,ids) {
  if(!raw||!text(raw.summary)||!Array.isArray(raw.outline))throw Error('模型未返回有效的材料综合分析');
  const outline=raw.outline.slice(0,30).map(o=>({title:text(o.title,150),sourceIds:Array.isArray(o.sourceIds)?[...new Set(o.sourceIds)]:[]}));
  if(outline.some(o=>!o.title||o.sourceIds.some(id=>!ids.includes(id))))throw Error('综合分析引用了不存在的材料');
  return {summary:text(raw.summary,3000),outline,questions:list(raw.questions,20),...(['clear','unclear'].includes(raw.themeClarity)?{themeClarity:raw.themeClarity,backgroundSubjectUnresolved:raw.themeClarity==='unclear'&&raw.backgroundSubjectUnresolved===true}:{})};
}
