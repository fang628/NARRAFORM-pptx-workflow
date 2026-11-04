export function initProjectTransfer({getProject,onImported,onError}){
  const heading=document.querySelector('#artifactStorageDialog>.modal-heading');
  heading.insertAdjacentHTML('afterend',`<section class="project-transfer-panel"><div class="project-transfer-heading"><h3>工程迁移</h3></div><div class="project-transfer-actions"><button type="button" class="project-transfer-card transfer-export" data-project-export aria-label="导出工程"><span class="transfer-file-icon" aria-hidden="true"><svg viewBox="0 0 32 36" fill="none"><path d="M5 2h14l8 8v24H5zM19 2v9h8M16 16v12m-5-5 5 5 5-5"/></svg></span><span class="transfer-card-copy"><strong>导出工程</strong></span><span class="transfer-card-arrow" aria-hidden="true">↗</span></button><button type="button" class="project-transfer-card transfer-import" data-project-import aria-label="导入工程"><span class="transfer-file-icon" aria-hidden="true"><svg viewBox="0 0 32 36" fill="none"><path d="M5 2h14l8 8v24H5zM19 2v9h8M16 28V16m-5 5 5-5 5 5"/></svg></span><span class="transfer-card-copy"><strong>导入工程</strong></span><span class="transfer-card-arrow" aria-hidden="true">↙</span></button><input type="file" data-project-package accept=".narra,.zip" hidden></div><p class="project-transfer-state" role="status" hidden></p></section>`);
  const input=document.querySelector('[data-project-package]'),status=document.querySelector('.project-transfer-state'),buttons=[...document.querySelectorAll('[data-project-export],[data-project-import]')];let pending=false;
  function state(text){status.hidden=!text;status.textContent=text;}
  function lock(value){pending=value;buttons.forEach(b=>b.disabled=value);}
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-project-export],[data-project-import]');if(!button||pending)return;
    if(button.hasAttribute('data-project-import')){input.value='';input.click();return;}
    try{
      const p=getProject();if(!p)throw Error('请先选择要导出的项目');if(!p.projectTransferEnabled)throw Error('工程导出需更新后端后启用');
      lock(true);state('正在打包工程…');
      const response=await fetch('/api/projects/'+p.id+'/package');if(!response.ok)throw Error((await response.json()).error||'工程导出失败');
      const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=(p.brief.title||'NARRAFORM')+'.narra';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);state('工程已导出');
    }catch(error){state('');onError(error.message);}finally{lock(false);}
  });
  input.addEventListener('change',async()=>{
    const file=input.files[0];if(!file||pending)return;
    try{
      if(file.size>1_000_000_000)throw Error('工程包不能超过1GB');lock(true);state('正在导入工程…');
      const response=await fetch('/api/project-import',{method:'POST',headers:{'content-type':'application/octet-stream'},body:file});
      const result=await response.json();if(!response.ok)throw Error(result.error||'工程导入失败');
      await onImported(result.id);state('已恢复为新工程，请配置本机API后继续');document.getElementById('artifactStorageDialog').close();
    }catch(error){state('');onError(error.message);}finally{lock(false);input.value='';}
  });
}
