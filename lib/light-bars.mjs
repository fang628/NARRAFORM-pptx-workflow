import {visualColor,visualOpacity} from './visual-color.mjs';
import {gradientSVG} from './visual-gradient.mjs';
import {nativeEffectDefs,nativeLineAttributes,nativeTransform} from './native-effects.mjs';
import {nativeShapeGeometry} from './native-shapes.mjs';

const visibleGlow=e=>e.glow&&(e.glow.opacity??.3)>0&&(e.glow.radius??4)>0;
const visibleShadow=e=>e.shadow&&e.shadow.type!=='none'&&(e.shadow.opacity??.3)>0;
export function isNativeLightBar(e){
  if(!e||e.managed||!['line','rect','shape'].includes(e.type))return false;
  const description=(e.key||'')+' '+(e.description||'');
  const named=/光条|光带|light[-_ ]?(?:bar|beam|streak)|(?:^|[-_\s])streak(?:$|[-_\s])/i.test(description);
  if(e.tableId||e.tableRole||/table|header|panel|banner/i.test(e.key||''))return false;
  if(e.role==='carrier'||e.nativeRequired||e.frameKind)return false;
  return !e.carrierTextIds?.length&&!!(named||e.lineEffect==='lit'||e.class==='light-strip'||e.classHint==='light-strip');
}

// Change the representation in place. One key remains one object; no extra
// native core is left underneath the SVG light bar.
export function routeLightBar(e){
  if(!isNativeLightBar(e))return e;
  const glow=visibleGlow(e)?{...e.glow,color:visualColor(e.glow.color,'FFFFFF').color,opacity:visualOpacity(e.glow.opacity??.3),radius:Number(e.glow.radius??4)}:null;
  const shadow=!glow&&visibleShadow(e)?{type:'outer',color:visualColor(e.shadow.color,'000000').color,opacity:visualOpacity(e.shadow.opacity??.3),blur:Number(e.shadow.blur??4),offset:Number(e.shadow.offset??2),angle:Number(e.shadow.angle??90)}:null;
  const width=Math.max(.1,Number(e.strokeWidth??1)),pad=Math.max(3,width/2+2,(glow?.radius||0)*2,(shadow?.blur||0)*2+(shadow?.offset||0));
  const ink=visualColor(e.color,e.fill||'FFFFFF'),fill=visualColor(e.fill,'FFFFFF');
  const object={...e,x:pad,y:pad,glow,shadow,color:ink.color,fill:fill.color};
  const halo=glow?`<filter id="light-bar-halo" x="-100%" y="-100%" width="300%" height="300%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="${glow.radius/2}" result="blur"/><feFlood flood-color="#${glow.color}" flood-opacity="${glow.opacity}"/><feComposite in2="blur" operator="in" result="halo"/><feMerge><feMergeNode in="halo"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`:'';
  const defs=(e.gradient?gradientSVG(e.gradient,'bar-fill',object):'')+(e.strokeGradient?gradientSVG(e.strokeGradient,'native-stroke-gradient-0',object):'')+nativeEffectDefs(object,0)+halo;
  const stroke=e.strokeGradient?'url(#native-stroke-gradient-0)':e.type==='line'&&e.gradient?'url(#bar-fill)':'#'+ink.color;
  let body;
  if(e.type==='line'){
    const x1=pad+(e.flipH?e.w:0),y1=pad+(e.flipV?e.h:0),x2=pad+(e.flipH?0:e.w),y2=pad+(e.flipV?0:e.h);
    body=`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}" stroke-opacity="${ink.alpha*visualOpacity(e.colorOpacity)}"${nativeLineAttributes(object,0)}/>`;
  }else{
    const geometry=e.type==='shape'||e.shapeGeometry||e.customGeometry?nativeShapeGeometry({...object,shape:e.shape||'rect'}):`rect x="${pad}" y="${pad}" width="${e.w}" height="${e.h}"`;
    body=`<${geometry} fill="${e.gradient?'url(#bar-fill)':'#'+fill.color}" fill-opacity="${fill.alpha*visualOpacity(e.fillOpacity)}" stroke="${stroke}" stroke-width="${e.strokeWidth??0}" stroke-opacity="${ink.alpha*visualOpacity(e.colorOpacity)}"/>`;
    const transform=nativeTransform(object);if(transform)body=`<g transform="${transform}">${body}</g>`;
  }
  if(glow)body=`<g filter="url(#light-bar-halo)">${body}</g>`;
  if(shadow)body=`<g filter="url(#native-shadow-0)">${body}</g>`;
  const w=e.w+pad*2,h=e.h+pad*2;
  return {key:e.key,type:'svg',x:e.x-pad,y:e.y-pad,w,h,description:e.description||'SVG光条',
    svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs>${defs}</defs><g opacity="${visualOpacity(e.opacity)}">${body}</g></svg>`,
    role:'effect',visualKind:'light-effect',effectKind:'lit-stroke',
    ...(e.effectOf?{effectOf:e.effectOf}:{}),representationOrigin:'svg-light-bar',
    lighting:{coreConfirmed:true,evidence:'保留原光条主体、方向及外围效果，由同一对象转入SVG'}};
}
