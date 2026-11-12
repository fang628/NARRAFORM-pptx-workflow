// Shared element taxonomy for the 05 pipeline: the audit step (LLM coarse recognition)
// and the parameter-fitting tools must agree on one enum. The audit can emit
// elementClass/fillKind/strokeKind/edgeKind/fitIgnore, and when those are missing the
// derive* helpers reconstruct them from the existing element fields.

export const GEOMETRY_CLASSES = [
  'rect-panel', 'rounded-panel', 'bubble', 'capsule', 'pill', 'card', 'plate',
  'circle', 'ellipse', 'ring', 'badge', 'parallelogram', 'cut-panel', 'chevron',
  'arrow', 'flag', 'triangle', 'trapezoid', 'hexagon', 'diamond', 'band', 'ribbon',
  'divider', 'progress-segment', 'table-grid', 'blob', 'freeform-panel',
];
export const ASSET_CLASSES = ['svg', 'icon', 'ai-cutout', 'image', 'logo', 'chart-image', 'artistic-text'];
export const TEXT_CLASSES = ['title', 'subtitle', 'heading', 'body', 'caption', 'number', 'formula'];
export const EFFECT_CLASSES = ['glow', 'shadow', 'light-beam', 'texture'];
export const STRUCTURAL_CLASSES = ['background'];
export const ELEMENT_CLASSES = [
  ...STRUCTURAL_CLASSES, ...TEXT_CLASSES, ...GEOMETRY_CLASSES, ...ASSET_CLASSES, ...EFFECT_CLASSES,
];
export const FILL_KINDS = ['solid', 'gradient', 'translucent', 'image', 'none'];
export const STROKE_KINDS = ['stroke', 'noStroke', 'glowOnly', 'unknown'];
export const EDGE_KINDS = ['crisp', 'faint', 'softGlow', 'unknown'];
export const FITTING_MODELS = [
  'QUAD', 'ROUND-QUAD', 'ELLIPSE', 'RING', 'PRESET-POLY', 'LINE', 'OPEN-PATH',
  'FREEFORM-CURVE', 'COMPOSITE', 'EFFECT', 'ASSET', 'TEXT', 'UNKNOWN',
];
export const FITTING_MODEL_OF_CLASS = {
  'rect-panel': 'QUAD', card: 'QUAD', plate: 'QUAD', 'cut-panel': 'QUAD', parallelogram: 'QUAD',
  'freeform-panel': 'QUAD', band: 'QUAD', ribbon: 'ROUND-QUAD', 'progress-segment': 'QUAD',
  'table-grid': 'COMPOSITE', 'rounded-panel': 'ROUND-QUAD', bubble: 'ROUND-QUAD',
  capsule: 'ROUND-QUAD', pill: 'ROUND-QUAD', circle: 'ELLIPSE', ellipse: 'ELLIPSE',
  ring: 'RING', badge: 'ELLIPSE', chevron: 'PRESET-POLY', arrow: 'PRESET-POLY',
  flag: 'PRESET-POLY', triangle: 'PRESET-POLY', trapezoid: 'PRESET-POLY',
  hexagon: 'PRESET-POLY', diamond: 'PRESET-POLY', divider: 'LINE', blob: 'FREEFORM-CURVE',
  'bubble-tail': 'FREEFORM-CURVE', glow: 'EFFECT', shadow: 'EFFECT', 'light-beam': 'EFFECT',
  texture: 'EFFECT', title: 'TEXT', subtitle: 'TEXT', heading: 'TEXT', body: 'TEXT',
  caption: 'TEXT', number: 'TEXT', formula: 'TEXT', background: 'ASSET',
  svg: 'ASSET', icon: 'ASSET', 'ai-cutout': 'ASSET', image: 'ASSET', logo: 'ASSET',
  'chart-image': 'ASSET', 'artistic-text': 'ASSET',
};
export function fittingModel(elementClass) {
  return FITTING_MODEL_OF_CLASS[elementClass] || 'UNKNOWN';
}
export const FIT_STRATEGIES = [
  'ignore-asset', 'ellipse', 'rounded-params', 'prototype', 'thin-band', 'fill-contrast', 'edge-line', 'unknown',
];

const GEOMETRY_TO_FAMILY = {
  'rect-panel': 'panel', card: 'panel', plate: 'panel', 'freeform-panel': 'panel',
  parallelogram: 'panel', 'cut-panel': 'panel', 'rounded-panel': 'rounded',
  bubble: 'rounded', capsule: 'rounded', pill: 'rounded',
  circle: 'ellipse', ellipse: 'ellipse', ring: 'ellipse', badge: 'ellipse',
  chevron: 'prototype', arrow: 'prototype', flag: 'prototype', triangle: 'prototype',
  trapezoid: 'prototype', hexagon: 'prototype', diamond: 'prototype',
  band: 'band', ribbon: 'band', divider: 'line', 'progress-segment': 'panel', 'table-grid': 'panel',
};

export function classFamily(elementClass) {
  return GEOMETRY_TO_FAMILY[elementClass] || (ASSET_CLASSES.includes(elementClass) ? 'asset' : 'unknown');
}

export function isAssetClass(elementClass) {
  return ASSET_CLASSES.includes(elementClass);
}

export function deriveElementClass(element = {}) {
  const type = String(element.type || '').toLowerCase();
  const role = String(element.role || '').toLowerCase();
  if (role === 'background') return 'background';
  if (role === 'effect' || role === 'glow') return 'glow';
  if (type === 'text' || type === 'formula') {
    if (type === 'formula') return 'formula';
    if (role === 'title') return 'title';
    if (role === 'subtitle') return 'subtitle';
    if (role === 'heading') return 'heading';
    if (role === 'caption') return 'caption';
    if (role === 'visual-number') return 'number';
    return 'body';
  }
  if (type === 'svg') return 'svg';
  if (type === 'cutout' || type === 'crop' || type === 'generate') return 'ai-cutout';
  if (type === 'image') {
    if (element.artisticText === true) return 'artistic-text';
    if (String(element.implementation || '').toLowerCase() === 'svg') return 'svg';
    return 'image';
  }
  if (type === 'line') return 'divider';
  if (type === 'ellipse') {
    const ratio = Math.min(Number(element.w) || 1, Number(element.h) || 1) / Math.max(Number(element.w) || 1, Number(element.h) || 1);
    if (role === 'badge') return 'badge';
    return ratio >= 0.94 ? 'circle' : 'ellipse';
  }
  if (type === 'rect') {
    const w = Number(element.w) || 0;
    const h = Number(element.h) || 0;
    if (h > 0 && w / h >= 4 && h <= 64) return 'band';
    if (element.shapeGeometry?.corners?.some?.((corner) => corner?.type === 'round')) return 'rounded-panel';
    return 'rect-panel';
  }
  if (type === 'shape') {
    const shape = String(element.shape || '').toLowerCase();
    const byShape = {
      roundrect: 'rounded-panel', hexagon: 'hexagon', chevron: 'chevron', rightarrow: 'arrow',
      triangle: 'triangle', trapezoid: 'trapezoid', parallelogram: 'parallelogram',
      diamond: 'diamond', star5: 'blob',
    };
    if (byShape[shape]) return byShape[shape];
    if (['freeform', 'freeform-curve'].includes(shape)) {
      const corners = element.shapeGeometry?.corners || [];
      if (corners.some((corner) => corner?.type === 'cut')) return 'cut-panel';
      if (corners.some((corner) => corner?.type === 'round')) return 'freeform-panel';
      return 'freeform-panel';
    }
    return 'freeform-panel';
  }
  return 'unknown';
}

export function deriveAppearance(element = {}) {
  const elementClass = element.elementClass || element.class || element.classHint || deriveElementClass(element);
  let fillKind = 'none';
  if (element.gradient) fillKind = 'gradient';
  else if (['image', 'svg', 'ai-cutout', 'artistic-text'].includes(element.type) || isAssetClass(elementClass)) fillKind = 'image';
  else if (Number(element.fillOpacity) < 0.98 || Number(element.opacity) < 0.98) fillKind = 'translucent';
  else if (element.fill || element.fillOpacity !== undefined) fillKind = 'solid';
  const strokeWidth = Number(element.strokeWidth ?? NaN);
  let strokeKind;
  if (roleIsEffect(element)) strokeKind = 'glowOnly';
  else if (isAssetClass(elementClass)) strokeKind = 'unknown';
  else if (Number.isFinite(strokeWidth)) strokeKind = strokeWidth > 0 ? 'stroke' : 'noStroke';
  else strokeKind = 'unknown';
  let edgeKind = 'unknown';
  if (strokeKind === 'stroke') edgeKind = 'crisp';
  else if (strokeKind === 'noStroke') edgeKind = fillKind === 'gradient' ? 'softGlow' : 'faint';
  return {fillKind, strokeKind, edgeKind, fitIgnore: isAssetClass(elementClass)};
}

function roleIsEffect(element) {
  const role = String(element.role || '').toLowerCase();
  return role === 'effect' || role === 'glow';
}

export function fittingStrategy(elementClass, appearance = {}) {
  if (isAssetClass(elementClass) || appearance.fitIgnore) return 'ignore-asset';
  const family = classFamily(elementClass);
  if (family === 'ellipse') return 'ellipse';
  if (family === 'rounded') return 'rounded-params';
  if (family === 'prototype') return 'prototype';
  if (family === 'band') return 'thin-band';
  if (family === 'panel') {
    const borderless = ['noStroke', 'glowOnly'].includes(appearance.strokeKind)
      || ['faint', 'softGlow'].includes(appearance.edgeKind);
    const gradient = appearance.fillKind === 'gradient';
    return borderless || gradient ? 'fill-contrast' : 'edge-line';
  }
  return 'unknown';
}

export function annotateElement(element = {}) {
  const elementClass = element.elementClass || element.class || element.classHint || deriveElementClass(element);
  const appearance = {...deriveAppearance({...element, elementClass}), ...(element.appearance || {})};
  return {
    ...element,
    elementClass,
    appearance,
    fitIgnore: element.fitIgnore ?? appearance.fitIgnore ?? isAssetClass(elementClass),
    fitStrategy: element.fitStrategy || fittingStrategy(elementClass, appearance),
  };
}

export function annotateElements(elements = []) {
  return elements.map((element) => annotateElement(element));
}

// Compact enum text injected into the audit prompt: class list + the few attribute words.
export const ELEMENT_CLASS_ENUM_TEXT = `class 枚举（每项一个词）：${ELEMENT_CLASSES.join('|')}；fillKind=${FILL_KINDS.join('|')}；strokeKind=${STROKE_KINDS.join('|')}；edgeKind=${EDGE_KINDS.join('|')}；需要 svg/AI 抠图的元素（type=svg|cutout|image 或 class=svg|icon|ai-cutout）标 fitIgnore:true，表示按原素材插入、不做形状拟合也不作为边缘证据。`;
