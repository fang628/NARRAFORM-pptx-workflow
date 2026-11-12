// Committed-pipeline adapters for the 05 framework (S4 fill / S5 stroke / S6 merge).
// Real adapters around committed pieces:
//   S4/S5 -> python tools/paint_stage.py (shape_paint.fit_shape_paint + committed mapping)
//   S6    -> native-parameter-groups.normalizeNativeParameters (+ group-fit-evidence guard)
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativeSVG} from './visual-model.mjs';
import {Resvg} from '@resvg/resvg-js';
import JSZip from 'jszip';
import {normalizeNativeParameters} from './native-parameter-groups.mjs';
import {baseShapePoints} from './shape-geometry.mjs';
import {preparePaintContext,paintVisibilitySignature,paintCompositeSignature,paintSampleHash} from './paint-context.mjs';
import {arrangeScene} from './scene-hierarchy.mjs';
import {mergeMeasuredPaint} from './paint-consensus.mjs';
import {enforceTextPaintPolicy} from './text-style-policy.mjs';
import {normalizeNativeAppearance} from './native-appearance-policy.mjs';

const run = promisify(execFile);
const paintCache = new Map();
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])])):value;
const paintSignature=elements=>JSON.stringify(stable(elements.map(element=>[element.key,
  ...[...FILL_FIELDS,...STROKE_FIELDS].map(field=>element[field])])));
function measurementElements(context,originals=context.elements||[]){
  const known=new Set(originals.map(element=>element.key));
  return arrangeScene([...originals,...(context.paintOccluders||[]).filter(element=>!known.has(element.key))
    .map(element=>({...element,_stagedSkip:true}))]);
}

async function measurePaint(context) {
  const {env, project, index, preview, signal} = context;
  const elements=measurementElements(context);
  const directory = path.join(env.data, project.id, 'geometry-records', 'pipeline', 'page-' + (index + 1));
  fs.mkdirSync(directory, {recursive: true});
  const foundation = project.visualPages?.[index]?.foundation?.file;
  const background = foundation ? path.join(env.data, project.id, foundation) : null;
  const requestedTargets = context.targetKeys ? new Set(context.targetKeys) : null;
  const targets = (elements || []).filter(element => ['shape', 'rect', 'ellipse','line'].includes(element.type)
    && (element.elementPath || 'native') === 'native'
    && !element.managed && !element._stagedSkip
    && (!requestedTargets || requestedTargets.has(element.key))
    && !String(element.key || '').startsWith('nf-')).map(element => element.key);
  const placeholderBoxes = (project.visualPages?.[index]?.images || [])
    .map(image => image?.placeholderBox)
    .filter(Boolean);
  const inputSpec = {reference: preview, elements, targetKeys: targets, background,
    exclude: placeholderBoxes};
  const geometrySpec = {...inputSpec, elements: elements.map(element => {
    const geometry = {...element};
    for (const field of [...FILL_FIELDS, ...STROKE_FIELDS]) delete geometry[field];
    return geometry;
  })};
  const snapshotHash = crypto.createHash('sha256').update(JSON.stringify(stable(geometrySpec)));
  const algorithmBytes=[];
  for (const file of [preview, background, ...['paint_stage.py', 'shape_paint.py',
    'paint_models.py', 'shape_reference.py','native_effects.py'].map(name => path.join(env.root, 'tools', name)),
    ...['native-appearance-policy.mjs','visual-model.mjs','native-effects.mjs'].map(name=>path.join(env.root,'lib',name))]) {
    if (file) {const bytes = fs.readFileSync(file); algorithmBytes.push(bytes); snapshotHash.update(bytes);}
  }
  for(const element of elements)if(element.type==='image'){
    const file=env.getImage?.(project,element.id);if(file)snapshotHash.update(fs.readFileSync(file));
  }
  const snapshotKey = snapshotHash.digest('hex');
  const inputPaint=paintSignature(elements);
  if (context.paintState?.key === snapshotKey && context.paintState.expectedPaint===inputPaint) return context.paintState.rows;
  Object.assign(inputSpec,await preparePaintContext({env,project,index,preview,elements,background,signal}));
  if(context.paintState)context.paintState.visibleContext={signature:paintVisibilitySignature(elements),compositeSignature:paintCompositeSignature(elements),masks:inputSpec.masks,underlays:inputSpec.underlays};
  const inputJson=JSON.stringify(inputSpec,null,1);
  const hash=crypto.createHash('sha256').update(inputJson);
  for(const bytes of algorithmBytes)hash.update(bytes);
  const cacheHash = hash.digest('hex');
  const key = directory + '|' + cacheHash;
  if (paintCache.has(key)) {
    const cached = paintCache.get(key);
    if (context.paintState) Object.assign(context.paintState, cached, {key: snapshotKey});
    return cached.rows;
  }
  const measurementDirectory = path.join(directory, 'paint', cacheHash, crypto.randomUUID());
  fs.mkdirSync(measurementDirectory, {recursive: true});
  const input = path.join(measurementDirectory, 'input.json');
  const output = path.join(measurementDirectory, 'output.json');
  const cacheFile = path.join(directory, 'paint', cacheHash, 'measurement.json');
  inputSpec.samplesFile=path.join(measurementDirectory,'samples.npz');
  fs.writeFileSync(input, JSON.stringify(inputSpec));
  const python = process.env.PPT_AGENT_PYTHON
    || path.join(env.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let result = null;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached && cached.cacheHash === cacheHash) result = cached;
  } catch {}
  if (!result) {
    await (env.run||run)(python, [path.join(env.root, 'tools', 'paint_stage.py'), input, output],
      {cwd: env.root, windowsHide: true, timeout: 300000, signal});
    result = JSON.parse(fs.readFileSync(output, 'utf8'));
    const published = path.join(measurementDirectory, 'published.json');
    fs.writeFileSync(published, JSON.stringify({...result, cacheHash}, null, 1));
    try { fs.renameSync(published, cacheFile); } catch {}
  }
  const measurements = new Map((result.results || []).map(row => [row.key, row]));
  if(context.paintState&&result.samplesFile){
    const measured=elements.map(element=>({...element,...measurements.get(element.key)?.properties}));
    const signature=paintVisibilitySignature(elements);
    if(signature===paintVisibilitySignature(measured))context.paintState.sampleEvidence={signature,file:result.samplesFile,
      compositeSignature:paintCompositeSignature(elements),sourceHash:paintSampleHash(preview,inputSpec)};
    else delete context.paintState.sampleEvidence;
  }
  paintCache.set(key, {rows:measurements,visibleContext:context.paintState?.visibleContext,
    sampleEvidence:context.paintState?.sampleEvidence});
  if (context.paintState) Object.assign(context.paintState, {key: snapshotKey, rows: measurements});
  if (paintCache.size > 64) paintCache.delete(paintCache.keys().next().value);
  return measurements;
}

const FILL_FIELDS = ['fill', 'fillOpacity', 'gradient'];
const STROKE_FIELDS = ['strokeWidth', 'color', 'strokeGradient', 'lineEffect', 'colorOpacity','glow','shadow','nativeEffectEvidence'];

function measuredAdapter(fields) {
  return async (context) => {
    try {
      const measurements = await measurePaint(context);
      if (context.paintState) context.paintState.rows = measurements;
      let changed = 0;
      const elements = (context.elements || []).map(element => {
        // Table members get their fills from the S3 table step (tableFittedFill): painting them
        // again would sample text/neighbour pixels and undo the table's colour fitting.
        if (element.tableFittedFill&&fields===FILL_FIELDS) return element;
        const row = measurements.get(element.key);
        if (!row || !row.properties) return element;
        const patch = {};
        for (const [field, value] of Object.entries(row.properties)) {
          if (fields.includes(field) && value !== undefined) patch[field] = value === null ? undefined : value;
        }
        if (Object.keys(patch).length === 0) return element;
        changed += 1;
        return fields===STROKE_FIELDS?clampPaintParameters({...element,...patch}):{...element,...patch};
      });
      if(context.paintState)context.paintState.expectedPaint=paintSignature(measurementElements(context,elements));
      return {status: 'ok', elements, counts: {measured: measurements.size, changed, fields: fields.length}};
    } catch (error) {
      if (context.signal?.aborted) throw error;
      return {status: 'failed', elements: context.elements,
        error: String(error.message || error).slice(0, 300)};
    }
  };
}


function parseHex(value) {
  const text = String(value || '').replace(/^#/, '');
  if (text.length !== 6) return null;
  const number = Number.parseInt(text, 16);
  if (!Number.isFinite(number)) return null;
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function toHex(rgb) {
  return rgb.map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('');
}

function colorDistance(first, second) {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}


function clampPaintParameters(element) {
  // Measured gradients are already supported by DrawingML, regardless of object size.
  return normalizeNativeAppearance(element);
}

function similarColors(list, tolerance = 26) {
  for (let i = 1; i < list.length; i += 1) if (colorDistance(list[0], list[i]) > tolerance) return false;
  return true;
}

function medianRgb(list) {
  return [0, 1, 2].map(channel => list.map(rgb => rgb[channel]).sort((a, b) => a - b)[Math.floor(list.length / 2)]);
}

function medianNumbers(list) {
  return [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
}

// Parameter-level merge for same-layout colour blocks: shared slant / corner presence / radius and
// (when clearly consistent) shared fill and stroke values. Size, position and layout stay individual.
export function mergeGroupParameters(elements) {
  const paramLocked = (element, parameter) => Array.isArray(element?.keepParameters)
    && element.keepParameters.some(name => String(name) === parameter
      || String(parameter).startsWith(String(name)) || String(name).startsWith(String(parameter)));
  const shapes = (elements || []).filter(element => ['shape', 'rect', 'ellipse'].includes(element.type)
    && !element._stagedSkip && !element.managed && !element.tableId);
  const assigned = new Set();
  const groups = [];
  for (const anchor of shapes) {
    if (assigned.has(anchor.key)) continue;
    const group = [anchor];
    assigned.add(anchor.key);
    for (const candidate of shapes) {
      if (assigned.has(candidate.key)) continue;
      const sharedGroups = Object.keys(anchor.parameterGroups || {}).filter(parameter =>
        anchor.parameterGroups[parameter] && anchor.parameterGroups[parameter] === candidate.parameterGroups?.[parameter]);
      if (!sharedGroups.length || anchor.type !== candidate.type || anchor.shape !== candidate.shape) continue;
      const nested = (a, b) => a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
      if (nested(anchor, candidate) || nested(candidate, anchor)) continue;
      if (Math.abs(Number(anchor.strokeWidth || 0) - Number(candidate.strokeWidth || 0)) > 0.5) continue;
      const overlapY = Math.min(anchor.y + anchor.h, candidate.y + candidate.h) - Math.max(anchor.y, candidate.y);
      const overlapX = Math.min(anchor.x + anchor.w, candidate.x + candidate.w) - Math.max(anchor.x, candidate.x);
      const sameRow = overlapY >= 0.4 * Math.min(anchor.h, candidate.h);
      const sameColumn = overlapX >= 0.4 * Math.min(anchor.w, candidate.w);
      if (!sameRow && !sameColumn) continue;
      group.push(candidate);
      assigned.add(candidate.key);
    }
    if (group.length >= 2) groups.push(group);
  }
  const merged = new Map();
  for (const group of groups) {
    const headDepths = group.map(element => Number(element.shapeGeometry?.headDepth)).filter(Number.isFinite);
    const slantSigns = group.map(element => Number(element.shapeGeometry?.slantSign)).filter(Number.isFinite);
    const cornerProfiles = group.map(element => element.shapeGeometry?.corners).filter(Array.isArray);
    const adjustments = group.map(element => Number(element.adjustments?.adj)).filter(Number.isFinite);
    const fills = group.map(element => parseHex(element.fill)).filter(Boolean);
    const gradients = group.map(element => element.gradient).filter(Boolean);
    const strokeWidths = group.map(element => Number(element.strokeWidth)).filter(Number.isFinite);
    const strokeColors = group.map(element => parseHex(element.color)).filter(Boolean);
    const shared = {
      headDepth: headDepths.length >= 2 ? medianNumbers(headDepths) : null,
      slantSign: slantSigns.length >= 2 ? (slantSigns.filter(value => value >= 0).length >= slantSigns.length / 2 ? 1 : -1) : null,
      adjustmentsAdj: adjustments.length >= 2 ? Math.round(medianNumbers(adjustments)) : null,
      cornerSet: (() => {
        // Corner merge is mandatory for merged groups: even a single element with corner evidence
        // fixes the shared corner parameters for the whole group (missing corners default sharp).
        const sets = group.map(element => (Array.isArray(element.shapeGeometry?.corners)
          ? element.shapeGeometry.corners
          : Array.isArray(element.cornerInfo?.corners) ? element.cornerInfo.corners : null))
          .filter(Boolean);
        if (!sets.length) return null;
        const count = Math.max(4, ...sets.map(set => set.length));
        const merged = [];
        for (let cornerIndex = 0; cornerIndex < count; cornerIndex += 1) {
          const types = sets.map(set => String(set[cornerIndex]?.type || 'sharp'));
          const type = types.sort((a, b) => types.filter(value => value === b).length
            - types.filter(value => value === a).length)[0];
          const sizeKey = type === 'cut' ? 'cut' : 'radius';
          const sizes = sets.map(set => Number(set[cornerIndex]?.[sizeKey])).filter(Number.isFinite);
          merged.push({type, ...(sizes.length ? {[sizeKey]: medianNumbers(sizes)} : {})});
        }
        return merged;
      })(),
      fill: fills.length >= 2 && fills.length === group.length && similarColors(fills) ? toHex(medianRgb(fills)) : null,
      gradientAngle: (() => {
        if (gradients.length < 2 || gradients.length !== group.length) return null;
        if (gradients.some(gradient => gradient.type !== 'linear')) return null;
        const angles = gradients.map(gradient => Number(gradient.angle));
        if (angles.some(angle => !Number.isFinite(angle))) return null;
        return Math.max(...angles) - Math.min(...angles) <= 24 ? Math.round(medianNumbers(angles)) : null;
      })(),
      strokeWidth: strokeWidths.length >= 2 && strokeWidths.length === group.length ? medianNumbers(strokeWidths) : null,
      strokeColor: strokeColors.length >= 2 && strokeColors.length === group.length && similarColors(strokeColors)
        ? toHex(medianRgb(strokeColors)) : null,
    };
    const shares = parameter => group[0].parameterGroups?.[parameter]
      && group.every(element => element.parameterGroups?.[parameter] === group[0].parameterGroups[parameter]);
    if (!shares('slant')) {shared.headDepth = null; shared.slantSign = null; shared.adjustmentsAdj = null;}
    if (!shares('corners')) shared.cornerSet = null;
    if (!shares('fill')) shared.fill = null;
    if (!shares('gradientAngle')) shared.gradientAngle = null;
    if (!shares('strokeWidth') && !shares('stroke')) shared.strokeWidth = null;
    if (!shares('strokeColor') && !shares('stroke')) shared.strokeColor = null;
    for (const element of group) {
      const params = {shape: [], fill: [], stroke: []};
      const patch = {};
      if (shared.headDepth != null) { patch.headDepth = shared.headDepth; params.shape.push('headDepth');
        patch.shapeGeometry = {...(element.shapeGeometry || {}), headDepth: shared.headDepth}; }
      if (shared.slantSign != null) { patch.slantSign = shared.slantSign; params.shape.push('slantSign');
        patch.shapeGeometry = {...(patch.shapeGeometry || element.shapeGeometry || {}), slantSign: shared.slantSign}; }
      if (shared.adjustmentsAdj != null) { patch.adjustments = {...(element.adjustments || {}), adj: shared.adjustmentsAdj};
        params.shape.push('adjustments.adj'); }
      if (Array.isArray(shared.cornerSet) && !paramLocked(element, 'corners')) {
        // Per-corner parameters are only valid when their count matches the preset's base
        // vertices (rect/roundRect/parallelogram/trapezoid = 4; hexagon/chevron/arrows != 4).
        const shapeName = String(element.shape || '');
        let baseLength = null;
        try {
          const basePoints = baseShapePoints(element);
          baseLength = Array.isArray(basePoints) ? basePoints.length : null;
        } catch {}
        const currentCorners = Array.isArray(element.shapeGeometry?.corners)
          ? element.shapeGeometry.corners : null;
        const cornersWriteable = shapeName !== 'freeform' && baseLength === shared.cornerSet.length
          && (currentCorners == null || currentCorners.length === baseLength)
          && (element.type === 'rect' || element.type === 'shape');
        if (cornersWriteable) {
          patch.shapeGeometry = {...(patch.shapeGeometry || element.shapeGeometry || {version: 2}),
            corners: shared.cornerSet};
        }
        patch.cornerInfo = {...(element.cornerInfo || {}), corners: shared.cornerSet,
          mergedFromGroup: true};
        params.shape.push('cornerType');
        if (shared.cornerSet.some(corner => Number(corner.radius) > 0)) params.shape.push('cornerRadius');
        if (shared.cornerSet.some(corner => Number(corner.cut) > 0)) params.shape.push('cornerCut');
      }
      if (shared.fill && !paramLocked(element, 'fill')) { patch.fill = shared.fill; params.fill.push('fill'); }
      if (shared.gradientAngle != null && !paramLocked(element, 'fill')) {
        patch.gradient = {...(element.gradient || {}), angle: shared.gradientAngle};
        params.fill.push('gradient.angle'); }
      if (shared.strokeWidth != null && !paramLocked(element, 'strokeWidth')) {
        patch.strokeWidth = shared.strokeWidth; params.stroke.push('strokeWidth'); }
      if (shared.strokeColor && !paramLocked(element, 'strokeColor')) {
        patch.color = shared.strokeColor; params.stroke.push('color'); }
      const mergedParams = [params.shape, params.fill, params.stroke].flat();
      if (!mergedParams.length) continue;
      const next = {...element, ...patch, groupMergedParams: mergedParams};
      merged.set(element.key, next);
    }
  }
  return (elements || []).map(element => merged.get(element.key) || element);
}

export const fillAdapter = measuredAdapter(FILL_FIELDS);
export const strokeAdapter = measuredAdapter(STROKE_FIELDS);


// Convert staged fitting's shape vocabulary into the production renderer's vocabulary
// (native-shapes/nativeShapeGeometry only understands a fixed preset list plus version-2
// shapeGeometry). Applied right after the staged S2-S6 fitting, before rendering.
export function normalizeStagedForRenderer(elements) {
  const round = radius => ({version: 2, corners: [{type: 'round', radius}, {type: 'round', radius},
    {type: 'round', radius}, {type: 'round', radius}]});
  const sharp = () => ({version: 2, corners: [{type: 'sharp'}, {type: 'sharp'},
    {type: 'sharp'}, {type: 'sharp'}]});
  const allowedContourKinds = ['arrow', 'hexagon', 'parallelogram', 'other'];
  const stripIllegalAdjustments = element => {
    // PowerPoint rejects `adj` on presets that do not consume it (ellipse, halo, freeform...).
    // Keep it only for the preset families that legitimately use a single adj value.
    if (!element.adjustments) return element;
    if (element.type === 'shape' && ['hexagon', 'chevron'].includes(String(element.shape))) return element;
    const cleaned = {...element.adjustments};
    delete cleaned.adj;
    const next = {...element, adjustments: Object.keys(cleaned).length ? cleaned : undefined};
    if (!next.adjustments) delete next.adjustments;
    return next;
  };
  return (elements || []).map(element => {
    if (element && element._stagedSkip) return stripIllegalAdjustments({...element});
    const sanitized = stripIllegalAdjustments({...(element || {})});
    if (sanitized.adjustments && !['hexagon', 'chevron'].includes(String(sanitized.shape))) {
      const cleaned = {...sanitized.adjustments};
      delete cleaned.adj;
      sanitized.adjustments = Object.keys(cleaned).length ? cleaned : undefined;
    }
    if (sanitized.contourKind !== undefined && !allowedContourKinds.includes(sanitized.contourKind)) {
      const shapeName = String(sanitized.shape || '');
      sanitized.contourKind = shapeName === 'parallelogram' ? 'parallelogram'
        : shapeName === 'hexagon' ? 'hexagon'
        : ['rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'chevron', 'triangle', 'diamond']
          .includes(shapeName) ? 'arrow' : 'other';
    }
    if (!['shape', 'rect', 'ellipse'].includes(sanitized.type)) return sanitized;
    const out = sanitized;
    const name = String(out.shape || '').toLowerCase();
    if (out.type === 'ellipse' || name === 'circle' || name === 'ellipse') {
      out.type = 'ellipse';
      delete out.shape;
      delete out.shapeGeometry;
      delete out.customGeometry;
      return out;
    }
    if (name === 'roundpanel' || name === 'roundrect' || name === 'cutpanel') {
      out.shape = 'roundRect';
      out.type = 'shape';
      out.shapeGeometry = out.shapeGeometry?.version === 2 ? out.shapeGeometry : round(0.035);
      delete out.customGeometry;
      return out;
    }
    if (name === 'rect-sharp' || name === 'seed-box' || name === 'seed-round' || name === 'box'
      || name === 'fill-panel' || name === 'rect') {
      out.type = 'rect';
      delete out.shape;
      delete out.customGeometry;
      return out;
    }
    if (name === 'pill') {
      out.shape = 'rect';
      out.shapeGeometry = round(0.5);
      delete out.customGeometry;
      return out;
    }
    if (name === 'pill') {
      out.type = 'shape';
      out.shape = 'roundRect';
      out.shapeGeometry = round(0.5);
      delete out.customGeometry;
      return out;
    }
    if (name === 'freeform') {
      // Slanted card/panel outlines stay freeform custom geometry. The earlier PowerPoint
      // corruption was caused by illegal `adjustments`, not by custom geometry, so it is safe now
      // (and required for preview similarity) to keep the measured outline.
      if (out.customGeometry?.points || out.customGeometry?.commands) {
        out.type = 'shape';
        out.shape = 'freeform';
        return out;
      }
      out.type = 'rect';
      delete out.shape;
      delete out.customGeometry;
      return out;
    }
    if (name === 'parallelogram-sharp' || name === 'parallelogram') {
      out.shape = 'parallelogram';
      delete out.customGeometry;
      return out;
    }
    if (['trapezoid', 'hexagon', 'chevron', 'triangle', 'diamond', 'pentagon', 'rightArrow',
      'leftArrow', 'upArrow', 'downArrow'].includes(name)) {
      out.shape = name;
      // S3 can encode a point-up hexagon as a measured six-point native path.
      // Retain that contour instead of silently restoring the preset direction.
      if(!out.customGeometry?.points&&!out.customGeometry?.commands)delete out.customGeometry;
      return out;
    }
    // Sanitize directional-metadata so committed validators accept staged elements.
    const allowedContour = ['arrow', 'hexagon', 'parallelogram', 'other'];
    if (out.contourKind !== undefined && !allowedContour.includes(out.contourKind)) {
      out.contourKind = out.shape === 'parallelogram' ? 'parallelogram'
        : out.shape === 'hexagon' ? 'hexagon'
        : ['rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'chevron', 'triangle', 'diamond']
          .includes(out.shape) ? 'arrow' : 'other';
    }
    return out;
  }).map(clampPaintParameters);
}

export const mergeAdapter = async (context) => {
  try {
    const beforeAll = context.elements || [];
    const skipped = new Map(beforeAll.filter(element => element._stagedSkip).map(element => [element.key, element]));
    const before = beforeAll.filter(element => !element._stagedSkip);
    // S4/S5 measured paint is authoritative: load its rows and lock fill-class parameter groups.
    const paintRows = context.paintState?.rows || new Map();
    const normalized = normalizeNativeParameters(before, {paintLocked: true, explicitOnly: true,
      targetKeys:context.targetKeys,measuredGeometryLocked:true});
    const after = normalized.elements || normalized;
    const decisions = normalized.decisions || [];
    // No measured proposal is supplied at this boundary. Geometry is already locked; never
    // roll back an entire object because one independently owned parameter was rejected.
    const merged = after;
    // Forced project-wide title style: font face, colour fill and shadow must be identical on
    // every page (the project already carries the committed title style).
    const project = context.project || {};
    const titleFont = project.rebuildTitleFont || null;
    const titleAppearance = project.rebuildTitleAppearance || null;
    const titleColor = project.rebuildContentTitleColor
      || (titleAppearance && titleAppearance.color) || null;
    // Only the page main title joins the forced font/colour/shadow merge. Subtitles and section
    // sub-headings keep their own audited styling (they are often deliberately different).
    const isTitle = (element) => {
      const role = String(element.role || '').toLowerCase();
      const key = String(element.key || '').toLowerCase();
      const nodeId = String(element.nodeId || '').toLowerCase();
      const secondary = /subtitle|sub-?title|heading|subhead|小标题/.test(key + ' ' + nodeId);
      if (secondary) return false;
      if (role === 'heading' || role === 'subtitle' || role === 'page-subtitle') return false;
      return role === 'title' || role === 'page-title' || key === 'title' || nodeId === 'title'
        || /^title([-_]|$)/.test(key);
    };
    const forced = merged.map(element => {
      if (element.type !== 'text' || !isTitle(element)) return element;
      const patch = {};
      if (titleFont) {
        if (titleFont.fontFace || titleFont.family) patch.fontFace = titleFont.fontFace || titleFont.family;
        if (titleFont.bold != null) patch.bold = Boolean(titleFont.bold);
        if (titleFont.italic != null) patch.italic = Boolean(titleFont.italic);
      }
      const resolveTitlePaint = (value) => {
        if (typeof value === 'string') return {color: value};
        if (value && typeof value === 'object') {
          const paint = value.paint || {};
          const gradient = paint.gradient ? {
            angle: paint.gradient.angle ?? 90,
            vertical: true,
            stops: (paint.gradient.stops || []).map(stop => ({
              offset: stop.position ?? stop.offset ?? 0, color: stop.color})),
          } : undefined;
          return {color: paint.color || value.color, gradient};
        }
        return {};
      };
      if (titleColor&&!element.textPaintMeasured) {
        const resolved = resolveTitlePaint(titleColor);
        if (resolved.color) patch.color = resolved.color;
        if (resolved.gradient) patch.textGradient = resolved.gradient;
        else{patch.gradient=undefined;patch.textGradient=undefined;}
      }
      if (titleAppearance) {
        if (titleAppearance.shadow != null) patch.shadow = titleAppearance.shadow;
        if (titleAppearance.shadowColor) patch.shadowColor = titleAppearance.shadowColor;
        if (titleAppearance.shadowBlur != null) patch.shadowBlur = titleAppearance.shadowBlur;
        if (titleAppearance.shadowOffsetX != null) patch.shadowOffsetX = titleAppearance.shadowOffsetX;
        if (titleAppearance.shadowOffsetY != null) patch.shadowOffsetY = titleAppearance.shadowOffsetY;
      }
      return enforceTextPaintPolicy(Object.keys(patch).length ? {...element, ...patch, titleStyleForced: true} : element);
    });
    // S3 owns geometry. S6 never borrows sibling widths/heights or repositions weak objects.
    const remediated=forced;
    const withSkipped = beforeAll.map(element => skipped.get(element.key) || remediated.find(item => item.key === element.key) || element);
    const withGroups = withSkipped;
    const withTheme = withGroups;
    // Final consistency guard: re-apply the measured fill/gradient after every merge step so a
    // later group/normalization pass can never repaint a measured block.
    let fillLocked = 0;
    const guarded = withTheme.map(element => {
      if (element.tableFittedFill || element._stagedSkip) return element;
      const properties = paintRows.get(element.key);
      if (!properties?.properties) return element;
      const patch = {};
      if (properties.properties.fill !== undefined) patch.fill = properties.properties.fill;
      if (properties.properties.gradient !== undefined) patch.gradient = properties.properties.gradient;
      if (properties.properties.fillOpacity !== undefined) patch.fillOpacity = properties.properties.fillOpacity;
      if (!Object.keys(patch).length) return element;
      fillLocked += 1;
      return clampPaintParameters({...element, ...patch, fillSource: 'S4S5-measured'});
    });
    let finalRejected = 0;
    const finalElements = guarded.map(element => {
      const original = beforeAll.find(previous => previous.key === element.key);
      if (original?._stagedSkip) return original;
      if (!original?.geometryEvidence?.accepted) return element;
      const next = {...element};
      // Independent contour measurements take precedence over shared-parameter guesses.
      for (const field of ['x', 'y', 'w', 'h', 'shape', 'shapeGeometry', 'customGeometry', 'adjustments']) {
        if (JSON.stringify(next[field]) !== JSON.stringify(original[field])) {
          next[field] = original[field]; finalRejected += 1;
        }
      }
      return next;
    });
    const consensus=await mergeMeasuredPaint({...context,elements:finalElements});
    const targets=context.targetKeys==null?null:new Set(context.targetKeys);
    return {status: 'ok', elements: consensus.elements.map((element,index)=>targets&&!targets.has(element.key)?beforeAll[index]:normalizeInertPaint(element)),
      counts: {input: before.length, normalized: decisions.length, contradictions: 0,
        titleStyleForced: forced.filter(element => element.titleStyleForced).length,
        lowConfidenceRemediated: remediated.filter(element => element.groupMergedFrom).length,
        measuredCarriersPreserved: beforeAll.length - before.length,
        groupParameterMerged: withGroups.filter(element => (element.groupMergedParams || []).length).length,
        themeFillMerged: withTheme.filter(element => element.themeFillMerged).length,
        fillLocked, finalRejected,paintGroups:consensus.records.filter(row=>row.kind==='whole-paint').length,
        colourNodeGroups:consensus.records.filter(row=>row.kind==='colour-node').length},
      report:[...decisions.slice(0,200),...consensus.records]};
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return {status: 'failed', elements: context.elements, error: String(error.message || error).slice(0, 300)};
  }
};


// Preserve measured paint; only mark table-owned fills so later refinement respects them.
export function finalizeElements(elements) {
  return (elements || []).map(element => {
    let next = clampPaintParameters(element);
    const key = String(next.key || '');
    // Explicit table marks (or unambiguous table-structure keys) only: on mixed pages a normal
    // text-section header band must keep participating in theme/paint merging.
    const tableFamily = (next.tablePlaced || next._tableStage || next.tableId
      || /^(table|vline|hline|-generated-\d+)|table-(header|base|panel|frame|row)|table-row|table-vline|table-hline/i.test(key))
      && ['shape', 'rect', 'line'].includes(next.type);
    if (tableFamily) {
      next = {...next, keepParameters: [...new Set([...(next.keepParameters || []),
        'fill', 'gradientStops', 'gradientAngle', 'gradientCenter'])]};
    }
    return normalizeInertPaint(next);
  });
}

export function normalizeInertPaint(element){
  if(!['rect','shape','ellipse'].includes(element.type)||element.strokeWidth!==0)return element;
  const next={...element,color:element.fill||'000000'};
  delete next.strokeGradient;delete next.colorOpacity;
  return next;
}

// ------------------------------------------------------------------ S7 assemble
// Mirrors the committed assembly step: render the native SVG scene (native shapes + text +
// registered images + wordless background) exactly like `nativeSVG()` in visual-model.mjs.
function dataURL(file) {
  const bytes = fs.readFileSync(file);
  const mime = file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
  return 'data:' + mime + ';base64,' + bytes.toString('base64');
}

function assetResolver(context) {
  const {env, project} = context;
  const assets = path.join(env.data, project.id, 'assets');
  return (id) => {
    if (typeof env.getImage === 'function') {
      const file = env.getImage(project, id);
      if (file && fs.existsSync(file)) return dataURL(file);
    }
    for (const name of [id + '.png', id + '.jpg', id + '.jpeg', id + '.svg']) {
      const file = path.join(assets, name);
      if (fs.existsSync(file)) return dataURL(file);
    }
    return 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString('base64');
  };
}


// S5b detected different-coloured runs inside one text element (e.g. one highlighted line).
// Split multi-line text into per-colour text groups so the assembled page actually renders the
// measured run colours (native text is single-colour per element).
function expandTextColourRuns(elements) {
  const output = [];
  for (const element of elements || []) {
    const runs = element.textColorRuns;
    const text = element.text;
    if (element.type !== 'text' || !Array.isArray(runs) || !runs.length || typeof text !== 'string') {
      output.push(element);
      continue;
    }
    const lines = text.split('\n');
    const height = Number(element.h || 0);
    const lineHeight = height / lines.length;
    const hasSpans = runs.some(run => Array.isArray(run.lineSpans) && run.lineSpans.length);
    if (!hasSpans && lines.length < 2) { output.push(element); continue; }
    if (!hasSpans) {
      // line-level colours only
      const colorAt = (index) => {
        const middle = (index + 0.5) / lines.length;
        const run = runs.find(row => middle >= Number(row.startLine) - 1e-6
          && middle <= Number(row.endLine) + 1e-6);
        return (run && run.color) || element.color;
      };
      const groups = [];
      lines.forEach((line, index) => {
        const color = colorAt(index);
        const last = groups[groups.length - 1];
        if (last && last.color === color) last.lines.push(line);
        else groups.push({color, lines: [line]});
      });
      if (groups.length === 1) { output.push(element); continue; }
      let offset = 0;
      for (const group of groups) {
        output.push({...element, text: group.lines.join('\n'), color: group.color,
          y: Math.round(Number(element.y || 0) + lineHeight * offset),
          h: Math.round(lineHeight * group.lines.length), textColorRuns: undefined});
        offset += group.lines.length;
      }
      continue;
    }
    // intra-line runs: split every line by the measured horizontal spans
    lines.forEach((line, lineIndex) => {
      const length = Math.max(1, line.length);
      const spans = runs.flatMap(run => (run.lineSpans || [])
        .filter(span => Number(span.lineIndex) === lineIndex)
        .map(span => ({...span, color: run.color})))
        .sort((a, b) => Number(a.startFraction) - Number(b.startFraction));
      const segments = [];
      let cursor = 0;
      for (const span of spans) {
        const startChar = Math.min(length, Math.max(cursor, Math.round(Number(span.startFraction) * length)));
        const endChar = Math.min(length, Math.max(startChar + 1, Math.round(Number(span.endFraction) * length)));
        if (startChar > cursor) segments.push({start: cursor, end: startChar, color: element.color});
        segments.push({start: startChar, end: endChar, color: span.color});
        cursor = Math.max(cursor, endChar);
      }
      if (cursor < length) segments.push({start: cursor, end: length, color: element.color});
      if (segments.length <= 1) {
        output.push({...element, text: line, color: element.color,
          y: Math.round(Number(element.y || 0) + lineHeight * lineIndex),
          h: Math.round(lineHeight * lines.length > 0 ? lineHeight : element.h), textColorRuns: undefined});
        return;
      }
      for (const segment of segments) {
        output.push({...element,
          text: line.slice(segment.start, segment.end),
          color: segment.color,
          x: Math.round(Number(element.x || 0) + (segment.start / length) * Number(element.w || 0)),
          y: Math.round(Number(element.y || 0) + lineHeight * lineIndex),
          w: Math.max(4, Math.round(((segment.end - segment.start) / length) * Number(element.w || 0))),
          h: Math.round(lineHeight),
          textColorRuns: undefined});
      }
    });
  }
  return output;
}

export async function assembleAdapter(context) {
  try {
    const {env, project, index, elements} = context;
    const directory = path.join(env.data, project.id, 'geometry-records', 'pipeline', 'page-' + (index + 1));
    fs.mkdirSync(directory, {recursive: true});
    const foundation = project.visualPages?.[index]?.foundation;
    const background = foundation?.materialId ? {id: foundation.materialId} : null;
    // Navigation / progress bar is program-inserted exactly like the committed pipeline:
    // take the managed progress elements from the committed reconstruction and render them
    // on top of the audited page elements (never audited or shape-fitted).
    const committed = project.reconstruction?.slides?.[index]?.elements || [];
    const chrome = committed.filter(element => element.role === 'navigation' || element.managed === 'progress');
    const assembledElements = chrome.length
      ? [...elements.filter(element => element.role !== 'navigation' && element.managed !== 'progress'), ...chrome]
      : elements;
    const svg = nativeSVG(assembledElements, assetResolver(context), background);
    const svgFile = path.join(directory, 'S7-assemble.svg');
    fs.writeFileSync(svgFile, svg);
    const png = new Resvg(svg, {fitTo: {mode: 'width', value: 1920}}).render().asPng();
    const pngFile = path.join(directory, 'S7-assemble.png');
    fs.writeFileSync(pngFile, png);
    context._assembled = {svg: svgFile, png: pngFile};
    return {status: 'ok', elements, artifacts: {svg: svgFile, png: pngFile},
      counts: {elements: elements.length, navigation: chrome.length}};
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return {status: 'failed', elements: context.elements, error: String(error.message || error).slice(0, 400)};
  }
}

// ------------------------------------------------------------------ S8 review
// Mirrors the committed review step: compare the assembled page with the approved preview and
// report quality issues; failures keep the previous page (elements untouched).
export async function reviewAdapter(context) {
  try {
    const {env, project, index, preview} = context;
    const directory = path.join(env.data, project.id, 'geometry-records', 'pipeline', 'page-' + (index + 1));
    const rendered = context._assembled?.png || path.join(directory, 'S7-assemble.png');
    if (!fs.existsSync(rendered)) return {status: 'skipped', elements: context.elements, reason: 'no-rendered-page'};
    const output = path.join(directory, 'S8-review.json');
    const python = process.env.PPT_AGENT_PYTHON
      || path.join(env.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    await run(python, [path.join(env.root, 'tools', 'page_diff.py'), preview, rendered, output],
      {cwd: env.root, windowsHide: true, timeout: 120000, signal: context.signal});
    const quality = JSON.parse(fs.readFileSync(output, 'utf8'));
    // S8 refinement: low-confidence geometries get a small local translation estimated from the
    // rendered page vs the approved preview (phase correlation inside the element box).
    let elements = context.elements;
    let refined = [];
    const lowConfidence = (elements || []).filter(element => element.lowConfidenceGeometry
      && element.type !== 'text' && Number(element.w) > 12 && Number(element.h) > 12);
    if (lowConfidence.length) {
      try {
        const refineInput = path.join(directory, 'S8-refine-input.json');
        const refineOutput = path.join(directory, 'S8-refine.json');
        fs.writeFileSync(refineInput, JSON.stringify({pageWidth: 1600, pageHeight: 900,
          elements: lowConfidence}, null, 1));
        await run(python, [path.join(env.root, 'tools', 'element_refine.py'), rendered, preview,
          refineInput, refineOutput], {cwd: env.root, windowsHide: true, timeout: 120000,
          signal: context.signal});
        const measured = JSON.parse(fs.readFileSync(refineOutput, 'utf8'));
        const offsets = new Map((measured.results || []).map(row => [row.key, row]));
        refined = [...offsets.values()];
        elements = elements.map(element => {
          const offset = offsets.get(element.key);
          if (!offset) return element;
          const dx = Math.max(-10, Math.min(10, Number(offset.dx) || 0));
          const dy = Math.max(-10, Math.min(10, Number(offset.dy) || 0));
          return {...element, x: Math.round(Number(element.x) + dx),
            y: Math.round(Number(element.y) + dy), refinedByS8: true,
            s8Offset: {dx: Math.round(dx * 10) / 10, dy: Math.round(dy * 10) / 10}};
        });
      } catch {}
    }
    return {status: 'ok', elements, counts: {...quality, refined: refined.length,
      lowConfidenceCandidates: lowConfidence.length},
      report: [quality, {refined}], artifacts: {review: output}};
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return {status: 'failed', elements: context.elements, error: String(error.message || error).slice(0, 300)};
  }
}

// ------------------------------------------------------------------ S9 deliver
// Mirrors the committed delivery step at page scope: package the assembled page, elements and
// review into a delivery bundle (the committed deck build plugs in through the same adapter).
export async function deliverAdapter(context) {
  try {
    const {env, project, index} = context;
    const directory = path.join(env.data, project.id, 'geometry-records', 'pipeline', 'page-' + (index + 1));
    const delivery = path.join(env.data, project.id, 'delivery');
    fs.mkdirSync(delivery, {recursive: true});
    const zip = new JSZip();
    for (const name of ['S7-assemble.svg', 'S7-assemble.png', 'S8-review.json', 'pipeline-result.json']) {
      const file = path.join(directory, name);
      if (fs.existsSync(file)) zip.file(name, fs.readFileSync(file));
    }
    zip.file('elements.json', JSON.stringify(context.elements, null, 1));
    const bytes = await zip.generateAsync({type: 'nodebuffer'});
    const zipFile = path.join(delivery, 'rebuild-page-' + (index + 1) + '.zip');
    fs.writeFileSync(zipFile, bytes);
    return {status: 'ok', elements: context.elements, artifacts: {zip: zipFile},
      counts: {bytes: bytes.length}};
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return {status: 'failed', elements: context.elements, error: String(error.message || error).slice(0, 300)};
  }
}
