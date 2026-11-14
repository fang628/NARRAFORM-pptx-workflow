// Committed-pipeline adapters for the 05 framework (S4 fill / S5 stroke / S6 merge).
// Real adapters around committed pieces:
//   S4/S5 -> python tools/paint_stage.py (shape_paint.fit_shape_paint + committed mapping)
//   S6    -> native-parameter-groups.normalizeNativeParameters (+ group-fit-evidence guard)
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {normalizeNativeParameters} from './native-parameter-groups.mjs';
import {preparePaintContext,paintVisibilitySignature,paintCompositeSignature,paintSampleHash} from './paint-context.mjs';
import {arrangeScene} from './scene-hierarchy.mjs';
import {mergeMeasuredPaint} from './paint-consensus.mjs';
import {enforceTextPaintPolicy} from './text-style-policy.mjs';
import {normalizeNativeAppearance} from './native-appearance-policy.mjs';
import {circleGroups} from './repeated-circles.mjs';
import {normalizeTableTypography} from './table-typography.mjs';
import {parameterKept} from './parameter-group-policy.mjs';
import {fitLinePaths} from './line-path-fitting.mjs';

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
  const inputSpec = {reference: preview, elements, circleGroups:circleGroups(elements),targetKeys: targets, background,
    exclude: placeholderBoxes};
  const geometrySpec = {...inputSpec, elements: elements.map(element => {
    const geometry = {...element};
    for (const field of [...FILL_FIELDS, ...STROKE_FIELDS]) delete geometry[field];
    return geometry;
  })};
  const snapshotHash = crypto.createHash('sha256').update(JSON.stringify(stable(geometrySpec)));
  const algorithmBytes=[];
  for (const file of [preview, background, ...['paint_stage.py', 'shape_paint.py',
    'paint_models.py', 'shape_reference.py','native_effects.py','line_path_fit.py','circle_paint.py','parameter_confidence.py','fill_end_alpha.py','frame_highlight.py'].map(name => path.join(env.root, 'tools', name)),
    ...['native-appearance-policy.mjs','visual-model.mjs','native-effects.mjs','line-style.mjs','parameter-confidence.mjs'].map(name=>path.join(env.root,'lib',name))]) {
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

const FILL_FIELDS = ['fill', 'fillOpacity', 'gradient','parameterEvidence','fillEndAlphaEvidence'];
const STROKE_FIELDS = ['strokeWidth', 'color', 'strokeGradient', 'colorOpacity','shadow','nativeEffectEvidence','beginArrowSize','endArrowSize','linePaintEvidence','parameterEvidence','fillEndAlphaEvidence'];

function measuredAdapter(fields) {
  return async (context) => {
    try {
      const measurements = await measurePaint(context);
      if (context.paintState) context.paintState.rows = measurements;
      let changed = 0;
      const targets=context.targetKeys==null?null:new Set(context.targetKeys);
      let elements = (context.elements || []).map(element => {
        if(targets&&!targets.has(element.key))return element;
        // Table members get their fills from the S3 table step (tableFittedFill): painting them
        // again would sample text/neighbour pixels and undo the table's colour fitting.
        if (element.tableFittedFill&&fields===FILL_FIELDS) return element;
        const row = measurements.get(element.key);
        if (!row || !row.properties) return element;
        const patch = {};
        for (const [field, value] of Object.entries(row.properties)) {
          const parameter=fields===FILL_FIELDS?'fill':'stroke';
          if(parameterKept(element.keepParameters,parameter))continue;
          if (fields.includes(field) && value !== undefined) patch[field] = field==='parameterEvidence'?{...element.parameterEvidence,...value}:value === null ? undefined : value;
        }
        if (Object.keys(patch).length === 0) return element;
        changed += 1;
        return fields===STROKE_FIELDS?clampPaintParameters({...element,...patch}):{...element,...patch};
      });
      if(fields===STROKE_FIELDS&&elements.some(e=>e.type==='line'&&!e.managed)){
        const paths=await fitLinePaths({...context,elements,styleOnly:true});
        changed+=paths.results.filter(r=>r.accepted&&Object.keys(r.style||{}).length).length;elements=paths.elements;
      }
      if(context.paintState)context.paintState.expectedPaint=paintSignature(measurementElements(context,elements));
      return {status: 'ok', elements, counts: {measured: measurements.size, changed, fields: fields.length}};
    } catch (error) {
      if (context.signal?.aborted) throw error;
      return {status: 'failed', elements: context.elements,
        error: String(error.message || error).slice(0, 300)};
    }
  };
}


function clampPaintParameters(element) {
  return normalizeNativeAppearance(element);
}

// Compatibility entry point; every caller uses the same parameter-specific evidence.
export function mergeGroupParameters(elements) {
  return normalizeNativeParameters(elements,{explicitOnly:true}).elements;
}

export const fillAdapter = measuredAdapter(FILL_FIELDS);
export const strokeAdapter = measuredAdapter(STROKE_FIELDS);


// Convert staged fitting's shape vocabulary into the production renderer's vocabulary
// (native-shapes/nativeShapeGeometry only understands a fixed preset list plus version-2
// shapeGeometry). Applied right after the staged S2-S6 fitting, before rendering.
export function normalizeStagedForRenderer(elements) {
  const round = radius => ({version: 2, corners: [{type: 'round', radius}, {type: 'round', radius},
    {type: 'round', radius}, {type: 'round', radius}]});
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
    // A committed path is already renderer-native. Legacy vocabulary aliases
    // must not erase it or add a second geometry/transform on top.
    if(out.customGeometry?.points||out.customGeometry?.commands){
      out.type='shape';
      if(!['hexagon','trapezoid','chevron'].includes(out.shape))out.shape='freeform';
      delete out.shapeGeometry;delete out.adjustments;
      return out;
    }
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
      if (element.tableFittedFill || element._stagedSkip || parameterKept(element.keepParameters,'fill')) return element;
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
    return {status: 'ok', elements: normalizeTableTypography(consensus.elements.map((element,index)=>targets&&!targets.has(element.key)?beforeAll[index]:normalizeInertPaint(element)),{targetKeys:context.targetKeys}).elements,
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
