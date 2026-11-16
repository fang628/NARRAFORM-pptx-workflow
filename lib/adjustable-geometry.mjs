import {baseShapePoints,detailedShapePath,shapeHeadFraction} from './shape-geometry.mjs';

// Compile the same geometry into DrawingML guides instead of freezing measured
// coordinates. Every handle changes an input guide used by the actual path.
class Guides {
 constructor(e){this.e=e;this.guides=[];this.adjustments=[];this.handles=[];this.cache=new Map();this.values={w:e.w,h:e.h,ss:Math.min(e.w,e.h)};}
 value(a){return typeof a==='number'?a:this.values[a];}
 ref(a){return typeof a==='number'?String(Math.round(a)):a;}
 formula(op,args,value,name){
  const f=op+' '+args.map(a=>this.ref(a)).join(' ');
  if(!name&&this.cache.has(f))return this.cache.get(f);
  const id=name||'g'+this.guides.length;this.guides.push({name:id,fmla:f});this.values[id]=value;this.cache.set(f,id);return id;
 }
 constant(value){return this.formula('*/',[Math.round(value*1000000),1,1000000],value);}
 add(a,b){return this.formula('+-',[a,b,0],this.value(a)+this.value(b));}
 sub(a,b){return this.formula('+-',[a,0,b],this.value(a)-this.value(b));}
 mul(a,b,c=1){return this.formula('*/',[a,b,c],this.value(a)*this.value(b)/this.value(c));}
 div(a,b){return this.mul(a,1,b);}
 min(a,b){return this.formula('min',[a,b],Math.min(this.value(a),this.value(b)));}
 max(a,b){return this.formula('max',[a,b],Math.max(this.value(a),this.value(b)));}
 sqrt(a){return this.formula('sqrt',[a],Math.sqrt(Math.max(0,this.value(a))));}
 sin(a){return this.formula('sin',[1e6,a],Math.sin(this.value(a)*Math.PI/10800000)*1e6);}
 cos(a){return this.formula('cos',[1e6,a],Math.cos(this.value(a)*Math.PI/10800000)*1e6);}
 alias(name,value){return this.formula('val',[value],this.value(value),name);}
 param(name,value,lo,hi){
  this.adjustments.push({name,fmla:'val '+Math.round(value)});this.values[name]=value;
  return this.formula('pin',[lo,name,hi],Math.max(this.value(lo),Math.min(this.value(hi),value)));
 }
 handle(name,point,{axis='x',min=0,max=50000,other}={}){
  const attrs=`gdRef${axis.toUpperCase()}="${name}" min${axis.toUpperCase()}="${this.ref(min)}" max${axis.toUpperCase()}="${this.ref(max)}"`;
  const extra=other?` gdRef${axis==='x'?'Y':'X'}="${other}" min${axis==='x'?'Y':'X'}="0" max${axis==='x'?'Y':'X'}="100000"`:'';
  this.handles.push(`<a:ahXY ${attrs}${extra}><a:pos x="${this.ref(this.mul(point[0],'w',100000))}" y="${this.ref(this.mul(point[1],'h',100000))}"/></a:ahXY>`);
 }
 angleHandle(name,point){
  this.handles.push(`<a:ahPolar gdRefAng="${name}" minAng="-21600000" maxAng="21600000"><a:pos x="${this.ref(this.mul(point[0],'w',100000))}" y="${this.ref(this.mul(point[1],'h',100000))}"/></a:ahPolar>`);
 }
}

function polygon(e,d){
 const g=e.shapeGeometry||{},half=50000,one=100000;
 const tail=e.arrowTail||(e.shape==='chevron'?'notched':/^(right|left|up|down)Arrow$/.test(e.shape||'')?'shaft':null);
 const direction=e.arrowDirection||({leftArrow:'left',upArrow:'up',downArrow:'down'}[e.shape]||'right');
 const vertical=direction==='up'||direction==='down',reverse=direction==='up'||direction==='left';
 const orient=p=>p.map(([x,y])=>direction==='left'?[d.sub(one,x),y]:direction==='up'?[y,d.sub(one,x)]:direction==='down'?[y,x]:[x,y]);
 if(e.progressGeometry){
  const head=d.param('adj',e.progressGeometry.head/e.w*one,100,25000);
  const tip=d.param('adjNotch',e.progressGeometry.leftTip/e.w*one,0,49000);
  const p=[[head,0],[d.sub(one,head),0],[one,half],[d.sub(one,head),one],[head,one],[tip,half]];
  d.handle('adj',p[0],{min:100,max:25000});d.handle('adjNotch',p[5],{max:49000});return p;
 }
 if(e.footerGeometry){
  const inset=d.param('adj',e.footerGeometry.inset/e.w*one,0,49000);
  d.handle('adj',[inset,0],{max:49000});return [[inset,0],[one,0],[one,one],[0,one]];
 }
 const custom=e.customGeometry?.points;
 const close=(a,b)=>Math.abs(a-b)<1e-5;
 const verticalHex=e.shape==='hexagon'&&custom?.length===6&&close(custom[0][0],.5)&&close(custom[0][1],0)&&close(custom[3][0],.5)&&close(custom[3][1],1)
  &&close(custom[1][0],1)&&close(custom[2][0],1)&&close(custom[4][0],0)&&close(custom[5][0],0)
  &&close(custom[1][1],custom[5][1])&&close(custom[2][1],custom[4][1])&&close(custom[1][1]+custom[2][1],1);
 const horizontalHex=custom?.length===6&&close(custom[2][0],1)&&close(custom[2][1],.5)&&close(custom[5][0],0)&&close(custom[5][1],.5)
  &&close(custom[0][1],0)&&close(custom[1][1],0)&&close(custom[3][1],1)&&close(custom[4][1],1)
  &&close(custom[0][0],custom[4][0])&&close(custom[1][0],custom[3][0])&&close(custom[0][0]+custom[1][0],1);
 if(e.shape==='hexagon'&&!e.customGeometry?.commands&&(!custom||verticalHex||horizontalHex)){
  const initial=verticalHex?custom[1][1]:horizontalHex?custom[0][0]:shapeHeadFraction(e)??Math.min(.49,Math.min(e.w,e.h)*(e.adjustments?.adj??25000)/100000/e.w);
  const head=d.alias('head',d.param('adj',initial*one,500,49000)),rHead=d.alias('rHead',d.sub(one,head));
  const p=verticalHex?[[half,0],[one,head],[one,rHead],[half,one],[0,rHead],[0,head]]:[[head,0],[rHead,0],[one,half],[rHead,one],[head,one],[0,half]];
  d.alias('hx',d.mul(head,'w',one));d.alias('hy',d.mul(head,'h',one));
  d.handles.push(`<a:ahXY gdRef${verticalHex?'Y':'X'}="adj" min${verticalHex?'Y':'X'}="500" max${verticalHex?'Y':'X'}="49000"><a:pos x="${verticalHex?'0':'hx'}" y="${verticalHex?'hy':'0'}"/></a:ahXY>`);
  return p;
 }
 // An explicitly measured outline owns its vertices. Only a verified symmetric
 // hexagon above can be represented by the compact depth parameter.
 if(custom)return custom.map(([x,y],i)=>freePoint(d,x,y,i));
 if(tail&&!custom&&!e.customGeometry?.commands){
  const length=vertical?e.h:e.w;
  const initial=shapeHeadFraction({...e,arrowDirection:direction})??Math.min(.49,Math.min(e.w,e.h)*(e.adjustments?.[tail==='notched'?'adj':'adj2']??50000)/one/length);
  const head=d.alias('head',d.param('adj',initial*one,500,49000)),rHead=d.alias('rHead',d.sub(one,head));
  const notch=tail==='notched'?d.alias('notch',d.param('adjNotch',(g.notchDepth??initial)*one,0,49000)):null;
  const shaft=tail==='shaft'?d.param('adjShaft',(g.shaftRatio??(e.adjustments?.adj1??50000)/one)*one,2000,98000):null;
  const top=shaft?d.sub(half,d.div(shaft,2)):null,bottom=shaft?d.add(half,d.div(shaft,2)):null;
  const p=orient(tail==='notched'?[[0,0],[rHead,0],[one,half],[rHead,one],[0,one],[notch,half]]:tail==='flat'?[[0,0],[rHead,0],[one,half],[rHead,one],[0,one]]:
   [[0,top],[rHead,top],[rHead,0],[one,half],[rHead,one],[rHead,bottom],[0,bottom]]);
  d.handle('adj',p[tail==='shaft'?2:1],{axis:vertical?'y':'x',min:500,max:49000});
  if(notch){
   if(reverse)d.alias('rNotch',d.sub(one,notch));
   // Use the named guide on the vertex so saved parameters remain inspectable.
   p[5][vertical?1:0]=reverse?'rNotch':'notch';
   d.handle('adjNotch',p[5],{axis:vertical?'y':'x',max:49000});
  }
  if(shaft)d.handle('adjShaft',p[0],{axis:vertical?'x':'y',min:2000,max:98000});
  return p;
 }
 if(e.shape==='parallelogram'||e.shape==='trapezoid'){
  const depth=g.slantAngle!=null?Math.min(.49,e.h/Math.tan(g.slantAngle*Math.PI/180)/e.w):g.headDepth??(e.adjustments?.adj!=null?Math.min(.49,Math.min(e.w,e.h)*e.adjustments.adj/100000/e.w):(e.shape==='trapezoid'?.2:.25));
  const head=d.param('adj',depth*one,0,49000),r=d.sub(one,head);
  const p=e.shape==='trapezoid'?[[head,0],[r,0],[one,one],[0,one]]:g.slantSign===-1?[[r,0],[0,0],[head,one],[one,one]]:[[head,0],[one,0],[r,one],[0,one]];
  d.handle('adj',p[0],{max:49000});return p;
 }
 if(e.shape==='star5'){
  const inner=d.param('adjInner',(g.innerRadius??.381966)*one,12000,80000);
  const angle=d.param('adjRotation',(g.rotation??0)*60000,-21600000,21600000);
  const raw=Array.from({length:10},(_,i)=>{
   const a=d.add(angle,-5400000+i*2160000),radius=i%2?inner:one;
   return [d.mul(radius,d.cos(a),1e6),d.mul(radius,d.sin(a),1e6)];
  });
  const bounds=axis=>[raw.reduce((m,p)=>d.min(m,p[axis]),raw[0][axis]),raw.reduce((m,p)=>d.max(m,p[axis]),raw[0][axis])];
  const [left,right]=bounds(0),[top,bottom]=bounds(1);
  const p=raw.map(([x,y])=>[d.mul(d.sub(x,left),one,d.sub(right,left)),d.mul(d.sub(y,top),one,d.sub(bottom,top))]);
  d.handle('adjInner',p[1],{min:12000,max:80000});d.angleHandle('adjRotation',p[0]);return p;
 }
 if(['leftRightArrow','upDownArrow'].includes(e.shape)){
  const v=e.shape==='upDownArrow',length=v?e.h:e.w;
  const head=d.param('adj',(g.headDepth??Math.min(e.w,e.h)*(e.adjustments?.adj2??50000)/one/length)*one,500,49000);
  const shaft=d.param('adjShaft',(g.shaftRatio??(e.adjustments?.adj1??50000)/one)*one,2000,98000);
  const top=d.sub(half,d.div(shaft,2)),bottom=d.add(half,d.div(shaft,2)),r=d.sub(one,head);
  const p=[[0,half],[head,0],[head,top],[r,top],[r,0],[one,half],[r,one],[r,bottom],[head,bottom],[head,one]].map(([x,y])=>v?[y,x]:[x,y]);
  d.handle('adj',p[1],{axis:v?'y':'x',min:500,max:49000});d.handle('adjShaft',p[2],{axis:v?'x':'y',min:2000,max:98000});return p;
 }
 if(e.shape==='triangle'){
  const apex=d.param('adjApex',e.adjustments?.adj??50000,0,100000);
  d.handle('adjApex',[apex,0],{max:100000});return [[apex,0],[one,one],[0,one]];
 }
 const points=baseShapePoints(e);return points?.map(p=>p.map(n=>Math.round(n*one)))||null;
}

function freePoint(d,x,y,i){
 const a=d.param('adjX'+i,x*100000,0,100000),b=d.param('adjY'+i,y*100000,0,100000);
 d.handle('adjX'+i,[a,b],{max:100000,other:'adjY'+i});return [a,b];
}

function openPath(e,d){
 const source=e.linePath?.commands||[{op:'M',points:[[e.flipH?1:0,e.flipV?1:0]]},{op:'L',points:[[e.flipH?0:1,e.flipV?0:1]]}];
 let index=0;
 const commands=source.map(c=>({...c,points:c.points.map(([x,y])=>freePoint(d,x,y,index++))}));
 const extra=[];
 const vertices=source.map(c=>c.points.at(-1)),symbols=commands.map(c=>c.points.at(-1));
 const nodes=[...(e.linePath?.nodes||[]),...['begin','end'].filter(side=>e[side+'ArrowType']==='oval'&&e.linePath?.terminals?.[side]&&!e.keepParameters?.includes(side+'ArrowSize'))
  .map(side=>({position:side==='begin'?vertices[0]:vertices.at(-1),diameter:e.linePath.terminals[side].diameter}))];
 for(const [i,n]of nodes.entries()){
  const at=vertices.findIndex(p=>Math.hypot((p[0]-n.position[0])*e.w,(p[1]-n.position[1])*e.h)<.01);
  if(at<0)continue;
  const [x,y]=symbols[at],size=d.param('adjDiameter'+i,n.diameter/Math.max(.01,Math.min(e.w||.01,e.h||.01))*100000,0,300000000);
  const rx=d.mul(d.mul(size,'ss',200000),100000,'w'),ry=d.mul(d.mul(size,'ss',200000),100000,'h');
  const k=d.constant(.55228475),kx=d.mul(rx,k),ky=d.mul(ry,k);
  const right=d.add(x,rx),left=d.sub(x,rx),bottom=d.add(y,ry),top=d.sub(y,ry);
  const p=[{op:'M',points:[[right,y]]},{op:'C',points:[[right,d.add(y,ky)],[d.add(x,kx),bottom],[x,bottom]]},
   {op:'C',points:[[d.sub(x,kx),bottom],[left,d.add(y,ky)],[left,y]]},
   {op:'C',points:[[left,d.sub(y,ky)],[d.sub(x,kx),top],[x,top]]},
   {op:'C',points:[[d.add(x,kx),top],[right,d.sub(y,ky)],[right,y]]},{op:'Z',points:[]}];
  d.handle('adjDiameter'+i,[right,y],{max:300000000});extra.push(p);
 }
 return {commands,extra};
}

function plaquePath(e,d){
 const g=e.shapeGeometry||{},radius=d.param('adjRadius',(g.cornerRadius??(e.adjustments?.adj??16667)/100000)*100000,0,50000);
 const r=d.mul(radius,'ss',100000),k=d.mul(r,d.constant(.552284749831));
 const w='w',h='h',right=d.sub(w,r),bottom=d.sub(h,r),rk=d.sub(w,k),bk=d.sub(h,k);
 d.handle('adjRadius',[d.mul(r,100000,w),0],{max:50000});
 const path=[{op:'M',points:[[r,0]]},{op:'L',points:[[right,0]]},{op:'C',points:[[right,k],[rk,r],[w,r]]},
  {op:'L',points:[[w,bottom]]},{op:'C',points:[[rk,bottom],[right,bk],[right,h]]},
  {op:'L',points:[[r,h]]},{op:'C',points:[[r,bk],[k,bottom],[0,bottom]]},
  {op:'L',points:[[0,r]]},{op:'C',points:[[k,r],[r,k],[r,0]]},{op:'Z',points:[]}];
 return path.map(c=>({...c,points:c.points.map(p=>p.map((a,i)=>d.mul(a,100000,i?h:w)))}));
}

function cornerPath(e,d,points){
 const g=e.shapeGeometry||{},explicit=g.version===2,scale='ss';
 const round=g.cornerRadius??(e.shape==='roundRect'?(e.adjustments?.adj??16667)/100000:0),cut=g.cutCorner??0;
 const shared=new Map();
 const dot=(a,b)=>d.add(d.mul(a[0],b[0]),d.mul(a[1],b[1]));
 const length=v=>d.sqrt(dot(v,v));
 const sub=(a,b)=>a.map((v,i)=>d.sub(v,b[i]));
 const scaled=(p,v,n)=>p.map((a,i)=>d.add(a,d.mul(v[i],n)));
 const physical=points.map(([x,y])=>[d.mul(x,'w',100000),d.mul(y,'h',100000)]);
 const segments=physical.map((p,i)=>{
  const before=physical[(i+points.length-1)%points.length],after=physical[(i+1)%points.length];
  const av=sub(before,p),bv=sub(after,p),la=length(av),lb=length(bv);
  const u=av.map(a=>d.div(a,la)),v=bv.map(a=>d.div(a,lb));
  const c=g.corners?.[i]||{type:g.cutCorner!==undefined?'cut':g.cornerRadius!==undefined||e.shape==='roundRect'?'round':'sharp',radius:round,distance:cut};
  if(c.type==='sharp')return {start:p,end:p,type:'sharp'};
  const amount=c.type==='cut'?(c.distance??cut):(c.radius??round);
  const name=g.corners?'adjCorner'+i:c.type==='cut'?'adjCut':'adjRadius';
  let parameter=shared.get(name);
  if(!parameter){parameter=d.param(name,amount*100000,0,50000);shared.set(name,parameter);}
  const cos=d.min(d.constant(.999999),d.max(d.constant(-.999999),dot(u,v)));
  const tan=d.sqrt(d.div(d.sub(1,cos),d.add(1,cos)));
  const distance=explicit&&c.type==='round'?d.div(d.mul(parameter,scale,100000),tan):d.mul(parameter,scale,100000);
  const reach=d.min(distance,d.mul(d.min(la,lb),explicit?45:40,100));
  const start=scaled(p,u,reach),end=scaled(p,v,reach);
  const axis=Math.abs(d.value(u[0]))>=Math.abs(d.value(u[1]))?'x':'y';
  d.handle(name,start.map((a,j)=>d.mul(a,100000,j?'h':'w')),{axis,max:50000});
  if(c.type!=='round'||!explicit)return {start,end,type:c.type,vertex:p};
  // tan(turn/4) = sin(turn/2)/(1+cos(turn/2)); use only
  // DrawingML arithmetic so moving either slant or radius recomputes controls.
  const sinHalf=d.sqrt(d.div(d.add(1,cos),2)),cosHalf=d.sqrt(d.div(d.sub(1,cos),2));
  const k=d.mul(d.mul(reach,tan),d.div(sinHalf,d.add(1,cosHalf)));
  const handle=d.mul(k,4,3);
  return {start,end,type:'round',c1:scaled(start,u,d.mul(handle,-1)),c2:scaled(end,v,d.mul(handle,-1))};
 });
 const normalized=p=>p.map((a,j)=>d.mul(a,100000,j?'h':'w'));
 const commands=[];
 for(const [i,s]of segments.entries()){
  commands.push({op:i?'L':'M',points:[normalized(s.start)]});
  if(s.type==='round')commands.push(explicit?{op:'C',points:[normalized(s.c1),normalized(s.c2),normalized(s.end)]}:{op:'Q',points:[normalized(s.vertex),normalized(s.end)]});
  else if(s.type==='cut')commands.push({op:'L',points:[normalized(s.end)]});
 }
 return [...commands,{op:'Z',points:[]}];
}

export function adjustableGeometry(e,{stroke}={}){
 const d=new Guides({...e,w:Math.max(.01,e.w),h:Math.max(.01,e.h)});let commands,lineExtras=[];
 if(e.type==='line'){
  const line=openPath(e,d);commands=line.commands;lineExtras=line.extra;
 }else if(e.shape==='plaque'&&!e.customGeometry){commands=plaquePath(e,d);
 }else if(e.customGeometry?.commands){
  let index=0;commands=e.customGeometry.commands.map(c=>({...c,points:c.points.map(([x,y])=>freePoint(d,x,y,index++))}));
 }else{
  const points=polygon(e,d);if(!points)return null;
  const g=e.shapeGeometry||{};
  commands=(!e.customGeometry&&(g.cornerRadius!==undefined||g.cutCorner!==undefined||g.corners?.some(c=>c.type!=='sharp')||e.shape==='roundRect'))
   ?cornerPath(e,d,points):points.map((p,i)=>({op:i?'L':'M',points:[p]})).concat({op:'Z',points:[]});
 }
 const pathXML=list=>list.map(c=>{
  const tag={M:'moveTo',L:'lnTo',Q:'quadBezTo',C:'cubicBezTo'}[c.op];
  return c.op==='Z'?'<a:close/>':`<a:${tag}>${c.points.map(([x,y])=>`<a:pt x="${d.ref(x)}" y="${d.ref(y)}"/>`).join('')}</a:${tag}>`;
 }).join('');
 let paths=`<a:path w="100000" h="100000"${e.type==='line'?' fill="none" stroke="1"':stroke?' stroke="0"':''}>${pathXML(commands)}</a:path>`;
 paths+=lineExtras.map(p=>`<a:path w="100000" h="100000" fill="norm" stroke="0">${pathXML(p)}</a:path>`).join('');
 if(stroke){
  const fixed=detailedShapePath(e),flat=fixed.flatMap(c=>c.points||[]);
  const symbolic=commands.flatMap(c=>c.points||[]);
  const locate=p=>{
   const at=flat.findIndex(q=>Math.hypot(q[0]-p[0],q[1]-p[1])<1e-5);
   if(at>=0&&symbolic[at])return symbolic[at];
   let previous,first;
   for(const [i,c]of fixed.entries()){
    const end=c.op==='Z'?first:c.points.at(-1),prior=i?commands[i-1].points.at(-1):null;
    if(previous&&end&&['L','Z'].includes(c.op)){
     const vx=end[0]-previous[0],vy=end[1]-previous[1],den=vx*vx+vy*vy;
     const t=den?((p[0]-previous[0])*vx+(p[1]-previous[1])*vy)/den:0;
     if(t>=-1e-6&&t<=1+1e-6&&Math.hypot(previous[0]+t*vx-p[0],previous[1]+t*vy-p[1])<1e-4){
      const a=prior,b=c.op==='Z'?commands[0].points[0]:commands[i].points.at(-1);
      return a.map((v,j)=>d.add(v,d.mul(d.sub(b[j],v),d.constant(t))));
     }
    }
    if(c.op==='M')first=end;if(end)previous=end;
   }
   throw Error('Shared frame edge cannot retain adjustable geometry: '+e.key);
  };
  paths+=`<a:path w="100000" h="100000" fill="none">${pathXML(stroke.map(c=>({...c,points:c.points.map(locate)})))}</a:path>`;
 }
 const xml=list=>list.map(g=>`<a:gd name="${g.name}" fmla="${g.fmla}"/>`).join('');
 return {xml:`<a:custGeom><a:avLst>${xml(d.adjustments)}</a:avLst><a:gdLst>${xml(d.guides)}</a:gdLst><a:ahLst>${[...new Set(d.handles)].join('')}</a:ahLst><a:cxnLst/><a:rect l="0" t="0" r="w" b="h"/><a:pathLst>${paths}</a:pathLst></a:custGeom>`,
  adjustments:d.adjustments,guides:d.guides,commands,extraCommands:lineExtras};
}
