// All scene distances are in the 1600x900 logical canvas; PowerPoint uses 0.6 pt/unit.
export const textSpacingRule='按预览中每个文本对象的实际疏密提取charSpacing（附加字距，可为0或小幅负值）和lineSpacing（相邻行基线距离）；两者均为1600×900逻辑单位，不是pt或倍数。逐对象观察，不全页套同一行距；不新增或修改段距，不增删准确文案、换行与空格来模拟间距。无法辨认时字距用0，行距先用字号的1.2倍，再依据实际PowerPoint渲染局部修正。';
export function textSpacing(e,size){
  const out={};
  function distance(value,field){
    if(typeof value==='string'){
      const m=value.trim().match(/^(-?\d+(?:\.\d+)?)\s*(px|pt|em|%)?$/i);
      if(!m)throw Error('原生文字间距无效（'+e.key+' · '+field+'）');
      value=Number(m[1])*(m[2]?.toLowerCase()==='pt'?1/.6:m[2]?.toLowerCase()==='em'?size:m[2]==='%'?size/100:1);
    }
    if(typeof value!=='number'||!Number.isFinite(value))throw Error('原生文字间距无效（'+e.key+' · '+field+'）');
    return value;
  }
  if(e.charSpacing!=null)out.charSpacing=Math.max(-size*.15,Math.min(size*.4,distance(e.charSpacing,'charSpacing')));
  const line=e.lineSpacing??(e.lineSpacingMultiple!=null?String(e.lineSpacingMultiple)+'em':undefined);
  if(line!=null)out.lineSpacing=Math.max(size,Math.min(size*3,distance(line,'lineSpacing')));
  return out;
}
export function nativeTextSpacingOptions(e){
  return {...(e.charSpacing!=null?{charSpacing:e.charSpacing*.6}:{}),...(e.lineSpacing!=null?{lineSpacing:e.lineSpacing*.6}:{} )};
}
