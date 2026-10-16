import {concreteSubjectPromptRule} from './theme-subject-policy.mjs';
import {promptColorText,promptColor,visualColors} from './prompt-colors.mjs';
export const themeImagePromptVersion='workflow-background-prompt-v13';
export const themePromptWritingRule='底图绘图要求只写用途与尺寸、实际风格和可用配色、具体主体、位置与留白、必要禁项，单段通常100–220字，不设凑字数下限；明确细节较多时可合理加长。主体来源与全篇代表性在内部规划中核对，不把筛选依据、检查条文或执行说明发给生图模型。删去简洁克制、阅读安静、不抢视觉中心、自由发挥、仅非事实视觉或不得伪造证据等通用套话；每项实际要求仅写一次，不扩写主体细节。封面和目录保留单一具象主体占满视觉区、可有少量主题点缀及主体区与文字留白区的边界线；内容背景保留主题元素的低对比边角位置。无字底图不含文字、数字、图注、文本框或占位框。';
export const themeSubjectBriefGuidance='主体描述用一个短语，通常10–25字，只写材料对象名、必要识别特征与大致位置。不要扩写微观结构、部件数量、精确构象、材质光学或技术参数，局部造型由生图模型发挥；用户明确要求的细节保留。材料明确给出可区别相近对象的视觉特征时，仅保留一个，不推测材料未提供的构象。主体位置与文字预留区应相互避让；每项要求只写在所属字段，不把通用规则写进对象名。';
const roles={'hero-image':'封面底图','toc-image':'目录底图','content-background':'内容页背景'};
const themeElements='主题元素须取自材料且可辨识，不能仅用通用色块、线条或纹理代替';
export const themeAssetSubjectRule=use=>use==='hero-image'||use==='toc-image'
  ?'主题元素须可辨识且取自材料；'+concreteSubjectPromptRule+'；一个明确主视觉铺满预定视觉区，明显可见；可搭配少量主题场景点缀，避免孤立，不形成竞争主体'
  :themeElements;
export const themeAssetBoundaryHint=use=>use==='hero-image'||use==='toc-image'?'主体区与文字留白区用边界线分隔。':'';
const sentence=v=>String(v||'').trim().replace(/[。；;\s]+$/u,'');
export function themeAssetSubject(p,d,use){
  const usable=v=>/^(不使用|不适用|无|none)$/i.test(sentence(v))?'':sentence(v);
  const fallback=usable(d.heroSubject)||usable(d.tocSubject)||`与“${p.brief.title}”相关的具体主题对象`;
  const key={'hero-image':'heroSubject','toc-image':'tocSubject','content-background':'contentSubject'}[use];
  let subject=usable(d[key])||fallback;
  const element=d.subjectSources?.[key]?.element;
  const identity=String(element||'').split(/[（(:：]/)[0].trim(),normalize=v=>String(v).replace(/[\s，,、；;：:（）()\-]/g,'').toLowerCase();
  if(element&&!normalize(subject).includes(normalize(element))&&!(identity.length>=4&&normalize(subject).includes(normalize(identity))))subject=element+'，'+subject;
  if(use==='content-background'){if(!/低对比|淡化|半透明/.test(subject))subject+='，低对比';if(!/边角|角落|左下|右下|左上|右上/.test(subject))subject+='，置于边角';}
  return subject;
}

function palette(d){
  const core=promptColor(d.coreColor),colors=[...new Set(visualColors(d.styleSummary??d.style??'').map(c=>c.endsWith('色')?c:c+'色'))].filter(c=>c!==core);
  return `底色 ${core}`+(colors.length?'，可用配色 '+colors.join('、'):'');
}

function readingArea(d,use){
  const area=sentence(d.textArea),parts=area.split(/[；;。]/).filter(Boolean);
  const match=use==='hero-image'?/封面|标题页/:use==='toc-image'?/目录/:/内容页|正文/;
  const scoped=parts.filter(s=>match.test(s));
  // Legacy planners put all page roles in one field. Send only this page's region.
  if(scoped.length)return scoped.join('；');
  if(use==='content-background')return '顶部标题及中央图文区留白';
  return area|| (use==='hero-image'?'左侧为标题、副标题预留连续阅读空间':'左侧为目录编号与条目预留连续阅读空间');
}

export function themeAssetPrompt(p,d,use){
  if(!roles[use])throw Error('底图用途不存在');
  const subject=themeAssetSubject(p,d,use);
  const mood=d.name||sentence(String(d.styleSummary??d.style??'简洁清晰').split(/[。；;]/)[0]);
  return `用途：“${p.brief.title}”无字${roles[use]}，16:9（1920×1080）。风格：${promptColorText(sentence(mood))}；${palette(d)}。主体：${sentence(subject)}。构图：${readingArea(d,use)}${use==='content-background'?'':'；单一具象主体占满视觉区，可配少量主题点缀'}。${themeAssetBoundaryHint(use)}不含文字、数字、图注、文本框或占位框。`;
}

