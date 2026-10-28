const directions=['right','left','up','down'];
// Classify the whole scene: a flow arrow outside all text is not a text carrier.
// Require explicit flow evidence as well as absence of contained text; unlabelled
// arrow-shaped decorations and genuine text-bearing panels keep their geometry.
export function normalizeDirectionalElements(elements){
  if(!Array.isArray(elements))return elements;
  const texts=elements.filter(e=>e?.type==='text');
  return elements.map(e=>{
    if(e?.type!=='shape'||e.managed==='progress'||e.arrowRole!=='carrier'||(e.arrowTail??(e.shape==='chevron'?'notched':'flat'))!=='flat')return normalizeDirectionalElement(e);
    const evidence=[e.key,e.description,e.frameKind].filter(Boolean).join(' ');
    const flow=/流向|指向|连接箭头|窄杆|细.{0,3}箭头|(?:flow|connector)[-_ ]?arrow|arrow[-_ ]?flow/i.test(evidence);
    const carriesText=texts.some(t=>t.x+t.w/2>e.x&&t.x+t.w/2<e.x+e.w&&t.y+t.h/2>e.y&&t.y+t.h/2<e.y+e.h);
    return normalizeDirectionalElement(flow&&!carriesText?{...e,arrowRole:'connector',arrowTail:'shaft'}:e);
  });
}
export const directionalGeometryRule='先区分用途：arrowRole=connector 是连接内容的直线、弧线或窄杆箭头，必须还原杆、尖端与朝向，完整箭头不能只剩三角头；实际窄杆流向箭头不能标成carrier或用flat/notched块面替代。carrier只用于实际承载文字或分区的箭形，结合所在位置及文字是否在块内判断；arrowRole=carrier 是承载文字或分区的箭形色块，保留完整块面与平尾/内凹尾，不改成细箭头，也不能拿箭形块替代连接箭头。SVG 六边形的外轮廓和各层内描边须关于自身横纵中轴对称，保持双尖外凸，不把内凹箭形修成六边形。箭头必须按参考图的实际尖端识别方向，不能按阅读顺序猜测。直线优先登记start:{x,y}和end:{x,y}（1600×900坐标），beginArrowType位于start端，endArrowType位于end端，圆点用oval；程序据起止点计算正宽高和翻转，不额外旋转。先按轮廓登记contourKind:arrow/hexagon/parallelogram/other；箭形与六边形绝不能用parallelogram代替；分清内凹V尾、外凸双尖和只有两组平行边的四边形。填充箭形记录arrowDirection:right/left/up/down及arrowTail:flat/notched/shaft，分别表示平尾、内凹V尾、窄杆尾；内凹V尾用chevron，不能因有六个顶点就识别为hexagon。只有左右两端均为向外凸尖且无凹口的轮廓才用hexagon。保留箭头、数字与承载的独立性；箭形内文字仍为独立text。复杂弯箭头用SVG，逐条核对尖端朝向、尾端和连接对象。';

// Explicit endpoint/contour evidence wins over ambiguous bbox/shape labels.
export function normalizeDirectionalElement(e){
  if(e?.arrowRole!==undefined&&!['connector','carrier'].includes(e.arrowRole))throw Error('arrowRole 须为 connector（连接箭头）或 carrier（文字承载箭形）');
  if(e?.arrowRole==='carrier'&&(e.type==='line'||e.curveArrow||e.arrowTail==='shaft'))throw Error('文字承载箭形不能还原成连接箭头；用平尾 flat 或内凹尾 notched 的完整块面，文字独立');
  if(e?.type==='shape'&&e.managed!=='progress'){
    if(e.contourKind!==undefined&&!['arrow','hexagon','parallelogram','other'].includes(e.contourKind))throw Error('contourKind 须为 arrow/hexagon/parallelogram/other');
    if(e.contourKind==='hexagon'){
      const {arrowDirection,arrowTail,...hexagon}=e;
      return {...hexagon,shape:'hexagon'};
    }
  }
  if(e?.type==='line'&&(e.start!==undefined||e.end!==undefined)){
    if(![e.start,e.end].every(p=>p&&typeof p.x==='number'&&typeof p.y==='number'&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1600&&p.y>=0&&p.y<=900)||e.start.x===e.end.x&&e.start.y===e.end.y)throw Error('箭头起止点无效，须为画布内两个不同的点');
    if(e.rotate)throw Error('登记起止点的线条不再叠加rotate，请直接修改起止点');
    const {start,end,...rest}=e;
    return {...rest,x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),w:Math.abs(end.x-start.x),h:Math.abs(end.y-start.y),flipH:start.x>end.x,flipV:start.y>end.y};
  }
  if(e?.type!=='shape'||e.managed==='progress'||e.contourKind!=='arrow'&&e.arrowDirection===undefined&&e.arrowTail===undefined&&e.arrowRole===undefined)return e;
  const direction=e.arrowDirection||({leftArrow:'left',upArrow:'up',downArrow:'down'}[e.shape]||'right');
  const tail=e.arrowTail||(e.shape==='chevron'?'notched':e.arrowRole==='carrier'?'flat':/^(right|left|up|down)Arrow$/.test(e.shape)?'shaft':null);
  if(!directions.includes(direction)||!['flat','notched','shaft'].includes(tail))throw Error('箭形须明确arrowDirection与arrowTail；真实六边形不登记箭形参数');
  if(e.rotate||e.flipH||e.flipV)throw Error('箭形已用arrowDirection指定朝向，请勿叠加旋转或翻转');
  if(e.arrowRole==='connector'&&tail!=='shaft')throw Error('连接箭头须保留线/弧线/窄杆和尖端，不能改成承载文字的箭形色块');
  return {...e,arrowDirection:direction,arrowTail:tail,shape:tail==='notched'?'chevron':direction+'Arrow'};
}

export function directionalShapePoints(e){
  if(!e.arrowTail)return null;
  const vertical=['up','down'].includes(e.arrowDirection),length=vertical?e.h:e.w;
  const adjustment=e.adjustments?.[e.arrowTail==='notched'?'adj':'adj2']??50000;
  const head=Math.max(.01,Math.min(.49,Math.min(e.w,e.h)*adjustment/100000/length));
  const shaft=Math.max(.01,Math.min(.98,(e.adjustments?.adj1??50000)/100000))/2;
  const points=e.arrowTail==='notched'?[[0,0],[1-head,0],[1,.5],[1-head,1],[0,1],[head,.5]]:
    e.arrowTail==='flat'?[[0,0],[1-head,0],[1,.5],[1-head,1],[0,1]]:
    [[0,.5-shaft],[1-head,.5-shaft],[1-head,0],[1,.5],[1-head,1],[1-head,.5+shaft],[0,.5+shaft]];
  return points.map(([x,y])=>e.arrowDirection==='left'?[1-x,y]:e.arrowDirection==='up'?[y,1-x]:e.arrowDirection==='down'?[y,x]:[x,y]);
}
