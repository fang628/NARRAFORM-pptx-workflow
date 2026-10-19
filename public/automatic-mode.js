const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function automaticModeButton(p){
  const active=!!p?.autoMode?.enabled;
  return {hidden:!p?.automaticModeEnabled,label:active?'退出自动模式':'自动模式',active};
}
export function automaticModePanel(p){
  if(!p?.automaticModeEnabled)return '';
  const mode=p.autoMode;if(!mode||mode.status==='off')return '';
  const active=mode.enabled;
  return `<section class="automatic-mode-panel" data-state="${h(mode.status)}" role="status"><div class="automatic-mode-summary"><span class="automatic-mode-badge">${active?'AUTO':mode.status==='completed'?'DONE':'MANUAL'}</span><div><strong>${h(mode.message)}</strong><p>${active?'自动确认内容、提示词和预览，持续调用已配置 API；仅风格选择需你操作。退出后当前任务继续完成。':'已完成结果全部保留，可继续手动编辑或重新开启自动模式。'}</p></div></div><div class="automatic-mode-actions">${active&&mode.choice==='treatment'?'<button type="button" class="secondary" data-auto-treatment="flat">简约平面</button><button type="button" class="secondary" data-auto-treatment="realistic">写实／立体</button>':''}${active&&mode.choice==='direction'?'<button type="button" class="secondary" data-nav="2">选择视觉方向 →</button>':''}<button type="button" class="${active?'text-button':'secondary'}" data-automatic-toggle>${active?'退出自动模式':'继续自动模式 →'}</button></div>${mode.history?.length?`<details class="automatic-mode-history"><summary>自动执行记录 · ${mode.history.length}</summary><ol>${mode.history.map(e=>`<li><span>${h(new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false}))}</span>${h(e.message)}${e.status==='submitted'?' · 已提交':''}</li>`).join('')}</ol></details>`:''}</section>`;
}
export function automaticViewTab(previous,next,current){
  if(next?.autoMode?.enabled&&Number.isInteger(next.autoMode.tab)&&(previous?.autoMode?.tab!==next.autoMode.tab||next.autoMode.status==='waiting_style'&&previous?.autoMode?.status!=='waiting_style'))return next.autoMode.tab;
  if(next?.autoMode?.status==='completed'&&previous?.autoMode?.status!=='completed')return 4;
  return current;
}
