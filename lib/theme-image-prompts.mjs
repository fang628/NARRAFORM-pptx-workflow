import {selectedThemePhotoId,themePhotoCandidates,photoThemePrompt} from '../public/theme-photo-policy.js';
import {visualTreatmentText} from './visual-treatment.mjs';
import {backgroundSubjectRule,backgroundVariationRule,distinguishBackgroundVisuals,coverSubjectArtRule} from './theme-subject-policy.mjs';
import {promptColorText,promptColor,visualColors} from './prompt-colors.mjs';
import {presetPageColor} from './preset-design.mjs';
export const themeImagePromptVersion='workflow-background-prompt-v24';
export const singleImagePromptRule='本次只处理当前用途的一张图片，返回一条完整提示词；不同时给出不同页面的提示词，不生成多页拼图或分镜。';
const themePromptWritingBase='底图绘图要求只写用途与尺寸、具体绘画表现和可用配色、明确让出的区域（方位及大致范围）、必要禁项，单段通常100–220字，不设凑字数下限；明确细节较多时可合理加长。不把筛选依据、检查条文或执行说明发给生图模型。删去简洁克制、阅读安静、不抢视觉中心、自由发挥等通用套话；每项实际要求仅写一次。留白必须写清是左侧、右侧、中上部或中央哪一区域，以及大致范围或面积，不能只说预留标题区或适当留白；主体与装饰避开该区，不画出空白框。不发送风格名或预设名称。';
const coverSubjectWriting='必须保留“主体：所选艺术形象”，以PPT实际介绍的那个具象对象或其特有关系为依据进行艺术化表达，不要求写实复刻。主体须能被图片直接表现，不依赖文字标签或缩写，简写一两项可画出的鲜明辨识特征。'+coverSubjectArtRule;
const tocSubjectWriting='目录视觉必须符合PPT主题并呼应全篇主线，可用艺术化或抽象意象，不强制实际核心具象对象及其鲜明特征，留出目录文字区。';
const pageBackgroundRule=use=>use==='content-background'?'主题元素仅置于低对比边角，中央约七成区域留空，不画分框、卡片、分栏或区域分隔线，不预设内容排版。':use==='toc-image'?'艺术主视觉位于边侧，目录文字区连续留空，不画文本框、卡片或占位框，不预画条目。':'艺术主视觉占满视觉区，可有少量主题点缀，主体区与文字留白区用边界线分隔。';
export const themePromptWritingRule=themePromptWritingBase+'仅封面：'+coverSubjectWriting+tocSubjectWriting+'内容背景不强制主体。'+['hero-image','toc-image','content-background'].map(pageBackgroundRule).join('')+backgroundVariationRule+'无字底图不含文字、数字、图注、文本框或占位框。各页型要求分开保存，组装每条提示词时仅使用对应页型，不能把三个页型的构图一起发给生图模型。';
export const themeSubjectBriefGuidance='仅封面先在内部识别PPT实际介绍的核心具象对象与主题特征，再选定一个鲜明可画的艺术形象，不要求写实复刻。'+coverSubjectArtRule+'描述用短语，不扩写技术参数，用户指定细节保留。内容背景只写低对比边角装饰，不要求主体。目录选符合主题并呼应全篇主线的艺术化或抽象意象，不强制核心具象对象及特征；封面与目录在形态、视角或效果上有差异，配色统一并避让文字区。';
const roles={'hero-image':'封面底图','toc-image':'目录底图','content-background':'内容页背景'};
export const themePromptWritingRuleFor=use=>singleImagePromptRule+themePromptWritingBase+'当前用途：'+(roles[use]||'当前底图')+'。'+pageBackgroundRule(use)+(use==='content-background'?'不要求主体对象或主体字段。':(use==='hero-image'?coverSubjectWriting:tocSubjectWriting)+backgroundVariationRule)+'无字底图不含文字、数字、图注、文本框或占位框。';
// Only inspect independent drawing-brief headers, never mentions in ordinary prose.
export function validateSingleThemePrompt(prompt){
  const briefs=[...String(prompt).matchAll(/用途[:：]/g)];
  const headers=[...String(prompt).matchAll(/(?:^|[\n。；;])\s*(?:#{1,4}\s*|[-*]\s*|\d+[.)、]\s*)?(?:\*\*|【)?(封面(?:页)?(?:底图)?|目录(?:页)?(?:底图)?|内容页(?:底图|背景)?)(?:提示词)?(?:\*\*|】)?\s*[:：]/g)];
  const multiImage=/(?:底图|背景图|预览图)(?:共|一共|总共)?\s*[两二三四五六七八九十2-9]\s*张|[两二三四五六七八九十2-9]\s*张(?:底图|背景图|预览图)/.test(prompt);
  if(multiImage||briefs.length>1||new Set(headers.map(h=>h[1])).size>1)throw Object.assign(Error('本次底图提示词包含多个独立页面任务'),{repairInstruction:singleImagePromptRule+'仅保留当前用途的构图、主体和留白要求，删除其他页的独立提示词，保留当前页有效要求。'});
  return prompt;
}
export const themeAssetSubjectRule=use=>use==='content-background'?'内容背景不强制主体，仅延续本方向的低对比边角装饰与配色，中央留空。':(use==='toc-image'?tocSubjectWriting:backgroundSubjectRule)+backgroundVariationRule;
export const themeAssetBoundaryHint=use=>use==='hero-image'?'主体区与文字留白区用边界线分隔。':'';
const sentence=v=>String(v||'').trim().replace(/[。；;\s]+$/u,'');
export function themeAssetSubject(p,d,use){
  const direction=distinguishBackgroundVisuals(d,p.brief||{},p.visualTreatment),usable=v=>/^(不使用|不适用|无|none|(?:左|右|上|下|中|侧|边|角|部|区|居|位|置|于|在|留|白|空|画|面|主体|视觉|[\s，,：:])+)$/i.test(sentence(v))?'':sentence(v);
  const key={'hero-image':'heroSubject','toc-image':'tocSubject','content-background':'contentSubject'}[use];
  let subject=usable(direction[key])||usable(direction.subjectSources?.[key]?.element)||(use==='content-background'?'低对比点阵与平面色块':use==='toc-image'?'呼应'+String(p.brief?.title||'全篇主题')+'的边侧艺术意象':usable(direction.heroSubject));
  if(!subject)throw Object.assign(Error('封面底图尚未明确PPT介绍的具象主体，请先重新规划提示词'),{repairInstruction:coverSubjectWriting});
  subject=subject.replace(/^同一(?=.{2,})/,'');
  if(use==='content-background'){subject=subject.split(/[，,；;。]/)[0];if(!/低对比|淡化|半透明/.test(subject))subject+='，低对比';if(!/边角|角落|左下|右下|左上|右上/.test(subject))subject+='，置于边角';}
  return subject;
}

function palette(d,use){
  const core=promptColor(presetPageColor(d,use)),colors=[...new Set(visualColors(d.styleSummary??d.style??'').map(c=>c.endsWith('色')?c:c+'色'))].filter(c=>c!==core);
  return `底色 ${core}（全套统一）`+(colors.length?'，可用配色 '+colors.join('、'):'');
}

export function themeReadingArea(d,use){
  if(use==='content-background')return '中央大片留空，约占画面七成，图形与装饰仅限边角';
  const purpose=use==='toc-image'?'目录文字区连续留空':'标题与副标题区域连续留白';
  const finish=(area,{preset=false}={})=>{
    const value=sentence(area);
    const regions=[[/中上|上中/,'中上部'],[/中下|下中/,'中下部'],[/左上|左侧上部/,'左上部'],[/右上|右侧上部/,'右上部'],[/左下|左侧下部/,'左下部'],[/右下|右侧下部/,'右下部'],[/左中|左侧中部/,'左侧中部'],[/右中|右侧中部/,'右侧中部'],[/左标题|左侧|左边|左半/,'左侧'],[/右侧|右边|右半/,'右侧'],[/上部|上方|顶部/,'上部'],[/下部|下方|底部/,'下部'],[/居中|中央|中部/,'中央']];
    let region=regions.find(([re])=>re.test(value))?.[1];
    if(!region){
      const subject=String(use==='hero-image'?d.heroSubject:d.tocSubject);
      region=/右/.test(subject)?'左侧':/左/.test(subject)?'右侧':use==='hero-image'?'左侧':'中央';
    }
    const extent=value.match(/(?:约\s*)?(\d+(?:\.\d+)?\s*[%％]|[一二三四五六七八九十两]+成半?|[一二三四五六七八九十]+分之[一二三四五六七八九十]+)/)?.[1]||
      (use==='hero-image'?/中央/.test(region)?'六成':'四成半':/中央/.test(region)?'七成':'六成');
    // Output only one scoped reading-area instruction; never repeat the raw planning sentence.
    return '画面'+region+'约'+extent+'区域为'+purpose+'，主体与装饰不得侵入该区';
  };
  if(d.presetDesign){
    const layout=d.presetDesign.source?.layout?.[use==='hero-image'?'cover':'toc']||'';
    // Title-on-left presets retain their original reading area, even when a later clause says centered.
    if(use==='hero-image')return finish(/左标题/.test(layout)?'左侧':/居中/.test(layout)?'中央':layout,{preset:true});
    if(/右侧|右.*(?:列表|胶囊)/.test(layout))return finish('右侧三分之二',{preset:true});
    return finish('中央七成',{preset:true});
  }
  const area=sentence(d.textArea),role='(?:封面(?:页)?|标题页|目录(?:页)?|内容页|内容背景|正文页|正文(?=[:：]))(?:底图|背景)?';
  const markers=[...area.matchAll(new RegExp(role+'(?:\\s*[、与和及/]\\s*'+role+')*','g'))];
  const match=use==='hero-image'?/封面|标题页/:/目录/;
  const scoped=markers.flatMap((marker,i)=>{
    if(!match.test(marker[0]))return [];
    const body=area.slice(marker.index+marker[0].length,markers[i+1]?.index??area.length).replace(/\n\s*(?:[-*•]|\d+[.)、])\s*$/g,'').replace(/^[\s:：、,，]+|[\s；;。，,、/]+$/g,'');
    return body?[body]:[];
  });
  return finish(scoped.length?scoped.join('；'):!markers.length?area:'');
}

export function themeAssetPrompt(p,d,use){
  if(!roles[use])throw Error('底图用途不存在');
  const subject=themeAssetSubject(p,d,use);
  const rendering=visualTreatmentText(p.visualTreatment)||'以艺术形态、轮廓与色面表现主题';
  const area=themeReadingArea(d,use);
  const space=use==='content-background'?area+'，不画分框、卡片、分栏或区域分隔线':area+(use==='hero-image'?'；艺术主视觉占满视觉区，可配少量主题点缀':'；艺术主视觉位于边侧，可配少量主题点缀');
  const prompt=`用途：“${p.brief.title}”无字${roles[use]}，仅生成本张，16:9（1920×1080）。表现：${rendering}；${palette(d,use)}。${use==='content-background'?'装饰：'+sentence(subject):'主体：'+sentence(subject)+'，以单个对象呈现'}。${use==='content-background'?'留白':'画面'}：${space}。${themeAssetBoundaryHint(use)}不含文字、数字、图注、文本框或占位框。`;
  const photo=themePhotoCandidates(p).find(m=>m.id===selectedThemePhotoId(d,use));return photo?photoThemePrompt(prompt,photo):prompt;
}
