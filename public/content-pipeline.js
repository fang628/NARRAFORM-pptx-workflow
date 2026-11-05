import {renderInlineText} from './inline-text.js';
import {mathFieldMarkup,renderMathText} from './math-markup.js';
const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const status={queued:'等待内容',generating:'生成内容', 'content-ready':'内容已保存',designing:'生成设计',done:'内容与设计已保存',failed:'内容待重试','design-failed':'设计待补',cancelled:'已保留当前结果'};
function tree(nodes){
  const ids=new Set(nodes.map(n=>n.id));
  const draw=(parent,depth)=>nodes.filter(n=>parent===null?!n.parentId||!ids.has(n.parentId):n.parentId===parent).map(n=>{
    const label=n.type==='image'?'图片 · '+(n.label||n.materialId):n.type==='table'?'表格 · '+(n.headers||[]).join(' / '):n.type==='formula'?'公式 · '+n.latex:n.type==='group'?n.label:n.text;
    return `<div class="design-line" style="--design-indent:${Math.min(depth,10)}">${n.type==='formula'?mathFieldMarkup(n.latex,{block:true}):renderMathText(label,renderInlineText)}</div>`+(depth<12?draw(n.id,depth+1):'');
  }).join('');return draw(null,0);
}
export function contentPipelinePanel(p){
  const d=p.contentPipeline;if(!d)return '';
  return `<section class="panel content-pipeline"><div class="slide-summary"><h3>逐页生成</h3><p class="subtle" role="status">内容 ${d.contentReady} / ${d.total} · 设计 ${d.designReady} / ${d.total}${['partial','failed','cancelled'].includes(d.status)?' · 正确结果已保留，继续生成会补齐缺页':''}</p></div>${d.status==='planning'?'<p class="subtle">正在分配全篇主题与配图…</p>':''}${d.pages.map(e=>`<details class="source-fold"><summary>第 ${e.index+1} 页 · ${h(e.title)} <span class="tag">${h(status[e.status]||e.status)}</span></summary>${e.nodes?.length?tree(e.nodes):''}${e.error?`<p class="subtle">${h(e.error)}</p>`:''}</details>`).join('')}</section>`;
}
