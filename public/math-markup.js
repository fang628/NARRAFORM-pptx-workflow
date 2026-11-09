import {formulaLatex,isFormulaLatexLike} from './formula-content.js';
const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Delimited Markdown math only: prose, currency and ordinary underscores stay text.
const pattern=/(?<!\\)\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|(?<![\\$])\$(?!\$)([^\n$]+?)\$(?!\$)|\\\(([^\n]+?)\\\)/g;
export function mathFieldMarkup(value,{block=false}={}){
  try{const latex=formulaLatex(value);return `<math-field read-only class="${block?'design-formula':'inline-formula'}" data-formula-latex="${h(latex)}" aria-label="${block?'设计稿公式':'段内公式'}">${h(latex)}</math-field>`;}
  catch{return h(value);}
}
export function renderMathText(value,renderText=h){
  const text=String(value??'');let out='',at=0;
  for(const match of text.matchAll(pattern)){
    // A bare $...$ pair is only a formula when it carries real math signals;
    // ordinary currency pairs ("$5 与 $10") and prose stay text.
    if(match[3]!==undefined&&!isFormulaLatexLike(match[3])){out+=renderText(text.slice(at,match.index+match[0].length));at=match.index+match[0].length;continue;}
    out+=renderText(text.slice(at,match.index));
    out+=mathFieldMarkup(match[1]??match[2]??match[3]??match[4],{block:match[1]!==undefined||match[2]!==undefined});at=match.index+match[0].length;
  }
  return out+renderText(text.slice(at));
}
