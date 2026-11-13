// Text paint policy for 05 rebuild (secondary-title solid fills).
//
// User-approved rule: subtitle / heading / table-header / imageTitle (and equivalent secondary
// titles) must NOT carry a glyph gradient. They may keep at most two distinct solid colours,
// spatially separated solid `textColorRuns` colours (e.g. prefix + value on one line). The page
// main title (`role:"title"`) keeps its designed gradient; shape/background fills are untouched.
//
// This module is the single policy function that audit patches, tool patches and the export path
// should funnel through (Codex integration). It is pure and idempotent: it never changes text,
// fontFace, size, weight, spacing or geometry -- only paint fields.
//
// Contract for consumers:
//   enforceTextPaintPolicy(element) -> element
//     - only type==='text' and role in SECONDARY_TITLE_ROLES are inspected;
//     - removes `gradient` and `textGradient`; keeps/derives one base `color`;
//     - keeps one base colour plus the accent with greatest character coverage; multiple
//       spans of that same accent are preserved in their original order;
//     - `textColorKind:'title'` is demoted to 'secondary' so export checks do not treat it as a
//       main title; other fields are preserved as-is.
//   enforceTextPaintPolicyAll(elements) -> elements[] (same element order).
//   selectTextColorRuns(runs, limit) / runCoverage(run) -> exported for tests and tooling.
export const TEXT_STYLE_POLICY_VERSION = 4;
export const mainTitleGradientRule='主标题禁止文字描边outline，仅允许纯色或竖向线性渐变（angle:90，上到下）；副标题、小标题与表头仍使用纯色。';
export function normalizeMainTitlePaint(element){
  if(element?.type!=='text'||!['title','page-title'].includes(String(element.role||'').toLowerCase()))return element;
  const normalize=paint=>{
    if(!paint)return paint;
    if((!paint.type||paint.type==='linear')&&paint.angle===90&&!paint.center&&paint.vertical!==false)return paint;
    const {center,vertical,...rest}=paint;
    return {...rest,type:'linear',angle:90,...(vertical!==undefined?{vertical:true}:{})};
  };
  const {outline,...rest}=element;
  const next={...rest,...(element.gradient?{gradient:normalize(element.gradient)}:{}),...(element.textGradient?{textGradient:normalize(element.textGradient)}:{})};
  return JSON.stringify(next)===JSON.stringify(element)?element:next;
}
export const MAX_SECONDARY_TEXT_COLORS = 2;
export const SECONDARY_TITLE_ROLES = Object.freeze([
  'subtitle', 'heading', 'subheading', 'table-header', 'table-title', 'imageTitle', 'figure-title',
]);

const SECONDARY_ROLES = new Set(SECONDARY_TITLE_ROLES.map(role => role.toLowerCase()));

export const isSecondaryTitleRole = role => SECONDARY_ROLES.has(String(role ?? '').trim().toLowerCase());

function stopsOf(paint) {
  return Array.isArray(paint?.stops) ? paint.stops : [];
}

function firstPaintColor(element) {
  for (const paint of [element?.color, ...stopsOf(element?.gradient).map(stop => stop?.color),
    ...stopsOf(element?.textGradient).map(stop => stop?.color)]) {
    const text = String(paint ?? '').replace(/^#/, '').trim();
    if (/^[0-9a-fA-F]{6}$/.test(text)) return text.toUpperCase();
  }
  return null;
}

export function runCoverage(run) {
  const spans = Array.isArray(run?.lineSpans) ? run.lineSpans : [];
  if (spans.length) {
    return spans.reduce((sum, span) => sum
      + Math.max(0, Number(span?.endFraction) - Number(span?.startFraction)), 0);
  }
  const share = Number(run?.share ?? run?.evidence?.share ?? 0);
  return Number.isFinite(share) ? Math.max(0, share) : 0;
}

// Keep at most `limit` colour runs, chosen by visible character coverage; ties keep original order.
export function selectTextColorRuns(runs, limit = MAX_SECONDARY_TEXT_COLORS) {
  if (!Array.isArray(runs) || !runs.length || limit <= 0) return [];
  const usable = runs
    .map((run, index) => ({run, index, coverage: runCoverage(run)}))
    .filter(entry => /^[0-9a-fA-F]{6}$/.test(String(entry.run?.color ?? '').replace(/^#/, '')));
  const kept = usable
    .sort((a, b) => b.coverage - a.coverage || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map(entry => entry.run);
  return kept;
}

function normalizeRuns(runs) {
  return runs.map(run => {
    const color = String(run?.color ?? '').replace(/^#/, '').toUpperCase();
    return color === run?.color ? run : {...run, color};
  });
}

export function enforceTextPaintPolicy(element) {
  element=normalizeMainTitlePaint(element);
  if (!element || element.type !== 'text' || !isSecondaryTitleRole(element.role)) return element;
  const hasGradient = element.gradient !== undefined || element.textGradient !== undefined;
  const currentRuns = Array.isArray(element.textColorRuns) ? element.textColorRuns : [];
  const base = firstPaintColor(element);
  const distinct = new Map();
  for(const run of currentRuns){
    const color=String(run.color||'').replace(/^#/,'').toUpperCase();
    if(!/^[\dA-F]{6}$/.test(color))continue;
    if(color===base)continue;
    const entry=distinct.get(color)||{coverage:0,runs:[]};
    entry.coverage+=runCoverage(run);entry.runs.push(run);distinct.set(color,entry);
  }
  const accent=[...distinct].sort((a,b)=>b[1].coverage-a[1].coverage)[0]?.[0];
  const keptRuns=currentRuns.filter(run=>String(run.color||'').replace(/^#/,'').toUpperCase()===accent);
  if (!hasGradient && keptRuns.length === currentRuns.length && element.textColorKind!=='title') return element;
  const {gradient, textGradient, ...rest} = element;
  const color = firstPaintColor(element);
  const next = {...rest, ...(color ? {color} : {})};
  if (keptRuns.length) next.textColorRuns = normalizeRuns(keptRuns);
  else delete next.textColorRuns;
  // A misclassified subtitle must not keep the main-title paint kind after its gradient is removed.
  if (String(element.textColorKind || '').toLowerCase() === 'title') next.textColorKind = 'secondary';
  return next;
}

export function enforceTextPaintPolicyAll(elements) {
  if (!Array.isArray(elements)) return elements;
  return elements.map(enforceTextPaintPolicy);
}
