// A shared, deterministic path representation for native DrawingML and SVG.
// All commands are absolute; arcs and smooth commands normalize to Beziers.
const token=/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi;
const counts={M:2,L:2,H:1,V:1,C:6,S:4,Q:4,T:2,A:7,Z:0};
export const vectorPathVersion=2;
const fmt=n=>String(Math.round(n*1e6)/1e6);
const point=(x,y)=>[x,y];
function arcSegments(start,args){
  let [rx,ry,rotation,large,sweep,x,y]=args;rx=Math.abs(rx);ry=Math.abs(ry);
  if(!rx||!ry)return [{op:'L',points:[[x,y]]}];
  if(Math.hypot(start[0]-x,start[1]-y)<1e-10)return [];
  if(![0,1].includes(large)||![0,1].includes(sweep))throw Error('圆弧标记须为0或1');
  const phi=rotation*Math.PI/180,co=Math.cos(phi),si=Math.sin(phi),dx=(start[0]-x)/2,dy=(start[1]-y)/2;
  const px=co*dx+si*dy,py=-si*dx+co*dy,scale=px*px/(rx*rx)+py*py/(ry*ry);
  if(scale>1){rx*=Math.sqrt(scale);ry*=Math.sqrt(scale);}
  const numerator=Math.max(0,rx*rx*ry*ry-rx*rx*py*py-ry*ry*px*px),denominator=rx*rx*py*py+ry*ry*px*px;
  const k=(large===sweep?-1:1)*Math.sqrt(numerator/Math.max(1e-30,denominator)),cxp=k*rx*py/ry,cyp=-k*ry*px/rx;
  const cx=co*cxp-si*cyp+(start[0]+x)/2,cy=si*cxp+co*cyp+(start[1]+y)/2;
  const angle=(a,b)=>Math.atan2(a[0]*b[1]-a[1]*b[0],a[0]*b[0]+a[1]*b[1]);
  const u=[(px-cxp)/rx,(py-cyp)/ry],v=[(-px-cxp)/rx,(-py-cyp)/ry];
  let theta=angle([1,0],u),delta=angle(u,v);if(!sweep&&delta>0)delta-=2*Math.PI;if(sweep&&delta<0)delta+=2*Math.PI;
  const parts=Math.max(1,Math.ceil(Math.abs(delta)/(Math.PI/2))),step=delta/parts,out=[];
  const p=t=>[cx+rx*co*Math.cos(t)-ry*si*Math.sin(t),cy+rx*si*Math.cos(t)+ry*co*Math.sin(t)];
  const d=t=>[-rx*co*Math.sin(t)-ry*si*Math.cos(t),-rx*si*Math.sin(t)+ry*co*Math.cos(t)];
  for(let i=0;i<parts;i++){const end=theta+step,a=p(theta),b=p(end),da=d(theta),db=d(end),f=4/3*Math.tan(step/4);out.push({op:'C',points:[[a[0]+f*da[0],a[1]+f*da[1]],[b[0]-f*db[0],b[1]-f*db[1]],b]});theta=end;}
  out.at(-1).points[2]=[x,y];return out;
}
export function parseVectorPath(d){
  if(typeof d!=='string'||d.length>180000)throw Error('路径数据无效');
  const tokens=d.match(token)||[],residue=d.replace(token,'').replace(/[\s,]/g,'');if(residue||tokens.length>16000)throw Error('路径含无效字符或过长');
  const out=[];let i=0,command=null,current=[0,0],start=[0,0],previous='',control=null;
  while(i<tokens.length){
    if(/^[a-z]$/i.test(tokens[i]))command=tokens[i++];
    if(!command||counts[command.toUpperCase()]===undefined)throw Error('不支持的路径命令');
    const op=command.toUpperCase(),relative=op!==command,n=counts[op];
    if(op==='Z'){out.push({op:'Z',points:[]});current=[...start];previous='Z';control=null;command=null;continue;}
    if(i+n>tokens.length||tokens.slice(i,i+n).some(t=>/^[a-z]$/i.test(t)))throw Error('路径命令参数不完整');
    const values=tokens.slice(i,i+n).map(Number);i+=n;if(!values.every(Number.isFinite))throw Error('路径坐标无效');
    const p=(at=0)=>point(values[at]+(relative?current[0]:0),values[at+1]+(relative?current[1]:0));
    let next;
    if(op==='M'||op==='L'){next={op,points:[p()]};if(op==='M'){start=[...next.points[0]];command=relative?'l':'L';}}
    else if(op==='H')next={op:'L',points:[[values[0]+(relative?current[0]:0),current[1]]]};
    else if(op==='V')next={op:'L',points:[[current[0],values[0]+(relative?current[1]:0)]]};
    else if(op==='C')next={op:'C',points:[p(),p(2),p(4)]};
    else if(op==='Q')next={op:'Q',points:[p(),p(2)]};
    else if(op==='S')next={op:'C',points:[['C','S'].includes(previous)&&control?[2*current[0]-control[0],2*current[1]-control[1]]:[...current],p(),p(2)]};
    else if(op==='T')next={op:'Q',points:[['Q','T'].includes(previous)&&control?[2*current[0]-control[0],2*current[1]-control[1]]:[...current],p()]};
    else if(op==='A'){const end=p(5),segments=arcSegments(current,[...values.slice(0,5),...end]);out.push(...segments);current=end;previous='A';control=null;continue;}
    if(!out.length&&next.op!=='M')throw Error('路径须以M开头');
    out.push(next);current=[...next.points.at(-1)];control=['Q','C'].includes(next.op)?[...next.points.at(-2)]:null;previous=op;
    if(out.length>2048)throw Error('路径段数过多');
  }
  return out;
}
export function pathD(commands){return commands.map(c=>c.op+(c.points?.length?' ':'')+(c.points||[]).map(p=>p.map(fmt).join(' ')).join(' ')).join(' ');}
export function transformPath(commands,m=[1,0,0,1,0,0]){return commands.map(c=>({op:c.op,points:c.points.map(([x,y])=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]])}));}
export function sampleVectorPath(commands,{steps=16}={}){
  let current=[0,0],start=current;const subpaths=[];let part;
  for(const c of commands){
    if(c.op==='M'){part={points:[[...c.points[0]]],closed:false};subpaths.push(part);current=[...c.points[0]];start=[...current];continue;}
    if(!part)throw Error('路径须以M开头');
    if(c.op==='Z'){part.closed=true;current=[...start];continue;}
    if(c.op==='L'){current=[...c.points[0]];part.points.push(current);continue;}
    const a=[...current];for(let n=1;n<=steps;n++){const t=n/steps,s=1-t;part.points.push([0,1].map(k=>c.op==='Q'?s*s*a[k]+2*s*t*c.points[0][k]+t*t*c.points[1][k]:s*s*s*a[k]+3*s*s*t*c.points[0][k]+3*s*t*t*c.points[1][k]+t*t*t*c.points[2][k]));}current=[...c.points.at(-1)];
  }
  return subpaths;
}
export function vectorPathBounds(commands){
  const points=sampleVectorPath(commands,{steps:32}).flatMap(p=>p.points);if(!points.length)throw Error('空路径');
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]),x=Math.min(...xs),y=Math.min(...ys);return {x,y,w:Math.max(...xs)-x,h:Math.max(...ys)-y};
}
export function pathTopology(commands){
  const loops=sampleVectorPath(commands,{steps:8});
  const area=p=>p.reduce((sum,a,i)=>{const b=p[(i+1)%p.length];return sum+a[0]*b[1]-b[0]*a[1];},0)/2;
  const inside=(p,poly)=>{let yes=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
  return loops.map((loop,index)=>{
    if(!loop.closed)return {closed:false};
    const p=loop.points,sign=area(p),depth=loops.reduce((n,other,j)=>n+(j!==index&&other.closed&&Math.abs(area(other.points))>Math.abs(sign)+1e-9&&inside(p[0],other.points)?1:0),0);
    const xs=p.map(q=>q[0]),ys=p.map(q=>q[1]),minX=Math.min(...xs),minY=Math.min(...ys),w=Math.max(...xs)-minX||1,h=Math.max(...ys)-minY||1,normalized=p.map(([x,y])=>[(x-minX)/w,(y-minY)/h]);
    const bins=new Map();let crossings=0;const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    for(let i=0;i<p.length;i++){const a=normalized[i],b=normalized[(i+1)%p.length],candidates=new Set(),cells=[];
      for(let x=Math.floor(Math.min(a[0],b[0])*16);x<=Math.floor(Math.max(a[0],b[0])*16);x++)for(let y=Math.floor(Math.min(a[1],b[1])*16);y<=Math.floor(Math.max(a[1],b[1])*16);y++){const key=x+','+y;cells.push(key);for(const j of bins.get(key)||[])candidates.add(j);}
      for(const j of candidates){if(j===i-1||j===0&&i===p.length-1)continue;const c=normalized[j],d=normalized[(j+1)%p.length];if(cross(a,b,c)*cross(a,b,d)<-1e-12&&cross(c,d,a)*cross(c,d,b)<-1e-12)crossings++;}
      for(const key of cells){if(!bins.has(key))bins.set(key,[]);bins.get(key).push(i);}
    }
    return {closed:true,orientation:Math.sign(sign),nesting:depth,crossings};
  });
}
function normalizeEvenOdd(commands){
  const groups=[];for(const c of commands){if(c.op==='M')groups.push([]);groups.at(-1).push(c);}
  const loops=groups.map(g=>sampleVectorPath(g,{steps:24})[0].points),area=p=>p.reduce((sum,a,i)=>{const b=p[(i+1)%p.length];return sum+a[0]*b[1]-b[0]*a[1];},0)/2;
  const inside=(p,poly)=>{let yes=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
  return groups.flatMap((g,i)=>{
    const sign=area(loops[i]),depth=loops.reduce((n,p,j)=>n+(j!==i&&Math.abs(area(p))>Math.abs(sign)+1e-9&&inside(loops[i][0],p)?1:0),0);
    if((sign>0)===(depth%2===0))return g;
    const start=g[0].points[0],segments=[];let current=start;
    for(const c of g.slice(1)){if(c.op==='Z')continue;segments.push({c,start:current});current=c.points.at(-1);}
    const reversed=[{op:'M',points:[[...start]]}];if(Math.hypot(current[0]-start[0],current[1]-start[1])>1e-9)reversed.push({op:'L',points:[[...current]]});
    for(const {c,start:p}of segments.reverse())reversed.push({op:c.op,points:c.op==='C'?[c.points[1],c.points[0],p]:c.op==='Q'?[c.points[0],p]:[p]});return reversed.concat({op:'Z',points:[]});
  });
}
export function validateNativePath(value){
  const commands=value?.commands;if(!Array.isArray(commands)||commands.length<3||commands.length>512||commands[0]?.op!=='M')throw Error('原生路径须为3–512段，以M开头');
  const lengths={M:1,L:1,Q:2,C:3,Z:0};let open=false;
  const out=commands.map(c=>{if(!c||lengths[c.op]===undefined||!Array.isArray(c.points)||c.points.length!==lengths[c.op]||c.points.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!Number.isFinite(v)||v< -2||v>3)))throw Error('原生路径命令或归一化坐标无效');if(c.op==='M'){if(open)throw Error('原生承载的子路径须闭合');open=true;}if(c.op==='Z'){if(!open)throw Error('无效闭合路径');open=false;}return {op:c.op,points:c.points.map(p=>[...p])};});
  if(open||value.closed===false)throw Error('原生承载路径须闭合');
  const subs=sampleVectorPath(out,{steps:24}),b=vectorPathBounds(out);if(b.x<-.002||b.y<-.002||b.x+b.w>1.002||b.y+b.h>1.002||b.w*b.h<.002)throw Error('原生路径超出归一化边界或面积无效');
  for(const sub of subs){const pts=sub.points;if(pts.length<3)throw Error('原生路径面积无效');
    const area=Math.abs(pts.reduce((a,p,i)=>{const q=pts[(i+1)%pts.length];return a+p[0]*q[1]-q[0]*p[1];},0))/2;if(area<1e-7)throw Error('原生路径退化');
    // Exclude adjacent segments and duplicate sampling endpoints. Touching a
    // corner is allowed; transverse self intersections are not.
    const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    const bins=new Map();
    for(let i=0;i<pts.length;i++){
      const a=pts[i],b=pts[(i+1)%pts.length],x0=Math.floor(Math.min(a[0],b[0])*32),x1=Math.floor(Math.max(a[0],b[0])*32),y0=Math.floor(Math.min(a[1],b[1])*32),y1=Math.floor(Math.max(a[1],b[1])*32),candidates=new Set(),cells=[];
      for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const key=x+','+y;cells.push(key);for(const j of bins.get(key)||[])candidates.add(j);}
      for(const j of candidates){if(j===i-1||j===0&&i===pts.length-1)continue;const c=pts[j],d=pts[(j+1)%pts.length];if(cross(a,b,c)*cross(a,b,d)<-1e-14&&cross(c,d,a)*cross(c,d,b)<-1e-14)throw Error('原生路径自交');}
      for(const key of cells){if(!bins.has(key))bins.set(key,[]);bins.get(key).push(i);}
    }
  }
  return {version:2,commands:value.fillRule==='evenodd'?normalizeEvenOdd(out):out,closed:true};
}
export function nativePathXML(commands,scale=100000){
  const tags={M:'moveTo',L:'lnTo',Q:'quadBezTo',C:'cubicBezTo'};
  return commands.map(c=>c.op==='Z'?'<a:close/>':`<a:${tags[c.op]}>${c.points.map(([x,y])=>`<a:pt x="${Math.round(x*scale)}" y="${Math.round(y*scale)}"/>`).join('')}</a:${tags[c.op]}>`).join('');
}
