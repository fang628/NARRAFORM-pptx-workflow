import {visualColor,visualOpacity} from './visual-color.mjs';

export const arrowTypes=['none','arrow','triangle','stealth','diamond','oval'];
export const lineDashTypes=['solid','dash','dashDot','lgDash','lgDashDot','lgDashDotDot','sysDash','sysDot'];
export const nativeEffectsRule='观察文字描边与阴影，分别记录outline:{color,width,opacity}及shadow:{type:"outer|inner",color,opacity,blur,offset,angle}，没有效果则省略，不用重复文字伪造描边。width、blur、offset均为1600×900逻辑单位。线条须还原起止位置、方向、线宽、虚实与端点，dashType为solid/dash/dashDot/lgDash/lgDashDot/lgDashDotDot/sysDash/sysDot，beginArrowType/endArrowType为none/arrow/triangle/stealth/diamond/oval；圆点端点用oval，可两端不同。负斜率线条用正宽高加flipV:true，禁止负宽高。线条与箭形渐变用原生gradient保留色标、方向和透明度，不简化为纯色。标准箭形用原生shape，复杂弯曲连线用SVG准确重绘。';
const bounded=(value,fallback,min,max,field)=>{const n=Number(value??fallback);if(!Number.isFinite(n)||n<min||n>max)throw Error('原生视觉效果无效：'+field);return n;};
export function nativeEffects(e){
  const out={};
  if(['text','rect','ellipse','shape','line'].includes(e.type)&&e.shadow?.type==='none')out.shadow=null;
  if(e.type==='text'&&e.outline!=null){
    if(typeof e.outline!=='object'||Array.isArray(e.outline))throw Error('文字描边格式无效');
    const c=visualColor(e.outline.color,'FFFFFF',{key:e.key,field:'outline.color'});
    out.outline={color:c.color,width:bounded(e.outline.width??e.outline.size,1,0,20,'outline.width'),opacity:c.alpha*visualOpacity(e.outline.opacity)};
  }
  if(['text','rect','ellipse','shape','line'].includes(e.type)&&e.shadow!=null&&e.shadow.type!=='none'){
    if(typeof e.shadow!=='object'||Array.isArray(e.shadow)||!['outer','inner',undefined].includes(e.shadow.type))throw Error('文字阴影格式无效');
    const c=visualColor(e.shadow.color,'000000',{key:e.key,field:'shadow.color'});
    out.shadow={type:e.shadow.type??'outer',color:c.color,opacity:c.alpha*visualOpacity(e.shadow.opacity??.3),blur:bounded(e.shadow.blur,4,0,100,'shadow.blur'),offset:bounded(e.shadow.offset,2,0,200,'shadow.offset'),angle:bounded(e.shadow.angle,45,0,360,'shadow.angle')%360};
  }
  if(['rect','ellipse','shape','line'].includes(e.type)){
    for(const k of ['beginArrowType','endArrowType'])if(e[k]!=null){const v=['circle','dot'].includes(e[k])?'oval':e[k];if(!arrowTypes.includes(v))throw Error('线条端点无效：'+k);out[k]=v;}
    if(e.dashType!=null){if(!lineDashTypes.includes(e.dashType))throw Error('线条虚实样式无效');out.dashType=e.dashType;}
  }
  if(e.type==='shape'&&e.adjustments!=null){
    if(typeof e.adjustments!=='object'||Array.isArray(e.adjustments)||Object.keys(e.adjustments).some(k=>!/^adj\d?$/.test(k)))throw Error('原生图形调节点无效');
    out.adjustments=Object.fromEntries(Object.entries(e.adjustments).map(([k,v])=>[k,bounded(v,0,0,100000,k)]));
  }
  if(['rect','ellipse','shape','line'].includes(e.type))for(const k of ['flipH','flipV'])if(e[k]!=null){if(typeof e[k]!=='boolean')throw Error('图形翻转须为布尔值');out[k]=e[k];}
  if(['rect','ellipse','shape','line','text'].includes(e.type)&&e.rotate!=null)out.rotate=bounded(e.rotate,0,-360,360,'rotate');
  if(e.type==='text'&&e.valign==='mid')out.valign='mid';
  return out;
}

// Write effects into DrawingML text properties, preserving native gradient fills.
// Logical units × .6 pt × 12700 EMU/pt. Zero blur/offset are intentionally retained.
export function applyNativeTextEffects(xml,elements){
  const pending=new Map(elements.filter(e=>e.type==='text'&&(e.outline||e.shadow)).map(e=>[e.key,e]));
  const result=xml.replace(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g,shape=>{
    const key=shape.match(/<p:cNvPr\b[^>]*\bname="([^"]+)"/)?.[1],e=pending.get(key);if(!e)return shape;
    const color=(c,opacity)=>`<a:srgbClr val="${c}"><a:alpha val="${Math.round(opacity*100000)}"/></a:srgbClr>`;
    const outline=e.outline?`<a:ln w="${Math.round(e.outline.width*7620)}"><a:solidFill>${color(e.outline.color,(e.outline.opacity??1)*(e.opacity??1))}</a:solidFill><a:round/></a:ln>`:'';
    const s=e.shadow,shadow=s?`<a:effectLst><a:${s.type}Shdw blurRad="${Math.round(s.blur*7620)}" dist="${Math.round(s.offset*7620)}" dir="${Math.round(s.angle*60000)}"${s.type==='outer'?' algn="ctr" rotWithShape="0"':''}>${color(s.color,(s.opacity??.3)*(e.opacity??1))}</a:${s.type}Shdw></a:effectLst>`:'';
    let changed=false;
    shape=shape.replace(/<p:txBody\b[^>]*>[\s\S]*?<\/p:txBody>/,body=>body.replace(/<a:(rPr|defRPr|endParaRPr)\b[^>]*\/>|<a:(rPr|defRPr|endParaRPr)\b[^>]*>[\s\S]*?<\/a:\2>/g,props=>{
      changed=true;const root=props.match(/^<a:(\w+)\b[^>]*>/),tag=root[1];
      if(root[0].endsWith('/>'))return root[0].slice(0,-2)+'>'+outline+shadow+`</a:${tag}>`;
      let content=props.slice(root[0].length,-(`</a:${tag}>`.length)).replace(/<a:ln\b[^>]*(?:\/>|>[\s\S]*?<\/a:ln>)/g,'').replace(/<a:effectLst\b[^>]*(?:\/>|>[\s\S]*?<\/a:effectLst>)/g,'');
      const at=content.search(/<a:(?:latin|ea|cs|sym|hlinkClick|hlinkMouseOver|rtl|extLst)\b/);
      content=at<0?content+shadow:content.slice(0,at)+shadow+content.slice(at);
      return root[0]+outline+content+`</a:${tag}>`;
    }));
    if(!changed)throw Error('未能写入文字描边或阴影：'+key);pending.delete(key);return shape;
  });
  if(pending.size)throw Error('文字效果对象未写入PPTX：'+[...pending.keys()].join('、'));
  return result;
}

export function applyNativeShapeEffects(xml,elements){
  const byKey=new Map(elements.filter(e=>['rect','ellipse','shape','line'].includes(e.type)&&(e.shadow||e.adjustments)).map(e=>[e.key,e]));
  return xml.replace(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g,shape=>{
    const e=byKey.get(shape.match(/<p:cNvPr\b[^>]*\bname="([^"]+)"/)?.[1]);if(!e)return shape;
    return shape.replace(/<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>/,props=>{
      // PowerPoint requires hexagon's companion vf guide whenever adj is
      // explicit; omitting it produces a deck PowerPoint refuses to open.
      if(e.adjustments)props=props.replace(/<a:avLst\s*\/>|<a:avLst>[\s\S]*?<\/a:avLst>/,`<a:avLst>${Object.entries(e.adjustments).map(([k,v])=>`<a:gd name="${k}" fmla="val ${Math.round(v)}"/>`).join('')}${e.shape==='hexagon'?'<a:gd name="vf" fmla="val 115470"/>':''}</a:avLst>`);
      if(e.shadow){const s=e.shadow,shadow=`<a:effectLst><a:${s.type}Shdw blurRad="${Math.round(s.blur*7620)}" dist="${Math.round(s.offset*7620)}" dir="${Math.round(s.angle*60000)}"${s.type==='outer'?' algn="ctr" rotWithShape="0"':''}><a:srgbClr val="${s.color}"><a:alpha val="${Math.round(s.opacity*(e.opacity??1)*100000)}"/></a:srgbClr></a:${s.type}Shdw></a:effectLst>`;
        props=props.replace(/<a:effectLst\b[^>]*(?:\/>|>[\s\S]*?<\/a:effectLst>)/g,'').replace('</p:spPr>',shadow+'</p:spPr>');}
      return props;
    });
  });
}

export function nativeEffectDefs(e,i){
  const s=e.shadow,shadow=s?`<filter id="native-shadow-${i}" x="-100%" y="-100%" width="300%" height="300%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="${s.blur/2}" result="blur"/><feOffset in="blur" dx="${Math.cos(s.angle*Math.PI/180)*s.offset}" dy="${Math.sin(s.angle*Math.PI/180)*s.offset}" result="offset"/>${s.type==='inner'?'<feComposite in="SourceAlpha" in2="offset" operator="out" result="offset"/>':''}<feFlood flood-color="#${s.color}" flood-opacity="${s.opacity}"/><feComposite in2="offset" operator="in" result="shade"/><feMerge>${s.type==='inner'?'<feMergeNode in="SourceGraphic"/><feMergeNode in="shade"/>':'<feMergeNode in="shade"/><feMergeNode in="SourceGraphic"/>'}</feMerge></filter>`:'';
  const markers=['begin','end'].map((side,j)=>{
    const kind=e[side+'ArrowType'];if(!kind||kind==='none')return '';
    const stops=e.gradient?.stops,color=stops?(j?stops.at(-1):stops[0]).color:e.color,opacity=stops?(j?stops.at(-1):stops[0]).opacity:1;
    const shape=kind==='oval'?'<circle cx="4" cy="4" r="2.5"/>':kind==='diamond'?'<path d="M0 4 L4 1 L8 4 L4 7 Z"/>':kind==='arrow'?'<path d="M1 1 L7 4 L1 7" fill="none" stroke="currentColor" stroke-width="1.2"/>':kind==='stealth'?'<path d="M0 0 L8 4 L0 8 L2 4 Z"/>':'<path d="M0 0 L8 4 L0 8 Z"/>';
    return `<marker id="native-${side}-${i}" viewBox="0 0 8 8" markerWidth="5" markerHeight="5" refX="${kind==='oval'||kind==='diamond'?4:7}" refY="4" orient="auto-start-reverse" markerUnits="strokeWidth"><g fill="#${color}" color="#${color}" opacity="${opacity}">${shape}</g></marker>`;
  }).join('');return shadow+markers;
}
export function nativeLineAttributes(e,i){
  const dash={dash:[4,3],dashDot:[4,3,1,3],lgDash:[8,3],lgDashDot:[8,3,1,3],lgDashDotDot:[8,3,1,3,1,3],sysDash:[3,2],sysDot:[1,2]}[e.dashType];
  return (dash?` stroke-dasharray="${dash.map(v=>v*(e.strokeWidth||1)).join(' ')}"`:'')+['begin','end'].map(side=>e[side+'ArrowType']&&e[side+'ArrowType']!=='none'?` marker-${side==='begin'?'start':'end'}="url(#native-${side}-${i})"`:'').join('');
}
export function nativeTransform(e){
  const cx=e.x+e.w/2,cy=e.y+e.h/2;
  return [e.rotate?`rotate(${e.rotate} ${cx} ${cy})`:'',e.flipH||e.flipV?`translate(${cx} ${cy}) scale(${e.flipH?-1:1} ${e.flipV?-1:1}) translate(${-cx} ${-cy})`:''].filter(Boolean).join(' ');
}
