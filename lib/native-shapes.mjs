import {directionalShapePoints} from './directional-geometry.mjs';
export const nativeShapeKinds=['roundRect','plaque','triangle','rtTriangle','diamond','hexagon','pentagon','chevron','parallelogram','trapezoid','rightArrow','leftArrow','upArrow','downArrow','leftRightArrow','upDownArrow'];
export function progressArrowPoints(e){
  const {head,leftTip}=e.progressGeometry||{};
  if(!Number.isFinite(head)||head<=0||head>e.h||!Number.isFinite(leftTip)||leftTip<0||leftTip>head*2||e.w<head*4)throw Error('进度箭形路径参数无效');
  return [[head,0],[e.w-head,0],[e.w,e.h/2],[e.w-head,e.h],[head,e.h],[leftTip,e.h/2]];
}
export function applyNativeProgressGeometry(xml,elements){
  const shapes=new Map(elements.filter(e=>e.type==='shape'&&(e.progressGeometry||e.arrowTail)).map(e=>[e.key,e]));
  return xml.replace(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g,shape=>{
    const e=shapes.get(shape.match(/<p:cNvPr\b[^>]*\bname="([^"]+)"/)?.[1]);if(!e)return shape;
    const points=e.progressGeometry?progressArrowPoints(e).map(([x,y])=>[Math.round(x/e.w*100000),Math.round(y/e.h*100000)]):directionalShapePoints(e).map(([x,y])=>[Math.round(x*100000),Math.round(y*100000)]);
    const path=points.map(([x,y],i)=>`<a:${i?'lnTo':'moveTo'}><a:pt x="${x}" y="${y}"/></a:${i?'lnTo':'moveTo'}>`).join('');
    const custom=`<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="w" b="h"/><a:pathLst><a:path w="100000" h="100000">${path}<a:close/></a:path></a:pathLst></a:custGeom>`;
    return shape.replace(/<a:prstGeom\b[^>]*>[\s\S]*?<\/a:prstGeom>/,custom);
  });
}
export function nativeShapeGeometry(e){
  const directional=directionalShapePoints(e);
  if(directional)return `polygon points="${directional.map(([a,b])=>`${e.x+a*e.w},${e.y+b*e.h}`).join(' ')}"`;
  const {x,y,w,h}=e,p=(a,b)=>`${x+a*w},${y+b*h}`;
  if(e.shape==='plaque'){
    const r=Math.min(w,h)*Math.max(0,Math.min(50000,e.adjustments?.adj??16667))/100000;
    if(!r)return `rect x="${x}" y="${y}" width="${w}" height="${h}"`;
    return `path d="M ${x+r} ${y} H ${x+w-r} A ${r} ${r} 0 0 0 ${x+w} ${y+r} V ${y+h-r} A ${r} ${r} 0 0 0 ${x+w-r} ${y+h} H ${x+r} A ${r} ${r} 0 0 0 ${x} ${y+h-r} V ${y+r} A ${r} ${r} 0 0 0 ${x+r} ${y} Z"`;
  }
  if(e.progressGeometry)return `polygon points="${progressArrowPoints(e).map(([a,b])=>`${x+a},${y+b}`).join(' ')}"`;
  const points={triangle:[[.5,0],[1,1],[0,1]],rtTriangle:[[0,0],[1,1],[0,1]],diamond:[[.5,0],[1,.5],[.5,1],[0,.5]],hexagon:[[.25,0],[.75,0],[1,.5],[.75,1],[.25,1],[0,.5]],pentagon:[[.5,0],[1,.38],[.81,1],[.19,1],[0,.38]],chevron:[[0,0],[.75,0],[1,.5],[.75,1],[0,1],[.25,.5]],parallelogram:[[.25,0],[1,0],[.75,1],[0,1]],trapezoid:[[.2,0],[.8,0],[1,1],[0,1]]};
  const notch=Math.min(w,h)*(e.adjustments?.adj??50000)/100000/w;points.chevron=[[0,0],[1-notch,0],[1,.5],[1-notch,1],[0,1],[notch,.5]];
  if(e.shape==='hexagon'&&e.adjustments?.adj!==undefined){const inset=Math.min(.5,Math.min(w,h)*e.adjustments.adj/100000/w);points.hexagon=[[inset,0],[1-inset,0],[1,.5],[1-inset,1],[inset,1],[0,.5]];}
  const arrow=head=>[[0,.25],[1-head,.25],[1-head,0],[1,.5],[1-head,1],[1-head,.75],[0,.75]],double=head=>[[0,.5],[head,0],[head,.25],[1-head,.25],[1-head,0],[1,.5],[1-head,1],[1-head,.75],[head,.75],[head,1]];
  const horizontal=Math.min(w,h)*.5/w,vertical=Math.min(w,h)*.5/h,right=arrow(horizontal),down=arrow(vertical);
  Object.assign(points,{rightArrow:right,leftArrow:right.map(([a,b])=>[1-a,b]),upArrow:down.map(([a,b])=>[b,1-a]),downArrow:down.map(([a,b])=>[b,a]),leftRightArrow:double(horizontal),upDownArrow:double(vertical).map(([a,b])=>[b,a])});
  return e.shape==='roundRect'?`rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(w,h)*(e.adjustments?.adj??16667)/100000}"`:`polygon points="${points[e.shape].map(([a,b])=>p(a,b)).join(' ')}"`;
}
