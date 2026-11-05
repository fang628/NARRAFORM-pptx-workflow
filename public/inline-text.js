// Shared, dependency-free inline text protocol for content tree, web preview and
// PPTX export. Saved text is ordinary text plus lightweight, non-nested
// <sup>…</sup> / <sub>…</sub> tags. Nothing else is interpreted: unknown tags and
// incomplete tag-like text stay literal, so this is never an HTML execution path.
// Common Unicode superscript/subscript characters (m², H₂O) stay literal and
// readable; ordinary underscores, carets or exponents are never rewritten.
export const inlineTextVersion=1;
export const inlineScriptNames=['sup','sub'];
export const inlineTextRule='段内上标/下标用轻量标记保存：上标 <sup>文字</sup>，下标 <sub>文字</sub>；只标记真正需要上标或下标的片段（单位平方立方、化学式、变量上下标、参考文献角标等），其余文字保持原样。标记不嵌套、不带属性、不成对时不要输出；不要用标记包裹整段文字，也不把普通下划线、乘方写法、普通数字或指数擅自转成上下标。材料中已有的 Unicode 上下标字符（如 m²、H₂O）按可读字符原样保留，不删除也不改写。独立公式仍使用 type=formula 的 LaTeX，不用上下标标记代替公式。';

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
  return source;
}

export function inlinePlainLength(value){
  return plainInlineText(value).length;
}

// Safe truncation by readable characters; a tag is never cut in half.
export function truncateInlineText(value,max){
  const limit=Math.floor(Number(max));
  if(!Number.isFinite(limit)||limit<=0)return '';
  let remaining=limit;const runs=[];
  for(const run of parseInlineText(value).runs){
    if(remaining<=0)break;
    const text=[...run.text].slice(0,remaining).join('');
    remaining-=text.length;
    if(text)runs.push({...run,text});
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
