// Shared, dependency-free inline text protocol for content tree, web preview and
// PPTX export. Saved text is ordinary text plus lightweight, non-nested
// <sup>…</sup> / <sub>…</sub> tags and explicit inline LaTeX \(…\). Nothing else
// is interpreted: unknown tags and incomplete tag-like text stay literal, so this
// is never an HTML execution path.
import {formulaLatex,isFormulaLatexLike} from './formula-content.js';
export const inlineTextVersion=1;
export const inlineScriptNames=['sup','sub'];
export const inlineMathRule='句内根式、分式、多层上下标等数学结构用行内LaTeX保存：只把公式本身写成 \\(...\\) 并与同一文本节点的普通文字混排，例如“增长率为 \\(\\sqrt{a^2+b^2}\\)”；不把整句变成公式，不虚构公式、变量或数值。简单单位平方/化学式仍优先用 <sup>…</sup> / <sub>…</sub>；普通货币符号、下划线、乘方写法或没有明确数学含义的 LaTeX 源串保持原样。独立公式仍用 type=formula 的 LaTeX，不用行内标记代替。';
export const inlineTextRule='段内上标/下标用轻量标记保存：上标 <sup>文字</sup>，下标 <sub>文字</sub>；只标记真正需要上标或下标的片段（单位平方立方、化学式、变量上下标、参考文献角标等），其余文字保持原样。标记不嵌套、不带属性、不成对时不要输出；不要用标记包裹整段文字，也不把普通下划线、乘方写法、普通数字或指数擅自转成上下标。材料中已有的 Unicode 上下标字符（如 m²、H₂O）按可读字符原样保留，不删除也不改写。独立公式仍使用 type=formula 的 LaTeX，不用上下标标记代替公式。'+inlineMathRule;

const escapeMap={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const escapeInlineText=value=>String(value??'').replace(/[&<>"']/g,char=>escapeMap[char]);
const scriptTagPattern=/<(sup|sub)>([^<]*)<\/\1>/gi;
const danglingTagPattern=/<\/?(?:sup|sub)\b/i;
const emptyTagPattern=/<(sup|sub)><\/\1>/i;

// Parse saved text into readable plain text plus ordered script runs.
// `script` is null, 'sup' or 'sub'; adjacent runs with the same script merge.
export function parseInlineText(value){
  const source=String(value??''),runs=[];let index=0;
  for(const match of source.matchAll(scriptTagPattern)){
    if(match.index>index)runs.push({text:source.slice(index,match.index),script:null});
    const text=match[2];
    if(text)runs.push({text,script:match[1].toLowerCase()});
    index=match.index+match[0].length;
  }
  if(index<source.length)runs.push({text:source.slice(index),script:null});
  const merged=[];
  for(const run of runs){
    if(!run.text)continue;
    const previous=merged.at(-1);
    if(previous&&previous.script===run.script)previous.text+=run.text;
    else merged.push({...run});
  }
  return {text:merged.map(run=>run.text).join(''),runs:merged};
}

// Readable text without presentation tags. No escaping, no character rewriting.
export function plainInlineText(value){
  return parseInlineText(value).text;
}

// Safe display HTML: every character is escaped; only sup/sub contain markup.
// Works in browsers and in Node (returned as a plain string).
export function renderInlineText(value){
  return parseInlineText(value).runs.map(run=>run.script?`<${run.script}>${escapeInlineText(run.text)}</${run.script}>`:escapeInlineText(run.text)).join('');
}

// Runs for callers that need the structure (UI, previews, import helpers).
export function inlineRuns(value){
  return parseInlineText(value).runs;
}

export function hasInlineScript(value){
  return parseInlineText(value).runs.some(run=>run.script);
}

// Rebuild the canonical saved string from runs.
export function formatInlineRuns(runs){
  return (runs||[]).map(run=>run?.text?(run.script?`<${run.script}>${run.text}</${run.script}>`:run.text):'').join('');
}

// Inline LaTeX spans embedded in prose. Explicit \(...\) is always trusted math;
// $...$ is math only when it carries a real math signal, so "$5 ... $10" and
// ordinary underscores stay text. Invalid or unsafe LaTeX is left literal.
export function inlineMathSegments(value){
  const source=String(value??''),found=[];
  const add=(start,end,body,delimiter)=>{
    if(!body.trim())return;
    try{const latex=formulaLatex(body);found.push({start,end,latex,delimiter});}catch{}
  };
  for(const match of source.matchAll(/\\\(([^\n]*?)\\\)/g))add(match.index,match.index+match[0].length,match[1],'paren');
  for(const match of source.matchAll(/(?<![\\$])\$(?!\$)([^\n$]+?)\$(?!\$)/g))if(isFormulaLatexLike(match[1]))add(match.index,match.index+match[0].length,match[1],'dollar');
  found.sort((a,b)=>a.start-b.start||b.end-a.end);
  const segments=[];let end=0;
  for(const segment of found){if(segment.start<end)continue;segments.push(segment);end=segment.end;}
  return segments;
}
export function hasInlineMath(value){
  return inlineMathSegments(value).length>0;
}
export function inlineMathMarkup(latex,{delimiter='paren'}={}){
  const value=formulaLatex(latex);
  return delimiter==='dollar'?'$'+value+'$':'\\('+value+'\\)';
}
// Split a plain text fragment into alternating text/math parts. The raw math
// source is kept for callers that must not silently drop an unsupported context.
export function splitInlineMath(value){
  const source=String(value??''),segments=inlineMathSegments(source),parts=[];let at=0;
  for(const segment of segments){
    if(segment.start>at)parts.push({type:'text',text:source.slice(at,segment.start)});
    parts.push({type:'math',latex:segment.latex,raw:source.slice(segment.start,segment.end),delimiter:segment.delimiter});
    at=segment.end;
  }
  if(at<source.length)parts.push({type:'text',text:source.slice(at)});
  return parts.length?parts:[{type:'text',text:source}];
}

// Canonical saved text: lower-case tags, no empty runs, otherwise unchanged.
export function normalizeInlineText(value){
  return formatInlineRuns(parseInlineText(value).runs);
}

// Validate a saved text value without silently dropping script markup.
// Throws for nested, attributed, empty or unclosed sup/sub tags.
export function assertInlineText(value){
  const source=String(value??'');
  if(emptyTagPattern.test(source))throw Error('上下标标记不能为空：请删除空标记或补上文字');
  if(danglingTagPattern.test(source.replace(scriptTagPattern,''))){
    throw Error('上下标标记格式无效：只能使用完整的 <sup>文字</sup> 或 <sub>文字</sub>，不能嵌套、添加属性或不闭合');
  }
  const opens=(source.match(/\\\(/g)||[]).length,closes=(source.match(/\\\)/g)||[]).length;
  if(opens!==closes)throw Error('行内公式标记格式无效：只能使用成对的 \\(...\\)');
  for(const match of source.matchAll(/\\\(([^\n]*?)\\\)/g)){
    let depth=0,balanced=true;
    for(const [index,char] of [...match[1]].entries()){
      if(char==='{'&&match[1][index-1]!=='\\')depth++;
      else if(char==='}'&&match[1][index-1]!=='\\'&&--depth<0){balanced=false;break;}
    }
    if(!balanced||depth!==0)throw Error('行内公式无效：花括号未成对');
    try{formulaLatex(match[1]);}
    catch{throw Error('行内公式无效：请检查 \\(...\\) 中的LaTeX语法或不支持的命令');}
  }
  return source;
}

export function inlinePlainLength(value){
  return plainInlineText(value).length;
}

// Safe truncation by readable characters; a tag or inline formula is never cut
// in half. Math source is kept atomic and omitted rather than broken.
export function truncateInlineText(value,max){
  const limit=Math.floor(Number(max));
  if(!Number.isFinite(limit)||limit<=0)return '';
  let remaining=limit;const runs=[];
  for(const run of parseInlineText(value).runs){
    for(const part of splitInlineMath(run.text)){
      if(remaining<=0)break;
      if(part.type==='math'){
        const raw=part.raw||'' , needed=Math.max(1,raw.length);
        if(needed<=remaining){runs.push({text:raw,script:run.script});remaining-=needed;}
        else{remaining=0;break;}
      }else{
        const text=[...part.text].slice(0,remaining).join('');
        remaining-=text.length;
        if(text)runs.push({...run,text});
      }
    }
    if(remaining<=0)break;
  }
  return formatInlineRuns(runs);
}

// PPTX helper: plain text returns the original string, script text returns
// pptxgenjs run objects. Run options only carry superscript/subscript; the caller
// must merge the element's base font options into each run (pptxgenjs replaces
// paragraph options when a run supplies its own). Common Unicode superscript and
// subscript characters are converted to their base character plus a native
// baseline run so PowerPoint carries real superscript/subscript formatting.
export function nativeInlineText(value){
  const source=String(value??''),{text,runs}=parseInlineText(source),converted=[];
  for(const run of runs){
    let buffer='';
    const pushBuffer=()=>{if(buffer){converted.push({text:buffer,script:run.script||null});buffer='';}};
    for(const char of run.text){
      const unicodeScript=unicodeScriptKind(char);
      if(!run.script&&unicodeScript){pushBuffer();converted.push({text:unicodeScriptText(char),script:unicodeScript});continue;}
      buffer+=char;
    }
    pushBuffer();
  }
  const needsScript=runs.some(run=>run.script)||converted.some(run=>run.script);
  if(!needsScript)return text;
  const merged=[];
  for(const run of converted){
    const previous=merged.at(-1);
    if(previous&&previous.script===run.script)previous.text+=run.text;
    else merged.push({...run});
  }
  return merged.map(run=>({text:run.text,options:run.script==='sup'?{superscript:true}:run.script==='sub'?{subscript:true}:{}}));
}

// Native text + inline math parts for PPTX builders. Text runs keep the exact
// sup/sub/Unicode behavior of nativeInlineText; math segments stay structured
// until they are converted to OMML and replace their placeholder run.
export function nativeInlineTextParts(value){
  const source=String(value??'');
  if(!hasInlineMath(source))return nativeInlineText(source);
  const parts=[];
  const pushText=(text,script)=>{
    if(!text)return;
    let buffer='';
    const flush=()=>{if(buffer){parts.push({type:'text',text:buffer,script:script||null});buffer='';}};
    for(const char of text){
      const unicodeScript=unicodeScriptKind(char);
      if(!script&&unicodeScript){flush();parts.push({type:'text',text:unicodeScriptText(char),script:unicodeScript});continue;}
      buffer+=char;
    }
    flush();
  };
  for(const run of parseInlineText(source).runs){
    for(const part of splitInlineMath(run.text)){
      if(part.type==='math'&&!run.script)parts.push({type:'math',latex:part.latex});
      else pushText(part.type==='math'?part.raw:part.text,run.script);
    }
  }
  const merged=[];
  for(const part of parts){
    const previous=merged.at(-1);
    if(part.type==='text'&&previous?.type==='text'&&previous.script===part.script)previous.text+=part.text;
    else merged.push({...part});
  }
  return merged;
}

// Unicode compatibility for script characters kept as readable glyphs in saved text.
const unicodeSuperscripts=new Map(Object.entries({'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9','⁺':'+','⁻':'-','⁼':'=','⁽':'(','⁾':')','ⁱ':'i','ⁿ':'n','ʰ':'h','ʲ':'j','ˡ':'l','ˢ':'s','ʳ':'r','ʷ':'w','ˣ':'x','ʸ':'y','ᵃ':'a','ᵇ':'b','ᶜ':'c','ᵈ':'d','ᵉ':'e','ᶠ':'f','ᵍ':'g','ᵏ':'k','ᵐ':'m','ᵒ':'o','ᵖ':'p','ᵗ':'t','ᵘ':'u','ᵛ':'v','ᶻ':'z'}));
const unicodeSubscripts=new Map(Object.entries({'₀':'0','₁':'1','₂':'2','₃':'3','₄':'4','₅':'5','₆':'6','₇':'7','₈':'8','₉':'9','₊':'+','₋':'-','₌':'=','₍':'(','₎':')','ₐ':'a','ₑ':'e','ₒ':'o','ₓ':'x','ₔ':'ə','ₕ':'h','ₖ':'k','ₗ':'l','ₘ':'m','ₙ':'n','ₚ':'p','ₛ':'s','ₜ':'t','ᵢ':'i','ᵣ':'r','ᵤ':'u','ᵥ':'v','ⱼ':'j'}));
export function unicodeScriptKind(char){
  if(unicodeSuperscripts.has(char))return 'sup';
  if(unicodeSubscripts.has(char))return 'sub';
  return null;
}
export function unicodeScriptText(char){
  return unicodeSuperscripts.get(char)??unicodeSubscripts.get(char)??char;
}

// Line layout for previews: keeps script runs while measuring readable characters.
// `measure(char, firstInLine)` returns the advance in the caller's unit.
export function layoutInlineLines(value,{width=Infinity,measure=char=>char.codePointAt(0)>255?1:.57}={}){
  const lines=[];let line=[],used=0;
  const flush=()=>{lines.push(line);line=[];used=0;};
  for(const run of parseInlineText(value).runs){
    let buffer='';
    const flushRun=()=>{if(buffer){line.push({text:buffer,script:run.script});buffer='';}};
    for(const char of run.text){
      if(char==='\n'){flushRun();flush();continue;}
      let advance=measure(char,used===0);
      // Overflow ends the current line but the character still belongs to the next
      // one; re-measure it as the first line character rather than dropping it.
      if(used+advance>width&&(line.length||buffer)){flushRun();flush();advance=measure(char,true);}
      buffer+=char;used+=advance;
    }
    flushRun();
  }
  if(line.length||!lines.length)lines.push(line);
  return lines;
}

// Build saved markup from extracted rich text spans (Word/PDF runs).
// `spans` carry {start,end} in UTF-16 units and a vertical style field.
export function inlineMarkupFromSpans(value,spans=[],{verticalOf=span=>span?.vertical}={}){
  const source=String(value??'');
  const ranges=(spans||[]).map(span=>{
    const vertical=String(verticalOf(span)||'').toLowerCase(),start=Number(span?.start),end=Number(span?.end);
    if(!['superscript','subscript','sup','sub'].includes(vertical)||!Number.isInteger(start)||!Number.isInteger(end)||end<=start||start<0||end>source.length)return null;
    return {start,end,script:vertical.startsWith('sub')?'sub':'sup'};
  }).filter(Boolean).sort((a,b)=>a.start-b.start||b.end-a.end);
  if(!ranges.length)return source;
  let out='',at=0;
  for(const range of ranges){
    if(range.start<at)continue;
    out+=source.slice(at,range.start);
    out+=`<${range.script}>${source.slice(range.start,range.end)}</${range.script}>`;
    at=range.end;
  }
  return out+source.slice(at);
}
