// Macro names omit the leading slash. Keep macros unexpanded in saved LaTeX.
export const formulaEditorMacros={
  tag:{args:1,def:'\\qquad\\text{(#1)}',expand:false},
  'tag*':{args:1,def:'\\qquad\\text{#1}',expand:false},
  label:{args:1,def:'',expand:false},
  dots:{def:'\\ldots',expand:false},
  dotsc:{def:'\\ldots',expand:false},
  dotsb:{def:'\\cdots',expand:false},
  dotsm:{def:'\\cdots',expand:false},
  dotsi:{def:'\\cdots',expand:false},
  dotso:{def:'\\ldots',expand:false},
};

export function formulaErrorMessage(errors=[]){
  return [...new Set(errors.map(error=>{
    if(error.code==='unknown-command')return '不支持的公式命令：'+(error.arg||'未知命令');
    if(error.code==='unknown-environment')return '不支持的公式环境：'+(error.arg||'未知环境');
    if(error.code==='unbalanced-braces'||error.code==='unbalanced-environment')return '公式括号或环境未配对';
    if(error.code==='missing-argument')return '公式命令缺少参数'+(error.arg?'：'+error.arg:'');
    return '公式语法错误：'+error.code+(error.arg?'（'+error.arg+'）':'');
  }))].join('；');
}

export function configureFormulaField(field){
  field.macros={...field.macros,...formulaEditorMacros};
}

export function formulaFieldMessage(field){
  const message=formulaErrorMessage(field.errors||[]);
  field.setAttribute('aria-invalid',String(!!message));
  if(message)field.title=message;else field.removeAttribute('title');
  return message;
}
