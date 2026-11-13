import {normalizeDirectionalElement} from './directional-geometry.mjs';
import {endpointSizeFactors} from './line-style.mjs';

const color=value=>String(value||'').replace('#','').toUpperCase();
const alpha=(e,stroke=false)=>(e.opacity??1)*(stroke?e.colorOpacity??1:e.fillOpacity??1);
const endpoints=e=>[[e.x+(e.flipH?e.w:0),e.y+(e.flipV?e.h:0)],
  [e.x+(e.flipH?0:e.w),e.y+(e.flipV?0:e.h)]];
const soft=e=>e.glow||e.shadow&&e.shadow.type!=='none'||e.effectOf||e.managed;

// Only an unambiguous round terminal belongs to a line. A bullet, intermediate
// node or branching junction is not consumed merely because it is nearby.
export function foldLineEndpointDots(elements,{svgGroup=false}={}){
  const lines=elements.filter(e=>e.type==='line'&&!soft(e)).map(normalizeDirectionalElement);
  const dots=elements.filter(e=>e.type==='ellipse'&&!soft(e)&&!e.tableId&&!e.nodeId&&!e.carrierTextIds?.length
    &&e.w>0&&e.h>0&&Math.abs(e.w-e.h)<=Math.max(.5,Math.min(e.w,e.h)*.08)
    &&!e.gradient&&!e.strokeGradient&&(!(e.strokeWidth>0)||e.colorOpacity===0));
  const proposals=[];
  for(const dot of dots){
    const center=[dot.x+dot.w/2,dot.y+dot.h/2],radius=(dot.w+dot.h)/4,matches=[];
    for(const line of lines){
      const sameGroup=line.representationGroup&&line.representationGroup===dot.representationGroup;
      if(!svgGroup&&!sameGroup&&line.arrowRole!=='connector'
        &&!/端点|点线|terminal|endpoint/i.test(dot.description||''))continue;
      const ends=endpoints(line),length=Math.hypot(ends[1][0]-ends[0][0],ends[1][1]-ends[0][1]);
      if(length<Math.max(8,radius*4)||radius>Math.max(12,(line.strokeWidth??1)*6))continue;
      const direction=[(ends[1][0]-ends[0][0])/length,(ends[1][1]-ends[0][1])/length];
      for(const [side,end]of ends.entries()){
        const key=side?'endArrowType':'beginArrowType';if(line[key]&&line[key]!=='none')continue;
        const dx=center[0]-end[0],dy=center[1]-end[1],along=dx*direction[0]+dy*direction[1],across=Math.abs(dx*direction[1]-dy*direction[0]);
        const gradient=line.strokeGradient||line.gradient,stop=side?gradient?.stops?.at(-1):gradient?.stops?.[0];
        if(color(dot.fill)!==color(stop?.color||line.color)||Math.abs(alpha(dot)-alpha(line,true)*(stop?.opacity??1))>.025)continue;
        if(across>Math.max(.6,radius*.12)||Math.abs(along)>radius+1)continue;
        matches.push({line,dot,side,center});
      }
    }
    if(matches.length===1)proposals.push(matches[0]);
  }
  const slots=new Map();for(const p of proposals){const key=p.line.key+':'+p.side;slots.set(key,(slots.get(key)||0)+1);}
  const replacements=new Map(),removed=new Set();
  for(const p of proposals){
    if(slots.get(p.line.key+':'+p.side)!==1)continue;
    const line=replacements.get(p.line.key)||{...p.line},ends=endpoints(line);ends[p.side]=p.center;
    const ratio=p.dot.w/Math.max(.1,line.strokeWidth??1),size=Object.keys(endpointSizeFactors).sort((a,b)=>Math.abs(Math.log(ratio/endpointSizeFactors[a]))-Math.abs(Math.log(ratio/endpointSizeFactors[b])))[0];
    const [a,b]=ends;Object.assign(line,{x:Math.min(a[0],b[0]),y:Math.min(a[1],b[1]),w:Math.abs(b[0]-a[0]),h:Math.abs(b[1]-a[1]),
      flipH:a[0]>b[0],flipV:a[1]>b[1],[p.side?'endArrowType':'beginArrowType']:'oval',
      [p.side?'endArrowSize':'beginArrowSize']:{width:size,length:size},endpointDotKeys:[...(line.endpointDotKeys||[]),p.dot.key]});
    replacements.set(line.key,line);removed.add(p.dot.key);
  }
  return elements.filter(e=>!removed.has(e.key)).map(e=>replacements.get(e.key)||e);
}
