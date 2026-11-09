// Minimum-cost one-to-one assignment, with an independent unmatched slot per
// observation. Repeated occurrences stay distinct even when their pixels match.
export function minimumAssignment(costs,unmatched=.72){
  if(!costs.length)return [];
  const n=costs.length,m=Math.max(0,...costs.map(r=>r.length)),cols=m+n;
  const a=costs.map(row=>Array.from({length:cols},(_,j)=>j<m?(Number.isFinite(row[j])?row[j]:1e6):unmatched));
  const u=Array(n+1).fill(0),v=Array(cols+1).fill(0),p=Array(cols+1).fill(0),way=Array(cols+1).fill(0);
  for(let i=1;i<=n;i++){
    p[0]=i;let j0=0;const minv=Array(cols+1).fill(Infinity),used=Array(cols+1).fill(false);
    do{used[j0]=true;const i0=p[j0];let delta=Infinity,j1=0;
      for(let j=1;j<=cols;j++)if(!used[j]){const cur=a[i0-1][j-1]-u[i0]-v[j];if(cur<minv[j]){minv[j]=cur;way[j]=j0;}if(minv[j]<delta){delta=minv[j];j1=j;}}
      for(let j=0;j<=cols;j++)if(used[j]){u[p[j]]+=delta;v[j]-=delta;}else minv[j]-=delta;j0=j1;
    }while(p[j0]);
    do{const j1=way[j0];p[j0]=p[j1];j0=j1;}while(j0);
  }
  const result=Array(n).fill(-1);for(let j=1;j<=m;j++)if(p[j]&&a[p[j]-1][j-1]<unmatched)result[p[j]-1]=j-1;return result;
}
const box=e=>e&&['x','y','w','h'].every(k=>Number.isFinite(e[k]))&&e.w>0&&e.h>0;
const overlap=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
const native=e=>!e.managed&&(['rect','ellipse','shape','svg'].includes(e.type)||e.type==='image'&&e.implementation==='svg'&&!!e.frameKind)&&e.role!=='background';
export function matchReferenceObjects(elements,candidates){
  const objects=elements.filter(e=>native(e)&&box(e)),reference=(candidates||[]).filter(c=>box(c)&&c.confidence>=.65);
  const costs=objects.map(e=>reference.map(c=>{
    const intersection=overlap(e,c),iou=intersection/(e.w*e.h+c.w*c.h-intersection);
    const distance=Math.hypot(e.x+e.w/2-c.x-c.w/2,e.y+e.h/2-c.y-c.h/2)/Math.max(24,Math.hypot(e.w,e.h));
    if(!intersection||distance>.8)return Infinity;
    return .8*(1-iou)+.2*Math.min(1,distance);
  }));
  const assignment=minimumAssignment(costs,.62),used=new Set(assignment.filter(i=>i>=0));
  return {matches:objects.flatMap((e,i)=>assignment[i]<0?[]:[{key:e.key,candidateId:reference[assignment[i]].id??String(assignment[i]),confidence:1-costs[i][assignment[i]],reference:reference[assignment[i]]}]),unmatchedElements:objects.filter((_,i)=>assignment[i]<0).map(e=>e.key),unmatchedCandidates:reference.filter((_,i)=>!used.has(i))};
}
export function reconstructionCorrespondence(elements,{texts=[],images=[],frames=[],candidates=[]}={}){
  const geometry=matchReferenceObjects(elements,candidates),warnings=[];
  const missingTexts=texts.filter(n=>!elements.some(e=>(e.type==='text'||e.type==='formula'||e.artisticText)&&e.nodeId===n.nodeId));
  const missingImages=images.filter(n=>!elements.some(e=>e.type==='image'&&e.nodeId===n.nodeId&&e.id===n.id));
  const missingFrames=frames.filter(f=>!elements.some(e=>e.key===f.key));
  for(const n of [...missingTexts,...missingImages])warnings.push('缺少内容对象：'+n.nodeId);
  for(const f of missingFrames)warnings.push('缺少框体：'+f.key);
  for(const c of geometry.unmatchedCandidates)warnings.push('待核对未对应的视觉承载：'+(c.id||'候选')+` (${Math.round(c.x)},${Math.round(c.y)},${Math.round(c.w)},${Math.round(c.h)})`);
  return {...geometry,missingTexts:missingTexts.map(n=>n.nodeId),missingImages:missingImages.map(n=>n.nodeId),missingFrames:missingFrames.map(f=>f.key),warnings};
}
