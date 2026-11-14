import {visualGradient} from './visual-gradient.mjs';
import {nativeCarrierElements,isTextCarrier,isVisualEffect,nativeCarrierRule,inferTextCarriers,carrierSVGParts} from './native-carriers.mjs';
import {identifyLightEffects} from './light-effects.mjs';
import {routeLightBar} from './light-bars.mjs';
import {registerRepresentation,representationOf} from './registered-representation.mjs';
import {routeStrokeSVG} from './line-path.mjs';

export const representationRule='先区分文本承载、独立图标与现实素材；'+nativeCarrierRule+'几何、填充、描边和光效分别拟合；不能因为有渐变就选SVG。基础形状判断核对凹凸、平行、对称与真实杆身，不能仅按顶点数定类型。复杂非承载平面图标使用SVG；现实材质和复杂画面用兼容提取。';
const attrs=text=>{
  const a=Object.fromEntries([...text.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1],m[2]]));
  if(a.style)for(const item of a.style.split(';')){const at=item.indexOf(':');if(at>0&&a[item.slice(0,at).trim()]===undefined)a[item.slice(0,at).trim()]=item.slice(at+1).trim();}
  return a;
};
const number=(v,fallback)=>v===undefined?fallback:/^[+-]?(?:\d*\.)?\d+$/.test(v)?Number(v):NaN;
const ratio=(v,fallback)=>v===undefined?fallback:v.endsWith('%')?Number(v.slice(0,-1))/100:number(v,NaN);
const color=v=>{v=({white:'#FFFFFF',black:'#000000',red:'#FF0000',none:'000000'})[v]||v;if(/^#[\da-f]{3}$/i.test(v||''))v='#'+[...v.slice(1)].map(c=>c+c).join('');return /^#?[\da-f]{6}$/i.test(v||'')?v.replace('#','').toUpperCase():null;};
export function paint(v,svg,box){
  if(!v)return null;
  const id=v.match(/^url\(#([\w.-]+)\)$/)?.[1];
  if(!id)return color(v)?{color:color(v),opacity:v==='none'?0:1}:null;
  const matches=[...svg.matchAll(/<(linearGradient|radialGradient)\b([^>]*)>([\s\S]*?)<\/\1>/g)];
  const match=matches.find(m=>attrs(m[2]).id===id);if(!match)return null;
  const a=attrs(match[2]);if(a.gradientTransform||a.href||a['xlink:href']||a.gradientUnits&&!['objectBoundingBox','userSpaceOnUse'].includes(a.gradientUnits)||a.spreadMethod&&a.spreadMethod!=='pad')return null;
  const stops=[...match[3].matchAll(/<stop\b([^>]*)\/?\s*>/g)].map(m=>{const s=attrs(m[1]);return {position:ratio(s.offset,0),color:color(s['stop-color']||'#000000'),opacity:number(s['stop-opacity'],1)};});
  if(stops.some(s=>!s.color))return null;
  let gradient;
  if(match[1]==='linearGradient'){
    const user=a.gradientUnits==='userSpaceOnUse';
    const coordinate=(value,axis,fallback)=>{
      if(!user)return ratio(value,fallback);
      const origin=axis==='x'?box.x:box.y,extent=axis==='x'?box.w:box.h,viewport=axis==='x'?box.view[2]:box.view[3];
      if(box.view[0]!==0||box.view[1]!==0)return NaN;
      const actual=value===undefined?fallback*viewport:String(value).endsWith('%')?ratio(value,0)*viewport:number(value,NaN);
      return (actual-origin)/extent;
    };
    const x1=coordinate(a.x1,'x',0),y1=coordinate(a.y1,'y',0),x2=coordinate(a.x2,'x',1),y2=coordinate(a.y2,'y',0);
    const dx=x2-x1,dy=y2-y1,norm=dx*dx+dy*dy;
    if(![x1,y1,x2,y2].every(Number.isFinite)||norm<1e-12)return null;
    // Transform the gradient FIELD, not its endpoint vector. Non-square SVG
    // objectBoundingBox gradients otherwise acquire the wrong diagonal angle.
    const physicalNorm=(dx*box.w)**2+(dy*box.h)**2;
    const ax=user?dx*box.w/physicalNorm:dx/(box.w*norm),ay=user?dy*box.h/physicalNorm:dy/(box.h*norm),length=Math.hypot(ax,ay),ux=ax/length,uy=ay/length;
    const slope=length*(Math.abs(ux)*box.w+Math.abs(uy)*box.h),offset=ax*box.w/2+ay*box.h/2-(x1*box.w*ax+y1*box.h*ay)-slope/2;
    const sorted=[...stops].sort((a,b)=>a.position-b.position);
    if(sorted.length<2||sorted.some(s=>!Number.isFinite(s.position)||!Number.isFinite(s.opacity)))return null;
    const sample=t=>{
      const at=sorted.findLastIndex(s=>s.position<=t);if(at<0)return {...sorted[0]};if(at===sorted.length-1)return {...sorted.at(-1)};
      const lo=sorted[at],up=sorted[at+1],f=(t-lo.position)/(up.position-lo.position||1),rgb=s=>[0,2,4].map(i=>parseInt(s.color.slice(i,i+2),16));
      return {color:rgb(lo).map((v,i)=>Math.round(v+(rgb(up)[i]-v)*f).toString(16).padStart(2,'0')).join('').toUpperCase(),opacity:lo.opacity+(up.opacity-lo.opacity)*f};
    };
    const mapped=[{...sample(offset),position:0},...sorted.map(s=>({...s,position:(s.position-offset)/slope})).filter(s=>s.position>1e-8&&s.position<1-1e-8),{...sample(offset+slope),position:1}];
    gradient={type:'linear',angle:Math.atan2(uy,ux)*180/Math.PI,stops:mapped};
  }else{
    if(a.gradientUnits==='userSpaceOnUse')return null;
    const cx=ratio(a.cx,.5),cy=ratio(a.cy,.5),r=ratio(a.r,.5);
    if(a.fx!==undefined&&ratio(a.fx,cx)!==cx||a.fy!==undefined&&ratio(a.fy,cy)!==cy||Math.abs(r-Math.max(cx,1-cx,cy,1-cy))>.001)return null;
    gradient={type:'radial',center:{x:cx,y:cy},stops};
  }
  try{gradient=visualGradient(gradient);return {color:gradient.stops[0].color,gradient,opacity:1};}catch{return null;}
}

// Convert only unambiguous self-contained SVGs. Unsupported effects, inheritance,
// coordinate transforms or partial gradients remain vector assets unchanged.
export function preferNativeRepresentation(element){
  if(representationOf(element)==='svg')return element;
  if(element?.representationOrigin==='svg-light-bar')return element;
  if(element?.type!=='svg'||typeof element.svg!=='string')return element;
  const svg=element.svg;
  if(/<(?:g|use|filter|image|text|style|script|clipPath|mask|pattern)\b|\b(?:transform|class)\s*=|<!|<\?xml-stylesheet/i.test(svg))return element;
  const root=attrs(svg.match(/<svg\b([^>]*)>/)?.[1]||'');
  const view=root.viewBox?.trim().split(/[ ,]+/).map(Number);
  if(!view||view.length!==4||!view.every(Number.isFinite)||view[2]<=0||view[3]<=0||root.style||root.opacity||root.fill||root.stroke)return element;
  const shapes=[...svg.matchAll(/<(rect|circle|ellipse|polygon)\b([^>]*)\/?\s*>/g)];
  if(shapes.length!==1||/<(?:path|polyline|line)\b/.test(svg))return element;
  const [_,kind,raw]=shapes[0],a=attrs(raw);
  if(a.filter||a.transform||a['clip-path']||a.mask||a['stroke-dasharray']||a['vector-effect']||a['stroke-linejoin']&&a['stroke-linejoin']!=='miter'||a['fill-rule']==='evenodd')return element;
  // Uniform scale keeps a single native outline width physically equivalent.
  const sx=element.w/view[2],sy=element.h/view[3];if(Math.abs(sx-sy)>.001)return element;
  let x,y,w,h,points;
  if(kind==='rect'){x=number(a.x,0);y=number(a.y,0);w=number(a.width,NaN);h=number(a.height,NaN);}
  else if(kind==='circle'||kind==='ellipse'){const rx=number(a.rx,number(a.r,NaN)),ry=number(a.ry,number(a.r,NaN));x=number(a.cx,0)-rx;y=number(a.cy,0)-ry;w=2*rx;h=2*ry;}
  else{
    const values=a.points?.trim().split(/[ ,]+/).map(Number);if(!values||values.length<6||values.length>320||values.length%2||!values.every(Number.isFinite))return element;
    points=Array.from({length:values.length/2},(_,i)=>values.slice(i*2,i*2+2));x=Math.min(...points.map(p=>p[0]));y=Math.min(...points.map(p=>p[1]));w=Math.max(...points.map(p=>p[0]))-x;h=Math.max(...points.map(p=>p[1]))-y;
  }
  if(![x,y,w,h].every(Number.isFinite)||w<=0||h<=0)return element;
  let cornerRadius=0;
  if(kind==='rect'){
    const rx=Math.min(w/2,number(a.rx,number(a.ry,0))),ry=Math.min(h/2,number(a.ry,number(a.rx,0)));
    if(!Number.isFinite(rx)||!Number.isFinite(ry)||rx<0||ry<0||Math.abs(rx-ry)>.001)return element;
    cornerRadius=rx/Math.min(w,h);
  }
  const fill=paint(a.fill||'#000000',svg,{x,y,w,h,view}),stroke=paint(a.stroke||'none',svg,{x,y,w,h,view});if(!fill||!stroke)return element;
  const opacity=number(a.opacity,1),fillOpacity=number(a['fill-opacity'],1)*fill.opacity,colorOpacity=number(a['stroke-opacity'],1)*stroke.opacity,strokeWidth=number(a['stroke-width'],1)*sx;
  if(![opacity,fillOpacity,colorOpacity].every(n=>n>=0&&n<=1)||!Number.isFinite(strokeWidth)||strokeWidth>20)return element;
  const {svg:old,curveArrow,...rest}=element;
  return {...rest,type:kind==='rect'?'rect':kind==='polygon'?'shape':'ellipse',...(cornerRadius?{shapeGeometry:{cornerRadius}}:{}),...(points?{shape:'freeform',customGeometry:{points:points.map(p=>[(p[0]-x)/w,(p[1]-y)/h]),closed:true}}:{}),x:element.x+(x-view[0])*sx,y:element.y+(y-view[1])*sy,w:w*sx,h:h*sy,fill:fill.color,color:stroke.color,opacity,fillOpacity,colorOpacity,strokeWidth:stroke.opacity?strokeWidth:0,...(fill.gradient?{gradient:fill.gradient}:{}),...(stroke.gradient?{strokeGradient:stroke.gradient}:{}),representationOrigin:'native-from-simple-svg'};
}

export function routeRebuildRepresentations(elements){
  if(!Array.isArray(elements))return elements;
  elements=identifyLightEffects(elements.map(e=>registerRepresentation(routeStrokeSVG(routeLightBar(e)))));
  // Do not let an explicitly named glow become a carrier merely because its
  // enclosing rectangle overlaps text. Keep light in a separate SVG layer.
  elements=elements.map(e=>{
    if(e?.type!=='svg'||!isVisualEffect(e)&&!/(?:^glow[-_]|光晕|外发光|发光轮廓|light-effect)/i.test(e.key+' '+(e.description||'')))return e;
    try{const {parts}=carrierSVGParts(e.svg);if(!parts.length||!parts.every(p=>p.style.fill==='none'))return e;}catch{return e;}
    const {frameKind,nativeRequired,isFrame,carrierTextIds,...rest}=e;
    // Legacy responses sometimes approximate blur by identical fat hard paths.
    // Restore a soft-only layer; the carrier itself owns the crisp edge.
    let svg=e.svg;
    if(!/<filter\b/.test(svg)){
      const view=attrs(svg.match(/<svg\b([^>]*)>/)?.[1]||'').viewBox?.trim().split(/[ ,]+/).map(Number);
      const scale=view?.length===4?Math.sqrt(e.w*e.h/(view[2]*view[3])):1,filters=[];
      svg=svg.replace(/<(path|polygon|rect)\b([^>]*?)\/?\s*>/g,(tag,kind,raw)=>{
        const a=attrs(raw),width=Number(a['stroke-width']||1);
        if(a.fill!=='none'||!Number.isFinite(width)||width*scale<=4&&e.effectKind!=='halo')return tag;
        const id='nf-soft-light-'+filters.length,blur=Math.max(.75/scale,width*.22);
        filters.push(`<filter id="${id}" x="-40%" y="-40%" width="180%" height="180%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${blur}"/></filter>`);
        const clean=raw.replace(/\s(?:stroke-width|filter)\s*=\s*["'][^"']*["']/g,'');
        return `<${kind}${clean} stroke-width="${Math.min(width,1.5/scale)}" filter="url(#${id})"/>`;
      });
      if(filters.length)svg=svg.replace(/<svg\b[^>]*>/,root=>root+'<defs>'+filters.join('')+'</defs>');
    }
    return {...rest,svg,role:'effect',visualKind:'light-effect'};
  });
  elements=inferTextCarriers(elements);
  return elements.flatMap(e=>{
    if(isVisualEffect(e))return e;
    if(representationOf(e)==='svg'||representationOf(e)==='cutout')return e;
    if(isTextCarrier(e))return nativeCarrierElements(e,{paint});
    return e;
  });
}
