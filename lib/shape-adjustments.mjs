const multi=new Set(['rightArrow','leftArrow','upArrow','downArrow','leftRightArrow','upDownArrow']);
export const shapeAdjustmentRule='框体不能因调节点格式省略。adjustments使用对象，如{adj:12000}表示12%，0–100000为DrawingML刻度；双参数箭形用{adj1:50000,adj2:50000}。不确定时保留正确轮廓并省略调节点，或用SVG精确重绘，不删除框体。';

export function shapeAdjustments(value,{shape,key='unknown'}={}){
  if(value==null)return undefined;
  const invalid=()=>Error(`原生图形调节点无效（元素 ${key}）：${shapeAdjustmentRule}`);
  function number(v,{ratio=false}={}){
    if(typeof v==='string'){
      const m=v.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(%)?$/);if(!m)throw invalid();
      v=Number(m[1])*(m[2]?1000:1);if(m[2])ratio=false;
    }
    if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>100000)throw invalid();
    return Math.round((ratio&&v<=1||v>0&&v<1)?v*100000:v);
  }
  if(typeof value==='string'&&/^\s*[\[{]/.test(value))try{value=JSON.parse(value);}catch{throw invalid();}
  if(typeof value==='number'||typeof value==='string')return {adj:number(value,{ratio:true})};
  if(Array.isArray(value)){
    if(!value.length)return undefined;
    if(value.length>(multi.has(shape)?2:1))throw invalid();
    return Object.fromEntries(value.map((v,i)=>[multi.has(shape)&&value.length>1?'adj'+(i+1):'adj',number(v,{ratio:true})]));
  }
  if(typeof value!=='object'||Object.keys(value).some(k=>!/^adj\d?$/.test(k)))throw invalid();
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,number(v)]));
}
