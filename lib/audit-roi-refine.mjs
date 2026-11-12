import {Resvg} from '@resvg/resvg-js';
import {chat, parseJSON} from './provider.mjs';

// Two-stage audit ROI refinement:
//  1) grid: one ruler/grid overlay of the whole page, ask the model to read coordinates
//     off the ticks (measured ~2.2x better than raw image);
//  2) crops: for the important elements, crop+upscale a local window with its own grid and
//     ask for the box inside the crop (error shrinks with the crop scale factor).
// Both return element boxes in the 1600x900 logic space used by the pipeline.

const CONTENT_WIDTH = 1600;
const CONTENT_HEIGHT = 900;

function pngDataUrl(bytes) {
  return 'data:image/png;base64,' + Buffer.from(bytes).toString('base64');
}

export function buildGridPng({referencePng, crop = null, scale = 1, step = 100}) {
  // referencePng: full-page PNG bytes (any size, drawn into 1600x900 content space)
  // crop: {x0,y0,x1,y1} in content coords -> crop image with its own grid + origin labels
  const url = pngDataUrl(referencePng);
  if (crop) {
    const width = Math.round((crop.x1 - crop.x0) * scale);
    const height = Math.round((crop.y1 - crop.y0) * scale);
    const lines = [];
    for (let x = Math.ceil(crop.x0 / 50) * 50; x <= crop.x1; x += 50) {
      const px = (x - crop.x0) * scale;
      lines.push(`<line x1="${px}" y1="0" x2="${px}" y2="${height}" stroke="#7EA0C8" stroke-width="1" opacity="0.55"/>`);
      lines.push(`<text x="${px + 2}" y="12" font-size="11" fill="#1B4F8A">${x}</text>`);
    }
    for (let y = Math.ceil(crop.y0 / 50) * 50; y <= crop.y1; y += 50) {
      const py = (y - crop.y0) * scale;
      lines.push(`<line x1="0" y1="${py}" x2="${width}" y2="${py}" stroke="#7EA0C8" stroke-width="1" opacity="0.55"/>`);
      lines.push(`<text x="2" y="${py + 11}" font-size="11" fill="#1B4F8A">${y}</text>`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <image href="${url}" xlink:href="${url}" x="${-crop.x0 * scale}" y="${-crop.y0 * scale}" width="${CONTENT_WIDTH * scale}" height="${CONTENT_HEIGHT * scale}"/>
      ${lines.join('')}
    </svg>`;
    return Buffer.from(new Resvg(svg, {fitTo: {mode: 'width', value: width}}).render().asPng());
  }
  const margin = 40;
  const width = CONTENT_WIDTH + margin * 2;
  const height = CONTENT_HEIGHT + margin * 2;
  const lines = [];
  for (let x = 0; x <= CONTENT_WIDTH; x += step) {
    const px = margin + x;
    lines.push(`<line x1="${px}" y1="${margin}" x2="${px}" y2="${margin + CONTENT_HEIGHT}" stroke="#7EA0C8" stroke-width="1" opacity="0.35"/>`);
    lines.push(`<line x1="${px}" y1="${margin - 10}" x2="${px}" y2="${margin}" stroke="#14406E" stroke-width="2"/>`);
    lines.push(`<text x="${px + 2}" y="${margin - 18}" font-size="13" fill="#14406E">${x}</text>`);
  }
  for (let y = 0; y <= CONTENT_HEIGHT; y += step) {
    const py = margin + y;
    lines.push(`<line x1="${margin}" y1="${py}" x2="${margin + CONTENT_WIDTH}" y2="${py}" stroke="#7EA0C8" stroke-width="1" opacity="0.35"/>`);
    lines.push(`<line x1="${margin - 10}" y1="${py}" x2="${margin}" y2="${py}" stroke="#14406E" stroke-width="2"/>`);
    lines.push(`<text x="2" y="${py + 4}" font-size="13" fill="#14406E">${y}</text>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#FFFFFF"/>
    <image href="${url}" xlink:href="${url}" x="${margin}" y="${margin}" width="${CONTENT_WIDTH}" height="${CONTENT_HEIGHT}"/>
    ${lines.join('')}
  </svg>`;
  return Buffer.from(new Resvg(svg, {fitTo: {mode: 'width', value: width}}).render().asPng());
}

function describeElement(element) {
  const parts = [element.key, element.type];
  if (element.shape) parts.push(element.shape);
  if (element.fill) parts.push('fill#' + element.fill);
  return parts.join(' | ');
}

function clampBox(box) {
  const x = Math.max(-4, Math.min(CONTENT_WIDTH - 8, Number(box.x) || 0));
  const y = Math.max(-4, Math.min(CONTENT_HEIGHT - 8, Number(box.y) || 0));
  const w = Math.max(8, Math.min(CONTENT_WIDTH, Number(box.w) || 0));
  const h = Math.max(8, Math.min(CONTENT_HEIGHT, Number(box.h) || 0));
  return {x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10};
}

function mergeRefinement(elements, boxes, source) {
  const byIndex = new Map(boxes.map(box => [Number(box.i), clampBox(box)]));
  const result = elements.map((element, index) => {
    const box = byIndex.get(index + 1);
    if (!box) return element;
    return {...element, x: box.x, y: box.y, w: box.w, h: box.h,
            auditRoiRefine: {source, previous: {x: element.x, y: element.y, w: element.w, h: element.h}}};
  });
  return result;
}

const SYSTEM = '你是严格的视觉坐标定位器。只输出 JSON 对象：{"boxes":[{"i":1,"x":number,"y":number,"w":number,"h":number},...]}。坐标是内容区的 1600×900 逻辑坐标，读刻度尺/网格上的数字。';

export async function refineAuditBoxesWithGrid({referencePng, elements, config, signal, limit = 14}) {
  const focus = elements.map((element, index) => ({element, index}))
    .filter(({element}) => ['shape', 'rect', 'ellipse'].includes(element.type))
    .filter(({element}) => Math.min(element.w || 0, element.h || 0) >= 16)
    .slice(0, limit);
  if (!focus.length) return elements;
  const grid = buildGridPng({referencePng});
  const list = focus.map(({element}, order) => `${order + 1}. ${describeElement(element)}（估计框 x=${Math.round(element.x)}, y=${Math.round(element.y)}, w=${Math.round(element.w)}, h=${Math.round(element.h)}）`).join('\n');
  const user = [
    {type: 'text', text: `图中是 PPT 预览与 100px 网格/刻度尺（数字即内容区坐标）。请按顺序为下列 ${focus.length} 个元素给出真实外接框（左上角 x,y + 宽 w、高 h），坐标读刻度：\n${list}`},
    {type: 'image_url', image_url: {url: pngDataUrl(grid)}},
  ];
  const response = await chat(config, SYSTEM, user, signal);
  const value = parseJSON(response.text);
  const boxes = (value.boxes || value.items || []).map((box, order) => ({...box, i: box.i ?? order + 1}));
  // map the ordered answers back to the original elements
  const refined = elements.map(element => element);
  focus.forEach(({element, index}, order) => {
    const box = boxes.find(item => Number(item.i) === order + 1) || boxes[order];
    if (!box) return;
    const clamped = clampBox(box);
    refined[index] = {...element, x: clamped.x, y: clamped.y, w: clamped.w, h: clamped.h,
                     auditRoiRefine: {source: 'grid', previous: {x: element.x, y: element.y, w: element.w, h: element.h}}};
  });
  return refined;
}

export async function refineAuditBoxesWithCrops({referencePng, elements, config, signal, keys = null, limit = 6, scale = 2.4}) {
  const picks = elements.map((element, index) => ({element, index}))
    .filter(({element}) => ['shape', 'rect', 'ellipse'].includes(element.type))
    .filter(({element}) => (keys ? keys.includes(element.key) : true))
    .slice(0, limit);
  if (!picks.length) return elements;
  const refined = elements.map(element => element);
  for (const {element, index} of picks) {
    const padX = Math.max(80, (element.w || 60) * 0.75);
    const padY = Math.max(60, (element.h || 60) * 0.75);
    const crop = {
      x0: Math.max(0, Math.floor(element.x - padX)),
      y0: Math.max(0, Math.floor(element.y - padY)),
      x1: Math.min(CONTENT_WIDTH, Math.ceil(element.x + element.w + padX)),
      y1: Math.min(CONTENT_HEIGHT, Math.ceil(element.y + element.h + padY)),
    };
    const cropPng = buildGridPng({referencePng, crop, scale, step: 50});
    const user = [
      {type: 'text', text: `这是局部放大的裁剪图（放大 ${scale}×），图上网格数字是整页 1600×900 坐标。请给出该元素（${describeElement(element)}）在整页坐标中的真实外接框：{"boxes":[{"i":1,"x":...,"y":...,"w":...,"h":...}]}`},
      {type: 'image_url', image_url: {url: pngDataUrl(cropPng)}},
    ];
    try {
      const response = await chat(config, SYSTEM, user, signal);
      const value = parseJSON(response.text);
      const box = (value.boxes || value.items || [])[0];
      if (!box) continue;
      const clamped = clampBox(box);
      if (clamped.w > element.w * 2.2 || clamped.w < element.w * 0.45 || clamped.h > element.h * 2.2 || clamped.h < element.h * 0.45) continue;
      refined[index] = {...element, x: clamped.x, y: clamped.y, w: clamped.w, h: clamped.h,
                       auditRoiRefine: {source: 'crop', previous: {x: element.x, y: element.y, w: element.w, h: element.h}}};
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  return refined;
}
