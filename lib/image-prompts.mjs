import {visualTreatmentText,flatTypographyRule} from './visual-treatment.mjs';
import {promptColorText,visualColors,withoutColorAssignments,uniquePromptColors} from './prompt-colors.mjs';
import {presetLayout,presetBackgroundStyle} from './preset-design.mjs';
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

export function imageStyle(direction,{background=false,foundationLocked=false,use='content-background',visualTreatment}={}){
  if(direction.presetDesign){
    const s=direction.presetDesign.source,fonts=s.typography;
    return promptColorText([visualTreatmentText(visualTreatment),'页面可用颜色 '+uniquePromptColors(visualColors(JSON.stringify(s.palette))).join('、'),foundationLocked||visualTreatment?null:presetBackgroundStyle(direction,use),
      background?null:visualTreatment==='flat'?flatTypographyRule:'标题采用'+fonts.title.family+'，'+[fonts.title.fill,fonts.title.effect].filter(Boolean).join('、')+'；正文采用'+fonts.body.family,
      background?null:'框形与装饰沿用'+s.decorativeShapes.forms.join('、'),background||foundationLocked?null:'原预设版式：'+presetLayout(direction,use)].filter(Boolean).join('；'));
  }
  const style=String(direction.styleSummary??direction.style??'');
  const colors=uniquePromptColors([direction.coreColor,style,direction.typography,direction.frames,direction.decoration].flatMap(visualColors));
  const mood=visualTreatmentText(visualTreatment)||compactVisualText(withoutColorAssignments(style).replaceAll(direction.name||'\u0000',''),35)||'沿用所选画面表现';
  const fields=[mood,colors.length?'页面可用颜色 '+colors.join('、'):null,background?null:visualTreatment==='flat'?flatTypographyRule:compactVisualText(withoutColorAssignments(direction.typography),45,/YaHei|雅黑|宋体|黑体|衬线|serif|sans/i),background?null:compactVisualText(withoutColorAssignments(direction.frames),45,/无框|渐变|描边|弧形|扇形|斜切|裁切/),foundationLocked?null:compactVisualText(direction.decoration,25,/渐变|弧线|扇形|裁切/)];
  return [...new Set(fields.filter(Boolean).map(promptColorText))].join('；');
}
