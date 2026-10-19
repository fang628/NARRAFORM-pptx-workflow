import {selectedThemePhotoId,themePhotoCandidates,photoThemePrompt} from '../public/theme-photo-policy.js';
import {visualTreatmentText} from './visual-treatment.mjs';
import {backgroundSubjectRule,backgroundVariationRule,distinguishBackgroundVisuals} from './theme-subject-policy.mjs';
import {promptColorText,promptColor,visualColors} from './prompt-colors.mjs';
import {presetPageColor} from './preset-design.mjs';
export const themeImagePromptVersion='workflow-background-prompt-v18';
export const singleImagePromptRule='本次只处理当前用途的一张图片，返回一条完整提示词；不同时给出不同页面的提示词，不生成多页拼图或分镜。';
const themePromptWritingBase='底图绘图要求只写用途与尺寸、具体绘画表现和可用配色、明确描述的艺术主视觉、位置与留白、必要禁项，单段通常100–220字，不设凑字数下限；明确细节较多时可合理加长。艺术意象必须符合主题、贯穿全材料共同主线；灵感在内部规划中记录，不强制材料实物或证据，不把筛选依据、检查条文或执行说明发给生图模型。删去简洁克制、阅读安静、不抢视觉中心、自由发挥、仅非事实视觉或不得伪造证据等通用套话；每项实际要求仅写一次，不扩写主体细节。不发送风格名或预设名称，不用同一主体、同一分子等代称代替具体艺术意象。';
const pageBackgroundRule=use=>use==='content-background'?'主题元素仅置于低对比边角，中央大片留空，不画分框、卡片、分栏或区域分隔线，不预设内容排版。':use==='toc-image'?'艺术主视觉位于边侧，目录文字区连续留空，不画文本框、卡片或占位框，不预画条目。':'艺术主视觉占满视觉区，可有少量主题点缀，主体区与文字留白区用边界线分隔。';
export const themePromptWritingRule=themePromptWritingBase+['hero-image','toc-image','content-background'].map(pageBackgroundRule).join('')+backgroundVariationRule+'无字底图不含文字、数字、图注、文本框或占位框。各页型要求分开保存，组装每条提示词时仅使用对应页型，不能把三个页型的构图一起发给生图模型。';
export const themeSubjectBriefGuidance='主体描述用一个短语，通常10–25字，只写具体艺术意象、简要形态或视觉效果与大致位置，不要求材料对应实物。不要扩写微观结构、部件数量、精确构象、材质光学或技术参数，局部造型由生图模型发挥；用户明确要求的细节保留。封面与目录的主体、形态或视觉效果至少一项明显不同，保持同套配色。主体位置与文字预留区应相互避让；每项要求只写在所属字段，不把通用规则写进对象名。';
const roles={'hero-image':'封面底图','toc-image':'目录底图','content-background':'内容页背景'};
export const themePromptWritingRuleFor=use=>singleImagePromptRule+themePromptWritingBase+'当前用途：'+(roles[use]||'当前底图')+'。'+pageBackgroundRule(use)+(use==='content-background'?'':backgroundVariationRule)+'无字底图不含文字、数字、图注、文本框或占位框。';
// Only inspect independent drawing-brief headers, never mentions in ordinary prose.
export function validateSingleThemePrompt(prompt){
  const briefs=[...String(prompt).matchAll(/用途[:：]/g)];
  const headers=[...String(prompt).matchAll(/(?:^|[\n。；;])\s*(?:#{1,4}\s*|[-*]\s*|\d+[.)、]\s*)?(?:\*\*|【)?(封面(?:页)?(?:底图)?|目录(?:页)?(?:底图)?|内容页(?:底图|背景)?)(?:提示词)?(?:\*\*|】)?\s*[:：]/g)];
  const multiImage=/(?:底图|背景图|预览图)(?:共|一共|总共)?\s*[两二三四五六七八九十2-9]\s*张|[两二三四五六七八九十2-9]\s*张(?:底图|背景图|预览图)/.test(prompt);
  if(multiImage||briefs.length>1||new Set(headers.map(h=>h[1])).size>1)throw Object.assign(Error('本次底图提示词包含多个独立页面任务'),{repairInstruction:singleImagePromptRule+'仅保留当前用途的构图、主体和留白要求，删除其他页的独立提示词，保留当前页有效要求。'});
  return prompt;
}
export const themeAssetSubjectRule=use=>backgroundSubjectRule+(use==='content-background'?'艺术图形低对比置于边角，中央留空':backgroundVariationRule);
export const themeAssetBoundaryHint=use=>use==='hero-image'?'主体区与文字留白区用边界线分隔。':'';
const sentence=v=>String(v||'').trim().replace(/[。；;\s]+$/u,'');
export function themeAssetSubject(p,d,use){
  const direction=distinguishBackgroundVisuals(d,p.brief||{},p.visualTreatment),usable=v=>/^(不使用|不适用|无|none)$/i.test(sentence(v))?'':sentence(v);
  const key={'hero-image':'heroSubject','toc-image':'tocSubject','content-background':'contentSubject'}[use];
  let subject=usable(direction[key])||usable(direction.subjectSources?.[key]?.element)||usable(direction.heroSubject)||'流动色面与光影交织的艺术形态';
  subject=subject.replace(/^同一(?=.{2,})/,'');
  if(use==='content-background'){subject=subject.split(/[，,；;。]/)[0];if(!/低对比|淡化|半透明/.test(subject))subject+='，低对比';if(!/边角|角落|左下|右下|左上|右上/.test(subject))subject+='，置于边角';}
  return subject;
}

function palette(d,use){
  const core=promptColor(presetPageColor(d,use)),colors=[...new Set(visualColors(d.styleSummary??d.style??'').map(c=>c.endsWith('色')?c:c+'色'))].filter(c=>c!==core);
  return `底色 ${core}（全套统一）`+(colors.length?'，可用配色 '+colors.join('、'):'');
}

export function themeReadingArea(d,use){
  if(use==='content-background')return '中央大片留空';
  if(d.presetDesign)return use==='toc-image'?'目录文字区连续留空':'标题与副标题区域连续留白';
  const area=sentence(d.textArea);
  const role='(?:封面(?:页)?|标题页|目录(?:页)?|内容页|内容背景|正文页|正文(?=[:：]))(?:底图|背景)?';
  const markers=[...area.matchAll(new RegExp(role+'(?:\\s*[、与和及/]\\s*'+role+')*','g'))];
  const match=use==='hero-image'?/封面|标题页/:use==='toc-image'?/目录/:/内容页|内容背景|正文/;
  // Labels, rather than sentence punctuation, separate legacy multi-page plans.
  // This also handles comma-separated, multiline and shared "封面与目录" regions.
  const scoped=markers.flatMap((marker,i)=>{
    if(!match.test(marker[0]))return [];
    const body=area.slice(marker.index+marker[0].length,markers[i+1]?.index??area.length).replace(/\n\s*(?:[-*•]|\d+[.)、])\s*$/g,'').replace(/^[\s:：、,，]+|[\s；;。，,、/]+$/g,'');
    return body?[roles[use]+body]:[];
  });
  if(scoped.length)return scoped.join('；');

  return (!markers.length&&area)|| (use==='hero-image'?'左侧为标题、副标题预留连续阅读空间':'左侧为目录编号与条目预留连续阅读空间');
}

export function themeAssetPrompt(p,d,use){
  if(!roles[use])throw Error('底图用途不存在');
  const subject=themeAssetSubject(p,d,use);
  const rendering=visualTreatmentText(p.visualTreatment)||'以艺术形态、轮廓与色面表现主题';
  const area=use==='toc-image'?'目录文字区连续留空':themeReadingArea(d,use);
  const space=use==='content-background'?'中央大片留空，不画分框、卡片、分栏或区域分隔线':area+(use==='hero-image'?'；艺术主视觉占满视觉区，可配少量主题点缀':'；艺术主视觉位于边侧，可配少量主题点缀');
  const prompt=`用途：“${p.brief.title}”无字${roles[use]}，仅生成本张，16:9（1920×1080）。表现：${rendering}；${palette(d,use)}。主体：${sentence(subject)}。${use==='content-background'?'留白':'画面'}：${space}。${themeAssetBoundaryHint(use)}不含文字、数字、图注、文本框或占位框。`;
  const photo=themePhotoCandidates(p).find(m=>m.id===selectedThemePhotoId(d,use));return photo?photoThemePrompt(prompt,photo):prompt;
}
