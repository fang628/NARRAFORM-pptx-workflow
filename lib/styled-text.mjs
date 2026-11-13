import {nativeInlineTextParts} from '../public/inline-text.js';
import {visualGradient} from './visual-gradient.mjs';
import {enforceTextPaintPolicy} from './text-style-policy.mjs';
import {scriptScale} from './script-metrics.mjs';

export function normalizeTextPaint(element) {
  element=enforceTextPaintPolicy(element);
  if (element.type !== 'text' || !element.textGradient) return element;
  const value = element.textGradient;
  const gradient = visualGradient({...value, type: value.type || 'linear', angle: value.angle ?? 90,
    stops: value.stops.map(stop => ({...stop, position: stop.position ?? stop.offset}))});
  const {textGradient, ...rest} = element;
  return {...rest, gradient};
}

export const hasRunStyles = element => Boolean(element.textColorRuns?.length || element.boldRuns?.length);

// Layout uses visible characters, never markup offsets. Math remains atomic through styling.
export function styledTextLines(element) {
  const parsed = nativeInlineTextParts(element.text);
  const parts = typeof parsed === 'string' ? [{type: 'text', text: parsed}]
    : parsed.map(part => ({...part, type: part.type || 'text',
      script: part.script || (part.options?.superscript ? 'sup' : part.options?.subscript ? 'sub' : null)}));
  const lines = [];
  let line = [], used = 0;
  const width = element.noWrap || element.role === 'navigation' ? Infinity : element.w;
  const flush = () => {lines.push(line); line = []; used = 0;};
  for (const part of parts) {
    const units = part.type === 'math' ? [part] : [...part.text].map(text => ({...part, text}));
    for (const unit of units) {
      if (unit.text === '\n') {flush(); continue;}
      const advance = unit.type === 'math' ? element.size * Math.max(1, Math.min(8, unit.latex.length * 0.5))
        : (unit.text.codePointAt(0) > 255 ? element.size : element.size * .57)*(unit.script ? scriptScale : 1) + (used ? element.charSpacing || 0 : 0);
      if (used + advance > width && line.length) flush();
      line.push({...unit, advance}); used += advance;
    }
  }
  if (line.length || !lines.length) flush();
  return lines.map((units, lineIndex) => {
    const length = units.reduce((sum, unit) => sum + (unit.text?.length || 1), 0);
    let offset = 0;
    return units.map(unit => {
      const middle = (offset + (unit.text?.length || 1) / 2) / Math.max(1, length);
      offset += unit.text?.length || 1;
      const contains = span => Number(span.lineIndex) === lineIndex
        && middle >= Number(span.startFraction) && middle < Number(span.endFraction);
      const color = (element.textColorRuns || []).find(run => run.lineSpans?.some(contains)
        || !run.lineSpans?.length && (lineIndex + .5) / lines.length >= Number(run.startLine)
          && (lineIndex + .5) / lines.length <= Number(run.endLine))?.color;
      return {...unit, color: color || element.color,
        bold: Boolean(element.bold || element.boldRuns?.some(contains))};
    });
  });
}

export function styledTextParts(element) {
  const parts = styledTextLines(element).flatMap((line, index) => [
    ...(index ? [{type: 'text', text: '\n', color: element.color, bold: element.bold}] : []), ...line,
  ]);
  const merged = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (part.type === 'text' && previous?.type === 'text' && previous.script === part.script
      && previous.color === part.color && previous.bold === part.bold) previous.text += part.text;
    else merged.push({...part});
  }
  return merged;
}
