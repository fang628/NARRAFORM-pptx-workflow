// Reference-based correction of literal-underscore math identifiers in formula elements.
//
// Problem: a canonical formula may contain a literal escaped underscore, e.g.
//   \mathrm{step\_num}^{-0.5}
// where the approved preview shows `step` with a subscript `num`. Diagnostics alone cannot fix it.
// This module proposes a generic (no project-key) candidate
//   \mathrm{step}_{\mathrm{num}}^{-0.5}
// renders the original and candidate math with the same formulaSVG proxy, and compares both to the
// approved preview ROI with a bounded, OCR-independent glyph-edge/mask alignment
// (tools/formula_script_fit.py). The candidate is accepted only when the independent reference
// evidence clearly improves, not merely because its width is tighter.
//
// Output contract for integration (Codex):
//   selected formula element:
//     latex: corrected LaTeX (export/render path must keep using `element.latex`)
//     sourceLatex: original canonical LaTeX (audit canonical comparison must use
//                  formulaLatex(element.sourceLatex ?? element.latex))
//     formulaScriptEvidence: {...serializable evidence for audit/review...}
//   retained/ambiguous: element is otherwise unchanged (latex stays original) and carries
//     formulaScriptEvidence with verdict/reason/confidence so review is not silent.
//   non-formula text and formulas without the pattern are never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {Resvg} from '@resvg/resvg-js';
import {formulaSVG} from './formula-native.mjs';
import {formulaLatex} from './formula-content.mjs';

export const FORMULA_SCRIPT_FIT_VERSION = 1;
export const FORMULA_SCRIPT_PATTERN = /\\(mathrm|operatorname)\{([A-Za-z]+)\\_([A-Za-z]+)\}/g;
export function formulaScriptUserRequested(project={}, {index,key,instruction}={}){
  if(project.rebuildFormulaScriptPolicy==='subscript')return true;
  if(project.rebuildFormulaScriptPolicy==='reference')return false;
  const request=project.rebuildFormulaRequests?.[index];
  const local=request&&(!request.targetKeys||key&&request.targetKeys.includes(key))?request.instruction:'';
  return [project.rebuildInstructions,local,instruction].some(value=>{
    const text=String(value||'');
    if(/(?:不要|无需|不必|勿).{0,8}(?:改|修复|修正|转换).{0,12}(?:下标|上下标)|(?:do not|don't).{0,15}(?:fix|change|convert).{0,15}subscripts?/i.test(text))return false;
    return /(?:修复|修正|还原|恢复|补齐).{0,20}(?:下标|上下标)|(?:下标|上下标).{0,24}(?:修复|修正|还原|恢复|补齐)|下划线.{0,15}(?:改|换|还原).{0,8}下标|(?:fix|restore|correct).{0,20}subscripts?/i.test(text);
  });
}

export function rememberFormulaScriptRequest(project,index,instruction,targetKeys=null){
  if(!formulaScriptUserRequested({rebuildInstructions:instruction}))return false;
  project.rebuildFormulaRequests||={};
  project.rebuildFormulaRequests[index]={instruction:String(instruction),targetKeys:targetKeys==null?null:[...targetKeys]};
  return true;
}
const SCENE_WIDTH = 1600;
const SCENE_HEIGHT = 900;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function protectedRanges(latex) {
  const ranges = [];
  const add = (start, end) => { if (end > start) ranges.push([start, end]); };
  // \text{...}, \textrm{...} etc. content is prose, never a math identifier.
  for (const match of latex.matchAll(/\\(?:text|textrm|textbf|textit|textsf|texttt|emph)\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let index = open; index < latex.length; index++) {
      const char = latex[index];
      if (char === '\\') { index++; continue; }
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) { add(match.index, index + 1); break; }
      }
    }
  }
  for (const match of latex.matchAll(/\\verb\*?([^a-zA-Z\s*])([\s\S]*?)\1/g)) add(match.index, match.index + match[0].length);
  for (const match of latex.matchAll(/%[^\n]*/g)) add(match.index, match.index + match[0].length);
  return ranges;
}

const inside = (index, ranges) => ranges.some(([start, end]) => index >= start && index < end);

// All generic candidates for one formula. `latex` is the normalized canonical source (unchanged if
// no candidate); `correctedLatex` replaces every protected math identifier occurrence at once.
export function formulaScriptCandidate(value) {
  let latex;
  try { latex = formulaLatex(value); } catch { return null; }
  const ranges = protectedRanges(latex);
  const patterns = [];
  for (const match of latex.matchAll(FORMULA_SCRIPT_PATTERN)) {
    if (inside(match.index, ranges)) continue;
    patterns.push({source: match[0], offset: match.index, macro: match[1], base: match[2], index: match[3]});
  }
  if (!patterns.length) return null;
  let corrected = '';
  let at = 0;
  for (const pattern of patterns) {
    if (pattern.offset < at) continue;
    corrected += latex.slice(at, pattern.offset);
    corrected += `\\${pattern.macro}{${pattern.base}}_{\\mathrm{${pattern.index}}}`;
    at = pattern.offset + pattern.source.length;
  }
  corrected += latex.slice(at);
  formulaLatex(corrected); // candidate must stay valid LaTeX
  return {latex, correctedLatex: corrected, patterns};
}

// Reference proxy rendering must ignore equation tags: MathJax/`\tag{}` in the current MathJax
// configuration produces a near-zero-width viewBox (the SVG preview proxy renders blank), while
// the approved preview shows the tag as a right-aligned label. Tags are identical for the original
// and the candidate, so removing them preserves the relative glyph evidence.
export function comparisonLatex(latex) {
  return String(latex ?? '').replace(/\\tag\*?\{[^{}]*\}/g, '').replace(/\\label\{[^{}]*\}/g, '').trim();
}

// Approximate exported rendering proxy: formulaSVG places the MathJax SVG in the 1600x900 scene
// exactly like the SVG/compare path. Not a PowerPoint render; reference alignment is the evidence.
export async function renderFormulaScenePng({element, latex, color = 'FFFFFF', background = null}) {
  const formula = formulaSVG({...element, latex: comparisonLatex(latex), color});
  const backdrop = background ? `<rect x="0" y="0" width="${SCENE_WIDTH}" height="${SCENE_HEIGHT}" fill="${background}"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SCENE_WIDTH}" height="${SCENE_HEIGHT}" viewBox="0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}">${backdrop}${formula}</svg>`;
  return new Resvg(svg, {fitTo: {mode: 'width', value: SCENE_WIDTH}}).render().asPng();
}

function pythonBinary() {
  const venv = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return process.env.PPT_AGENT_PYTHON || (fs.existsSync(venv) ? venv : 'python');
}

async function runPython(items,{env,signal,directory}) {
  signal?.throwIfAborted();
  if(env?.run){
    const input=path.join(directory,'input.json'),output=path.join(directory,'output.json');
    fs.writeFileSync(input,JSON.stringify(items));
    await env.run(pythonBinary(),[path.join(root,'tools','formula_script_fit.py'),input,output],
      {windowsHide:true,signal,timeout:60000,maxBuffer:5000000});
    const result=JSON.parse(fs.readFileSync(output,'utf8'));
    if(!Array.isArray(result)||result.length!==items.length)throw Error('公式脚本拟合结果不完整');
    return result;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBinary(), [path.join(root, 'tools', 'formula_script_fit.py')],
      {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],signal});
    let stdout = '', stderr = '', ended = false;
    const finish = (error, value) => { if (ended) return; ended = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('公式脚本拟合超时')); }, 60000);
    child.on('error', finish);
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 5_000_000) { child.kill(); finish(new Error('公式脚本拟合输出过大')); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on('close', code => {
      if (code) return finish(new Error('公式脚本拟合失败：' + stderr));
      try {
        const result = JSON.parse(stdout);
        if (!Array.isArray(result) || result.length !== items.length) throw new Error('公式脚本拟合结果不完整');
        finish(null, result);
      } catch (error) { finish(error); }
    });
    child.stdin.end(JSON.stringify(items));
  });
}

function resolveReference({reference, project, index, env}) {
  if (reference) return reference;
  const page = project?.visualPages?.[index];
  if (!page?.file || !env?.data || !project?.id) return null;
  return path.join(env.data, project.id, page.file);
}

function evidenceBase({candidate, roi, reference, userRequested, result}) {
  const selected = Boolean(result.selected);
  const contradicts = result.reason === 'reference-supports-original' || result.strongOriginal === true;
  const userOverride = Boolean(userRequested) && !selected && !contradicts;
  const verdict = selected ? 'selected' : userOverride ? 'selected-by-user-request'
    : contradicts ? 'retained-reference-conflict' : 'review-required';
  return {
    version: FORMULA_SCRIPT_FIT_VERSION,
    verdict,
    changed: selected || userOverride,
    policy: selected ? 'reference' : userOverride ? 'user-request' : 'reference',
    userRequested: Boolean(userRequested),
    originalLatex: candidate.latex,
    correctedLatex: candidate.correctedLatex,
    patterns: candidate.patterns,
    scores: result.scores,
    referenceSubscript: result.referenceSubscript || null,
    strongOriginal: Boolean(result.strongOriginal),
    margin: result.margin,
    confidence: result.confidence,
    reason: result.reason,
    roi,
    reference: reference ? path.resolve(reference) : null,
    renderProxy: 'formulaSVG+resvg/1600x900 (\\tag stripped for comparison)',
  };
}

async function fitBatch({elements, project, index, reference, env, userRequested = false,signal,targetKeys}) {
  const referenceFile = resolveReference({reference, project, index, env});
  const prepared = [];
  for (const [position, element] of (elements || []).entries()) {
    if (element?.type !== 'formula'||targetKeys&&!targetKeys.includes(element.key)) continue;
    const candidate = formulaScriptCandidate(element.latex);
    if (!candidate) continue;
    prepared.push({position, element, candidate});
  }
  const next = [...(elements || [])];
  if (!prepared.length) return {elements: next, changes: [], evidence: []};
  if (!referenceFile || !fs.existsSync(referenceFile)) {
    for (const item of prepared) {
      const evidence = {version: FORMULA_SCRIPT_FIT_VERSION, verdict: 'review-required', changed: false,
        policy: 'reference', userRequested: Boolean(userRequested), originalLatex: item.candidate.latex,
        correctedLatex: item.candidate.correctedLatex, patterns: item.candidate.patterns, reason: 'reference-unavailable',
        confidence: 0, reference: null};
      next[item.position] = {...item.element, formulaScriptEvidence: evidence};
    }
    return {elements: next, changes: [], evidence: prepared.map(item => ({key: item.element.key,
      verdict: 'review-required', reason: 'reference-unavailable'}))};
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'narra-script-fit-'));
  try {
    const items = [],pending=[],results=[];
    const cacheDirectory=env?.data&&project?.id?path.join(env.data,project.id,'geometry-records','formula-scripts'):null;
    const algorithm=crypto.createHash('sha256').update(fs.readFileSync(referenceFile));
    for(const file of ['tools/formula_script_fit.py','lib/formula-native.mjs', 'lib/formula-script-fit.mjs'])algorithm.update(fs.readFileSync(path.join(root,file)));
    const algorithmHash=algorithm.digest('hex');
    for (const item of prepared) {
      signal?.throwIfAborted();
      item.userRequested=userRequested||formulaScriptUserRequested(project,{index,key:item.element.key});
      const digest=crypto.createHash('sha256').update(JSON.stringify([algorithmHash,item.element,item.candidate])).digest('hex');
      item.cacheFile=cacheDirectory?path.join(cacheDirectory,digest+'.json'):null;
      try{results.push(JSON.parse(fs.readFileSync(item.cacheFile,'utf8')));items.push(null);continue;}catch{}
      results.push(null);
      const originalFile = path.join(directory, 'original-' + item.position + '.png');
      const candidateFile = path.join(directory, 'candidate-' + item.position + '.png');
      fs.writeFileSync(originalFile, await renderFormulaScenePng({element: item.element, latex: item.candidate.latex}));
      fs.writeFileSync(candidateFile, await renderFormulaScenePng({element: item.element, latex: item.candidate.correctedLatex}));
      const inset = Math.max(2, Math.min(6, Math.round(Math.min(item.element.w || 0, item.element.h || 0) * 0.06)));
      const roi = {x: Number(item.element.x || 0) + inset, y: Number(item.element.y || 0) + inset,
        w: Math.max(8, Number(item.element.w || 0) - inset * 2), h: Math.max(8, Number(item.element.h || 0) - inset * 2)};
      items.push({reference: referenceFile, roi, original: originalFile, candidate: candidateFile,
        color: item.element.color || 'FFFFFF',
        hasTag: /\\tag\*?\{/.test(item.candidate.latex)});
      pending.push(prepared.indexOf(item));
    }
    if(pending.length){
      const measured=await runPython(pending.map(position=>items[position]),{env,signal,directory});
      for(const [offset,position]of pending.entries()){
        results[position]=measured[offset];
        const cacheFile=prepared[position].cacheFile;
        if(cacheFile){fs.mkdirSync(cacheDirectory,{recursive:true});const temp=cacheFile+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(measured[offset]));try{fs.renameSync(temp,cacheFile);}catch{fs.rmSync(temp,{force:true});}}
      }
    }
    const changes = [];
    const evidenceList = [];
    for (const [position, item] of prepared.entries()) {
      const result = results[position];
      const roi = items[position]?.roi||result.roi;
      const evidence = evidenceBase({candidate: item.candidate, roi, reference: referenceFile, userRequested:item.userRequested, result});
      if (evidence.changed) {
        next[item.position] = {...item.element, latex: item.candidate.correctedLatex,
          sourceLatex: item.element.sourceLatex || item.candidate.latex, formulaScriptEvidence: evidence};
        changes.push({key: item.element.key, latex: item.candidate.correctedLatex,
          sourceLatex: item.element.sourceLatex || item.candidate.latex, evidence});
      } else {
        next[item.position] = {...item.element, formulaScriptEvidence: evidence};
      }
      evidenceList.push({key: item.element.key, ...evidence});
    }
    return {elements: next, changes, evidence: evidenceList};
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

export async function fitFormulaScripts(context) {
  return fitBatch(context);
}

export async function fitFormulaScript({element,...context}) {
  const result = await fitBatch({...context,elements:[element]});
  return {element: result.elements[0], changed: result.changes.length > 0,
    evidence: result.evidence[0] || null};
}
