import {backgroundUsesForBrief} from './page-options.mjs';

export const concreteBackgroundSubjectRule='封面与目录每张各自只能有一个明确且贴合主题的视觉主体，必须是材料中存在的具象宏观或微观物体，具有可辨识的实体形态、表面或体积；可简约、写实或插画化。抽象图表、数字、公式、化学结构式、符号网络、流程或概念关系图不能作为主体。按材料选实际对象，不把研究过程或概念当成物体；微观实体用具象形态表达，不用结构式或键线图代替，不声称真实实验构象。主体充分占据预定视觉区，阅读区留白，可有少量主题陪衬。';
export const deckWideBackgroundSubjectRule='封面与目录的共同主体必须代表贯穿全篇的核心研究对象、产品或主题实体。先综合材料总述、各章节主题与逐页内容判断其全篇代表性，再登记来源；仅在某一段、小节、案例或实验中出现的局部对象不能升格为全篇主体，只能作相关页面的配图或次要陪衬。不按关键词出现次数机械判断，也不要求每页重复提及主体名称。范围判断和一句话依据写入 subjectSources 的 scope、scopeReason，不扩写生图中的主体细节。';
export const concreteSubjectPromptRule='以贯穿全篇的具象宏观或微观物体为主体，不选局部案例对象，禁用抽象图表、数字、公式、结构式';
export const deckWideSubjectSource=source=>source?.scope==='whole-deck'&&typeof source.scopeReason==='string'&&!!source.scopeReason.trim();
export function validateDeckSubjectScope(raw,brief,{required=false}={}){
  const fields=backgroundUsesForBrief(brief||{}).filter(use=>use!=='content-background').map(use=>use==='hero-image'?'heroSubject':'tocSubject');
  const invalid=fields.filter(field=>{
    const source=raw.subjectSources?.[field];
    return (required||source?.scope!==undefined||source?.scopeReason!==undefined)&&!deckWideSubjectSource(source);
  });
  if(invalid.length){const error=Error('封面与目录主体必须贯穿全篇，不能取自单段、小节或局部案例；请依据全篇内容重新选型并说明依据：'+invalid.join('、'));error.code='BACKGROUND_SUBJECT_NOT_DECK_WIDE';throw error;}
}
export function nonConcreteSubject(value){
  const first=String(value||'').trim().split(/[，,；;。]/)[0];
  if(/^(?:不使用|不适用|无|none)$/i.test(first))return false;
  return /抽象|概念化|符号化|图表|统计图|曲线图|柱状图|折线图|饼图|雷达图|流程图|关系图|机理图|结构式|化学式|分子式|公式|符号网络|数据矩阵|键线图/.test(first)
    || /^(?:数字|数码|分子修饰|技术路线|研究过程|药代动力学|分子对接|主题概念|研究趋势)$/.test(first)
    || /(?:数字|数码)(?:构成|组成|组合|主体|阵列|矩阵|网络|字符|\s*\d)/.test(first)
    || /^\d+(?:[.%＋+−-]\d+)*$/.test(first);
}
export function validateConcreteBackgroundSubjects(raw,brief){
  const fields=backgroundUsesForBrief(brief||{}).filter(use=>use!=='content-background').map(use=>use==='hero-image'?'heroSubject':'tocSubject');
  const invalid=fields.filter(field=>nonConcreteSubject(raw[field])||nonConcreteSubject(raw.subjectSources?.[field]?.element));
  if(invalid.length){const error=Error('封面与目录主体须为材料中的具象宏观或微观物体，请更换：'+invalid.join('、'));error.code='BACKGROUND_SUBJECT_NOT_CONCRETE';throw error;}
}
