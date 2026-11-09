// Root title IDs are user/model supplied, e.g. p3-title, not always "title".
export function pageTitleMatcher(p,index){
  const slides=Number.isInteger(index)?[p.slides?.[index]]:p.slides||[];
  const ids=new Set(slides.filter(Boolean).flatMap(s=>(s.elements||[{id:'title',type:'text',role:'title'}]).filter(n=>n.type==='text'&&n.role==='title').map(n=>n.id)));
  // Node IDs are page-local. With no page index, an explicit non-title role
  // wins over an ID used as another page's title (e.g. TOC t1 vs body t1).
  return e=>e.type==='text'&&(e.role==='title'||(Number.isInteger(index)||!e.role)&&(ids.has(e.nodeId)||e.nodeId==='title'));
}
