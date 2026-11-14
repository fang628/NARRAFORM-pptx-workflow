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
import {normalizeTextPaint} from './styled-text.mjs';
import {fitConstrainedShapes} from './constrained-fitting.mjs';
import {arrangeScene} from './scene-hierarchy.mjs';
import {enforceTextPaintPolicy} from './text-style-policy.mjs';
import {fitTableRows} from './table-row-fitting.mjs';
import {routeLightBar} from './light-bars.mjs';
import {mergeSymmetricCorners} from './corner-symmetry.mjs';
import {normalizeRebuildProgress} from './rebuild-progress.mjs';
import {normalizeTableTypography} from './table-typography.mjs';
import {registerLocalComponents,placeLocalComponents} from './local-components.mjs';
import {nativeSVG} from './visual-model.mjs';
import {renderSVG} from './render-pool.mjs';
import {
  createShapeStageWorkspace, enhancedPreviewCache, enhancementTempPaths, publishEnhancement,
  readEnhancement, runShapeStageTool,
} from './shape-stage-workspace.mjs';

const run = promisify(execFile);

async function runPython({python, script, args, cwd, timeout = 600000, signal, executor=run}) {
  return executor(python, [script, ...args], {cwd, windowsHide: true, timeout, signal});
}

// ------------------------------------------------------------------ S2 补全
// Uses the pixel-difference registration tool: foreground regions missing from the wordless
// background are registered as complete audit objects (key/type/shape/nodeId/x/y/w/h/fill).
export async function completeStage(context) {
  const {env, project, index, preview, elements, resolveNodeId, signal} = context;
  const foundation = project.visualPages?.[index]?.foundation?.file;
  const background = foundation ? path.join(env.data, project.id, foundation) : null;
  const directory = path.join(env.data, project.id, 'geometry-records', 'registration');
  fs.mkdirSync(directory, {recursive: true});
  const runDirectory = path.join(directory, 'page-' + (index + 1), crypto.randomUUID());
  fs.mkdirSync(runDirectory, {recursive: true});
  const input = path.join(runDirectory, 'input.json');
  const output = path.join(runDirectory, 'registry.json');
  const protectedChrome=normalizeRebuildProgress(project,index,elements).filter(e=>e.managed);
  const registrationSpec = {preview, background, elements,protected:protectedChrome};
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
    const registry = registration.registry.map(element => {
      if (!element.autoRegistered) return element;
      if(element.role==='effect')return element;
      let nodeId = typeof resolveNodeId === 'function' ? resolveNodeId(element) : null;
      if (!nodeId) {
        const inside = elements.find(other => other.type === 'text' && other.nodeId
          && other.x >= element.x - 6 && other.y >= element.y - 6
          && other.x + other.w <= element.x + element.w + 6
          && other.y + other.h <= element.y + element.h + 6);
        nodeId = inside?.nodeId || null;
      }
      return {...element, nodeId: nodeId || null,
        role: nodeId ? 'content-frame' : 'background-diff',
        description: element.description || '按像素差补登记的前景框架'};
    });
    // Independent title carriers are owned by the contour/audit path. A row
    // colour step cannot create a second opaque carrier in S2.
    let completed = {titleBands: 0};
    let finalElements = registry;
    // S2 table-object detection: group table cells/bands/lines ONCE and annotate them. Later
    // stages (S3 table fitting) read these annotations instead of re-detecting the table, so a
    // repeated attempt or a later stage cannot duplicate table objects.
    let tableObjects = [];
    try {
      const annotated = annotateTableObjects(finalElements, {project, index});
      finalElements = annotated.elements;
      tableObjects = annotated.tableObjects;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    finalElements=arrangeScene(finalElements.map(routeLightBar));
    const validation = validateRegistry(finalElements);
    return {status: validation.ok ? 'ok' : 'partial', elements: finalElements, targets: registration.targets,
      coverage: registration.coverage,
      counts: {...registration.counts, titleBands: completed.titleBands,
        tableObjects: tableObjects.length},
      validation, completed, artifacts: {input, output}};
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
  let {env, project, index, preview, elements, signal, gate = true} = context;
  // S3 table step (S3t): S2 already detected and annotated table objects. Fit the table outer
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
  const targets = natives.filter(element => ['shape', 'rect', 'ellipse', 'line'].includes(element.type)
    && !element.managed && !element._stagedSkip && !element._tableStage && !element.tableId
    && !String(element.key || '').startsWith('nf-')
    && !handled.has(element.key)
    && (!requestedKeys || requestedKeys.has(element.key))).slice(0,12);
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
      const maskHash = crypto.createHash('sha256').update(JSON.stringify({
        reference: preview, background,
        elements: elements.map(element => [element.key, element.type, element.x, element.y,
          element.w, element.h, element.svg ? String(element.svg).length : 0]),
      })).digest('hex').slice(0, 16);
      const manifest = path.join(maskDirectory, 'manifest-' + maskHash + '.json');
      if (fs.existsSync(manifest)) {
        try { maskEntries = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch { maskEntries = []; }
      }
      if (!maskEntries.length) {
        maskEntries = await buildObjectMasks({elements, directory: maskDirectory,
          getImage: id => env.getImage(project, id), signal: context.signal});
        try { fs.writeFileSync(manifest, JSON.stringify(maskEntries)); } catch {}
      }
    }
  } catch {
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
  } catch {}
  fs.writeFileSync(specFile, JSON.stringify({reference: fitReference, background: fitBackground, elements,
    exclude: placeholderBoxes, masks: maskEntries, headingNodeIds, panelOpt: true,
    targetKeys: targets.map(element => element.key), debug: true}));
  try {
    await runTool('shape_measure.py', [specFile, directory], 120000);
    const result = JSON.parse(fs.readFileSync(workspace.resultFile, 'utf8'));
    const byKey = new Map(elements.map(element => [element.key, element]));
    let secondResult = null;
    const retryKeys=(result.elements||[]).filter(item=>(item.chosen?.metrics?.boundaryP95??999)>4||item.lowConfidence).map(item=>item.key);
    if (retryKeys.length && !enhancedGeometry && context.shapeStageExec) {
      // Poor first pass: retry geometry on the contrast-enhanced copy and keep the better fit.
      try {
        // Retry files stay inside this run's private directory as well.
        const retryDirectory = workspace.retryDirectory;
        fs.mkdirSync(retryDirectory, {recursive: true});
        const retrySpec = path.join(retryDirectory, 'spec.json');
        const enhancedPreview = path.join(directory, 'enhanced-preview.png');
        let enhancedBackground = null;
        await runTool('enhance_page.py', [preview, enhancedPreview], 120000);
        if (background) {
          enhancedBackground = workspace.enhancedBackground;
          await runTool('enhance_page.py', [background, enhancedBackground], 120000);
        }
        fs.writeFileSync(retrySpec, JSON.stringify({reference: enhancedPreview, background: enhancedBackground,
          elements, masks:maskEntries,exclude: placeholderBoxes, targetKeys: retryKeys, debug: true}));
        await runTool('shape_measure.py', [retrySpec, retryDirectory], 900000);
        secondResult = JSON.parse(fs.readFileSync(path.join(retryDirectory, 'shape-result.json'), 'utf8'));
        enhancedGeometry = true;
      } catch {}
    }
    const report = [];
    const secondByKey = new Map((secondResult?.elements || []).map(item => [item.key, item]));
    for (let item of result.elements) {
      const original = byKey.get(item.key);
      if (!original) continue;
      const alternative = secondByKey.get(item.key);
      if (alternative) {
        const fallbackKinds = new Set(['seed-box', 'box', 'seed-round', 'seed-sharp',
          'freeform', 'freeform-curve', 'fill-panel']);
        const firstKind = String(item.chosen?.kind || '');
        const altKind = String(alternative.chosen?.kind || '');
        const firstP95 = item.chosen?.metrics?.boundaryP95 ?? 999;
        const altP95 = alternative.chosen?.metrics?.boundaryP95 ?? 999;
        const firstFallback = fallbackKinds.has(firstKind);
        const altFallback = fallbackKinds.has(altKind);
        const family = (kind) => kind.replace(/-merged$/, '');
        const altPoints = alternative.chosen.points || [];
        const altX = altPoints.map(point => point[0]);
        const altY = altPoints.map(point => point[1]);
        const altW = Math.max(...altX) - Math.min(...altX);
        const altH = Math.max(...altY) - Math.min(...altY);
        const sizeOk = altW / Math.max(1, original.w) >= 0.70
          && altW / Math.max(1, original.w) <= 1.45
          && altH / Math.max(1, original.h) >= 0.70
          && altH / Math.max(1, original.h) <= 1.45;
        const compatible = family(firstKind) === family(altKind) || firstFallback;
        const clearlyBetter = altP95 <= Math.max(0, firstP95 - Math.max(1.0, 0.25 * firstP95));
        if (!altFallback && sizeOk && compatible && (firstFallback || clearlyBetter)) {
          item = alternative;
        }
      }
      const xs = item.chosen.points.map(point => point[0]);
      const ys = item.chosen.points.map(point => point[1]);
      const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
      const displacement = Math.max(...[box[0] - original.x, box[1] - original.y,
        box[2] - original.w, box[3] - original.h].map(Math.abs));
      const limit = Math.max(24, 0.18 * Math.max(original.w, original.h));
      const p95 = item.chosen.metrics?.boundaryP95 ?? 999;
      const lowConfidence = Boolean(item.lowConfidence
        || (item.chosen?.extra || {}).fallback === 'low-confidence');
      const familyChanged=['hexagon','ellipse','parallelogram','trapezoid'].includes(original.shape||original.type)
        && (item.chosen.native?.shape||item.chosen.native?.type)!==(original.shape||original.type);
      const accepted = !gate || (!lowConfidence&&!familyChanged&&p95 <= 4.0 && displacement <= limit);
      report.push({key: item.key, kind: item.chosen.kind, p95, displacement: Math.round(displacement),
        support: item.chosen.metrics?.edgeSupport ?? 0, chamfer: item.chosen.metrics?.chamfer ?? 0,
        accepted, lowConfidence, alternativeUsed: item !== null && alternative === item});
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
            p95: Math.round(p95 * 10) / 10, method: 'staged-shape-fit', accepted: true},
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
            p95: Math.round(p95 * 10) / 10, displacement: Math.round(displacement),
            limit: Math.round(limit)},
          geometryEvidence: {source: 'staged-S3', kind: item.chosen.kind,
            p95: Math.round(p95 * 10) / 10, method: 'staged-shape-fit', accepted: false},
          shapeRepaired: false,
        });
      }
    }
    const acceptedCount = report.filter(row => row.accepted).length;
    const lowConfidenceCount = report.filter(row => row.lowConfidence).length;
    const secondPassUsed = report.filter(row => row.alternativeUsed).length;
    return {status: tableFit?.status==='partial'?'partial':'ok', elements: arrangeScene(placeLocalComponents([...byKey.values()],{targetKeys:context.targetKeys}).elements), report:[...(prototype?.results||[]),...report],
      note:tableFit?.status==='partial'?JSON.stringify(tableFit.report).slice(0,1200):null,
      counts: {targets: report.length+(prototype?.results?.length||0), accepted: acceptedCount+(prototype?.results?.filter(row=>row.status==='accepted').length||0),
        rejected: report.length - acceptedCount, lowConfidence: lowConfidenceCount,
        secondPassUsed, tableObjects: tableFit?.counts?.tables || 0,
        tableFitted: tableFit?.counts?.fittedTables || 0},
      artifacts: {specFile, directory, runId: workspace.runId, enhancedGeometry}};
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
      const resolve=id=>{const file=id==='__surface_bg'?base:env.getImage?.(project,id);return file&&fs.existsSync(file)?'data:image/'+(file.endsWith('.svg')?'svg+xml':'png')+';base64,'+fs.readFileSync(file).toString('base64'):'';};
      const markup=nativeSVG(surfaces,resolve,base&&fs.existsSync(base)?{id:'__surface_bg'}:null);
      surfaceFile=path.join(directory,'text-surface-'+crypto.createHash('sha256').update(markup).digest('hex').slice(0,20)+'.png');
      if(!fs.existsSync(surfaceFile))fs.writeFileSync(surfaceFile,await renderSVG(markup,{fitTo:{mode:'width',value:1600}},signal));
    }
    const textColorJson = JSON.stringify({reference: preview, pageWidth: 1600,
      surface:surfaceFile,elements: elements || texts}, null, 1);
    fs.writeFileSync(input, textColorJson);
    const textColorHash = crypto.createHash('sha256').update(textColorJson)
      .update(fs.readFileSync(preview)).update(fs.readFileSync(path.join(env.root, 'tools', 'text_color.py')))
      .update(surfaceFile?fs.readFileSync(surfaceFile):'no-surface')
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
    let changed = 0;
    const next = (elements || []).map(element => {
      const row = byKey.get(element.key);
      if (!row || row.error) return element;
      if(element.managed||element.role==='navigation'||element.key?.startsWith('nf-progress-'))return element;
      // Table flags are independent observations; the table-wide decision below
      // replaces cell noise instead of monotonically accumulating true flags.
      const tableCell=element.tableRole==='cell'||['table-cell','table-header'].includes(element.role);
      const stylePatch = row.style ? {
        italic: tableCell?Boolean(row.italic):element.italic===true||Boolean(row.italic), bold: tableCell?Boolean(row.bold):element.bold===true||Boolean(row.bold),
        parameterEvidence:{...element.parameterEvidence,...Object.fromEntries(['bold','italic'].map(p=>[p,{
          value:row[p]===true,confidence:row.styleConfidence?.[p]==='strong'?.9:row.styleConfidence?.[p]==='weak'?.4:.6,
          independent:true,source:'reference-text-style',observationId:element.key+':'+p}]))},
        ...((row.boldSpans || []).length ? {boldRuns: row.boldSpans} : {}),
      } : {};
      if (row.confident === false) {
        // Titles never carry a measured stroke/outline, even when the colour measurement is not
        // confident enough to override the audit colour.
        const titleOutline = row.kind === 'title' ? {outline: undefined} : {};
        return Object.keys(stylePatch).length || Object.keys(titleOutline).length
          ? {...element, ...stylePatch, ...titleOutline} : element;
      }
      changed += 1;
      if (row.kind === 'title') {
        // Titles never carry a measured stroke/outline: the audit title outline is dropped.
        const {textGradient, ...rest} = element;
        return normalizeTextPaint({...rest, ...stylePatch, color: row.color, outline: undefined,
          gradient: undefined, ...(row.gradient ? {textGradient: row.gradient} : {}), textColorKind: 'title',textPaintMeasured:true});
      }
      return {...element, ...stylePatch, color: row.color, textColorKind: 'body',
        ...((row.colorRuns || []).length ? {textColorRuns: row.colorRuns} : {})};
    });
    return {status: 'ok', elements: normalizeTableTypography(next.map(enforceTextPaintPolicy),{targetKeys:context.targetKeys}).elements, counts: {measured: measured.results?.length || 0, changed},
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
export const assembleStage = delegatedStage('S7-assemble', 'assemble', 'committed native shapes + svg/cutout/image routing');
export const reviewStage = delegatedStage('S8-review', 'review', 'committed render/compare/review loop');
export const deliverStage = delegatedStage('S9-deliver', 'deliver', 'committed PPTX build/download');

// ------------------------------------------------------------------ S3t 表格模板
// Tables are not generic shapes: cells give the grid, and the header band / row bands / grid
// lines are generated as a parameterised template instead of being fitted independently by S3.
// This mirrors the committed approach (content-tree cell boxes + layer order + shared parameters)
// and prevents extra/misaligned grid lines and wrong band fills.
// ------------------------------------------------------------------ S3t 表格模板
// Tables are not generic shapes: cells give the grid, and bands/grid lines are snapped to that
// grid instead of being fitted independently by S3. A page may mix tables with ordinary text /
// decorations, and may contain several tables: each table is detected from its own cell nodeIds and
// only the shapes inside that table region are templated. Everything outside stays untouched.
export async function tableStage(context) {
  const input = context?.elements || [];
  const elements = input.map(element => ({...element}));
  const cellPattern = /-cell-(\d+)-(\d+)$/;
  const groups = new Map();
  for (const element of elements) {
    if (element.type !== 'text') continue;
    const id = String(element.nodeId || element.key || '');
    const match = id.match(cellPattern) || String(element.key || '').match(/-?cell-(\d+)-(\d+)$/);
    if (!match) continue;
    const tableId = (id.replace(cellPattern, '') || String(element.key || '')).replace(/-$/, '');
    if (!groups.has(tableId)) groups.set(tableId, []);
    groups.get(tableId).push({row: Number(match[1]), column: Number(match[2]), element});
  }
  const provided = Array.isArray(context?.tableObjects) ? context.tableObjects : null;
  let tableGroups;
  if (provided && provided.length) {
    // S2 already grouped the table: never re-detect here, only build the work list from annotations.
    const byKey = new Map(elements.map(element => [element.key, element]));
    tableGroups = provided.map(object => ({
      tableId: object.tableId,
      outer: object.outer || null,
      cells: (object.cells || []).map(cell => ({row: Number(cell.row), column: Number(cell.column),
        element: byKey.get(cell.key)})).filter(cell => cell.element),
    })).filter(group => group.cells.length >= 4);
  } else {
    tableGroups = [...groups.entries()].filter(([, cells]) => cells.length >= 4)
      .map(([tableId, cells]) => ({tableId, outer: null, cells}));
  }
  if (!tableGroups.length) return {status: 'skipped', elements: input, reason: 'no-table-cells', counts: null};
  const medianOr = (values, fallback = 0) => {
    const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : fallback;
  };
  const classify = element => {
    const key = String(element.key || '').toLowerCase();
    if (/icon|hex|badge|dot|bullet|logo|gear/i.test(key)) return 'icon';
    if (/deco|ring|slash|glow|halo|spark|arc/.test(key)) return null;
    if (/vline|v-line|vertical|col-line|colsep|col-sep|column-line|col-divider/.test(key)) return 'vline';
    if (/hline|h-line|horizontal|row-line|rowsep|row-sep|row-separator|row-divider|divider/.test(key)) return 'hline';
    if (/header|head-bg|head-band|table-head/.test(key)) return 'header';
    if (/row-?\d|rowband|row-bg|row-fill/.test(key)) return 'rowband';
    if (/base|frame|panel|outer|body-bg|table-bg/.test(key)) return 'base';
    return null;
  };
  const tableLocks = ['width', 'height', 'fill', 'gradientStops', 'gradientAngle',
    'gradientCenter', 'corners', 'strokeWidth', 'strokeColor'];
  const lockTableElement = element => ({...element, _tableStage: true, tablePlaced: true,
    keepParameters: [...new Set([...(element.keepParameters || []), ...tableLocks])]});
  const overlapRatio = (box, element) => {
    const x1 = Math.max(box.x, Number(element.x));
    const y1 = Math.max(box.y, Number(element.y));
    const x2 = Math.min(box.right, Number(element.x) + Number(element.w));
    const y2 = Math.min(box.bottom, Number(element.y) + Number(element.h));
    const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const ownArea = Math.max(1, Number(element.w) * Number(element.h));
    return intersection / ownArea;
  };
  const centerInside = (box, element, pad = 12) => {
    const centerX = Number(element.x) + Number(element.w) / 2;
    const centerY = Number(element.y) + Number(element.h) / 2;
    return centerX >= box.x - pad && centerX <= box.right + pad
      && centerY >= box.y - pad && centerY <= box.bottom + pad;
  };
  const roundCorners = existing => {
    const corners = existing?.shapeGeometry?.corners;
    if (Array.isArray(corners) && corners.length === 4) return corners;
    return [{type: 'round', radius: 0.06}, {type: 'round', radius: 0.06},
      {type: 'round', radius: 0.06}, {type: 'round', radius: 0.06}];
  };
  const snapped = new Map();
  const cellBoxes = new Map();
  const removed = new Set();
  const reorderGroups = [];
  const counts = {tables: 0, cells: 0, rows: 0, columns: 0, snappedBands: 0,
    snappedLines: 0, snappedIcons: 0, removedExtraLines: 0};
  for (const tableGroup of tableGroups) {
    const {tableId, cells, outer} = tableGroup;
    const rowMap = new Map(), columnMap = new Map();
    for (const cell of cells) {
      const box = {x: Number(cell.element.x), y: Number(cell.element.y),
        w: Number(cell.element.w), h: Number(cell.element.h)};
      if (!rowMap.has(cell.row)) rowMap.set(cell.row, []);
      rowMap.get(cell.row).push(box);
      if (!columnMap.has(cell.column)) columnMap.set(cell.column, []);
      columnMap.get(cell.column).push(box);
    }
    // Robust grid: medians ignore one outlier header/label box instead of shifting a whole row.
    const rows = [...rowMap.entries()].sort((a, b) => a[0] - b[0]).map(([row, boxes]) => ({
      row,
      // y from the median (ignore one outlier label), but the bottom must cover the tallest cell
      // so multi-line cell texts fit inside their row instead of overflowing.
      y: Math.round(medianOr(boxes.map(box => box.y))),
      bottom: Math.round(Math.max(medianOr(boxes.map(box => box.y + box.h)),
        ...boxes.map(box => box.y + box.h))),
    }));
    const columns = [...columnMap.entries()].sort((a, b) => a[0] - b[0]).map(([column, boxes]) => ({
      column,
      x: Math.round(medianOr(boxes.map(box => box.x))),
      right: Math.round(Math.max(medianOr(boxes.map(box => box.x + box.w)),
        ...boxes.map(box => box.x + box.w))),
    }));
    if (rows.length < 2 || columns.length < 2) continue;
    let area = {x: Math.min(...columns.map(column => column.x)),
      y: Math.min(...rows.map(row => row.y)),
      right: Math.max(...columns.map(column => column.right)),
      bottom: Math.max(...rows.map(row => row.bottom))};
    // Grid separators sit in the gap between cells, not on the text baseline.
    const horizontalBoundaries = rows.slice(0, -1).map((row, index) => {
      const next = rows[index + 1];
      return Math.round((row.bottom + next.y) / 2);
    });
    const verticalBoundaries = columns.slice(0, -1).map((column, index) => {
      const next = columns[index + 1];
      return Math.round((column.right + next.x) / 2);
    });
    const tableShapes = elements.map((element, index) => ({element, index}))
      .filter(({element}) => ['shape', 'rect', 'ellipse', 'line'].includes(element.type))
      .map(item => ({...item, role: item.element.tableRole || classify(item.element)}))
      .filter(item => item.role && item.element.tableId === tableId);
    const padX = 10, padY = 8;
    const bands = tableShapes.filter(item => ['base', 'header', 'rowband'].includes(item.role));
    for (const role of ['base', 'header']) {
      for (const item of bands.filter(band => band.role === role)) {
        const element = item.element;
        const outerShape = outer?.shape && outer.shape !== 'freeform' ? outer.shape : 'roundRect';
        const outerCorners = outer?.shapeGeometry?.corners || roundCorners(element);
        snapped.set(element.key, role === 'header'
          ? {...element, type: 'shape', shape: outerShape,
            shapeGeometry: {version: 2, corners: outerCorners},
            customGeometry: undefined, x: Math.round(area.x), y: Math.round(rows[0].y),
            w: Math.round(area.right - area.x),
            h: Math.round(rows[0].bottom - rows[0].y)}
          : {...element, type: 'shape', shape: outerShape,
            shapeGeometry: {version: 2, corners: outerCorners},
            customGeometry: undefined, x: Math.round(area.x - padX),
            y: Math.round(area.y - padY),
            w: Math.round(area.right - area.x + padX * 2),
            h: Math.round(area.bottom - area.y + padY * 2)});
        counts.snappedBands += 1;
      }
    }
    // Row bands snap to the row with the largest vertical overlap instead of list order.
    for (const item of bands.filter(band => band.role === 'rowband')) {
      const element = item.element;
      const centerY = Number(element.y) + Number(element.h) / 2;
      let best = rows[0];
      let bestDistance = Infinity;
      for (const row of rows) {
        const distance = Math.abs(centerY - (row.y + row.bottom) / 2);
        if (distance < bestDistance) { bestDistance = distance; best = row; }
      }
      snapped.set(element.key, {...element, x: Math.round(area.x), y: best.y,
        w: Math.round(area.right - area.x), h: Math.round(best.bottom - best.y)});
      counts.snappedBands += 1;
    }
    const horizontalLines = tableShapes.filter(item => item.role === 'hline')
      .sort((first, second) => Number(first.element.y) - Number(second.element.y));
    horizontalLines.forEach((item, order) => {
      if (order >= horizontalBoundaries.length) {
        removed.add(item.element.key); counts.removedExtraLines += 1; return;
      }
      snapped.set(item.element.key, {...item.element, type: 'line', x: Math.round(area.x),
        y: horizontalBoundaries[order], w: Math.round(area.right - area.x), h: 0});
      counts.snappedLines += 1;
    });
    const verticalLines = tableShapes.filter(item => item.role === 'vline')
      .sort((first, second) => Number(first.element.x) - Number(second.element.x));
    verticalLines.forEach((item, order) => {
      if (order >= verticalBoundaries.length) {
        removed.add(item.element.key); counts.removedExtraLines += 1; return;
      }
      snapped.set(item.element.key, {...item.element, type: 'line',
        x: verticalBoundaries[order], y: Math.round(area.y), w: 0,
        h: Math.round(area.bottom - area.y)});
      counts.snappedLines += 1;
    });
    // Icons/hex badges inside the table: keep them in the left gutter of their row so they never
    // overlap the first-column text (the audit often places them on top of the label).
    const iconShapes = tableShapes.filter(item => item.role === 'icon');
    const firstColumn = columns[0];
    for (const item of iconShapes) {
      const element = item.element;
      const centerY = Number(element.y) + Number(element.h) / 2;
      let best = rows[0];
      let bestDistance = Infinity;
      for (const row of rows) {
        const distance = Math.abs(centerY - (row.y + row.bottom) / 2);
        if (distance < bestDistance) { bestDistance = distance; best = row; }
      }
      const width = Number(element.w) || 0;
      const height = Number(element.h) || 0;
      const nextX = Math.round(firstColumn.x - width - 6);
      const nextY = Math.round((best.y + best.bottom) / 2 - height / 2);
      snapped.set(element.key, {...element, x: nextX, y: nextY});
      counts.snappedIcons += 1;
    }
    for (const cell of cells) {
      const row = rows.find(item => item.row === cell.row);
      const column = columns.find(item => item.column === cell.column);
      if (!row || !column) continue;
      cellBoxes.set(cell.element.key, {...cell.element, x: column.x, y: row.y,
        w: Math.max(8, column.right - column.x), h: Math.max(8, row.bottom - row.y)});
    }
    counts.tables += 1;
    counts.cells += cells.length;
    counts.rows += rows.length;
    counts.columns += columns.length;
    reorderGroups.push({tableShapes, snappedKeys: new Set(snapped.keys())});
  }
  const output = elements.filter(element => !removed.has(element.key)).map(element => {
    if (cellBoxes.has(element.key)) return lockTableElement(cellBoxes.get(element.key));
    if (snapped.has(element.key)) return lockTableElement(snapped.get(element.key));
    return element;
  });
  const layerRank = {base: 0, header: 1, rowband: 2, hline: 3, vline: 4, icon: 5};
  for (const group of reorderGroups) {
    const keys = new Set(group.tableShapes.map(item => item.element.key)
      .filter(key => group.snappedKeys.has(key)));
    const positions = [];
    output.forEach((element, index) => { if (keys.has(element.key)) positions.push(index); });
    const ordered = output.filter(element => keys.has(element.key))
      .sort((first, second) => (layerRank[group.tableShapes
        .find(item => item.element.key === first.key)?.role] ?? 9)
        - (layerRank[group.tableShapes.find(item => item.element.key === second.key)?.role] ?? 9));
    positions.forEach((position, order) => { output[position] = ordered[order]; });
  }
  return {status: 'ok', elements: output, counts,
    report: [{tables: counts.tables, cells: counts.cells, rows: counts.rows,
      columns: counts.columns, snappedIcons: counts.snappedIcons}]};
}

// S3 table ownership: shared row/column boundaries and independently measured row fills.
// S2 annotations remain the identity source; generic S4 never repaints accepted row bands.
export async function fitTableObjects(context) {
  return fitTableRows(context);
}
