import {directionalShapePoints} from './directional-geometry.mjs';
import {detailedShapeSVG,detailedShapeXML} from './shape-geometry.mjs';
import {validateNativePath,pathD,transformPath} from './vector-path.mjs';
import {linePathXML} from './line-path.mjs';
import {frameStrokePaths} from './frame-edge-ownership.mjs';
import {adjustableGeometry} from './adjustable-geometry.mjs';
export const nativeShapeKinds=['roundRect','plaque','triangle','rtTriangle','diamond','hexagon','pentagon','star5','chevron','parallelogram','trapezoid','rightArrow','leftArrow','upArrow','downArrow','leftRightArrow','upDownArrow','freeform'];
export function validateCustomGeometry(geometry){
  if(geometry?.commands)return validateNativePath(geometry);
  const points=geometry?.points;
  if(!Array.isArray(points)||points.length<3||points.length>160||geometry.closed===false||points.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!Number.isFinite(v)||v<0||v>1)))throw Error('原生异形轮廓须为3–160个归一化顶点的闭合路径');
  const area=Math.abs(points.reduce((sum,[x,y],i)=>{const [nx,ny]=points[(i+1)%points.length];return sum+x*ny-nx*y;},0))/2;
  if(area<.002)throw Error('原生异形轮廓面积无效');
  return {points:points.map(p=>[...p]),closed:true};
}
export function progressArrowPoints(e){
  const {head,leftTip}=e.progressGeometry||{};
  if(!Number.isFinite(head)||head<=0||head>e.h||!Number.isFinite(leftTip)||leftTip<0||leftTip>head*2||e.w<head*4)throw Error('进度箭形路径参数无效');
  return [[head,0],[e.w-head,0],[e.w,e.h/2],[e.w-head,e.h],[head,e.h],[leftTip,e.h/2]];
}
export function footerTrapezoidPoints(e){
  const inset=e.footerGeometry?.inset;
  if(e.footerGeometry?.kind!=='right-trapezoid'||!Number.isFinite(inset)||inset<=0||inset>=e.w)throw Error('页脚直角梯形路径参数无效');
  return [[inset,0],[e.w,0],[e.w,e.h],[0,e.h]];
}
export function applyNativeProgressGeometry(xml,elements){
  const frameStrokes=frameStrokePaths(elements);
  if(frameStrokes.size)xml=xml.replace(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g,shape=>{
    const key=shape.match(/<p:cNvPr\b[^>]*\bname="([^"]+)"/)?.[1],owned=frameStrokes.get(key);if(!owned)return shape;
    const e=elements.find(e=>e.key===key),geometry=adjustableGeometry(e,{stroke:owned.stroke}).xml;
    return shape.replace(/<a:(prstGeom|custGeom)\b[^>]*>[\s\S]*?<\/a:\1>/,geometry);
  });
  const shapes=new Map(elements.filter(e=>e.type==='line'&&e.linePath||['shape','rect'].includes(e.type)&&(e.customGeometry||e.shapeGeometry||e.shape==='star5'||e.progressGeometry||e.arrowTail||e.footerGeometry)).map(e=>[e.key,e]));
  return xml.replace(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g,shape=>{
    const e=shapes.get(shape.match(/<p:cNvPr\b[^>]*\bname="([^"]+)"/)?.[1]);if(!e||frameStrokes.has(e.key))return shape;
    if(e.type==='line')return shape.replace(/<a:(prstGeom|custGeom)\b[^>]*>[\s\S]*?<\/a:\1>/,linePathXML(e));
    const geometry=detailedShapeXML(e);
    return geometry?shape.replace(/<a:(prstGeom|custGeom)\b[^>]*>[\s\S]*?<\/a:\1>/,geometry):shape;
  });
}
export function nativeShapeGeometry(e){
  if(e.customGeometry?.commands)return `path d="${pathD(transformPath(validateCustomGeometry(e.customGeometry).commands,[e.w,0,0,e.h,e.x,e.y]))}"`;
  if(e.customGeometry)return `polygon points="${validateCustomGeometry(e.customGeometry).points.map(([a,b])=>`${e.x+a*e.w},${e.y+b*e.h}`).join(' ')}"`;
  if(e.shape==='plaque'){
    const {x,y,w,h}=e,r=Math.min(w,h)*Math.max(0,Math.min(.5,e.shapeGeometry?.cornerRadius??(e.adjustments?.adj??16667)/100000));
    if(!r)return `rect x="${x}" y="${y}" width="${w}" height="${h}"`;
    return `path d="M ${x+r} ${y} H ${x+w-r} A ${r} ${r} 0 0 0 ${x+w} ${y+r} V ${y+h-r} A ${r} ${r} 0 0 0 ${x+w-r} ${y+h} H ${x+r} A ${r} ${r} 0 0 0 ${x} ${y+h-r} V ${y+r} A ${r} ${r} 0 0 0 ${x+r} ${y} Z"`;
  }
  if(!e.managed&&(e.shapeGeometry||e.shape==='star5')){const geometry=detailedShapeSVG(e);if(geometry)return geometry;}
  if(e.footerGeometry)return `polygon points="${footerTrapezoidPoints(e).map(([a,b])=>`${e.x+a},${e.y+b}`).join(' ')}"`;
  const directional=directionalShapePoints(e);
  if(directional)return `polygon points="${directional.map(([a,b])=>`${e.x+a*e.w},${e.y+b*e.h}`).join(' ')}"`;
  const {x,y,w,h}=e,p=(a,b)=>`${x+a*w},${y+b*h}`;
  if(e.shape==='rect')return `rect x="${x}" y="${y}" width="${w}" height="${h}"`;
  if(e.progressGeometry)return `polygon points="${progressArrowPoints(e).map(([a,b])=>`${x+a},${y+b}`).join(' ')}"`;
  const points={triangle:[[.5,0],[1,1],[0,1]],rtTriangle:[[0,0],[1,1],[0,1]],diamond:[[.5,0],[1,.5],[.5,1],[0,.5]],hexagon:[[.25,0],[.75,0],[1,.5],[.75,1],[.25,1],[0,.5]],pentagon:[[.5,0],[1,.38],[.81,1],[.19,1],[0,.38]],chevron:[[0,0],[.75,0],[1,.5],[.75,1],[0,1],[.25,.5]],parallelogram:[[.25,0],[1,0],[.75,1],[0,1]],trapezoid:[[.2,0],[.8,0],[1,1],[0,1]]};
  const notch=Math.min(w,h)*(e.adjustments?.adj??50000)/100000/w;points.chevron=[[0,0],[1-notch,0],[1,.5],[1-notch,1],[0,1],[notch,.5]];
  if(e.shape==='hexagon'&&e.adjustments?.adj!==undefined){const inset=Math.min(.5,Math.min(w,h)*e.adjustments.adj/100000/w);points.hexagon=[[inset,0],[1-inset,0],[1,.5],[1-inset,1],[inset,1],[0,.5]];}
  const arrow=head=>[[0,.25],[1-head,.25],[1-head,0],[1,.5],[1-head,1],[1-head,.75],[0,.75]],double=head=>[[0,.5],[head,0],[head,.25],[1-head,.25],[1-head,0],[1,.5],[1-head,1],[1-head,.75],[head,.75],[head,1]];
  const horizontal=Math.min(w,h)*.5/w,vertical=Math.min(w,h)*.5/h,right=arrow(horizontal),down=arrow(vertical);
  Object.assign(points,{rightArrow:right,leftArrow:right.map(([a,b])=>[1-a,b]),upArrow:down.map(([a,b])=>[b,1-a]),downArrow:down.map(([a,b])=>[b,a]),leftRightArrow:double(horizontal),upDownArrow:double(vertical).map(([a,b])=>[b,a])});
  return e.shape==='roundRect'?`rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(w,h)*(e.adjustments?.adj??16667)/100000}"`:`polygon points="${points[e.shape].map(([a,b])=>p(a,b)).join(' ')}"`;
}
