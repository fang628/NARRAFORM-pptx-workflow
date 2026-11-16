import {detailedShapePath} from './shape-geometry.mjs';
import {transformPath} from './vector-path.mjs';

// A shared panel boundary is painted by the first panel. Keep both complete
// fill silhouettes and their curved corners; omit only the coincident straight span.
export function frameStrokePaths(elements){
  const owned=[],result=new Map();
  for(const e of elements){
    if(!['rect','shape'].includes(e.type)||!(e.strokeWidth>0)||(e.colorOpacity??1)<=0||(e.opacity??1)<=0||e.rotate||e.flipH||e.flipV||e.customGeometry
      ||!['rect','roundRect'].includes(e.shape||e.type)||e.tableId)continue;
    const path=detailedShapePath(e);if(!path)continue;
    const stroke=[];let current,start,changed=false;
    for(const c of path){
      if(c.op==='M'){current=c.points[0];start=current;stroke.push(c);continue;}
      const end=c.op==='Z'?start:c.points.at(-1);
      if(c.op!=='L'&&c.op!=='Z'){stroke.push(c);current=end;continue;}
      const dx=end[0]-current[0],dy=end[1]-current[1],length=Math.hypot(dx,dy);
      if(length<1e-8){current=end;continue;}
      const a=[current[0]+e.x,current[1]+e.y],b=[end[0]+e.x,end[1]+e.y],ux=dx/length,uy=dy/length;
      let intervals=[[0,length]];
      for(const edge of owned){
        const side=p=>(p[0]-a[0])*uy-(p[1]-a[1])*ux;
        if(side(edge.center)*side([e.x+e.w/2,e.y+e.h/2])>=0)continue;
        const normal=p=>Math.abs((p[0]-a[0])*uy-(p[1]-a[1])*ux);
        if(normal(edge.a)>1||normal(edge.b)>1)continue;
        const project=p=>(p[0]-a[0])*ux+(p[1]-a[1])*uy;
        const lo=Math.max(0,Math.min(project(edge.a),project(edge.b))),hi=Math.min(length,Math.max(project(edge.a),project(edge.b)));
        if(hi-lo<12)continue;
        changed=true;intervals=intervals.flatMap(([s,t])=>hi<=s||lo>=t?[[s,t]]:[[s,Math.max(s,lo)],[Math.min(t,hi),t]].filter(([l,r])=>r-l>.01));
      }
      for(const [s,t]of intervals)stroke.push({op:'M',points:[[current[0]+ux*s,current[1]+uy*s]]},{op:'L',points:[[current[0]+ux*t,current[1]+uy*t]]});
      owned.push({a,b,center:[e.x+e.w/2,e.y+e.h/2]});current=end;
    }
    if(changed)result.set(e.key,{fill:path,stroke,absolute:transformPath(stroke,[1,0,0,1,e.x,e.y])});
  }
  return result;
}
