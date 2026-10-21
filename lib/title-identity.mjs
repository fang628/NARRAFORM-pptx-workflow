// Root title IDs are user/model supplied, e.g. p3-title, not always "title".
export function pageTitleMatcher(p,index){
  const slides=Number.isInteger(index)?[p.slides?.[index]]:p.slides||[];
  const ids=new Set(slides.filter(Boolean).flatMap(s=>(s.elements||[{id:'title',type:'text',role:'title'}]).filter(n=>n.type==='text'&&n.role==='title').map(n=>n.id)));
  return e=>e.type==='text'&&(ids.has(e.nodeId)||e.role==='title'||e.nodeId==='title');
}
