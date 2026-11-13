// Diameter, fill and stroke are independent equivalence classes. Positions and
// semantic instances stay individual, including circles in different columns.
export function circleGroups(elements){
  const circles=elements.filter(e=>e.type==='ellipse'&&!e.managed&&!e.effectOf&&e.role!=='effect'
    &&Math.max(e.w,e.h)<=80&&Math.min(e.w,e.h)>=4&&Math.max(e.w,e.h)/Math.min(e.w,e.h)<1.18);
  const groups=[];
  for(const e of circles){
    const badge=elements.some(t=>t.type==='text'&&t.role==='visual-number'&&t.x+t.w/2>=e.x&&t.x+t.w/2<=e.x+e.w&&t.y+t.h/2>=e.y&&t.y+t.h/2<=e.y+e.h);
    const purpose=badge||e.class==='badge'?'badge':e.w<20?'bullet':'icon-disc';
    const state=e.visualState||e.emphasis||'normal';
    const group=groups.find(g=>g.purpose===purpose&&g.state===state&&g.members.every(o=>Math.abs((e.w+e.h)/2-(o.w+o.h)/2)<=Math.max(2,(e.w+e.h)*.05)));
    if(group)group.members.push(e);else groups.push({purpose,state,members:[e]});
  }
  return groups.filter(g=>g.members.length>=2).map((g,i)=>({id:'circle-'+g.purpose+'-'+i,keys:g.members.map(e=>e.key),purpose:g.purpose}));
}
