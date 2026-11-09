import {representationRule} from './rebuild-representation.mjs';
import {overlapLayerRule} from './overlap-layers.mjs';
import {nativeGradientRule} from './visual-gradient.mjs';
import {normalizeDirectionalElements} from './directional-geometry.mjs';
import {rebuildReuseRule} from './rebuild-reuse.mjs';
export {nativeGradientRule};
export const nativeLineRule='无光效直线、折线、直箭头、点线组合优先原生line及独立ellipse，分别记录完整杆身、尖端方向和圆点端点；不要把连线箭头当成箭形色块。忽略零散小断口和偶发线宽波动，按理想中心线、实际长度、主要粗细与渐变恢复；有规律的虚线间距及明确持续变化须保留。很小的圆角与切角不放大重现。';
export const rebuildMethodRule='公式使用独立type=formula对象（nodeId、latex、x/y/w/h、size、color），latex取准确内容树；分数、根号、上下标和矩阵导出为Office原生公式，不用text、svg或抠图替代。元素提取与重建的方法固定为：简单色块与普通无光影线条使用PPTX原生图形（矩形、椭圆、线条、四角向内凹的plaque或简单预设几何）；有发光、光晕或光影层次的线条不使用原生图形：可由多层不同宽度和透明度描边还原时用SVG，复杂光影用cutout抠图，保留线宽、渐变与端点。所有文本承载框必须用原生预设或原生自定义几何；独立非承载复杂轮廓与平面图标使用SVG重绘，局部光晕可用受限的本地GaussianBlur、DropShadow或Merge滤镜，禁止外链、feImage、脚本和文字；复杂现实风格、含立体材质/光影细节的图标以及复杂画面元素使用cutout兼容提取：先分析前景颜色自动选择高色差底色，再附局部参考图生成均匀纯色底素材，再由本地去底；失败后结合当前预览与登记无字底图本地分离。不请求透明背景模式，不重画主体，保留原有轮廓、颜色和细节。文字单独原生编辑，原材料图片直接使用登记原件。新重建任务不以直接裁图crop或文生图generate替代上述方法，也不重画底图已有内容。'+rebuildReuseRule+nativeGradientRule+representationRule+overlapLayerRule+nativeLineRule;
export function validateRebuildMethods(elements){
  if(!Array.isArray(elements))return;
  elements=normalizeDirectionalElements(elements);
  for(const e of elements)if(e?.type==='shape'&&e.shape==='parallelogram'&&e.contourKind!=='parallelogram'&&e.arrowDirection===undefined&&e.arrowTail===undefined&&/箭形|箭头|六边形|hexagon|chevron|arrow/i.test(e.description||''))throw Error('箭形或六边形不能用 parallelogram 还原，请按真实轮廓登记 contourKind 及对应形状');
  for(const e of elements)if(e?.type==='line'){
    const description=String(e.description||'').replace(/(?:无明显|没有|不带|不含|未使用|无)(?:发光|光晕|光影|辉光|霓虹)/g,'').replace(/(?:no|without)\s+(?:glow|neon)/gi,'');
    if(e.lineEffect==='lit'||e.shadow&&e.shadow.type!=='none'||e.glow||/发光|光晕|光影|辉光|霓虹|glow|neon/i.test(description))throw Error('有光影的线条不使用原生line；用多层描边SVG重绘，复杂光影用cutout抠图，保留粗细、渐变和尖端方向');
  }
  // The representation router converts supported primitives deterministically.
  // A valid gradient outside that capability must remain SVG rather than cause
  // a whole-page model retry that cannot improve the converter's capabilities.
  const unsupported=elements.filter(e=>e?.type==='generate'||e?.type==='crop');
  if(unsupported.length)throw Error('重建方法需调整：'+unsupported.map(e=>e.key+'='+e.type).join('、')+'；'+rebuildMethodRule);
}
