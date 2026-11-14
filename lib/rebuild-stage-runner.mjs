import {assertStageWrites, validateRegistry} from './rebuild-contract.mjs';

// Compatibility exports: old project flags can be read, but never select another fitter.
export const stagedRebuildEnabled=()=>true;
export const rebuildFittingMode=()=>'replace';

export function stageStatus(records) {
  if (records.some(record => record.status === 'failed')) return 'failed';
  return records.some(record => record.status !== 'ok'
    && !(record.status === 'skipped' && !record.error && /^no-/.test(record.reason || '')))
    ? 'partial' : 'ok';
}

export async function executeRebuildStage(id, run, context) {
  context.signal?.throwIfAborted();
  const before = structuredClone(context.elements || []);
  const started = Date.now();
  let output;
  try {
    output = await run({...context, elements: structuredClone(before)});
  } catch (error) {
    if (context.signal?.aborted || error.aborted || error.name === 'AbortError') throw error;
    output = {status: 'failed', error: String(error.message || error)};
  }
  context.signal?.throwIfAborted();
  const malformed = !output || output.elements !== undefined && !Array.isArray(output.elements);
  const candidate = malformed ? before : output.elements || before;
  const validation = validateRegistry(candidate);
  const violations = assertStageWrites(id, before, candidate);
  const failed = malformed || output?.status === 'failed' || Boolean(output?.error)
    || !validation.ok || violations.length > 0;
  const record = {stage: id, status: failed ? 'failed' : output?.status || 'ok',
    counts: output?.counts || null, coverage: output?.coverage || null,
    reason: output?.reason || null, note: output?.note || null,
    error: output?.error || (malformed ? 'Invalid stage response' : !validation.ok ? 'Invalid element registry' : violations.length ? 'Stage field contract violated' : null),
    violations, rejected: validation.rejected, elapsedMs: Date.now() - started};
  return {...output, elements: failed ? before : candidate, record};
}

export function saveStagedPage(project, index, runId, records, error = null) {
  const previous = project.rebuildStagedResults?.pages || {};
  const record = {runId, status: error ? 'failed' : stageStatus(records), records,
    error, at: new Date().toISOString()};
  const pages = {...previous, [index]: record};
  project.rebuildStagedResults = {pages, status: stageStatus(Object.values(pages))};
  return record;
}
