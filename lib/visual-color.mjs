// Preserve the color and alpha, while accepting common model/CSS spellings.
const names={black:'000000',white:'FFFFFF',gray:'808080',grey:'808080',silver:'C0C0C0',red:'FF0000',maroon:'800000',yellow:'FFFF00',olive:'808000',lime:'00FF00',green:'008000',aqua:'00FFFF',cyan:'00FFFF',teal:'008080',blue:'0000FF',navy:'000080',fuchsia:'FF00FF',magenta:'FF00FF',purple:'800080',orange:'FFA500',gold:'FFD700',whitesmoke:'F5F5F5',ivory:'FFFFF0',beige:'F5F5DC',lightgray:'D3D3D3',lightgrey:'D3D3D3',darkgray:'A9A9A9',darkgrey:'A9A9A9',dimgray:'696969',dimgrey:'696969',slategray:'708090',slategrey:'708090',lightblue:'ADD8E6',darkblue:'00008B'};
export const visualColorRule='原生元素fill/color使用六位RGB十六进制字符串，不加#，如FFFFFF、272727；透明度单独用opacity（0–1），不要把渐变或CSS变量写入原生颜色字段。文字与简单色块渐变使用原生gradient字段记录色标、方向与透明度，不能转为SVG或图片；复杂矢量仍可使用SVG，SVG内部按标准CSS颜色书写。';
const number=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/;
function component(token,limit){if(!number.test(token))return NaN;const percent=token.endsWith('%'),v=Number(percent?token.slice(0,-1):token);return v>=0&&v<=(percent?100:limit)?percent?v/100*limit:v:NaN;}
export function visualColor(value,fallback,{key='unknown',field='color'}={}){
  value??=fallback;
  if(typeof value==='string'){
    const s=value.trim(),lower=s.toLowerCase();
    if(lower==='transparent'||lower==='none')return {color:'000000',alpha:0};
    if(Object.hasOwn(names,lower))return {color:names[lower],alpha:1};
    const hex=s.replace(/^#/,'');
    if(/^[a-f\d]{3,4}$/i.test(hex)){const expanded=[...hex].map(c=>c+c).join('');return {color:expanded.slice(0,6).toUpperCase(),alpha:hex.length===4?parseInt(expanded.slice(6),16)/255:1};}
    if(/^[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(hex))return {color:hex.slice(0,6).toUpperCase(),alpha:hex.length===8?parseInt(hex.slice(6),16)/255:1};
    const rgb=s.match(/^rgba?\(([^()]*)\)$/i);
    if(rgb){
      const body=rgb[1].trim(),comma=body.includes(','),parts=comma?body.split(',').map(v=>v.trim()):body.split(/\s*\/\s*/);
      const channels=comma?parts.slice(0,3):parts[0].split(/\s+/),a=comma?parts[3]:parts[1];
      if(channels.length===3&&(comma?(parts.length===3||parts.length===4):parts.length<=2)){
        const values=channels.map(v=>component(v,255)),alpha=a===undefined?1:component(a,1);
        if(values.every(Number.isFinite)&&Number.isFinite(alpha))return {color:values.map(v=>Math.round(v).toString(16).padStart(2,'0')).join('').toUpperCase(),alpha};
      }
    }
  }
  const shown=(typeof value==='string'?value:JSON.stringify(value)??String(value)).slice(0,90);
  const error=Error(`视觉颜色格式无效（元素 ${key} · ${field}：${shown}）；请用六位RGB十六进制或有效RGB颜色`);
  Object.assign(error,{code:'INVALID_VISUAL_COLOR',elementKey:key,field});throw error;
}
export function visualOpacity(value=1){const n=Number(value??1);if(!Number.isFinite(n)||n<0||n>1)throw Error('透明度无效');return n;}
