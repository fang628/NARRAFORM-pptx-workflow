import {pathD,transformPath,nativePathXML} from './vector-path.mjs';
import {directionalShapePoints} from './directional-geometry.mjs';
import {gradientSVG} from './visual-gradient.mjs';
import {nativeMarker,nativeLineAttributes} from './native-effects.mjs';

export const LINE_PATH_VERSION=1;
export const THICK_CONNECTOR_WIDTH=8;
export function validateLinePath(value){
 const commands=value?.commands;
 if(!Array.isArray(commands)||commands.length<2||commands.length>160||commands[0]?.op!=='M')throw Error('线路径须为2–160段，以M开始');
 const counts={M:1,L:1,Q:2,C:3};
 const out=commands.map((c,i)=>{
  if(!counts[c?.op]||i>0&&c.op==='M'||!Array.isArray(c.points)||c.points.length!==counts[c.op]
   ||c.points.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!Number.isFinite(v)||v<0||v>1)))throw Error('线路径须为单条开放M/L/Q/C路径，坐标归一化到0–1');
  return {op:c.op,points:c.points.map(p=>[...p])};
 });
 const segmentGroups={};
 for(const [index,label]of Object.entries(value.segmentGroups||{})){
  if(!/^\d+$/.test(index)||Number(index)<1||out[Number(index)]?.op!=='L'||typeof label!=='string'||!label.trim()||label.length>80)throw Error('segmentGroups须以L段命令序号为键、斜度组ID为值');
  segmentGroups[index]=label;
 }
 const nodes=(value.nodes||[]).map(n=>{
  if(!Array.isArray(n.position)||n.position.length!==2||n.position.some(v=>!Number.isFinite(v)||v<0||v>1)||!Number.isFinite(n.diameter)||n.diameter<=0||n.diameter>30)throw Error('路径节点须为归一化位置与实测直径');
  return {position:[...n.position],diameter:n.diameter};
 });
 const terminals={};
 for(const side of ['begin','end'])if(value.terminals?.[side]){
  const diameter=value.terminals[side].diameter;
  if(!Number.isFinite(diameter)||diameter<=0||diameter>30)throw Error('路径圆端点须有实测直径');
  terminals[side]={diameter};
 }
 return {version:LINE_PATH_VERSION,commands:out,...(Object.keys(segmentGroups).length?{segmentGroups}:{}),...(nodes.length?{nodes}:{}),...(Object.keys(terminals).length?{terminals}:{})};
}
export function lineCommands(e){
 return e.linePath?validateLinePath(e.linePath).commands:[
  {op:'M',points:[[e.flipH?1:0,e.flipV?1:0]]},{op:'L',points:[[e.flipH?0:1,e.flipV?0:1]]}];
}
export function normalizeLineNodes(e){
 if(!e.linePath?.nodes?.length)return e;
 const commands=lineCommands(e),vertices=commands.map(c=>c.points.at(-1)),scale=[Math.max(.01,e.w),Math.max(.01,e.h)];
 const anchors=vertices.flatMap((p,i)=>{
  if(i===0||i===vertices.length-1)return [{p,i}];
  const before=commands[i].points.length>1?commands[i].points.at(-2):vertices[i-1],after=commands[i+1].points[0];
  const a=p.map((v,k)=>(v-before[k])*scale[k]),b=p.map((v,k)=>(after[k]-v)*scale[k]);
  const angle=Math.acos(Math.max(-1,Math.min(1,(a[0]*b[0]+a[1]*b[1])/(Math.hypot(...a)*Math.hypot(...b)||1))))*180/Math.PI;
  return angle>3?[{p,i}]:[];
 });
 const nodes=new Map(),terminals={...e.linePath.terminals};let begin=e.beginArrowType,end=e.endArrowType;
 for(const n of e.linePath.nodes){
  const nearest=anchors.map(a=>({...a,d:Math.hypot(...a.p.map((v,k)=>(v-n.position[k])*scale[k]))})).sort((a,b)=>a.d-b.d)[0];
  if(!nearest||nearest.d>Math.min(18,Math.max(8,n.diameter*1.5,(e.strokeWidth||1)*3)))continue;
  const side=nearest.i===0?'begin':nearest.i===vertices.length-1?'end':null;
  if(side){
   const kind=side==='begin'?begin:end;if(kind&&kind!=='none'&&kind!=='oval')continue;
   terminals[side]={diameter:Math.max(n.diameter,terminals[side]?.diameter||0)};
   if(side==='begin')begin='oval';else end='oval';
  }else if(!nodes.has(nearest.i)||nodes.get(nearest.i).diameter<n.diameter)nodes.set(nearest.i,{position:[...nearest.p],diameter:n.diameter});
 }
 const {nodes:oldNodes,terminals:oldTerminals,...linePath}=e.linePath;
 return {...e,linePath:{...linePath,...(nodes.size?{nodes:[...nodes.values()]}:{}),...(Object.keys(terminals).length?{terminals}:{})},...(begin?{beginArrowType:begin}:{}),...(end?{endArrowType:end}:{})};
}
export const linePathD=e=>pathD(transformPath(lineCommands(e),[e.w,0,0,e.h,e.x,e.y]));
export const hasLineNodes=e=>Boolean(e.linePath?.nodes?.length||Object.keys(e.linePath?.terminals||{}).length);
export const hasMeasuredRoundEnd=(e,side)=>e[side+'ArrowType']==='oval'&&e.linePath?.terminals?.[side]&&!e.keepParameters?.includes(side+'ArrowSize');
export function lineStrokePadding(e){
 const dots=(e.linePath?.nodes||[]).map(n=>n.diameter/2);
 const ends=['begin','end'].map(side=>hasMeasuredRoundEnd(e,side)?e.linePath.terminals[side].diameter/2:e[side+'ArrowType']&&e[side+'ArrowType']!=='none'?(e.strokeWidth||1)*5:0);
 return Math.max(3,(e.strokeWidth||1)/2+2,...dots,...ends)+1;
}
export function lineNodePaths(e){
 e=normalizeLineNodes(e);
 const commands=lineCommands(e),ends=['begin','end'].filter(side=>hasMeasuredRoundEnd(e,side)).map(side=>({position:side==='begin'?commands[0].points[0]:commands.at(-1).points.at(-1),diameter:e.linePath.terminals[side].diameter}));
 return [...(e.linePath?.nodes||[]),...ends].map(n=>{
  const [x,y]=n.position,r=n.diameter/2,rx=r/Math.max(.01,e.w),ry=r/Math.max(.01,e.h),k=.55228475;
  return [{op:'M',points:[[x+rx,y]]},{op:'C',points:[[x+rx,y+k*ry],[x+k*rx,y+ry],[x,y+ry]]},{op:'C',points:[[x-k*rx,y+ry],[x-rx,y+k*ry],[x-rx,y]]},{op:'C',points:[[x-rx,y-k*ry],[x-k*rx,y-ry],[x,y-ry]]},{op:'C',points:[[x+k*rx,y-ry],[x+rx,y-k*ry],[x+rx,y]]},{op:'Z',points:[]}];
 });
}
export const lineNodesSVG=e=>lineNodePaths(e).map(commands=>pathD(transformPath(commands,[e.w,0,0,e.h,e.x,e.y])));
export function lineStrokeSVG(e,i=0,{inlineMarkers=false}={}){
 e=normalizeLineNodes(e);
 const ink=e.strokeGradient?'url(#native-stroke-gradient-'+i+')':e.gradient?'url(#native-gradient-'+i+')':'#'+e.color;
 const attrs=nativeLineAttributes(inlineMarkers?{...e,beginArrowType:'none',endArrowType:'none'}:e,i);
 const commands=transformPath(lineCommands(e),[e.w,0,0,e.h,e.x,e.y]);
 const tips=inlineMarkers?['begin','end'].map(side=>{
  const marker=nativeMarker(e,side);if(!marker)return '';
  const begin=side==='begin',end=commands.at(-1),tip=begin?commands[0].points[0]:end.points.at(-1),control=begin?commands[1].points[0]:end.points.length>1?end.points.at(-2):commands.at(-2).points.at(-1);
  const d=begin?[control[0]-tip[0],control[1]-tip[1]]:[tip[0]-control[0],tip[1]-control[1]],angle=Math.atan2(d[1],d[0])*180/Math.PI;
  const {mw,mh,refX,color,opacity,shape}=marker,scale=Math.min(mw,mh)*(e.strokeWidth||1)/8;
  return `<g transform="translate(${tip[0]} ${tip[1]}) rotate(${angle}) scale(${scale}) translate(${-refX} -4)"><g${begin?' transform="rotate(180 4 4)"':''} fill="#${color}" opacity="${opacity}">${shape.replaceAll('currentColor','#'+color)}</g></g>`;
 }).join(''):'';
 return `<path d="${linePathD(e)}" fill="none" stroke="${ink}" stroke-width="${e.strokeWidth??1}" stroke-opacity="${e.colorOpacity??1}" stroke-linejoin="miter"${attrs}/>`+lineNodesSVG(e).map(d=>`<path d="${d}" fill="${ink}" fill-opacity="${e.colorOpacity??1}"/>`).join('')+tips;
}
export function linePathXML(e){return '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="w" b="h"/><a:pathLst><a:path w="100000" h="100000" fill="none" stroke="1">'+nativePathXML(lineCommands(e))+'</a:path>'+lineNodePaths(e).map(commands=>'<a:path w="100000" h="100000" fill="norm" stroke="0">'+nativePathXML(commands)+'</a:path>').join('')+'</a:pathLst></a:custGeom>';}

export function routeStrokeSVG(e){
 if(e?.managed)return e;
 const connector=e?.type==='shape'&&(e.arrowRole==='connector'||/^(right|left|up|down|leftRight|upDown)Arrow$/.test(e.shape||'')||e.irregularArrow===true);
 const thick=e?.type==='line'&&Number(e.strokeWidth)>THICK_CONNECTOR_WIDTH;
 const irregular=e?.type==='line'&&e.irregularArrow===true;
 if(!connector&&!thick&&!irregular)return e;
 const width=Math.max(.1,e.strokeWidth||2),pad=Math.max(8,width*4,lineStrokePadding(e)),w=Math.max(.01,e.w),h=Math.max(.01,e.h);
 let body;
 if(e.type==='line'){
  const local={...e,x:pad,y:pad,w,h,color:e.color||'FFFFFF',strokeWidth:width,opacity:1};
  const defs=(e.gradient?gradientSVG(e.gradient,'native-gradient-0',local):'')+(e.strokeGradient?gradientSVG(e.strokeGradient,'native-stroke-gradient-0',local):'');
  body='<defs>'+defs+'</defs>'+lineStrokeSVG(local,0,{inlineMarkers:true});
 }else{
  const points=e.customGeometry?.points||directionalShapePoints({...e,arrowTail:e.arrowTail||'shaft',arrowDirection:e.arrowDirection||e.shape?.replace('Arrow','')||'right'});
  const ink=e.gradient?'url(#stroke-paint)':'#'+(e.fill||e.color||'FFFFFF');
  body=(e.gradient?'<defs>'+gradientSVG(e.gradient,'stroke-paint',{x:pad,y:pad,w,h})+'</defs>':'')+(e.customGeometry?.commands?'<path d="'+pathD(transformPath(e.customGeometry.commands,[w,0,0,h,pad,pad]))+'"':'<polygon points="'+points.map(([x,y])=>`${pad+x*w},${pad+y*h}`).join(' ')+'"')+' fill="'+ink+'"/>';
 }
 const {linePath,initialRepresentation,objectIdentity,shape,customGeometry,shapeGeometry,arrowRole,arrowTail,arrowDirection,gradient,strokeGradient,nativeRequired,contourKind,adjustments,...rest}=e;
 return {...rest,type:'svg',x:e.x-pad,y:e.y-pad,w:w+pad*2,h:h+pad*2,
  initialRepresentation:'svg',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w+pad*2} ${h+pad*2}"><g opacity="${(e.opacity??1)*(e.type==='line'?1:e.fillOpacity??1)}">${body}</g></svg>`,
  representationOrigin:'svg-stroke-silhouette',...(objectIdentity?{objectIdentity:{...objectIdentity,type:'svg'}}:{})};
}

