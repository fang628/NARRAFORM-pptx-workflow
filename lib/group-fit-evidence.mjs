const rgb=c=>typeof c==='string'&&/^[\da-f]{6}$/i.test(c)?[0,2,4].map(i=>parseInt(c.slice(i,i+2),16)):null;
const distance=(a,b)=>a&&b?Math.hypot(...a.map((v,i)=>v-b[i])):0;
const slope=e=>{const g=e?.shapeGeometry;if(!g||!e.w||!e.h)return null;return (g.slantAngle!=null?1/Math.tan(g.slantAngle*Math.PI/180):g.headDepth!=null?g.headDepth*e.w/e.h:null)*(g.slantSign??1);};
const sampled=g=>g?.stops?[0,.25,.5,.75,1].map(t=>{let i=g.stops.findIndex(s=>s.position>=t);if(i<0)i=g.stops.length-1;const a=g.stops[Math.max(0,i-1)],b=g.stops[i],f=Math.max(0,Math.min(1,(t-a.position)/(b.position-a.position||1))),x=rgb(a.color),y=rgb(b.color);return x&&y?x.map((v,j)=>v+(y[j]-v)*f):null;}):null;
const alpha=e=>[e.fillOpacity??1,...(e.gradient?.stops||[]).map(s=>s.opacity??1)];
const angleDelta=(a,b)=>{const d=Math.abs((a??0)-(b??0))%360;return Math.min(d,360-d);};
const stopColours=e=>e.strokeGradient?.stops?.map(stop=>stop.color)||e.color;
const paintMeasurement=p=>p?.measurements?.fill||(p?.measurements?.solidFill?{...p.measurements.solidFill,accepted:p.measurements.solidFill.confidence>=.9&&p.measurements.solidFill.samples>=80}:null);
export function changedSharedParameters(a,b){
 if(!a||!b)return [];
 const values=e=>({width:e.w,height:e.h,slant:[e.shape,e.shapeGeometry?.headDepth,e.shapeGeometry?.slantAngle,e.shapeGeometry?.slantSign,e.customGeometry],corners:[e.shapeGeometry?.corners,e.shapeGeometry?.cornerRadius,e.shapeGeometry?.cutCorner,e.customGeometry],fill:[e.fill,e.gradient,e.fillOpacity],stroke:[e.color,e.strokeWidth,e.strokeGradient,e.colorOpacity],strokeWidth:e.strokeWidth,strokeColor:stopColours(e),gradientAngle:[e.gradient?.type,e.gradient?.angle],gradientCenter:[e.gradient?.type,e.gradient?.center],gradientStops:e.gradient?.stops});
 const x=values(a),y=values(b);return Object.keys(a.parameterGroups||{}).filter(p=>p in x&&JSON.stringify(x[p])!==JSON.stringify(y[p]));
}
export function groupFitContradictions(before,after,report){
 const originals=new Map(before.map(e=>[e.key,e])),next=new Map(after.map(e=>[e.key,e])),evidence=[];
 const reject=(key,parameter,confidence,reason,measuredValue)=>{const e=next.get(key);if(e?.parameterGroups?.[parameter])evidence.push({key,parameter,contradicts:true,confidence,reason,measuredValue});};
 for(const p of report.proposals||[]){
  const a=originals.get(p.key),b=next.get(p.key);if(!a||!b||!(p.visibleCoverage>=.9&&p.samples>=40&&p.beforeError-p.afterError>=.25))continue;
  const sa=slope(a),sb=slope(b);
  if(sa!=null&&sb!=null&&Math.abs(sa-sb)>.08)reject(b.key,'slant',.92,`独立参考长边拟合反对共享斜度：${sa.toFixed(3)}→${sb.toFixed(3)}，可见支持${p.visibleCoverage}`,sb);
  if(a.shape!==b.shape||a.type!==b.type){for(const parameter of ['slant','corners'])reject(b.key,parameter,.92,'独立完整轮廓支持的基础几何与识别分组不同',b.shape||b.type);}
  const ca=a.shapeGeometry?.corners,cb=b.shapeGeometry?.corners;
  if(ca?.length===cb?.length&&ca?.some((c,i)=>Math.abs((c.radius??c.distance??0)-(cb[i].radius??cb[i].distance??0))>.05||c.type!==cb[i].type&&Math.max(c.radius??c.distance??0,cb[i].radius??cb[i].distance??0)>.05))reject(b.key,'corners',.92,'独立长边与角部轮廓支持明显不同的圆角或切角参数',cb);
  for(const [parameter,field]of [['width','w'],['height','h']])if(Math.abs(a[field]-b[field])>Math.max(8,a[field]*.1))reject(b.key,parameter,.92,'可见边界拟合得到的尺寸明显偏离此前共享尺寸',b[field]);
 }
 for(const p of report.paintProposals||[]){
  const a=originals.get(p.key),b=next.get(p.key),m=paintMeasurement(p);if(!a||!b)continue;
  if(m?.accepted&&m.scope!=='group-base-fill'&&!m.referenceSource&&(m.confidence>=.85||m.r2>=.96&&m.afterError<=7)&&m.beforeError-m.afterError>=6){
   const x=sampled(a.gradient)||Array(5).fill(rgb(a.fill)),y=sampled(b.gradient)||Array(5).fill(rgb(b.fill));
   const colorDelta=x.reduce((sum,c,i)=>sum+distance(c,y[i]),0)/5;
   const angle=Math.abs((a.gradient?.angle??0)-(b.gradient?.angle??0))%360;
   const angleDelta=Math.min(angle,360-angle),typeChanged=(a.gradient?.type||'solid')!==(b.gradient?.type||'solid');
   const centerDelta=Math.hypot((a.gradient?.center?.x??.5)-(b.gradient?.center?.x??.5),(a.gradient?.center?.y??.5)-(b.gradient?.center?.y??.5));
   const aa=alpha(a),ab=alpha(b),opacityChanged=aa.length===ab.length&&aa.some((v,i)=>Math.abs(v-ab[i])>.08);
   if(colorDelta>24||typeChanged||angleDelta>12||centerDelta>.12||opacityChanged){reject(b.key,'fill',.92,`独立留出样本拟合反对共享填充：颜色差${colorDelta.toFixed(1)}，中心差${centerDelta.toFixed(2)}，误差改善${(m.beforeError-m.afterError).toFixed(1)}`,b.gradient||b.fill);}
   if(colorDelta>24)reject(b.key,'gradientStops',.92,'独立颜色采样支持不同色标，保留斜度等其他共享参数',b.gradient?.stops);
   if(typeChanged||angleDelta>12)reject(b.key,'gradientAngle',.92,'独立像素拟合显示渐变类型或方向与组内假设不同',b.gradient?.angle);
   if(typeChanged||centerDelta>.12)reject(b.key,'gradientCenter',.92,'独立像素拟合显示渐变中心偏离此前共享假设',b.gradient?.center);
  }
  const o=p.measurements?.outline;
  if(o?.confidence>=.95&&o.samples>=24){
   if(o.presence==='absent'||Math.abs((a.strokeWidth||0)-o.width)>Math.max(1.25,(a.strokeWidth||0)*.6))for(const parameter of ['stroke','strokeWidth'])reject(b.key,parameter,.95,'实际边界横截面显示描边有无或宽度与共享结论不同',o.width);
   if(o.color&&distance(rgb(a.color),rgb(o.color))>25)for(const parameter of ['stroke','strokeColor'])reject(b.key,parameter,.95,'独立边界色脊测量显示描边颜色与共享结论不同',o.color);
  }
 }
 // A common correction is not evidence against sharing: all members may have
 // started from the same wrong estimate and independently converge together.
 // Only strong independent observations can establish this exemption.
 const independentlyFitted=(e,param)=>{
  if(['slant','corners','width','height'].includes(param))return (report.proposals||[]).some(p=>p.key===e.key&&p.visibleCoverage>=.9&&p.samples>=40);
  const p=(report.paintProposals||[]).find(p=>p.key===e.key),m=paintMeasurement(p);
  if(param.startsWith('stroke'))return p?.measurements?.outline?.confidence>=.95&&p.measurements.outline.samples>=24;
  return m?.accepted&&m.scope!=='group-base-fill'&&!m.referenceSource&&(m.confidence>=.85||m.r2>=.96&&m.afterError<=7);
 };
 const agree=(a,b,param)=>{
  if(param==='slant')return slope(a)!=null&&slope(b)!=null&&Math.abs(slope(a)-slope(b))<=.045;
  if(param==='corners')return JSON.stringify(a.shapeGeometry?.corners)===JSON.stringify(b.shapeGeometry?.corners)&&JSON.stringify(a.customGeometry)===JSON.stringify(b.customGeometry);
  if(param==='width'||param==='height')return Math.abs(a[param==='width'?'w':'h']-b[param==='width'?'w':'h'])<=4;
  if(param==='strokeWidth')return Math.abs((a.strokeWidth||0)-(b.strokeWidth||0))<=.5;
  if(param==='strokeColor'){
   const x=a.strokeGradient?.stops?.map(stop=>rgb(stop.color))||[rgb(a.color)],y=b.strokeGradient?.stops?.map(stop=>rgb(stop.color))||[rgb(b.color)];
   return x.length===y.length&&x.every((color,i)=>color&&y[i]&&distance(color,y[i])<12);
  }
  if(param.startsWith('stroke'))return distance(rgb(a.color),rgb(b.color))<12&&Math.abs((a.strokeWidth||0)-(b.strokeWidth||0))<=.5&&JSON.stringify(a.strokeGradient)===JSON.stringify(b.strokeGradient);
  if((a.gradient?.type||'solid')!==(b.gradient?.type||'solid'))return false;
  if(param==='gradientAngle')return a.gradient?.type==='linear'&&angleDelta(a.gradient.angle,b.gradient.angle)<=5;
  if(param==='gradientCenter')return a.gradient?.center&&b.gradient?.center&&Math.hypot(a.gradient.center.x-b.gradient.center.x,a.gradient.center.y-b.gradient.center.y)<=.05;
  if(param==='gradientStops'){
   const x=sampled(a.gradient),y=sampled(b.gradient);
   return x&&y&&x.every(Boolean)&&y.every(Boolean)&&x.reduce((sum,color,i)=>sum+distance(color,y[i]),0)/x.length<12;
  }
  const aa=alpha(a),ab=alpha(b);if(aa.length!==ab.length||aa.some((v,i)=>Math.abs(v-ab[i])>.02))return false;
  const x=sampled(a.gradient)||Array(5).fill(rgb(a.fill)),y=sampled(b.gradient)||Array(5).fill(rgb(b.fill));
  const angle=Math.abs((a.gradient?.angle??0)-(b.gradient?.angle??0))%360;
  return x.every(Boolean)&&y.every(Boolean)&&x.reduce((s,c,i)=>s+distance(c,y[i]),0)/5<12&&Math.min(angle,360-angle)<=5&&Math.hypot((a.gradient?.center?.x??.5)-(b.gradient?.center?.x??.5),(a.gradient?.center?.y??.5)-(b.gradient?.center?.y??.5))<=.05;
 };
 return evidence.filter(item=>{const e=next.get(item.key),id=e.parameterGroups[item.parameter],peers=after.filter(p=>p.key!==e.key&&p.parameterGroups?.[item.parameter]===id);return !peers.length||!independentlyFitted(e,item.parameter)||!peers.every(p=>independentlyFitted(p,item.parameter)&&agree(e,p,item.parameter));});
}
