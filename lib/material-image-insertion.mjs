// Deterministic insertion and release identity for registered material ORIGINAL images.
//
// The approved image plan (project.visualPages[index].images) is the only source of identity and
// placeholder geometry for audit `type:"image"` objects. The audit model must not be able to swap a
// material id, forget an occurrence, or invent replacement geometry. `ensureMaterialImages` restores
// every approved occurrence by `nodeId` and creates a deterministic element only when the audit
// omitted it; two nodes that use the same material remain two independent image elements.
//
// The export path (lib/visual-build.mjs) verifies the material file bytes against the registered
// sha256 before embedding, uses `objectName = element.key`, and keeps original SVG source bytes
// verbatim. `materialImageManifest(project,index,getImage)` turns the built page image objects into
// the optional `deck-spec.materialImages[page] = [{key,id,sha256}]` entries consumed by
// `tools/release_check.py`; Codex adds that field to the production deck spec and replay.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {imageSize} from 'image-size';

export const MATERIAL_IMAGE_INSERTION_VERSION = 1;
const hashBytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const keyPattern = /^[a-zA-Z0-9_-]{1,64}$/;

export const approvedMaterialImagePlan = (project, index) => {
  const plan = project?.visualPages?.[index]?.images;
  if (!Array.isArray(plan)) return [];
  return plan.map((entry, position) => {
    if (typeof entry?.nodeId !== 'string' || !entry.nodeId.trim()
      || typeof entry?.id !== 'string' || !entry.id.trim()
      || !['x', 'y', 'w', 'h'].every(field => Number.isFinite(entry[field]))
      || entry.w <= 0 || entry.h <= 0) {
      throw Error('批准图片计划第 ' + (position + 1) + ' 项缺少有效 nodeId、材料 ID 或占位框');
    }
    return {nodeId: entry.nodeId, id: entry.id, x: entry.x, y: entry.y, w: entry.w, h: entry.h,
      ...(Number.isFinite(entry.aspect) ? {aspect: entry.aspect} : {}),
      ...(entry.imageFit === 'fill' ? {imageFit: 'fill'} : {})};
  });
};

function deterministicKey(nodeId, used) {
  const base = ('image-' + String(nodeId).replace(/[^a-zA-Z0-9_-]/g, '-'))
    .replace(/-+/g, '-').replace(/^[-]+|[-]+$/g, '').slice(0, 56) || 'image';
  let key = base;
  for (let suffix = 2; used.has(key) || !keyPattern.test(key); suffix++) {
    key = (base.slice(0, 56) + '-' + suffix).slice(0, 64);
  }
  return key;
}

// Restore all approved original-image occurrences into raw audit output. Existing image elements
// (except artistic-text cutouts) must keep the planned material id; geometry is restored from the
// approved plan so a model-reported box can never reflow a registered original image.
export function ensureMaterialImages(elements, imagePlan) {
  if (!Array.isArray(elements)) throw Error('审计元素须为数组');
  const plan = (imagePlan || []).map(entry => ({...entry}));
  const planByNode = new Map();
  for (const entry of plan) {
    if (planByNode.has(entry.nodeId)) throw Error('批准图片计划重复登记图片节点：' + entry.nodeId);
    planByNode.set(entry.nodeId, entry);
  }
  const next = elements.map(element => {
    if (element?.type !== 'image' || element.artisticText === true||element.implementation) return element;
    const nodeId = element.nodeId;
    const planned = nodeId ? planByNode.get(nodeId) : null;
    if (!planned) throw Error('审计图片对象不在批准图片计划中：' + String(element.key || nodeId || element.id));
    const {imageFit,aspect,aspectAdjustment,...rest}=element;
    return {...rest, type: 'image', nodeId, id: planned.id,
      x: planned.x, y: planned.y, w: planned.w, h: planned.h,
      ...(planned.imageFit==='fill'?{imageFit:'fill'}:{}),...(planned.aspect?{aspect:planned.aspect}:{})};
  });
  const present = new Set(next.filter(element => element?.type === 'image' && element.artisticText !== true&&!element.implementation)
    .map(element => element.nodeId));
  if (next.filter(element => element?.type === 'image' && element.artisticText !== true&&!element.implementation).length !== present.size) {
    throw Error('审计图片节点重复，无法确定登记原图身份');
  }
  const usedKeys = new Set(next.map(element => element?.key).filter(Boolean));
  const inserted = [];
  for (const planned of plan) {
    if (present.has(planned.nodeId)) continue;
    const key = deterministicKey(planned.nodeId, usedKeys);
    usedKeys.add(key);
    next.push({key, type: 'image', nodeId: planned.nodeId, id: planned.id,
      x: planned.x, y: planned.y, w: planned.w, h: planned.h,
      ...(planned.imageFit==='fill'?{imageFit:'fill'}:{}),...(planned.aspect?{aspect:planned.aspect}:{}),
      description: '登记原图 ' + String(planned.id).slice(0, 8)});
    inserted.push({key, nodeId: planned.nodeId, id: planned.id});
  }
  const restored = next.filter(element => element?.type === 'image' && element.artisticText !== true
    && !inserted.some(added => added.key === element.key)).map(element => element.key);
  return {elements: next, inserted, restored: [...new Set(restored)]};
}

export function materialImagePath(project, id, getImage) {
  if (typeof getImage !== 'function') throw Error('缺少登记原图文件解析器');
  const file = getImage(project, id);
  if (!file || !fs.existsSync(file)) throw Error('登记原图文件不存在：' + id);
  return file;
}

// Read and verify one registered original. The returned sha256 is computed from the actual bytes;
// a mismatch with material.sha256 fails, so a swapped/screenshot/placeholder file is detected here.
export function readMaterialImage(project, id, getImage) {
  const material = (project?.materials || []).find(item => item.id === id);
  if (!material) throw Error('材料登记中不存在图片：' + id);
  const file = materialImagePath(project, id, getImage);
  const bytes = fs.readFileSync(file);
  const sha256 = hashBytes(bytes);
  if (material.sha256 && material.sha256 !== sha256) throw Error('登记原图文件哈希与材料登记不一致：' + id);
  let dimensions = null;
  try { dimensions = imageSize(bytes); } catch { dimensions = null; }
  return {id, file, bytes, sha256,
    ...(dimensions?.width > 0 && dimensions?.height > 0
      ? {width: dimensions.width, height: dimensions.height, aspect: dimensions.width / dimensions.height} : {})};
}

// Built-page image objects -> release spec entries. `getImage(project,id)` must return the material
// file path (same callback as buildVisualDeck). Missing/replaced files fail here, before release.
export function materialImageManifest(project, index, getImage) {
  const page = project?.reconstruction?.slides?.[index];
  const elements = Array.isArray(page?.elements) ? page.elements : [];
  const planByNode = new Map(approvedMaterialImagePlan(project, index).map(entry => [entry.nodeId, entry]));
  const entries = [];
  for (const element of elements) {
    if (element?.type !== 'image' || element.artisticText === true||element.implementation) continue;
    const planned = planByNode.get(element.nodeId);
    if (!planned || planned.id !== element.id) throw Error('重建图片对象与批准图片计划身份不一致：' + String(element.key || element.nodeId));
    const source = readMaterialImage(project, element.id, getImage);
    entries.push({key: element.key, id: element.id, sha256: source.sha256});
  }
  for(const plan of planByNode.values())if(!elements.some(e=>e.type==='image'&&!e.implementation&&e.nodeId===plan.nodeId&&e.id===plan.id))throw Error('重建遗漏登记原图：'+plan.nodeId);
  return entries;
}

const relTarget = (rels, id) => {
  for (const relationship of rels.matchAll(/<Relationship\s+([^>]+?)\/?\s*>/g)) {
    const attrs = Object.fromEntries([...relationship[1].matchAll(/(\w+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    if (attrs.Id === id) return path.posix.basename(attrs.Target || '');
  }
  return null;
};

const pictureName = block => block.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/)?.[1] || null;

// Verify each expected page image object resolves to media bytes with the registered sha256.
// SVG originals are checked through asvg:svgBlip (their raw source), raster originals through the
// main a:blip. Returns per-slide evidence for the build/test report.
export async function verifyMaterialImageEmbedding(zip, expectedSlides) {
  const errors = [];
  const slides = [];
  for (const [index, expected] of (expectedSlides || []).entries()) {
    if (!expected?.length) { slides.push({index, verified: []}); continue; }
    const xmlName = 'ppt/slides/slide' + (index + 1) + '.xml';
    const relsName = 'ppt/slides/_rels/slide' + (index + 1) + '.xml.rels';
    const xml = await zip.file(xmlName)?.async('string');
    const rels = await zip.file(relsName)?.async('string');
    if (!xml || !rels) { errors.push('S' + (index + 1) + ': missing slide/relationship XML'); continue; }
    const used = new Set();
    const verified = [];
    for (const item of expected) {
      const blocks = (xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) || []).filter(block => pictureName(block) === item.key);
      if (blocks.length !== 1) {
        errors.push('S' + (index + 1) + ': material image object count mismatch for ' + item.key + ' (' + blocks.length + ')');
        continue;
      }
      if (used.has(item.key)) { errors.push('S' + (index + 1) + ': duplicate material image object key ' + item.key); continue; }
      used.add(item.key);
      const block = blocks[0];
      const id = block.match(/<asvg:svgBlip[^>]+r:embed="([^"]+)"/)?.[1]
        || block.match(/<a:blip[^>]+r:embed="([^"]+)"/)?.[1];
      if (!id) { errors.push('S' + (index + 1) + ': material image has no media relationship ' + item.key); continue; }
      const target = relTarget(rels, id);
      const mediaName = target ? 'ppt/media/' + target : null;
      const bytes = mediaName ? await zip.file(mediaName)?.async('nodebuffer') : null;
      if (!bytes) { errors.push('S' + (index + 1) + ': material image media missing ' + item.key); continue; }
      const sha256 = hashBytes(bytes);
      if (sha256 !== item.sha256) errors.push('S' + (index + 1) + ': material image bytes mismatch ' + item.key);
      verified.push({key: item.key, id: item.id, media: mediaName, sha256});
    }
    slides.push({index, verified});
  }
  return {passed: errors.length === 0, errors, slides};
}
