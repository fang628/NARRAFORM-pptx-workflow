// Markdown/LaTeX is the portable source; HTML, images and OMML are derived views.
export const formulaLimit=4000;
export const formulaPlanningRule='公式按需选用：识别材料中的公式、上下标、分数、根式、求和、积分、矩阵及变量含义；仅当公式服务于本页需要说明的内容且能清晰呈现时，主动建立独立type=formula节点，latex保存准确LaTeX，markdown保存$$包围的Markdown公式。公式从属于对应观点或小标题，不把公式当普通文本、表格或图片，不拆断表达式、不虚构推导；必要变量解释另建独立短文本。设计稿和预览提示词的嵌套内容列表直接给出实际Markdown公式，重建为可编辑Office原生公式，不能用公式截图或普通文本替代。';
export const formulaScriptRule='数学下标用 _{...} 保存，多字母下标用 _{\\mathrm{...}}，如 d_{\\mathrm{model}}、\\mathrm{step}_{\\mathrm{num}}；不能把材料或预览中实际位于基线下方的字写成 \\mathrm{step\\_num} 的字面下划线。上下标同属一个变量时使用 base_{sub}^{sup}，不能漏掉下标。文件名、代码标识或普通正文的字面下划线仍按原文保留，不能全局按下划线猜测上下标。';
export function formulaScriptDiagnostics(value){
  const latex=formulaLatex(value),issues=[];
  for(const match of latex.matchAll(/\\(?:mathrm|operatorname)\{([A-Za-z]+)\\_([A-Za-z0-9]+)\}/g))issues.push({
    kind:'literal-underscore-identifier',source:match[0],offset:match.index,
    reason:'字面下划线不会成为数学下标；须与材料或批准预览核对，不能按名称自动改写',
  });
  return issues;
}
export function formulaLatex(value){
  let source=typeof value==='string'?value:value?.latex??value?.markdown;
  if(typeof source!=='string')throw Error('公式须包含LaTeX或Markdown公式');
  source=source.trim();
  if(source.startsWith('$$')&&source.endsWith('$$'))source=source.slice(2,-2).trim();
  else if(source.startsWith('\\[')&&source.endsWith('\\]'))source=source.slice(2,-2).trim();
  else if(source.startsWith('\\(')&&source.endsWith('\\)'))source=source.slice(2,-2).trim();
  else if(source.startsWith('$')&&source.endsWith('$'))source=source.slice(1,-1).trim();
  if(!source||source.length>formulaLimit)throw Error('公式须为1–4000字的LaTeX');
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source)||/\\(?:input|include|write|openout|read|catcode|usepackage|documentclass|href|url|html\w*|includegraphics|require|def|newcommand|renewcommand|csname)\b/i.test(source)||/<\/?(?:script|iframe|img|svg|math)\b/i.test(source))throw Error('公式包含不支持的外部引用或命令');
  return source;
}
export const formulaMarkdown=value=>'$$\n'+formulaLatex(value)+'\n$$';
// Inline prose math is only recognized when the body carries a real math
// signal; bare currency pairs ($5 ... $10), ordinary underscores and plain
// numbers therefore stay text. Explicit \(...\) delimiters are trusted LaTeX.
export function isFormulaLatexLike(value){
  const source=String(value??'').trim();
  if(!source||source.length>formulaLimit)return false;
  return /\\[a-zA-Z]+|[\^_{}]|√/.test(source)||/(?:[A-Za-z0-9)\]]\s*[=<>+\-*/×÷±≤≥≠≈]\s*[A-Za-z0-9(\[])/.test(source);
}
export const validateFormulaContent=value=>{const latex=formulaLatex(value);return {latex,markdown:formulaMarkdown(latex)};};
const symbols={'α':'\\alpha ','β':'\\beta ','γ':'\\gamma ','δ':'\\delta ','ε':'\\epsilon ','θ':'\\theta ','λ':'\\lambda ','μ':'\\mu ','π':'\\pi ','σ':'\\sigma ','Σ':'\\sum ','∑':'\\sum ','∫':'\\int ','∞':'\\infty ','≤':'\\le ','≥':'\\ge ','≠':'\\ne ','×':'\\times ','·':'\\cdot ','±':'\\pm ','∂':'\\partial ','∇':'\\nabla '};
export function mathTreeLatex(node){
  if(!node||typeof node!=='object')return '';
  const c=(node.children||[]).map(mathTreeLatex),body=c.join(''),text=String(node.text||'').replace(/\u2061/g,' ').replace(/[{}%#&]/g,'\\$&').replace(/[αβγδεθλμπσΣ∑∫∞≤≥≠×·±∂∇]/g,s=>symbols[s]);
  switch(node.tag){
    case 'mi':return node.attributes?.mathvariant==='normal'&&/^[a-zA-Z]+$/.test(text)?(/^(?:sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|sinh|cosh|tanh|log|ln|exp|lim|max|min|det|gcd)$/.test(text)?'\\'+text+' ':'\\operatorname{'+text+'}'):text+body;
    case 'mfrac':return '\\frac{'+c[0]+'}{'+c[1]+'}';
    case 'msup':return '{'+c[0]+'}^{'+c[1]+'}';
    case 'msub':return '{'+c[0]+'}_{'+c[1]+'}';
    case 'msubsup':return '{'+c[0]+'}_{'+c[1]+'}^{'+c[2]+'}';
    case 'msqrt':return '\\sqrt{'+body+'}';
    case 'mroot':return '\\sqrt['+c[1]+']{'+c[0]+'}';
    case 'munderover':return '{'+c[0]+'}_{'+c[1]+'}^{'+c[2]+'}';
    case 'munder':return '{'+c[0]+'}_{'+c[1]+'}';
    case 'mover':return /[¯‾]/.test(c[1])?'\\overline{'+c[0]+'}':'\\overset{'+c[1]+'}{'+c[0]+'}';
    case 'mtable':return '\\begin{matrix}'+c.join(' \\\\ ')+'\\end{matrix}';
    case 'mtr':return c.join(' & ');
    case 'mtext':return '\\text{'+text+body+'}';
    default:return text+body;
  }
}
export function sourceFormulaCatalog(material,source=String(material?.text||'')){
  const originals=(material?.richText?.structures||[]).filter(s=>s.type==='formula'&&s.end<=source.length);
  const presentation=(material?.presentation?.slides||[]).flatMap(page=>(page.objects||[]).flatMap(object=>(object.formulas||[]).map(math=>({math,page:page.number,objectId:object.id}))));
  return [...originals,...presentation].slice(0,60).flatMap((s,i)=>{
    try{return [{id:'F'+(i+1),...validateFormulaContent(s.latex||mathTreeLatex(s.math)||source.slice(s.start,s.end)),start:s.start,end:s.end,...(s.page?{page:s.page,objectId:s.objectId}:{})}];}catch{return [];}
  });
}
