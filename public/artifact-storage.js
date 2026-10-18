const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function storageSize(bytes){return bytes>=1024**3?(bytes/1024**3).toFixed(2)+' GB':bytes>=1024**2?(bytes/1024**2).toFixed(1)+' MB':bytes>=1024?(bytes/1024).toFixed(1)+' KB':bytes+' B';}
export function artifactStorageView(report){
  const names={current:['当前结果','材料、当前预览、重建素材与交付文件'],history:['撤回历史','图片撤回、单页撤回和可复用的此前结果'],cache:['可清理缓存','不再被当前结果或撤回历史引用的生成文件'],protected:['受保护文件','项目记录、密钥与尚未识别用途的文件']};
  return `<div class="storage-total"><span>本项目占用</span><strong>${storageSize(report.total.bytes)}</strong><small>${report.total.files} 个文件 · ${report.referenceCount} 条引用</small></div><div class="storage-categories">${Object.entries(names).map(([key,[title,description]])=>`<article class="storage-category ${key}"><span>${title}</span><strong>${storageSize(report.summary[key].bytes)}</strong><small>${report.summary[key].files} 个文件</small><p>${description}</p></article>`).join('')}</div>${report.missing.length?`<p class="notice">有 ${report.missing.length} 个已登记素材文件缺失，请检查备份。清理不会修复缺失文件。</p>`:''}${report.blockedLinks.length?'<p class="subtle">链接目录或文件已跳过。</p>':''}<details class="storage-samples"><summary>查看可清理文件${report.samples.length===30?'（前 30 个）':''}</summary>${report.samples.length?`<ul>${report.samples.map(f=>`<li><span>${h(f.file)}</span><small>${storageSize(f.bytes)}</small></li>`).join('')}</ul>`:'<p class="subtle">没有可清理缓存。</p>'}</details>`;
}

export function initArtifactStorage({getProject,request,act,onError}){
  document.body.insertAdjacentHTML('beforeend',`<dialog id="artifactStorageDialog" class="artifact-storage-dialog"><div class="modal-heading"><div><span class="eyebrow">ARTIFACT STORAGE</span><h2>工件与存储</h2></div><button type="button" class="close" data-close="artifactStorageDialog" aria-label="关闭工件与存储">×</button></div><div id="artifactStorageBody"></div><p class="subtle">按引用关系清理，保留当前结果、撤回历史与原始材料。仅统计本项目，不包含依赖与开发测试目录。</p><label class="checkbox"><input id="artifactCleanupConsent" type="checkbox">删除无引用缓存；此操作不可撤回</label><div class="modal-actions"><button type="button" class="secondary" data-storage-refresh>刷新统计</button><button type="button" class="primary" data-storage-clean disabled>清理缓存</button></div><p id="artifactStorageResult" role="status"></p></dialog>`);
  const dialog=document.getElementById('artifactStorageDialog'),body=document.getElementById('artifactStorageBody'),consent=document.getElementById('artifactCleanupConsent'),clean=dialog.querySelector('[data-storage-clean]'),result=document.getElementById('artifactStorageResult');
  let report=null,projectId=null,pending=false;
  const sync=()=>{clean.disabled=pending||!consent.checked||!report?.summary.cache.files||getProject()?.id!==projectId;dialog.querySelector('[data-storage-refresh]').disabled=pending;};
  async function refresh(){
    const p=getProject();if(!p)throw Error('请先创建或选择项目');if(!p.artifactStorageEnabled)throw Error('存储管理需要重启后端后启用');
    projectId=p.id;report=null;consent.checked=false;result.textContent='';pending=true;sync();body.textContent='正在建立工件引用与占用统计…';dialog.showModal();
    try{const id=projectId,value=await request('/api/projects/'+id+'/storage');if(getProject()?.id!==id)throw Error('当前项目已切换，请重新打开存储管理');report=value;body.innerHTML=artifactStorageView(report);}
    catch(error){body.textContent=error.message;throw error;}finally{pending=false;sync();}
  }
  consent.addEventListener('change',sync);
  document.addEventListener('click',async event=>{
    const target=event.target.closest('[data-storage-open],[data-storage-refresh],[data-storage-clean]');if(!target)return;
    try{
      if(target.hasAttribute('data-storage-open')||target.hasAttribute('data-storage-refresh')){if(!pending)await refresh();return;}
      if(pending||!consent.checked||!report||getProject()?.id!==projectId)return;
      pending=true;sync();const p=await act('cleanArtifactCache',{token:report.token});report=p.artifactCleanup.report;body.innerHTML=artifactStorageView(report);consent.checked=false;result.textContent=`已清理 ${p.artifactCleanup.deleted.files} 个缓存文件，释放 ${storageSize(p.artifactCleanup.deleted.bytes)}。`;
    }catch(error){onError(error.message);}finally{pending=false;sync();}
  });
}
