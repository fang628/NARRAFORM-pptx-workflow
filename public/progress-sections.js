export const defaultProgressTitles=['背景与目标','内容与思路','方案与过程','成果与分析','总结与展望'];
export function validateProgressSections(value){
  if(!Array.isArray(value)||![4,5,6].includes(value.length))throw Error('进度条须为 4、5 或 6 段');
  const titles=value.map(item=>typeof item==='string'?item.trim():String(item?.title||'').trim());
  if(titles.some(t=>!t||t.length>24))throw Error('每个进度章节名称须为 1–24 字');
  if(new Set(titles).size!==titles.length)throw Error('进度章节名称不能重复');
  return titles.map((title,i)=>({id:'section-'+(i+1),title}));
}
export function progressSectionsOf(p){
  try{return validateProgressSections(p?.progressSections);}catch{}
  const source=p?.analysis?.outline||p?.slides?.filter(s=>s.kind==='section')||[];
  const titles=[...new Set(source.map(s=>s.title?.trim()).filter(t=>t&&t.length<=24))].slice(0,6);
  const count=[4,6].includes(titles.length)?titles.length:5;
  for(const title of defaultProgressTitles)if(titles.length<count&&!titles.includes(title))titles.push(title);
  return validateProgressSections(titles);
}
const h=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function progressSectionFields(sections){return sections.map((s,i)=>`<label class="progress-section-item"><span class="progress-section-index" aria-hidden="true">${String(i+1).padStart(2,'0')}</span><input data-progress-section="${i}" aria-label="进度章节 ${i+1}" value="${h(s.title)}" maxlength="24" required><span class="progress-section-track" aria-hidden="true"></span></label>`).join('');}
export function progressSectionsEditor(p){
  const sections=progressSectionsOf(p),pending=p.task?.status==='running'&&p.task.label==='重新生成页顶进度章节',count=pending?p.task.progressSectionCount||sections.length:sections.length;
  return `<fieldset class="progress-sections-editor"><legend>页顶进度章节</legend><div class="progress-sections-heading"><p>按章节串联全篇<span>按内容建议段数，改段数后重新生成；名称可用6–8字</span></p><div class="progress-sections-actions">${p.progressSectionsRegenerationEnabled?`<button type="button" class="secondary progress-regenerate" data-regenerate-progress aria-label="单独重新生成页顶进度章节" ${p.task?.status==='running'?'disabled':''} title="仅重新生成章节名称与页面归属，保留正文和图片">重新生成 ↻</button>`:''}<label class="progress-section-count"><span>章节数量</span><select id="progressSectionCount" aria-label="进度章节数量" ${p.task?.status==='running'?'disabled':''}><option value="4" ${count===4?'selected':''}>4 段</option><option value="5" ${count===5?'selected':''}>5 段</option><option value="6" ${count===6?'selected':''}>6 段</option></select></label></div></div><div class="progress-section-fields" data-progress-section-fields>${pending?`<p class="subtle" role="status">正在按 ${count} 段重新生成章节…</p>`:progressSectionFields(sections)}</div></fieldset>`;
}
export function pageProgressSelector(p,s){
  if(p.brief.progress===false||['cover','toc'].includes(s.kind))return '';
  return `<label>所属进度章节<select data-field="progressSectionId"><option value="">自动归属</option>${progressSectionsOf(p).map(section=>`<option value="${section.id}" ${s.progressSectionId===section.id?'selected':''}>${h(section.title)}</option>`).join('')}</select></label>`;
}
