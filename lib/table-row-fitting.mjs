// S3 table row fitting (05-B / 05-E): build real, independent row bands for one or more table
// objects and merge their fill colours by measured visual evidence.
//
// This module owns the S3 side of the table object:
//   * the true table boundary comes from the S2 `tableObject` (frame element / measured outer);
//     text boxes are only internal constraints, never the table edge;
//   * `tools/table_rows.py` detects the grid and colours of all tables of the page in ONE process
//     (existing grid lines / colour steps + cell constraints, excluding text, icons and foreground
//     overlay pixels), and returns a per-row fill + colour group with confidence and error records;
//   * the header row and every data row become independent native rect/shape carriers. There is no
//     single big gradient block that explains all rows;
//   * rows whose measured colours agree inside the tolerance share a robust representative colour,
//     while header rows, alternating groups and emphasis rows are never force-merged (grouping is by
//     measured distance only, never by even/odd index);
//   * the table frame, row bands, grid lines, icons and editable cell texts are re-stacked in the
//     right z-order inside the page; parent panel -> table frame -> rows -> cells is preserved.
//     No text is rasterised and no page is flattened.
//
// Codex integration contract (S3-shape stage, after S2 annotateTableObjects):
//   const fitted = await fitTableRows({env, project, index, preview, elements, background, signal});
//   if (fitted.elements) elements = fitted.elements;
// Element fields written (all are whitelisted for S3-shape in rebuild-contract.mjs):
//   key,type,shape,x,y,w,h,fill,fillOpacity,gradient,tableId,tableGroup,tableRole,rowIndex,
//   tableRowKey,tableColorGroup,tablePaintEvidence,tableObject,memberKeys,parentKey,
//   tableFittedFill,tablePlaced,_tableStage,keepParameters,tableGridExtra,stroke fields untouched.
// Generated element keys are always sanitised to the identity contract ^[a-zA-Z0-9_-]{1,64}$
// (`table-1:row:2` -> `table-1-row-2`, with a stable hash when truncated); the semantic
// tableRowKey/tableColorGroup values keep their `tableId:row:n` / `tableId:g0` form.
// `fitTableRows` never removes text and never creates a table from scratch: it needs the S2 anchors.
//
// context fields: env (root/data), project, index, preview, elements, background, signal,
//   python (optional interpreter path), tableObjects (optional S2 output), rowDetector (test hook:
//   async spec => measurement JSON, used instead of the Python process).
// Return: {status: 'ok'|'partial'|'skipped'|'failed', elements, counts, report, artifacts?, error?}.
// status is only 'ok' when every row fill was measured and the grid was verified; otherwise the
// original geometry is kept for the unreliable rows/table and the reason is reported as partial.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {annotateTableObjects, elementBox} from './table-objects.mjs';
import {tableTextPlacement} from './table-text-layout.mjs';

const run = promisify(execFile);
const SCENE = {width: 1600, height: 900};
const ROW_BAND_LOCKS = ['width', 'height', 'fill', 'fillOpacity', 'gradient', 'gradientStops',
  'gradientAngle', 'gradientCenter', 'strokeWidth', 'strokeColor'];
const LINE_LOCKS = ['strokeWidth', 'color', 'colorOpacity', 'strokeGradient', 'lineEffect'];
const DEFAULT_OPTIONS = {
  colorTolerance: 9, // LAB deltaE; rows closer than this share one representative colour
  gridConfidence: 0.5,
  sampleInset: 0.12,
};

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round1(value) {
  return Math.round(toNumber(value) * 10) / 10;
}

function round4(value) {
  return Math.round(toNumber(value) * 10000) / 10000;
}

function clamp(value, low = 0, high = 1) {
  return Math.min(high, Math.max(low, toNumber(value)));
}

function median(values) {
  const sorted = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Element keys must satisfy the S3 identity contract `^[a-zA-Z0-9_-]{1,64}$`: semantic ids such as
// `table-1:row:2` are mapped to `table-1-row-2` here, deterministically, so a re-run and a collision
// suffix always produce the same legal key. `tableRowKey`/`tableColorGroup` keep the ':' semantic id.
const SAFE_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function keyHash(text) {
  let hash = 2166136261;
  const source = String(text || '');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function sanitizeElementKey(value) {
  const raw = String(value ?? '');
  let key = raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  if (!key) key = 'table-row';
  if (key.length > 64) {
    // Stable truncation: keep a readable prefix plus a hash of the full original, never a timestamp.
    key = key.slice(0, 55).replace(/[-_]+$/g, '') + '-' + keyHash(raw);
  }
  // Defensive: a pathological original may still trim below the cap after the regex.
  if (!SAFE_KEY_PATTERN.test(key)) key = 'table-row-' + keyHash(raw);
  return key;
}

function uniqueKey(existingKeys, base) {
  const safe = sanitizeElementKey(base);
  let key = safe;
  let order = 2;
  while (existingKeys.has(key)) {
    const suffix = '-' + order;
    key = (safe.length + suffix.length > 64 ? safe.slice(0, 64 - suffix.length) : safe) + suffix;
    if (!SAFE_KEY_PATTERN.test(key)) key = sanitizeElementKey(safe + suffix);
    order += 1;
  }
  existingKeys.add(key);
  return key;
}

function hexColor(value) {
  const raw = typeof value === 'string' ? value
    : (value && typeof value === 'object' ? (value.color ?? value.hex ?? value.fill) : null);
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/^#/, '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
  return text.toUpperCase();
}

function parseRgb(value) {
  const hex = hexColor(value);
  if (!hex) return null;
  return [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function rgbDistance(first, second) {
  if (!first || !second) return Infinity;
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

function normalizeGradient(value) {
  if (!value || typeof value !== 'object') return null;
  const stops = (Array.isArray(value.stops) ? value.stops : [])
    .map(stop => ({position: clamp(stop?.position ?? stop?.offset ?? 0),
      color: hexColor(stop?.color), opacity: clamp(stop?.opacity ?? 1)}))
    .filter(stop => stop.color).sort((first, second) => first.position - second.position);
  if (stops.length < 2) return null;
  if(['radial','rectangular'].includes(value.type))return {type:value.type,
    center:{x:clamp(value.center?.x??.5),y:clamp(value.center?.y??.5)},stops};
  return {type: 'linear', angle: round1(value.angle ?? 90), stops};
}

function gradientDistance(first, second) {
  if (!first || !second) return Infinity;
  if(first.type!==second.type)return Infinity;
  if(first.type!=='linear'&&Math.hypot(first.center.x-second.center.x,first.center.y-second.center.y)>.1)return Infinity;
  const angleDelta = Math.abs(first.angle - second.angle);
  if (Math.min(angleDelta, 360 - angleDelta) > 20) return Infinity;
  if (first.stops.length !== second.stops.length) return Infinity;
  let distance = 0;
  for (let index = 0; index < first.stops.length; index += 1) {
    if (Math.abs(first.stops[index].position - second.stops[index].position) > 0.2) return Infinity;
    distance = Math.max(distance, rgbDistance(parseRgb(first.stops[index].color),
      parseRgb(second.stops[index].color)));
  }
  return distance;
}

function isCarrier(element) {
  return Boolean(element) && ['shape', 'rect', 'ellipse'].includes(element.type);
}

function rowElementKind(element) {
  return String(element?.tableRole || '');
}

// S2 annotations are the only source of truth for what the table is. Codex passes the S2 output
// through `context.tableObjects`; when it is not supplied the page is annotated here (same function,
// no re-detection drift).
function tableObjectsFrom(context) {
  const provided = Array.isArray(context.tableObjects) ? context.tableObjects.filter(Boolean) : null;
  if (provided && provided.length) return {tableObjects: provided, annotated: false};
  const annotated = annotateTableObjects(context.elements || [], {project: context.project,
    index: context.index});
  return {annotated: true, elements: annotated.elements, tableObjects: annotated.tableObjects};
}

// Row-band template geometry: the header carrier already encodes the table content width (it is not
// the page panel), so generated row bands share that width. The outer frame is the fallback.
function bandTemplate(elements, tableObject) {
  const byKey = new Map((elements || []).map(element => [String(element.key || ''), element]));
  const outer = tableObject?.outer && ['x', 'y', 'right', 'bottom']
    .every(field => Number.isFinite(Number(tableObject.outer[field]))) ? tableObject.outer : null;
  // The true table extent: measured outer, otherwise the cell grid itself (never the whole page).
  const cellBoxes = (tableObject?.cells || []).filter(cell => cell
    && Number.isFinite(Number(cell.x)) && Number.isFinite(Number(cell.w)));
  const cellSpan = cellBoxes.length
    ? {x: Math.min(...cellBoxes.map(cell => toNumber(cell.x))),
      right: Math.max(...cellBoxes.map(cell => toNumber(cell.x) + toNumber(cell.w)))}
    : {x: 0, right: SCENE.width};
  const fallback = outer ? {x: toNumber(outer.x), right: toNumber(outer.right)} : cellSpan;
  const header = tableObject?.headerKey ? byKey.get(String(tableObject.headerKey)) : null;
  if (header) {
    const box = elementBox(header);
    if (box.w >= Math.max(24, (fallback.right - fallback.x) * 0.6)
      && (!outer || box.w >= (toNumber(outer.right) - toNumber(outer.x)) * 0.6)) {
      return {x: round1(box.x), right: round1(box.right)};
    }
  }
  return fallback;
}

// Sampling exclusions. Only *foreground occluders* may hide pixels:
//   * text/formula -> passed as glyph ZONES (python removes only the glyph ink, keeping the band
//     colour between glyphs; a whole text box would eat a dense header/row);
//   * grid lines -> thin hard boxes;
//   * images/svg/cutout and small native icons -> tight hard boxes;
//   * ancestors / enclosing panels and other lower-layer carriers are NOT occluders. A carrier that
//     contains the whole table (e.g. the enclosing p11 panel) must never zero the table sample.
function excludeBoxesForTable(elements, tableObject) {
  const outer = tableObject?.outer;
  const bounds = outer && ['x', 'y', 'right', 'bottom']
    .every(field => Number.isFinite(Number(outer[field])))
    ? {x: toNumber(outer.x), y: toNumber(outer.y), right: toNumber(outer.right), bottom: toNumber(outer.bottom)}
    : elementBox({x: tableObject?.area?.x, y: tableObject?.area?.y, w: tableObject?.area?.w,
      h: tableObject?.area?.h});
  const boundsArea = Math.max(1, (bounds.right - bounds.x) * (bounds.bottom - bounds.y));
  const bandKeys = new Set(tableObject?.rowBandKeys || []);
  const baseKey = String(tableObject?.baseKey || '');
  const headerKey = String(tableObject?.headerKey || '');
  const iconKeys = new Set(tableObject?.iconKeys || []);
  const boxes = [];
  for (const element of elements || []) {
    if (!element) continue;
    const key = String(element.key || '');
    // The bands themselves are the colour measurement target; the frame underneath them too.
    if (bandKeys.has(key) || key === headerKey || key === baseKey) continue;
    if (element.tableId && String(element.tableId) !== String(tableObject?.tableId || '')) continue;
    if (!['text', 'formula', 'image', 'svg', 'cutout', 'line', 'ellipse', 'shape', 'rect'].includes(element.type)) continue;
    const box = elementBox(element);
    const intersects = box.x < bounds.right && box.right > bounds.x
      && box.y < bounds.bottom && box.bottom > bounds.y;
    if (!intersects) continue;
    // Ancestor panel / full-cover lower carrier: contains the table -> it is behind the table, not an
    // occluder. This is the p11 `panel-left` that previously excluded every table pixel.
    const containsTable = box.x <= bounds.x + 4 && box.y <= bounds.y + 4
      && box.right >= bounds.right - 4 && box.bottom >= bounds.bottom - 4;
    if (containsTable) continue;
    if (['text', 'formula'].includes(element.type)) {
      boxes.push({x: round1(box.x), y: round1(box.y), w: round1(box.w), h: round1(box.h),
        kind: 'text', key});
      continue;
    }
    if (element.type === 'line') {
      // Grid lines are thin; a 1px guard only (a full-height line box must not mask whole columns).
      boxes.push({x: round1(box.x), y: round1(box.y), w: round1(Math.max(1, box.w)),
        h: round1(Math.max(1, box.h)), kind: 'grid', key});
      continue;
    }
    if (['image', 'svg', 'cutout'].includes(element.type)) {
      boxes.push({x: round1(box.x), y: round1(box.y), w: round1(box.w), h: round1(box.h),
        kind: 'asset', key});
      continue;
    }
    // Effect overlays / other native carriers: only a small one can be an above-band occluder. A big
    // carrier is a lower-layer panel/background, not foreground.
    const area = Math.max(0, box.w) * Math.max(0, box.h);
    if (element.role === 'effect' || element.effectOf) {
      if (area <= boundsArea * 0.3) {
        boxes.push({x: round1(box.x), y: round1(box.y), w: round1(box.w), h: round1(box.h),
          kind: 'asset', key});
      }
      continue;
    }
    if (area > boundsArea * 0.2) continue;
    boxes.push({x: round1(box.x), y: round1(box.y), w: round1(box.w), h: round1(box.h),
      kind: iconKeys.has(key) ? 'icon' : 'shape', key});
  }
  return boxes;
}

// One spec for the whole page: the Python tool detects every table grid in a single process.
export function buildTableRowSpec({elements, tableObjects, preview, background, options = {}}) {
  const tables = [];
  for (const tableObject of tableObjects || []) {
    const rows = Array.isArray(tableObject.rows) ? tableObject.rows : [];
    const cells = Array.isArray(tableObject.cells) ? tableObject.cells : [];
    if (!rows.length || !cells.length) continue;
    tables.push({
      tableId: String(tableObject.tableId || ''),
      outer: tableObject.outer && ['x', 'y', 'right', 'bottom']
        .every(field => Number.isFinite(Number(tableObject.outer[field])))
        ? {x: round1(tableObject.outer.x), y: round1(tableObject.outer.y),
          w: round1(toNumber(tableObject.outer.right) - toNumber(tableObject.outer.x)),
          h: round1(toNumber(tableObject.outer.bottom) - toNumber(tableObject.outer.y)),
          source: tableObject.outer.source || 'frame-element'}
        : null,
      rows: rows.map(row => ({rowIndex: Number(row.rowIndex), kind: row.kind || 'data',
        y: round1(row.y), bottom: round1(row.bottom),
        contentTop: round1(row.contentTop ?? row.y), contentBottom: round1(row.contentBottom ?? row.bottom)})),
      columns: (tableObject.columns || []).map(column => ({columnIndex: Number(column.columnIndex),
        x: round1(toNumber(column.x)), right: round1(toNumber(column.right))}))
        .filter(column => Number.isFinite(column.x) && Number.isFinite(column.right)
          && column.right > column.x)
        .sort((first, second) => first.x - second.x),
      cells: cells.map(cell => ({key:cell.key,row: Number(cell.row), column: Number(cell.column),
        x: round1(cell.x), y: round1(cell.y), w: round1(cell.w), h: round1(cell.h)})),
      exclude: excludeBoxesForTable(elements, tableObject),
    });
  }
  return {
    version: 1,
    engine: 'table_rows.py',
    reference: preview ? path.resolve(String(preview)) : null,
    background: background ? path.resolve(String(background)) : null,
    scene: {...SCENE},
    options: {...DEFAULT_OPTIONS, ...options},
    tables,
  };
}

function normalizeMeasurement(measurement) {
  if (!measurement) return null;
  let parsed = measurement;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const tables = Array.isArray(parsed.tables) ? parsed.tables : [];
  return {status: parsed.status || (tables.length ? 'available' : 'unavailable'),
    tables, diagnostics: parsed.diagnostics || null};
}

function normalizeGrid(measurementTable, rows, columns) {
  const grid = measurementTable?.grid || {};
  const boundaries = Array.isArray(grid.boundaries) ? grid.boundaries.map(Number).filter(Number.isFinite) : [];
  const confidence = clamp(grid.confidence ?? 0);
  const monotonic = boundaries.every((value, index) => index === 0 || value > boundaries[index - 1]);
  const usable = boundaries.length === rows.length + 1 && monotonic;
  const verticalBoundaries = Array.isArray(grid.verticalBoundaries)
    ? grid.verticalBoundaries.map(Number).filter(Number.isFinite) : [];
  const sortedColumns = (columns || []).filter(column => column
    && Number.isFinite(Number(column.x)) && Number.isFinite(Number(column.right))
    && Number(column.right) > Number(column.x))
    .sort((first, second) => Number(first.x) - Number(second.x));
  // Annotation column boundaries: left edge, then the gap midpoints, then the right edge.
  const expectedVertical = [];
  if (sortedColumns.length >= 2) {
    expectedVertical.push(Number(sortedColumns[0].x));
    for (let index = 1; index < sortedColumns.length; index += 1) {
      expectedVertical.push((Number(sortedColumns[index - 1].right)
        + Number(sortedColumns[index].x)) / 2);
    }
    expectedVertical.push(Number(sortedColumns[sortedColumns.length - 1].right));
  }
  const widths = sortedColumns.map(column => Number(column.right) - Number(column.x))
    .filter(width => width > 0).sort((first, second) => first - second);
  const medianWidth = widths.length ? widths[Math.floor(widths.length / 2)] : 0;
  const verticalTolerance = Math.max(24, medianWidth * 0.3);
  let verticalUsable = verticalBoundaries.length === expectedVertical.length
    && expectedVertical.length >= 2
    && verticalBoundaries.every((value, index) => index === 0 || value > verticalBoundaries[index - 1]);
  if (verticalUsable) {
    // A boundary that snapped to a garbage profile (e.g. all internal boundaries clamped to the edge
    // of their search window) is not a usable column grid: it must stay distinct AND near the cell
    // constraint it refines. Collapsed 442.5/443.5 boundaries are rejected here, never trusted.
    verticalUsable = verticalBoundaries.every((value, index) =>
      Math.abs(value - expectedVertical[index]) <= verticalTolerance)
      && verticalBoundaries.every((value, index) => index === 0
        || Math.abs(value - verticalBoundaries[index - 1]) >= 4);
  }
  return {boundaries, confidence, usable, verticalBoundaries, verticalUsable,
    expectedVertical, source: grid.source || 'cell-constraints'};
}

// A row may only own a fill / join a colour group when the tool actually measured it: a row record
// with no fill (or an unreliable measurement) must never inherit a colour or a group.
function rowMeasuredEvidence(preparedRow, options = {}) {
  if (!preparedRow?.measurementRow) return false;
  if (preparedRow.measurementRow.reliable === false) return false;
  if (!(preparedRow.fill || preparedRow.gradient)) return false;
  return toNumber(preparedRow.measurementRow.confidence) >= (options.minRowConfidence ?? 0.2);
}

function clusterRows(rows, options = {}) {
  const tolerance = toNumber(options.colorTolerance, DEFAULT_OPTIONS.colorTolerance) * 2.6;
  const items = (rows || []).filter(row => row && !row.header && row.reliable
    && (row.fill || row.gradient));
  const groups = [];
  for (const item of items) {
    const rgb = parseRgb(item.fill);
    let target = null;
    for (const group of groups) {
      const distance = rgb && group.rgb ? rgbDistance(rgb, group.rgb)
        : gradientDistance(item.gradient, group.gradient);
      if (distance <= (rgb ? tolerance : tolerance)) {
        target = {group, distance};
        break;
      }
    }
    if (!target) {
      groups.push({members: [item], rgb, gradient: item.gradient || null, fill: item.fill || null});
    } else {
      target.group.members.push(item);
    }
  }
  // Medoid representative: the member with the lowest total distance, so one noisy row cannot
  // drag the shared colour. Header/alternating/emphasis rows stay in their own cluster because
  // grouping only follows measured distance.
  for (const group of groups) {
    let best = null;
    const sources=group.members.filter(row=>Number(row.measurementRow?.confidence??row.confidence??.6)>=.55);
    for (const candidate of sources) {
      const candidateRgb = parseRgb(candidate.fill);
      const total = sources.reduce((sum, other) => {
        const otherRgb = parseRgb(other.fill);
        const distance = candidateRgb && otherRgb ? rgbDistance(candidateRgb, otherRgb)
          : (candidate.gradient && other.gradient ? gradientDistance(candidate.gradient, other.gradient) : 0);
        return sum + (Number.isFinite(distance) ? distance : 0)*Number(other.confidence??.6);
      }, 0);
      if (!best || total < best.total) best = {member: candidate, total};
    }
    if(!best)continue;
    group.representative = best.member;
    group.fill = group.representative.fill || group.fill;
    group.gradient = group.representative.gradient || null;
  }
  return groups;
}

function decideRowPaint(row, group, options) {
  const gradient = group?.gradient || row?.gradient || null;
  const fill = hexColor(group?.fill ?? row?.fill);
  if (gradient && gradient.stops?.length >= 2) {
    return {fill: gradient.stops[0].color, gradient, method: 'linear-gradient',
      evidence: group && group.members.length > 1 ? 'group-shared' : 'measured'};
  }
  if (fill) {
    return {fill, gradient: null,
      method: group && group.members.length > 1 ? 'group-shared' : 'solid',
      evidence: group && group.members.length > 1 ? 'group-shared' : 'measured'};
  }
  return null;
}

function existingRowBand(elements, tableObject, rowIndex) {
  const annotated = (tableObject.rowBandKeys || []).length
    ? (tableObject.rowBandKeys || []).map(key => elements.find(element => String(element.key || '') === String(key)))
    : [];
  const direct = annotated.find(element => element && Number(element.rowIndex) === rowIndex
    && rowElementKind(element) === 'rowband');
  if (direct) return direct;
  return elements.find(element => element && String(element.tableId || '') === String(tableObject.tableId)
    && rowElementKind(element) === 'rowband' && Number(element.rowIndex) === rowIndex) || null;
}

function existingHeaderBand(elements, tableObject) {
  const key = String(tableObject.headerKey || '');
  if (key) {
    const found = elements.find(element => String(element.key || '') === key);
    if (found) return found;
  }
  return elements.find(element => element && String(element.tableId || '') === String(tableObject.tableId)
    && rowElementKind(element) === 'header') || null;
}

function existingGridLines(elements, tableObject) {
  const byKey = new Map((elements || []).map(element => [String(element.key || ''), element]));
  return (tableObject.members || []).filter(member => member.role === 'hline' || member.role === 'vline')
    .map(member => ({member, element: byKey.get(String(member.key))}))
    .filter(item => item.element);
}

function applyRowBandPaint(element, paint, evidence, group) {
  const next = {...element};
  if (!paint) return next;
  if (paint.gradient) {
    next.gradient = paint.gradient;
    next.fill = paint.fill;
    next.fillOpacity = 1;
  } else {
    next.fill = paint.fill;
    delete next.gradient;
    next.fillOpacity = 1;
  }
  next.tableColorGroup = evidence.colorGroup;
  next.tablePaintEvidence = evidence;
  return next;
}

function snapPaintEvidence({tableId, rowIndex, paint, row, group, measurementRow, source}) {
  const confidence = clamp(measurementRow?.confidence ?? (paint?.evidence === 'group-shared' ? 0.7 : 0.6));
  const groupConfidence = clamp(group?.confidence ?? confidence);
  return {
    source: source || 'table_rows.py',
    method: paint?.method || 'solid',
    colorGroup: String(row?.colorGroup || '').trim() || null,
    rowIndex,
    confidence: round4(Math.min(confidence, groupConfidence || confidence)),
    sampleCount: Number(measurementRow?.samples) || 0,
    coverage: round4(clamp(measurementRow?.coverage ?? 0)),
    error: round4(toNumber(measurementRow?.error)),
    groupError: round4(toNumber(group?.error)),
    groupSize: group?.members?.length || 1,
    representativeRow: Number.isFinite(Number(group?.representative?.rowIndex))
      ? Number(group.representative.rowIndex) : rowIndex,
    evidence: paint?.evidence || 'measured',
    independent:paint?.evidence!=='group-shared',
    inherited:paint?.evidence==='group-shared',
    sources:(group?.members||[]).filter(row=>Number(row.measurementRow?.confidence??row.confidence??.6)>=.55).map(row=>'table-row-'+row.rowIndex),
    ...(measurementRow?.gradientEvidence ? {gradientEvidence: measurementRow.gradientEvidence} : {}),
    ...(tableId ? {tableId} : {}),
  };
}

function rankOf(role) {
  return {base: 0, header: 1, rowband: 2, hline: 3, vline: 4, icon: 5}[role] ?? 9;
}

function stackOneTable(elements, tableObject) {
  const tableId = String(tableObject?.tableId || '');
  if (!tableId) return elements;
  const memberKeys = new Set(elements
    .filter(element => element && String(element.tableId || '') === tableId
      && rankOf(rowElementKind(element)) <= 5)
    .map(element => String(element.key || '')));
  if (!memberKeys.size) return elements;
  const cellKeys = new Set((tableObject.cells || []).map(cell => String(cell.key || '')));
  const firstMember = elements.findIndex(element => memberKeys.has(String(element?.key || '')));
  if (firstMember < 0) return elements;
  const members = elements.filter(element => memberKeys.has(String(element?.key || '')))
    .sort((first, second) => (rankOf(rowElementKind(first)) - rankOf(rowElementKind(second)))
      || (toNumber(first.rowIndex) - toNumber(second.rowIndex))
      || (String(first.key) < String(second.key) ? -1 : 1));
  const nonMembers = elements.filter(element => !memberKeys.has(String(element?.key || '')));
  // Everything painted above the table block (cell texts especially) goes right after it, so the
  // editable text can never be hidden by a generated band/icon.
  const insertion = nonMembers.filter(element => elements.indexOf(element) < firstMember).length;
  const before = nonMembers.slice(0, insertion);
  const after = nonMembers.slice(insertion);
  const cells = after.filter(element => cellKeys.has(String(element?.key || '')));
  const rest = after.filter(element => !cellKeys.has(String(element?.key || '')));
  return [...before, ...members, ...cells, ...rest];
}

// Re-stack only the tables: base -> header -> row bands -> grid lines -> icons -> cell texts. Each
// table block is placed where the table already starts, so the enclosing panel stays behind and the
// page's other objects keep their relative order.
function stackTableMembers(elements, tableObjects) {
  let list = [...elements];
  for (const tableObject of tableObjects || []) list = stackOneTable(list, tableObject);
  return list;
}

function statusFromTables(tableReports, measurementAvailable) {
  if (!tableReports.length) return 'skipped';
  const allOk = tableReports.every(report => report.status === 'ok');
  if (allOk && measurementAvailable) return 'ok';
  return 'partial';
}

function tableStatusOf(issues) {
  return issues.length ? 'partial' : 'ok';
}

// ------------------------------------------------------------------ application
export function applyTableRowMeasurement({elements: input, tableObjects, measurement,
  spec, options = {}, measurementError = null}) {
  const elements = (input || []).map(element => ({...element}));
  const normalized = normalizeMeasurement(measurement);
  const measurementTables = new Map((normalized?.tables || []).map(table => [String(table.tableId || ''), table]));
  const byKey = new Map(elements.map(element => [String(element.key || ''), element]));
  const keys = new Set(elements.map(element => String(element.key || '')));
  const report = [];
  const counts = {tables: 0, rows: 0, headerRows: 0, generatedBands: 0, updatedBands: 0,
    generatedHeaders: 0, colorGroups: 0, fittedTables: 0, partialTables: 0, sampledRows: 0};
  for (const tableObject of tableObjects || []) {
    const tableId = String(tableObject.tableId || '');
    if (!tableId) continue;
    counts.tables += 1;
    const tableForReport = {tableId, status: 'ok', issues: [], rows: [], colorGroups: [],
      outer: tableObject.outer || null, grid: null, generated: [], retained: []};
    const measurementTable = measurementTables.get(tableId) || null;
    const frame=measurementTable?.outer;
    if(frame?.source==='measured-frame-ridges'&&frame.confidence>=.6&&['x','y','w','h'].every(k=>Number.isFinite(frame[k]))){
      tableObject.outer={...tableObject.outer,...frame,key:tableObject.baseKey};
      tableForReport.outer=tableObject.outer;
    }
    // Problems reported by the row tool itself are part of the table status; a tool-level partial can
    // never be upgraded to ok just because JS thresholds happened to pass.
    for (const issue of measurementTable?.issues || []) {
      const text = String(issue || '');
      if (text && !tableForReport.issues.includes(text)) tableForReport.issues.push(text);
    }
    // The supplied table object is authoritative for membership: make sure every listed member is
    // annotated before the geometry/colour work (Codex may pass S2 output with raw elements).
    for (const member of tableObject.members || []) {
      const element = byKey.get(String(member.key || ''));
      if (!element) continue;
      element.tableId = tableId;
      element.tableGroup = tableId;
      element.tableRole = member.role;
      if (Number.isInteger(member.rowIndex)) element.rowIndex = member.rowIndex;
    }
    const rows = (tableObject.rows || []).map(row => ({...row}));
    if (!rows.length) {
      tableForReport.issues.push('no-row-slots');
      tableForReport.status = 'partial';
      report.push(tableForReport);
      counts.partialTables += 1;
      continue;
    }
    const columns = (tableObject.columns || []).map(column => ({...column}));
    const grid = measurementTable ? normalizeGrid(measurementTable, rows, columns) : null;
    let measuredGrid = null;
    if (grid?.usable && grid.confidence >= (options.gridConfidence ?? DEFAULT_OPTIONS.gridConfidence)) {
      // Verified grid: measured boundaries replace the cell-derived slots.
      rows.forEach((row, index) => {
        row.y = round1(grid.boundaries[index]);
        row.bottom = round1(grid.boundaries[index + 1]);
      });
      measuredGrid = {confidence: round4(grid.confidence), source: grid.source,
        boundaries: grid.boundaries.map(round1)};
    } else {
      tableForReport.issues.push(grid ? 'grid-unverified' : 'grid-unavailable');
    }
    // Column separators are independent of row fitting. If the measured column grid is missing,
    // collapsed or far from the cell constraints, the vlines keep their audited positions and the
    // table stays partial instead of trusting a bogus "ok".
    if (measurementTable && columns.length >= 2 && grid && !grid.verticalUsable) {
      tableForReport.issues.push('vertical-grid-invalid');
    }
    tableForReport.grid = measuredGrid
      || {confidence: round4(grid?.confidence ?? 0), source: 'cell-constraints', boundaries: null};
    // Row colour evidence, grouped by measured distance only.
    const measuredRows = new Map();
    for (const row of measurementTable?.rows || []) {
      if (!Number.isFinite(Number(row?.rowIndex))) continue;
      measuredRows.set(Number(row.rowIndex), row);
    }
    const prepared = rows.map(row => {
      const measurementRow = measuredRows.get(Number(row.rowIndex)) || null;
      return {rowIndex: Number(row.rowIndex), header: row.kind === 'header',
        fill: hexColor(measurementRow?.fill ?? measurementRow?.fill?.color)
          || hexColor(measurementRow?.gradient?.stops?.[0]?.color) || null,
        gradient: normalizeGradient(measurementRow?.gradient),
        measurementRow, colorGroup: measurementRow?.colorGroup || null, reliable: false};
    });
    for (const row of prepared) row.reliable = rowMeasuredEvidence(row, options);
    // Colour groups: ONLY rows with real measurement evidence may be grouped or declared. A row with
    // fill=null or an unreliable confidence stays out of every group and gets no representative colour.
    const groups = [];
    const groupByRawId = new Map();
    const declared = (measurementTable?.colorGroups || []).filter(group => group && group.id);
    for (const declaredGroup of declared) {
      const rawId = String(declaredGroup.id);
      const id = rawId.startsWith(tableId) ? rawId : tableId + ':' + rawId;
      const declaredRows = Array.isArray(declaredGroup.rows) ? declaredGroup.rows.map(Number) : [];
      const members = prepared.filter(row => row.reliable
        && (declaredRows.includes(row.rowIndex) || String(row.colorGroup || '') === rawId));
      if (!members.length) continue; // never declare a group whose rows were not measured
      const group = {id, rawId, fill: hexColor(declaredGroup.fill ?? declaredGroup.fillColor),
        gradient: normalizeGradient(declaredGroup.gradient),
        confidence: clamp(declaredGroup.confidence ?? declaredGroup.coverage ?? 0.6),
        error: round4(toNumber(declaredGroup.error)), members,
        representativeRow: Number.isFinite(Number(declaredGroup.representativeRow))
          && members.some(member => member.rowIndex === Number(declaredGroup.representativeRow))
          ? Number(declaredGroup.representativeRow) : members[0].rowIndex};
      // A group without a measured representative paint cannot supply a fill.
      if (!group.fill && !group.gradient) {
        const measured = members.find(member => member.fill || member.gradient);
        group.fill = measured?.fill || null;
        group.gradient = measured?.gradient || null;
      }
      if (!group.fill && !group.gradient) continue;
      groups.push(group);
      groupByRawId.set(rawId, group);
    }
    // A row listed by the tool's group owns that group id when the row itself was measured.
    for (const group of groups) {
      for (const member of group.members) member.colorGroup = group.id;
    }
    for (const row of prepared) {
      if (!row.reliable) continue;
      const raw = row.colorGroup ? String(row.colorGroup) : '';
      const declaredGroup = raw ? groupByRawId.get(raw) : null;
      if (declaredGroup) row.colorGroup = declaredGroup.id;
    }
    const claimed = new Set(groups.flatMap(group => group.members.map(member => member.rowIndex)));
    const unspecified = prepared.filter(row => row.reliable && !claimed.has(row.rowIndex));
    if (unspecified.length) {
      for (const cluster of clusterRows(unspecified, options)) {
        const id = tableId + ':g' + groups.length;
        groups.push({id, fill: cluster.fill, gradient: cluster.gradient, confidence: 0.7,
          error: 0, members: cluster.members, representativeRow: cluster.representative?.rowIndex ?? null});
        for (const member of cluster.members) member.colorGroup = id;
      }
    }
    let groupById = new Map(groups.map(group => [group.id, group]));
    // Header rows are always their own group, and only measured header rows may join it.
    for (const row of prepared) {
      if (!row.header || !row.reliable) continue;
      const current = row.colorGroup ? groupById.get(String(row.colorGroup)) : null;
      if (!current || current.members.some(member => !member.header)) {
        if (current) current.members = current.members.filter(member => !member.header);
        const headerId = tableId + ':header';
        let headerGroup = groupById.get(headerId);
        if (!headerGroup) {
          headerGroup = {id: headerId, fill: row.fill || current?.fill || null,
            gradient: row.gradient || current?.gradient || null,
            confidence: clamp(row.measurementRow?.confidence ?? 0.5), error: 0,
            members: [], representativeRow: row.rowIndex};
          groups.push(headerGroup);
          groupById.set(headerId, headerGroup);
        }
        if (!headerGroup.members.includes(row)) headerGroup.members.push(row);
        row.colorGroup = headerId;
      }
    }
    for (const row of prepared) {
      if (row.header) continue;
      const group = row.colorGroup ? groupById.get(String(row.colorGroup)) : null;
      if (group && group.id === tableId + ':header') {
        row.colorGroup = null;
        group.members = group.members.filter(member => member.header);
      }
    }
    // No group may survive with unmeasured rows only, and no group may claim a fill it does not have.
    for (const group of groups) {
      if (!group.members.length || (!group.fill && !group.gradient)) {
        for (const member of group.members) member.colorGroup = null;
      }
    }
    const activeGroups = groups.filter(group => group.members.length && (group.fill || group.gradient));
    for (const row of prepared) {
      if (row.colorGroup && !activeGroups.some(group => group.id === row.colorGroup)) row.colorGroup = null;
    }
    groupById = new Map(activeGroups.map(group => [group.id, group]));
    counts.colorGroups += activeGroups.length;
    const template = bandTemplate(elements, tableObject);
    // Base frame: always an owned table member. Its fitted geometry is only moved when the S2
    // annotation carries measured outer bounds (a frame element already has that geometry).
    const baseElement = tableObject.baseKey ? byKey.get(String(tableObject.baseKey)) : null;
    if (baseElement) {
      baseElement.tableId = tableId;
      baseElement.tableGroup = tableId;
      baseElement.tableRole = 'base';
      baseElement.tablePlaced = true;
      baseElement._tableStage = true;
      const bounds = tableObject.outer;
      if (bounds && (!bounds.key||bounds.source==='measured-frame-ridges') && ['x', 'y', 'right', 'bottom']
        .every(field => Number.isFinite(Number(bounds[field])))) {
        baseElement.x = round1(bounds.x);
        baseElement.y = round1(bounds.y);
        baseElement.w = round1(toNumber(bounds.right) - toNumber(bounds.x));
        baseElement.h = round1(toNumber(bounds.bottom) - toNumber(bounds.y));
      }
    }
    const headerBand = existingHeaderBand(elements, tableObject);
    const headerRow = rows.find(row => row.kind === 'header') || null;
    // Header band: keep its fitted geometry (it carries the table width), only fill from evidence.
    if (headerRow) {
      counts.headerRows += 1;
      const headerPrepared = prepared.find(row => row.header);
      const headerGroup = headerPrepared?.colorGroup ? groupById.get(String(headerPrepared.colorGroup)) : null;
      const headerPaint = headerPrepared?.reliable
        ? decideRowPaint(headerPrepared, headerGroup, options) : null;
      if (headerBand) {
        if(frame?.source==='measured-frame-ridges')Object.assign(headerBand,{x:frame.x+2,w:frame.w-4,y:round1(headerRow.y),h:round1(headerRow.bottom-headerRow.y)});
        if (headerPaint) {
          const evidence = snapPaintEvidence({tableId, rowIndex: headerRow.rowIndex, paint: headerPaint,
            row: headerPrepared, group: headerGroup, measurementRow: headerPrepared?.measurementRow});
          Object.assign(headerBand, applyRowBandPaint(headerBand, headerPaint, evidence, headerGroup), {
            tableId, tableGroup: tableId, tableRole: 'header', rowIndex: headerRow.rowIndex,
            tableRowKey: tableId + ':row:' + headerRow.rowIndex,
            tableColorGroup: evidence.colorGroup, tablePaintEvidence: evidence,
            tablePlaced: true, _tableStage: true,
            keepParameters: [...new Set([...(headerBand.keepParameters || []), ...ROW_BAND_LOCKS])],
          });
          if (!headerPaint.gradient) delete headerBand.gradient;
          tableForReport.rows.push({rowIndex: headerRow.rowIndex, kind: 'header', key: String(headerBand.key),
            y: round1(headerRow.y), bottom: round1(headerRow.bottom), fill: headerPaint.fill,
            gradient: headerPaint.gradient || null, colorGroup: evidence.colorGroup,
            method: evidence.method, confidence: evidence.confidence, source: 'existing-header'});
        } else {
          tableForReport.retained.push(String(headerBand.key));
          tableForReport.issues.push('header-colour-unmeasured');
        }
        headerBand.tableId = tableId;
        headerBand.tableGroup = tableId;
        headerBand.tableRole = 'header';
        headerBand.rowIndex = headerRow.rowIndex;
        headerBand.tableRowKey = tableId + ':row:' + headerRow.rowIndex;
        headerBand.tablePlaced = true;
        headerBand._tableStage = true;
        headerBand.keepParameters = [...new Set([...(headerBand.keepParameters || []), ...ROW_BAND_LOCKS])];
        headerRow.key = String(headerBand.key);
        if (!headerBand.parentKey && tableObject.baseKey) headerBand.parentKey = tableObject.baseKey;
      } else if (headerPaint) {
        // No header carrier in the audit: create one from the verified row slot.
        const key = uniqueKey(keys, tableId + ':header');
        const created = {
          key, type: 'rect', shape: 'rect',
          x: template.x, y: round1(headerRow.y), w: round1(template.right - template.x),
          h: round1(headerRow.bottom - headerRow.y),
          fill: headerPaint.fill, ...(headerPaint.gradient ? {gradient: headerPaint.gradient} : {}),
          fillOpacity: 1, tableId, tableGroup: tableId, tableRole: 'header',
          rowIndex: headerRow.rowIndex, tableRowKey: tableId + ':row:' + headerRow.rowIndex,
          tableColorGroup: headerPrepared?.colorGroup || tableId + ':header',
          tablePaintEvidence: snapPaintEvidence({tableId, rowIndex: headerRow.rowIndex, paint: headerPaint,
            row: headerPrepared, group: headerGroup, measurementRow: headerPrepared?.measurementRow}),
          parentKey: tableObject.baseKey || undefined,
          tablePlaced: true, _tableStage: true, keepParameters: [...ROW_BAND_LOCKS],
        };
        if (!created.parentKey) delete created.parentKey;
        elements.push(created);
        byKey.set(key, created);
        counts.generatedHeaders += 1;
        headerRow.key = key;
        tableForReport.generated.push(key);
        tableForReport.rows.push({rowIndex: headerRow.rowIndex, kind: 'header', key,
          y: created.y, bottom: round1(headerRow.bottom), fill: headerPaint.fill,
          gradient: headerPaint.gradient || null, colorGroup: created.tableColorGroup,
          method: 'measured', confidence: created.tablePaintEvidence.confidence, source: 'generated-header'});
      } else {
        tableForReport.issues.push('header-band-missing');
      }
    }
    // Data rows: every row becomes its own native carrier.
    for (const row of rows) {
      if (row.kind === 'header') continue;
      counts.rows += 1;
      const preparedRow = prepared.find(item => item.rowIndex === Number(row.rowIndex));
      const group = preparedRow?.colorGroup ? groupById.get(String(preparedRow.colorGroup)) : null;
      const paint = preparedRow?.reliable ? decideRowPaint(preparedRow, group, options) : null;
      const current = existingRowBand(elements, tableObject, Number(row.rowIndex));
      if (preparedRow?.reliable) counts.sampledRows += 1;
      if (paint) {
        const evidence = snapPaintEvidence({tableId, rowIndex: row.rowIndex, paint,
          row: preparedRow, group, measurementRow: preparedRow?.measurementRow});
        if (current) {
          Object.assign(current, applyRowBandPaint(current, paint, evidence, group), {
            tableId, tableGroup: tableId, tableRole: 'rowband', rowIndex: Number(row.rowIndex),
            tableRowKey: tableId + ':row:' + row.rowIndex,
            x: template.x, y: round1(row.y), w: round1(template.right - template.x),
            h: round1(row.bottom - row.y),
            parentKey: tableObject.baseKey || current.parentKey,
            tablePlaced: true, _tableStage: true,
            keepParameters: [...new Set([...(current.keepParameters || []), ...ROW_BAND_LOCKS])],
          });
          if (!paint.gradient) delete current.gradient;
          if (!current.parentKey) delete current.parentKey;
          counts.updatedBands += 1;
          row.key = String(current.key);
          tableForReport.rows.push({rowIndex: Number(row.rowIndex), kind: 'data', key: String(current.key),
            y: round1(row.y), bottom: round1(row.bottom), fill: paint.fill,
            gradient: paint.gradient || null, colorGroup: evidence.colorGroup,
            method: evidence.method, confidence: evidence.confidence, source: 'existing-row'});
        } else {
          const key = uniqueKey(keys, tableId + ':row:' + row.rowIndex);
          const created = {
            key, type: 'rect', shape: 'rect',
            x: template.x, y: round1(row.y), w: round1(template.right - template.x),
            h: round1(row.bottom - row.y),
            fill: paint.fill, ...(paint.gradient ? {gradient: paint.gradient} : {}),
            fillOpacity: 1, tableId, tableGroup: tableId, tableRole: 'rowband',
            rowIndex: Number(row.rowIndex), tableRowKey: tableId + ':row:' + row.rowIndex,
            tableColorGroup: evidence.colorGroup,
            tablePaintEvidence: evidence,
            parentKey: tableObject.baseKey || undefined,
            tablePlaced: true, _tableStage: true, keepParameters: [...ROW_BAND_LOCKS],
          };
          if (!created.parentKey) delete created.parentKey;
          elements.push(created);
          byKey.set(key, created);
          counts.generatedBands += 1;
          row.key = key;
          tableForReport.generated.push(key);
          tableForReport.rows.push({rowIndex: Number(row.rowIndex), kind: 'data', key,
            y: created.y, bottom: round1(row.bottom), fill: paint.fill,
            gradient: paint.gradient || null, colorGroup: evidence.colorGroup,
            method: evidence.method, confidence: evidence.confidence, source: 'generated-row'});
        }
      } else if (current) {
        // No colour evidence for this row: keep the existing carrier untouched (never invent a fill).
        tableForReport.retained.push(String(current.key));
        tableForReport.issues.push('row-colour-unmeasured:' + row.rowIndex);
      } else {
        tableForReport.issues.push('row-carrier-unavailable:' + row.rowIndex);
      }
    }
    // Grid lines snap to the verified boundaries; their paint is not changed here. Every line keeps its
    // tableRole/boundaryIndex even when the measured grid is unusable (partial, no geometry claim).
    const snappedVerticalXs = new Set();
    for (const {member, element} of existingGridLines(elements, tableObject)) {
      const boundaryIndex = Number(member.boundaryIndex);
      if (!Number.isInteger(boundaryIndex)) continue;
      let snapped = false;
      if (member.role === 'hline') {
        if (measuredGrid && boundaryIndex >= 0 && boundaryIndex < measuredGrid.boundaries.length) {
          element.type = 'line';
          element.x = template.x;
          element.y = round1(measuredGrid.boundaries[boundaryIndex]);
          element.w = round1(template.right - template.x);
          element.h = 0;
          snapped = true;
        }
      } else {
        const verticalBoundaries = grid?.verticalUsable ? grid.verticalBoundaries : null;
        // Only internal separators are placed from the column grid; the two outer edges stay on the
        // frame. Two separators collapsing onto one x means the column grid is unusable: keep the
        // audited distinct positions and report it instead of trusting the measurement.
        if (verticalBoundaries && boundaryIndex > 0
          && boundaryIndex < verticalBoundaries.length - 1) {
          const measuredX = round1(verticalBoundaries[boundaryIndex]);
          if (snappedVerticalXs.has(measuredX)) {
            tableForReport.issues.push('vertical-boundary-collapsed');
          } else {
            snappedVerticalXs.add(measuredX);
            element.type = 'line';
            element.x = measuredX;
            element.y = round1(rows[0]?.y ?? element.y);
            element.w = 0;
            element.h = round1((rows[rows.length - 1]?.bottom ?? element.y) - (rows[0]?.y ?? element.y));
            snapped = true;
          }
        }
      }
      element.tableId = tableId;
      element.tableGroup = tableId;
      element.tableRole = member.role;
      element.tableGridExtra = {role: member.role, boundaryIndex, snapped};
      element.parentKey = tableObject.baseKey || element.parentKey;
      if (!element.parentKey) delete element.parentKey;
      element.tablePlaced = true;
      element._tableStage = true;
      element.keepParameters = [...new Set([...(element.keepParameters || []), ...LINE_LOCKS])];
    }
    // Icons: keep their fitted geometry, only re-attach the row relation/z-order.
    const icons = (tableObject.members || []).filter(member => member.role === 'icon');
    for (const icon of icons) {
      const element = byKey.get(String(icon.key));
      if (!element) continue;
      element.tableId = tableId;
      element.tableGroup = tableId;
      element.tableRole = 'icon';
      if (Number.isInteger(icon.rowIndex)) element.rowIndex = icon.rowIndex;
      // Use the post-fit row list: the row key set in this call is what an icon must hang off.
      const iconRow = rows.find(row => Number(row.rowIndex) === Number(icon.rowIndex));
      element.parentKey = iconRow?.key || tableObject.headerKey || tableObject.baseKey
        || element.parentKey;
      if (!element.parentKey) delete element.parentKey;
      element.tablePlaced = true;
      element._tableStage = true;
    }
    // Cell texts: keep the exact same element and text (editable), only fix the row relation.
    const alignments=new Map((measurementTable?.alignment||[]).filter(a=>a.key&&a.confidence>=.55).map(a=>[a.key,a]));
    for (const cell of tableObject.cells || []) {
      const element = byKey.get(String(cell.key || ''));
      if (!element) continue;
      const measured=alignments.get(element.key);
      if(measured&&['left','center','right'].includes(measured.align)){
        Object.assign(element,tableTextPlacement(element,measured));
      }
      element.tableId = tableId;
      element.tableGroup = tableId;
      element.tableRole = element.tableRole || 'cell';
      element.rowIndex = Number(cell.row);
      element.tableRowKey = tableId + ':row:' + Number(cell.row);
      const band = rows.find(row => Number(row.rowIndex) === Number(cell.row));
      const bandElement = band && band.key ? byKey.get(String(band.key)) : null;
      if (bandElement) element.parentKey = String(bandElement.key);
      else if (!element.parentKey && tableObject.baseKey) element.parentKey = tableObject.baseKey;
    }
    tableForReport.colorGroups = activeGroups.map(group => ({
      id: group.id, fill: group.fill || null, gradient: group.gradient || null,
      rows: group.members.map(member => member.rowIndex).sort((a, b) => a - b),
      size: group.members.length, representativeRow: group.representativeRow ?? null,
      confidence: round4(group.confidence ?? 0.6), error: round4(group.error ?? 0)}));
    const dataRows = rows.filter(row => row.kind === 'data');
    const headerRows = rows.filter(row => row.kind === 'header');
    const reliableFor = row => prepared.find(item => item.rowIndex === Number(row.rowIndex))?.reliable === true;
    // Completion is evidence-based, not record-count-based: every data row AND the header row must
    // have a reliable colour measurement, the grid must be verified, and there may be no unresolved
    // issue. A row record with null fill / low confidence can never be reported as fitted.
    const complete = dataRows.length > 0 && dataRows.every(reliableFor)
      && headerRows.every(reliableFor) && Boolean(measuredGrid)
      && !tableForReport.issues.length;
    tableForReport.status = tableStatusOf(tableForReport.issues);
    const fitted = complete;
    if (fitted) counts.fittedTables += 1;
    else counts.partialTables += 1;
    tableForReport.fitted = fitted;
    // Persist the fitted table object on its S2 anchor and accept fill ownership for later stages.
    const anchor = (tableObject.baseKey ? byKey.get(String(tableObject.baseKey)) : null)
      || elements.find(element => String(element?.tableObject?.tableId || '') === tableId) || null;
    const nextRows = rows.map(row => {
      const reported = tableForReport.rows.find(item => Number(item.rowIndex) === Number(row.rowIndex));
      const band = reported?.key ? byKey.get(String(reported.key)) : null;
      return {...row, kind: row.kind, key: band ? String(band.key) : (row.key || null),
        ...(reported?.colorGroup ? {colorGroup: reported.colorGroup} : {})};
    });
    // Rebuild the complete member roster from the post-fit elements so a re-run (or a re-annotation)
    // sees one consistent table object, including the row carriers generated in this call.
    const fittedRowBands = nextRows.filter(row => row.kind === 'data' && row.key)
      .map(row => ({key: String(row.key), role: 'rowband', rowIndex: Number(row.rowIndex)}));
    const gridMembers = (tableObject.members || [])
      .filter(member => member.role === 'hline' || member.role === 'vline')
      .map(member => ({key: String(member.key), role: member.role, boundaryIndex: member.boundaryIndex}));
    const iconMembers = (tableObject.members || []).filter(member => member.role === 'icon')
      .map(member => ({key: String(member.key), role: 'icon', rowIndex: member.rowIndex}));
    const cellMembers = (tableObject.cells || []).map(cell => ({key: String(cell.key), role: 'cell',
      rowIndex: Number(cell.row)}));
    const memberKeys = [...new Set([
      ...(tableObject.baseKey ? [String(tableObject.baseKey)] : []),
      ...(headerBand ? [String(headerBand.key)] : []),
      ...fittedRowBands.map(member => member.key),
      ...gridMembers.map(member => member.key),
      ...iconMembers.map(member => member.key),
      ...cellMembers.map(member => member.key),
    ])];
    const nextObject = {
      ...(tableObject || {}),
      rows: nextRows,
      rowBandKeys: fittedRowBands.map(member => member.key),
      ...(headerBand ? {headerKey: String(headerBand.key)} : {}),
      members: [
        ...(tableObject.baseKey ? [{key: String(tableObject.baseKey), role: 'base'}] : []),
        ...(headerBand ? [{key: String(headerBand.key), role: 'header'}] : []),
        ...fittedRowBands,
        ...gridMembers,
        ...iconMembers,
        ...cellMembers,
      ],
      memberKeys,
      colorGroups: tableForReport.colorGroups,
      paintSource: measurementTable ? 'table_rows.py' : (measurementError ? 'unavailable' : 'none'),
      gridConfidence: tableForReport.grid.confidence,
      fitted,
      fittedIssues: fitted ? [] : tableForReport.issues.slice(),
      status: tableForReport.status,
      version: 2,
    };
    if (anchor) {
      anchor.tableObject = nextObject;
      if (memberKeys.length) {
        anchor.memberKeys = memberKeys.filter(key => key !== String(tableObject.baseKey || ''));
      }
    }
    if (fitted) {
      for (const element of elements) {
        if (!element || String(element.tableId || '') !== tableId) continue;
        // Fill ownership belongs to the table's carriers/grid/icons; text keeps its own text paint
        // pipeline (S5b) and must never be marked as a fitted table fill.
        if (['text', 'formula'].includes(element.type)||element.tableRole==='icon') continue;
        element.tableFittedFill = true;
        if (element.tablePaintEvidence) element.tablePaintEvidence = {...element.tablePaintEvidence, fitted: true};
      }
    }
    report.push(tableForReport);
  }
  const status = statusFromTables(report, Boolean(normalized && (normalized.tables || []).length));
  const ordered = stackTableMembers(elements, tableObjects);
  // `fillMeasured` keeps the S3 report field used by rebuild-stages; a table counts as fitted fill
  // ownership only when every data row and the header were actually measured.
  counts.fillMeasured = counts.fittedTables;
  return {
    status,
    elements: ordered,
    counts,
    report,
    ...(normalized ? {measurementStatus: normalized.status} : {}),
    ...(measurementError ? {measurementError: String(measurementError.message || measurementError).slice(0, 300)} : {}),
    specTables: spec?.tables?.length || 0,
  };
}

async function runPythonTool({context, spec}) {
  const {env, project, index, signal} = context;
  if (!env?.root || !env?.data || !project?.id) throw Error('table-row-tool-environment-missing');
  const directory = path.join(env.data, String(project.id), 'geometry-records', 'table-rows',
    'page-' + (toNumber(index) + 1), crypto.randomUUID());
  fs.mkdirSync(directory, {recursive: true});
  const specFile = path.join(directory, 'spec.json');
  const outputFile = path.join(directory, 'rows.json');
  fs.writeFileSync(specFile, JSON.stringify(spec, null, 1));
  const python = context.python || process.env.PPT_AGENT_PYTHON
    || path.join(env.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  signal?.throwIfAborted?.();
  await (env.run||run)(python, [path.join(env.root, 'tools', 'table_rows.py'), specFile, outputFile],
    {cwd: env.root, windowsHide: true, timeout: 120000, signal});
  signal?.throwIfAborted?.();
  const measurement = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  return {measurement, artifacts: {spec: specFile, output: outputFile, directory}};
}

export async function fitTableRows(context = {}) {
  const {env, project, index, preview, background} = context;
  const input = Array.isArray(context.elements) ? context.elements : null;
  if (!input) {
    return {status: 'failed', elements: [], counts: {tables: 0}, report: [],
      error: 'missing-elements'};
  }
  const annotated = tableObjectsFrom(context);
  let elements = annotated.elements || input;
  const requested=context.targetKeys==null?null:new Set(context.targetKeys);
  const tableObjects = (annotated.tableObjects || []).filter(object => object
    && Array.isArray(object.rows) && Array.isArray(object.cells) && object.cells.length
    &&(!requested||(object.members||[]).some(member=>requested.has(member.key))||requested.has(object.baseKey)));
  if (!tableObjects.length) {
    return {status: 'skipped', elements: annotated.elements || input, counts: {tables: 0},
      report: [], reason: 'no-table-objects'};
  }
  const foundation = project?.visualPages?.[index]?.foundation?.file;
  const backgroundFile = background || (foundation && env?.data && project?.id
    ? path.join(env.data, String(project.id), foundation) : null);
  const spec = buildTableRowSpec({elements, tableObjects, preview: preview || null,
    background: backgroundFile || null, options: context.tableRowOptions || {}});
  let measurement = null;
  let measurementError = null;
  let artifacts = null;
  try {
    if (typeof context.rowDetector === 'function') {
      measurement = await context.rowDetector(spec, {...context});
    } else if (spec.tables.length) {
      const tool = await runPythonTool({context, spec});
      measurement = tool.measurement;
      artifacts = tool.artifacts;
    }
  } catch (error) {
    if (context.signal?.aborted) throw error;
    measurementError = error;
  }
  const applied = applyTableRowMeasurement({elements, tableObjects, measurement, spec,
    options: context.tableRowOptions || {}, measurementError});
  return {
    ...applied,
    ...(annotated.annotated ? {annotated: true} : {}),
    ...(artifacts ? {artifacts} : {}),
  };
}
