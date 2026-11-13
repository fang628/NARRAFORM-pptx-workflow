import {carrierSVGParts} from './native-carriers.mjs';

export const lightRecognitionRule='独立光条、光带和弧形光环使用同一个SVG对象，保留一条实际亮芯及其柔光，不再叠加原生line。从属于框体边缘的高光不能另画SVG，在框上登记edgeHighlight:{edge:"top|bottom|left|right"}，由S4/S5拟合填充和描边还原。普通原生线不带发光、阴影。原生色块、圆形及箭头禁止发光；实际阴影记shadow，不复制主体，不另建光晕绕过限制。复杂独立光效使用SVG，不把柔光外缘或拖尾清点成独立线条。实际可见连续亮芯及端点/走向时才记effectKind:"lit-stroke",lighting:{coreConfirmed:true,evidence:"细亮芯依据"}。不确定时不补亮芯，柔光与实体描边独立判断。';

export function absorbFrameHighlights(elements){
 const removed=new Set(),hints=new Map();
 for(const e of elements||[]){
  if(e.type!=='svg'||!/(?:高光|上缘|下缘|edge[-_ ]?light|edge[-_ ]?highlight)/i.test([e.key,e.description].join(' ')))continue;
  const horizontal=e.w>=e.h;
  const owners=elements.filter(p=>['shape','rect'].includes(p.type)&&!p.managed&&p.role!=='effect'
   &&(horizontal?p.w>e.w*.8&&p.h>e.h*2&&e.x>=p.x-12&&e.x+e.w<=p.x+p.w+12:
     p.h>e.h*.8&&p.w>e.w*2&&e.y>=p.y-12&&e.y+e.h<=p.y+p.h+12));
  const explicit=owners.find(p=>p.key===(e.parentKey||e.effectOf));
  const owner=explicit||owners.find(p=>horizontal?Math.min(Math.abs(e.y+e.h/2-p.y),Math.abs(e.y+e.h/2-p.y-p.h))<=Math.max(10,e.h):
   Math.min(Math.abs(e.x+e.w/2-p.x),Math.abs(e.x+e.w/2-p.x-p.w))<=Math.max(10,e.w));
  if(!owner)continue;
  const edge=horizontal?(Math.abs(e.y+e.h/2-owner.y)<Math.abs(e.y+e.h/2-owner.y-owner.h)?'top':'bottom'):
   (Math.abs(e.x+e.w/2-owner.x)<Math.abs(e.x+e.w/2-owner.x-owner.w)?'left':'right');
  hints.set(owner.key,{edge});removed.add(e.key);
 }
 return {removed,elements:(elements||[]).filter(e=>!removed.has(e.key)).map(e=>({...e,...(hints.has(e.key)?{edgeHighlight:hints.get(e.key)}:{}),
  ...(e.memberKeys?{memberKeys:e.memberKeys.filter(k=>!removed.has(k))}:{})}))};
}
const area=e=>Math.max(0,e.w)*Math.max(0,e.h);
const intersection=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
export function identifyLightEffects(elements){
 if(!Array.isArray(elements))return elements;
 return elements.map(e=>{
  if(e?.type!=='svg')return e;
  const description=String(e.description||'').replace(/(?:无|没有|不带|without|no)\s*(?:光晕|光影|发光|glow|halo)/gi,'');
  const named=e.role==='effect'||e.effectKind||/(?:^|[-_])(?:light|glow)(?:$|[-_])/i.test(e.key)||/(?:光晕|光带|发光轮廓|辉光|halo)/i.test(description);
  if(!named)return e;
  let parts;try{parts=carrierSVGParts(e.svg).parts;}catch{return e;}
  const outlineOnly=parts.length&&parts.every(p=>p.style.fill==='none');
  if(!outlineOnly&&!e.effectKind&&e.role!=='effect')return e;
  const core=e.lighting?.coreConfirmed===true&&typeof e.lighting.evidence==='string'&&e.lighting.evidence.length>=8;
  const kind=core&&e.effectKind==='lit-stroke'?'lit-stroke':'halo';
  const owners=elements.filter(p=>p.key!==e.key&&!p.managed&&['shape','rect','ellipse'].includes(p.type)&&p.role!=='effect'&&area(p)>2000&&intersection(e,p)/Math.max(1,Math.max(area(e),area(p)))>.65);
  const owner=owners.sort((a,b)=>intersection(e,b)/area(b)-intersection(e,a)/area(a))[0];
  const {frameKind,nativeRequired,isFrame,carrierTextIds,...rest}=e;
  // Keep the measured/redrawn SVG layers as-is: replacing outlined rings/beams with one radial
  // gradient blob destroyed the layer structure (HUD rings, rectangular table glow, light beams)
  // that the reference actually shows. The source SVG already carries its own blur/glow layers.
  // Feathered edges: the outermost edge (radial halos) or both ends (elongated beams) fade to
  // fully transparent, so a light effect never ends in a hard cut against the page.
  const svg=featherEffectSVG(e.svg,e.w,e.h);
  return {...rest,svg,role:'effect',visualKind:'light-effect',effectKind:kind,...(e.effectOf||owner?{effectOf:e.effectOf||owner.key}:{}),lighting:{...e.lighting,coreConfirmed:kind==='lit-stroke',evidence:kind==='lit-stroke'?e.lighting.evidence:'识别为柔光区域，未以独立细亮芯作为线条依据'}};
 });
}

// Wrap an effect SVG in an alpha feather mask: radial halos fade out at the outer edge; elongated
// light beams fade out at both ends. Mask coordinates follow the source viewBox so the original
// drawing is untouched.
export function featherEffectSVG(svg,w=100,h=100){
  const text=String(svg||'');
  if(text.includes('id="nf-effect-feather-mask"'))return text;
  const open=text.match(/<svg\b[^>]*>/i);
  const close=text.lastIndexOf('</svg>');
  if(!open||close<0)return text;
  const attrs=open[0];
  const view=String(attrs.match(/viewBox\s*=\s*["']([^"']+)["']/i)?.[1]||'').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  let vx=0,vy=0,vw=Number(w)||100,vh=Number(h)||100;
  if(view.length===4&&view.every(Number.isFinite)&&view[2]>0&&view[3]>0){[vx,vy,vw,vh]=view;}
  const inner=text.slice(open.index+attrs.length,close);
  const aspect=vw/Math.max(1,vh);
  let defs;
  if(aspect>=1.6){
    defs=`<linearGradient id="nf-effect-feather-fade" gradientUnits="userSpaceOnUse" x1="${vx}" y1="${vy}" x2="${vx+vw}" y2="${vy}"><stop offset="0" stop-color="#000"/><stop offset="0.14" stop-color="#FFF"/><stop offset="0.86" stop-color="#FFF"/><stop offset="1" stop-color="#000"/></linearGradient>`;
  }else if(aspect<=1/1.6){
    defs=`<linearGradient id="nf-effect-feather-fade" gradientUnits="userSpaceOnUse" x1="${vx}" y1="${vy}" x2="${vx}" y2="${vy+vh}"><stop offset="0" stop-color="#000"/><stop offset="0.14" stop-color="#FFF"/><stop offset="0.86" stop-color="#FFF"/><stop offset="1" stop-color="#000"/></linearGradient>`;
  }else{
    defs=`<radialGradient id="nf-effect-feather-fade" gradientUnits="userSpaceOnUse" cx="${vx+vw/2}" cy="${vy+vh/2}" r="${Math.max(vw,vh)/2}"><stop offset="0" stop-color="#FFF"/><stop offset="0.72" stop-color="#FFF"/><stop offset="1" stop-color="#000"/></radialGradient>`;
  }
  defs+=`<mask id="nf-effect-feather-mask" maskUnits="userSpaceOnUse" x="${vx}" y="${vy}" width="${vw}" height="${vh}"><rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="url(#nf-effect-feather-fade)"/></mask>`;
  return `${attrs}<defs>${defs}</defs><g mask="url(#nf-effect-feather-mask)">${inner}</g></svg>`;
}
