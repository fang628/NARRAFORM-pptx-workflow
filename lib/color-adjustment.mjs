// Display-only corrections. Original media bytes, IDs and background hashes stay intact.
export const colorAdjustmentRule='微调时按参考图分别核对底图与AI抠图素材的饱和度与明度；先排除错位、遮挡、透明度与色相差异，不把它们当作明暗问题。colorAdjustment:{saturation:0.7至1.3（1为原值）,brightness:-0.12至0.12（0为原值）}仅调整显示参数，仅用于底图与AI抠图元素，不用于SVG、文字、原生色块、进度条或登记原图；不改素材文件、原图身份、内容、结构或全篇风格，不对整页统一套滤镜；程序按有效区域色差拟合并复渲染，收益不足自动回退。';
export function colorAdjustment(value){
 if(value==null)return undefined;
 const saturation=Number(value.saturation??1),brightness=Number(value.brightness??0);
 if(!Number.isFinite(saturation)||saturation<.7||saturation>1.3||!Number.isFinite(brightness)||brightness<-.12||brightness>.12)throw Error('饱和度或明度显示参数超出微调范围');
 return {saturation,brightness};
}
export function adjustedColor(hex,value){
 const a=colorAdjustment(value);if(!a||!/^#?[a-f\d]{6}$/i.test(hex))return hex;
 const rgb=hex.replace('#','').match(/../g).map(c=>parseInt(c,16)),luma=rgb.reduce((n,c,i)=>n+c*[.2126,.7152,.0722][i],0);
 return rgb.map(c=>Math.round(Math.max(0,Math.min(255,luma+(c-luma)*a.saturation+a.brightness*255))).toString(16).padStart(2,'0')).join('').toUpperCase();
}
export function colorAdjustmentSVG(value,id){
 const a=colorAdjustment(value);if(!a)return '';
 return `<filter id="${id}" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="${a.saturation}"/><feComponentTransfer>${['R','G','B'].map(c=>`<feFunc${c} type="linear" slope="1" intercept="${a.brightness}"/>`).join('')}</feComponentTransfer></filter>`;
}
function pictureEffect(block,value){
 const a=colorAdjustment(value);if(!a)return block;
 const effects=`<a:satMod amt="${Math.round(a.saturation*100000)}"/><a:lum bright="${Math.round(a.brightness*100000)}" contrast="0"/>`;
 return block.replace(/<a:blip\b([^>]*?)\/>|<a:blip\b([^>]*)>([\s\S]*?)<\/a:blip>/g,(_,short,attrs,body)=>`<a:blip${short??attrs}>${(body||'').replace(/<a:satMod\b[^>]*\/>|<a:lum\b[^>]*\/>/g,'')}${effects}</a:blip>`);
}
export function applyNativeColorAdjustments(xml,elements,background){
 const map=new Map(elements.map(e=>[e.key,e]));
 xml=xml.replace(/<p:(sp|pic)\b[^>]*>[\s\S]*?<\/p:\1>/g,block=>{
  const e=map.get(block.match(/<p:cNvPr\b[^>]*\bname="([^"]+)"/)?.[1]);if(!e?.colorAdjustment||e.type!=='image'||e.implementation!=='cutout')return block;
  return pictureEffect(block,e.colorAdjustment);
 });
 if(background?.colorAdjustment)xml=xml.replace(/<p:bg>[\s\S]*?<\/p:bg>/,b=>pictureEffect(b,background.colorAdjustment));
 return xml;
}
