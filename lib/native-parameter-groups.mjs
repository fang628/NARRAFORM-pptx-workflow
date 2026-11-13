import {parameterBlocked} from './parameter-group-policy.mjs';
import {parameterConfidence,independentSources,weightedMedian,inheritedParameter} from './parameter-confidence.mjs';
// Each parameter has its own equivalence class. Instances/positions are never merged.
export const nativeGroupParameters=['width','height','shape','slant','corners','stroke','fill','strokeWidth','strokeColor','gradientAngle','gradientCenter','gradientStops'];
const names=nativeGroupParameters;
export const parameterGroupingRule='平行四边形、梯形和直线等对象只对有依据的相近斜度归组，parameterGroups:{slant:"组名"}；相反方向、明显不同斜度分别保留，不归并宽高、坐标、间距、字号或圆角。已有填充/描边颜色组可用fill、stroke、strokeWidth、strokeColor、gradientAngle、gradientCenter、gradientStops独立登记；强调状态和叠层保留。keepParameters:[参数名]保留有意差异。斜度必须经S3参考边界验证。';
const rgb=c=>/^[\da-f]{6}$/i.test(String(c||'').replace('#',''))?String(c).replace('#','').match(/../g).map(v=>parseInt(v,16)):null;
const family=e=>e.customGeometry?'custom':e.shape==='rect'||e.type==='rect'?'rect':e.shape||e.type;
const role=e=>String(e.frameKind||e.role||'block').replace(/[-_]?\d+$/,'');
const phase=e=>e.progressState||e.visualState||e.state||e.emphasis||'normal';
const near=(a,b,t)=>Math.abs(a-b)<=t;
const recognition=(e,param)=>{
 const evidence=e.recognitionEvidence;
 return evidence?.byParameter?evidence.byParameter[param]:evidence?.parameters?.includes(param)?evidence:undefined;
};
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
 if(param==='shape')return explicit&&phase(a)===phase(b);
 if(family(a)!==family(b)||phase(a)!==phase(b))return false;
 if(!explicit&&(role(a)!==role(b)||Math.max(a.w/b.w,b.w/a.w,a.h/b.h,b.h/a.h)>2.5))return false;
 const recognized=sameRecognition(a,b,param),scale=recognized?2.5:explicit?1.5:1;
 if(param==='width'||param==='height')return explicit&&near(a[param==='width'?'w':'h'],b[param==='width'?'w':'h'],Math.max(2,a[param==='width'?'w':'h']*.04));
 if(param==='slant')return slope(a)!=null&&slope(b)!=null&&near(slope(a),slope(b),.045*scale);
 if(param==='corners'){
  const ca=a.shapeGeometry?.corners,cb=b.shapeGeometry?.corners;
  if(!ca&&!cb)return ['cornerRadius','cutCorner'].some(k=>a.shapeGeometry?.[k]!=null)&&['cornerRadius','cutCorner'].every(k=>near(a.shapeGeometry?.[k]??0,b.shapeGeometry?.[k]??0,.018*scale));
  return ca?.length&&ca.length===cb?.length&&ca.every((c,i)=>c.type===cb[i].type&&near(c.radius??c.distance??0,cb[i].radius??cb[i].distance??0,.018*scale));
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
const paintGroupParameters=new Set(['fill','gradientAngle','gradientCenter','gradientStops']);
const geometryParameters=new Set(['width','height','shape','slant','corners']);
// Production S6 integration (Codex):
//   normalizeNativeParameters(elements,{paintLocked:true,explicitOnly:true,measuredGeometryLocked:true})
// or equivalently
//   allowedParameters:['fill','stroke','strokeWidth','strokeColor','gradientAngle','gradientCenter','gradientStops']
// measuredGeometryLocked keeps S3's measured joint slant/size/corners untouched: only color/stroke
// parameters may group. allowedParameters is an exact whitelist of parameters.
export function normalizeNativeParameters(elements,{targetKeys,paintLocked=false,explicitOnly=false,allowedParameters=null,measuredGeometryLocked=false}={}){
 // paintLocked: S4/S5 measured fill/gradient owns the fill; parameter groups must never
 // copy a group representative's fill onto other blocks (this caused wrong table bands).
 const targets=targetKeys?new Set(targetKeys):null;let out=elements.map(e=>structuredClone(e));const changes=[],decisions=[];
 const allowed=Array.isArray(allowedParameters)?new Set(allowedParameters.filter(name=>names.includes(name))):null;
 const groupParameters=names.filter(name=>(!allowed||allowed.has(name))
   &&(!measuredGeometryLocked||!geometryParameters.has(name)));
 if(allowed&&!groupParameters.length)return {elements:out,changes,decisions};
 for(const e of out){
  if(!groupParameters.includes('corners')||e.managed||targets&&!targets.has(e.key)||!e.shapeGeometry||e.customGeometry||e.keepParameters?.includes('corners'))continue;
  const g=e.shapeGeometry,short=Math.min(e.w,e.h),tiny=value=>value<=2||value<short*.015&&value<=4;let changed=false;
  if(g.corners)g.corners=g.corners.map(c=>{const size=(c.radius??c.distance??0)*short;if(c.type!=='sharp'&&tiny(size)){changed=true;return {type:'sharp'};}return c;});
  for(const k of ['cornerRadius','cutCorner'])if(g[k]&&tiny(g[k]*short)){delete g[k];changed=true;}
  if(changed)decisions.push({parameter:'corners',keys:[e.key],reason:'sub-visible-corner-noise',accepted:true});
 }
 for(const param of groupParameters){
  if(paintLocked&&paintGroupParameters.has(param))continue;
  const candidates=out.filter(e=>!e.managed&&e.role!=='effect'&&!e.effectOf&&['rect','shape','ellipse'].includes(e.type)&&!parameterBlocked(e,param)).sort((a,b)=>parameterConfidence(b,param)-parameterConfidence(a,param));const used=new Set();
  for(const anchor of candidates){
   if(used.has(anchor.key))continue;const label=anchor.parameterGroups?.[param];
   if(explicitOnly&&!label)continue;
   // Complete-link agreement prevents a chain of near neighbours drifting far.
   const members=[anchor];for(const e of candidates){if(e===anchor||used.has(e.key))continue;
    if(explicitOnly){const contains=(a,b)=>a.x<=b.x&&a.y<=b.y&&a.x+a.w>=b.x+b.w&&a.y+a.h>=b.y+b.h;
     if(members.some(a=>contains(a,e)||contains(e,a)))continue;}
    const explicit=!!label&&e.parameterGroups?.[param]===label;
    if(label&&!explicit||!label&&e.parameterGroups?.[param])continue;
    const reliablePeers=explicit?candidates.filter(peer=>peer.parameterGroups?.[param]===label&&parameterConfidence(peer,param)>=.55&&family(peer)===family(anchor)&&phase(peer)===phase(anchor)):[];
    const conflicting=reliablePeers.some((peer,i)=>reliablePeers.slice(i+1).some(other=>!close(peer,other,param,true)));
    if(conflicting&&parameterConfidence(e,param)<.55)continue;
    const envelope=!['gradientAngle','gradientCenter','gradientStops'].includes(param)||e.gradient?.stops?.length>=2&&e.gradient.type===anchor.gradient?.type;
    const weak=explicit&&!conflicting&&envelope&&parameterConfidence(e,param)<.55&&parameterConfidence(anchor,param)>=.55&&family(e)===family(anchor)&&phase(e)===phase(anchor);
    if(weak||members.filter(a=>parameterConfidence(a,param)>=.55).every(a=>close(a,e,param,explicit))&&members.every(a=>close(a,e,param,explicit)))members.push(e);
   }
   if(members.length<2){if(label&&candidates.some(e=>e!==anchor&&e.parameterGroups?.[param]===label))decisions.push({parameter:param,keys:candidates.filter(e=>e.parameterGroups?.[param]===label).map(e=>e.key),accepted:false,reason:'parameter-distance-or-family-state-disagreement'});continue;}for(const e of members)used.add(e.key);
   const sources=independentSources(members,param).map(e=>structuredClone(e));
   if(!sources.length){decisions.push({parameter:param,keys:members.map(e=>e.key),accepted:false,reason:'no-independent-reliable-source'});continue;}
   const estimate=get=>weightedMedian(sources.map(e=>({value:get(e),weight:parameterConfidence(e,param)})));
   if(param==='slant'&&members.some(e=>{const depth=Math.abs(estimate(slope))*e.h/e.w;return depth<.005||depth>.49;})){decisions.push({parameter:param,keys:members.map(e=>e.key),accepted:false,reason:'shared-slant-outside-native-parameter-range'});continue;}
   const paintMembers=['fill','gradientStops'].includes(param)?colourSamples:param==='strokeColor'||param==='stroke'?e=>colourSamples({...e,fill:e.color,gradient:e.strokeGradient}):null;
   const representative=paintMembers?[...sources].sort((a,b)=>{
    const cost=source=>sources.reduce((sum,other)=>{const x=paintMembers(source),y=paintMembers(other);return sum+(x&&y?x.reduce((s,c,i)=>s+(c&&y[i]?Math.hypot(...c.map((v,j)=>v-y[i][j])):0),0):0)*parameterConfidence(other,param);},0);
    return cost(a)-cost(b)||parameterConfidence(b,param)-parameterConfidence(a,param);
   })[0]:sources[0];
   for(const e of members){
    if(targets&&!targets.has(e.key))continue;
    const before=JSON.stringify(e);
    if(param==='shape'){
     e.shape=representative.shape;
     if(representative.customGeometry)e.customGeometry=structuredClone(representative.customGeometry);else delete e.customGeometry;
     if(representative.shapeGeometry)e.shapeGeometry=structuredClone(representative.shapeGeometry);else delete e.shapeGeometry;
    }
    if(param==='slant'){const s=estimate(slope);e.shapeGeometry={...e.shapeGeometry,headDepth:Math.abs(s)*e.h/e.w,...(e.shape==='parallelogram'?{slantSign:s<0?-1:1}:{})};delete e.shapeGeometry.slantAngle;}
    if(param==='width'||param==='height'){
     const oldSlope=slope(e),axis=param==='width'?'w':'h',value=estimate(m=>m[axis]),w=axis==='w'?value:e.w,h=axis==='h'?value:e.h,depth=oldSlope===null?null:Math.abs(oldSlope)*h/w;
     if(depth!==null&&(depth<.005||depth>.49))continue;e[axis]=value;if(depth!==null){e.shapeGeometry={...e.shapeGeometry,headDepth:depth};delete e.shapeGeometry.slantAngle;}
    }
    if(param==='corners'){if(representative.shapeGeometry?.corners)e.shapeGeometry={...e.shapeGeometry,corners:representative.shapeGeometry.corners.map((c,i)=>({...c,...(c.type==='round'?{radius:estimate(m=>m.shapeGeometry.corners[i].radius)}:c.type==='cut'?{distance:estimate(m=>m.shapeGeometry.corners[i].distance)}:{})}))};else for(const k of ['cornerRadius','cutCorner'])if(representative.shapeGeometry?.[k]!=null)e.shapeGeometry={...e.shapeGeometry,[k]:estimate(m=>m.shapeGeometry?.[k])};}
    if(param==='stroke'){e.strokeWidth=estimate(m=>m.strokeWidth);e.color=representative.color;}
    if(param==='fill'){e.fill=representative.fill;if(representative.gradient)e.gradient=structuredClone(representative.gradient);else delete e.gradient;}
    if(param==='strokeWidth')e.strokeWidth=estimate(m=>m.strokeWidth);
    if(param==='strokeColor')e.color=representative.color;
    if(param==='gradientAngle'){const origin=representative.gradient.angle,angle=estimate(m=>origin+((m.gradient.angle-origin+540)%360-180));e.gradient={...e.gradient,angle:(angle+360)%360};}
    if(param==='gradientCenter')e.gradient={...e.gradient,center:{x:estimate(m=>m.gradient.center.x),y:estimate(m=>m.gradient.center.y)}};
    if(param==='gradientStops')e.gradient={...e.gradient,stops:structuredClone(representative.gradient.stops)};
    if(before!==JSON.stringify(e))Object.assign(e,inheritedParameter(e,param,sources,parameterConfidence(representative,param)));
   }
   decisions.push({parameter:param,keys:members.map(e=>e.key),source:representative.key,accepted:true,reason:label?'model-group-and-parameter-agreement':'same-role-family-and-parameter-agreement',preserved:['x','y',...['w','h'].filter(k=>k!==(param==='width'?'w':param==='height'?'h':null))]});
  }
 }
 for(let i=0;i<out.length;i++)if(JSON.stringify(out[i])!==JSON.stringify(elements[i]))changes.push({key:out[i].key,before:elements[i],after:out[i],reason:'按参数归并或去除微小角部噪声'});
 return {elements:out,changes,decisions};
}
