export const rebuildMethodRule='元素提取与重建的方法固定为：简单色块与线条使用PPTX原生图形（矩形、椭圆、线条或简单预设几何）；复杂形状或图标使用SVG重绘；复杂画面元素使用图生图抠图cutout，以预览中的局部参考图提取独立透明素材，保持原有轮廓、颜色和细节。文字单独原生编辑，原材料图片直接使用登记原件。新重建任务不以直接裁图crop或文生图generate替代上述方法，也不重画底图已有内容。';
export function validateRebuildMethods(elements){
  if(!Array.isArray(elements))return;
  const unsupported=elements.filter(e=>e?.type==='generate'||e?.type==='crop');
  if(unsupported.length)throw Error('重建方法需调整：'+unsupported.map(e=>e.key+'='+e.type).join('、')+'；'+rebuildMethodRule);
}
