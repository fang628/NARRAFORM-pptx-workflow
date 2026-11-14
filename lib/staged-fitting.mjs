// Committed native fitting: S2/S3 own geometry throughout the audit repair loop.
// S2 completion and S3 geometry run here; paint is deferred until the audit is accepted.
// Scoped refits preserve unrelated objects and skip page-wide completion.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  completeStage, routeStage, shapeStage,
} from './rebuild-stages.mjs';
import {identifyLightEffects, featherEffectSVG} from './light-effects.mjs';
import {fillAdapter, strokeAdapter} from './rebuild-adapters.mjs';
import {anchorOriginalElements} from './ppt-visual-optimization.mjs';
import {executeRebuildStage,stageStatus} from './rebuild-stage-runner.mjs';
import {commitRebuildTargets} from './rebuild-incremental.mjs';
import {validateAudit} from './visual-model.mjs';
import {normalizeRebuildProgress} from './rebuild-progress.mjs';

const algorithmFiles = [
  'tools/shape_measure.py', 'tools/paint_stage.py', 'tools/shape_registration.py',
  'tools/row_step.py', 'tools/enhance_page.py', 'lib/rebuild-stages.mjs',
  'lib/rebuild-adapters.mjs', 'lib/light-effects.mjs', 'lib/staged-fitting.mjs',
  'lib/rebuild-stage-runner.mjs', 'lib/rebuild-contract.mjs',
  'lib/constrained-fitting.mjs','tools/constrained_shapes.py','lib/scene-hierarchy.mjs',
  'lib/slant-groups.mjs','lib/rebuild-incremental.mjs',
  'lib/recognition-groups.mjs','lib/native-parameter-groups.mjs','lib/parameter-group-policy.mjs',
  'lib/table-objects.mjs','tools/paint_models.py',
  'lib/table-row-fitting.mjs','tools/table_rows.py','lib/text-style-policy.mjs',
  'lib/paint-context.mjs','tools/shape_paint.py','lib/body-fonts.mjs','tools/text_color.py',
  'lib/paint-consensus.mjs','tools/paint_consensus.py',
  'lib/formula-native.mjs','lib/formula-script-fit.mjs','tools/formula_script_fit.py',
  'lib/native-appearance-policy.mjs','tools/native_effects.py',
  'lib/light-bars.mjs',
  'lib/line-path.mjs','lib/line-path-fitting.mjs','tools/line_path_fit.py','tools/line_geometry.py','tools/object_masks.py','tools/stroke_topology.py','tools/path_slant_consensus.py','lib/line-style.mjs',
  'lib/repeated-circles.mjs','tools/circle_paint.py','lib/audit-identities.mjs','lib/script-metrics.mjs',
  'lib/model-tools.mjs',
  'lib/corner-symmetry.mjs',
  'lib/parameter-confidence.mjs','tools/parameter_confidence.py',
  'lib/table-typography.mjs',
  'lib/table-text-layout.mjs',
  'lib/structural-reference.mjs','tools/structural_edges.py',
  'tools/fill_end_alpha.py',
  'tools/arc_light_completion.py',
  'tools/frame_highlight.py',
  'lib/local-components.mjs',
  'lib/audit-preparation.mjs',
  'lib/registered-representation.mjs','lib/rebuild-representation.mjs','lib/native-carriers.mjs',
  'lib/object-masks.mjs','tools/object_masks.py',
  'lib/reference-position.mjs','tools/reference_position.py',
];

function fingerprint({env, project, index, elements, reference, background, targetKeys}) {
  const hash = crypto.createHash('sha256');
  for (const file of algorithmFiles) {
    try { hash.update(fs.readFileSync(path.join(env.root, file))); } catch {}
  }
  hash.update(JSON.stringify({index, elements, targetKeys:targetKeys==null?null:[...targetKeys].sort()}));
  for (const file of [reference, background]) {
    try { hash.update(fs.readFileSync(file)); } catch {}
  }
  return hash.digest('hex').slice(0, 20);
}

function isPassthrough(element) {
  return ['text', 'formula', 'image', 'svg', 'cutout', 'generate', 'crop'].includes(String(element?.type));
}

// A failed content audit does not exempt independently validated geometry from
// S2/S3. Keep the audit partial while fitting the retained scene exactly once.
export async function fitPartialAuditGeometry(context,{fit=stagedFit}={}){
  const {project,index}=context;
  context.signal?.throwIfAborted();
  const result=await fit({...context,targetKeys:null});
  context.signal?.throwIfAborted();
  const elements=validateAudit(normalizeRebuildProgress(project,index,result.elements),project.slides[index],project.visualPages[index].images||[],project,index,{allowPartial:true});
  return {...result,elements,report:{...result.report,partialAudit:true}};
}

export async function stagedFit({env, project, index, elements, reference, background, signal, python, targetKeys}) {
  const originalInput = (elements || []).map(element => ({...element}));
  const originalByKey = new Map(originalInput.map(element => [element.key, element]));
  const cacheDirectory = path.join(env.data, project.id, 'geometry-records', 'staged-fit');
  const fitHash = fingerprint({env, project, index, elements: originalInput, reference, background, targetKeys});
  const cacheFile = path.join(cacheDirectory, 'page-' + (index + 1) + '-' + fitHash + '.json');
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cached.elements) && cached.elements.length) {
        return {elements: cached.elements, changes: cached.changes || [],
          report: {...(cached.report || {}), cache: {hit: true, file: cacheFile}}};
      }
    } catch {}
  }
  let current = originalInput.map(element => ({...element}));
  const records = [];
  const context = {env, project, index, preview: reference, background, signal, gate: true,
    python, targetKeys, adapters: {fill: fillAdapter, stroke: strokeAdapter}};
  // Audit-phase fitting is geometry only: S4/S5 paint runs once after the audit passes (deferred
  // paint), so the audit repair loop never pays for repeated paint measurements.
  // A scoped refit already has a complete registry. Do not rescan the whole page for additions.
  const sequence = [...(targetKeys==null?[['S2-complete',completeStage]]:[]),
    ['S2r-route', routeStage], ['S3-shape', shapeStage]];
  for (const [name, stage] of sequence) {
    const output = await executeRebuildStage(name, stage, {...context, elements: current});
    current = commitRebuildTargets(current,output?.elements||current,targetKeys);
    records.push(output.record);
    if (output.record.status === 'failed' || output.record.error) throw Object.assign(new Error('分阶段几何拟合失败：' + output.record.error+(output.record.rejected?.length?' '+JSON.stringify(output.record.rejected):'')), {stageRecords: records});
  }
  // Light effects: keep measured layered SVG but classify halo/lit-stroke and attach evidence/owner.
  // Effects that were already converted to image/svg assets are identified from their SVG file and
  // receive the same edge feather mask (alpha 0 at the outer edge / both ends).
  let lightEnriched = current.map(element => {
    if (element.type === 'image' && element.implementation === 'svg' && !element.effectKind) {
      try {
        const file = typeof env.getImage === 'function' ? env.getImage(project, element.id) : null;
        if (file && String(file).toLowerCase().endsWith('.svg')) {
          return {...element, type: 'svg', svg: fs.readFileSync(file, 'utf8'), _wasSvgAsset: true};
        }
      } catch {}
    }
    return element;
  });
  lightEnriched = identifyLightEffects(lightEnriched);
  current = lightEnriched.map(element => {
    if (!element?._wasSvgAsset) return element;
    const {svg, _wasSvgAsset, ...rest} = element;
    try {
      if (!String(svg).includes('nf-effect-feather-mask')) {
        const feathered = featherEffectSVG(svg, rest.w, rest.h);
        const file = typeof env.getImage === 'function' ? env.getImage(project, rest.id) : null;
        if (file && String(file).toLowerCase().endsWith('.svg')) fs.writeFileSync(file, feathered);
      }
    } catch {}
    return {...rest, type: 'image', implementation: 'svg'};
  });
  // Text / formula / asset elements are never fitted here: restore the audit originals exactly.
  current = current.map(element => {
    const original = originalByKey.get(element.key);
    if (original && isPassthrough(element) && element.role!=='visual-number' && !element.tableId && !element.tableRole
      && !(element.role === 'effect' || element.visualKind === 'light-effect')) {
      return {...original,...(element.referencePositionEvidence?{x:element.x,y:element.y,referencePositionEvidence:element.referencePositionEvidence}:{})};
    }
    return element;
  });
  try {
    current = anchorOriginalElements(project, index, current);
  } catch {}
  current=commitRebuildTargets(originalInput,current,targetKeys);
  const changes = current.filter(element => {
    const original = originalByKey.get(element.key);
    return original && JSON.stringify(element) !== JSON.stringify(original);
  }).map(element => element.key);
  const unresolved = current.filter(element => element.lowConfidenceGeometry)
    .map(element => ({key: element.key, kind: 'low-confidence-geometry',
      reason: element.lowConfidenceReason || null}));
  const report = {mode: 'staged-replace', stages: records, changes,
    unresolved, cache: {hit: false, file: cacheFile}};
  try {
    if (stageStatus(records) !== 'ok') return {elements: current, changes, report};
    fs.mkdirSync(cacheDirectory, {recursive: true});
    fs.writeFileSync(cacheFile, JSON.stringify({elements: current, changes, report}, null, 1));
  } catch {}
  return {elements: current, changes, report};
}
