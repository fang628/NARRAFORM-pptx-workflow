export const imagePromptSuffix='。仅作概念插画，不伪造实际事件、数据或证据，不含文字。';
export function checkedPrompt(v){if(typeof v!=='string'||!v.trim()||v.length>4000)throw Error('提示词须为 1–4000 字');return v.trim();}
export const promptDraftKey=(index,id,elementId)=>`${index===null?'library':index}:${id||'new'}${elementId?':'+elementId:''}`;

// Drawing briefs select visual choices, while the full registered definition stays intact.
export function compactVisualText(value,max=100,preserve){
  const parts=String(value||'').replace(/\r?\n/g,'；').split(/[。；;]/).map(s=>s.trim()).filter(Boolean);
  const unique=[...new Set(parts)],chosen=[];let length=0;
  for(const part of unique){
    // Long clauses are separated at natural commas; never cut a word or color code.
    for(const phrase of part.length>max?part.split(/[，,]/).map(s=>s.trim()).filter(Boolean):[part]){
      if(length+phrase.length+(chosen.length?1:0)>max)continue;
      chosen.push(phrase);length+=phrase.length+(chosen.length>1?1:0);
    }
  }
  if(preserve)for(const part of unique.flatMap(s=>s.split(/[，,]/).map(s=>s.trim()).filter(Boolean))){
    if(preserve.test(part)&&!chosen.some(s=>s.includes(part)))chosen.push(part);
  }
  return chosen.join('；');
}

export function imageStyle(direction,{background=false}={}){
  const style=String(direction.styleSummary??direction.style??''),core=direction.coreColor||'沿用已确认底色';
  const palette=style.split(/[，,。；;]/).filter(s=>/#[\da-f]{6}/i.test(s)&&!((s.match(/#[\da-f]{6}\b/gi)||[]).every(c=>c.toUpperCase()===core.toUpperCase())));
  const colorRoles=palette.map(s=>{
    const colors=[...new Set(s.match(/#[\da-f]{6}\b/gi)||[])];
    const role=/强调|重点|accent/i.test(s)?'强调':/辅助|secondary/i.test(s)?'辅助':/正文/.test(s)?'正文':/文字/.test(s)?'文字':/标题/.test(s)?'标题':/主色/.test(s)?'主色':'配色';
    return role+' '+colors.join('、');
  });
  const mood=direction.name||compactVisualText(style,35);
  // Every explicit color remains present, even when a verbose palette clause was omitted.
  const missingColors=[...new Set(style.match(/#[\da-f]{6}\b/gi)||[])].filter(c=>c.toUpperCase()!==core.toUpperCase()&&!colorRoles.join('；').toUpperCase().includes(c.toUpperCase()));
  const fields=[mood,`核心底色 ${core}`,...colorRoles,!/#[\da-f]{6}/i.test(style)?compactVisualText(style,45):null,missingColors.length?'辅助配色 '+missingColors.join('、'):null,background?null:compactVisualText(direction.typography,45,/#[\da-f]{6}|YaHei|雅黑|宋体|黑体|衬线|serif|sans/i),background?null:compactVisualText(direction.frames,45,/#[\da-f]{6}|无框|渐变|描边|弧形|扇形|斜切|裁切/),compactVisualText(direction.decoration,25,/#[\da-f]{6}|渐变|弧线|扇形|裁切/)];
  return [...new Set(fields.filter(Boolean))].join('；');
}
