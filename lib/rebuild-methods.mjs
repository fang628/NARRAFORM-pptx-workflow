import {representationRule} from './rebuild-representation.mjs';
import {overlapLayerRule} from './overlap-layers.mjs';
import {nativeGradientRule} from './visual-gradient.mjs';
import {normalizeDirectionalElements} from './directional-geometry.mjs';
import {rebuildReuseRule} from './rebuild-reuse.mjs';
import {nativeAppearanceRule} from './native-appearance-policy.mjs';
export {nativeGradientRule};
export const svgReconstructionRule='独立SVG按局部参考构造完整图形：外轮廓、内部图案及属于同一主体的装饰在同一SVG、同一坐标系中一起绘制和拟合，保留孔洞、朝向、嵌套层次、相对比例和遮挡；不得只替换内部图标或用通用符号概括。独立部件可用path表达，但主体整体变换；链环的倾角、开口、连接和前后遮挡按实际图保留。圆弧用Q/C曲线，不用密集折线近似。光条、环层和斜切装饰保留真实曲率、条数、断开位置和端点，柔光沿同一几何生成，不以单线概括。原生框体的edgeHighlight仍由S4/S5处理。';
export const nativeLineRule='细直线、折线、曲线和标准细箭头统一原生line开放路径，linePath:{version:1,commands:[{op:M|L|Q|C,points:[[归一化x,y],...]}],segmentGroups:{"2":"斜度组ID"}}。segmentGroups以L段命令序号为键，允许该段与其他图形slant组共享相近斜度，其他参数独立；keepParameters:["slant:2"]只保护该段。折线是一个自定义路径，不分段、不组合、不延长接缝；直线为M+L，曲线用Q/C。点线组合用同一line的beginArrowType/endArrowType:"oval"，端点为圆点中心，不另加ellipse。线身圆点只允许位于端点或真实折点，附近圆点吸附至该位置，同位置合并；不为圆点新增折点，远离锚点的线身圆点不输出。独立项目符号单独保留；属于线身的中间圆点记录linePath.nodes:[{position:[归一化x,y],diameter:逻辑直径}]，端点圆实测直径记录linePath.terminals:{begin:{diameter},end:{diameter}}。标准箭头大小beginArrowSize/endArrowSize:{width:"sm|med|lg",length:"sm|med|lg"}作为路径端点信息，和路径、线宽联合拟合，不另建图形。折线保留主要转向，在小幅位置误差内优先减少线段，忽略微小抖动，将同一转角附近的短碎转折合成一个转角。很粗箭头（线宽大于8逻辑单位）、异形箭头与光条统一SVG。原生line禁止glow/shadow；光条用SVG。保留杆身、尖端方向、端点、实际粗细和规则虚线间距，忽略偶发小断口。单侧/双侧渐隐使用同一line的strokeGradient同色透明度色标，允许中间亮区偏置或保持平台，两侧渐隐长度独立；按实际沿线方向记录，不缩短为亮段、不拆成两条线、不将背景色拟合为线色。';
export const rebuildMethodRule='公式使用独立type=formula对象（nodeId、latex、x/y/w/h、size、color），latex取准确内容树；分数、根号、上下标和矩阵导出为Office原生公式，不用text、svg或抠图替代。简单色块与普通线条使用PPTX原生图形，色块、箭头及圆形禁止glow，实际阴影用shadow且与描边互斥；原生line不带光影，光条统一用SVG。文本承载保留最初登记的SVG或原生方式，文字独立；复杂轮廓、平面图标及复杂多层光效可用SVG，受限滤镜只允许本地GaussianBlur、DropShadow或Merge，禁止外链、feImage、脚本和文字。复杂现实风格、立体材质及复杂画面用cutout兼容提取：分析前景颜色选高色差底色，附局部参考图生成均匀纯色底素材，再本地去底；失败后结合当前预览与登记无字底图本地分离。不请求透明背景模式，不重画主体，保留轮廓、颜色和细节。文字单独原生编辑，原材料图片直接使用登记原件。新任务不以直接裁图crop或文生图generate替代上述方法，不重画底图已有内容。'+nativeAppearanceRule+rebuildReuseRule+nativeGradientRule+representationRule+overlapLayerRule+nativeLineRule;
export function validateRebuildMethods(elements){
  if(!Array.isArray(elements))return;
  elements=normalizeDirectionalElements(elements);
  for(const e of elements)if(e.type==='line'&&(e.glow||e.shadow&&e.shadow.type!=='none'))throw Error('原生line不允许发光或阴影；普通线移除glow/shadow，光条改用同一对象的SVG，不复制线条主体');
  for(const e of elements)if(e?.type==='shape'&&e.shape==='parallelogram'&&e.contourKind!=='parallelogram'&&e.arrowDirection===undefined&&e.arrowTail===undefined&&/箭形|箭头|六边形|hexagon|chevron|arrow/i.test(e.description||''))throw Error('箭形或六边形不能用 parallelogram 还原，请按真实轮廓登记 contourKind 及对应形状');
  // The representation router converts supported primitives deterministically.
  // A valid gradient outside that capability must remain SVG rather than cause
  // a whole-page model retry that cannot improve the converter's capabilities.
  const unsupported=elements.filter(e=>e?.type==='generate'||e?.type==='crop');
  if(unsupported.length)throw Error('重建方法需调整：'+unsupported.map(e=>e.key+'='+e.type).join('、')+'；'+rebuildMethodRule);
}
