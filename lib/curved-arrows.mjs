import {visualColor,visualOpacity} from './visual-color.mjs';
import {visualGradient,gradientSVG} from './visual-gradient.mjs';

export const curvedArrowRule='细曲线箭头登记为一个linePath开放Q/C路径，箭头与圆点作为beginArrowType/endArrowType端点信息，按路径切线保留实际头尾、方向及连接对象，不另画端点或建立组合。粗箭头、异形箭头及光条走SVG；SVG曲线箭头可给curveArrow:{start:{x,y},control1:{x,y},control2:{x,y}(可选),end:{x,y},headAt:"start|end|both",startDirection/endDirection:"right|left|up|down|upRight|upLeft|downRight|downLeft",color,strokeWidth,headSize}，坐标为1600×900页面坐标，完整边框包含曲线与尖端。切线与登记端方向不能相反，不以弯曲方向代替尖端朝向，不新增反向箭头。';
const directions={right:[1,0],left:[-1,0],up:[0,-1],down:[0,1],upRight:[Math.SQRT1_2,-Math.SQRT1_2],upLeft:[-Math.SQRT1_2,-Math.SQRT1_2],downRight:[Math.SQRT1_2,Math.SQRT1_2],downLeft:[-Math.SQRT1_2,Math.SQRT1_2]};
const point=p=>p&&['x','y'].every(k=>typeof p[k]==='number'&&Number.isFinite(p[k]))&&p.x>=0&&p.x<=1600&&p.y>=0&&p.y<=900;
const vector=(a,b)=>[b.x-a.x,b.y-a.y];
const unit=v=>{const length=Math.hypot(...v);return length>1e-6?v.map(n=>n/length):null;};
const pair=p=>`${p.x} ${p.y}`;

export function normalizeCurvedArrow(e){
  if(e?.type!=='svg'||!e.curveArrow)return e;
  const c=e.curveArrow,points=[c.start,c.control1,...(c.control2?[c.control2]:[]),c.end];
  if(!points.every(point)||c.start.x===c.end.x&&c.start.y===c.end.y)throw Error('弧线箭头起止点或控制点无效');
  if(!['start','end','both'].includes(c.headAt))throw Error('弧线箭头须明确headAt');
  const strokeWidth=Number(c.strokeWidth??3),headSize=Number(c.headSize??Math.max(10,strokeWidth*4));
  if(!Number.isFinite(strokeWidth)||strokeWidth<=0||strokeWidth>20||!Number.isFinite(headSize)||headSize<4||headSize>100)throw Error('弧线箭头线宽或尖端尺寸无效');
  if(!['x','y','w','h'].every(k=>typeof e[k]==='number'&&Number.isFinite(e[k]))||e.w<=0||e.h<=0)throw Error('弧线箭头须登记完整边框');
  const heads=[];
  for(const side of ['start','end'])if(c.headAt===side||c.headAt==='both'){
    const tip=c[side],other=side==='start'?[c.control1,c.control2,c.end]:[c.control2,c.control1,c.start];
    const tangent=other.filter(Boolean).map(p=>vector(p,tip)).map(unit).find(Boolean),expected=directions[c[side+'Direction']];
    if(!expected||!tangent||tangent[0]*expected[0]+tangent[1]*expected[1]<Math.SQRT1_2-1e-6)throw Error('弧线箭头'+side+'端切线与登记朝向不符，请核对尖端并调整控制点');
    const [dx,dy]=tangent,b={x:tip.x-dx*headSize,y:tip.y-dy*headSize},half=headSize*.42;
    heads.push([tip,{x:b.x-dy*half,y:b.y+dx*half},{x:b.x+dy*half,y:b.y-dx*half}]);
  }
  const geometry=[...points,...heads.flat()];
  if(geometry.some(p=>p.x<e.x+strokeWidth/2||p.y<e.y+strokeWidth/2||p.x>e.x+e.w-strokeWidth/2||p.y>e.y+e.h-strokeWidth/2))throw Error('弧线箭头边框须包含控制点及完整尖端，请扩大边框避免裁断');
  const ink=visualColor(c.color,'272727',{key:e.key,field:'curveArrow.color'}),opacity=ink.alpha*visualOpacity(c.opacity),gradient=c.gradient?visualGradient(c.gradient,{key:e.key}):null;
  const fill=gradient?'url(#curve-gradient)':'#'+ink.color;
  const local=p=>({x:p.x-e.x,y:p.y-e.y});
  const d=`M ${pair(local(c.start))} ${c.control2?'C '+pair(local(c.control1))+' '+pair(local(c.control2)):'Q '+pair(local(c.control1))} ${pair(local(c.end))}`;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${e.w} ${e.h}">${gradient?'<defs>'+gradientSVG(gradient,'curve-gradient',{x:0,y:0,w:e.w,h:e.h})+'</defs>':''}<g opacity="${opacity}"><path d="${d}" fill="none" stroke="${fill}" stroke-width="${strokeWidth}" stroke-linecap="round"/>${heads.map(p=>`<polygon points="${p.map(local).map(p=>`${p.x},${p.y}`).join(' ')}" fill="${fill}"/>`).join('')}</g></svg>`;
  return {...e,svg,curveArrow:{...c,color:ink.color,opacity,strokeWidth,headSize,...(gradient?{gradient}:{})}};
}
