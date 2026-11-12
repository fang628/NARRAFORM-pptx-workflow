// Measured-slant hypothesis only. This module never groups width/height/position/font/spacing.
// It is shared by S3 evidence (via constrained-fitting) and recognition fallback groups; the
// measured joint geometry itself is written by tools/constrained_shapes.py at the end of S3.
export const SLANT_GROUP_MAX_DELTA_DEGREES = 2;

const clampAngle = value => Math.max(5, Math.min(85, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);

function parallelogramSlant(element) {
  const geometry = element?.shapeGeometry || {};
  if (String(element?.shape) !== 'parallelogram') return null;
  const angle=Number.isFinite(geometry.slantAngle)?geometry.slantAngle:geometry.headDepth>0&&element.w>0
    ?Math.atan2(element.h,geometry.headDepth*element.w)*180/Math.PI:null;
  if(!Number.isFinite(angle))return null;
  return { family: 'parallelogram', angle: clampAngle(angle),
    sign: Number(geometry.slantSign) === -1 ? -1 : 1 };
}

function quadrilateralPoints(element) {
  const points = element?.customGeometry?.points;
  if (!Array.isArray(points) || points.length !== 4) return null;
  if (!points.every(point => Array.isArray(point) && point.length === 2
    && finite(Number(point[0])) && finite(Number(point[1])))) return null;
  return points.map(point => [Number(point[0]), Number(point[1])]);
}

function trapezoidSlant(element) {
  if (String(element?.shape) !== 'trapezoid' && String(element?.shape) !== 'freeform') return null;
  if(element.shape==='trapezoid'&&!element.customGeometry&&Number.isFinite(element.shapeGeometry?.slantAngle))return {family:'trapezoid',angle:element.shapeGeometry.slantAngle,sign:0};
  const points = quadrilateralPoints(element);
  if (!points) return null;
  const width = Number(element.w), height = Number(element.h);
  if (!(width > 0) || !(height > 0)) return null;
  const slanted = [];
  for (let index = 0; index < 4; index += 1) {
    const first = points[index], second = points[(index + 1) % 4];
    const dx = Math.abs(second[0] - first[0]) * width;
    const dy = Math.abs(second[1] - first[1]) * height;
    if (dy < 2 || dx < 1) continue;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    if (angle < 5 || angle > 85) continue;
    const upper = first[1] <= second[1] ? first : second;
    const lower = first[1] <= second[1] ? second : first;
    const sign = (lower[0] - upper[0]) >= 0 ? 1 : -1;
    slanted.push({ angle, sign });
  }
  if (slanted.length !== 1) return null;
  return { family: 'trapezoid', angle: slanted[0].angle, sign: slanted[0].sign };
}

function lineSlant(element) {
  if (String(element?.type) !== 'line') return null;
  const width = Number(element.w), height = Number(element.h);
  if (!finite(width) || !finite(height) || width < 0 || height < 0) return null;
  const angle = Math.atan2(height, width) * 180 / Math.PI;
  const visualDx = element.flipH ? -width : width;
  const visualDy = element.flipV ? -height : height;
  const product = visualDx * visualDy;
  return { family: 'line', angle, sign: product === 0 ? 0 : product > 0 ? 1 : -1 };
}

export function measuredSlant(element) {
  return parallelogramSlant(element) || trapezoidSlant(element) || lineSlant(element);
}

export function slantAngleDelta(first, second) {
  if (!first || !second || first.family !== second.family || first.sign !== second.sign) return Infinity;
  return Math.abs(first.angle - second.angle);
}

// Complete-link 1-D grouping: a window is accepted only when max-min <= threshold, which is
// equivalent to every pair being within the threshold. Opposite slope signs never mix.
export function groupMeasuredSlants(elements, { targetKeys = null, maxDelta = SLANT_GROUP_MAX_DELTA_DEGREES } = {}) {
  const targets = targetKeys ? new Set(targetKeys) : null;
  const candidates = (elements || []).map(element => ({ element, slant: measuredSlant(element) }))
    .filter(item => item.slant && (!targets || targets.has(item.element.key)))
    .sort((first, second) => first.slant.family.localeCompare(second.slant.family)
      || first.slant.sign - second.slant.sign || first.slant.angle - second.slant.angle
      || String(first.element.key).localeCompare(String(second.element.key)));
  const groups = [];
  let index = 0;
  while (index < candidates.length) {
    const first = candidates[index];
    let end = index + 1;
    while (end < candidates.length) {
      const candidate = candidates[end];
      if (candidate.slant.family !== first.slant.family || candidate.slant.sign !== first.slant.sign) break;
      if (candidate.slant.angle - first.slant.angle > maxDelta) break;
      end += 1;
    }
    const members = candidates.slice(index, end);
    if (members.length >= 2) {
      const angles = members.map(item => item.slant.angle);
      groups.push({
        id: 'slant-' + first.slant.family + '-' + (first.slant.sign < 0 ? 'neg' : first.slant.sign > 0 ? 'pos' : 'axis')
          + '-' + Math.round(Math.min(...angles) * 10) + '-' + Math.round(Math.max(...angles) * 10),
        family: first.slant.family,
        sign: first.slant.sign,
        angle: angles.slice().sort((a, b) => a - b)[Math.floor(angles.length / 2)],
        maxDelta: Math.max(...angles) - Math.min(...angles),
        keys: members.map(item => item.element.key),
        evidence: 'measured-boundary-slant-within-' + maxDelta + 'deg',
      });
    }
    index = end;
  }
  return groups;
}
