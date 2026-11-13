import {representationRule} from './rebuild-representation.mjs';
import {overlapLayerRule} from './overlap-layers.mjs';
import {nativeGradientRule} from './visual-gradient.mjs';
import {normalizeDirectionalElements} from './directional-geometry.mjs';
import {rebuildReuseRule} from './rebuild-reuse.mjs';
import {nativeAppearanceRule} from './native-appearance-policy.mjs';
export {nativeGradientRule};
export const nativeLineRule='普通直线、折线和直箭头优先原生line。点线组合用同一line的beginArrowType/endArrowType:"oval"，start/end登记圆点中心，不另加ellipse。独立项目符号、中间节点保留。端点大小beginArrowSize/endArrowSize:{width:"sm|med|lg",length:"sm|med|lg"}独立于strokeWidth记录，按实测宽高选择原生档位。原生line禁止glow/shadow；光条用SVG。保留杆身、尖端方向、端点、实际粗细和规则虚线间距，忽略偶发小断口。单侧/双侧渐隐使用同一line的strokeGradient同色透明度色标，允许中间亮区偏置或保持平台，两侧渐隐长度独立；按实际沿线方向记录，不缩短为亮段、不拆成两条线、不将背景色拟合为线色。';
export const rebuildMethodRule='公式使用独立type=formula对象（nodeId、latex、x/y/w/h、size、color），latex取准确内容树；分数、根号、上下标和矩阵导出为Office原生公式，不用text、svg或抠图替代。简单色块与普通线条使用PPTX原生图形，色块、箭头及圆形禁止glow，实际阴影用shadow且与描边互斥；原生line不带光影，光条统一用SVG。所有文本承载框必须用原生预设或原生自定义几何；独立非承载复杂轮廓、平面图标及复杂多层光效用SVG，受限滤镜只允许本地GaussianBlur、DropShadow或Merge，禁止外链、feImage、脚本和文字。复杂现实风格、立体材质及复杂画面用cutout兼容提取：分析前景颜色选高色差底色，附局部参考图生成均匀纯色底素材，再本地去底；失败后结合当前预览与登记无字底图本地分离。不请求透明背景模式，不重画主体，保留轮廓、颜色和细节。文字单独原生编辑，原材料图片直接使用登记原件。新任务不以直接裁图crop或文生图generate替代上述方法，不重画底图已有内容。'+nativeAppearanceRule+rebuildReuseRule+nativeGradientRule+representationRule+overlapLayerRule+nativeLineRule;
export function validateRebuildMethods(elements){
  if(!Array.isArray(elements))return;
  elements=normalizeDirectionalElements(elements);
  for(const e of elements)if(e.type==='line'&&(e.glow||e.shadow&&e.shadow.type!=='none'||e.lineEffect==='lit'))throw Error('原生line不允许发光或阴影；普通线移除glow/shadow，光条改用同一对象的SVG，不复制线条主体');
  for(const e of elements)if(e?.type==='shape'&&e.shape==='parallelogram'&&e.contourKind!=='parallelogram'&&e.arrowDirection===undefined&&e.arrowTail===undefined&&/箭形|箭头|六边形|hexagon|chevron|arrow/i.test(e.description||''))throw Error('箭形或六边形不能用 parallelogram 还原，请按真实轮廓登记 contourKind 及对应形状');
  // The representation router converts supported primitives deterministically.
  // A valid gradient outside that capability must remain SVG rather than cause
  // a whole-page model retry that cannot improve the converter's capabilities.
  const unsupported=elements.filter(e=>e?.type==='generate'||e?.type==='crop');
  if(unsupported.length)throw Error('重建方法需调整：'+unsupported.map(e=>e.key+'='+e.type).join('、')+'；'+rebuildMethodRule);
}
