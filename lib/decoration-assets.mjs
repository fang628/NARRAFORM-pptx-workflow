// Original-asset priority for decorative / light-effect elements.
// Decorations such as glowing rings, beams, slashes and arc halos are not faithfully
// reconstructible as native shapes. When the audit registers them as generic shape/line, convert
// them into a local cutout of the approved preview instead, so the asset pipeline keeps the original
// pixels (alpha, glow layers, exact colours) rather than redrawing a simplified approximation.
const DECORATION_PATTERN = /复杂光效|复杂画面|realistic|volumetric|photorealistic/i;

const ASSET_TYPES = new Set(['image', 'svg', 'cutout', 'crop', 'generate', 'text', 'formula']);

export function isDecorationAsset(element) {
  if (!element || ASSET_TYPES.has(String(element.type))) return false;
  if (!['shape', 'rect', 'ellipse', 'line'].includes(element.type)) return false;
  const key = String(element.key || '');
  const description = String(element.description || '');
  // A simple geometric glow is rendered separately; names never force paid extraction.
  return DECORATION_PATTERN.test(key) || DECORATION_PATTERN.test(description);
}

function sourceBoxOf(element, canvas = {width: 1600, height: 900}) {
  const x = Number(element.x), y = Number(element.y);
  const w = Number(element.w), h = Number(element.h);
  if (!['x', 'y', 'w', 'h'].every(key => Number.isFinite(Number(element[key])))) return null;
  if (w <= 0 && element.type !== 'line') return null;
  const padX = 4, padY = 4;
  let left = Math.max(0, Math.round(x - padX));
  let top = Math.max(0, Math.round(y - padY));
  let right = Math.min(canvas.width, Math.round(x + Math.max(w, 2) + padX));
  let bottom = Math.min(canvas.height, Math.round(y + Math.max(h, 2) + padY));
  if (right - left < 12 || bottom - top < 8) return null;
  if ((right - left) * (bottom - top) > 1600 * 900 * 0.32) return null;
  return {x: left, y: top, w: right - left, h: bottom - top};
}

export function preferOriginalDecorationAssets(audit, {project, index} = {}) {
  if (!Array.isArray(audit)) return audit;
  const converted = [];
  const output = audit.map(element => {
    if (!isDecorationAsset(element)) return element;
    const sourceBox = sourceBoxOf(element);
    if (!sourceBox) return element;
    const next = {...element, type: 'cutout', sourceBox, nonFactual: true,
      x: sourceBox.x, y: sourceBox.y, w: sourceBox.w, h: sourceBox.h,
      role: element.role || 'effect',
      description: (element.description || element.key)
        + '（原件资产优先：从批准预览提取原始装饰，不重绘）',
      implementation: undefined, shape: undefined, shapeGeometry: undefined,
      customGeometry: undefined, adjustments: undefined, gradient: undefined,
      strokeGradient: undefined, fill: undefined, fillOpacity: undefined,
      color: undefined, colorOpacity: undefined, strokeWidth: undefined};
    converted.push({key: element.key, sourceBox, originalType: element.type});
    return next;
  });
  if (converted.length && project) {
    project._decorationAssetPriority = {...(project._decorationAssetPriority || {}), [index]: converted};
  }
  return output;
}
