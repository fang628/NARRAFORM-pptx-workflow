import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {nativeFontFace, fontCategory} from './native-fonts.mjs';

// Candidate metrics are provisional. The pipeline accepts them only after a real PowerPoint render
// improves the same fixed local comparison regions.
//
// User-approved 05 rule: the local font search stays inside the accepted sans/serif class. A
// Chinese black-body (sans) element must not be re-typed as a serif family just because glyph
// distance is marginally smaller; math/Latin keep their own class. Unknown families fall back to a
// script-appropriate default instead of switching class.
const CJK_SANS = ['Microsoft YaHei', 'SimHei', 'DengXian', 'PingFang SC', 'Noto Sans CJK SC', 'Source Han Sans SC'];
const CJK_SERIF = ['SimSun', 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Source Han Serif SC', 'FangSong'];
const LATIN_SANS = ['Arial', 'Calibri', 'Segoe UI', 'Verdana', 'Helvetica'];
const LATIN_SERIF = ['Times New Roman', 'Cambria', 'Georgia', 'Garamond', 'Baskerville'];
const CJK_TEXT = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const MATH_TEXT = /[\^_$<>]|\\(?:frac|sqrt|sum|int|alpha|beta|gamma|theta|cdot|times|le|ge|neq|left|right)/i;

export const FONT_REFERENCE_POLICY_VERSION = 2;

// Same-class candidate families for one element (declared family first, then that class only).
export function fontFamiliesFor(element) {
  const text = String(element?.text || '');
  if (MATH_TEXT.test(text)) return [];
  const cjk = CJK_TEXT.test(text);
  const category = fontCategory(element?.fontFace || '');
  const declared = nativeFontFace(element?.fontFace || '');
  const pool = category === 'serif'
    ? (cjk ? CJK_SERIF : LATIN_SERIF)
    : category === 'sans'
      ? (cjk ? CJK_SANS : LATIN_SANS)
      // Unknown family: reasonable script default (Chinese sans black-body / Latin serif), never a
      // cross-class search from an accepted family.
      : (cjk ? CJK_SANS : LATIN_SERIF);
  return [...new Set([declared, ...pool].filter(Boolean))].slice(0, 4);
}

export function sameFontClass(beforeFace, afterFace) {
  const before = fontCategory(beforeFace || '');
  const after = fontCategory(afterFace || '');
  if (!before || !after) return true; // unknown -> keep the candidate but let acceptors decide
  return before === after;
}

export async function refineReferenceFonts({project, index, elements, reference, background, env, signal, targetKeys}) {
  const candidates = elements.filter(e => (!targetKeys || targetKeys.includes(e.key)) && e.type === 'text'
    && !e.managed && !e.artisticText && !e.gradient && !e.outline && !e.shadow
    && !MATH_TEXT.test(e.text || '') && e.text?.length <= 350)
    .slice(0, 20)
    .map(e => ({...e, fontFace: nativeFontFace(e.fontFace || 'Microsoft YaHei'), families: fontFamiliesFor(e)}))
    .filter(e => e.families.length);
  if (!candidates.length) return {elements, changes: [], status: 'skipped'};
  try {
    const spec = {reference, background, elements: candidates, policyVersion: FONT_REFERENCE_POLICY_VERSION};
    const stamp = crypto.createHash('sha256').update(JSON.stringify([FONT_REFERENCE_POLICY_VERSION, spec, fs.statSync(reference).mtimeMs])).digest('hex').slice(0, 24);
    const directory = path.join(env.data, project.id, 'geometry-records', 'font-reference', index + '-' + stamp);
    const file = path.join(directory, 'input.json');
    const output = path.join(directory, 'result.json');
    const record = path.relative(path.join(env.data, project.id), directory);
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(file, JSON.stringify(spec));
    let result;
    if (fs.existsSync(output)) result = JSON.parse(fs.readFileSync(output, 'utf8'));
    else {
      const python = process.env.PPT_AGENT_PYTHON || path.join(env.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      result = JSON.parse((await env.run(python, [path.join(env.root, 'tools', 'font_reference.py'), file], {windowsHide: true, timeout: 45000, maxBuffer: 2000000, signal})).stdout);
      fs.writeFileSync(output, JSON.stringify(result));
    }
    const changes = [];
    const proposals = new Map((result.proposals || []).map(proposal => [proposal.key, proposal]));
    const fitted = elements.map(e => {
      const proposal = proposals.get(e.key);
      if (!proposal || !(proposal.confidence >= .8) || !Number.isFinite(proposal.beforeScore)
        || !Number.isFinite(proposal.afterScore) || proposal.afterScore < proposal.beforeScore + .025) return e;
      const value = proposal.properties;
      if (!value || typeof value.fontFace !== 'string' || value.fontFace.length > 120 || /[\\/]/.test(value.fontFace)
        || !Number.isFinite(value.size)
        || value.size < Math.max(Math.min(20, e.size), e.size * .9) || value.size > e.size * 1.1) return e;
      // Same-class only: the local search may refine metrics within the accepted sans/serif class,
      // but may not turn a black-body (sans) element into a serif one or vice versa.
      const proposedFace = nativeFontFace(value.fontFace);
      if (!fontFamiliesFor(e).map(nativeFontFace).includes(proposedFace)) return e;
      if (!sameFontClass(e.fontFace, proposedFace)) return e;
      if (!Number.isFinite(value.charSpacing) || Math.abs(value.charSpacing - (e.charSpacing || 0)) > e.size * .07
        || !Number.isFinite(value.lineSpacing) || value.lineSpacing < value.size || value.lineSpacing > value.size * 3) return e;
      const properties = {fontFace: proposedFace, size: value.size, charSpacing: value.charSpacing, lineSpacing: value.lineSpacing};
      changes.push({key: e.key, beforeScore: proposal.beforeScore, afterScore: proposal.afterScore, properties,
        fontClass: fontCategory(proposedFace)});
      const {requestedFontFace, fontSubstitution, families, ...rest} = e;
      return {...rest, ...properties, fontCategory: fontCategory(proposedFace) || e.fontCategory};
    });
    return {elements: fitted, changes, record, status: result.status};
  } catch (error) {
    if (signal?.aborted) throw error;
    return {elements, changes: [], status: 'unavailable', error: String(error.stderr || error.message).slice(-500)};
  }
}
