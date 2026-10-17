export const materialLimits=Object.freeze({count:200,fileBytes:500_000_000,fileMB:500,extractedImages:1000});
export const extractableDocuments=p=>(p?.materials||[]).filter(m=>!m.generated&&!m.extracted&&!m.reconstructed&&m.purpose!=='reconstruction'&&m.purpose!=='workflow-background'&&/\.(pdf|docx|pptx)$/i.test(m.file||m.name||''));
export function extractAllImagesButton(p){return extractableDocuments(p).length?`<button type="button" class="secondary" data-extract-all-images ${p.task?.status==='running'?'disabled':''} title="在本机提取全部 PDF、Word 和 PPTX 的内嵌图片，保留来源并跳过重复图片">一键提取图片 ↗</button>`:'';}
export const pageLimits=Object.freeze({min:1,max:30});
export const supplementImageTypes=Object.freeze([{id:'illustration',name:'主题配图'},{id:'scene',name:'场景图片'},{id:'flowchart',name:'流程图'},{id:'roadmap',name:'路线图'},{id:'mechanism',name:'机理图'},{id:'schematic',name:'结构示意图'},{id:'other',name:'其他图片'}]);
export const supplementInfo=m=>m?.supplementImage||m?.scientificFigure;
export function supplementImageRequests({imageTypes,instruction,imageName='',academicStyle=false,allowUpload=false}){
  if(!Array.isArray(imageTypes)||!imageTypes.length||imageTypes.some(id=>!supplementImageTypes.some(t=>t.id===id)))throw Error('请至少勾选一种图片类型');
  if(typeof instruction!=='string'||instruction.trim().length<2||instruction.trim().length>3000)throw Error('绘图要求须为 2–3000 字');
  if(typeof imageName!=='string'||imageName.trim().length>120)throw Error('图片名称最多120字');
  if(allowUpload!==true)throw Error('请确认将材料理解和绘图要求发送给配置的模型');
  return [...new Set(imageTypes)].map(imageType=>({action:'supplementImage',imageType,imageName:imageName.trim(),instruction:instruction.trim(),academicStyle:academicStyle===true,allowUpload:true}));
}
export const supplementImageDialog=`<dialog id="supplementImageDialog" class="visual-prompt-dialog supplement-image-dialog"><form id="supplementImageForm"><div class="modal-heading"><div><span class="eyebrow">CONTENT / IMAGE SUPPLEMENT</span><h2>补充图片</h2></div><button type="button" class="close" data-close="supplementImageDialog" aria-label="关闭补充图片">×</button></div><p class="subtle">结合已理解的材料与描述生成图片，完成后从素材库插入内容树。</p><fieldset class="supplement-image-types"><legend>图片类型 · 可多选，每类生成一张</legend>${supplementImageTypes.map(t=>`<label class="checkbox"><input name="imageTypes" type="checkbox" value="${t.id}" ${t.id==='illustration'?'checked':''}>${t.name}</label>`).join('')}</fieldset><label class="checkbox supplement-academic"><input name="academicStyle" type="checkbox">科研学术风格（可选）</label><label>你的绘图要求<textarea name="instruction" required minlength="2" maxlength="3000" rows="4" placeholder="描述希望补充的画面、内容和风格；可为每种图片分别说明要求。"></textarea></label><p id="supplementImageModel" class="subtle"></p><label class="checkbox"><input name="allowUpload" type="checkbox" required>将材料理解和绘图要求发送给配置的模型并消耗额度</label><p id="supplementImageState" class="subtle" role="status"></p><div class="actions"><button class="primary" type="submit">生成补充图片 ↗</button></div></form></dialog>`;
const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const originalMaterialCount=p=>p?.materials.filter(m=>!m.extracted&&!m.reconstructed).length||0;
export const imageOrigin=m=>m.extractionMethod==='manual-crop'?m.sourceMaterialName+' / 手动裁片':m.extracted?m.sourceMaterialName+' / '+(m.sourceLocations||[]).map(l=>l.page?'第 '+l.page+(l.unit==='slide'?' 张':' 页'):l.part==='word/document.xml'?'Word 正文':l.part?.includes('/header')?'Word 页眉':l.part?.includes('/footer')?'Word 页脚':'文档嵌入图').filter((v,i,a)=>a.indexOf(v)===i).join('、'):m.sourcePath||m.name;
export const materialImageDialog=`<dialog id="materialImageDialog" class="material-image-dialog"><div class="modal-heading"><div><span class="eyebrow">SOURCE / IMAGE LIBRARY</span><h2>从材料插图</h2></div><button type="button" class="close" data-close="materialImageDialog" aria-label="关闭素材库">×</button></div><div id="materialImageLibrary"></div></dialog>`;
export function extractionButtons(m,disabled=false){
  if(m.generated||m.reconstructed)return '';
  const manual=m.kind==='image'?`<button type="button" class="secondary" data-crop-material="${m.id}" ${disabled?'disabled':''}>手动裁切分离 ↗</button>`:'';
  if(m.extracted)return `<div class="image-extraction-actions">${manual}</div>`;
  const local=/\.(pdf|docx|pptx)$/i.test(m.file),region=m.kind==='image'||/\.pdf$/i.test(m.file);
  return `<div class="image-extraction-actions">${manual}${local?`<button type="button" class="secondary" data-extract-images="${m.id}" ${disabled?'disabled':''}>提取文档图片 ↗</button>`:''}${region?`<button type="button" class="secondary" data-separate-images="${m.id}" ${disabled?'disabled':''}>AI 识别分离 ↗</button>`:''}</div>`;
}
export function extractionReport(m){const r=m.imageExtraction;return !r?'':`<div class="image-extraction-report" role="status">已收录 ${r.total} 张 · 本次新增 ${r.added} 张${r.duplicates?' · 重复 '+r.duplicates+' 张':''}${r.warnings.map(w=>`<p>${h(w)}</p>`).join('')}</div>`;}
export function imageLibrary(p,editor,running=false){
  const sources=p.materials.filter(m=>!m.generated&&!m.extracted&&!m.reconstructed&&(m.kind==='image'||/\.(pdf|docx|pptx)$/i.test(m.file))),images=p.materials.filter(m=>m.kind==='image'&&!m.reconstructed&&m.purpose!=='reconstruction'&&m.purpose!=='workflow-background');
  return `<p class="subtle">${editor.nodeId?'替换所选图片字段':'插入第 '+(editor.page+1)+' 页内容树'} · ${images.length} 张原始 / 分离 / AI 补充图片</p><details class="image-library-sources" ${images.length?'':'open'}><summary>从已上传材料提取图片</summary><p class="subtle">文档原图在本机提取；AI 分离会把原页发送给视觉模型定位区域，再裁取原始像素。插入前请核对裁片。</p>${sources.map(m=>`<article><strong>${h(m.name)}</strong>${extractionButtons(m,running)}${extractionReport(m)}</article>`).join('')||'<p>请先在“需求与材料”中发送文件。</p>'}</details>${running?`<p class="image-extraction-report" role="status">${h(p.task.message||'正在处理材料…')}</p>`:''}<div class="material-image-grid">${images.map(m=>`<article class="material-image-card"><div class="material-image-thumb"><img src="/api/projects/${p.id}/assets/${m.id}" alt="${h(m.name)}" loading="lazy"></div><div><span class="tag">${m.generated?'AI 补充图片':m.extracted?m.extractionMethod==='manual-crop'?'手动裁片':m.extractionMethod==='region-crop'?'AI 定位 / 原图裁片':'文档原图':'上传原图'}</span><strong>${h(m.name)}</strong><small>${h(imageOrigin(m))}</small>${m.width?`<small>${m.width} × ${m.height}</small>`:''}${m.needsRegionReview?'<small>请核对边界、坐标和图例是否完整</small>':''}<div class="actions">${m.generated?`<button type="button" class="text-button" data-image-prompt="${m.id}">查看 / 修改提示词</button>`:''}<button type="button" class="text-button" data-read-material="${m.id}">放大核对</button><button type="button" class="primary" data-insert-material-image="${m.id}" ${running?'disabled':''}>${editor.nodeId?'替换图片':'插入内容树'} ↗</button></div></div></article>`).join('')}</div>${images.length?'':'<div class="design-empty">提取完成后，图片会显示在这里。</div>'}`;
}

const clamp=(n,min=0,max=1000)=>Math.max(min,Math.min(max,n));
export function cropSelection(a,b){
  const x=Math.round(clamp(Math.min(a.x,b.x))),y=Math.round(clamp(Math.min(a.y,b.y))),right=Math.round(clamp(Math.max(a.x,b.x))),bottom=Math.round(clamp(Math.max(a.y,b.y)));
  return {x,y,w:right-x,h:bottom-y};
}
export function adjustCrop(box,dx,dy,handle='move'){
  dx=Math.round(dx);dy=Math.round(dy);
  if(handle==='move')return {...box,x:clamp(box.x+dx,0,1000-box.w),y:clamp(box.y+dy,0,1000-box.h)};
  let {x,y,w,h}=box,right=x+w,bottom=y+h;
  if(handle.includes('w'))x=clamp(x+dx,0,right-1);
  if(handle.includes('e'))right=clamp(right+dx,x+1,1000);
  if(handle.includes('n'))y=clamp(y+dy,0,bottom-1);
  if(handle.includes('s'))bottom=clamp(bottom+dy,y+1,1000);
  return {x,y,w:right-x,h:bottom-y};
}
export function initMaterialCropEditor({getProject,act,busy,onError}){
  document.body.insertAdjacentHTML('beforeend',`<dialog id="materialCropDialog" class="material-crop-dialog"><div class="modal-heading"><div><span class="eyebrow">SOURCE / MANUAL SEPARATION</span><h2>手动裁切分离</h2><p id="materialCropName" class="subtle"></p></div><button type="button" class="close" data-crop-close aria-label="关闭裁切窗口">×</button></div><p class="crop-guidance">在原图上拖动框选多个区域，拖动裁切框或边角调整范围。每个区域保存为独立图片，原图完整保留。</p><div class="crop-editor-layout"><div class="crop-canvas-panel"><div id="materialCropStage" class="crop-stage"><img id="materialCropImage" alt="待裁切原图" draggable="false"><div id="materialCropBoxes" class="crop-boxes"></div></div></div><div class="crop-regions-panel"><div class="panel-heading"><h3>裁切区域 <small id="materialCropCount">0 / 25</small></h3><button type="button" class="text-button" id="materialCropAdd">＋ 裁切框</button></div><div id="materialCropRegions"></div></div></div><div class="modal-actions crop-footer"><p id="materialCropState" class="subtle" role="status"></p><button type="button" class="primary" id="materialCropSave">保存裁片并重新理解 ↗</button></div></dialog>`);
  const dialog=document.querySelector('#materialCropDialog'),$=s=>dialog.querySelector(s),stage=$('#materialCropStage'),image=$('#materialCropImage');
  let context=null,regions=[],selected=-1,gesture=null,saving=false;
  const current=()=>getProject()?.id===context?.projectId;
  function renderBoxes(){
    $('#materialCropBoxes').innerHTML=regions.map((r,i)=>`<div class="crop-box ${i===selected?'selected':''}" data-crop-region="${i}" style="left:${r.box.x/10}%;top:${r.box.y/10}%;width:${r.box.w/10}%;height:${r.box.h/10}%"><span class="crop-box-index">${i+1}</span>${i===selected?['nw','n','ne','e','se','s','sw','w'].map(handle=>`<span class="crop-handle crop-handle-${handle}" data-crop-handle="${handle}" aria-hidden="true"></span>`).join(''):''}</div>`).join('');
  }
  function render(){
    renderBoxes();$('#materialCropCount').textContent=regions.length+' / 25';$('#materialCropAdd').disabled=saving||regions.length>=25;
    $('#materialCropSave').disabled=saving||!regions.length||!image.naturalWidth||busy();
    $('#materialCropRegions').innerHTML=regions.length?regions.map((r,i)=>`<section class="crop-region ${i===selected?'selected':''}" data-crop-list="${i}"><div class="crop-region-heading"><button type="button" class="text-button" data-crop-select="${i}" aria-label="选择裁切区域 ${i+1}">${String(i+1).padStart(2,'0')}</button><input data-crop-label="${i}" value="${h(r.label)}" maxlength="120" aria-label="裁片 ${i+1} 名称"><button type="button" class="text-button" data-crop-remove="${i}" aria-label="删除裁切区域 ${i+1}">×</button></div><div class="crop-dimensions">${[['x','左'],['y','上'],['w','宽'],['h','高']].map(([key,label])=>`<label>${label} %<input type="number" min="${key==='w'||key==='h'?'.1':'0'}" max="100" step=".1" value="${r.box[key]/10}" data-crop-dimension="${key}" data-crop-index="${i}" aria-label="裁片 ${i+1} ${label}百分比"></label>`).join('')}</div></section>`).join(''):'<div class="crop-empty">拖动框选第一张裁片，<br>或点击「＋ 裁切框」。</div>';
    $('#materialCropSave').textContent=getProject()?.apiReady?'保存裁片并重新理解 ↗':'保存裁片 · 待配置模型理解 ↗';
  }
  image.addEventListener('load',()=>{stage.style.setProperty('--crop-aspect',image.naturalWidth/image.naturalHeight);render();});
  image.addEventListener('error',()=>{$('#materialCropState').textContent='原图加载失败，请关闭后重试';$('#materialCropSave').disabled=true;});
  const point=e=>{const rect=stage.getBoundingClientRect();return {x:clamp((e.clientX-rect.left)/rect.width*1000),y:clamp((e.clientY-rect.top)/rect.height*1000)};};
  stage.addEventListener('pointerdown',e=>{
    if(saving||busy()||e.button!==0||!image.naturalWidth)return;e.preventDefault();const a=point(e),box=e.target.closest('[data-crop-region]'),handle=e.target.closest('[data-crop-handle]')?.dataset.cropHandle;
    if(box){selected=Number(box.dataset.cropRegion);gesture={id:e.pointerId,a,box:{...regions[selected].box},handle:handle||'move',created:false};}
    else{if(regions.length>=25)return;selected=regions.length;regions.push({label:'裁片 '+(selected+1),box:cropSelection(a,a)});gesture={id:e.pointerId,a,created:true};}
    stage.setPointerCapture(e.pointerId);renderBoxes();
  });
  stage.addEventListener('pointermove',e=>{
    if(!gesture||gesture.id!==e.pointerId)return;const b=point(e);regions[selected].box=gesture.created?cropSelection(gesture.a,b):adjustCrop(gesture.box,b.x-gesture.a.x,b.y-gesture.a.y,gesture.handle);renderBoxes();
  });
  function finish(e,cancel=false){if(!gesture||gesture.id!==e.pointerId)return;
    if(cancel){if(gesture.created)regions.splice(selected,1);else regions[selected].box=gesture.box;}
    else if(regions[selected].box.w<1||regions[selected].box.h<1)regions.splice(selected,1);
    gesture=null;selected=Math.min(selected,regions.length-1);render();
  }
  stage.addEventListener('pointerup',e=>finish(e));stage.addEventListener('pointercancel',e=>finish(e,true));
  dialog.addEventListener('input',e=>{const input=e.target;if(input.dataset.cropLabel!==undefined)regions[Number(input.dataset.cropLabel)].label=input.value;});
  dialog.addEventListener('change',e=>{const input=e.target;if(!input.dataset.cropDimension)return;const r=regions[Number(input.dataset.cropIndex)],key=input.dataset.cropDimension,n=Number(input.value)*10;
    if(Number.isFinite(n)){r.box[key]=Math.round(clamp(n,key==='w'||key==='h'?1:0));r.box.w=clamp(r.box.w,1,1000-r.box.x);r.box.h=clamp(r.box.h,1,1000-r.box.y);r.box.x=Math.min(r.box.x,999);r.box.y=Math.min(r.box.y,999);r.box.w=Math.min(r.box.w,1000-r.box.x);r.box.h=Math.min(r.box.h,1000-r.box.y);}render();});
  dialog.addEventListener('click',e=>{e.stopPropagation();const button=e.target.closest('button');if(!button||saving)return;
    if(button.hasAttribute('data-crop-close'))dialog.close();
    else if(button.id==='materialCropAdd'){if(regions.length<25){selected=regions.length;regions.push({label:'裁片 '+(selected+1),box:{x:100,y:100,w:600,h:600}});render();}}
    else if(button.dataset.cropSelect!==undefined){selected=Number(button.dataset.cropSelect);render();}
    else if(button.dataset.cropRemove!==undefined){regions.splice(Number(button.dataset.cropRemove),1);selected=Math.min(selected,regions.length-1);render();}
    else if(button.id==='materialCropSave')Promise.resolve().then(async()=>{
      if(!current())throw Error('项目已变化，请重新打开裁切窗口');if(busy())throw Error('请等待当前任务完成');if(!getProject()?.manualCropEnabled)throw Error('请先重启本地服务，启用手动裁切与重新理解');
      if(!regions.length||regions.some(r=>!r.label.trim()||r.box.w<1||r.box.h<1))throw Error('请填写裁片名称并框选有效区域');
      saving=true;render();$('#materialCropState').textContent='正在保存独立裁片，原图不会修改…';
      try{await act('cropMaterialImages',{id:context.id,sourceHash:context.sourceHash,regions:structuredClone(regions)},0);dialog.close();}
      finally{saving=false;if(dialog.open)render();}
    }).catch(e=>{$('#materialCropState').textContent=e.message;onError(e.message);});
  });
  return {open(id){if(busy())throw Error('请等待当前任务完成');const p=getProject(),m=p?.materials.find(m=>m.id===id&&m.kind==='image'&&!m.generated);if(!m)throw Error('请选择原始图片或已分离图片');
    context={projectId:p.id,id,sourceHash:m.sha256};regions=[];selected=-1;gesture=null;$('#materialCropName').textContent=m.name;image.src=`/api/projects/${p.id}/assets/${m.id}`;$('#materialCropState').textContent=p.apiReady?'保存后使用主模型重新理解新裁片，结果需核对确认。':'尚未配置主模型：可先保存裁片，配置后重新理解。';dialog.showModal();render();},close(){dialog.close();context=null;gesture=null;}};
}

// Shared image editing helpers stay in this established browser entry point.
export function imageEditRegion(value){
  if(value==null)return null;
  if(typeof value!=='object'||Array.isArray(value))throw Error('框选位置格式无效');
  const keys=['x','y','w','h'];
  if(keys.some(k=>typeof value[k]!=='number'||!Number.isFinite(value[k])))throw Error('框选位置须为有效坐标');
  const r=Object.fromEntries(keys.map(k=>[k,Math.round(value[k]*100)/100]));
  if(r.x<0||r.y<0||r.w<1||r.h<1||r.x+r.w>1000||r.y+r.h>1000)throw Error('框选位置须在图片内，请重新框选');
  return r;
}
export const sameImageEditRegion=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);


export function initImageEditRegion({stage,image,overlay,toggle,clear,status,onChange}){
  let region=null,gesture=null,enabled=false,active=false;
  function paint(){
    overlay.hidden=!region||!enabled;stage.classList.toggle('selecting',enabled&&active);
    toggle.disabled=!enabled;toggle.setAttribute('aria-pressed',String(enabled&&active));
    toggle.textContent=active?'拖动框选 / 调整位置':'框选修改位置';clear.disabled=!enabled||!region;
    status.textContent=region?'已框选 · 仅作定位提示':'可选 · 框选提示修改位置';
    if(region)Object.assign(overlay.style,{left:region.x/10+'%',top:region.y/10+'%',width:region.w/10+'%',height:region.h/10+'%'});
  }
  function commit(){onChange?.(region?{...region}:null);paint();}
  function point(e){const r=image.getBoundingClientRect();return {x:Math.max(0,Math.min(1000,(e.clientX-r.left)/r.width*1000)),y:Math.max(0,Math.min(1000,(e.clientY-r.top)/r.height*1000))};}
  toggle.addEventListener('click',()=>{if(!enabled)return;active=!active;paint();});
  clear.addEventListener('click',()=>{if(!enabled)return;region=null;active=false;commit();});
  stage.addEventListener('pointerdown',e=>{
    if(!enabled||!active||e.button!==0||!image.complete||!image.naturalWidth)return;
    const r=image.getBoundingClientRect();if(!r.width||!r.height)return;
    e.preventDefault();stage.setPointerCapture(e.pointerId);
    const a=point(e),handle=e.target.closest('[data-edit-region-handle]')?.dataset.editRegionHandle;
    gesture={id:e.pointerId,a,previous:region?{...region}:null,handle:handle||(e.target.closest('#aiEditRegionSelection')?'move':'draw')};
    if(gesture.handle==='draw')region=cropSelection(a,a);paint();
  });
  stage.addEventListener('pointermove',e=>{
    if(!gesture||e.pointerId!==gesture.id)return;const b=point(e);
    region=gesture.handle==='draw'?cropSelection(gesture.a,b):adjustCrop(gesture.previous,b.x-gesture.a.x,b.y-gesture.a.y,gesture.handle);paint();
  });
  function finish(e,cancel=false){
    if(!gesture||e.pointerId!==gesture.id)return;
    if(cancel||!region||region.w<2||region.h<2)region=gesture.previous;
    gesture=null;if(stage.hasPointerCapture?.(e.pointerId))stage.releasePointerCapture(e.pointerId);commit();
  }
  stage.addEventListener('pointerup',e=>finish(e));stage.addEventListener('pointercancel',e=>finish(e,true));
  return {get value(){return region?{...region}:null;},setEnabled(value){if(!value&&gesture){region=gesture.previous;gesture=null;}enabled=value;paint();},
    reset(value=null){region=imageEditRegion(value);gesture=null;active=!!region;paint();}};
}
