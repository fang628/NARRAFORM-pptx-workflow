import {nativeInlineTextParts} from '../public/inline-text.js';
import {visualGradient} from './visual-gradient.mjs';
import {enforceTextPaintPolicy} from './text-style-policy.mjs';
import {scriptScale} from './script-metrics.mjs';

export function normalizeTextPaint(element) {
  element=enforceTextPaintPolicy(normalizeTextColorRuns(element));
  if (element.type !== 'text' || !element.textGradient) return element;
  const value = element.textGradient;
  const gradient = visualGradient({...value, type: value.type || 'linear', angle: value.angle ?? 90,
    stops: value.stops.map(stop => ({...stop, position: stop.position ?? stop.offset}))});
  const {textGradient, ...rest} = element;
  return {...rest, gradient};
}

export const hasRunStyles = element => Boolean(element.textColorRuns?.length || element.boldRuns?.length);

// Keep adjacent letters in one shaping run. Independent x positions destroy kerning
// and cannot represent proportional Latin fonts or a centred base/subscript pair.
export function mergeTextUnits(units) {
  const merged=[];
  for(const unit of units){
    const previous=merged.at(-1);
    if(unit.type==='text'&&previous?.type==='text'&&previous.script===unit.script
      &&previous.color===unit.color&&previous.bold===unit.bold){
      previous.text+=unit.text;previous.advance+=unit.advance;
    }else merged.push({...unit});
  }
  return merged;
}

// Layout uses visible characters, never markup offsets. Math remains atomic through styling.
export function styledTextLines(element) {
  if(element.textColorRuns?.some(run=>!run.charRanges||run.text!==element.text))element=normalizeTextColorRuns(element);
  const parsed = nativeInlineTextParts(element.text);
  const parts = typeof parsed === 'string' ? [{type: 'text', text: parsed}]
    : parsed.map(part => ({...part, type: part.type || 'text',
      script: part.script || (part.options?.superscript ? 'sup' : part.options?.subscript ? 'sub' : null)}));
  const lines = [];
  let line = [], used = 0, sourceOffset=0;
  const width = element.noWrap || element.role === 'navigation' ? Infinity : element.w;
  const flush = () => {lines.push(line); line = []; used = 0;};
  for (const part of parts) {
    const units = part.type === 'math' ? [part] : [...part.text].map(text => ({...part, text}));
    for (let index=0;index<units.length;index++) {
      const unit=units[index];
      unit.sourceOffset=sourceOffset;sourceOffset+=unit.text?.length||1;
      if (unit.text === '\n') {line.push({...unit,advance:0,explicitBreak:true});flush(); continue;}
      const advance = unit.type === 'math' ? element.size * Math.max(1, Math.min(8, unit.latex.length * 0.5))
        : (unit.text.codePointAt(0) > 255 ? element.size : element.size * .57)*(unit.script ? scriptScale : 1) + (used ? element.charSpacing || 0 : 0);
      // Break before an English word when it fits on a fresh line.
      if(/^[A-Za-z0-9]$/.test(unit.text||'')&&!/^[A-Za-z0-9]$/.test(units[index-1]?.text||'')){
        let wordWidth=0;
        for(let j=index;j<units.length&&/^[A-Za-z0-9]$/.test(units[j].text||'');j++)wordWidth+=element.size*.57*(units[j].script?scriptScale:1)+(element.charSpacing||0);
        if(used+wordWidth>width&&wordWidth<=width&&line.length)flush();
      }
      if (used + advance > width && line.length) flush();
      line.push({...unit, advance}); used += advance;
    }
  }
  if (line.length || !lines.length) flush();
  return lines.map((units, lineIndex) => {
    const length = units.reduce((sum, unit) => sum + (unit.explicitBreak?0:unit.text?.length || 1), 0);
    let offset = 0;
    return units.map(unit => {
      const middle = (offset + (unit.text?.length || 1) / 2) / Math.max(1, length);
      offset += unit.text?.length || 1;
      const contains = span => Number(span.lineIndex) === lineIndex
        && middle >= Number(span.startFraction) && middle < Number(span.endFraction);
      const color = (element.textColorRuns || []).find(run => run.text===element.text
        &&run.charRanges?.some(range=>unit.sourceOffset>=range.start&&unit.sourceOffset<range.end))?.color;
      return {...unit, color: color || element.color,
        bold: Boolean(element.bold || element.boldRuns?.some(contains))};
    });
  });
}

export function styledTextParts(element) {
  // PowerPoint owns wrapping. Only newlines present in the source may be exported.
  const parts = styledTextLines(element).flat();
  const merged = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (part.type === 'text' && previous?.type === 'text' && previous.script === part.script
      && previous.color === part.color && previous.bold === part.bold) previous.text += part.text;
    else merged.push({...part});
  }
  return merged;
}

export function anchorTextColorRuns(element,runs) {
  const plain={...element,textColorRuns:[]},lines=styledTextLines(plain);
  return (runs||[]).flatMap(run=>{
    if(run.text!==undefined&&run.text!==element.text)return [];
    if(Array.isArray(run.charRanges)){
      const length=lines.flat().reduce((n,u)=>Math.max(n,u.sourceOffset+(u.text?.length||1)),0);
      const ranges=run.charRanges.filter(r=>Number.isInteger(r.start)&&Number.isInteger(r.end)&&r.start>=0&&r.end>r.start&&r.end<=length).map(({start,end})=>({start,end}));
      if(!ranges.length)return [];
      const {lineSpans,startLine,endLine,...rest}=run;
      return [{...rest,source:run.source||'audit',text:element.text,charRanges:ranges}];
    }
    const ranges=[];
    for(const [lineIndex,units]of lines.entries()){
      const width=units.reduce((sum,u)=>sum+u.advance,0);let x=0;
      for(const unit of units){
        const middle=(x+unit.advance/2)/Math.max(1,width);x+=unit.advance;
        if(unit.explicitBreak)continue;
        const selected=run.lineSpans?.length?run.lineSpans.some(s=>s.lineIndex===lineIndex&&middle>=s.startFraction&&middle<s.endFraction)
          :(lineIndex+.5)/lines.length>=Number(run.startLine)&&(lineIndex+.5)/lines.length<=Number(run.endLine);
        if(!selected)continue;
        const end=unit.sourceOffset+(unit.text?.length||1),last=ranges.at(-1);
        if(last?.end===unit.sourceOffset)last.end=end;else ranges.push({start:unit.sourceOffset,end});
      }
    }
    const {lineSpans,startLine,endLine,...rest}=run;
    return ranges.length?[{...rest,source:run.source||'audit',text:element.text,charRanges:ranges}]:[];
  });
}

// Legacy pixel spans are an input format only. Consumers use stable text offsets.
export function normalizeTextColorRuns(element){
  if(element?.type!=='text'||!element.textColorRuns?.length)return element;
  const runs=anchorTextColorRuns(element,element.textColorRuns);
  const {textColorRuns,...rest}=element;
  return runs.length?{...rest,textColorRuns:runs}:rest;
}

export function retainedTextColorRuns(element,referenceHash){
  return (normalizeTextColorRuns(element).textColorRuns||[]).filter(run=>run.source==='user'
    ||run.source==='reference-glyphs'&&run.referenceHash===referenceHash&&run.text===element.text);
}
