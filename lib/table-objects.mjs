// S2 table-object detection: group table cells / frame / header / row bands / grid lines /
// inner icons ONCE per page and annotate them (tableId/tableRole/tableGroup/rowIndex/tableRowKey).
//
// Identity comes from the explicit content-tree `nodeId` (`<table>-cell-<row>-<col>`), never from a
// key naming convention: p10 uses `th-1`/`td-1-0` keys while p11 uses `tbl-data-cell-*` keys with a
// `table-data` frame, and both must resolve to one table object. Shape members are associated
// spatially: a frame/header/row band only exists when its box actually covers the cell grid in the
// right row span, so an enclosing page panel is never mistaken for the table base.
//
// The result is stored as annotations on the elements plus exactly one `tableObject` anchor per
// table. S3 (`fitTableRows` in table-row-fitting.mjs) reads this annotation and never re-detects the
// table. Re-annotation is idempotent and preserves already fitted ownership (fitted/outer/colour
// groups) instead of clearing everything.

const CELL_NODE_PATTERN = /^(.+?)[-_.]cell[-_.]?(\d+)[-_.](\d+)$/i;
const CELL_KEY_PATTERN = /(?:^|[-_.])cell[-_.]?(\d+)[-_.](\d+)$/i;
const HEADER_ROLES = new Set(['table-header', 'table-head', 'header']);
const DECOR_KEYS = /icon|hex|badge|dot|bullet|logo|gear|ring|slash|glow|halo|spark|deco/i;

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

function median(values) {
  const sorted = (values || []).map(Number).filter(Number.isFinite).sort((first, second) => first - second);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function elementBox(element) {
  const x = toNumber(element?.x);
  const y = toNumber(element?.y);
  const w = toNumber(element?.w);
  const h = toNumber(element?.h);
  return {x, y, w, h, right: x + w, bottom: y + h};
}

function boxArea(box) {
  return Math.max(0, box.w) * Math.max(0, box.h);
}

function boxIntersection(first, second) {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  return {x, y, right, bottom, w: Math.max(0, right - x), h: Math.max(0, bottom - y)};
}

function boxContains(outer, inner, pad = 2) {
  return outer.x - pad <= inner.x && outer.y - pad <= inner.y
    && outer.right + pad >= inner.right && outer.bottom + pad >= inner.bottom;
}

function centerInside(box, element, pad = 0) {
  const centerX = toNumber(element.x) + toNumber(element.w) / 2;
  const centerY = toNumber(element.y) + toNumber(element.h) / 2;
  return centerX >= box.x - pad && centerX <= box.right + pad
    && centerY >= box.y - pad && centerY <= box.bottom + pad;
}

function unionBoxes(boxes) {
  const usable = (boxes || []).filter(Boolean);
  if (!usable.length) return {x: 0, y: 0, w: 0, h: 0, right: 0, bottom: 0};
  const x = Math.min(...usable.map(box => box.x));
  const y = Math.min(...usable.map(box => box.y));
  const right = Math.max(...usable.map(box => box.right));
  const bottom = Math.max(...usable.map(box => box.bottom));
  return {x, y, w: right - x, h: bottom - y, right, bottom};
}

function boxFromBounds(bounds) {
  const x = round1(bounds.x);
  const y = round1(bounds.y);
  const right = round1(bounds.right);
  const bottom = round1(bounds.bottom);
  return {x, y, w: round1(right - x), h: round1(bottom - y), right, bottom};
}

function isCarrier(element) {
  return Boolean(element) && ['shape', 'rect', 'ellipse'].includes(element.type);
}

function isDecor(element) {
  return Boolean(element) && (element.managed === true || element.role === 'effect'
    || Boolean(element.effectOf) || element.role === 'navigation');
}

function isHeaderCell(element) {
  return HEADER_ROLES.has(String(element?.tableRole || '').toLowerCase())
    || HEADER_ROLES.has(String(element?.role || '').toLowerCase());
}

function hashString(text) {
  let hash = 2166136261;
  const source = String(text || '');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function stableTableId(cellKeys) {
  return 'table-' + hashString([...cellKeys].sort().join('|'));
}

// Explicit content-tree cell identity. `nodeId` wins; the key pattern is only a last resort for
// elements that carry no nodeId at all, so arbitrary key naming never creates a phantom table.
export function cellIdentity(element) {
  if (!element) return null;
  const nodeId = String(element.nodeId || '');
  if (nodeId) {
    const match = nodeId.match(CELL_NODE_PATTERN);
    if (!match) return null;
    return {tableId: match[1].replace(/[-_.]+$/, ''), row: Number(match[2]),
      column: Number(match[3]), source: 'nodeId'};
  }
  const match = String(element.key || '').match(CELL_KEY_PATTERN);
  if (!match) return null;
  return {tableId: '', row: Number(match[1]), column: Number(match[2]), source: 'key'};
}

function normalizeCellText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\\([a-zA-Z]+)/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function collectContentTreeTables(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'table' && !node.__tableVisited) {
    const headers = Array.isArray(node.headers) ? node.headers : [];
    const rows = Array.isArray(node.rows) ? node.rows : [];
    const allRows = [headers, ...rows];
    const id = String(node.id || 'table');
    // A content-tree table's `headers` array is the header ROW (one cell per column), not a count of
    // header rows. Treating it as a row count used to mark the first data rows as header.
    out.push({id, headerRows: headers.length ? 1 : 0,
      cells: allRows.flatMap((row, rowIndex) => (row || []).map((text, columnIndex) => ({
        row: rowIndex, column: columnIndex, text: normalizeCellText(text),
      }))).filter(cell => cell.text)});
  }
  for (const child of node.children || node.elements || []) collectContentTreeTables(child, out);
}

// Fallback for audits that registered table text without a cell nodeId: match normalized text
// against the content tree table definition and recover row/column from the tree, never from keys.
function cellsFromContentTree(elements, project, index) {
  const slide = project?.slides?.[index];
  if (!slide) return {assigned: new Map(), tables: []};
  const tables = [];
  collectContentTreeTables(slide, tables);
  const byText = new Map();
  for (const table of tables) {
    for (const cell of table.cells) {
      if (!byText.has(cell.text)) byText.set(cell.text, []);
      byText.get(cell.text).push({tableId: table.id, row: cell.row, column: cell.column, used: false});
    }
  }
  const assigned = new Map();
  const texts = (elements || []).filter(element => element?.type === 'text' && element.text)
    .sort((first, second) => (toNumber(first.y) - toNumber(second.y))
      || (toNumber(first.x) - toNumber(second.x)));
  for (const element of texts) {
    if (cellIdentity(element)) continue;
    const text = normalizeCellText(element.text);
    if (!text) continue;
    const candidates = byText.get(text);
    if (!candidates) continue;
    const cell = candidates.find(item => !item.used);
    if (!cell) continue;
    cell.used = true;
    assigned.set(String(element.key || ''), {tableId: cell.tableId, row: cell.row, column: cell.column,
      source: 'content-tree', nodeId: cell.tableId + '-cell-' + cell.row + '-' + cell.column,
      headerRows: tables.find(table => table.id === cell.tableId)?.headerRows || 0});
  }
  return {assigned, tables};
}

function detectCellGroups(elements, {project, index}) {
  const groups = new Map();
  const add = (identity, element) => {
    const key = String(element.key || '');
    if (!key) return;
    const tableId = String(identity.tableId || '');
    if (!groups.has(tableId)) groups.set(tableId, {tableId, source: identity.source, cells: new Map()});
    groups.get(tableId).cells.set(key, {row: Number(identity.row), column: Number(identity.column),
      element, source: identity.source});
  };
  for (const element of elements || []) {
    if (!element || element.managed) continue;
    if (!['text', 'formula'].includes(element.type)) continue;
    const identity = cellIdentity(element);
    if (identity) add(identity, element);
  }
  let treeInfo = {tables: []};
  if (project) {
    const recovered = cellsFromContentTree(elements, project, index);
    treeInfo = recovered;
    for (const [key, identity] of recovered.assigned) {
      const element = elements.find(candidate => String(candidate.key || '') === key);
      if (element) add(identity, element);
    }
  }
  const tables = [];
  for (const group of groups.values()) {
    const cells = [...group.cells.values()];
    if (cells.length < 4) continue;
    const rowCount = new Set(cells.map(cell => cell.row)).size;
    const columnCount = new Set(cells.map(cell => cell.column)).size;
    if (rowCount < 2 || columnCount < 2) continue;
    // Stable id: cells that already share a prior tableId keep it (idempotency); otherwise derive it
    // from the cell keys, never from list order.
    const priorIds = [...new Set(cells.map(cell => String(cell.element.tableId || '')).filter(Boolean))];
    const tableId = group.tableId || (priorIds.length === 1 ? priorIds[0] : '')
      || stableTableId(cells.map(cell => cell.element.key));
    const tree = treeInfo.tables.find(item => item.id === tableId || item.id === group.tableId);
    tables.push({tableId, source: group.source, headerRows: tree?.headerRows || 0, cells});
  }
  return tables;
}

function buildGrid(cells) {
  const rowMap = new Map();
  const columnMap = new Map();
  for (const cell of cells) {
    if (!rowMap.has(cell.row)) rowMap.set(cell.row, []);
    rowMap.get(cell.row).push(cell.element);
    if (!columnMap.has(cell.column)) columnMap.set(cell.column, []);
    columnMap.get(cell.column).push(cell.element);
  }
  const rows = [...rowMap.entries()].sort((first, second) => first[0] - second[0])
    .map(([rowIndex, rowElements]) => {
      const contentTop = Math.min(...rowElements.map(element => toNumber(element.y)));
      const contentBottom = Math.max(...rowElements.map(element => toNumber(element.y) + toNumber(element.h)));
      return {rowIndex, header: rowElements.some(element => isHeaderCell(element)),
        contentTop: round1(contentTop), contentBottom: round1(contentBottom)};
    });
  const columns = [...columnMap.entries()].sort((first, second) => first[0] - second[0])
    .map(([columnIndex, columnElements]) => ({
      columnIndex,
      x: round1(Math.min(...columnElements.map(element => toNumber(element.x)))),
      right: round1(Math.max(...columnElements.map(element => toNumber(element.x) + toNumber(element.w)))),
    }));
  return {rows, columns};
}

// Row slots tile the data area from the cell content boxes: the boundary between two rows is the
// midpoint of their gap. Bands are only generated inside those slots, so page-level bars that
// happen to sit inside a large frame stay outside the table rows.
function rowSlotBoundaries(rows) {
  const tops = rows.map(row => row.contentTop);
  const bottoms = rows.map(row => row.contentBottom);
  const gaps = [];
  for (let index = 1; index < rows.length; index += 1) gaps.push(tops[index] - bottoms[index - 1]);
  const positiveGaps = gaps.filter(gap => gap > 0);
  const gap = positiveGaps.length ? median(positiveGaps) : 16;
  const boundaries = [round1(tops[0] - gap / 2)];
  for (let index = 1; index < rows.length; index += 1) {
    boundaries.push(round1((bottoms[index - 1] + tops[index]) / 2));
  }
  boundaries.push(round1(bottoms[bottoms.length - 1] + gap / 2));
  return {boundaries, gap: round1(gap)};
}

function tableCellBox(cells) {
  return unionBoxes(cells.map(cell => elementBox(cell.element)));
}

// The table base is the *minimal* containing carrier, never an enclosing panel. Panel candidates are
// rejected by geometry (naming-independent): too large relative to the cell area, or too much slack
// above/below the actual row span.
function resolveOuter(list, table, allTables, priorObject) {
  const cellsBox = table.area;
  const rowSpanTop = table.rows[0].y;
  const rowSpanBottom = table.rows[table.rows.length - 1].bottom;
  const rowSpan = Math.max(8, rowSpanBottom - rowSpanTop);
  const otherBoxes = allTables.filter(other => other !== table && other.area && other.area.w > 0)
    .map(other => other.area);
  const candidates = [];
  for (const element of list) {
    if (!isCarrier(element) || isDecor(element)) continue;
    if (element.tableId && element.tableId !== table.tableId) continue;
    const box = elementBox(element);
    if (!boxContains(box, cellsBox, 4)) continue;
    const ratio = boxArea(box) / Math.max(1, boxArea(cellsBox));
    if (ratio < 1.0 || ratio > 2.2) continue;
    if (box.h > rowSpan * 2.0 + 24) continue;
    const topSlack = rowSpanTop - box.y;
    const bottomSlack = box.bottom - rowSpanBottom;
    if (topSlack > Math.max(40, rowSpan * 0.4)) continue;
    if (bottomSlack > Math.max(90, rowSpan * 0.55)) continue;
    if (box.w > cellsBox.w * 2.0 + 40) continue;
    if (otherBoxes.some(other => boxContains(box, other, 4))) continue;
    candidates.push({element, ratio, box});
  }
  candidates.sort((first, second) => (first.ratio - second.ratio)
    || (String(first.element.key) < String(second.element.key) ? -1 : 1));
  const chosen = candidates[0] || null;
  if (chosen) {
    return {outer: {...boxFromBounds(chosen.box), source: 'frame-element',
      confidence: chosen.ratio <= 1.8 ? 0.9 : 0.65, key: chosen.element.key}, issues: []};
  }
  // No trustworthy frame element. Keep the previously fitted base/outer when still valid, otherwise
  // synthesize a conservative padded box from the cells and label it as such.
  const priorBase = priorObject?.baseKey
    ? list.find(element => String(element.key || '') === String(priorObject.baseKey)) : null;
  if (priorBase && isCarrier(priorBase) && boxContains(elementBox(priorBase), cellsBox, 4)) {
    return {outer: {...boxFromBounds(elementBox(priorBase)), source: 'previous-base',
      confidence: 0.65, key: priorBase.key}, issues: []};
  }
  const priorOuter = priorObject?.outer;
  if (priorOuter && ['x', 'y', 'right', 'bottom'].every(field => Number.isFinite(Number(priorOuter[field])))
    && boxContains(boxFromBounds(priorOuter), cellsBox, 4)) {
    return {outer: {...boxFromBounds(priorOuter), source: 'previous-outer', confidence: 0.6}, issues: []};
  }
  const padding = Math.max(6, round1(cellsBox.w * 0.02));
  const outer = boxFromBounds({x: cellsBox.x - padding, y: cellsBox.y - padding,
    right: cellsBox.right + padding, bottom: cellsBox.bottom + padding});
  return {outer: {...outer, source: 'synthesized', confidence: 0.35},
    issues: ['outer-unavailable-synthesized']};
}

function rowSlotAt(table, element, pad = 4) {
  const box = elementBox(element);
  const centerY = box.y + box.h / 2;
  let best = null;
  for (const slot of table.rows) {
    const slotHeight = Math.max(4, slot.bottom - slot.y);
    const denominator = Math.max(1, Math.min(boxArea(box), Math.max(1, box.w) * slotHeight));
    const overlap = boxArea(boxIntersection(box, {x: box.x, y: slot.y, right: box.right,
      bottom: slot.bottom, w: box.w, h: slotHeight})) / denominator;
    if (centerY >= slot.y - pad && centerY <= slot.bottom + pad && overlap >= 0.4) {
      const distance = Math.abs(centerY - (slot.y + slot.bottom) / 2);
      if (!best || distance < best.distance) best = {slot, distance};
    }
  }
  return best?.slot || null;
}

function nearestBoundary(boundaries, value, tolerance) {
  let best = null;
  for (let index = 0; index < boundaries.length; index += 1) {
    const distance = Math.abs(boundaries[index] - value);
    if (distance <= tolerance && (!best || distance < best.distance)) best = {index, distance};
  }
  return best;
}

function associateMembers(list, table, includedKeys) {
  const tableWidth = Math.max(1, table.area.w);
  const tableHeight = Math.max(1, table.area.h);
  const rowSpanTop = table.rows[0].y;
  const rowSpanBottom = table.rows[table.rows.length - 1].bottom;
  // Bands and grid lines must be centred on the table; icons live in the side gutter just outside the
  // cell grid (p10 row icons sit left of the first cell column).
  const strictRegion = {x: table.area.x - 4, y: rowSpanTop - 6, right: table.area.right + 4,
    bottom: rowSpanBottom + 6};
  const gutter = Math.max(48, tableWidth * 0.1);
  const iconRegion = {x: table.area.x - gutter, y: rowSpanTop - 6,
    right: table.area.right + gutter, bottom: rowSpanBottom + 6};
  const maxRowHeight = Math.max(...table.rows.map(slot => slot.bottom - slot.y));
  const horizontalBoundaries = [...table.rows.map(slot => slot.y),
    table.rows[table.rows.length - 1].bottom];
  // Column separators live in the gap between cell boxes, not on the cell edge.
  const verticalBoundaries = [table.columns[0].x];
  for (let index = 1; index < table.columns.length; index += 1) {
    verticalBoundaries.push(round1((table.columns[index - 1].right + table.columns[index].x) / 2));
  }
  verticalBoundaries.push(table.columns[table.columns.length - 1].right);
  const headerSlot = table.rows.find(slot => slot.kind === 'header') || table.rows[0];
  const bands = [];
  const gridLines = [];
  const icons = [];
  const claimed = new Set();
  // Stable ownership first: a grid line already annotated to this table keeps its boundary index even
  // after S3 moved it away from the cell-text midpoint, so re-annotation cannot drop it.
  const priorLineIndices = {hline: new Set(), vline: new Set()};
  for (const element of list) {
    if (!element || String(element.tableId || '') !== table.tableId) continue;
    const role = String(element.tableRole || '');
    if (role !== 'hline' && role !== 'vline') continue;
    const boundaryIndex = Number(element.tableGridExtra?.boundaryIndex);
    const boundaries = role === 'hline' ? horizontalBoundaries : verticalBoundaries;
    if (!Number.isInteger(boundaryIndex) || boundaryIndex < 0 || boundaryIndex >= boundaries.length) continue;
    const box = elementBox(element);
    const center = role === 'hline' ? box.y + box.h / 2 : box.x + box.w / 2;
    gridLines.push({key: String(element.key || ''), role, boundaryIndex,
      offset: round1(center - boundaries[boundaryIndex]), element});
    priorLineIndices[role].add(boundaryIndex);
    claimed.add(element.key);
  }
  const pendingLines = [];
  const ordered = [...list].sort((first, second) => (toNumber(first.y) - toNumber(second.y))
    || (toNumber(first.x) - toNumber(second.x)) || (String(first.key) < String(second.key) ? -1 : 1));
  for (const element of ordered) {
    if (!element || claimed.has(element.key) || includedKeys.has(String(element.key || ''))) continue;
    if (isDecor(element)) continue;
    if (element.tableId && element.tableId !== table.tableId) continue;
    if (!isCarrier(element) && !['line', 'image', 'svg', 'cutout'].includes(element.type)) continue;
    const box = elementBox(element);
    const centerOnTable = centerInside(strictRegion, element, 8);
    // Grid line: thin horizontal/vertical stroke crossing most of the table.
    if (element.type === 'line' || box.h <= 3 || box.w <= 3) {
      if (box.h <= 4 && box.w >= tableWidth * 0.45 && centerOnTable) {
        pendingLines.push({element, role: 'hline', center: box.y + box.h / 2});
        continue;
      }
      if (box.w <= 4 && box.h >= tableHeight * 0.45 && centerOnTable) {
        pendingLines.push({element, role: 'vline', center: box.x + box.w / 2});
        continue;
      }
    }
    // Row band / header band: nearly full table width and confined to one row slot.
    if (isCarrier(element) && box.w >= tableWidth * 0.7 && centerOnTable
      && box.h <= maxRowHeight * 1.8 + 8) {
      const slot = rowSlotAt(table, element, 2);
      if (slot && box.w >= tableWidth * 0.65) {
        bands.push({key: element.key, role: slot.kind === 'header' ? 'header' : 'rowband',
          rowIndex: slot.rowIndex, element});
        claimed.add(element.key);
        continue;
      }
    }
    // Inner icon / badge: small object centred inside one row slot, in the grid or its gutter.
    if (centerInside(iconRegion, element, 6) && box.w <= tableWidth * 0.45
      && box.h <= maxRowHeight * 2.2 + 8
      && boxArea(box) <= tableWidth * maxRowHeight * 0.32) {
      const slot = rowSlotAt(table, element, 2);
      if (slot) {
        icons.push({key: element.key, rowIndex: slot.rowIndex, role: 'icon', element});
        claimed.add(element.key);
      }
    }
  }
  // When every internal separator is present, their order is authoritative: cell-text midpoints can
  // sit several px off the visible divider (p10 col-divider-1 is at 540, not at the text gap 501).
  const assignLines = (role, boundaries) => {
    const expectedInternal = role === 'hline' ? table.rows.length - 1 : table.columns.length - 1;
    const pending = pendingLines.filter(candidate => candidate.role === role)
      .sort((first, second) => first.center - second.center);
    if (!priorLineIndices[role].size && pending.length === expectedInternal
      && pending.every(candidate => candidate.center > boundaries[0] + 4
        && candidate.center < boundaries[boundaries.length - 1] - 4)) {
      pending.forEach((candidate, order) => {
        gridLines.push({key: String(candidate.element.key || ''), role, boundaryIndex: order + 1,
          offset: round1(candidate.center - boundaries[order + 1]), element: candidate.element});
        claimed.add(candidate.element.key);
      });
      return;
    }
    const tolerance = Math.max(8, Math.min(24, tableWidth * 0.06));
    for (const candidate of pending) {
      const match = nearestBoundary(boundaries, candidate.center, tolerance);
      if (!match || priorLineIndices[role].has(match.index)) continue;
      priorLineIndices[role].add(match.index);
      gridLines.push({key: String(candidate.element.key || ''), role, boundaryIndex: match.index,
        offset: round1(candidate.center - boundaries[match.index]), element: candidate.element});
      claimed.add(candidate.element.key);
    }
  };
  assignLines('hline', horizontalBoundaries);
  assignLines('vline', verticalBoundaries);
  // One band per slot: an audit may register duplicated bands; keep the largest one.
  const bySlot = new Map();
  for (const band of bands) {
    const signature = band.role + ':' + band.rowIndex;
    const previous = bySlot.get(signature);
    if (!previous || boxArea(elementBox(band.element)) > boxArea(elementBox(previous.element))) {
      bySlot.set(signature, band);
    }
  }
  const unique = [...bySlot.values()].sort((first, second) => first.rowIndex - second.rowIndex);
  const headerBand = unique.find(band => band.role === 'header')
    || unique.find(band => band.rowIndex === headerSlot.rowIndex) || null;
  const rowBands = unique.filter(band => band !== headerBand);
  return {headerBand, rowBands,
    gridLines: gridLines.sort((first, second) => (first.role === second.role
      ? first.boundaryIndex - second.boundaryIndex
      : (first.role < second.role ? -1 : 1))),
    icons: icons.sort((first, second) => (first.rowIndex - second.rowIndex)
      || (toNumber(first.element.x) - toNumber(second.element.x)))};
}

export function detectTableObjects(elements, {project, index} = {}) {
  const list = (elements || []).filter(Boolean);
  const groups = detectCellGroups(list, {project, index});
  const tables = [];
  for (const group of groups) {
    const grid = buildGrid(group.cells);
    if (grid.rows.length < 2 || grid.columns.length < 2) continue;
    const {boundaries, gap} = rowSlotBoundaries(grid.rows);
    const headerRows = new Set();
    if (group.headerRows > 0) {
      for (let row = 0; row < Math.min(group.headerRows, grid.rows.length); row += 1) headerRows.add(row);
    }
    for (const row of grid.rows) if (row.header) headerRows.add(row.rowIndex);
    const headerEvidence = headerRows.size ? 'role-or-content-tree'
      : (project ? 'content-tree-default' : 'first-row-convention');
    if (!headerRows.size) headerRows.add(grid.rows[0].rowIndex);
    const rows = grid.rows.map((row, order) => ({
      rowIndex: row.rowIndex,
      kind: headerRows.has(row.rowIndex) ? 'header' : 'data',
      y: boundaries[order],
      bottom: boundaries[order + 1],
      contentTop: row.contentTop,
      contentBottom: row.contentBottom,
    }));
    const cellKeys = new Set(group.cells.map(cell => String(cell.element.key || '')));
    const area = tableCellBox(group.cells);
    const table = {tableId: group.tableId, source: group.source, headerEvidence,
      cells: group.cells.map(cell => ({row: cell.row, column: cell.column, element: cell.element})),
      cellKeys, rows, columns: grid.columns, gap, area, memberKeys: new Set(cellKeys)};
    const discovered = associateMembers(list, table, table.cellKeys);
    const memberKeys = new Set([...cellKeys,
      ...(discovered.headerBand ? [discovered.headerBand.key] : []),
      ...discovered.rowBands.map(band => band.key),
      ...discovered.gridLines.map(line => line.key),
      ...discovered.icons.map(icon => icon.key)]);
    table.memberKeys = memberKeys;
    const priorObject = list.find(element => element.tableObject?.tableId === table.tableId)
      ?.tableObject || null;
    const outerInfo = resolveOuter(list, table, tables.concat([table]), priorObject);
    table.headerKey = discovered.headerBand?.key || null;
    table.baseKey = outerInfo.outer.key || null;
    table.rowBands = discovered.rowBands;
    table.gridLines = discovered.gridLines;
    table.icons = discovered.icons;
    table.outer = outerInfo.outer;
    table.issues = [...outerInfo.issues];
    if (!table.headerKey) table.issues.push('header-band-missing');
    table.confidence = round4(Math.min(outerInfo.outer.confidence || 0.3,
      table.headerKey ? 0.9 : 0.55));
    table.members = [
      ...(table.baseKey ? [{key: table.baseKey, role: 'base'}] : []),
      ...(table.headerKey ? [{key: table.headerKey, role: 'header'}] : []),
      ...table.rowBands.map(band => ({key: band.key, role: 'rowband', rowIndex: band.rowIndex})),
      ...table.gridLines.map(line => ({key: line.key, role: line.role, boundaryIndex: line.boundaryIndex})),
      ...table.icons.map(icon => ({key: icon.key, role: 'icon', rowIndex: icon.rowIndex})),
      ...table.cells.map(cell => ({key: String(cell.element.key), role: 'cell', rowIndex: cell.row})),
    ];
    tables.push(table);
  }
  return tables;
}

function structureSignature(table) {
  const rows = table.rows || [];
  const columns = table.columns || [];
  // Cell identity + row-band membership are part of the structure: fitted ownership is only invalidated
  // when the grid, the cell identities or the band set actually changed (never because of list order or
  // a re-detected anchor).
  const cells = (table.cells || []).map(cell => String(cell?.key ?? cell?.element?.key ?? ''));
  const rowBands = Array.isArray(table.rowBandKeys)
    ? table.rowBandKeys.map(String)
    : (table.rowBands || []).map(band => String(band?.key ?? ''));
  return [rows.length, columns.length, cells.length,
    rows.map(row => Number(row.rowIndex)).join(','),
    rows.map(row => String(row.kind || '')).join(','),
    columns.map(column => Number(column.columnIndex)).join(','),
    [...cells].sort().join('|'),
    [...rowBands].sort().join('|')].join(';');
}

function mergeKeys(existing, added) {
  return [...new Set([...(Array.isArray(existing) ? existing : []), ...added])];
}

// Annotate elements in place (returns a new array). Idempotent: re-running on an annotated page
// produces the same tableIds/tableObject, never duplicates members, and keeps a previously fitted
// table's `fitted`/`outer`/colour groups instead of clearing ownership.
export function annotateTableObjects(elements, {project, index} = {}) {
  const list = (elements || []).filter(Boolean).map(element => ({...element}));
  const byKey = new Map(list.map(element => [String(element.key || ''), element]));
  const priorAnchors = new Map();
  for (const element of list) {
    // Keep a plain record: the anchor's fields are deleted below, but the previous tableObject stays
    // referenced so a valid fitted ownership can be carried over.
    if (element?.tableObject?.tableId) {
      priorAnchors.set(String(element.tableObject.tableId),
        {key: String(element.key || ''), tableObject: element.tableObject});
    }
  }
  const tables = detectTableObjects(list, {project, index});
  const tableIds = new Set(tables.map(table => table.tableId));
  const memberByKey = new Map();
  for (const table of tables) {
    for (const member of table.members) {
      if (!member.key || !byKey.has(member.key)) continue;
      memberByKey.set(member.key, {table, member});
    }
  }
  const tableObjects = [];
  // 0) The tableObject anchor is re-created below; a previous anchor may have been any member (e.g.
  //    the first cell text). Capture it first, then drop it everywhere so exactly one anchor remains.
  for (const element of list) delete element.tableObject;
  // 1) Drop stale ownership only. Elements that are no longer members of a detected table lose their
  //    table annotations; previously fitted members are re-detected (bands by geometry) and survive.
  for (const element of list) {
    const priorTable = String(element.tableId || element.tableGroup || '');
    if (!priorTable) continue;
    if (tableIds.has(priorTable) && memberByKey.has(String(element.key || ''))) continue;
    for (const field of ['tableId', 'tableGroup', 'tableRole', 'rowIndex', 'tableRowKey',
      'tableColorGroup', 'tablePaintEvidence', 'tableFittedFill', 'tableObject']) {
      delete element[field];
    }
  }
  // 2) Apply the current annotation.
  for (const table of tables) {
    const priorAnchor = priorAnchors.get(table.tableId) || null;
    const priorObject = priorAnchor?.tableObject || null;
    const fitted = Boolean(priorObject?.fitted) && Boolean(priorObject)
      && structureSignature(priorObject) === structureSignature(table);
    const priorRows = new Map((priorObject?.rows || []).map(row => [Number(row.rowIndex), row]));
    const memberKeys = table.members.map(member => member.key);
    for (const member of table.members) {
      const element = byKey.get(member.key);
      if (!element) continue;
      element.tableId = table.tableId;
      element.tableGroup = table.tableId;
      element.tableRole = member.role;
      if (Number.isInteger(member.rowIndex)) element.rowIndex = member.rowIndex;
      if (member.role === 'cell') element.tableRowKey = table.tableId + ':row:' + member.rowIndex;
      if (!element.parentKey) {
        if (member.role === 'header') element.parentKey = table.baseKey || undefined;
        else if (member.role === 'rowband') element.parentKey = table.baseKey || undefined;
        else if (member.role === 'hline' || member.role === 'vline') element.parentKey = table.baseKey || undefined;
        else if (member.role === 'icon') {
          element.parentKey = table.rowBands.find(band => band.rowIndex === member.rowIndex)?.key
            || table.headerKey || table.baseKey || undefined;
        } else if (member.role === 'cell') {
          element.parentKey = table.rowBands.find(band => band.rowIndex === member.rowIndex)?.key
            || (member.rowIndex === table.rows[0].rowIndex ? table.headerKey : null)
            || table.baseKey || undefined;
        }
        if (!element.parentKey) delete element.parentKey;
      }
      if (!Array.isArray(element.keepParameters)) element.keepParameters = [];
    }
    const base = table.baseKey ? byKey.get(table.baseKey) : null;
    if (base) base.memberKeys = mergeKeys(base.memberKeys, memberKeys.filter(key => key !== table.baseKey));
    const rows = table.rows.map(row => {
      const prior = priorRows.get(row.rowIndex);
      const band = table.rowBands.find(item => item.rowIndex === row.rowIndex);
      return {rowIndex: row.rowIndex, kind: row.kind, y: row.y, bottom: row.bottom,
        contentTop: row.contentTop, contentBottom: row.contentBottom,
        key: band?.key || null, ...(prior?.colorGroup ? {colorGroup: prior.colorGroup} : {})};
    });
    const tableObject = {
      tableId: table.tableId,
      area: {...table.area},
      outer: fitted && priorObject?.outer ? priorObject.outer : {...table.outer},
      baseKey: table.baseKey,
      headerKey: table.headerKey,
      rowBandKeys: table.rowBands.map(band => band.key),
      gridKeys: table.gridLines.map(line => line.key),
      iconKeys: table.icons.map(icon => icon.key),
      rows,
      columns: table.columns.map(column => ({...column})),
      cells: table.cells.map(cell => ({row: cell.row, column: cell.column, key: String(cell.element.key),
        x: round1(cell.element.x), y: round1(cell.element.y),
        w: round1(cell.element.w), h: round1(cell.element.h)})),
      members: table.members.map(member => ({...member})),
      memberKeys,
      headerEvidence: table.headerEvidence,
      source: table.source,
      confidence: table.confidence,
      issues: [...table.issues],
      fitted,
      fittedIssues: fitted ? [] : ['row-fit-pending'],
      ...(fitted && priorObject?.colorGroups ? {colorGroups: priorObject.colorGroups} : {}),
      version: 2,
    };
    const anchor = (table.baseKey ? byKey.get(table.baseKey) : null)
      || (priorAnchor && byKey.has(String(priorAnchor.key)) ? byKey.get(String(priorAnchor.key)) : null)
      || byKey.get(String(table.cells[0].element.key));
    if (!anchor) continue;
    anchor.tableObject = tableObject;
    tableObjects.push(tableObject);
  }
  return {elements: list, tableObjects};
}
