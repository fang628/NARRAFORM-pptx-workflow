const directions=['right','left','up','down'];
export const directionalGeometryRule='箭头必须按参考图的实际尖端识别方向，不能按阅读顺序猜测。直线优先登记start:{x,y}和end:{x,y}（1600×900坐标），beginArrowType位于start端，endArrowType位于end端，圆点用oval；程序据起止点计算正宽高和翻转，不额外旋转。填充箭形记录arrowDirection:right/left/up/down及arrowTail:flat/notched/shaft，分别表示平尾、内凹V尾、窄杆尾；内凹V尾用chevron，不能因有六个顶点就识别为hexagon。只有左右两端均为向外凸尖且无凹口的轮廓才用hexagon。保留箭头、数字与承载的独立性；箭形内文字仍为独立text。复杂弯箭头用SVG，逐条核对尖端朝向、尾端和连接对象。';

// Explicit endpoint/contour evidence wins over ambiguous bbox/shape labels.
export function normalizeDirectionalElement(e){
  if(e?.type==='line'&&(e.start!==undefined||e.end!==undefined)){
    if(![e.start,e.end].every(p=>p&&typeof p.x==='number'&&typeof p.y==='number'&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1600&&p.y>=0&&p.y<=900)||e.start.x===e.end.x&&e.start.y===e.end.y)throw Error('箭头起止点无效，须为画布内两个不同的点');
    if(e.rotate)throw Error('登记起止点的线条不再叠加rotate，请直接修改起止点');
    const {start,end,...rest}=e;
    return {...rest,x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),w:Math.abs(end.x-start.x),h:Math.abs(end.y-start.y),flipH:start.x>end.x,flipV:start.y>end.y};
  }
  if(e?.type!=='shape'||e.managed==='progress'||e.arrowDirection===undefined&&e.arrowTail===undefined)return e;
  const direction=e.arrowDirection||({leftArrow:'left',upArrow:'up',downArrow:'down'}[e.shape]||'right');
  const tail=e.arrowTail||(e.shape==='chevron'?'notched':/^(right|left|up|down)Arrow$/.test(e.shape)?'shaft':null);
  if(!directions.includes(direction)||!['flat','notched','shaft'].includes(tail))throw Error('箭形须明确arrowDirection与arrowTail；真实六边形不登记箭形参数');
  if(e.rotate||e.flipH||e.flipV)throw Error('箭形已用arrowDirection指定朝向，请勿叠加旋转或翻转');
  return {...e,arrowDirection:direction,arrowTail:tail,shape:tail==='notched'?'chevron':direction+'Arrow'};
}

export function directionalShapePoints(e){
  if(!e.arrowTail)return null;
  const vertical=['up','down'].includes(e.arrowDirection),length=vertical?e.h:e.w;
  const adjustment=e.adjustments?.[e.arrowTail==='notched'?'adj':'adj2']??50000;
  const head=Math.max(.01,Math.min(.49,Math.min(e.w,e.h)*adjustment/100000/length));
  const points=e.arrowTail==='notched'?[[0,0],[1-head,0],[1,.5],[1-head,1],[0,1],[head,.5]]:
    e.arrowTail==='flat'?[[0,0],[1-head,0],[1,.5],[1-head,1],[0,1]]:
    [[0,.25],[1-head,.25],[1-head,0],[1,.5],[1-head,1],[1-head,.75],[0,.75]];
  return points.map(([x,y])=>e.arrowDirection==='left'?[1-x,y]:e.arrowDirection==='up'?[y,1-x]:e.arrowDirection==='down'?[y,x]:[x,y]);
}
