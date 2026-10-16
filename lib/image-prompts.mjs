import {promptColorText,visualColors,withoutColorAssignments} from './prompt-colors.mjs';
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
  const style=String(direction.styleSummary??direction.style??'');
  const colors=[...new Set([direction.coreColor,style,direction.typography,direction.frames,direction.decoration].flatMap(visualColors))];
  const mood=direction.name||compactVisualText(withoutColorAssignments(style),35)||'沿用所选视觉气质';
  const fields=[mood,colors.length?'页面可用颜色 '+colors.join('、'):null,background?null:compactVisualText(withoutColorAssignments(direction.typography),45,/YaHei|雅黑|宋体|黑体|衬线|serif|sans/i),background?null:compactVisualText(withoutColorAssignments(direction.frames),45,/无框|渐变|描边|弧形|扇形|斜切|裁切/),compactVisualText(direction.decoration,25,/渐变|弧线|扇形|裁切/)];
  return [...new Set(fields.filter(Boolean).map(promptColorText))].join('；');
}
