// Figure completeness and panel boundaries for 01 material extraction.
// Native placement bboxes (PDF embedded images / PPTX objects) complete vision half-boxes;
// captions from the real text layer anchor whole figures; a figure is split into panels only
// with several independent evidence types (panel labels or a panel-list caption, plus blank
// separators and separated content cells). A single coordinate system, flowchart or one image
// with ordinary whitespace is never split by geometry alone.
export const figureLimits = Object.freeze({nativeImageMaxArea: 600000, compositeMaxArea: 900000, figureMaxArea: 850000, minPanelFraction: 0.08, scannedPageArea: 650000});

const validBox = box => box && ['x', 'y', 'w', 'h'].every(key => typeof box[key] === 'number' && Number.isFinite(box[key])) && box.x >= 0 && box.y >= 0 && box.w >= 1 && box.h >= 1 && box.x + box.w <= 1000.01 && box.y + box.h <= 1000.01 ? {x: box.x, y: box.y, w: box.w, h: box.h} : null;
export const figureBox = validBox;
export const boxArea = box => box ? box.w * box.h : 0;
export const unionBox = (...boxes) => {
  const list = boxes.filter(Boolean);
  if (!list.length) return null;
  const x = Math.min(...list.map(box => box.x)), y = Math.min(...list.map(box => box.y));
  const right = Math.max(...list.map(box => box.x + box.w)), bottom = Math.max(...list.map(box => box.y + box.h));
  return validBox({x, y, w: right - x, h: bottom - y});
};
export const intersectionArea = (a, b) => a && b ? Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)) : 0;
export const overlapFraction = (inner, outer) => inner ? intersectionArea(inner, outer) / (boxArea(inner) || 1) : 0;
export const centerInside = (inner, outer) => !!inner && !!outer && inner.x + inner.w / 2 >= outer.x && inner.x + inner.w / 2 <= outer.x + outer.w && inner.y + inner.h / 2 >= outer.y && inner.y + inner.h / 2 <= outer.y + outer.h;
export const clampBox = box => box ? validBox({x: Math.max(0, box.x), y: Math.max(0, box.y), w: Math.min(1000 - Math.max(0, box.x), box.w), h: Math.min(1000 - Math.max(0, box.y), box.h)}) : null;
const expand = (box, ratio) => box ? {x: box.x - box.w * ratio, y: box.y - box.h * ratio, w: box.w * (1 + ratio * 2), h: box.h * (1 + ratio * 2)} : null;
const objectPageBox = box => box && ['x', 'y', 'w', 'h'].every(key => typeof box[key] === 'number' && Number.isFinite(box[key])) ? {x: box.x * 1000 / 1600, y: box.y * 1000 / 900, w: box.w * 1000 / 1600, h: box.h * 1000 / 900} : null;

const figureCaptionPattern = /^\s*(?:(图|圖)\s*([0-9]+(?:[.\-–—][0-9]+)*)|(figure|fig\.?)\s*([0-9]+(?:[.\-–—][0-9]+)*))/i;
const tableCaptionPattern = /^\s*(?:表|table|tab\.?)\s*[0-9]/i;
const panelLabelPattern = /^\s*(?:[（(]\s*(?:[a-zA-Z]|[0-9]{1,2}|[ivxIVX]{1,4})\s*[)）]|[a-zA-Z][)）]|[a-zA-Z](?:[.、])?)\s*[:：.]?\s*\S{0,30}$/;
const captionPanelPattern = /[（(]\s*([a-zA-Z])\s*[)）]/g;

export function parseFigureCaption(text) {
  const value = String(text || '').trim();
  if (!value || tableCaptionPattern.test(value)) return null;
  const match = value.match(figureCaptionPattern);
  if (!match) return null;
  const chinese = !!match[1];
  const number = (chinese ? match[2] : match[4]).replace(/[–—]/g, '-');
  const label = chinese ? '图' : /^fig/i.test(match[3]) ? 'Fig' : 'Figure';
  return {key: 'figure:' + number, label, number, text: value.slice(0, 600)};
}
export function captionPanelLetters(text) {
  const letters = [...String(text || '').matchAll(captionPanelPattern)].map(match => match[1].toLowerCase());
  return [...new Set(letters)];
}
export function parsePanelLabel(text) {
  const value = String(text || '').trim();
  if (!value || value.length > 48 || tableCaptionPattern.test(value)) return null;
  if (!panelLabelPattern.test(value)) return null;
  const bracketed = value.match(/[（(]\s*([a-zA-Z0-9ivxIVX]{1,4})\s*[)）]/);
  const suffix = value.match(/^([a-zA-Z])[)）]/);
  const standalone = value.match(/^([a-zA-Z])(?:[.、])?$/);
  const token = (bracketed ? bracketed[1] : suffix ? suffix[1] : standalone ? standalone[1] : '').toLowerCase();
  if (!token) return null;
  return {token, text: value};
}
// Real text-layer labels win; vision labels only fill in when the text layer has fewer than
// two distinct panel labels. Duplicate tokens never become extra evidence.
export function mergePanelLabels(nativeLabels, visualLabels) {
  const unique = labels => {
    const seen = new Set(), result = [];
    for (const label of labels || []) {
      if (!label || !label.box || !label.token || seen.has(label.token)) continue;
      seen.add(label.token);
      result.push(label);
    }
    return result;
  };
  const native = unique(nativeLabels);
  if (native.length >= 2) return native;
  const merged = unique([...native, ...(visualLabels || [])]);
  return merged.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}
const dedupeByBox = items => {
  const seen = new Set(), result = [];
  for (const item of items) {
    const key = JSON.stringify([item.text || '', item.box]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
};
export function pdfPageAnchors(page) {  const captions = dedupeByBox((page?.captions || []).map(item => {const parsed = parseFigureCaption(item.text); return parsed ? {...parsed, box: figureBox(item.box)} : null;}).filter(Boolean)).filter(item => item.box);
  const panels = dedupeByBox((page?.panels || []).map(item => {const parsed = parsePanelLabel(item.text); return parsed ? {...parsed, box: figureBox(item.box)} : null;}).filter(Boolean)).filter(item => item.box);
  return {captions, panels};
}
export function pptPageAnchors(page) {
  const captions = [], panels = [];
  for (const object of page?.objects || []) {
    const box = objectPageBox(object.box);
    const text = String(object.text || '').trim();
    if (!box || !text) continue;
    for (const line of text.split('\n').map(value => value.trim()).filter(Boolean)) {
      const caption = parseFigureCaption(line);
      if (caption) {captions.push({...caption, box}); continue;}
      const panel = parsePanelLabel(line);
      if (panel) panels.push({...panel, box});
    }
  }
  return {captions: dedupeByBox(captions), panels: dedupeByBox(panels)};
}
// Caption directly under (preferred) or above the figure, horizontally overlapping it.
export function nearestFigureCaption(box, captions) {
  if (!box) return null;
  let best = null, bestScore = Infinity;
  for (const caption of captions || []) {
    if (!caption.box) continue;
    const horizontal = Math.max(0, Math.min(box.x + box.w, caption.box.x + caption.box.w) - Math.max(box.x, caption.box.x));
    const overlap = horizontal / Math.max(1, Math.min(box.w, caption.box.w));
    if (overlap < 0.25) continue;
    const below = caption.box.y - (box.y + box.h);
    const above = box.y - (caption.box.y + caption.box.h);
    const gap = below >= -8 ? below : above >= -8 ? above + 12 : Infinity;
    if (gap < 0 || gap > 140) continue;
    const score = gap + (below < -8 ? 40 : 0);
    if (score < bestScore) {best = caption; bestScore = score;}
  }
  return best;
}
export function panelLabelsInFigure(box, panels) {
  if (!box) return [];
  const target = expand(box, 0.06);
  return (panels || []).filter(panel => centerInside(panel.box, target)).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}
export function panelEvidence(group) {
  const seen = new Set(), labels = [];
  for (const label of group.labels || []) {
    if (!label?.box || !label.token || seen.has(label.token)) continue;
    seen.add(label.token);
    labels.push(label);
  }
  const captionLetters = captionPanelLetters(group.captionAnchor?.text || '');
  const groupPictures = group.groupPictures || 0;
  if (labels.length >= 2) {
    const letters = [...new Set(labels.map(label => label.token))];
    if (captionLetters.length >= 2 && !captionLetters.every(letter => letters.includes(letter))) return {count: 0, kind: 'conflict', labels, letters};
    return {count: labels.length, kind: 'labels', labels, letters, captionLetters};
  }
  if (groupPictures >= 2) return {count: groupPictures, kind: 'group-pictures', labels, letters: [], captionLetters};
  if (captionLetters.length >= 2) return {count: captionLetters.length, kind: 'caption', labels: [], letters: captionLetters, captionLetters};
  return {count: 0, kind: 'none', labels, letters: [], captionLetters};
}
const center = box => ({x: box.x + box.w / 2, y: box.y + box.h / 2});
const axisCenter = (box, axis) => axis === 'vertical' ? box.x + box.w / 2 : box.y + box.h / 2;
const axisStart = (box, axis) => axis === 'vertical' ? box.x : box.y;
const axisSize = (box, axis) => axis === 'vertical' ? box.w : box.h;

function candidateCells(analysis, orientation) {
  if (orientation === 'grid') {
    const columns = analysis.verticalCells || [], rows = analysis.horizontalCells || [];
    if (columns.length < 2 || rows.length < 2) return [];
    return columns.flatMap(column => rows.map(row => ({x0: column.start, x1: column.end, y0: row.start, y1: row.end, content: Math.min(column.content, row.content), filled: Math.min(column.filled, row.filled)})));
  }
  const cells = (orientation === 'vertical' ? analysis.verticalCells : analysis.horizontalCells) || [];
  return cells.map(cell => orientation === 'vertical' ? {x0: cell.start, x1: cell.end, y0: 0, y1: 1, content: cell.content, filled: cell.filled} : {x0: 0, x1: 1, y0: cell.start, y1: cell.end, content: cell.content, filled: cell.filled});
}
// Every separator keeps its axis: grid candidates mix vertical and horizontal gaps.
function candidateSeparators(analysis, orientation) {
  const vertical = (analysis.verticalSeparators || []).map(separator => ({...separator, axis: 'vertical'}));
  const horizontal = (analysis.horizontalSeparators || []).map(separator => ({...separator, axis: 'horizontal'}));
  if (orientation === 'grid') return [...vertical, ...horizontal];
  return orientation === 'vertical' ? vertical : horizontal;
}
function cellPageBox(figureBoxValue, cell) {
  return validBox({
    x: figureBoxValue.x + figureBoxValue.w * cell.x0,
    y: figureBoxValue.y + figureBoxValue.h * cell.y0,
    w: figureBoxValue.w * (cell.x1 - cell.x0),
    h: figureBoxValue.h * (cell.y1 - cell.y0)
  });
}
function componentsSupportCells(analysis, cells, orientation) {
  const components = analysis.components || [];
  // Sparse scientific plots are mostly thin axes/curves: pixel-area thresholds must stay low,
  // while bbox extent keeps tiny ticks/speckles from counting as panel evidence.
  const meaningful = component => component && component.area >= 0.0004 && ((component.box[2] - component.box[0]) >= 0.03 || (component.box[3] - component.box[1]) >= 0.03);
  const crosses = (component, separator) => component.area >= 0.0005 && (separator.axis === 'vertical'
    ? component.box[0] < separator.pos - 0.01 && component.box[2] > separator.pos + 0.01
    : component.box[1] < separator.pos - 0.01 && component.box[3] > separator.pos + 0.01);
  for (const separator of candidateSeparators(analysis, orientation)) {
    if (components.some(component => crosses(component, separator))) return false;
  }
  return cells.every(cell => {
    const centerX = (cell.x0 + cell.x1) / 2, centerY = (cell.y0 + cell.y1) / 2;
    return components.some(component => {
      if (!meaningful(component)) return false;
      if (orientation === 'vertical') return component.box[0] <= centerX && component.box[2] >= centerX;
      if (orientation === 'horizontal') return component.box[1] <= centerY && component.box[3] >= centerY;
      return component.box[0] <= centerX && component.box[2] >= centerX && component.box[1] <= centerY && component.box[3] >= centerY;
    });
  });
}
// Labels live in page 1000-coordinates; cells are fractions of the whole figure, so map label
// centers into the figure's own coordinate space before assigning them to panels. Panel labels
// often sit just below the raster figure, hence the small outer tolerance.
const relativeCenter = (label, figure) => {const value = center(label.box); return {x: (value.x - figure.x) / figure.w, y: (value.y - figure.y) / figure.h};};
function mapCellsToLabels(labels, cells, figure) {
  const used = new Set(), mapping = new Map(), pending = [];
  // Exact containment first: a lower-row label near a row boundary belongs to its true cell.
  labels.forEach(label => {
    const value = relativeCenter(label, figure);
    const index = cells.findIndex((cell, cellIndex) => !used.has(cellIndex) && value.x >= cell.x0 - 0.005 && value.x <= cell.x1 + 0.005 && value.y >= cell.y0 - 0.005 && value.y <= cell.y1 + 0.005);
    if (index >= 0) {used.add(index); mapping.set(index, label);}
    else pending.push({label, value});
  });
  // Only labels just outside the raster (e.g. caption-row letters below panels) use a unique
  // nearest-cell fallback; any ambiguous or duplicate match refuses the split.
  for (const {label, value} of pending) {
    let best = -1, bestDistance = Infinity;
    cells.forEach((cell, index) => {
      if (used.has(index)) return;
      const dx = Math.max(0, cell.x0 - value.x, value.x - cell.x1), dy = Math.max(0, cell.y0 - value.y, value.y - cell.y1);
      const distance = Math.hypot(dx, dy);
      if (dx <= 0.12 && dy <= 0.12 && distance < bestDistance) {best = index; bestDistance = distance;}
    });
    if (best < 0) return null;
    used.add(best); mapping.set(best, label);
  }
  return mapping.size === cells.length ? mapping : null;
}
// Reading order: columns left-to-right, rows top-to-bottom; caption letters follow this order.
function readingOrder(cells, orientation) {
  return cells.map((cell, index) => ({cell, index})).sort((a, b) => orientation === 'vertical'
    ? a.cell.x0 - b.cell.x0
    : orientation === 'horizontal'
      ? a.cell.y0 - b.cell.y0
      : (a.cell.y0 - b.cell.y0) || (a.cell.x0 - b.cell.x0));
}
// Requires caption/label evidence first; geometry only confirms where the panels are.
export function planPanelSplit(group, analysis) {
  const evidence = panelEvidence(group);
  if (evidence.count < 2) return {split: false, evidence, reason: 'no-panel-evidence'};
  if (!analysis || analysis.error || analysis.contentRatio === undefined) return {split: false, evidence, reason: 'no-panel-geometry'};
  if (analysis.contentRatio < 0.0008) return {split: false, evidence, reason: 'blank-region'};
  const labels = evidence.labels || [];
  const labelOrientation = labels.length >= 2 ? (Math.max(...labels.map(label => label.box.x)) - Math.min(...labels.map(label => label.box.x)) >= Math.max(...labels.map(label => label.box.y)) - Math.min(...labels.map(label => label.box.y)) ? 'vertical' : 'horizontal') : null;
  const orientations = ['vertical', 'horizontal', 'grid'];
  const candidates = [];
  for (const orientation of orientations) {
    const separators = candidateSeparators(analysis, orientation);
    if (!separators.length || Math.max(...separators.map(separator => separator.gap)) < 0.018) continue;
    const cells = candidateCells(analysis, orientation);
    if (cells.length < 2 || cells.length !== evidence.count) continue;
    if (cells.some(cell => Math.min(cell.x1 - cell.x0, cell.y1 - cell.y0) < figureLimits.minPanelFraction || cell.content < 0.001 || cell.filled < 0.01)) continue;
    if (!componentsSupportCells(analysis, cells, orientation)) continue;
    const labelMap = labels.length >= 2 ? mapCellsToLabels(labels, cells, group.figure.box) : null;
    if (labels.length >= 2 && !labelMap) continue;
    candidates.push({orientation, cells, separators, labelMap});
  }
  if (!candidates.length) return {split: false, evidence, reason: 'geometry-mismatch'};
  const chosen = candidates.find(candidate => candidate.orientation === labelOrientation) || candidates[0];
  const panels = readingOrder(chosen.cells, chosen.orientation).map((entry, position) => {
    let box = cellPageBox(group.figure.box, entry.cell);
    const label = chosen.labelMap?.get(entry.index) || null;
    // Only this panel's own label may extend the crop; another panel's label stays outside.
    if (label?.box) {
      const value = label.box;
      if (value.x + value.w >= box.x - box.w * 0.12 && value.x <= box.x + box.w * 1.12 && value.y + value.h >= box.y - box.h * 0.18 && value.y <= box.y + box.h * 1.18) box = unionBox(box, value);
    }
    // Labels are location cues; a loose label rectangle must not move a panel outside the
    // verified complete original. Real outside labels are included during figure completion.
    if(box){
      const parent=group.figure.box,left=Math.max(box.x,parent.x),top=Math.max(box.y,parent.y);
      box=validBox({x:left,y:top,w:Math.min(box.x+box.w,parent.x+parent.w)-left,h:Math.min(box.y+box.h,parent.y+parent.h)-top});
    }
    box = clampBox(box);
    const labelText = label?.text || evidence.captionLetters[position] || (group.figure.caption || '') + ' 子图 ' + (position + 1);
    return {box, label: labelText, index: position};
  });
  if (panels.some(panel => !panel.box || boxArea(panel.box) < 400 || boxArea(panel.box) > figureLimits.compositeMaxArea)) return {split: false, evidence, reason: 'panel-box-invalid'};
  return {split: true, panels, orientation: chosen.orientation, evidence: {kind: evidence.kind, count: evidence.count, labels: labels.map(label => label.text), letters: evidence.letters, captionLetters: evidence.captionLetters, separators: chosen.separators.length, parentBox: group.figure.box}, reason: 'multi-evidence'};
}

export function pageScanned(page) {
  return (page?.images || []).some(image => boxArea(image.box) >= figureLimits.scannedPageArea);
}

// Complete PDF figures: group native placements, extend vision half-boxes to the full image,
// fuse duplicates of the same placement and attach the whole-figure caption anchor.
export function resolvePdfFigureGroups(figures, page) {
  const anchors = pdfPageAnchors(page);
  const scanned = pageScanned(page);
  const images = (page?.images || []).map((image, index) => ({id: 'pdf:' + (image.xref ?? index), xref: Number.isFinite(image.xref) ? image.xref : null, box: figureBox(image.box), width: Number(image.width) || 0, height: Number(image.height) || 0, hasMask: image.hasMask === true})).filter(image => image.box && image.width >= 8 && image.height >= 8);
  const items = (figures || []).map(figure => {
    let best = null, bestScore = 0;
    for (const image of images) {
      const score = Math.max(overlapFraction(figure.box, image.box), centerInside(figure.box, image.box) ? 0.6 : 0);
      if (score > bestScore) {best = image; bestScore = score;}
    }
    const match = best && bestScore >= 0.45 && boxArea(best.box) <= figureLimits.nativeImageMaxArea ? best : null;
    return {figure, box: figure.box, image: match, caption: null, labels: []};
  });
  const groups = new Map();
  for (const item of items) {
    const key = item.image ? 'pdf-image:' + item.image.id : 'pdf-vision:' + JSON.stringify(item.box);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const result = [...groups.values()].map(groupItems => {
    const image = groupItems[0].image;
    const figureBoxValue = image ? image.box : unionBox(...groupItems.map(item => item.box));
    const placements = groupItems.map(item => ({box: image ? image.box : item.box, objectId: item.figure.objectId ?? null, nativeId: image?.id || null}));
    // A scanned page still needs the same connectivity/boundary completion: an AI half-box on
    // a full-page raster is not trusted as a complete figure. The full-page native raster is
    // never itself used as the content image.
    const extraction = image && image.hasMask ? {type: 'region-crop', box: figureBoxValue, needsCompletion: false, mask: true, scanned} : image && image.xref ? {type: 'pdf-image', xref: image.xref, nativeId: image.id} : {type: 'region-crop', box: figureBoxValue, needsCompletion: true, scanned};
    return {figure: {...groupItems[0].figure, box: figureBoxValue, identities: groupItems.map(item => JSON.stringify([item.figure.objectId || item.figure.box]))}, placements, image, captionAnchor: null, labels: [], visualPanelLabels: dedupeByBox(groupItems.flatMap(item => item.figure.panelLabels || [])), groupPictures: 0, scanned, extraction, key: image ? 'pdf-image:' + image.id : 'pdf-vision:' + JSON.stringify(figureBoxValue)};
  });
  for (const group of result) {
    if (!group.image) group.captionAnchor = nearestFigureCaption(group.figure.box, anchors.captions);
    else group.captionAnchor = nearestFigureCaption(group.image.box, anchors.captions) || nearestFigureCaption(group.figure.box, anchors.captions);
    group.labels = mergePanelLabels(panelLabelsInFigure(group.image ? group.image.box : group.figure.box, anchors.panels), group.visualPanelLabels);
  }
  return {groups: result, captions: anchors.captions, panels: anchors.panels};
}

// Complete PPTX figures: redirect child objects to their semantic figure group, keep the full
// original media/object and de-duplicate repeated placements of the same original.
export function resolvePptFigureGroups(figures, page) {
  const anchors = pptPageAnchors(page);
  const objects = (page?.objects || []).map(object => ({...object, id: String(object.id), parentId: object.parentId == null ? null : String(object.parentId)}));
  const byId = new Map(objects.map(object => [object.id, object]));
  const childrenOf = id => objects.filter(object => object.parentId === id);
  const descendantsOf = id => {const result = [], stack = [...childrenOf(id)]; while (stack.length) {const object = stack.shift(); result.push(object); stack.push(...childrenOf(object.id));} return result;};
  const contentNodes = object => object.type === 'pic' || object.type === 'graphicFrame' || (object.type === 'sp' && String(object.text || '').trim());
  const figureGroup = object => object.type === 'grpSp' && descendantsOf(object.id).filter(contentNodes).length >= 2;
  const groupBox = object => objectPageBox(object.box);
  const captionsInside = object => {
    const box = groupBox(object);
    if (!box) return [];
    return anchors.captions.filter(caption => caption.box && centerInside(caption.box, box));
  };
  // Whole-page/section layout wrappers are not one figure: they commonly group unrelated
  // figures and long body text, so they must not collapse several figures into one object.
  const layoutWrapper = object => {
    const box = groupBox(object);
    if (!box) return true;
    if (boxArea(box) > 700000) return true;
    if (captionsInside(object).length >= 2) return true;
    if (descendantsOf(object.id).some(item => item.type === 'sp' && String(item.text || '').length > 80)) return true;
    return descendantsOf(object.id).filter(item => item.type === 'grpSp').some(item => figureGroup(item));
  };
  const completeFigureGroup = object => figureGroup(object) && !layoutWrapper(object);
  const targetObject = object => {
    // Nearest complete figure group wins; a page wrapper must never swallow several figures.
    const chain = [];
    let current = object;
    while (current) {chain.push(current); current = current.parentId ? byId.get(current.parentId) : null;}
    const nearestGroup = chain.find(completeFigureGroup);
    if (nearestGroup) return nearestGroup;
    if (object.type === 'grpSp') {
      const descendants = descendantsOf(object.id), pictures = descendants.filter(item => item.mediaPart);
      if (pictures.length === 1 && descendants.filter(contentNodes).length === 1) return pictures[0];
    }
    return object;
  };
  const groups = new Map();
  for (const figure of figures || []) {
    const sourceObject = byId.get(String(figure.objectId));
    if (!sourceObject) {groups.set('ppt-missing:' + figure.objectId, {figure: {...figure, box: figure.box}, placements: [{box: figure.box, objectId: figure.objectId ?? null}], target: null, captionAnchor: null, labels: [], visualPanelLabels: dedupeByBox(figure.panelLabels || []), extraction: {type: 'skip', reason: '原稿对象不存在，未自动提取'}, key: 'ppt-missing:' + figure.objectId}); continue;}
    const target = targetObject(sourceObject);
    const targetBox = objectPageBox(target.box) || figure.box;
    const extraction = target.mediaPart ? {type: 'embedded', objectId: target.id, mediaPart: target.mediaPart, mediaHash: target.mediaHash} : {type: 'pptx-object', objectId: target.id};
    const key = target.mediaPart ? 'ppt-media:' + (target.mediaHash || target.mediaPart) : 'ppt-object:' + target.id;
    if (!groups.has(key)) groups.set(key, {figure: {...figure, box: targetBox}, placements: [], target, captionAnchor: null, labels: [], visualPanelLabels: dedupeByBox(figure.panelLabels || []), extraction, key});
    const group = groups.get(key);
    group.placements.push({box: targetBox, objectId: sourceObject.id});
    if (figure.panelLabels?.length) group.visualPanelLabels = dedupeByBox([...group.visualPanelLabels, ...figure.panelLabels]);
    if (!group.figure.caption && figure.caption) group.figure.caption = figure.caption;
    if (!group.figure.evidence && figure.evidence) group.figure.evidence = figure.evidence;
  }
  const result = [...groups.values()].map(group => {
    const groupPictures = group.target && group.target.type === 'grpSp' ? descendantsOf(group.target.id).filter(item => item.mediaPart).length : 0;
    if (!group.extraction || group.extraction.type === 'skip') return {...group, groupPictures, frameBox: group.figure.box};
    const box = group.figure.box;
    if (boxArea(box) > figureLimits.figureMaxArea) return {...group, groupPictures, frameBox: box, extraction: {type: 'skip', reason: '对象覆盖整页，可能为页面背景，未自动提取'}};
    const captionAnchor = nearestFigureCaption(box, anchors.captions);
    const labels = mergePanelLabels(panelLabelsInFigure(box, anchors.panels), group.visualPanelLabels);
    return {...group, frameBox: box, groupPictures, captionAnchor, labels};
  });
  return {groups: result, captions: anchors.captions, panels: anchors.panels};
}

// Several placements/fragments that share one real figure caption describe one complete figure.
// Distinct figure numbers stay separate; figures without a caption are never merged here.
// PPTX objects are never converted into page screenshots: same-caption objects stay independent
// original objects and only carry their shared-caption relationship metadata.
export function mergeGroupsByCaption(groups, {isPpt = false} = {}) {
  const source = groups || [];
  if (isPpt) {
    const counts = new Map();
    for (const group of source) {
      const key = group.captionAnchor?.key;
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return source.map(group => {
      const key = group.captionAnchor?.key || null;
      return {...group, sharedCaption: key ? {key, count: counts.get(key) || 1} : null};
    });
  }
  const byCaption = new Map(), result = [];
  for (const group of groups || []) {
    const key = group.captionAnchor?.key;
    if (!key) {result.push(group); continue;}
    if (!byCaption.has(key)) byCaption.set(key, []);
    byCaption.get(key).push(group);
  }
  for (const [,list] of byCaption) {
    if (list.length === 1) {result.push(list[0]); continue;}
    const box = unionBox(...list.map(group => group.figure.box));
    const fromNative = list.some(group => group.extraction.type === 'pdf-image' || group.extraction.type === 'embedded' || group.extraction.type === 'pptx-object');
    result.push({key: 'caption:' + list[0].captionAnchor.key, figure: {...list[0].figure, box}, placements: list.flatMap(group => group.placements), captionAnchor: list[0].captionAnchor, labels: dedupeByBox(list.flatMap(group => group.labels || [])), groupPictures: 0, composite: true, nativeComposite: fromNative, extraction: {type: 'region-crop', box, needsCompletion: !fromNative}, parentEvidence: fromNative ? 'caption-cluster-native' : 'caption-cluster-vision'});
  }
  return result;
}

// A reusable parent must be the same extraction path and the same complete range. An old
// half-page crop (region-crop) can never be reused as a native original just because some old
// placement identity matched; the file stays on disk but a fresh complete extraction is made.
export function reusableParent(parent, {methods = [], figureBox} = {}) {
  if (!parent || !parent.extracted || !methods.includes(parent.extractionMethod)) return false;
  const location = (parent.sourceLocations || [])[0];
  if (!location?.box || !figureBox) return false;
  const forward = overlapFraction(location.box, figureBox), backward = overlapFraction(figureBox, location.box);
  return forward >= 0.97 && backward >= 0.97;
}

// Map a complete-figure sub-panel back into the retained parent original. The parent file may be
// an embedded original (with PPTX crop), an object render or a page-region crop; rotation/flip and
// unprovable aspect changes are refused so a half page frame is never cut as a panel.
export function panelCropMapping({parent, parentBox, panelBox, pageSize}) {
  if (!parent || !parentBox || !panelBox) return {reliable: false, reason: '缺少完整原图范围'};
  const left = (panelBox.x - parentBox.x) / parentBox.w, top = (panelBox.y - parentBox.y) / parentBox.h;
  const width = panelBox.w / parentBox.w, height = panelBox.h / parentBox.h;
  if (left < -0.02 || top < -0.02 || left + width > 1.02 || top + height > 1.02) return {reliable: false, reason: '子图超出完整原图范围'};
  const relative = {x: left * 1000, y: top * 1000, w: width * 1000, h: height * 1000};
  const location = (parent.sourceLocations || [])[0] || {};
  if (parent.extractionMethod === 'region-crop') return {reliable: true, box: relative};
  if (parent.extractionMethod === 'pptx-object') {
    const transform = location.transform || {};
    if (Number(transform.rot || 0) % 21600000 !== 0 || transform.flipH === '1' || transform.flipV === '1') return {reliable: false, reason: '原稿对象存在旋转或翻转，无法可靠映射子图'};
    return {reliable: true, box: relative};
  }
  if (parent.extractionMethod === 'embedded' || parent.extractionMethod === 'pdf-embedded') {
    const transform = location.transform || {};
    if (Number(transform.rot || 0) % 21600000 !== 0) return {reliable: false, reason: '原稿图片存在旋转，无法可靠映射子图'};
    if (transform.flipH === '1' || transform.flipV === '1') return {reliable: false, reason: '原稿图片存在翻转，无法可靠映射子图'};
    let x = left, y = top, w = width, h = height;
    let l = 0, t = 0, r = 0, b = 0;
    if (location.crop) {
      // OOXML srcRect uses 1/100000 of the picture (50% = 50000), not 1/1000.
      l = Number(location.crop.l || 0) / 100000; t = Number(location.crop.t || 0) / 100000;
      r = Number(location.crop.r || 0) / 100000; b = Number(location.crop.b || 0) / 100000;
      x = l + left * (1 - l - r);
      y = t + top * (1 - t - b);
      w = width * (1 - l - r);
      h = height * (1 - t - b);
    }
    if (parent.width && parent.height && parentBox.w > 0 && parentBox.h > 0) {
      // parentBox is normalized 1000x1000, so page aspect must be restored before comparing
      // with the raw image pixel aspect (A4/landscape pages are not square). The visible source
      // aspect is the raw picture minus the OOXML srcRect crop, compared with the frame aspect.
      const pageWidth = Number(pageSize?.width) > 0 ? Number(pageSize.width) : 1000;
      const pageHeight = Number(pageSize?.height) > 0 ? Number(pageSize.height) : 1000;
      const imageAspect = (parent.width * (1 - l - r)) / (parent.height * (1 - t - b));
      const frameAspect = (parentBox.w * pageWidth) / (parentBox.h * pageHeight);
      if (Math.abs(Math.log(imageAspect / frameAspect)) > 0.08) return {reliable: false, reason: '原图与放置区域比例不一致，可能存在旋转，无法可靠映射子图'};
    }
    return {reliable: true, box: {x: x * 1000, y: y * 1000, w: w * 1000, h: h * 1000}};
  }
  return {reliable: false, reason: '父素材不是可直接映射的原件'};
}
