// Measured-slant hypothesis only. This module never groups width/height/position/font/spacing.
// It is shared by S3 evidence (via constrained-fitting) and recognition fallback groups; the
// measured joint geometry itself is written by tools/constrained_shapes.py at the end of S3.
export const SLANT_GROUP_MAX_DELTA_DEGREES = 2;
import {parameterConfidence,weightedMedian} from './parameter-confidence.mjs';
import {lineCommands} from './line-path.mjs';

const clampAngle = value => Math.max(5, Math.min(85, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);

function parallelogramSlant(element) {
  const geometry = element?.shapeGeometry || {};
  if (String(element?.shape) !== 'parallelogram') return null;
  const angle=Number.isFinite(geometry.slantAngle)?geometry.slantAngle:geometry.headDepth>0&&element.w>0
    ?Math.atan2(element.h,geometry.headDepth*element.w)*180/Math.PI:null;
  if(!Number.isFinite(angle))return null;
  // A positive preset slant puts the upper vertex to the right of the lower
  // one. Use screen-space dx/dy, like lines and custom polygon edges.
  const depth=Math.min(.49,element.h/Math.tan(clampAngle(angle)*Math.PI/180)/element.w);
  return { family: 'parallelogram', angle: Math.atan2(element.h,depth*element.w)*180/Math.PI,
    sign: Number(geometry.slantSign) === -1 ? 1 : -1 };
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
  const commands=element.customGeometry?.commands;
  if(commands){
    const sides=[];let current,first;
    for(const command of commands){
      const end=command.points?.at(-1)||(command.op==='Z'?first:null);
      if(['L','Z'].includes(command.op)&&current&&end){
        const dx=(end[0]-current[0])*element.w,dy=(end[1]-current[1])*element.h;
        const angle=Math.atan2(Math.abs(dy),Math.abs(dx))*180/Math.PI;
        if(Math.abs(dy)>=element.h*.5&&angle>=5&&angle<=85)sides.push({angle,sign:dx*dy>0?1:-1});
      }
      if(command.op==='M')first=end;
      if(end)current=end;
    }
    return sides.length===2&&sides[0].sign===sides[1].sign&&Math.abs(sides[0].angle-sides[1].angle)<=.75
      ?{family:'parallelogram',angle:(sides[0].angle+sides[1].angle)/2,sign:sides[0].sign}:null;
  }
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
  if(slanted.length===2&&slanted[0].sign===slanted[1].sign&&Math.abs(slanted[0].angle-slanted[1].angle)<=.75)
    return {family:'parallelogram',angle:(slanted[0].angle+slanted[1].angle)/2,sign:slanted[0].sign};
  if (slanted.length !== 1) return null;
  return { family: 'trapezoid', angle: slanted[0].angle, sign: slanted[0].sign };
}

function lineSlant(element) {
  if (String(element?.type) !== 'line') return null;
  if(element.linePath&&!(element.linePath.commands?.length===2&&element.linePath.commands[1].op==='L'))return null;
  const width = Number(element.w), height = Number(element.h);
  if (!finite(width) || !finite(height) || width < 0 || height < 0) return null;
  const commands=lineCommands(element),a=commands[0].points[0],b=commands.at(-1).points.at(-1);
  const visualDx=(b[0]-a[0])*width,visualDy=(b[1]-a[1])*height;
  const angle = Math.atan2(Math.abs(visualDy),Math.abs(visualDx)) * 180 / Math.PI;
  const product = visualDx * visualDy;
  return { family: 'line', angle, sign: product === 0 ? 0 : product > 0 ? 1 : -1 };
}

export function measuredSlant(element) {
  return parallelogramSlant(element) || trapezoidSlant(element) || lineSlant(element);
}

export function slantAngleDelta(first, second) {
  if (!first || !second || first.sign !== second.sign ||first.sign===0&&first.family!==second.family) return Infinity;
  return Math.abs(first.angle - second.angle);
}

// Complete-link 1-D grouping: a window is accepted only when max-min <= threshold, which is
// equivalent to every pair being within the threshold. Opposite slope signs never mix.
export function groupMeasuredSlants(elements, { targetKeys = null, maxDelta = SLANT_GROUP_MAX_DELTA_DEGREES } = {}) {
  const targets = targetKeys ? new Set(targetKeys) : null;
  const candidates = (elements || []).map(element => ({ element, slant: measuredSlant(element) }))
    .filter(item => item.slant && (!targets || targets.has(item.element.key)))
    .sort((first, second) => first.slant.sign - second.slant.sign || first.slant.angle - second.slant.angle
      || String(first.element.key).localeCompare(String(second.element.key)));
  const groups = [];
  let index = 0;
  while (index < candidates.length) {
    const first = candidates[index];
    let end = index + 1;
    while (end < candidates.length) {
      const candidate = candidates[end];
      if (slantAngleDelta(candidate.slant,first.slant)===Infinity) break;
      if (candidate.slant.angle - first.slant.angle > maxDelta) break;
      end += 1;
    }
    const members = candidates.slice(index, end);
    if (members.length >= 2) {
      const angles = members.map(item => item.slant.angle);
      const family=new Set(members.map(item=>item.slant.family)).size===1?first.slant.family:'mixed';
      groups.push({
        id: 'slant-' + family + '-' + (first.slant.sign < 0 ? 'neg' : first.slant.sign > 0 ? 'pos' : 'axis')
          + '-' + Math.round(Math.min(...angles) * 10) + '-' + Math.round(Math.max(...angles) * 10),
        family,
        sign: first.slant.sign,
        angle: weightedMedian(members.map(item=>({value:item.slant.angle,weight:parameterConfidence(item.element,'slant')})))??null,
        maxDelta: Math.max(...angles) - Math.min(...angles),
        keys: members.map(item => item.element.key),
        evidence: 'measured-boundary-slant-within-' + maxDelta + 'deg',
      });
    }
    index = end;
  }
  return groups;
}
