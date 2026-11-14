// Field contract for the 05 rebuild pipeline.
// Each stage may only write its own fields; SVG / AI-cutout / image elements bypass S3-S6.

export const STAGES = ['S1-register', 'S2-complete', 'S2r-route', 'S3-shape', 'S4-fill',
  'S5-stroke', 'S5b-text-color', 'S6-merge', 'S7-assemble', 'S8-review', 'S9-deliver'];

export const ROUTES = ['native', 'text', 'svg', 'cutout', 'image'];

export const ELEMENT_TYPES = ['text', 'formula', 'shape', 'rect', 'ellipse', 'line',
  'svg', 'cutout', 'crop', 'generate', 'image'];

const TEXT_TYPES = new Set(['text', 'formula']);
const NATIVE_TYPES = new Set(['shape', 'rect', 'ellipse', 'line']);
const SVG_TYPES = new Set(['svg']);
const CUTOUT_TYPES = new Set(['cutout', 'crop', 'generate']);

export function routeOf(element) {
  const type = String(element?.type || '');
  if (TEXT_TYPES.has(type)) return 'text';
  if (NATIVE_TYPES.has(type)) return 'native';
  if (SVG_TYPES.has(type)) return 'svg';
  if (CUTOUT_TYPES.has(type)) return 'cutout';
  if (type === 'image') return String(element?.implementation || '').toLowerCase() === 'svg' ? 'svg' : 'image';
  return 'native';
}

// S2 exit: tag every element with elementPath so later stages only process the native route.
export function assignRoutes(elements) {
  return (elements || []).map(element => ({...element, elementPath: routeOf(element)}));
}

export function nativeRoute(elements) {
  return (elements || []).filter(element => (element.elementPath || routeOf(element)) === 'native');
}

export function validateIdentity(element, seenKeys = new Set(), {requireNodeId = false} = {}) {
  const issues = [];
  const key = String(element?.key || '');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) issues.push('invalid-key');
  else if (seenKeys.has(key)) issues.push('duplicate-key');
  if (!ELEMENT_TYPES.includes(String(element?.type || ''))) issues.push('invalid-type');
  if (!Number.isFinite(Number(element?.x)) || !Number.isFinite(Number(element?.y))
    || !Number.isFinite(Number(element?.w)) || !Number.isFinite(Number(element?.h))) issues.push('invalid-box');
  else if (String(element?.type) === 'line') {
    if (Math.max(Number(element.w), Number(element.h)) < 4) issues.push('tiny-box');
  } else if (Number(element.w) < 4 || Number(element.h) < 4) issues.push('tiny-box');
  if (requireNodeId && String(element?.type) === 'text' && !element?.nodeId) issues.push('missing-nodeId');
  if (issues.length === 0) seenKeys.add(key);
  return {ok: issues.length === 0, issues, key};
}

export function validateRegistry(elements) {
  const seen = new Set();
  const rejected = [];
  for (const element of elements || []) {
    const result = validateIdentity(element, seen);
    if (!result.ok) rejected.push({key: element?.key, issues: result.issues});
  }
  return {ok: rejected.length === 0, rejected, keys: seen.size};
}

// Apply a geometry-only patch (S3 may never touch paint/stroke/effect fields).
export function applyGeometryPatch(element, patch) {
  const allowed = ['x', 'y', 'w', 'h', 'shapeGeometry', 'customGeometry', 'shape', 'shapeRepaired', 'flipH', 'flipV'];
  const next = {...element};
  for (const field of allowed) {
    if (patch[field] !== undefined) next[field] = patch[field];
  }
  return next;
}

const STAGE_WRITES = {
  'S2-complete': ['role', 'description', 'nodeId', 'lowConfidence', 'fill', 'shape', 'type',
                  'x', 'y', 'w', 'h', 'key', 'elementPath', 'tableId', 'tableRole', 'tableGroup', 'tableObject', 'tableFittedFill', 'keepParameters',
                  'svg','visualKind','effectKind','representationOrigin','lighting','glow','shadow','strokeWidth','color','class','classHint'],
  'S2r-route': ['elementPath'],
  'S3t-table': ['x', 'y', 'w', 'h', 'strokeWidth', 'strokeGradient', 'color',
                'colorOpacity', '_tableStage', 'tableRole', 'keepParameters',
                'tableGridExtra'],
  'S3-shape': ['x', 'y', 'w', 'h', 'type', 'shapeGeometry', 'customGeometry', 'shape', 'shapeRepaired',
               'flipH', 'flipV', 'rotate', 'nativeDecision', 'lowConfidenceGeometry', 'geometryConfidence',
               'adjustments', 'headDepth', 'slantSign', 'geometryEvidence', 'cornerInfo',
               'lowConfidenceReason', 'tableId', 'tableGroup', 'tableObject', 'tableFittedFill',
               'tablePlaced', '_tableStage', 'tableRole', 'keepParameters', 'tableGridExtra',
               'fill', 'fillOpacity', 'gradient', 'color', 'colorOpacity', 'strokeWidth', 'strokeGradient'],
  'S4-fill': ['fill', 'fillOpacity', 'paint', 'gradient'],
  'S5-stroke': ['strokeWidth', 'color', 'strokeGradient', 'colorOpacity', 'lineEffect', 'effects','shadow','nativeEffectEvidence','beginArrowSize','endArrowSize','linePaintEvidence'],
  'S5b-text-color': ['color', 'gradient', 'textGradient', 'textColorKind', 'textColorRuns',
                     'italic', 'bold', 'boldRuns', 'outline','textPaintMeasured'],
  'S6-merge': ['parameterGroups', 'keepParameters', 'shapeGeometry', 'x', 'y', 'w', 'h', 'shape',
               'fill', 'gradient', 'fillOpacity', 'strokeWidth', 'color', 'strokeGradient', 'colorOpacity',
               'groupMergedFrom', 'groupMergedParams', 'tablePlaced', 'themeFillMerged', 'fillSource', 'adjustments', 'headDepth', 'slantSign', 'cornerInfo',
               'titleStyleForced', 'fontFace', 'bold', 'italic', 'textGradient',
               'shadow', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
               'geometryConfidence', 'lowConfidenceGeometry', 'tableId', 'tableGroup', 'tableObject', 'tableFittedFill','paintConsensus'],
  'S7-assemble': ['nativeShape', 'svg', 'assetId', 'sourceBox', 'imageId', 'fontKey', 'implementation'],
  'S8-review': ['issues', 'rejectedFrames', 'toolRepair', 'quality', 'x', 'y',
                'refinedByS8', 's8Offset'],
  'S9-deliver': [],
};

export function assertStageWrites(stage, before, after) {
  if (stage === 'S1-register') return [];
  const allowed = new Set(STAGE_WRITES[stage] || []);
  if(['S3-shape','S4-fill','S5-stroke','S5b-text-color','S6-merge'].includes(stage))allowed.add('parameterEvidence');
  if(['S4-fill','S5-stroke'].includes(stage))allowed.add('fillEndAlphaEvidence');
  if(['S5b-text-color','S6-merge'].includes(stage))for(const field of ['boldRuns','tableTypography'])allowed.add(field);
  if(stage==='S3-shape')for(const field of ['tableAlignment','align','valign'])allowed.add(field);
  if(stage==='S3-shape')allowed.add('objectIdentity');
  if(['S2-complete','S3-shape','S6-merge'].includes(stage))for(const field of ['parentKey','memberKeys','rowIndex','tableColorGroup','tablePaintEvidence','tableRowKey'])allowed.add(field);
  const violations = [];
  const beforeMap = new Map((before || []).map(element => [element.key, element]));
  for (const element of after || []) {
    const previous = beforeMap.get(element.key);
    if (!previous) continue;
    for (const field of new Set([...Object.keys(previous), ...Object.keys(element)])) {
      if (allowed.has(field)) continue;
      if (JSON.stringify(previous[field]) !== JSON.stringify(element[field])) violations.push({key: element.key, field});
    }
  }
  if (!['S2-complete', 'S3-shape', 'S3t-table'].includes(stage)) {
    const nextKeys = new Set((after || []).map(element => element.key));
    for (const element of before || []) if (!nextKeys.has(element.key)) violations.push({key: element.key, field: 'removed-element'});
    for (const element of after || []) if (!beforeMap.has(element.key)) violations.push({key: element.key, field: 'added-element'});
  }
  return violations;
}
