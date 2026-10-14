import {originalMaterialCount,imageOrigin,extractionButtons} from './material-images.js';
import {promptButton} from './provenance.js';
import {materialLimits} from './material-images.js';
const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size=n=>n>=1e6?(n/1e6).toFixed(1)+' MB':Math.max(1,Math.round(n/1e3))+' KB';
const reportExpansion=new Map();
let reportLayoutObserver=null,reportLayoutFrame=0;
export function layoutMaterialReports(root){
  reportLayoutObserver?.disconnect();
  cancelAnimationFrame(reportLayoutFrame);
  const grid=root.querySelector('.reading-grid');
  if(!grid)return;
  const cards=[...grid.children];
  const layout=()=>{
    const spans=cards.map(card=>Math.ceil(card.offsetHeight)+16);
    cards.forEach((card,i)=>card.style.gridRowEnd='span '+spans[i]);
    grid.classList.add('reading-masonry');
  };
  const schedule=()=>{
    cancelAnimationFrame(reportLayoutFrame);
    reportLayoutFrame=requestAnimationFrame(layout);
  };
  layout();
  reportLayoutObserver=new ResizeObserver(schedule);
  reportLayoutObserver.observe(grid);
  cards.forEach(card=>reportLayoutObserver.observe(card));
}
function materialReportExpanded(projectId,materialId){
  const key=projectId+':'+materialId;
  return reportExpansion.get(key)??false;
}
export function rememberMaterialReportExpansion(target){
  const projectId=target?.dataset?.materialReport,materialId=target?.dataset?.materialId;if(!projectId||!materialId)return;
  const key=projectId+':'+materialId;
  reportExpansion.set(key,target.open);
}
export function selectMaterialFiles(files,queue,existingCount=0){
  const added=[],skipped=[];let duplicates=0;
  for(const entry of files){const file=entry.file||entry,relativePath=entry.relativePath||file.webkitRelativePath||file.name;
    if(!/\.(pdf|docx|pptx|txt|md|csv|json|png|jpe?g)$/i.test(file.name)){skipped.push({path:relativePath,reason:'格式暂不支持'});continue;}
    if(!file.size||file.size>materialLimits.fileBytes){skipped.push({path:relativePath,reason:`文件为空或超过 ${materialLimits.fileMB} MB`});continue;}
    if([...queue,...added].some(q=>(q.relativePath||q.file.name)===relativePath&&q.file.size===file.size&&q.file.lastModified===file.lastModified)){duplicates++;continue;}
    if(existingCount+queue.length+added.length>=materialLimits.count){skipped.push({path:relativePath,reason:`超过项目 ${materialLimits.count} 份材料上限`});continue;}
    added.push({id:crypto.randomUUID(),file,relativePath,status:'queued'});
  }return {added,skipped,duplicates};
}
export async function uploadMaterialFile(projectId,entry,fetcher=fetch,streaming=true){
  let url=`/api/projects/${projectId}/materials`,options;
  if(streaming){
    const query=new URLSearchParams({name:entry.file.name,sourcePath:entry.relativePath||''});
    url+='?'+query;
    options={method:'POST',headers:{'content-type':'application/octet-stream'},body:entry.file};
  }else{
    if(entry.file.size>20_000_000)throw Error('后端尚未启用 500 MB 文件流上传，请重启服务后重试');
    const bytes=new Uint8Array(await entry.file.arrayBuffer());let binary='';
    for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    options={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:entry.file.name,sourcePath:entry.relativePath||'',base64:btoa(binary)})};
  }
  const response=await fetcher(url,options);
  const result=await response.json();if(!response.ok)throw Error(result.error||'材料发送失败');return result;
}
export async function droppedMaterialFiles(transfer){
  const entries=[...(transfer.items||[])].filter(i=>i.kind==='file').map(i=>i.webkitGetAsEntry?.());
  if(!entries.some(Boolean))return [...transfer.files];
  const out=[];
  async function walk(entry,parent=''){if(!entry)return;const relativePath=parent+entry.name;
    if(entry.isFile){const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));out.push({file,relativePath});}
    else if(entry.isDirectory){const reader=entry.createReader();for(;;){const batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!batch.length)break;for(const child of batch)await walk(child,relativePath+'/');}}
  }
  for(const entry of entries)await walk(entry);return out;
}
export const selectionReport=r=>!r?'':`<p>已加入 ${r.added.length} 份${r.duplicates?` · 重复 ${r.duplicates} 份`:''}${r.skipped.length?` · 跳过 ${r.skipped.length} 份`:''}</p>${r.skipped.length?`<details><summary>查看跳过的文件</summary><ul>${r.skipped.slice(0,30).map(s=>`<li>${h(s.path)} · ${h(s.reason)}</li>`).join('')}</ul>${r.skipped.length>30?`<p>另有 ${r.skipped.length-30} 份未列出。</p>`:''}</details>`:''}`;
export function queueRows(queue){return queue.map((q,i)=>`<div class="send-item"><span class="send-order">${String(i+1).padStart(2,'0')}</span><div><strong>${h(q.relativePath||q.file.name)}</strong><small>${size(q.file.size)} · ${h(q.error||({queued:'待发送',sending:'正在发送并提取文字…',sent:'已发送',failed:'发送失败'}[q.status]))}</small></div><button class="text-button" type="button" data-unqueue="${q.id}" aria-label="移除待发送文件 ${h(q.file.name)}" ${q.status==='sending'?'disabled':''}>×</button></div>`).join('');}
export function materialPanel(p,icon,queue,draft,report=null){const received=(p?.materials||[]).filter(m=>!m.reconstructed&&m.purpose!=='reconstruction'&&m.purpose!=='workflow-background');return `<section class="panel material-inbox" id="materialInbox"><div class="panel-heading"><div><span class="eyebrow">MATERIAL INPUT</span><h3>发送你的材料。</h3><p class="subtle">报告、数据、图片或一段文字，都可以成为演示的起点。</p></div><span class="tag">${originalMaterialCount(p)} / ${materialLimits.count} 份</span></div><div class="material-composer"><label class="upload-zone" for="fileInput"><div class="upload-icon">${icon('upload')}</div><strong>选择文件 / 拖入文件或文件夹</strong><p>PDF · Word · PPTX · TXT · MD · CSV · JSON · PNG · JPEG</p><small>单文件 ≤ ${materialLimits.fileMB} MB · 文档保留文字格式、表格与公式</small></label><input id="fileInput" class="file-input" type="file" multiple accept=".pdf,.docx,.pptx,.txt,.md,.csv,.json,.png,.jpg,.jpeg"><div class="folder-upload-row"><label class="secondary folder-upload-button" for="folderInput">${icon('folder')} 选择文件夹 ↗</label><span>包含子文件夹 · 自动筛选支持的文件</span></div><input id="folderInput" class="file-input" type="file" multiple webkitdirectory directory aria-label="选择材料文件夹"><div id="selectionReport" class="selection-report" aria-live="polite">${selectionReport(report)}</div><div id="sendQueue" class="send-queue" aria-live="polite">${queueRows(queue)}</div><label class="material-text-label" for="pasteText">补充文字<textarea id="pasteText" rows="3" maxlength="120000" placeholder="粘贴报告正文、背景说明或数据解释；也可以和文件一起发送。">${h(draft)}</textarea></label><div class="composer-footer"><span id="sendStatus" role="status">${queue.length?`${queue.length} 个文件待发送`:'材料先保存到本机；识别时才发送给你的模型。'}</span><button class="primary" id="sendMaterials" type="button">${icon('arrow')} 发送材料</button></div></div>${received.length?`<div class="received-heading"><span>已收到的材料</span><small>点击查看提取内容</small></div><div class="materials">${received.map(m=>`<div class="material received-material">${m.kind==='image'?`<img src="/api/projects/${p.id}/assets/${m.id}" alt="">`:`<span class="file-icon">${h(m.name.split('.').pop().toUpperCase())}</span>`}<div><button class="material-name" type="button" data-read-material="${m.id}">${h(m.name)}</button><small class="material-source-path">${h(m.extracted?imageOrigin(m):m.sourcePath||'')}</small><small>${m.kind==='image'?'独立图片':`${(m.text?.length||0).toLocaleString()} 字已提取`}${m.truncated?' · 已截取':''} · ${m.generated?'AI 补充图片':p.analysisCurrent&&p.analysis.readings.some(r=>r.id===m.id&&r.status==='read')?'已理解':'待识别'}</small>${m.generated?promptButton(m.id):''}${extractionButtons(m)}${m.needsOCR?'<small>含扫描页 · 部分页面无可提取文字</small>':''}</div><button class="text-button remove-material" data-remove-material="${m.id}" type="button" aria-label="移除材料 ${h(m.name)}">移除</button></div>`).join('')}</div>`:''}</section>${p?.materials.some(m=>!m.generated)?analysisPanel(p,icon):''}`;}
function analysisPanel(p,icon){const a=p.analysisCurrent?p.analysis:null,images=p.materials.some(m=>m.kind==='image'&&!m.generated),failed=p.task?.label==='识别与理解材料'&&['failed','cancelled','interrupted'].includes(p.task.status);return `<section class="panel material-analysis" id="materialAnalysis"><div class="panel-heading"><div><span class="eyebrow">READ & UNDERSTAND</span><h3>从材料，到有依据的内容。</h3><p class="subtle">识别材料类型，提炼核心信息，保留证据，找出缺口。</p></div><span class="tag">${a?.approvedAt?'理解已确认':a?'等待核对':'等待识别'}</span></div><div class="analysis-controls">${images?`<label class="checkbox"><input id="includeImages" type="checkbox" ${(p.pendingImageUnderstanding?.length||a?.includeImages||p.analysisDraft?.includeImages)?'checked':''} ${p.pendingImageUnderstanding?.length?'disabled':''}>同时识别图片内容（将原图发送给模型，需支持视觉）</label>`:'<span class="subtle">使用你在 API 设置中配置的模型</span>'}<button class="secondary" id="analyzeMaterials" type="button">${icon('spark')} ${p.analysisResumeCount?'继续识别材料':a?'重新识别材料':'识别与理解材料'}</button></div><p class="subtle analysis-cost">会将每份文档前 20,000 字发送给配置的 API，每份材料及综合整理分别调用模型；异常引用最多增加一次修正请求。超长部分不会纳入本轮分析。材料理解完成后，可在「02 逐页内容」中按需补充图片。三方向主题底图在「03 视觉方案」中规划、确认与生成。</p>${failed?`<div class="analysis-error" role="alert">${h(p.task.message)}<small>${p.analysisResumeCount?`已保存 ${p.analysisResumeCount} 份已读材料；材料、需求和识别选项不变时，重试将继续处理剩余部分。`:'材料仍保存在本机，可查看提取原文后重试。'}</small></div>`:''}${a?`<div class="analysis-summary"><span class="eyebrow">综合理解 · AI 生成 / 请核对</span><p>${h(a.summary)}</p></div><div class="reading-grid">${a.readings.map(r=>{const m=p.materials.find(m=>m.id===r.id);return `<details class="reading-card" data-material-report="${h(p.id)}" data-material-id="${h(r.id)}" ${materialReportExpanded(p.id,r.id)?'open':''}><summary><span class="reading-report-heading"><span class="reading-top"><span class="tag">${h(r.category)}</span><small>${r.status==='read'?(r.coverage==='image'?'已识别画面':r.partial?`部分读取 · ${r.readChars.toLocaleString()} 字`:'已读取文字'):'未分析'}</small></span><strong class="reading-name">${h(m?.name||r.id)}</strong></span><span class="reading-report-toggle"><span class="when-expanded">收起</span><span class="when-collapsed">展开</span><i aria-hidden="true"></i></span></summary><div class="reading-report-body"><p>${h(r.summary)}</p>${r.keyPoints.length?`<ul>${r.keyPoints.map(k=>`<li>${h(k)}</li>`).join('')}</ul>`:''}${r.facts.length?`<details><summary>关键证据 / ${r.facts.length}</summary>${r.facts.map(f=>`<div class="evidence"><strong>${h(f.claim)}</strong><blockquote>${h(f.quote)}</blockquote></div>`).join('')}</details>`:''}${r.suggestedUse?`<p class="reading-use"><b>使用建议</b>${h(r.suggestedUse)}</p>`:''}${r.questions.length?`<div class="reading-questions"><b>待确认</b><ul>${r.questions.map(q=>`<li>${h(q)}</li>`).join('')}</ul></div>`:''}</div></details>`;}).join('')}</div>${a.outline.length?`<div class="analysis-outline"><h4>建议内容主题</h4>${a.outline.map((o,i)=>`<div><span>${String(i+1).padStart(2,'0')}</span><div class="analysis-topic"><input data-analysis-title="${i}" aria-label="建议内容主题 ${i+1}" maxlength="150" required value="${h(o.title)}"><small>${o.sourceIds.map(id=>h(p.materials.find(m=>m.id===id)?.name||id)).join(' / ')||'用户需求'}</small></div></div>`).join('')}</div>`:''}${a.questions.length?`<div class="analysis-questions"><h4>还需要你确认</h4><ul>${a.questions.map(q=>`<li>${h(q)}</li>`).join('')}</ul></div>`:''}<label>你的补充与纠正<textarea id="analysisNotes" rows="3" maxlength="4000" placeholder="例如：统计周期为第二季度；不要采用尚未验证的预测数据。">${h(a.reviewNotes)}</textarea></label><div class="actions"><button class="primary" id="approveAnalysis" type="button">${icon('check')} ${a.approvedAt?'保存修改并确认':'确认材料理解'}</button></div>`:`<div class="analysis-empty"><span>${icon('content')}</span><p>收到材料后，先读懂它。<small>分析结果会在这里呈现；核对确认后用于生成逐页内容。</small></p></div>`}</section>`;}
