// Stage adapters for the 05 rebuild pipeline framework.
// The framework itself is product-independent: committed pipeline functions are injected as
// adapters (register/fill/stroke/merge/assemble/review), so this file can be reused as-is.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assignRoutes, nativeRoute, validateRegistry} from './rebuild-contract.mjs';
import {annotateTableObjects} from './table-objects.mjs';
import {buildObjectMasks} from './object-masks.mjs';
import {normalizeTextPaint,anchorTextColorRuns,retainedTextColorRuns} from './styled-text.mjs';
import {mergeParallelTextAccents} from './text-accent-consensus.mjs';
import {fitConstrainedShapes} from './constrained-fitting.mjs';
import {arrangeScene} from './scene-hierarchy.mjs';
import {enforceTextPaintPolicy} from './text-style-policy.mjs';
import {fitTableRows} from './table-row-fitting.mjs';
import {routeLightBar} from './light-bars.mjs';
import {mergeSymmetricCorners} from './corner-symmetry.mjs';
import {normalizeRebuildProgress} from './rebuild-progress.mjs';
import {normalizeTableTypography} from './table-typography.mjs';
import {parameterKept} from './parameter-group-policy.mjs';
import {registerLocalComponents,placeLocalComponents} from './local-components.mjs';
import {nativeSVG} from './visual-model.mjs';
import {specialPageNativeOnly,normalizeSpecialPageElements} from './page-options.mjs';
import {renderSVG} from './render-pool.mjs';
import {fileDigest} from './file-digest.mjs';
import {relocateReferenceElements} from './reference-position.mjs';
import {fitLinePaths} from './line-path-fitting.mjs';
import {
  createShapeStageWorkspace, enhancedPreviewCache, enhancementTempPaths, publishEnhancement,
  readEnhancement, runShapeStageTool,
} from './shape-stage-workspace.mjs';

const run = promisify(execFile);

async function runPython({python, script, args, cwd, timeout = 600000, signal, executor=run}) {
  return executor(python, [script, ...args], {cwd, windowsHide: true, timeout, signal});
}

// ------------------------------------------------------------------ S2 补全
// Audited frames pass through. Only independent light effects are completed from pixels, and
// TOC/thanks pages are native-only: no light effect is completed or passed through as SVG.
export async function completeStage(context) {
  const {env, project, index, preview, signal} = context;
  const slide=project.slides?.[index];
  const nativeOnly=specialPageNativeOnly(slide,index,project.brief);
  // Locate registered objects before testing whether a light ridge is independent.
  const seeds=nativeOnly?normalizeSpecialPageElements(slide,index,context.elements||[],project.brief).elements:context.elements||[];
  const annotated=annotateTableObjects(seeds,{project,index});
  const foreground=annotated.elements.filter(e=>['text','formula','svg','image','cutout','rect','shape','ellipse','line'].includes(e.type)).map(e=>e.key);
  const located=await relocateReferenceElements({...context,elements:annotated.elements,targetKeys:context.targetKeys??foreground});
  const elements=located.elements;
  const foundation = project.visualPages?.[index]?.foundation?.file;
  const background = foundation ? path.join(env.data, project.id, foundation) : null;
  const directory = path.join(env.data, project.id, 'geometry-records', 'registration');
  fs.mkdirSync(directory, {recursive: true});
  const runDirectory = path.join(directory, 'page-' + (index + 1), crypto.randomUUID());
  fs.mkdirSync(runDirectory, {recursive: true});
  const input = path.join(runDirectory, 'input.json');
  const output = path.join(runDirectory, 'registry.json');
  const protectedChrome=normalizeRebuildProgress(project,index,elements).filter(e=>e.managed);
  const registrationSpec = {preview, background, elements,protected:protectedChrome,...(nativeOnly?{nativeOnly:true}:{})};
  const registrationJson = JSON.stringify(registrationSpec, null, 1);
  fs.writeFileSync(input, registrationJson);
  const registrationDigest = crypto.createHash('sha256').update(registrationJson)
    .update(fs.readFileSync(path.join(env.root, 'tools', 'shape_registration.py')))
    .update(fs.readFileSync(path.join(env.root, 'tools', 'arc_light_completion.py')));
  for (const file of [preview, background]) if (file) registrationDigest.update(fs.readFileSync(file));
  const registrationHash = registrationDigest
    .digest('hex').slice(0, 16);
  const registrationCache = path.join(directory, 'cache-' + registrationHash + '.json');
  const python = context.python || process.env.PPT_AGENT_PYTHON
    || path.join(env.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  try {
    let registration = null;
    if (fs.existsSync(registrationCache)) {
      try { registration = JSON.parse(fs.readFileSync(registrationCache, 'utf8')); } catch {}
    }
    if (!registration) {
      await runPython({python, script: path.join(env.root, 'tools', 'shape_registration.py'),
        args: [input, output], cwd: env.root, signal,executor:env.run||run});
      registration = JSON.parse(fs.readFileSync(output, 'utf8'));
      try { fs.writeFileSync(registrationCache, JSON.stringify(registration)); } catch {}
    }
    const registry = registration.registry;
    // Table identity is resolved before localization. New effects cannot become
    // table members, so no second discovery or swallowed association failure.
    // TOC/thanks never route native light bars into SVG and drop legacy auto effects.
    const finalElements=arrangeScene(nativeOnly?normalizeSpecialPageElements(slide,index,registry,project.brief).elements:registry.map(routeLightBar));
    const validation = validateRegistry(finalElements);
    return {status: validation.ok ? 'ok' : 'partial', elements: finalElements, targets: registration.targets,
      coverage: registration.coverage,
      counts: {...registration.counts, tableObjects: annotated.tableObjects.length},
      validation, artifacts: {input, output}};
  } catch (error) {
    if (signal?.aborted) throw error;
    return {status: 'skipped', elements, reason: 'registration-unavailable', error: String(error.message || error).slice(0, 300)};
  }
}

// ------------------------------------------------------------------ S2' 分流
export function routeStage(context) {
  const elements = assignRoutes(context.elements);
  const counts = elements.reduce((map, element) => {
    map[element.elementPath] = (map[element.elementPath] || 0) + 1;
    return map;
  }, {});
  return {status: 'ok', elements, counts};
}

// ------------------------------------------------------------------ S3 形状拟合
// Only native-route elements are fitted. The engine returns geometry; the gate keeps the
// original geometry whenever evidence/deformation bounds are not met (never worse).
export async function shapeStage(context) {
  // Visibility masks must use each foreground object's own preview position.
  // Fitting a carrier first let stale text masks hide its actual top/bottom.
  const positioned=context.shapeStageExec?{elements:context.elements,records:[]}:await relocateReferenceElements(context);
  const paths=context.shapeStageExec?{elements:context.elements,results:[]}:await fitLinePaths({...context,elements:positioned.elements});
  const fitted=await fitShapes({...context,elements:paths.elements});
  if(fitted.status==='failed'||context.shapeStageExec)return fitted;
  const joint=fitted.elements.some(e=>!e.managed&&(e.type==='line'||e.arrowTail||e.shape==='chevron'||e.shape==='hexagon'))?await fitLinePaths({...context,elements:fitted.elements,finalize:true}):{elements:fitted.elements,results:[],slantGroups:[]};
  return {...fitted,status:paths.results.length&&fitted.status==='skipped'?'ok':fitted.status,elements:joint.elements,report:[...joint.results,...joint.slantGroups,...(fitted.report||[]),...positioned.records.map(r=>({...r,stage:'reference-position'}))],
    counts:{...fitted.counts,linePaths:paths.results.length,relocated:positioned.records.filter(r=>r.accepted).length}};
}

async function fitShapes(context) {
  let {env, project, index, preview, elements, signal, gate = true} = context;
  // S3 table fitting: S2 already detected and annotated table objects. Fit the table outer
  // contour first, then snap grid parameters and fit the inner colour blocks; only after that the
  // remaining elements go through the normal S3 shape fitting below.
  let tableFit = null;
  try {
    if (context.adapters?.fill && Array.isArray(elements)
      && elements.some(element => element?.tableObject?.tableId)) {
      tableFit = await fitTableObjects({...context, elements});
      if (tableFit?.elements) elements = tableFit.elements;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    tableFit = {status: 'failed', error: String(error && error.message || error).slice(0, 200)};
  }
  if (tableFit?.status === 'failed') return {...tableFit, elements: context.elements};
  elements=registerLocalComponents(elements,{nodes:project.slides?.[index]?.elements||[],previous:context.elements});
  let prototype=null;
  if(!context.shapeStageExec){
    prototype=await fitConstrainedShapes({...context,elements});
    elements=prototype.elements;
  }
  const handled=new Set(prototype?.handled||[]);
  const natives = nativeRoute(elements);
  const requestedKeys = context.targetKeys ? new Set(context.targetKeys) : null;
  const targets = natives.filter(element => ['shape', 'rect', 'ellipse'].includes(element.type)
    && !element.managed && !element._stagedSkip && !element._tableStage && !element.tableId
    && !String(element.key || '').startsWith('nf-')
    && !handled.has(element.key)
    && (!requestedKeys || requestedKeys.has(element.key)));
  const batchSize = 12;
  if (!targets.length) return {status:tableFit?.status==='partial'?'partial':prototype?.results?.length||tableFit ? 'ok':'skipped',
    elements:arrangeScene(placeLocalComponents(elements,{targetKeys:context.targetKeys}).elements),reason:'no-native-targets',report:prototype?.results||[],
    counts:{targets:prototype?.results?.length||0,accepted:prototype?.results?.filter(r=>r.status==='accepted').length||0,
      tableObjects:tableFit?.counts?.tables||0,tableFitted:tableFit?.counts?.fittedTables||0},
    note:tableFit?.status==='partial'?JSON.stringify(tableFit.report).slice(0,1200):null};
  // F03: every S3 working file (spec, result, enhanced background, retry files) is scoped by
  // project id + page + a per-run UUID. Different projects sharing a page number, and re-entries
  // of the same page, must never overwrite each other's inputs or read each other's results.
  const workspace = createShapeStageWorkspace({env, project, index});
  const directory = workspace.directory;
  const specFile = workspace.specFile;
  const exec = typeof context.shapeStageExec === 'function' ? context.shapeStageExec : null;
  const placeholderBoxes = (project.visualPages?.[index]?.images || [])
    .map(image => image?.placeholderBox || (image?.x != null ? {x: image.x, y: image.y, w: image.w, h: image.h} : null))
    .filter(Boolean);
  const foundation = project.visualPages?.[index]?.foundation?.file;
  const background = foundation ? path.join(env.data, project.id, foundation) : null;
  const python = context.python || process.env.PPT_AGENT_PYTHON
    || path.join(env.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const runTool = (script, args, timeout) => runShapeStageTool({python, exec, cwd: env.root,
    script: path.join(env.root, 'tools', script), args, timeout, signal,executor:env.run});
  // Object masks + heading ids: the engine uses front masks for occlusion-aware fitting (neighbour
  // objects drawn later hide parts of the target) and heading ids for panel/heading separation.
  let maskEntries = [];
  try {
    if (typeof env.getImage === 'function') {
      const maskDirectory = path.join(env.data, project.id, 'geometry-records', 'object-masks');
      fs.mkdirSync(maskDirectory, {recursive: true});
      maskEntries = await buildObjectMasks({elements, directory: maskDirectory,
        getImage: id => env.getImage(project, id), signal});
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    maskEntries = [];
  }
  const headingNodeIds = (project.slides?.[index]?.elements || [])
    .filter(element => element.type === 'group' || element.role === 'heading')
    .map(element => element.id).filter(Boolean);
  // Geometry fitting uses a contrast-enhanced copy on dark pages; colours stay original
  // for S4/S5 paint fitting (the paint adapter keeps using the original preview).
  let fitReference = preview;
  let fitBackground = background;
  let enhancedGeometry = false;
  if(context.enhanceGeometry===true||context.shapeStageExec)try {
    // Enhanced-preview cache is shared by runs with the same preview/background (per project).
    // Generate it in this run's directory, then publish atomically (png first, meta last) so a
    // concurrent run can never consume a half-written enhancement.
    const cache = enhancedPreviewCache({env, project, preview, background});
    let enhancedMeta = readEnhancement(cache);
    if (!enhancedMeta) {
      const temp = enhancementTempPaths({cache, directory, runId: workspace.runId});
      await runTool('enhance_page.py', [preview, temp.previewFile], 120000);
      enhancedMeta = publishEnhancement({cache, temp});
    }
    if (enhancedMeta.dark) {
      fitReference = cache.previewFile;
      enhancedGeometry = true;
      if (background) {
        // Enhanced background only feeds this run's spec, so keeping it run-scoped is enough.
        await runTool('enhance_page.py', [background, workspace.enhancedBackground], 120000);
        fitBackground = workspace.enhancedBackground;
      }
    }
  } catch (error) { if (signal?.aborted) throw error; }
  const writeSpec = (file, keys) => fs.writeFileSync(file, JSON.stringify({reference: fitReference, background: fitBackground, elements,
    exclude: placeholderBoxes, masks: maskEntries, headingNodeIds, panelOpt: true,
    targetKeys: keys, debug: context.debugGeometry === true}));
  const runBatch = async (keys, batchIndex, attempt) => {
    const base = batchIndex === 0 ? directory : path.join(directory, 'batch-' + (batchIndex + 1));
    const batchDirectory = attempt ? path.join(base, 'retry') : base;
    fs.mkdirSync(batchDirectory, {recursive: true});
    const batchSpec = batchDirectory === directory ? specFile : path.join(batchDirectory, 'spec.json');
    writeSpec(batchSpec, keys);
    await runTool('shape_measure.py', [batchSpec, batchDirectory], 120000);
    return JSON.parse(fs.readFileSync(path.join(batchDirectory, 'shape-result.json'), 'utf8'));
  };
  const batchFailures = [];
  try {
    const measured = new Map();
    let retried = 0;
    for (let at = 0; at < targets.length; at += batchSize) {
      const index = at / batchSize;
      let keys = targets.slice(at, at + batchSize).map(element => element.key);
      for (let attempt = 0; keys.length && attempt < 2; attempt++) {
        signal?.throwIfAborted();
        if (attempt) retried += keys.length;
        const errors = new Map();
        try {
          const result = await runBatch(keys, index, attempt);
          for (const row of result.errors || []) errors.set(row.key, row.error);
          for (const item of result.elements) {
            const points = item.chosen?.points;
            if (keys.includes(item.key) && !errors.has(item.key) && Array.isArray(points) && points.length >= 3
              && points.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) measured.set(item.key, item);
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          for (const key of keys) errors.set(key, String(error.message || error).slice(0, 200));
        }
        keys = keys.filter(key => !measured.has(key));
        if (attempt) for (const key of keys) batchFailures.push({batch: index + 1, key, error: errors.get(key) || 'No measured contour'});
      }
    }
    const byKey = new Map(elements.map(element => [element.key, element]));
    const report = [];
    for (const item of measured.values()) {
      const original = byKey.get(item.key);
      const xs = item.chosen.points.map(point => point[0]);
      const ys = item.chosen.points.map(point => point[1]);
      const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
      const displacement = Math.max(...[box[0] - original.x, box[1] - original.y,
        box[2] - original.w, box[3] - original.h].map(Math.abs));
      const limit = Math.max(24, 0.18 * Math.max(original.w, original.h));
      const rawP95 = item.chosen.metrics?.boundaryP95;
      const p95 = Number.isFinite(rawP95) ? rawP95 : null;
      const boundary = p95 === null ? {evidence: 'insufficient'} : {p95: Math.round(p95 * 10) / 10};
      const lowConfidence = Boolean(item.lowConfidence
        || (item.chosen?.extra || {}).fallback === 'low-confidence');
      const familyChanged=['hexagon','ellipse','parallelogram','trapezoid'].includes(original.shape||original.type)
        && (item.chosen.native?.shape||item.chosen.native?.type)!==(original.shape||original.type);
      const accepted = !gate || (!lowConfidence&&!familyChanged&&p95 !== null && p95 <= 4.0 && displacement <= limit);
      report.push({key: item.key, kind: item.chosen.kind, p95, displacement: Math.round(displacement),
        support: item.chosen.metrics?.edgeSupport ?? 0, chamfer: item.chosen.metrics?.chamfer ?? 0,
        accepted, lowConfidence});
      if (accepted) {
        const native = item.chosen.native || {};
        const shapeGeometry = native.shapeGeometry || original.shapeGeometry;
        const nativeShape = native.shape || original.shape;
        // Corner evidence (post-fit): decide significance, merge consistent corners of this
        // element, and only convert to freeform when the preset really cannot express the corners.
        const measuredPoints = Array.isArray(item.chosen.points) ? item.chosen.points : [];
        const measuredCorners = Array.isArray(item.chosen.corners) ? item.chosen.corners : null;
        const cornerTypes = measuredCorners
          ? [...new Set(measuredCorners.map(corner => String(corner?.type || 'sharp')))] : [];
        const cornerValue = corner => {
          if (!corner) return 0;
          if (String(corner.type) === 'cut') {
            const cut = corner.distance??corner.cut;
            if (Array.isArray(cut)) return cut.reduce((sum, value) => sum + (Number(value) || 0), 0) / cut.length;
            return Number(cut) || 0;
          }
          return Number(corner.radius) || 0;
        };
        const rawCorners = measuredCorners ? measuredCorners.map(corner => ({
          type: String(corner?.type || 'sharp'), value: cornerValue(corner),confidence:corner.confidence??corner.support??0})) : [];
        const significantCorners = rawCorners.filter(corner => corner.type !== 'sharp'
          && Number.isFinite(corner.value) && corner.value >= 0.03);
        const hasSignificantCorners = significantCorners.length > 0;
        // Single-element merge: corners that share type and a consistent size/angle collapse into
        // one shared parameter (the median value).
        const cornerSpec = corner => (corner.type === 'cut'
          ? {type: 'cut', distance: corner.value}
          : corner.type === 'round' ? {type: 'round', radius: corner.value} : {type: 'sharp'});
        const specs=rawCorners.map(c=>({...cornerSpec(c),confidence:c.confidence})),symmetric=mergeSymmetricCorners(specs,original.shapeGeometry?.cornerSymmetry||'auto',{points:measuredPoints});
        const mergedWithinElement=JSON.stringify(specs)!==JSON.stringify(symmetric);
        const mergedCorners=symmetric.map(c=>({type:c.type,value:c.radius??c.distance??0}));
        const presetFamily = ['rect', 'roundRect', 'rect-sharp', 'parallelogram', 'trapezoid'];
        const complexCornerTypes = [...new Set(significantCorners.map(corner => corner.type))].length > 1;
        const convertToFreeform = hasSignificantCorners && !native.customGeometry
          && nativeShape !== 'freeform' && measuredPoints.length >= 3
          && (!['rect','roundRect','hexagon','ellipse','parallelogram','trapezoid'].includes(nativeShape)&&measuredPoints.length > 4
            || (['parallelogram', 'trapezoid'].includes(String(nativeShape)) && complexCornerTypes));
        let effectiveNative = native;
        if (convertToFreeform) {
          try {
            const xsMeasured = measuredPoints.map(point => Number(point[0]));
            const ysMeasured = measuredPoints.map(point => Number(point[1]));
            const minX = Math.min(...xsMeasured), minY = Math.min(...ysMeasured);
            const spanX = Math.max(1e-6, Math.max(...xsMeasured) - minX);
            const spanY = Math.max(1e-6, Math.max(...ysMeasured) - minY);
            const normalized = measuredPoints.map(point => [
              Math.round(((Number(point[0]) - minX) / spanX) * 10000) / 10000,
              Math.round(((Number(point[1]) - minY) / spanY) * 10000) / 10000]);
            const area = Math.abs(normalized.reduce((sum, point, pointIndex) => {
              const next = normalized[(pointIndex + 1) % normalized.length];
              return sum + point[0] * next[1] - next[0] * point[1];
            }, 0)) / 2;
            if (area >= 0.002) {
              effectiveNative = {type: 'shape', shape: 'freeform',
                bounds: {x: minX, y: minY, w: spanX, h: spanY},
                customGeometry: {points: normalized, closed: true}};
            }
          } catch {}
        }
        // Preset shape geometry: significant corners are written per-corner (rect/roundRect shape
        // geometry supports round/cut); insignificant corner evidence becomes plain sharp corners.
        let effectiveShapeGeometry = effectiveNative.shapeGeometry;
        if (measuredCorners) {
          const baseGeometry = effectiveShapeGeometry?.version === 2
            ? effectiveShapeGeometry : {version: 2};
          if (hasSignificantCorners && effectiveNative.shape !== 'freeform'
            && presetFamily.includes(String(effectiveNative.shape))) {
            effectiveShapeGeometry = {...baseGeometry,
              corners: mergedCorners.map(corner => cornerSpec(corner))};
          } else if (!hasSignificantCorners && Array.isArray(baseGeometry?.corners)) {
            effectiveShapeGeometry = {...baseGeometry,
              corners: baseGeometry.corners.map(() => ({type: 'sharp'}))};
          }
        }
        const cornerInfo = measuredCorners ? {
          corners: mergedCorners.map(corner => cornerSpec(corner)),
          vertexCount: measuredPoints.length,
          significant: hasSignificantCorners,
          mergedWithinElement,
          convertedToFreeform: effectiveNative.shape === 'freeform',
        } : undefined;
        const adjustments = {...(original.adjustments || {})};
        // Only presets whose committed geometry encoder consumes adjustments get one; writing an
        // arbitrary adj on other presets produces PowerPoint-invalid geometry XML.
        if (['hexagon', 'chevron'].includes(nativeShape)) {
          if (shapeGeometry && Number.isFinite(Number(shapeGeometry.headDepth))) {
            adjustments.adj = Math.round(Math.min(50000, Math.max(0, Number(shapeGeometry.headDepth) * 100000)));
          } else if (Array.isArray(shapeGeometry?.corners)) {
            const radius = Math.max(...shapeGeometry.corners.map(corner => Number(corner.radius) || 0));
            if (radius > 0) adjustments.adj = Math.round(Math.min(50000, radius * 100000));
          }
        } else {
          delete adjustments.adj;
        }
        byKey.set(item.key, {
          ...original,
          x: box[0], y: box[1], w: box[2], h: box[3],
          type: effectiveNative.type || original.type,
          shape: effectiveNative.shape || original.shape,
          adjustments,
          headDepth: effectiveShapeGeometry?.headDepth,
          slantSign: effectiveShapeGeometry?.slantSign,
          ...(item.chosen.native?.flipH != null ? {flipH: item.chosen.native.flipH} : {}),
          ...(item.chosen.native?.flipV != null ? {flipV: item.chosen.native.flipV} : {}),
          shapeGeometry: effectiveShapeGeometry,
          customGeometry: effectiveNative.customGeometry || undefined,
          ...(cornerInfo ? {cornerInfo} : {}),
          nativeDecision: {...(item.chosen.native || original.nativeDecision || {}),
            cornerInfo: cornerInfo ? {types: cornerTypes, convertedToFreeform: cornerInfo.convertedToFreeform} : undefined},
          shapeRepaired: true,
          geometryEvidence: {source: 'staged-S3', kind: item.chosen.kind,
            ...boundary, method: 'staged-shape-fit', accepted: true},
          ...(lowConfidence ? {geometryConfidence: 'low', lowConfidenceGeometry: true} : {}),
        });
      } else {
        // Remediation instead of silently keeping the audit box: emit an explicit low-confidence
        // native geometry at the ROI/audit size with the declared shape family. S6 can then merge
        // shared parameters from high-confidence peers and S8 can refine it locally.
        const declaredShape = String(original.shape || '').toLowerCase();
        const kindMap = {roundrect: 'roundRect', roundpanel: 'roundPanel', rect: 'rect',
          ellipse: 'ellipse', circle: 'circle', hexagon: 'hexagon',
          parallelogram: 'parallelogram-sharp', trapezoid: 'trapezoid',
          freeform: 'roundRect', pill: 'pill', chevron: 'chevron'};
        const fallbackShape = original.shape || kindMap[declaredShape] || 'roundRect';
        byKey.set(item.key, {
          ...original,
          shape: fallbackShape,
          shapeGeometry: original.shapeGeometry,
          geometryConfidence: 'low',
          lowConfidenceGeometry: true,
          lowConfidenceReason: {stage: 'S3', reason: 'gate-rejected',
            ...boundary, displacement: Math.round(displacement),
            limit: Math.round(limit)},
          geometryEvidence: {source: 'staged-S3', kind: item.chosen.kind,
            ...boundary, method: 'staged-shape-fit', accepted: false},
          shapeRepaired: false,
        });
      }
    }
    // Candidates whose batch could not be measured keep their audit geometry but are now marked
    // as insufficient evidence, so the existing review branch (not a silent drop) can see them.
    for (const failure of batchFailures) {
      const key = failure.key;
      const element = byKey.get(key);
      byKey.set(key, {...element, geometryConfidence: 'low', lowConfidenceGeometry: true,
        lowConfidenceReason: {stage: 'S3', reason: 'measurement-unavailable', evidence: 'insufficient',
          batch: failure.batch, error: failure.error},
        geometryEvidence: {source: 'staged-S3', accepted: false, evidence: 'insufficient'}});
    }
    const acceptedCount = report.filter(row => row.accepted).length;
    const lowConfidenceCount = report.filter(row => row.lowConfidence).length;
    return {status: batchFailures.length ? 'partial' : tableFit?.status==='partial'?'partial':'ok', elements: arrangeScene(placeLocalComponents([...byKey.values()],{targetKeys:context.targetKeys}).elements), report:[...(prototype?.results||[]),...report],
      note: [tableFit?.status==='partial'?JSON.stringify(tableFit.report).slice(0,1200):null,
        batchFailures.length?JSON.stringify(batchFailures).slice(0,600):null].filter(Boolean).join('\n') || null,
      counts: {candidates: targets.length, batches: Math.ceil(targets.length / batchSize),
        batchFailures: new Set(batchFailures.map(row=>row.batch)).size, unresolved: batchFailures.length, retried,
        targets: targets.length+(prototype?.results?.length||0), accepted: acceptedCount+(prototype?.results?.filter(row=>row.status==='accepted').length||0),
        rejected: report.length - acceptedCount, lowConfidence: lowConfidenceCount,
        tableObjects: tableFit?.counts?.tables || 0,
        tableFitted: tableFit?.counts?.fittedTables || 0},
      artifacts: {specFile, directory, runId: workspace.runId, enhancedGeometry, batchFailures}};
  } catch (error) {
    if (signal?.aborted) throw error;
    return {status:'partial',elements,reason:'shape-engine-unavailable',note:String(error.message||error).slice(0,300),
      report:prototype?.results||[],counts:{accepted:prototype?.results?.filter(r=>r.status==='accepted').length||0,unresolved:targets.length}};
  }
}

// ------------------------------------------------------------------ S4 / S5 / S6 / S7 / S8 / S9
// Delegated to the committed pipeline modules (adapter injection); the framework still
// validates the field contract after each stage so a mis-wired adapter cannot touch other
// stages' fields.

// ------------------------------------------------------------------ S5b 文字颜色识别
// Title: solid colour or vertical-only gradient fit. Body: detect differently-coloured runs.
// Runs before S6 merge so the committed merge can force one global title style.
export async function textColorStage(context) {
  try {
    const {env, project, index, preview, elements, signal} = context;
    const texts = (elements || []).filter(element => element.type === 'text' && element.text);
    if (!texts.length) return {status: 'skipped', elements, reason: 'no-text'};
    const directory = path.join(env.data, project.id, 'geometry-records', 'pipeline', 'page-' + (index + 1));
    fs.mkdirSync(directory, {recursive: true});
    const runDirectory = path.join(directory, 'text-color', crypto.randomUUID());
    fs.mkdirSync(runDirectory, {recursive: true});
    const input = path.join(runDirectory, 'input.json');
    const output = path.join(runDirectory, 'output.json');
    const foundation=project.visualPages?.[index]?.foundation?.file;
    const base=foundation?path.join(env.data,project.id,foundation):null;
    const surfaces=elements.filter(e=>['rect','shape','ellipse','line','image','svg'].includes(e.type));
    let surfaceFile;
    if(surfaces.length||base&&fs.existsSync(base)){
      const resolve=id=>{const file=id==='__surface_bg'?base:env.getImage?.(project,id);if(file?.startsWith('data:image/'))return file;return file&&fs.existsSync(file)?'data:image/'+(file.endsWith('.svg')?'svg+xml':'png')+';base64,'+fs.readFileSync(file).toString('base64'):'';};
      const markup=nativeSVG(surfaces,resolve,base&&fs.existsSync(base)?{id:'__surface_bg'}:null);
      surfaceFile=path.join(directory,'text-surface-'+crypto.createHash('sha256').update(markup).digest('hex').slice(0,20)+'.png');
      if(!fs.existsSync(surfaceFile))fs.writeFileSync(surfaceFile,await renderSVG(markup,{fitTo:{mode:'width',value:1600}},signal));
    }
    const glyphMasks=await buildObjectMasks({elements:texts,directory:path.join(env.data,project.id,'geometry-records','object-masks'),signal});
    const targets=context.targetKeys==null?null:new Set(context.targetKeys);
    const sizeKeys=new Set(texts.filter(e=>(!targets||targets.has(e.key))&&!e.managed&&!e.tableId&&!e.tableRole
      &&!['title','visual-number','navigation','footer','table-header','table-cell'].includes(e.role)
      &&!e.keepParameters?.some(k=>['size','fontSize','typography'].includes(k))).map(e=>e.key));
    const textColorJson = JSON.stringify({reference: preview, pageWidth: 1600,targetKeys:context.targetKeys,uniformSizeKeys:[...sizeKeys],
      objectMasks:glyphMasks,surface:surfaceFile,measureTypography:false,elements: elements || texts}, null, 1);
    fs.writeFileSync(input, textColorJson);
    const textColorHash = crypto.createHash('sha256').update(textColorJson)
      .update(fileDigest(preview)).update(fileDigest(path.join(env.root, 'tools', 'text_color.py')))
      .update(fileDigest(path.join(env.root,'tools','uniform_text_size.py')))
      .update(surfaceFile?fileDigest(surfaceFile):'no-surface')
      .digest('hex').slice(0, 16);
    const textColorCache = path.join(directory, 'S5b-text-color-cache-' + textColorHash + '.json');
    const python = context.python || process.env.PPT_AGENT_PYTHON
      || path.join(env.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    let measured = null;
    if (fs.existsSync(textColorCache)) {
      try { measured = JSON.parse(fs.readFileSync(textColorCache, 'utf8')); } catch {}
    }
    if (!measured) {
      await runPython({python, script: path.join(env.root, 'tools', 'text_color.py'),
        args: [input, output], cwd: env.root, timeout: 300000, signal,executor:env.run||run});
      measured = JSON.parse(fs.readFileSync(output, 'utf8'));
      try { fs.writeFileSync(textColorCache, JSON.stringify(measured)); } catch {}
    }
    const byKey = new Map((measured.results || []).map(row => [row.key, row]));
    const referenceHash=fileDigest(preview);
    let changed = 0;
    const next = (elements || []).map(element => {
      if(element.type!=='text'||targets&&!targets.has(element.key))return element;
      const row = byKey.get(element.key);
      if(element.managed||element.role==='navigation'||element.key?.startsWith('nf-progress-'))return element;
      const size=row?.uniformTextSize;
      if(sizeKeys.has(element.key)&&Number.isFinite(size?.confidence)&&size.confidence>=.75&&size.confidence<=1
        &&Number.isFinite(size.size)&&size.size>=12&&size.size<=120){
        element={...element,size:size.size,uniformTextSizeEvidence:{source:'preview-glyph-scale',size:size.size,confidence:size.confidence,referenceHash}};
      }
      if(parameterKept(element.keepParameters,'textColor'))return element;
      if (!row || row.error || row.confident === false) {
        // Titles never carry a measured stroke/outline, even when the colour measurement is not
        // confident enough to override the audit colour.
        const titleOutline = row?.kind === 'title' ? {outline: undefined} : {};
        const {textColorRuns,...rest}=element,runs=retainedTextColorRuns(element,referenceHash);
        return {...rest,...titleOutline,...(runs.length?{textColorRuns:runs}:{})};
      }
      changed += 1;
      if (row.kind === 'title') {
        // Titles never carry a measured stroke/outline: the audit title outline is dropped.
        const {textGradient, ...rest} = element;
        return normalizeTextPaint({...rest, color: row.color, outline: undefined,
          gradient: undefined, ...(row.gradient ? {textGradient: row.gradient} : {}), textColorKind: 'title',textPaintMeasured:true});
      }
      const {textColorRuns,...rest}=element;
      const explicit=(element.textColorRuns||[]).some(run=>run.source==='user');
      const runs=explicit?retainedTextColorRuns(element,referenceHash).filter(run=>run.source==='user')
        :anchorTextColorRuns(element,(row.colorRuns||[]).map(run=>({...run,referenceHash})));
      return {...rest, color: row.color, textColorKind: 'body',
        ...(runs.length ? {textColorRuns: runs} : {})};
    });
    const accents=mergeParallelTextAccents(next,{nodes:project.slides?.[index]?.elements||[],targetKeys:context.targetKeys,referenceHash});
    return {status: 'ok', elements: accents.elements.map((e,i)=>targets&&!targets.has(e.key)?elements[i]:enforceTextPaintPolicy(e)), counts: {measured: measured.results?.length || 0, changed,accentGroups:accents.records.length},accentGroups:accents.records,
      report: measured.results, artifacts: {input, output}};
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return {status: 'failed', elements: context.elements, error: String(error.message || error).slice(0, 300)};
  }
}

export function delegatedStage(name, key, fallbackNote) {
  return async (context) => {
    const adapter = context.adapters?.[key];
    if (typeof adapter !== 'function') {
      return {status: 'delegated', elements: context.elements, note: fallbackNote || 'awaiting committed-pipeline adapter'};
    }
    const output = await adapter(context);
    return {status: 'ok', ...output};
  };
}

export const fillStage = delegatedStage('S4-fill', 'fill', 'committed shape_paint / paint_models');
export const strokeStage = delegatedStage('S5-stroke', 'stroke', 'native stroke and shadow fitting');
export const mergeStage = delegatedStage('S6-merge', 'merge', 'committed native-parameter-groups / group-fit-evidence');

// S3 table ownership: shared row/column boundaries and independently measured row fills.
// S2 annotations remain the identity source; generic S4 never repaints accepted row bands.
export async function fitTableObjects(context) {
  return fitTableRows(context);
}
