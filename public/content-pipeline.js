const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Finished pages use the normal editable form; live progress belongs to the task list.
export function contentPageIndices(p){
  if(!p.contentPipeline)return (p.slides||[]).map((_,index)=>index);
  return p.contentPipeline.pages.filter(entry=>entry.slide).map(entry=>entry.index);
}
export function contentPipelinePanel(p){
  const d=p.contentPipeline;if(!d)return '';
  const errors=d.pages.filter(entry=>entry.error);
  if(!errors.length)return '';
  return `<details class="content-pipeline-issues"><summary>${errors.length} 页待补齐 · 已完成内容保留</summary><ul>${errors.map(e=>`<li>第 ${e.index+1} 页 · ${h(e.title)}：${h(e.error)}</li>`).join('')}</ul></details>`;
}
