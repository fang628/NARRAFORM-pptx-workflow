import {visualColor,visualOpacity} from './visual-color.mjs';

export const nativeGradientRule='文字、简单色块、箭形与普通无光影线条的渐变必须使用PowerPoint原生渐变，不转成SVG或位图；带光晕或光影层次的线条例外，改用多层描边SVG或复杂光影cutout。text 的 gradient 表示字形填充，不能给无框文字额外加渐变底框；rect/ellipse/shape 的 gradient 表示形状填充，line 的 gradient 表示线条及其端点的渐变颜色。格式 gradient:{type:"linear|radial|rectangular",angle:0至360度（0左到右、90上到下）,center:{x:0至1,y:0至1}（radial/rectangular的中心，可省略）,stops:[{position:0至1,color:"六位RGB",opacity:0至1}]}，2–10个色标；opacity是每个色标的不透明度，元素opacity仍控制整体。先区分纯色、单向/多色标线性渐变、径向渐变、矩形路径渐变与透明度渐变，不能一律填linear；radial表示中心向四周，rectangular表示矩形等距扩散。按预览记录颜色、色标位置、方向和透明度，简单渐变色块保留原生形状；复杂几何和图标仍可用SVG。形状填充gradient与描边strokeGradient独立记录，后者使用相同渐变结构；按实际预览恢复描边色标、透明度及方向，不强制添加渐变。';

export function visualGradient(value,{key='unknown'}={}){
  if(value===undefined||value===null)return undefined;
  const invalid=()=>{const error=Error(`原生渐变格式无效（元素 ${key}）：使用linear/radial/rectangular、2–10个色标，position/opacity为0–1`);error.code='INVALID_VISUAL_GRADIENT';error.repairInstruction=nativeGradientRule;return error;};
  if(!value||typeof value!=='object'||!['linear','radial','rectangular'].includes(value.type)||!Array.isArray(value.stops)||value.stops.length<2||value.stops.length>10)throw invalid();
  const stops=value.stops.map(stop=>{
    if(!stop||typeof stop.position!=='number'||!Number.isFinite(stop.position)||stop.position<0||stop.position>1)throw invalid();
    const color=visualColor(stop.color,undefined,{key,field:'gradient.stops.color'});
    return {position:stop.position,color:color.color,opacity:color.alpha*visualOpacity(stop.opacity)};
  }).sort((a,b)=>a.position-b.position);
  if(stops[0].position===stops.at(-1).position)throw invalid();
  if(value.type==='linear'){
    const angle=value.angle??0;if(typeof angle!=='number'||!Number.isFinite(angle))throw invalid();
    return {type:'linear',angle:((angle%360)+360)%360,stops};
  }
  const center={x:value.center?.x??.5,y:value.center?.y??.5};
  if(Object.values(center).some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1))throw invalid();
  return {type:value.type,center,stops};
}

export function gradientFillXML(value,opacity=1){
  const g=visualGradient(value),alpha=visualOpacity(opacity),percent=n=>Math.round(n*100000);
  const stops=g.stops.map(s=>`<a:gs pos="${percent(s.position)}"><a:srgbClr val="${s.color}"><a:alpha val="${percent(s.opacity*alpha)}"/></a:srgbClr></a:gs>`).join('');
  const direction=g.type==='linear'?`<a:lin ang="${Math.round(g.angle*60000)}" scaled="0"/>`:`<a:path path="${g.type==='rectangular'?'rect':'circle'}"><a:fillToRect l="${percent(g.center.x)}" t="${percent(g.center.y)}" r="${percent(1-g.center.x)}" b="${percent(1-g.center.y)}"/></a:path>`;
  return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst>${direction}<a:tileRect/></a:gradFill>`;
}

export function gradientSVG(value,id,box){
  const g=visualGradient(value),stops=g.stops.map(s=>`<stop offset="${s.position}" stop-color="#${s.color}" stop-opacity="${s.opacity}"/>`).join('');
  if(g.type==='rectangular'){
    const colorAt=t=>{let b=g.stops.findIndex(s=>s.position>=t);if(b<0)b=g.stops.length-1;const a=Math.max(0,b-1),lo=g.stops[a],hi=g.stops[b],f=Math.max(0,Math.min(1,(t-lo.position)/(hi.position-lo.position||1))),rgb=s=>[0,2,4].map(i=>parseInt(s.color.slice(i,i+2),16));return {color:'#'+rgb(lo).map((v,i)=>Math.round(v+(rgb(hi)[i]-v)*f).toString(16).padStart(2,'0')).join(''),opacity:lo.opacity+(hi.opacity-lo.opacity)*f};};
    const cx=box.x+g.center.x*box.w,cy=box.y+g.center.y*box.h,parts=[];
    const ring=t=>`M${cx+(box.x-cx)*t} ${cy+(box.y-cy)*t}H${cx+(box.x+box.w-cx)*t}V${cy+(box.y+box.h-cy)*t}H${cx+(box.x-cx)*t}Z`;
    for(let i=96;i>=1;i--){const t=i/96,c=colorAt((i-.5)/96);parts.push(`<path d="${ring(t)}${i>1?ring((i-1)/96):''}" shape-rendering="crispEdges" fill-rule="evenodd" fill="${c.color}" fill-opacity="${c.opacity}"/>`);}
    return `<pattern id="${id}" patternUnits="userSpaceOnUse" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}">${parts.join('')}</pattern>`;
  }
  if(g.type==='radial')return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${box.x+box.w/2}" cy="${box.y+box.h/2}" r="${Math.hypot(box.w,box.h)/2}" fx="${box.x+g.center.x*box.w}" fy="${box.y+g.center.y*box.h}">${stops}</radialGradient>`;
  const angle=g.angle*Math.PI/180,dx=Math.cos(angle),dy=Math.sin(angle),length=Math.abs(box.w*dx)+Math.abs(box.h*dy),cx=box.x+box.w/2,cy=box.y+box.h/2;
  // PowerPoint applies a font fill across the visible glyphs, not spare box space.
  if(box.type==='text')return `<linearGradient id="${id}" x1="${.5-dx/2}" y1="${.5-dy/2}" x2="${.5+dx/2}" y2="${.5+dy/2}">${stops}</linearGradient>`;
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${cx-dx*length/2}" y1="${cy-dy*length/2}" x2="${cx+dx*length/2}" y2="${cy+dy*length/2}">${stops}</linearGradient>`;
}

// Replace a direct fill child only; a shape's outline has its own nested fill.
function replaceFill(parent,fill){
  const root=parent.match(/^<([\w:]+)\b[^>]*>/);if(!root)throw Error('无法定位原生渐变属性');
  if(root[0].endsWith('/>'))return root[0].slice(0,-2)+'>'+fill+'</'+root[1]+'>';
  const tokens=[...parent.matchAll(/<\/?[\w:]+\b[^>]*>/g)];let depth=0,start=-1;
  for(const token of tokens){
    const closing=token[0].startsWith('</'),self=token[0].endsWith('/>');
    if(closing){depth--;if(start>=0&&depth===1)return parent.slice(0,start)+fill+parent.slice(token.index+token[0].length);}
    else{
      if(depth===1&&/^<a:(?:solidFill|gradFill|noFill|blipFill|pattFill|grpFill)\b/.test(token[0])){
        if(self)return parent.slice(0,token.index)+fill+parent.slice(token.index+token[0].length);
        start=token.index;
      }
      if(!self)depth++;
    }
  }
  // Text properties put their fill after the optional outline and before effects/fonts.
  if(root[1]!=='p:spPr'){
    const outline=parent.slice(root[0].length).match(/^<a:ln\b[^>]*(?:\/>|>[\s\S]*?<\/a:ln>)/);
    const at=root[0].length+(outline?.[0].length||0);return parent.slice(0,at)+fill+parent.slice(at);
  }
  throw Error('原生形状缺少可替换的填充属性');
}

export function applyNativeGradients(xml,elements){
  const pending=new Map(elements.filter(e=>e.gradient||e.strokeGradient).map(e=>[e.key,e]));
  const result=xml.replace(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g,shape=>{
    const name=shape.match(/<p:cNvPr\b[^>]*\bname="([^"]+)"/)?.[1],element=pending.get(name);if(!element)return shape;
    const fill=element.gradient?gradientFillXML(element.gradient,(element.opacity??1)*(element.type==='text'?1:element.type==='line'?element.colorOpacity??1:element.fillOpacity??1)):null;let changed=false;
    if(fill){
    if(element.type==='text')shape=shape.replace(/<p:txBody\b[^>]*>[\s\S]*?<\/p:txBody>/,body=>body.replace(/<a:(rPr|defRPr|endParaRPr)\b[^>]*\/>|<a:(rPr|defRPr|endParaRPr)\b[^>]*>[\s\S]*?<\/a:\2>/g,properties=>{changed=true;return replaceFill(properties,fill);}));
      else if(['rect','ellipse','shape'].includes(element.type))shape=shape.replace(/<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>/,properties=>{changed=true;return replaceFill(properties,fill);});
      else if(element.type==='line')shape=shape.replace(/<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>/,properties=>properties.replace(/<a:ln\b[^>]*(?:\/>|>[\s\S]*?<\/a:ln>)/,line=>{changed=true;return replaceFill(line,fill);}));
    }
    if(element.strokeGradient){const stroke=gradientFillXML(element.strokeGradient,(element.opacity??1)*(element.colorOpacity??1));shape=shape.replace(/<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>/,properties=>properties.replace(/<a:ln\b[^>]*(?:\/>|>[\s\S]*?<\/a:ln>)/,line=>{changed=true;return replaceFill(line,stroke);}));}
    if(!changed)throw Error('未能写入原生渐变：'+element.key);pending.delete(name);return shape;
  });
  if(pending.size)throw Error('原生渐变对象未写入PPTX：'+[...pending.keys()].join('、'));
  return result;
}
