import {representationRule} from './rebuild-representation.mjs';
import {overlapLayerRule} from './overlap-layers.mjs';
import {nativeGradientRule} from './visual-gradient.mjs';
import {normalizeDirectionalElements} from './directional-geometry.mjs';
import {rebuildReuseRule} from './rebuild-reuse.mjs';
import {nativeAppearanceRule} from './native-appearance-policy.mjs';
export {nativeGradientRule};
export const nativeLineRule='直线、折线、直箭头、点线组合优先原生line及独立ellipse，普通发光和阴影用主体glow/shadow；复杂多层光带再用SVG/cutout。分别记录完整杆身、尖端方向和圆点端点，不把连线箭头当成箭形色块。忽略零散断口和偶发线宽波动，保留实际长度、主要粗细、规则虚线间距及明确持续变化。';
export const rebuildMethodRule='公式使用独立type=formula对象（nodeId、latex、x/y/w/h、size、color），latex取准确内容树；分数、根号、上下标和矩阵导出为Office原生公式，不用text、svg或抠图替代。简单色块、线条、普通发光及阴影使用PPTX原生图形及主体glow/shadow。所有文本承载框必须用原生预设或原生自定义几何；独立非承载复杂轮廓、平面图标及复杂多层光效用SVG，受限滤镜只允许本地GaussianBlur、DropShadow或Merge，禁止外链、feImage、脚本和文字。复杂现实风格、立体材质及复杂画面用cutout兼容提取：分析前景颜色选高色差底色，附局部参考图生成均匀纯色底素材，再本地去底；失败后结合当前预览与登记无字底图本地分离。不请求透明背景模式，不重画主体，保留轮廓、颜色和细节。文字单独原生编辑，原材料图片直接使用登记原件。新任务不以直接裁图crop或文生图generate替代上述方法，不重画底图已有内容。'+nativeAppearanceRule+rebuildReuseRule+nativeGradientRule+representationRule+overlapLayerRule+nativeLineRule;
export function validateRebuildMethods(elements){
  if(!Array.isArray(elements))return;
  elements=normalizeDirectionalElements(elements);
  for(const e of elements)if(e?.type==='shape'&&e.shape==='parallelogram'&&e.contourKind!=='parallelogram'&&e.arrowDirection===undefined&&e.arrowTail===undefined&&/箭形|箭头|六边形|hexagon|chevron|arrow/i.test(e.description||''))throw Error('箭形或六边形不能用 parallelogram 还原，请按真实轮廓登记 contourKind 及对应形状');
  // The representation router converts supported primitives deterministically.
  // A valid gradient outside that capability must remain SVG rather than cause
  // a whole-page model retry that cannot improve the converter's capabilities.
  const unsupported=elements.filter(e=>e?.type==='generate'||e?.type==='crop');
  if(unsupported.length)throw Error('重建方法需调整：'+unsupported.map(e=>e.key+'='+e.type).join('、')+'；'+rebuildMethodRule);
}
