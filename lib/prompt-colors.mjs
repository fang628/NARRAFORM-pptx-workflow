// Exact palette values stay in registered styles; drawing briefs use broad color names.
export function promptColor(value){
  const hex=String(value||'').replace(/^#/,'');
  if(!/^[\da-f]{6}$/i.test(hex))return String(value||'');
  const [r,g,b]=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)/255);
  const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min,light=(max+min)/2;
  if(max<.12)return '近黑色';
  if(min>.94&&delta<.04)return '近白色';
  if(delta<.035)return light>.82?'浅灰色':light<.35?'深灰色':'灰色';
  let hue=delta===0?0:max===r?((g-b)/delta)%6:max===g?(b-r)/delta+2:(r-g)/delta+4;
  hue=(hue*60+360)%360;
  if(hue>=15&&hue<50&&light<.5&&delta>.1)return (light<.28?'深':'')+'褐色';
  const family=hue<15||hue>=345?'红色':hue<45?'橙色':hue<70?'黄色':hue<165?'绿色':hue<195?'青色':hue<255?'蓝色':hue<290?'紫色':'紫红色';
  return (light>.72?'浅':light<.32?'深':delta<.3?'灰调':'')+family;
}
export const promptColorText=value=>String(value??'').replace(/#[\da-f]{6}\b/gi,promptColor);
export const promptColorRule='配色只列页面可用的大致颜色，如深蓝、灰白、暖黄，不为标题、正文、图注或其他文字逐项指定颜色；由生图模型安排各颜色用途，已有底图颜色保持。精确色值仅供内部登记与重建。不要追加深底浅字、简约、紧密排版或可读性等通用套话。';

const colorPattern=/(?:#[\da-f]{6}\b|(?:近|浅|深|冷|暖|亮|暗|墨|灰调)?(?:蓝绿|灰白|蓝灰|紫红|黑|白|灰|红|橙|黄|绿|青|蓝|紫|粉|棕|褐)(?:色)?)(?!体|字)/gi;
export const visualColors=value=>[...new Set((String(value||'').match(colorPattern)||[]).map(promptColor))];
export const uniquePromptColors=values=>[...new Set(values.map(promptColor).map(color=>color.endsWith('色')?color:color+'色'))];
export function withoutColorAssignments(value){
  return String(value||'').split(/[，,。；;]/).map(clause=>{
    if(visualColors(clause).length&&/标题|正文|文字|图注|副标题|导航/.test(clause)&&!/无框|填充|描边|渐变|裁切|衬线|YaHei|雅黑|宋体|黑体/i.test(clause))return '';
    return clause.replace(colorPattern,'').trim();
  }).filter(Boolean).join('；');
}

export function conciseDrawingBrief(prompt){
  return String(prompt).split(/(?=^- \*\*[^*]+\*\*：)/m).map(part=>{
    // Content is authoritative, even if a real slide discusses design rules.
    if(/^- \*\*内容要求\*\*：/.test(part))return part;
    if(/^- \*\*可读性要求\*\*：/.test(part))return '';
    return part
      .replace(/^[ \t]+- \*\*(?:简约要求|紧密排版要求)\*\*：[^\n]*(?:\n|$)/gm,'')
      .replaceAll('有填充的文本框与所在背景底色须有可辨认色差，不能只靠描边区分；无框文字不强制加底。','')
      .replaceAll('无框文字不强制加底。','')
      .replaceAll('深色阅读区必须用浅色文字，浅色阅读区用深色文字；按文字所在局部底色（含文本框填充）判断，强调色也须清晰可读。','');
  }).join('');
}

function unassignTextColors(part){
  const roles='(?:主标题|副标题|小标题|标题|正文|图注|文字|导航|页码)(?:(?:与|和|及|、)(?:标题|正文|图注|文字|导航|页码))*';
  const colors=[];
  const collect=match=>{colors.push(...visualColors(match));return '';};
  const result=part
    .replace(new RegExp(roles+'\\s*(?:使用|采用|用|为|颜色为|颜色|色为|色|[:：])?\\s*'+colorPattern.source,'gi'),collect)
    .replace(new RegExp(colorPattern.source+'\\s*(?:用于|作为|的)?'+roles,'gi'),collect);
  if(!colors.length)return part;
  return result.replace(/[，；]\s*(?=[。\n]|$)/g,'').trimEnd()+'\n  - 页面可用颜色 '+[...new Set(colors)].join('、')+'。\n';
}

export function simplifyPromptColors(prompt){
  // Confirmed on-screen content may legitimately include a color code; never alter it.
  return conciseDrawingBrief(prompt).split(/(?=^- \*\*[^*]+\*\*：)/m).map(part=>
    /^- \*\*内容要求\*\*：/.test(part)?part:unassignTextColors(promptColorText(part)).replace(/((?:页面可用颜色|可用配色)\s+)([^。；\n]+)/g,(all,prefix,list)=>{
      const colors=list.trim().split(/\s*[、,，]\s*/);
      if(!colors.every(color=>visualColors(color).length===1&&visualColors(color)[0]===color))return all;
      return prefix+uniquePromptColors(colors).join('、');
    })).join('');
}
