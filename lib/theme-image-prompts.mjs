export const themeImagePromptVersion='workflow-background-prompt-v9';
export const themeSubjectBriefGuidance='主体描述用一个短语，通常10–25字，只写材料对象名、必要识别特征与大致位置。不要扩写微观结构、部件数量、精确构象、材质光学或技术参数，局部造型由生图模型发挥；用户明确要求的细节保留。';
const roles={'hero-image':'封面底图','toc-image':'目录底图','content-background':'内容页背景'};
const complexity='不要过于复杂，不要抢夺视觉中心';
const themeElements='主题元素须取自材料且可辨识，不能仅用通用色块、线条或纹理代替';
export const themeAssetSubjectRule=use=>use==='hero-image'||use==='toc-image'
  ?'主题元素须可辨识且取自材料；一个明确主视觉铺满预定视觉区，明显可见；可搭配少量主题场景点缀，避免孤立，不形成竞争主体'
  :themeElements;
export const themeAssetSimplicity=use=>use==='hero-image'||use==='toc-image'?'主体为视觉重心，细节简洁，阅读区安静':complexity;
const sentence=v=>String(v||'').trim().replace(/[。；;\s]+$/u,'');
export function themeAssetSubject(p,d,use){
  const usable=v=>/^(不使用|不适用|无|none)$/i.test(sentence(v))?'':sentence(v);
  const fallback=usable(d.heroSubject)||usable(d.tocSubject)||`与“${p.brief.title}”相关的具体主题对象`;
  const key={'hero-image':'heroSubject','toc-image':'tocSubject','content-background':'contentSubject'}[use];
  let subject=usable(d[key])||fallback;
  const element=d.subjectSources?.[key]?.element;
  const identity=String(element||'').split(/[（(:：]/)[0].trim(),normalize=v=>String(v).replace(/[\s，,、；;：:（）()\-]/g,'').toLowerCase();
  if(element&&!normalize(subject).includes(normalize(element))&&!(identity.length>=4&&normalize(subject).includes(normalize(identity))))subject=element+'，'+subject;
  return subject+(use==='content-background'?'，以低对比简化轮廓置于边角，中央大片留白':'');
}

function palette(d){
  const style=String(d.styleSummary??d.style??''),core=d.coreColor.toUpperCase();
  const colors=[...new Set((style.match(/#[\da-f]{6}\b/gi)||[]).map(c=>c.toUpperCase()))].filter(c=>c!==core);
  const accent=style.split(/[。；;]/).filter(s=>/强调|点缀/.test(s)).flatMap(s=>s.match(/#[\da-f]{6}\b/gi)||[]).map(c=>c.toUpperCase()).filter(c=>c!==core);
  const others=colors.filter(c=>!accent.includes(c));
  return `统一核心底色 ${d.coreColor}`+(others.length?'，辅助色 '+others.join('、'):'')+(accent.length?'，'+[...new Set(accent)].join('、')+' 少量点缀':'')+(!colors.length?'，'+sentence(style.split(/[。；;]/)[0]).replaceAll(d.coreColor,''): '');
}

function readingArea(d,use){
  const area=sentence(d.textArea),parts=area.split(/[；;。]/).filter(Boolean);
  const match=use==='hero-image'?/封面|标题页/:use==='toc-image'?/目录/:/内容页|正文/;
  const scoped=parts.filter(s=>match.test(s));
  // Legacy planners put all page roles in one field. Send only this page's region.
  if(scoped.length)return scoped.join('；');
  if(use==='content-background')return '顶部标题及中央图文区安静留白，主题细节仅在边角';
  return area|| (use==='hero-image'?'左侧为标题、副标题预留连续阅读空间':'左侧为目录编号与条目预留连续阅读空间');
}

export function themeAssetPrompt(p,d,use){
  if(!roles[use])throw Error('底图用途不存在');
  const subject=themeAssetSubject(p,d,use);
  const mood=d.name||sentence(String(d.styleSummary??d.style??'简洁清晰').split(/[。；;]/)[0]);
  return `用途：“${p.brief.title}”PPT独立无字${roles[use]}。画布16:9（1920×1080）横版。视觉气质：${sentence(mood)}。${palette(d)}。主体：${sentence(subject)}；${themeAssetSubjectRule(use)}，局部造型自由发挥。构图：${readingArea(d,use)}；主体、装饰线与高光避开阅读区。${themeAssetSimplicity(use)}。不铺密集纹理，不用多处强光效。不绘制可读文字、数字、图注、文本框或占位框；仅非事实主题视觉，不画实验数据或伪造证据。`;
}

