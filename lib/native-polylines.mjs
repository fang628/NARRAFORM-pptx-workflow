import {baseShapePoints} from './shape-geometry.mjs';

const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const center=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2];
const ends=e=>[[e.x+(e.flipH?e.w:0),e.y+(e.flipV?e.h:0)],
 [e.x+(e.flipH?0:e.w),e.y+(e.flipV?0:e.h)]];
const rgb=c=>/^[\da-f]{6}$/i.test(c||'')?c.match(/../g).map(x=>parseInt(x,16)):null;
const label=e=>e.representationGroup||e.polylineId||null;
const endpointMarker=(e,index)=>e.type==='line'?e[index?'endArrowType':'beginArrowType']:null;

// Only actual narrow native strokes qualify; carrier edges and table grids are not chains.
export function nativeSegment(e){
 if(!e||e.managed||e.tableId||e.tableRole||e.effectOf||e.role==='effect'||e.glow||e.shadow||e.rotate
  ||e.lineEffect==='lit'||e.arrowTail||e.arrowRole==='carrier')return null;
 if(e.type==='line'){
  const points=ends(e),width=e.strokeWidth??1;
  if(distance(...points)<8||width<=0||e.dashType&&e.dashType!=='solid')return null;
  return {key:e.key,points,width,color:e.color,opacity:(e.opacity??1)*(e.colorOpacity??1),gradient:e.strokeGradient||e.gradient};
 }
 if(!['shape','rect'].includes(e.type)||e.nativeRequired&&!label(e)||['carrier','frame','background','content-frame'].includes(e.role)
  ||e.strokeWidth>0||e.shapeGeometry?.corners||e.shapeGeometry?.cornerRadius||e.shapeGeometry?.cutCorner)return null;
 if(e.shape&&!['rect','parallelogram','freeform'].includes(e.shape))return null;
 const raw=e.customGeometry?.points||(!e.customGeometry?baseShapePoints(e):null);
 if(raw?.length!==4)return null;
 const p=raw.map(([x,y])=>[e.x+(e.flipH?1-x:x)*e.w,e.y+(e.flipV?1-y:y)*e.h]);
 const pairs=[[[p[0],p[1]],[p[2],p[3]]],[[p[1],p[2]],[p[3],p[0]]]];
 const caps=pairs.sort((a,b)=>a.reduce((n,q)=>n+distance(...q),0)-b.reduce((n,q)=>n+distance(...q),0))[0];
 const width=(distance(...caps[0])+distance(...caps[1]))/2,points=caps.map(q=>center(...q)),length=distance(...points);
 const reference=e.objectIdentity?.component?.referenceEndpoints;
 if(reference&&distance(points[0],reference[1])+distance(points[1],reference[0])<distance(points[0],reference[0])+distance(points[1],reference[1]))points.reverse();
 if(!reference&&(points[0][0]>points[1][0]||Math.abs(points[0][0]-points[1][0])<1e-8&&points[0][1]>points[1][1]))points.reverse();
 if(width<.5||width>12||length<width*4||length<12||Math.abs(distance(...caps[0])-distance(...caps[1]))>width*.2)return null;
 const d=points[1].map((v,i)=>(v-points[0][i])/length);
 if(caps.some(cap=>Math.abs((cap[1][0]-cap[0][0])*d[0]+(cap[1][1]-cap[0][1])*d[1])>width*.3))return null;
 return {key:e.key,points,width,color:e.fill,opacity:(e.opacity??1)*(e.fillOpacity??1),gradient:e.gradient};
}

function compatible(a,b){
 if(label(a.e)&&label(b.e)&&label(a.e)!==label(b.e))return false;
 if(Math.abs(a.width-b.width)>Math.max(.35,Math.min(a.width,b.width)*.2)||Math.abs(a.opacity-b.opacity)>.02)return false;
 const x=rgb(a.color),y=rgb(b.color);
 if(!x||!y||Math.hypot(...x.map((v,i)=>v-y[i]))>18)return false;
 if(JSON.stringify(a.gradient||null)!==JSON.stringify(b.gradient||null))return false;
 // Alpha overlap at a filled-shape joint would darken the seam. Keep it independent.
 if(a.opacity<.98||b.opacity<.98||a.gradient||b.gradient)return false;
 return true;
}

export function registerNativePolylines(elements){
 const out=elements.map(e=>({...e}));
 const segments=out.filter(e=>!e.objectIdentity?.component).map(e=>{const s=nativeSegment(e);return s?{...s,e}:null;}).filter(Boolean);
 const candidates=[];
 for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++){
  const a=segments[i],b=segments[j];if(!compatible(a,b))continue;
  for(let u=0;u<2;u++)for(let v=0;v<2;v++){
   const gap=distance(a.points[u],b.points[v]),tolerance=Math.min(3,Math.max(1.25,Math.min(a.width,b.width)*.55));
   if(gap>tolerance||endpointMarker(a.e,u)&&endpointMarker(a.e,u)!=='none'||endpointMarker(b.e,v)&&endpointMarker(b.e,v)!=='none')continue;
   const va=a.points[1-u].map((x,k)=>x-a.points[u][k]),vb=b.points[1-v].map((x,k)=>x-b.points[v][k]);
   const cosine=(va[0]*vb[0]+va[1]*vb[1])/Math.hypot(...va)/Math.hypot(...vb);
   if(cosine>.94)continue; // Co-directed overlapping copies are not a join.
   // A T junction is ambiguous: never infer one polyline through an unrelated branch.
   const at=center(a.points[u],b.points[v]);
   const branch=segments.some(c=>c!==a&&c!==b&&(()=>{
    const [p,q]=c.points,dx=q[0]-p[0],dy=q[1]-p[1],t=((at[0]-p[0])*dx+(at[1]-p[1])*dy)/(dx*dx+dy*dy);
    return t>0&&t<1&&distance(at,[p[0]+t*dx,p[1]+t*dy])<=tolerance;
   })());
   if(!branch)candidates.push({a:a.key,b:b.key,u,v});
  }
 }
 const count=new Map();for(const j of candidates)for(const [k,end]of [[j.a,j.u],[j.b,j.v]])count.set(k+':'+end,(count.get(k+':'+end)||0)+1);
 const joins=candidates.filter(j=>count.get(j.a+':'+j.u)===1&&count.get(j.b+':'+j.v)===1),visited=new Set();
 for(const s of segments){
  if(visited.has(s.key))continue;
  const keys=new Set([s.key]),work=[s.key];
  while(work.length){const key=work.pop();for(const j of joins)if(j.a===key||j.b===key){const other=j.a===key?j.b:j.a;if(!keys.has(other)){keys.add(other);work.push(other);}}}
  for(const key of keys)visited.add(key);if(keys.size<2)continue;
  const sorted=[...keys].sort(),anchor=sorted[0],id='lc-native-polyline-'+anchor;
  const topology=joins.filter(j=>keys.has(j.a)&&keys.has(j.b));
  for(const e of out.filter(e=>keys.has(e.key))){const segment=nativeSegment(e);
   e.objectIdentity={...e.objectIdentity,component:{id,kind:'native-polyline',anchor,joints:topology,
    reference:{x:e.x,y:e.y,w:e.w,h:e.h},referenceAnchor:{x:s.e.x,y:s.e.y,w:s.e.w,h:s.e.h},referenceEndpoints:segment.points}};
  }
 }
 return out;
}

function jointPoint(a,u,b,v){
 const p=a.points[u],q=b.points[v],da=a.points[1-u].map((x,i)=>x-p[i]),db=b.points[1-v].map((x,i)=>x-q[i]);
 const cross=da[0]*db[1]-da[1]*db[0];
 if(Math.abs(cross)>1e-7){const t=((q[0]-p[0])*db[1]-(q[1]-p[1])*db[0])/cross,r=p.map((x,i)=>x+t*da[i]);
  if(distance(p,r)<=4&&distance(q,r)<=4)return r;
 }
 return center(p,q);
}

export function connectNativePolylines(elements,{targetKeys=null}={}){
 const out=elements.map(e=>({...e})),byKey=new Map(out.map(e=>[e.key,e])),targets=targetKeys?new Set(targetKeys):null;
 const groups=new Map(),changes=[],issues=[];
 for(const e of out){const c=e.objectIdentity?.component;if(c?.kind==='native-polyline')groups.set(c.id,c);}
 for(const [id,c]of groups){
  const updates=new Map();
  for(const j of c.joints||[]){
   if(targets&&(!targets.has(j.a)||!targets.has(j.b)))continue;
   const a=nativeSegment(byKey.get(j.a)),b=nativeSegment(byKey.get(j.b));
   if(!a||!b||!compatible({...a,e:byKey.get(j.a)},{...b,e:byKey.get(j.b)})||distance(a.points[j.u],b.points[j.v])>6){issues.push({component:id,reason:'joint-outside-local-range-or-style',keys:[j.a,j.b]});continue;}
   const point=jointPoint(a,j.u,b,j.v);
   for(const [s,end]of [[a,j.u],[b,j.v]]){
    if(!updates.has(s.key))updates.set(s.key,{...s,points:s.points.map(p=>[...p]),joined:new Set()});
    const update=updates.get(s.key);update.points[end]=point;update.joined.add(end);
   }
  }
  for(const [key,s]of updates){
   const e=byKey.get(key),before=JSON.stringify(e);let points=s.points;
   if(e.type==='line'){
    const [p,q]=points;Object.assign(e,{x:Math.min(p[0],q[0]),y:Math.min(p[1],q[1]),w:Math.abs(q[0]-p[0]),h:Math.abs(q[1]-p[1]),flipH:p[0]>q[0],flipV:p[1]>q[1]});
    if(e.start||e.end){e.start={x:p[0],y:p[1]};e.end={x:q[0],y:q[1]};}
   }else{
    // Logical geometry shares endpoints. Seam overlap is applied only by the exporters.
    const [p,q]=points,length=distance(p,q),d=q.map((v,i)=>(v-p[i])/length),normal=[-d[1],d[0]];
    const [a,b]=points;const n=normal,logical=[a.map((v,i)=>v+n[i]*s.width/2),b.map((v,i)=>v+n[i]*s.width/2),b.map((v,i)=>v-n[i]*s.width/2),a.map((v,i)=>v-n[i]*s.width/2)];
    const lx=Math.min(...logical.map(p=>p[0])),ly=Math.min(...logical.map(p=>p[1])),lw=Math.max(...logical.map(p=>p[0]))-lx,lh=Math.max(...logical.map(p=>p[1]))-ly;
    Object.assign(e,{x:lx,y:ly,w:lw,h:lh,shape:'freeform',customGeometry:{points:logical.map(p=>[(p[0]-lx)/lw,(p[1]-ly)/lh]),closed:true},flipH:false,flipV:false});
    delete e.shapeGeometry;delete e.adjustments;
   }
   if(before!==JSON.stringify(e))changes.push({key,component:id,method:'shared-native-joint'});
  }
 }
 return {elements:out,changes,issues};
}

export function joinedSegmentForExport(e,{elements}={}){
 const c=e.objectIdentity?.component;if(c?.kind!=='native-polyline')return e;
 const s=nativeSegment(e);if(!s||s.opacity<.98||s.gradient)return e;
 const joined=new Set((c.joints||[]).filter(j=>{
  if(!elements)return true;
  const other=elements.find(n=>n.key===(j.a===e.key?j.b:j.a)),peer=nativeSegment(other);
  const ownEnd=j.a===e.key?j.u:j.v,peerEnd=j.a===e.key?j.v:j.u;
  return peer&&compatible({...s,e},{...peer,e:other})&&distance(s.points[ownEnd],peer.points[peerEnd])<.05;
 }).flatMap(j=>j.a===e.key?[j.u]:j.b===e.key?[j.v]:[]));
 if(!joined.size)return e;
 const [p,q]=s.points,len=distance(p,q),d=q.map((v,i)=>(v-p[i])/len),n=[-d[1],d[0]],ext=s.width*.5+.15;
 const a=p.map((v,i)=>v-(joined.has(0)?ext:0)*d[i]),b=q.map((v,i)=>v+(joined.has(1)?ext:0)*d[i]);
 if(e.type==='line')return {...e,x:Math.min(a[0],b[0]),y:Math.min(a[1],b[1]),w:Math.abs(b[0]-a[0]),h:Math.abs(b[1]-a[1]),flipH:a[0]>b[0],flipV:a[1]>b[1],
   ...(e.start||e.end?{start:{x:a[0],y:a[1]},end:{x:b[0],y:b[1]}}:{})};
 const points=[a.map((v,i)=>v+n[i]*s.width/2),b.map((v,i)=>v+n[i]*s.width/2),b.map((v,i)=>v-n[i]*s.width/2),a.map((v,i)=>v-n[i]*s.width/2)];
 const x=Math.min(...points.map(p=>p[0])),y=Math.min(...points.map(p=>p[1])),w=Math.max(...points.map(p=>p[0]))-x,h=Math.max(...points.map(p=>p[1]))-y;
 return {...e,x,y,w,h,shape:'freeform',customGeometry:{points:points.map(p=>[(p[0]-x)/w,(p[1]-y)/h]),closed:true},shapeGeometry:undefined,adjustments:undefined,flipH:false,flipV:false};
}
