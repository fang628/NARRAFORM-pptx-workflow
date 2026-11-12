import crypto from 'node:crypto';
import {nativeFontFace, fontCategory} from './native-fonts.mjs';
import {pageTitleMatcher} from './title-identity.mjs';

// User-approved 05 typography rule: fonts are decided per role + script, never by one full-page
// vote. Chinese table headers / row names / body / descriptions keep their sans (hei) evidence;
// Latin and math keep their own serif family; math never votes for Chinese and vice versa.
export const BODY_FONT_POLICY_VERSION = 3;
export const pageBodyFontRule = '每页普通正文按角色与文字脚本分组统一字体族：中文表头、行名、正文与说明保持无衬线（黑体）证据，拉丁与数学/公式保留其适用的衬线族，数学不参与中文投票；主标题、副标题、小标题、导航、页码、公式及书法图片独立，不混入正文投票，不改其字体。识别不确定时保留已接受的字体，不做跨家族切换。';

const MATH_TEXT = /[\^_$<>]|\\(?:frac|sqrt|sum|int|alpha|beta|gamma|theta|cdot|times|le|ge|neq|left|right)/i;
const CJK_TEXT = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

export function textScript(text) {
  const value = String(text || '');
  if (MATH_TEXT.test(value)) return 'math';
  if (CJK_TEXT.test(value)) return 'cjk';
  if (/[A-Za-z]/.test(value)) return 'latin';
  return 'other';
}

function roleGroupOf(element) {
  const role = String(element?.role || '').trim().toLowerCase();
  if (['table-header', 'table-cell', 'table-title', 'row-header'].includes(role)) return 'table';
  if (role === 'heading' || role === 'subtitle' || role === 'subheading') return 'secondary';
  return 'body';
}

export function pageBodyText(p, e) {
  if (e.type !== 'text' || e.managed || e.artisticText || pageTitleMatcher(p)(e)
    || ['title', 'subtitle', 'heading', 'navigation', 'formula', 'visual-number'].includes(e.role)
    || e.role !== 'body' && ['calligraphy', 'artistic'].includes(e.fontCategory || fontCategory(e.fontFace || ''))) return false;
  return !e.part || e.part === 'whole';
}

export function bodyFontGroupKey(e) {
  return roleGroupOf(e) + '|' + textScript(e.text);
}

function voteGroups(candidates) {
  const votes = new Map();
  for (const element of candidates) {
    const script = textScript(element.text);
    if (script === 'math') continue; // math/serif keeps itself out of the voting pool
    const key = roleGroupOf(element) + '|' + script;
    const face = nativeFontFace(element.fontFace || 'Microsoft YaHei');
    const counts = votes.get(key) || new Map();
    counts.set(face, (counts.get(face) || 0) + 1);
    votes.set(key, counts);
  }
  const groups = {};
  for (const [key, counts] of votes) {
    const script = key.split('|')[1];
    const entries = [...counts].map(([face, count]) => ({face, count, category: fontCategory(face)}));
    // Prefer sans evidence for CJK roles when it exists (hei/sans is the design class); otherwise the
    // naive majority could keep a serif font that leaked in from an earlier stage.
    const sansCount = entries.filter(entry => entry.category === 'sans').reduce((sum, entry) => sum + entry.count, 0);
    const pool = script === 'cjk' && sansCount > 0 ? entries.filter(entry => entry.category === 'sans') : entries;
    pool.sort((a, b) => b.count - a.count || a.face.localeCompare(b.face));
    groups[key] = {fontFace: pool[0].face, category: pool[0].category,
      count: pool[0].count, total: [...counts.values()].reduce((sum, count) => sum + count, 0)};
  }
  return groups;
}

// Keep this signature: visual-pipeline/visual-build call it for every page, and the local
// refinement path re-runs it with {reselect:true}.
export function unifyPageBodyFonts(p, elements, index, {reselect = false, references = []} = {}) {
  const scope = crypto.createHash('sha256').update(JSON.stringify([
    BODY_FONT_POLICY_VERSION, p.selectedTheme, p.visualPages?.[index]?.previewHash, p.slides?.[index]?.title,
  ])).digest('hex').slice(0, 16);
  const memo = p.rebuildBodyFonts?.[index];
  let groups = !reselect && memo?.policyVersion === BODY_FONT_POLICY_VERSION && memo?.scope === scope
    ? memo.groups : null;
  const candidates = (elements || []).filter(element => pageBodyText(p, element));
  if (!groups) {
    groups = voteGroups(candidates);
    if (Object.keys(groups).length) {
      p.rebuildBodyFonts ||= {};
      p.rebuildBodyFonts[index] = {policyVersion: BODY_FONT_POLICY_VERSION, scope, groups,
        source: 'page-role-script-consensus'};
    }
  }
  const changes = [];
  const next = (elements || []).map(element => {
    if (!pageBodyText(p, element)) return element;
    const script = textScript(element.text);
    if (script === 'math') return element; // preserve math/serif and never drag it into CJK votes
    const target = groups?.[roleGroupOf(element) + '|' + script];
    if (!target || !['sans', 'serif'].includes(target.category)) return element;
    const currentFamily = nativeFontFace(element.fontFace || '');
    const currentCategory = currentFamily ? fontCategory(currentFamily) : null;
    if (currentFamily && currentCategory === target.category) {
      if (currentFamily === target.fontFace) return element;
      // Same sans/serif class: unify to the page/role consensus (old "one body family" rule) but
      // never change the accepted class. Size/weight/spacing are untouched.
      changes.push({key: element.key, requested: element.fontFace, used: target.fontFace,
        reason: '统一同脚本同角色的字体族（保持 sans/serif 类）'});
      const {requestedFontFace, fontSubstitution, ...rest} = element;
      return {...rest, fontFace: target.fontFace, fontCategory: target.category};
    }
    if (currentFamily && currentCategory && ['sans', 'serif', 'calligraphy', 'artistic', 'monospace'].includes(currentCategory)) {
      // A declared CJK serif is valid local evidence. Latin-only serif faces on CJK text are the
      // known cross-script leak; a neighbouring sans object is not grounds to erase Song/FangSong.
      if(script==='cjk'&&currentCategory==='serif'&&/SimSun|Song|Fang|宋|仿宋/i.test(currentFamily))return element;
      // Only correct a cross-class override (the reported sans->serif regression). Unknown families
      // are kept as-is instead of being replaced on weak evidence.
      changes.push({key: element.key, requested: element.fontFace, used: target.fontFace,
        reason: '按角色与文字脚本保持字体族（中文/拉丁/数学分组）'});
      const {requestedFontFace, fontSubstitution, ...rest} = element;
      return {...rest, fontFace: target.fontFace, fontCategory: target.category};
    }
    if (!currentFamily) {
      changes.push({key: element.key, requested: element.fontFace, used: target.fontFace,
        reason: '缺少字体时使用同脚本同角色的字体族'});
      return {...element, fontFace: target.fontFace, fontCategory: target.category};
    }
    return element;
  });
  // Backward-compatible summary: the primary body family (previous single-family return value).
  const primaryFamily = groups?.['body|cjk']?.fontFace || groups?.['body|latin']?.fontFace
    || Object.values(groups || {})[0]?.fontFace || null;
  return {fontFace: primaryFamily, groups, elements: next, changes};
}
