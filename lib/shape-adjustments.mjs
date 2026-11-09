const multi=new Set(['rightArrow','leftArrow','upArrow','downArrow','leftRightArrow','upDownArrow']);
export const shapeAdjustmentRule='框体不能因调节点格式省略。先识别圆、椭圆、星形、六边形、五边形、箭形、平尾箭形、矩形、平行四边形或三角形，再测细节。shapeGeometry:{slantAngle:60,headDepth:0.15,notchDepth:0.12,cornerRadius:0.04,cutCorner:0.02,shaftRatio:0.5}按需登记；slantAngle是斜边与水平边夹角（度），独立移动斜边而不改宽高；headDepth/notchDepth相对箭头指向的总长度（横向为宽度、竖向为高度），不是相对较短边，cornerRadius/cutCorner相对较短边；六边形保持对称。不要靠拉长或压扁框体改变斜率。实测异形色块可用shape:freeform，customGeometry:{points:[[0,0],[1,0],[0.8,1],[0,1]],closed:true}登记3–160个相对自身边界归一化的闭合轮廓点；不套用近似预设，填充、渐变、描边和阴影独立保留。adjustments使用对象，如{adj:12000}表示12%，0–100000为DrawingML刻度；双参数箭形用{adj1:50000,adj2:50000}，adj1控制窄杆宽度、adj2控制头部长度，不能忽略杆身比例。四角向内凹陷的矩形使用原生shape:plaque（不是roundRect或斜切四角），adjustments:{adj:16667}控制内凹半径，范围0–50000；填充、渐变、阴影、描边分别保留。slantSign=1表示平行四边形上边向右偏移，-1向左。不确定时保留正确原生轮廓并省略调节点；曲边用customGeometry的M/L/Q/C/Z闭合路径，逐角圆角/切角用shapeGeometry.version:2与corners参数，不转SVG或删除框体。';

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
