// Read-only projection: unfinished skeletons keep stable page indices but are never
// rendered as editable pages. The live deck is untouched until generation completes.
export function contentEditorView(p,stamp){
  const d=p.contentPipelineDraft;if(!d||d.stamp!==stamp)return p;
  const slides=(d.plan||[]).map((spec,index)=>d.pages[index]?.slide||{
    kind:spec.kind,title:spec.title,subtitle:'',body:[],notes:'',sources:[],sourceLinks:[],imageId:null,
    elements:[{id:'title',type:'text',role:'title',text:spec.title,parentId:null}]
  });
  return {...p,slides,pageDesigns:Object.fromEntries(d.pages.filter(e=>e.slide&&e.design).map(e=>[e.index,e.design]))};
}
