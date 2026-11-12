// Measurement-based title-band detection: the main audit pass reads the card header colour block
// as part of the card gradient, and VLM confirmations are unstable. Pixel row-step measurement is
// stable (the header block ends at a sharp light->dark step), so the band is emitted directly as
// a low-confidence native shape and confirmed by the assembled page review later.
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {arrangeScene} from './scene-hierarchy.mjs';

const run = promisify(execFile);

const BAND_MIN_HEIGHT = 20;
const BAND_MAX_HEIGHT = 240;
const BAND_MIN_DELTA = 20;

function cardShapes(audit) {
  return (audit || []).filter(element => ['shape', 'rect'].includes(element.type)
    && Number(element.w) > 120 && Number(element.h) > 100 && Number(element.h) <= 900);
}

function headingTitles(audit, shapes) {
  return (audit || []).filter(element => {
    if (element.type !== 'text' || element.role!=='heading' || Number(element.size) < 18) return false;
    return shapes.some(shape => Number(element.x) >= Number(shape.x) - 10
      && Number(element.y) >= Number(shape.y) - 10
      && Number(element.x) + Number(element.w) <= Number(shape.x) + Number(shape.w) + 10
      && Number(element.y) + Number(element.h) <= Number(shape.y) + Number(shape.h) * 0.65);
  });
}

export async function augmentAuditWithTitleBands({env, project, index, audit, reference, signal, limit = 6}) {
  if (!reference || !fs.existsSync(reference)) return {audit, added: []};
  const committedCarrier = (audit || []).some(element => element
    && (element.contourKind === 'measured-title-band'
      || (element.role === 'carrier' && /heading-carrier/i.test(String(element.frameKind || '')))
      || /^tcar-|title-plate/i.test(String(element.key || ''))));
  if (committedCarrier) return {audit, added: []};
  const shapes = cardShapes(audit);
  const titles = headingTitles(audit, shapes).slice(0, limit);
  if (!titles.length) return {audit, added: []};
  const existing = (audit || []).filter(element => element.role === 'title-band');
  const python = process.env.PPT_AGENT_PYTHON
    || path.join(env.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const directory = path.join(env.data, project.id, 'geometry-records', 'guided-bands', 'page-' + (index + 1));
  fs.mkdirSync(directory, {recursive: true});
  const added = [];
  const emittedParents = new Set();
  for (const title of titles) {
    const parent = [...shapes].sort((a,b)=>a.w*a.h-b.w*b.h).find(shape => Number(title.x) >= Number(shape.x) - 10
      && Number(title.y) >= Number(shape.y) - 10
      && Number(title.x) + Number(title.w) <= Number(shape.x) + Number(shape.w) + 10
      && Number(title.y) + Number(title.h) <= Number(shape.y) + Number(shape.h) * 0.65);
    if (!parent) continue;
    if (emittedParents.has(String(parent.key))) continue;
    if (existing.some(band => Math.abs(Number(band.x) - Number(parent.x)) < 8
        && Math.abs(Number(band.y) - Number(parent.y)) < 8)) continue;
    try {
      const region = {x: Number(parent.x), y: Number(parent.y), w: Number(parent.w),
        h: Math.min(Number(parent.h), Math.max(220, Number(parent.h) * 0.6))};
      const stdout = await (env.run||run)(python, [path.join(env.root, 'tools', 'row_step.py'), reference,
        String(region.x), String(region.y), String(region.w), String(region.h), '1600'],
        {cwd: env.root, windowsHide: true, timeout: 60000, signal});
      const step = JSON.parse(String(stdout.stdout || '').trim().split('\n').pop());
      const height = Number(step.boundaryY) - Number(parent.y);
      if (!(height >= BAND_MIN_HEIGHT && height <= Math.min(BAND_MAX_HEIGHT,title.y+title.h-parent.y+16,parent.h*.28))) continue;
      if (Number(step.delta) < BAND_MIN_DELTA) continue;
      added.push({
        key: String(parent.key) + '-titleband',
        type: 'shape',
        shape: 'roundRect',
        role: 'title-band',
        parentKey: parent.key,
        nodeId: parent.nodeId,
        x: Math.round(Number(parent.x)),
        y: Math.round(Number(parent.y)),
        w: Math.round(Number(parent.w)),
        h: Math.round(height),
        fill: step.topColor || null,
        lowConfidence: true,
        description: '标题区承载块（行色阶测量：y=' + step.boundaryY + ' 处亮暗突变 ΔE≈' + step.delta + '）',
      });
      emittedParents.add(String(parent.key));
      fs.writeFileSync(path.join(directory, 'band-' + parent.key + '.json'), JSON.stringify(step, null, 1));
    } catch {}
  }
  return {audit: arrangeScene([...(audit || []), ...added]), added};
}
