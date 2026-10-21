import {nativeGradientRule} from './visual-gradient.mjs';
import {normalizeDirectionalElement} from './directional-geometry.mjs';
import {rebuildReuseRule} from './rebuild-reuse.mjs';
export {nativeGradientRule};
export const rebuildMethodRule='元素提取与重建的方法固定为：简单色块与普通无光影线条使用PPTX原生图形（矩形、椭圆、线条或简单预设几何）；有发光、光晕或光影层次的线条不使用原生图形：可由多层不同宽度和透明度描边还原时用SVG，复杂光影用cutout抠图，保留线宽、渐变与端点。复杂几何形状与简单平面的图标使用SVG重绘，局部光晕可用受限的本地GaussianBlur、DropShadow或Merge滤镜，禁止外链、feImage、脚本和文字；复杂现实风格、含立体材质/光影细节的图标以及复杂画面元素使用图生图抠图cutout，以预览中的局部参考图提取独立透明素材，保持原有轮廓、颜色和细节。文字单独原生编辑，原材料图片直接使用登记原件。新重建任务不以直接裁图crop或文生图generate替代上述方法，也不重画底图已有内容。'+rebuildReuseRule+nativeGradientRule;
export function validateRebuildMethods(elements){
  if(!Array.isArray(elements))return;
  elements=elements.map(normalizeDirectionalElement);
  for(const e of elements)if(e?.type==='shape'&&e.shape==='parallelogram'&&e.contourKind!=='parallelogram'&&e.arrowDirection===undefined&&e.arrowTail===undefined&&/箭形|箭头|六边形|hexagon|chevron|arrow/i.test(e.description||''))throw Error('箭形或六边形不能用 parallelogram 还原，请按真实轮廓登记 contourKind 及对应形状');
  for(const e of elements)if(e?.type==='line'){
    const description=String(e.description||'').replace(/(?:无明显|没有|不带|不含|未使用|无)(?:发光|光晕|光影|辉光|霓虹)/g,'').replace(/(?:no|without)\s+(?:glow|neon)/gi,'');
    if(e.lineEffect==='lit'||e.shadow&&e.shadow.type!=='none'||e.glow||/发光|光晕|光影|辉光|霓虹|glow|neon/i.test(description))throw Error('有光影的线条不使用原生line；用多层描边SVG重绘，复杂光影用cutout抠图，保留粗细、渐变和尖端方向');
  }
  for(const e of elements.filter(e=>e?.type==='svg'&&typeof e.svg==='string')){
    const geometry=[...e.svg.matchAll(/<(rect|ellipse|circle|path|polygon|polyline|line|use|image|text)\b/gi)];
    if(/<(?:linearGradient|radialGradient)\b/.test(e.svg)&&geometry.length===1&&/^(rect|ellipse|circle)$/i.test(geometry[0][1])&&!/<(?:mask|clipPath|filter)\b|\btransform\s*=/.test(e.svg))throw Error('简单渐变色块须改为原生rect/ellipse/shape并填写gradient，不能作为SVG素材；'+nativeGradientRule);
  }
  const unsupported=elements.filter(e=>e?.type==='generate'||e?.type==='crop');
  if(unsupported.length)throw Error('重建方法需调整：'+unsupported.map(e=>e.key+'='+e.type).join('、')+'；'+rebuildMethodRule);
}
