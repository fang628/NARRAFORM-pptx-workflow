import {sourcePanel,foldHint} from './provenance.js';
const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// A deliberately small renderer: no raw HTML, external embeds or executable links.
export function designPreview(markdown,p,index){
  const lines=markdown.split('\n').filter(l=>!l.startsWith('<!--')),out=[];
  const renderLine=l=>{
  const head=/^(#{1,3}) (.*)/.exec(l);if(head)return `<h${Math.min(4,head[1].length+1)}>${h(head[2])}</h${Math.min(4,head[1].length+1)}>`;
  return `<div class="design-line" style="--design-indent:${Math.min(6,(l.match(/^ */)?.[0].length||0)/2)}">${h(l).replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')||'&nbsp;'}</div>`;
  };
  for(let i=0;i<lines.length;i++){
    const source=/^(#{1,3})\s+原材料对应索引\s*$/.exec(lines[i]);
    if(!source){out.push(renderLine(lines[i]));continue;}
    let end=i+1;while(end<lines.length){const next=/^(#{1,3})\s/.exec(lines[end]);if(next&&next[1].length<=source[1].length)break;end++;}
    out.push(p?.slides?.[index]?sourcePanel(p,p.slides[index],index,true,'design'):'<details class="source-relations"><summary>原材料对应索引</summary>'+lines.slice(i+1,end).map(renderLine).join('')+'</details>');i=end-1;
  }
  return out.join('');
}
const designExpansion=new Map(),batchResults=new Map();
const batchStateKey=p=>JSON.stringify(p.slides.map((s,index)=>[p.pageDesigns?.[index]?.markdown,p.pageDesigns?.[index]?.current,p.pageDesigns?.[index]?.approvedCurrent,(s.sourceLinks||[]).some(l=>l.stale)]));
export function rememberDesignExpansion(target){const key=target?.dataset?.designFold;if(key&&target.isConnected!==false)designExpansion.set(key,!!target.open);}
const designFold=(p,index)=>{const key=p.id+':'+index;return `data-design-fold="${h(key)}" ${designExpansion.get(key)?'open':''}`;};
export async function saveAndConfirmPageDesigns(project,slides,drafts,save,approve){
  const saved=await save(project,slides);
  if(saved.id!==project.id)throw Error('项目已变化，请重新确认');
  if(saved.approvals?.content!==saved.version)throw Error('内容未确认，请重试');
  return confirmAllPageDesigns(saved,drafts,approve);
}
export async function confirmAllPageDesigns(project,drafts,approve){
  let p=project;const confirmed=[],already=[],skipped=[];
  for(let index=0;index<p.slides.length;index++){
    const d=p.pageDesigns?.[index],markdown=drafts.get(index)??d?.markdown;
    const reason=!d?.markdown?'尚未生成设计稿':!d.current?'设计稿已过期':(p.slides[index].sourceLinks||[]).some(l=>l.stale)?'材料对应待核对':null;
    if(reason){skipped.push({index,reason});continue;}
    if(d.approvedCurrent&&markdown===d.markdown){already.push(index);continue;}
    try{const next=await approve(p,index,markdown);if(next.id!==project.id)throw Error('项目已变化，请重新确认');p=next;confirmed.push(index);}catch(e){skipped.push({index,reason:e.message});}
  }
  const result={confirmed,already,skipped};batchResults.set(project.id,{...result,state:batchStateKey(p)});return {project:p,...result};
}
export function batchDesignResult(p){const r=batchResults.get(p.id);if(!r||r.state!==batchStateKey(p))return '';return `<div class="notice design-batch-result" role="status">本次已确认 ${r.confirmed.length} 页，原已确认 ${r.already.length} 页。${r.skipped.length?`<details><summary>${r.skipped.length} 页暂未确认</summary><ul>${r.skipped.map(s=>`<li>第 ${s.index+1} 页：${h(s.reason)}</li>`).join('')}</ul></details>`:'所有页设计已确认。'}</div>`;}
const feedbackDrafts=new Map();
export function rememberDesignFeedback(projectId,index,value){feedbackDrafts.set(projectId+':'+index,value);}
export function pageDesignPanel(p,i){
  const d=p.pageDesigns?.[i],failure=p.initialDesign?.failed?.find(f=>f.index===i);
  const state=d?.approvedCurrent?'设计稿已确认':d?.current?'等待复核':d?.markdown?'内容已变 · 需重新生成':d?.layoutCurrent?'排版已确认':'等待 AI 初稿';
  return `<section class="page-design-panel" data-page-design="${i}">
    <div class="page-design-head"><div><span class="eyebrow">DESIGN SPEC / ${String(i+1).padStart(2,'0')}</span><h3>单页设计稿</h3></div><span class="tag" data-design-state>${state}</span></div>
    <div class="page-design-body">
      <p class="subtle">AI 先完成设计初稿；修改上方内容后可重新生成，确认本页即可进入视觉方案。</p>
      ${failure&&!d?.current?`<p class="image-extraction-report">本页 AI 设计未完成：${h(failure.message)}；可单页重试或补齐设计稿。</p>`:''}
      <section class="design-input-check"><h4>设计稿本步检查 · ${d?.inputCheck?.warnings.length?'材料与图注待核对':'内容与素材登记'}</h4>${d?.inputCheck?.warnings.length?`<ul>${d.inputCheck.warnings.map(v=>`<li>${h(v)}</li>`).join('')}</ul>`:d?'<p>暂无新增素材登记缺口。</p>':'<p>生成设计稿后在这里显示本步检查结果。</p>'}<p>实际画面检查在视觉方案与完整预览生成结束时完成。</p></section>
      <div class="page-design-actions">
        <button type="button" class="primary" data-page-design-action="designPage" data-page="${i}">${d?.markdown?'AI 重新设计本页':'AI 生成本页设计稿'} ↗</button>
        ${d?.markdown?`<button type="button" class="secondary" data-page-design-action="savePageDesign" data-page="${i}" ${!d.current?'disabled':''}>保存修改</button><button type="button" class="primary" data-page-design-action="approvePageDesign" data-page="${i}" ${!d.current?'disabled':''}>${d.approvedCurrent?'✓ 已确认设计稿':'确认本页内容与设计 →'}</button>${d.current?`<a class="text-button" data-design-download href="/api/projects/${p.id}/page-design?index=${i}">下载 .md ↧</a>`:''}`:''}
      </div>
      ${d?.markdown?`
        <p class="subtle design-dirty" role="status">${d.current?'设计稿仅规划这一页，生成后等待你复核。':'本页内容或材料已变化，请重新生成设计稿。'}</p>
        <details class="design-document" ${designFold(p,i)}><summary><span>${d.current?'阅读设计稿':'上一版设计稿 · 已过期'}<small>文案 / 排版树 / 素材意图</small></span>${foldHint}</summary><div class="design-markdown">${designPreview(d.markdown,p,i)}</div></details>
        <section class="design-feedback"><h4>用 AI 修改设计稿</h4><label>修改意见<textarea aria-label="第 ${i+1} 页设计修改意见" data-design-feedback="${i}" rows="3" maxlength="3000" placeholder="例如：图片移到右侧并放大，左侧突出核心结论，减少装饰，保留图注。">${h(feedbackDrafts.get(p.id+':'+i)||'')}</textarea></label><div class="page-design-actions"><button type="button" class="secondary" data-page-design-action="revisePageDesign" data-page="${i}" ${p.executionConcurrency===undefined?'disabled title="重启本地服务后启用"':''}>按意见重新生成 ↗</button></div><p class="subtle">保留当前文案与内容层级，重新生成后需复核确认。</p></section>
        <p class="subtle design-edit-hint">可修改风格和设计说明。准确文案与嵌套排版树请回到上方内容树修改后重新生成。</p>
        <details class="design-edit"><summary>编辑设计说明 · Markdown</summary><textarea aria-label="第 ${i+1} 页设计稿 Markdown" data-design-markdown="${i}" rows="16" maxlength="80000">${h(d.markdown)}</textarea></details>
      `:'<div class="design-empty">AI 设计稿尚未生成，点击上方按钮生成本页初稿。</div>'}
    </div>
  </section>`;
}
export function markPageDesignDirty(el){const panel=el.querySelector('[data-page-design]');if(!panel)return;panel.dataset.dirty='true';panel.querySelector('[data-design-state]').textContent='内容树有未保存修改';panel.querySelectorAll('[data-page-design-action]:not([data-page-design-action="confirmPageLayout"]):not([data-page-design-action="designPage"]):not([data-page-design-action="revisePageDesign"])').forEach(b=>b.disabled=true);panel.querySelector('[data-design-download]')?.remove();const hint=panel.querySelector('.design-dirty');if(hint)hint.textContent='保存修改后，重新生成设计稿并复核。';}
export function reconstructionPanel(p){const r=p.reconstruction,current=p.reconstructionCurrent;return `<section class="panel reconstruction-panel"><div class="panel-heading"><div><span class="eyebrow">ELEMENT AUDIT & REBUILD</span><h3>提取元素，重组交付。</h3><p class="subtle">使用支持图片输入的模型读取整页成品，重组为原生文字、图形和独立图片。</p></div><span class="tag">${current?r.approvedAt?'重组预览已确认':'重组完成 · 等待复核':r?'旧重组已过期':'可选步骤'}</span></div><p class="subtle">${p.rebuildModel?(p.rebuildSource==='rebuild'?'独立视觉模型：':'沿用主模型：')+h(p.rebuildModel):'请先连接支持图片输入的主模型；高性能视觉模型为选填。'} 会将全部成品页（含图片）发送给该模型，每页调用一次。准确文字和素材身份必须保留。</p><div class="actions"><button type="button" class="secondary" data-open-api>配置 / 测试模型</button><button type="button" class="primary" data-action="reconstructPreview" ${!p.rebuildReady?'disabled':''}>${current?'重新提取并重组':'提取元素并重组全篇'} ↗</button>${current?'<button type="button" class="text-button" data-action="discardReconstruction">恢复原预览</button>':''}</div>${current?`<div class="reconstruction-summary">${r.slides.map(s=>`<span>S${String(s.index+1).padStart(2,'0')} <b>${s.elements.filter(e=>e.type==='text').length}</b> 文字 / <b>${s.elements.filter(e=>e.type==='image').length}</b> 图片 / <b>${s.elements.filter(e=>e.type==='rect').length}</b> 图形</span>`).join('')}</div><p class="callout">下方已显示重组后的成品。请重新审阅全部页面，再点击“批准当前完整预览”。导出将采用同一组可编辑元素。</p>`:''}</section>`;}
