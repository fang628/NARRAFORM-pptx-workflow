import {parseSVGTree,walkSVG,svgTransform,multiplyMatrix} from './svg-tree.mjs';
import {parseVectorPath,transformPath,vectorPathBounds,validateNativePath,sampleVectorPath} from './vector-path.mjs';

export const nativeCarrierVersion=3;
export const isVisualEffect=e=>e?.role==='effect'||!!e?.effectOf||e?.visualKind==='light-effect';
export const isTextCarrier=e=>!isVisualEffect(e)&&(e?.nativeRequired===true||e?.role==='carrier'||e?.role==='frame'||e?.isFrame===true||!!e?.frameKind);
export const nativeCarrierRule='所有文本承载框（标题底块、正文框、标签框和叠放异形框）必须用PPT原生预设或原生自定义几何；先判断基础形状，再拟合斜度、逐角圆角/切角和局部曲边，不能用SVG或抠图替代。每个重叠框分别登记完整轮廓及前后关系，文字独立。shapeGeometry支持version:2、corners:[{type:sharp|round|cut,radius或distance:相对短边的0–0.5}]；自由曲边用customGeometry:{version:2,commands:[{op:M|L|Q|C|Z,points:[[归一化x,y],...]}],closed:true}，程序测量并拟合路径，不用无证据的密集顶点。框体加role:carrier和nativeRequired:true；独立图标才用SVG。';
export function inferTextCarriers(elements){
  const text=elements.filter(e=>['text','formula','table'].includes(e.type)&&e.role!=='navigation'&&!e.managed);
  const tagged=elements.map(e=>{
    if(!['svg','cutout','rect','shape','ellipse'].includes(e.type)||e.managed||isVisualEffect(e)||e.arrowRole==='connector'||e.curveArrow)return e;
    // A bounding box around text is not proof of a filled carrier. In particular,
    // a transparent light outline must never enter the native-frame converter.
    if(!isTextCarrier(e)&&e.type==='svg'&&typeof e.svg==='string')try{const {parts}=carrierSVGParts(e.svg);if(parts.length&&parts.every(p=>(p.style.fill==='none'||Number(p.style['fill-opacity']??1)===0)&&sampleVectorPath(p.path).every(path=>!path.closed)))return e;}catch{return e;}
    if(!isTextCarrier(e)&&e.fillOpacity===0)return e;
    const supported=text.filter(t=>{
      const area=Math.max(0,Math.min(e.x+e.w,t.x+t.w)-Math.max(e.x,t.x))*Math.max(0,Math.min(e.y+e.h,t.y+t.h)-Math.max(e.y,t.y));
      return area>t.w*t.h*.88&&e.w>t.w*.9&&e.h>t.h*1.12&&e.w*e.h>t.w*t.h*1.35;
    });
    return supported.length?{...e,role:'carrier',nativeRequired:true,frameKind:e.frameKind||'text-carrier',carrierTextIds:supported.map(t=>t.nodeId).filter(Boolean)}:e;
  });
  return tagged.map(e=>{
    if(!['text','formula','table'].includes(e.type)||e.carrierId)return e;
    const carrier=tagged.filter(c=>c.carrierTextIds?.includes(e.nodeId)).sort((a,b)=>a.w*a.h-b.w*b.h)[0];
    return carrier?{...e,carrierId:carrier.key}:e;
  });
}
const value=(v,d=0)=>{const n=Number(v??d);if(!Number.isFinite(n))throw Error('SVG框体含无效尺寸');return n;};
const style=a=>{const out={...a};for(const s of (a.style||'').split(';')){const i=s.indexOf(':');if(i>0)out[s.slice(0,i).trim()]=s.slice(i+1).trim();}return out;};
export function geometryNodePath(node){
  const a=node.attrs,n=k=>value(a[k]);
  if(node.name==='path')return parseVectorPath(a.d||'');
  if(['polygon','polyline'].includes(node.name)){
    const v=(a.points||'').trim().split(/[\s,]+/).filter(Boolean).map(Number);if(v.length<4||v.length%2||!v.every(Number.isFinite))throw Error('SVG顶点无效');
    return Array.from({length:v.length/2},(_,i)=>({op:i?'L':'M',points:[v.slice(i*2,i*2+2)]})).concat(node.name==='polygon'?{op:'Z',points:[]}:[]);
  }
  if(node.name==='line')return [{op:'M',points:[[n('x1'),n('y1')]]},{op:'L',points:[[n('x2'),n('y2')]]}];
  if(node.name==='rect'){
    const x=n('x'),y=n('y'),w=n('width'),h=n('height'),rx=Math.min(w/2,value(a.rx,a.ry||0)),ry=Math.min(h/2,value(a.ry,a.rx||0));
    if(w<=0||h<=0)throw Error('SVG矩形尺寸无效');
    return rx&&ry?parseVectorPath(`M${x+rx} ${y}H${x+w-rx}A${rx} ${ry} 0 0 1 ${x+w} ${y+ry}V${y+h-ry}A${rx} ${ry} 0 0 1 ${x+w-rx} ${y+h}H${x+rx}A${rx} ${ry} 0 0 1 ${x} ${y+h-ry}V${y+ry}A${rx} ${ry} 0 0 1 ${x+rx} ${y}Z`):parseVectorPath(`M${x} ${y}H${x+w}V${y+h}H${x}Z`);
  }
  if(['circle','ellipse'].includes(node.name)){const cx=n('cx'),cy=n('cy'),rx=value(a.rx,a.r),ry=value(a.ry,a.r);if(rx<=0||ry<=0)throw Error('SVG椭圆尺寸无效');return parseVectorPath(`M${cx-rx} ${cy}A${rx} ${ry} 0 1 0 ${cx+rx} ${cy}A${rx} ${ry} 0 1 0 ${cx-rx} ${cy}Z`);}
  return null;
}
export function carrierSVGParts(svg){
  if(/<style\b|\bclass\s*=/i.test(svg))throw Error('文本框CSS样式需按参考重新拟合原生几何与填充');
  const root=parseSVGTree(svg),ids=new Map();walkSVG(root,n=>{if(n.attrs?.id)ids.set(n.attrs.id,n);});const parts=[];
  const visit=(node,parentMatrix,inherited,depth=0)=>{
    if(depth>32)throw Error('SVG框体引用过深');if(['defs','filter','clipPath','mask','pattern','linearGradient','radialGradient'].includes(node.name))return;
    const a=style(node.attrs||{}),m=multiplyMatrix(parentMatrix,svgTransform(a.transform||'')),s={...inherited,...a,opacity:value(inherited.opacity,1)*value(a.opacity,1)};
    if(s.display==='none'||s.opacity<=0)return;
    if(a['clip-path']||a.mask)throw Error('文本框裁切路径需按参考重新拟合原生轮廓');
    if(node.name==='use'){
      const ref=ids.get((a.href||a['xlink:href']||'').replace(/^#/,''));if(!ref)throw Error('SVG内部引用不存在');visit(ref,multiplyMatrix(m,[1,0,0,1,value(a.x),value(a.y)]),s,depth+1);return;
    }
    const path=geometryNodePath(node);if(path?.length&&s.visibility!=='hidden')parts.push({path:transformPath(path,m),style:s,matrix:m,node});
    for(const child of node.children||[])if(child.name!=='#text')visit(child,m,s,depth+1);
  };
  visit(root,[1,0,0,1,0,0],{});return {root,ids,parts};
}
// Deterministic compatibility conversion of legacy model SVG carriers. New
// audits request native candidates directly; local fitting uses the reference.
export function nativeCarrierElements(element,{paint}={}){
  if(!isTextCarrier(element))return [element];
  if(['rect','ellipse','shape'].includes(element.type)){
    const aliases={rectangle:'rect',roundedRectangle:'roundRect',roundedRect:'roundRect',freeForm:'freeform',custom:'freeform',customGeometry:'freeform'};
    const kind=aliases[element.shape]||element.shape;
    if(kind==='freeform'&&element.customGeometry)element={...element,shape:'freeform',type:'shape'};
    else if(kind==='rect')element={...element,type:'rect',shape:'rect'};
    else if(kind&&kind!==element.shape)element={...element,type:'shape',shape:kind};
    if(element.customGeometry&&element.shapeGeometry?.corners?.length===0){const {corners,...g}=element.shapeGeometry;element={...element,shapeGeometry:g};}
  }
  if(['rect','ellipse','shape'].includes(element.type))return [{...element,role:'carrier',nativeRequired:true,carrierVersion:nativeCarrierVersion}];
  if(element.type!=='svg')throw Error('文本承载框须重新拟合为原生几何：'+element.key);
  const {root,parts,ids}=carrierSVGParts(element.svg),view=(root.attrs.viewBox||'').trim().split(/[\s,]+/).map(Number);
  if(view.length!==4||!view.every(Number.isFinite)||view[2]<=0||view[3]<=0||!parts.length||parts.length>24)throw Error('文本承载框缺少可恢复的原生轮廓：'+element.key);
  const sx=element.w/view[2],sy=element.h/view[3],result=[];
  for(const [i,part]of parts.entries()){
    let commands=part.path;const subs=sampleVectorPath(commands);if(subs.some(p=>!p.closed)){
      // Open decorative strokes are separate native lines/path outlines, not
      // grounds for rasterizing the carrier. Close only a filled path implicitly.
      if(part.style.fill!=='none')commands=commands.concat({op:'Z',points:[]});else continue;
    }
    const b=vectorPathBounds(commands);if(b.w<1e-5||b.h<1e-5)continue;
    const fill=paint?.(part.style.fill||'#000000',element.svg,{...b,view}),stroke=paint?.(part.style.stroke||'none',element.svg,{...b,view});
    if(!fill||!stroke)throw Error('文本框填充需按参考拟合原生参数：'+element.key);
    const normalized=transformPath(commands,[1/b.w,0,0,1/b.h,-b.x/b.w,-b.y/b.h]);const geometry=validateNativePath({commands:normalized,closed:true,fillRule:part.style['fill-rule']});
    const {svg,implementation,id,curveArrow,mask,sourceBox,shapeGeometry,...rest}=element;
    const key=i===0?element.key:element.key.slice(0,53)+'-layer-'+i;
    const native={...rest,key,type:'shape',shape:'freeform',role:'carrier',nativeRequired:true,carrierVersion:nativeCarrierVersion,carrierGroup:element.key,
      x:element.x+(b.x-view[0])*sx,y:element.y+(b.y-view[1])*sy,w:b.w*sx,h:b.h*sy,customGeometry:geometry,
      fill:fill.color,color:stroke.color,opacity:value(part.style.opacity,1),fillOpacity:value(part.style['fill-opacity'],1)*fill.opacity,colorOpacity:value(part.style['stroke-opacity'],1)*stroke.opacity,
      strokeWidth:stroke.opacity?Math.min(20,value(part.style['stroke-width'],1)*Math.sqrt(Math.abs(sx*sy))):0,
      ...(fill.gradient?{gradient:fill.gradient}:{}),...(stroke.gradient?{strokeGradient:stroke.gradient}:{}),representationOrigin:'native-carrier-path'};
    const filter=ids.get((part.style.filter||'').match(/url\(#([^)]*)\)/)?.[1]);
    if(filter){
      const nodes=[];walkSVG(filter,n=>nodes.push(n));const blur=nodes.find(n=>['feGaussianBlur','feDropShadow'].includes(n.name)),flood=nodes.find(n=>n.name==='feFlood'),offset=nodes.find(n=>n.name==='feOffset');
      if(nodes.some(n=>!['filter','feGaussianBlur','feDropShadow','feFlood','feOffset','feComposite','feMerge','feMergeNode'].includes(n.name)))native.unresolved=['复杂滤镜已按原生效果近似，需实际渲染核对'];
      if(blur){const radius=Math.max(0,...String(blur.attrs.stdDeviation||0).split(/[\s,]+/).map(Number))*Math.sqrt(Math.abs(sx*sy))*2,color=(flood?.attrs['flood-color']||blur.attrs['flood-color']||(native.colorOpacity?native.color:native.fill)).replace('#','');
        if(/^[\da-f]{6}$/i.test(color)&&Number.isFinite(radius)){const dx=value(offset?.attrs.dx,blur.attrs.dx||0)*sx,dy=value(offset?.attrs.dy,blur.attrs.dy||0)*sy;
          if(Math.hypot(dx,dy)>.1)native.shadow={type:'outer',color,opacity:value(flood?.attrs['flood-opacity'],.3),blur:Math.min(100,radius),offset:Math.min(200,Math.hypot(dx,dy)),angle:(Math.atan2(dy,dx)*180/Math.PI+360)%360};
          else native.glow={color,radius:Math.min(100,radius),opacity:value(flood?.attrs['flood-opacity'],.3)};
        }
      }
    }
    result.push(native);
  }
  if(!result.length)throw Error('文本承载框未能恢复有效原生路径：'+element.key);
  // Keep the original instance identity on the largest body, not a small glint.
  const main=result.reduce((a,b)=>a.w*a.h*(a.fillOpacity||.1)>=b.w*b.h*(b.fillOpacity||.1)?a:b);if(main.key!==element.key){const first=result.find(e=>e.key===element.key),old=main.key;main.key=element.key;first.key=old;}
  return result;
}
export function assertNativeCarriers(elements,previous=[],{allowUnchanged=false}={}){
  const required=new Set(previous.filter(isTextCarrier).map(e=>e.key));
  for(const e of elements){if(allowUnchanged&&JSON.stringify(e)===JSON.stringify(previous.find(p=>p.key===e.key)))continue;if((isTextCarrier(e)||required.has(e.key))&&!['rect','ellipse','shape'].includes(e.type))throw Error('文本承载框只能使用原生预设或自定义几何：'+e.key);}
}
