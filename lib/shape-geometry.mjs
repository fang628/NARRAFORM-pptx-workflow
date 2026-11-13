// Geometry is independent of the object's bounding box: changing a bevel angle
// moves its vertices, not the text carrier's size or position.
export function shapeGeometry(value){
 if(value==null)return undefined;if(typeof value!=='object'||Array.isArray(value))throw Error('原生形状细节参数须为对象');
 const limits={slantAngle:[5,85],slantSign:[-1,1],headDepth:[.005,.49],notchDepth:[0,.49],shaftRatio:[.02,.98],cornerRadius:[0,.5],cutCorner:[0,.49],innerRadius:[.12,.8],rotation:[-360,360]};
 const result={};for(const [key,v]of Object.entries(value)){
  if(key==='cornerSymmetry'){if(!['auto','horizontal','diagonal','all','none'].includes(v))throw Error('角部对称模式无效');result.cornerSymmetry=v;continue;}
  if(key==='version'){if(v!==2)throw Error('未知几何参数版本');result.version=2;continue;}
  if(key==='corners'){
   if(!Array.isArray(v)||v.length<3||v.length>32)throw Error('逐角参数须为3–32项');
   result.corners=v.map(c=>{if(!c||!['sharp','round','cut'].includes(c.type))throw Error('角部类型无效');const out={type:c.type};for(const f of ['radius','distance'])if(c[f]!==undefined){if(!Number.isFinite(c[f])||c[f]<0||c[f]>.5)throw Error('角部尺寸无效');out[f]=c[f];}return out;});continue;
  }
  if(!limits[key])throw Error('未知形状细节参数：'+key);const n=Number(v),[min,max]=limits[key];if(!Number.isFinite(n)||n<min||n>max||key==='slantSign'&&Math.abs(n)!==1)throw Error('形状细节参数无效：'+key);result[key]=n;
 }if(result.corners)result.version=2;return result;
}
export function shapeHeadFraction(e){
 const g=e.shapeGeometry||{},vertical=['up','down'].includes(e.arrowDirection),length=vertical?e.h:e.w,cross=vertical?e.w:e.h;
 if(g.slantAngle!==undefined)return Math.max(.005,Math.min(.49,cross/2/Math.tan(g.slantAngle*Math.PI/180)/length));
 return g.headDepth;
}
export function baseShapePoints(e){
 const g=e.shapeGeometry||{},w=e.w,h=e.h,head=shapeHeadFraction(e);
 if(!e.arrowTail&&e.shape==='chevron')return baseShapePoints({...e,arrowTail:'notched',arrowDirection:'right'});
 if(!e.arrowTail&&['rightArrow','leftArrow','upArrow','downArrow'].includes(e.shape))return baseShapePoints({...e,arrowTail:'shaft',arrowDirection:e.shape.replace('Arrow','')});
 if(e.arrowTail){
  const q=head??Math.min(w,h)*(e.adjustments?.[e.arrowTail==='notched'?'adj':'adj2']??50000)/100000/(['up','down'].includes(e.arrowDirection)?h:w),a=Math.max(.005,Math.min(.49,q)),notch=g.notchDepth??a,s=(g.shaftRatio??(e.adjustments?.adj1??50000)/100000)/2;
  const pts=e.arrowTail==='notched'?[[0,0],[1-a,0],[1,.5],[1-a,1],[0,1],[notch,.5]]:e.arrowTail==='flat'?[[0,0],[1-a,0],[1,.5],[1-a,1],[0,1]]:[[0,.5-s],[1-a,.5-s],[1-a,0],[1,.5],[1-a,1],[1-a,.5+s],[0,.5+s]];
  return pts.map(([x,y])=>e.arrowDirection==='left'?[1-x,y]:e.arrowDirection==='up'?[y,1-x]:e.arrowDirection==='down'?[y,x]:[x,y]);
 }
 if(e.shape==='hexagon'){const a=head??Math.min(.49,Math.min(w,h)*(e.adjustments?.adj??25000)/100000/w);return [[a,0],[1-a,0],[1,.5],[1-a,1],[a,1],[0,.5]];}
 if(e.shape==='star5'){
  const inner=g.innerRadius??.381966,angle=(g.rotation??0)*Math.PI/180;
  const points=Array.from({length:10},(_,i)=>{const a=-Math.PI/2+i*Math.PI/5+angle,r=i%2?inner:1;return [r*Math.cos(a),r*Math.sin(a)];});
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]),x=Math.min(...xs),y=Math.min(...ys),width=Math.max(...xs)-x,height=Math.max(...ys)-y;return points.map(([a,b])=>[(a-x)/width,(b-y)/height]);
 }
 if(e.shape==='parallelogram'){const a=g.slantAngle!==undefined?Math.min(.49,h/Math.tan(g.slantAngle*Math.PI/180)/w):g.headDepth??.25,pts=[[a,0],[1,0],[1-a,1],[0,1]];return g.slantSign===-1?pts.map(([x,y])=>[1-x,y]):pts;}
 if(e.shape==='trapezoid'){const a=g.slantAngle!==undefined?Math.min(.49,h/Math.tan(g.slantAngle*Math.PI/180)/w):g.headDepth??.2;return [[a,0],[1-a,0],[1,1],[0,1]];}
 return {diamond:[[.5,0],[1,.5],[.5,1],[0,.5]],triangle:[[.5,0],[1,1],[0,1]],rtTriangle:[[0,0],[1,1],[0,1]],pentagon:[[.5,0],[1,.381966],[.809017,1],[.190983,1],[0,.381966]],rect:[[0,0],[1,0],[1,1],[0,1]],roundRect:[[0,0],[1,0],[1,1],[0,1]]}[e.shape||e.type];
}
export function detailedShapePath(e){
 const points=baseShapePoints(e);if(!points)return null;
 const g=e.shapeGeometry||{},round=(g.cornerRadius??(e.shape==='roundRect'?.166667:0))*Math.min(e.w,e.h),cut=(g.cutCorner??0)*Math.min(e.w,e.h);
 const vertices=points.map(([x,y])=>[x*e.w,y*e.h]);
 if(g.version===2){
  if(g.corners&&g.corners.length!==vertices.length)throw Error('逐角参数数量与基础顶点不一致');
  const scale=Math.min(e.w,e.h),segments=vertices.map((p,i)=>{
   const a=vertices[(i+vertices.length-1)%vertices.length],b=vertices[(i+1)%vertices.length],la=Math.hypot(a[0]-p[0],a[1]-p[1]),lb=Math.hypot(b[0]-p[0],b[1]-p[1]);
   const u=[(a[0]-p[0])/la,(a[1]-p[1])/la],v=[(b[0]-p[0])/lb,(b[1]-p[1])/lb],angle=Math.acos(Math.max(-1,Math.min(1,u[0]*v[0]+u[1]*v[1])));
   const c=g.corners?.[i]||{type:cut?'cut':round?'round':'sharp',radius:g.cornerRadius,distance:g.cutCorner};
   let d=c.type==='round'?(c.radius??g.cornerRadius??0)*scale/Math.max(.01,Math.tan(angle/2)):c.type==='cut'?(c.distance??g.cutCorner??0)*scale:0;
   d=Math.min(d,la*.45,lb*.45);const radius=d*Math.tan(angle/2),k=4/3*Math.tan((Math.PI-angle)/4)*radius;
   const start=[p[0]+u[0]*d,p[1]+u[1]*d],end=[p[0]+v[0]*d,p[1]+v[1]*d];
   return {start,end,type:c.type,c1:[start[0]-u[0]*k,start[1]-u[1]*k],c2:[end[0]-v[0]*k,end[1]-v[1]*k]};
  });
  const path=[];for(const [i,s]of segments.entries()){path.push({op:i?'L':'M',points:[s.start]});if(s.type==='round'&&Math.hypot(s.start[0]-s.end[0],s.start[1]-s.end[1])>1e-8)path.push({op:'C',points:[s.c1,s.c2,s.end]});else if(s.type==='cut')path.push({op:'L',points:[s.end]});}return path.concat({op:'Z',points:[]});
 }
 if(!round&&!cut)return vertices.map((p,i)=>({op:i?'L':'M',points:[p]})).concat({op:'Z',points:[]});
 const segments=vertices.map((p,i)=>{
  const a=vertices[(i+vertices.length-1)%vertices.length],b=vertices[(i+1)%vertices.length],l=Math.hypot(a[0]-p[0],a[1]-p[1]),r=Math.hypot(b[0]-p[0],b[1]-p[1]),d=Math.min(cut||round,l*.4,r*.4);
  return {vertex:p,in:[p[0]+(a[0]-p[0])*d/l,p[1]+(a[1]-p[1])*d/l],out:[p[0]+(b[0]-p[0])*d/r,p[1]+(b[1]-p[1])*d/r]};
 });
 const path=[];for(const [i,s]of segments.entries()){path.push({op:i?'L':'M',points:[s.in]});path.push(cut?{op:'L',points:[s.out]}:{op:'Q',points:[s.vertex,s.out]});}path.push({op:'Z',points:[]});return path;
}
export function detailedShapeSVG(e){const path=detailedShapePath(e);return path?`path d="${path.map(c=>c.op+c.points.map(([x,y])=>`${e.x+x},${e.y+y}`).join(' ')).join(' ')}"`:null;}
export function detailedShapeXML(e){
 const path=detailedShapePath(e);if(!path)return null;
 const g=e.shapeGeometry||{},adjustable=(e.shape==='hexagon'||e.arrowTail)&&!g.cornerRadius&&!g.cutCorner;
 let guides='',handles='',av='',points;
 if(adjustable){
  const head=shapeHeadFraction(e)??(e.shape==='hexagon'?Math.min(e.w,e.h)*(e.adjustments?.adj??25000)/100000/e.w:Math.min(e.w,e.h)*(e.adjustments?.[e.arrowTail==='notched'?'adj':'adj2']??50000)/100000/(['up','down'].includes(e.arrowDirection)?e.h:e.w)),depth=Math.round(Math.min(.49,head)*100000);
  av=`<a:gd name="adj" fmla="val ${depth}"/>`;guides='<a:gd name="head" fmla="pin 500 adj 49000"/><a:gd name="rHead" fmla="+- 100000 0 head"/>';
  const vertical=['up','down'].includes(e.arrowDirection),reverse=['left','up'].includes(e.arrowDirection),position=reverse?'rHead':'head';
  guides+='<a:gd name="hx" fmla="*/ w head 100000"/><a:gd name="hy" fmla="*/ h head 100000"/><a:gd name="rhx" fmla="+- w 0 hx"/><a:gd name="rhy" fmla="+- h 0 hy"/>';
  handles=`<a:ahXY gdRef${vertical?'Y':'X'}="adj" min${vertical?'Y':'X'}="500" max${vertical?'Y':'X'}="49000"><a:pos x="${vertical?'0':reverse?'rhx':'hx'}" y="${vertical?reverse?'rhy':'hy':'0'}"/></a:ahXY>`;
  // Reference the adjustable head vertices; other coordinates retain independent
  // notch/shaft parameters. Native PowerPoint handles change bevel, not bbox.
  points=path.map((c,ci)=>({...c,points:c.points.map(([x,y])=>{
   const values=[Math.round(x/e.w*100000),Math.round(y/e.h*100000)],axis=vertical?1:0;
   if(!(e.arrowTail==='notched'&&g.notchDepth!=null&&ci===5)){if(Math.abs(values[axis]-depth)<2)values[axis]='head';else if(Math.abs(values[axis]-(100000-depth))<2)values[axis]='rHead';}return values;
  })}));
 }else points=path.map(c=>({...c,points:c.points.map(([x,y])=>[Math.round(x/e.w*100000),Math.round(y/e.h*100000)])}));
 const tags={M:'moveTo',L:'lnTo',Q:'quadBezTo',C:'cubicBezTo'},commands=points.map(c=>c.op==='Z'?'<a:close/>':`<a:${tags[c.op]}>${c.points.map(([x,y])=>`<a:pt x="${x}" y="${y}"/>`).join('')}</a:${tags[c.op]}>`).join('');
 return `<a:custGeom><a:avLst>${av}</a:avLst><a:gdLst>${guides}</a:gdLst><a:ahLst>${handles}</a:ahLst><a:cxnLst/><a:rect l="0" t="0" r="w" b="h"/><a:pathLst><a:path w="100000" h="100000">${commands}</a:path></a:pathLst></a:custGeom>`;
}
