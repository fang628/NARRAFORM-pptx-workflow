import {parseSVGTree,svgTransform,multiplyMatrix} from './svg-tree.mjs';
import {parseVectorPath as parsePath} from './vector-path.mjs';

// Straight line/dot groups stay editable. Any curvature/lighting aborts the
// whole conversion, so unsupported parts are never silently discarded.
export function nativeLineGroup(element,paint){
 if(element.type!=='svg'||!element.svg||element.glow||element.shadow||element.lineEffect==='lit'||element.rotate)return null;
 if(/<(?:filter|mask|clipPath|text|image|pattern|style|use)\b|\b(?:filter|class|clip-path|mask)\s*=/i.test(element.svg))return null;
 let root;try{root=parseSVGTree(element.svg);}catch{return null;}
 const view=root.attrs.viewBox?.trim().split(/[\s,]+/).map(Number);if(view?.length!==4||!view.every(Number.isFinite)||view[2]<=0||view[3]<=0)return null;
 const sx=element.w/view[2],sy=element.h/view[3];if(Math.abs(sx-sy)>Math.max(sx,sy)*.01)return null;
 const parts=[],markers=new Map();let hasLine=false;const identity=[1,0,0,1,0,0];
 const attrs=(node,parent)=>{const a={...parent,...node.attrs};if(node.attrs.style)for(const entry of node.attrs.style.split(';')){const i=entry.indexOf(':');if(i>0)a[entry.slice(0,i).trim()]=entry.slice(i+1).trim();}for(const k of Object.keys(a))if(a[k]==='inherit'){if(parent[k]!==undefined)a[k]=parent[k];else delete a[k];}return a;};
 const alpha=v=>typeof v==='string'&&v.trim().endsWith('%')?Number(v.trim().slice(0,-1))/100:Number(v??1);
 const dash=a=>{if(!a['stroke-dasharray']||a['stroke-dasharray']==='none')return {};if(Number(a['stroke-dashoffset']||0)!==0)throw Error('custom dash offset');const values=a['stroke-dasharray'].trim().split(/[\s,]+/).map(Number);if(!values.length||values.some(v=>!Number.isFinite(v)||v<=0))throw Error('invalid dash');return {dashType:values.length>=4?'dashDot':values[0]<=Number(a['stroke-width']||1)*1.3?'sysDot':'dash'};};
 const point=(m,x,y)=>[element.x+(m[0]*x+m[2]*y+m[4]-view[0])*sx,element.y+(m[1]*x+m[3]*y+m[5]-view[1])*sy];
 const bounds=ps=>{const x=Math.min(...ps.map(p=>p[0])),y=Math.min(...ps.map(p=>p[1]));return {x,y,w:Math.max(.01,Math.max(...ps.map(p=>p[0]))-x),h:Math.max(.01,Math.max(...ps.map(p=>p[1]))-y)};};
 function mappedPaint(value,box,mid,out,m){
  const p=paint(value,element.svg,{...box,view});if(!p)throw Error('unsupported paint');if(!p.gradient)return p;
  const g=p.gradient;if(g.type!=='linear')throw Error('nonlinear SVG paint needs separate native fitting');
  const theta=g.angle*Math.PI/180,span=Math.max(1e-8,Math.abs(box.w*Math.cos(theta))+Math.abs(box.h*Math.sin(theta))),gx=Math.cos(theta)/span,gy=Math.sin(theta)/span;
  const a=m[0]*sx,b=m[1]*sy,c=m[2]*sx,d=m[3]*sy,det=a*d-b*c;if(Math.abs(det)<1e-12)throw Error('singular transform');
  const ux=(d*gx-b*gy)/det,uy=(-c*gx+a*gy)/det,norm=Math.hypot(ux,uy),slope=Math.abs(ux)*out.w+Math.abs(uy)*out.h,offset=.5+gx*(mid[0]-box.x-box.w/2)+gy*(mid[1]-box.y-box.h/2)-slope/2;
  if(slope<1e-8||!Number.isFinite(norm))throw Error('degenerate gradient');
  const at=t=>{let i=g.stops.findIndex(s=>s.position>=t);if(i<0)i=g.stops.length-1;const lo=g.stops[Math.max(0,i-1)],hi=g.stops[i],f=Math.max(0,Math.min(1,(t-lo.position)/(hi.position-lo.position||1))),rgb=s=>s.color.match(/../g).map(v=>parseInt(v,16));return {color:rgb(lo).map((v,j)=>Math.round(v+(rgb(hi)[j]-v)*f).toString(16).padStart(2,'0')).join('').toUpperCase(),opacity:lo.opacity+(hi.opacity-lo.opacity)*f};};
  return {...p,gradient:{type:'linear',angle:(Math.atan2(uy,ux)*180/Math.PI+360)%360,stops:[{position:0,...at(offset)},...g.stops.map(s=>({...s,position:(s.position-offset)/slope})).filter(s=>s.position>1e-8&&s.position<1-1e-8),{position:1,...at(offset+slope)}]}};
 }
 function marker(value,begin,p,q,stroke){
  if(!value||value==='none')return undefined;const id=value.match(/^url\(#([\w.-]+)\)$/)?.[1],m=markers.get(id);if(!m||m.children.length!==1)throw Error('unknown marker');const child=m.children[0],a=attrs(child,m.attrs),fill=a.fill||'#000000';
  if(a.transform||Number(m.attrs.markerWidth??3)!==3||Number(m.attrs.markerHeight??3)!==3||m.attrs.markerUnits&&m.attrs.markerUnits!=='strokeWidth')throw Error('custom marker geometry');
  if(fill!=='context-stroke'){const c=paint(fill,element.svg,{x:0,y:0,w:view[2],h:view[3],view});if(!c||c.gradient||stroke.gradient||c.color!==stroke.color||c.opacity!==1)throw Error('independent marker paint');}
  if(['circle','ellipse'].includes(child.name))return 'oval';
  let points;if(child.name==='polygon'){const v=child.attrs.points?.trim().split(/[\s,]+/).map(Number);if(v?.length===6)points=[v.slice(0,2),v.slice(2,4),v.slice(4,6)];}
  if(child.name==='path'){const c=parsePath(child.attrs.d);if(c.every(n=>['M','L','Z'].includes(n.op))&&c.filter(n=>n.op!=='Z').length===3)points=c.filter(n=>n.op!=='Z').map(n=>n.points[0]);}
  if(!points||points.some(p=>!p.every(Number.isFinite)))throw Error('unsupported marker');
  const tip=[...points].sort((a,b)=>b[0]-a[0])[0],base=points.filter(p=>p!==tip);if(Math.abs(base[0][0]-base[1][0])>.01||tip[0]<=base[0][0])throw Error('nonstandard arrow tip');
  const orient=m.attrs.orient||'0',native=Math.atan2(q[1]-p[1],q[0]-p[0])*180/Math.PI+(begin?180:0),actual=orient==='auto-start-reverse'?native:orient==='auto'?native-(begin?180:0):Number(orient.replace(/deg$/,''));
  if(!Number.isFinite(actual)||Math.abs(((actual-native+540)%360)-180)>.1)throw Error('marker direction is not a native endpoint');
  return 'triangle';
 }
 function visit(node,parent={},matrix=identity,groupOpacity=1){
  if(node.name==='#text')throw Error('text');if(node.name==='defs'){for(const c of node.children)if(c.name==='marker')markers.set(c.attrs.id,c);return;}
  if(['linearGradient','radialGradient','stop','marker','title','desc'].includes(node.name))return;
  const a=attrs(node,parent),m=multiplyMatrix(matrix,svgTransform(node.attrs.transform||'')),composedOpacity=groupOpacity*alpha(attrs(node,{}).opacity);
  if(a.display==='none'||composedOpacity===0)return;
  if(['svg','g'].includes(node.name)){for(const child of node.children)visit(child,a,m,composedOpacity);return;}
  if(['hidden','collapse'].includes(a.visibility))return;
  if(parts.length>64)throw Error('too many parts');
  const n=(k,d=0)=>Number(a[k]??d),opacity=composedOpacity*(element.opacity??1),fill=paint(a.fill||'black',element.svg,{x:0,y:0,w:view[2],h:view[3],view}),stroke=paint(a.stroke||'none',element.svg,{x:0,y:0,w:view[2],h:view[3],view});
  const scale=Math.hypot(m[0]*sx,m[1]*sy),other=Math.hypot(m[2]*sx,m[3]*sy);if(Math.abs(scale-other)>Math.max(scale,other)*.01||Math.abs(m[0]*m[2]*sx*sx+m[1]*m[3]*sy*sy)>Math.max(1e-8,scale*other)*.001)throw Error('nonuniform/sheared transform');
  const common={opacity,color:stroke?.color||'000000',strokeWidth:stroke?.opacity?n('stroke-width',1)*scale:0,...(stroke?.gradient?{strokeGradient:stroke.gradient}:{}),colorOpacity:alpha(a['stroke-opacity'])*(stroke?.opacity??0),...dash(a)};
  const line=(p,q,begin,end,sourceBox)=>{
   if(!stroke||!stroke.opacity||!Number.isFinite(common.strokeWidth))throw Error('line stroke');hasLine=true;
   const det=m[0]*m[3]-m[1]*m[2],unpoint=p=>{const x=(p[0]-element.x)/sx+view[0]-m[4],y=(p[1]-element.y)/sy+view[1]-m[5];return [(m[3]*x-m[2]*y)/det,(-m[1]*x+m[0]*y)/det];},lp=unpoint(p),lq=unpoint(q),box=bounds([p,q]);
   const actual=mappedPaint(a.stroke,sourceBox||bounds([lp,lq]),[(lp[0]+lq[0])/2,(lp[1]+lq[1])/2],box,m);
   parts.push({...common,type:'line',...box,color:actual.color,flipH:p[0]>q[0],flipV:p[1]>q[1],...(actual.gradient?{gradient:actual.gradient,strokeGradient:undefined}:{}),...(begin?{beginArrowType:begin}:{}),...(end?{endArrowType:end}:{})});
  };
  if(node.name==='line'){const p=[n('x1'),n('y1')],q=[n('x2'),n('y2')];line(point(m,...p),point(m,...q),marker(a['marker-start'],true,p,q,stroke),marker(a['marker-end'],false,p,q,stroke));}
  else if(['polyline','path'].includes(node.name)){
   if(fill?.opacity&&a.fill!=='none')throw Error('filled path');let locals;
   if(node.name==='path'){const cmds=parsePath(a.d);if(cmds.some(c=>!['M','L'].includes(c.op))||cmds.filter(c=>c.op==='M').length!==1)throw Error('curved/closed path');locals=cmds.map(c=>c.points[0]);}
   else{const v=a.points.trim().split(/[\s,]+/).map(Number);if(v.length%2||!v.every(Number.isFinite))throw Error('points');locals=Array.from({length:v.length/2},(_,i)=>[v[i*2],v[i*2+1]]);}
   const points=locals.map(p=>point(m,...p)),box=bounds(locals);for(let i=1;i<points.length;i++)line(points[i-1],points[i],i===1?marker(a['marker-start'],true,locals[0],locals[1],stroke):undefined,i===points.length-1?marker(a['marker-end'],false,locals.at(-2),locals.at(-1),stroke):undefined,box);
  }else if(['circle','ellipse'].includes(node.name)){
   if(!fill||m[1]||m[2])throw Error('ellipse');const cx=n('cx'),cy=n('cy'),lx=n('rx',n('r')),ly=n('ry',n('r')),p=point(m,cx,cy),rx=lx*Math.abs(m[0]*sx),ry=ly*Math.abs(m[3]*sy);if(rx<=0||ry<=0)throw Error('radius');const box={x:p[0]-rx,y:p[1]-ry,w:rx*2,h:ry*2},local={x:cx-lx,y:cy-ly,w:lx*2,h:ly*2},actual=mappedPaint(a.fill||'black',local,[cx,cy],box,m),outline=mappedPaint(a.stroke||'none',local,[cx,cy],box,m);parts.push({...common,type:'ellipse',...box,fill:actual.color,color:outline.color,strokeGradient:outline.gradient,fillOpacity:alpha(a['fill-opacity'])*actual.opacity,...(actual.gradient?{gradient:actual.gradient}:{})});
  }else throw Error('not straight-line/dot group');
 }
 try{visit(root);}catch{return null;}
 if(!hasLine||!parts.length||parts.some(e=>!['x','y','w','h','opacity','strokeWidth','colorOpacity'].every(k=>Number.isFinite(e[k]))||['opacity','colorOpacity','fillOpacity'].some(k=>e[k]!==undefined&&(!Number.isFinite(e[k])||e[k]<0||e[k]>1))))return null;
 const {svg,id,implementation,curveArrow,...rest}=element;
 return parts.map((part,i)=>({...rest,...part,key:i?`${element.key.slice(0,54)}-part-${i}`:element.key,representationGroup:element.key,representationOrigin:'native-straight-line-dot-group'}));
}
