// Each parameter has its own equivalence class. Instances/positions are never merged.
export const nativeGroupParameters=['width','height','slant','corners','stroke','fill','strokeWidth','strokeColor','gradientAngle','gradientCenter','gradientStops'];
const names=nativeGroupParameters;
export const parameterGroupingRule='相似框与色块按参数分别归组，可给对象parameterGroups:{slant:"组名",corners:"组名",strokeWidth:"组名",strokeColor:"组名",gradientAngle:"组名",gradientCenter:"组名",gradientStops:"组名",fill:"组名",width:"组名",height:"组名"}；宽度、斜度、描边粗细、描边颜色、渐变方向/中心/色标可独立共享，不整套覆盖。长度、位置、强调状态和叠层默认独立；keepParameters:[参数名]保留有意差异。微小断口、线宽波动与过小圆角/切角作为生图噪声忽略。';
const rgb=c=>/^[\da-f]{6}$/i.test(String(c||'').replace('#',''))?String(c).replace('#','').match(/../g).map(v=>parseInt(v,16)):null;
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const family=e=>e.customGeometry?'custom':e.shape==='rect'||e.type==='rect'?'rect':e.shape||e.type;
const role=e=>String(e.frameKind||e.role||'block').replace(/[-_]?\d+$/,'');
const phase=e=>e.progressState||e.visualState||e.state||e.emphasis||'normal';
const near=(a,b,t)=>Math.abs(a-b)<=t;
const rejected=(e,param)=>e.recognitionRejections?.some(r=>r.parameter===param||param.startsWith('gradient')&&r.parameter==='fill'||param.startsWith('stroke')&&r.parameter==='stroke'||param==='fill'&&String(r.parameter).startsWith('gradient')||param==='stroke'&&String(r.parameter).startsWith('stroke'));
const recognition=(e,param)=>e.recognitionEvidence?.byParameter?.[param]||e.recognitionEvidence;
const sameRecognition=(a,b,param)=>{const x=recognition(a,param),y=recognition(b,param),id=a.parameterGroups?.[param];return id&&b.parameterGroups?.[param]===id&&x?.id===id&&y?.id===id&&Math.min(x.confidence||0,y.confidence||0)>=.8;};
const slope=e=>{
 if(!['parallelogram','trapezoid'].includes(e.shape)||!e.shapeGeometry)return null;const g=e.shapeGeometry;
 const depth=g.slantAngle!=null?Math.min(.49,e.h/Math.tan(g.slantAngle*Math.PI/180)/e.w):g.headDepth;
 return depth==null?null:depth*e.w/e.h*(e.shape==='parallelogram'?g.slantSign??1:1);
};
function colourSamples(e){
 const g=e.gradient;if(!g)return rgb(e.fill)?Array.from({length:5},()=>rgb(e.fill)):null;
 return [0,.25,.5,.75,1].map(t=>{let i=g.stops.findIndex(s=>s.position>=t);if(i<0)i=g.stops.length-1;const lo=g.stops[Math.max(0,i-1)],hi=g.stops[i],f=Math.max(0,Math.min(1,(t-lo.position)/(hi.position-lo.position||1))),a=rgb(lo.color),b=rgb(hi.color);return a&&b?a.map((v,j)=>v+(b[j]-v)*f):null;});
}
function alphaSamples(e){const stops=e.gradient?.stops;if(!stops)return [1,1,1,1,1];return [0,.25,.5,.75,1].map(t=>{let i=stops.findIndex(s=>s.position>=t);if(i<0)i=stops.length-1;const lo=stops[Math.max(0,i-1)],hi=stops[i],f=Math.max(0,Math.min(1,(t-lo.position)/(hi.position-lo.position||1)));return (lo.opacity??1)+((hi.opacity??1)-(lo.opacity??1))*f;});}
function close(a,b,param,explicit){
 if(family(a)!==family(b)||phase(a)!==phase(b))return false;
 if(!explicit&&(role(a)!==role(b)||Math.max(a.w/b.w,b.w/a.w,a.h/b.h,b.h/a.h)>2.5))return false;
 const recognized=sameRecognition(a,b,param),scale=recognized?2.5:explicit?1.5:1;
 if(param==='width'||param==='height')return explicit&&near(a[param==='width'?'w':'h'],b[param==='width'?'w':'h'],Math.max(2,a[param==='width'?'w':'h']*.04));
 if(param==='slant')return slope(a)!=null&&slope(b)!=null&&near(slope(a),slope(b),.045*scale);
 if(param==='corners'){
  const ca=a.shapeGeometry?.corners,cb=b.shapeGeometry?.corners;
  if(!ca&&!cb)return ['cornerRadius','cutCorner'].some(k=>a.shapeGeometry?.[k]!=null)&&['cornerRadius','cutCorner'].every(k=>near(a.shapeGeometry?.[k]??0,b.shapeGeometry?.[k]??0,.018*scale));
  return ca?.length&&ca.length===cb?.length&&ca.every((c,i)=>(c.type===cb[i].type||recognized&&Math.max(c.radius??c.distance??0,cb[i].radius??cb[i].distance??0)<=.09)&&near(c.radius??c.distance??0,cb[i].radius??cb[i].distance??0,.018*scale));
 }
 if(param==='strokeWidth')return a.strokeWidth>0&&b.strokeWidth>0&&near(a.strokeWidth,b.strokeWidth,Math.max(.35,a.strokeWidth*.12)*scale);
 if(param==='strokeColor')return a.strokeWidth>0&&b.strokeWidth>0&&!a.strokeGradient&&!b.strokeGradient&&rgb(a.color)&&rgb(b.color)&&Math.hypot(...rgb(a.color).map((v,i)=>v-rgb(b.color)[i]))<12*scale;
 if(param==='gradientAngle'){if(a.gradient?.type!=='linear'||b.gradient?.type!=='linear')return false;const d=Math.abs(a.gradient.angle-b.gradient.angle)%360;return Math.min(d,360-d)<=4*scale;}
 if(param==='gradientCenter')return a.gradient?.center&&b.gradient?.center&&a.gradient.type===b.gradient.type&&Math.hypot(a.gradient.center.x-b.gradient.center.x,a.gradient.center.y-b.gradient.center.y)<.05*scale;
 if(param==='gradientStops'){const x=colourSamples(a),y=colourSamples(b);return a.gradient&&b.gradient&&a.gradient.type===b.gradient.type&&x&&y&&x.every(Boolean)&&y.every(Boolean)&&x.reduce((s,c,i)=>s+Math.hypot(...c.map((v,j)=>v-y[i][j])),0)/x.length<10*scale&&a.gradient.stops.every(s=>s.opacity===undefined||s.opacity>=.98)&&b.gradient.stops.every(s=>s.opacity===undefined||s.opacity>=.98);}
 if(param==='stroke')return (a.strokeWidth||0)>0&&near(a.strokeWidth||0,b.strokeWidth||0,Math.max(.4,(a.strokeWidth||1)*.15)*scale)&&JSON.stringify(a.strokeGradient||null)===JSON.stringify(b.strokeGradient||null)&&rgb(a.color)&&rgb(b.color)&&Math.hypot(...rgb(a.color).map((v,i)=>v-rgb(b.color)[i]))<14*scale;
 if(param==='fill'){
  if((a.gradient?.type||'solid')!==(b.gradient?.type||'solid')||Math.abs((a.fillOpacity??1)-(b.fillOpacity??1))>.02)return false;
  if(alphaSamples(a).some((v,i)=>Math.abs(v-alphaSamples(b)[i])>.02))return false;
  if(a.gradient?.type==='linear'){const d=Math.abs(a.gradient.angle-b.gradient.angle)%360;if(Math.min(d,360-d)>5)return false;}
  if(a.gradient?.center&&Math.hypot(a.gradient.center.x-b.gradient?.center?.x,a.gradient.center.y-b.gradient?.center?.y)>.05)return false;
  const x=colourSamples(a),y=colourSamples(b);return x&&y&&x.every(Boolean)&&y.every(Boolean)&&x.reduce((s,c,i)=>s+Math.hypot(...c.map((v,j)=>v-y[i][j])),0)/x.length<12*scale;
 }return false;
}
export function normalizeNativeParameters(elements,{targetKeys}={}){
 const targets=targetKeys?new Set(targetKeys):null;let out=elements.map(e=>structuredClone(e));const changes=[],decisions=[];
 for(const e of out){
  if(e.managed||targets&&!targets.has(e.key)||!e.shapeGeometry||e.customGeometry||e.keepParameters?.includes('corners'))continue;
  const g=e.shapeGeometry,short=Math.min(e.w,e.h),tiny=value=>value<=2||value<short*.015&&value<=4;let changed=false;
  if(g.corners)g.corners=g.corners.map(c=>{const size=(c.radius??c.distance??0)*short;if(c.type!=='sharp'&&tiny(size)){changed=true;return {type:'sharp'};}return c;});
  for(const k of ['cornerRadius','cutCorner'])if(g[k]&&tiny(g[k]*short)){delete g[k];changed=true;}
  if(changed)decisions.push({parameter:'corners',keys:[e.key],reason:'sub-visible-corner-noise',accepted:true});
 }
 for(const param of names){
  const candidates=out.filter(e=>!e.managed&&e.role!=='effect'&&!e.effectOf&&['rect','shape','ellipse'].includes(e.type)&&(!targets||targets.has(e.key))&&!rejected(e,param)&&!e.keepParameters?.includes(param)&&!(param.startsWith('stroke')&&e.keepParameters?.includes('stroke'))&&!(param.startsWith('gradient')&&e.keepParameters?.includes('fill'))&&!(param==='stroke'&&e.keepParameters?.some(k=>k.startsWith('stroke')))&&!(param==='fill'&&e.keepParameters?.some(k=>k.startsWith('gradient'))));const used=new Set();
  for(const anchor of candidates){
   if(used.has(anchor.key))continue;const label=anchor.parameterGroups?.[param];
   // Complete-link agreement prevents a chain of near neighbours drifting far.
   const members=[anchor];for(const e of candidates){if(e===anchor||used.has(e.key))continue;
    const explicit=!!label&&e.parameterGroups?.[param]===label;
    if(label&&!explicit||!label&&e.parameterGroups?.[param])continue;
    if(members.every(a=>close(a,e,param,explicit)))members.push(e);
   }
   if(members.length<2){if(label&&candidates.some(e=>e!==anchor&&e.parameterGroups?.[param]===label))decisions.push({parameter:param,keys:candidates.filter(e=>e.parameterGroups?.[param]===label).map(e=>e.key),accepted:false,reason:'parameter-distance-or-family-state-disagreement'});continue;}for(const e of members)used.add(e.key);
   if(param==='slant'&&members.some(e=>{const depth=Math.abs(median(members.map(slope)))*e.h/e.w;return depth<.005||depth>.49;})){decisions.push({parameter:param,keys:members.map(e=>e.key),accepted:false,reason:'shared-slant-outside-native-parameter-range'});continue;}
   const reliability=e=>(e.paintEvidence?.confidence||0)+(e.geometryEvidence?.visibleCoverage||0)+(e.baseGeometry?.confidence||0);
   const referenceKey=recognition(anchor,param)?.referenceKey;
   const representative=members.find(e=>e.key===referenceKey&&sameRecognition(anchor,e,param))||[...members].sort((a,b)=>reliability(b)-reliability(a))[0];
   for(const e of members){
    if(param==='slant'){const s=median(members.map(slope));e.shapeGeometry={...e.shapeGeometry,headDepth:Math.abs(s)*e.h/e.w,...(e.shape==='parallelogram'?{slantSign:s<0?-1:1}:{})};delete e.shapeGeometry.slantAngle;}
    if(param==='width'||param==='height'){
     const oldSlope=slope(e),axis=param==='width'?'w':'h',value=median(members.map(m=>m[axis])),w=axis==='w'?value:e.w,h=axis==='h'?value:e.h,depth=oldSlope===null?null:Math.abs(oldSlope)*h/w;
     if(depth!==null&&(depth<.005||depth>.49))continue;e[axis]=value;if(depth!==null){e.shapeGeometry={...e.shapeGeometry,headDepth:depth};delete e.shapeGeometry.slantAngle;}
    }
    if(param==='corners'){if(representative.shapeGeometry?.corners)e.shapeGeometry={...e.shapeGeometry,corners:structuredClone(representative.shapeGeometry.corners)};else for(const k of ['cornerRadius','cutCorner'])if(representative.shapeGeometry?.[k]!=null)e.shapeGeometry={...e.shapeGeometry,[k]:representative.shapeGeometry[k]};}
    if(param==='stroke'){e.strokeWidth=median(members.map(m=>m.strokeWidth));e.color=representative.color;}
    if(param==='fill'){e.fill=representative.fill;if(representative.gradient)e.gradient=structuredClone(representative.gradient);else delete e.gradient;}
    if(param==='strokeWidth')e.strokeWidth=median(members.map(m=>m.strokeWidth));
    if(param==='strokeColor')e.color=representative.color;
    if(param==='gradientAngle')e.gradient={...e.gradient,angle:representative.gradient.angle};
    if(param==='gradientCenter')e.gradient={...e.gradient,center:structuredClone(representative.gradient.center)};
    if(param==='gradientStops')e.gradient={...e.gradient,stops:structuredClone(representative.gradient.stops)};
   }
   decisions.push({parameter:param,keys:members.map(e=>e.key),source:representative.key,accepted:true,reason:label?'model-group-and-parameter-agreement':'same-role-family-and-parameter-agreement',preserved:['x','y',...['w','h'].filter(k=>k!==(param==='width'?'w':param==='height'?'h':null))]});
  }
 }
 for(let i=0;i<out.length;i++)if(JSON.stringify(out[i])!==JSON.stringify(elements[i]))changes.push({key:out[i].key,before:elements[i],after:out[i],reason:'按参数归并或去除微小角部噪声'});
 return {elements:out,changes,decisions};
}
