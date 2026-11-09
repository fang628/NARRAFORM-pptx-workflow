import {initialElements,orderedElements,descendants,syncLegacy,moveElementBranch,elementLevelTarget,setImageAnnotation,isImageAnnotation,tableLimits} from '/elements-model.js';
import {formulaEditorMarkup,collectFormula,bindFormulaEditors} from './formula-editor.js';
export {bindFormulaEditors};
import {promptButton} from './provenance.js';
const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={text:'文本',image:'图片',shape:'形状',group:'小标题',table:'表格',formula:'公式'};
const folded=new Set();
const nodeName=n=>n.type==='group'?(n.text||n.label):n.type==='text'?({title:'标题',subtitle:'副标题',body:'文本',imageTitle:'图片标题',caption:'图注'}[n.role]||'文本'):names[n.type];
function circuitLink(kind){
  const subtitle=kind==='subtitle',level=kind==='level',width=subtitle?42:24;
  return `<svg class="${subtitle?'subtitle-circuit':'tree-circuit-link tree-circuit-'+kind}" viewBox="0 0 ${width} 24" aria-hidden="true"><path d="${level?'M3 -3V8l12 12h6':subtitle?'M3 0v2l12 12h24.5':'M3 0v2l12 12h6.5'}"/>${level?'':`<circle cx="${width}" cy="14" r="2.5"/>`}</svg>`;
}

function nodePreview(n,m,p,i,nodes){
  if(n.type==='formula')return formulaEditorMarkup(n);
  if(n.type==='table')return `<div class="tree-table-content"><div class="tree-table-scroll"><table aria-label="可编辑表格"><thead><tr>${n.headers.map((v,c)=>`<th><textarea class="tree-inline-text tree-table-cell" rows="1" maxlength="600" data-table-cell="${c}" data-table-row="header" aria-label="表头第 ${c+1} 列">${h(v)}</textarea></th>`).join('')}</tr></thead><tbody>${n.rows.map((row,r)=>`<tr>${row.map((v,c)=>`<td><textarea class="tree-inline-text tree-table-cell" rows="1" maxlength="600" data-table-cell="${c}" data-table-row="${r}" aria-label="表格第 ${r+1} 行第 ${c+1} 列">${h(v)}</textarea></td>`).join('')}<td class="tree-table-row-action"><button type="button" class="text-button danger" data-element-action="table-remove-row" data-node-id="${h(n.id)}" data-element-type="${r}" data-page="${i}" ${n.rows.length===1?'disabled':''} aria-label="删除表格第 ${r+1} 行">×</button></td></tr>`).join('')}</tbody></table></div><div class="tree-table-actions"><span>${n.rows.length} 行 / ${n.headers.length} 列</span><button type="button" class="text-button" data-element-action="table-add-row" data-node-id="${h(n.id)}" data-page="${i}">＋ 行</button><button type="button" class="text-button" data-element-action="table-add-column" data-node-id="${h(n.id)}" data-page="${i}">＋ 列</button><select aria-label="待删除的表格列" data-table-column>${n.headers.map((v,c)=>`<option value="${c}">${h(v||'第 '+(c+1)+' 列')}</option>`).join('')}</select><button type="button" class="text-button danger" data-element-action="table-remove-column" data-node-id="${h(n.id)}" data-page="${i}" ${n.headers.length===1?'disabled':''}>删除列</button></div></div>`;
  if(n.type==='text')return `<textarea class="tree-text-preview tree-inline-text" aria-label="${h(nodeName(n))}文字" data-node-field="text" rows="1" maxlength="${n.role==='title'?60:n.role==='subtitle'?120:600}" required>${h(n.text)}</textarea>`;
  if(n.type==='image'){
    const captions=nodes.filter(c=>c.parentId===n.id&&isImageAnnotation(c));
    const fields=captions.length?captions.slice(0,1):[{id:'caption-'+crypto.randomUUID(),role:'caption',text:''}];
    return `<div class="tree-image-content"><div class="tree-image-preview">${m?`<button type="button" class="tree-image-open" data-view-tree-image="${h(m.id)}" aria-label="放大查看${h(nodeName(n))}" title="点击查看完整图片"><img draggable="false" src="/api/projects/${p.id}/assets/${m.id}" alt="${h(nodeName(n))}"></button><div><span>${h(m.name)}</span>${m.generated?promptButton(m.id,i,n.id):''}</div>`:'<span class="tree-empty-image">＋ 等待插入图片</span>'}</div><div class="tree-image-captions">${fields.map((caption,j)=>`<div class="tree-image-annotation"><select class="tree-annotation-role" aria-label="${h(nodeName(n))}的说明类型" data-caption-role="${h(caption.id)}"><option value="imageTitle" ${caption.role==='imageTitle'?'selected':''}>图片标题</option><option value="caption" ${caption.role!=='imageTitle'?'selected':''}>图注</option></select><textarea class="tree-caption-inline" aria-label="${h(nodeName(n))}的${caption.role==='imageTitle'?'图片标题':'图注'}" data-image-caption="${h(n.id)}" data-caption-node="${h(caption.id)}" rows="1" maxlength="600" placeholder="${caption.role==='imageTitle'?'添加图片标题…':'添加图注…'}">${h(caption.text)}</textarea></div>`).join('')}</div></div>`;
  }
  if(n.type==='group')return `<textarea class="tree-inline-text tree-group-text" aria-label="小标题文字" data-node-field="text" rows="1" maxlength="80" required>${h(n.text||n.label)}</textarea><button type="button" class="tree-group-preview tree-relation-toggle" data-element-action="toggle-relation" data-node-id="${h(n.id)}" data-page="${i}" aria-label="切换子项关系，当前${n.childRelation==='sequence'?'递进':'并列'}" title="点击切换并列或递进"><svg class="tree-relation-icon" viewBox="0 0 18 18" aria-hidden="true"><path d="${n.childRelation==='sequence'?'M3 4h6v10h6M12 11l3 3-3 3':'M3 3v12M3 5h12M3 13h12'}"/></svg>子项${n.childRelation==='sequence'?'递进 · 有序列表':'并列 · 无序列表'}<span>${n.childRelation==='sequence'?'SEQUENCE':'PARALLEL'} CIRCUIT ↔</span></button>`;
  return `<div class="tree-shape-preview"><i style="background:#${n.color||'FFF238'}"></i><span>矩形 / #${h(n.color||'FFF238')}</span></div>`;
}
export function elementEditor(p,s,i){
  const nodes=initialElements(s),pageTitle=nodes.find(n=>n.type==='text'&&n.role==='title'),images=p.materials.filter(m=>m.kind==='image'&&!m.excludedFromContent&&!m.reconstructed&&m.purpose!=='reconstruction'&&m.purpose!=='workflow-background'),foldKey=id=>`${p.id}:${i}:${id}`;
  const embeddedCaptions=new Map(nodes.filter(n=>isImageAnnotation(n)&&nodes.some(o=>o.id===n.parentId&&o.type==='image')).map(n=>[n.id,n]));
  const visibleNodes=nodes.filter(n=>!embeddedCaptions.has(n.id));
  const displayParent=n=>embeddedCaptions.get(n.parentId)?.parentId||n.parentId;
  function renderNode(n,depth){const excluded=descendants(nodes,n.id),isTitle=n.type==='text'&&n.role==='title',header=n.type==='text'&&['title','subtitle'].includes(n.role),m=p.materials.find(m=>m.kind==='image'&&m.id===n.materialId),children=visibleNodes.filter(o=>displayParent(o)===n.id);
    return `<article class="element-node" data-field-type="${n.type}" data-field-role="${h(n.role||'body')}" data-node="${h(n.id)}" data-parent-node="${h(displayParent(n)||'')}" style="--depth:${depth}"><div class="element-node-head"><button type="button" class="tree-drag-handle" data-tree-drag="${h(n.id)}" ${header?'disabled':''} aria-label="拖动 ${h(nodeName(n))}，调整顺序或附属关系" title="左右滑动调整层级；上下拖动排列分支"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 7h10M5 12h10"/></svg></button>${children.length&&!header?`<button type="button" class="element-type tree-type-fold" data-tree-fold="${h(n.id)}" aria-expanded="${!folded.has(foldKey(n.id))}" aria-label="展开或收起 ${h(nodeName(n))} 的附属项" title="点击标签展开或收起子项">${names[n.type]}</button>`:`<span class="element-type">${n.type==='text'&&n.role==='title'?'标题':n.type==='text'&&n.role==='subtitle'?'副标题':isImageAnnotation(n)&&nodes.some(o=>o.id===n.parentId&&o.type==='image')?(n.role==='imageTitle'?'图片标题':'图注'):names[n.type]}</span>`}<span class="element-relation">${String(depth+1).padStart(2,'0')} / ${children.length?children.length+' 支路':'终端'}</span><span class="tree-item-accent" aria-hidden="true"></span>${isTitle?'<span class="tree-title-accent" aria-hidden="true"></span><span class="tree-required" title="每页必须保留一个标题">必填</span>':`<button class="tree-delete-field" type="button" data-element-action="remove" data-node-id="${h(n.id)}" data-page="${i}" aria-label="删除字段：${h(nodeName(n))}" title="删除字段，保留其附属内容"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5.5h12M8 5.5V3.5h4v2M6 5.5l.7 11h6.6l.7-11M8.5 8v6M11.5 8v6"/></svg><span>删除</span></button>`}</div>${nodePreview(n,m,p,i,nodes)}<details class="tree-node-editor"><summary>编辑内容与关系 <span>↗</span></summary><div class="tree-editor-fields">${n.type==='text'?`<div class="element-text-line"><select aria-label="文字用途" data-node-field="role" ${isTitle?'disabled':''}>${[['title','页面标题'],['subtitle','副标题'],['body','正文'],['imageTitle','图片标题'],['caption','图注 / 附属说明']].filter(([v])=>isTitle||v!=='title').map(([v,label])=>`<option value="${v}" ${n.role===v?'selected':''}>${label}</option>`).join('')}</select></div>`:''}${n.type==='image'?`<div class="element-image"><div class="element-thumbnail">${m?`<button type="button" class="tree-image-open" data-view-tree-image="${h(m.id)}" aria-label="放大查看${h(nodeName(n))}" title="点击查看完整图片"><img draggable="false" src="/api/projects/${p.id}/assets/${m.id}" alt="${h(nodeName(n))}"></button>`:'<span>等待插入图片</span>'}</div><div><label>图片素材<select aria-label="图片素材" data-node-field="materialId"><option value="">暂不插入</option>${images.map(m=>`<option value="${m.id}" ${m.id===n.materialId?'selected':''}>${h(m.name)}</option>`).join('')}</select></label><button type="button" class="secondary" data-material-image-picker="${i}" data-image-node="${h(n.id)}">从材料选图</button><button type="button" class="secondary" data-element-generate="${h(n.id)}" data-page="${i}">生成元素图 ↗</button>${m?.generated?promptButton(m.id,i,n.id):''}</div></div>`:''}${n.type==='shape'?`<label>形状颜色<input type="color" aria-label="形状颜色" data-node-field="color" value="#${n.color||'FFF238'}"></label>`:''}<details class="element-relationship-settings"><summary>调整层级与排列 · ${n.layout==='row'?'子项并排':'子项纵向'}</summary><div class="element-settings"><label>附属于<select aria-label="上级元素" data-node-field="parentId" ${header?'disabled':''}><option value="">${isTitle?'标题 · 固定最高项':'标题下方第一层'}</option>${nodes.filter(o=>!excluded.has(o.id)).map(o=>`<option value="${h(o.id)}" ${n.parentId===o.id?'selected':''}>${h(nodeName(o))} · ${names[o.type]}</option>`).join('')}</select></label><label>子项排列<select aria-label="子项排列" data-node-field="layout"><option value="stack" ${n.layout!=='row'?'selected':''}>纵向排列</option><option value="row" ${n.layout==='row'?'selected':''}>横向并排</option></select></label></div></details><div class="element-node-actions"><button class="text-button" type="button" data-element-action="child" data-node-id="${h(n.id)}" data-page="${i}">＋ 附属文本</button><button class="text-button" type="button" data-link-source="${i}" data-source-target="element:${h(n.id)}">关联原材料</button><span></span>${(header?[]:['up','down']).map(a=>`<button class="text-button" type="button" data-element-action="${a}" data-node-id="${h(n.id)}" data-page="${i}">${{up:'↑',down:'↓',remove:'移除'}[a]}</button>`).join('')}</div></div></details></article>`;
  }
  function level(parentId,depth){const siblings=visibleNodes.filter(n=>displayParent(n)===parentId&&n.id!==pageTitle.id&&!(parentId===pageTitle.id&&n.type==='text'&&n.role==='subtitle'));if(!siblings.length)return '';
    const parent=nodes.find(n=>n.id===parentId),sequence=parent?.childRelation==='sequence',tag=sequence?'ol':'ul';
    return `<div class="tree-level" data-tree-parent="${h(parentId||'')}">${circuitLink('level')}<div class="tree-level-meta"><span class="circuit-pad" aria-hidden="true"></span><b>${siblings.length>1?(sequence?'递进':'并列'):parentId?'附属':'顶层'} · ${String(siblings.length).padStart(2,'0')}</b><span>${parent?h(nodeName(parent)):'PAGE ROOT'}</span></div><${tag} class="tree-siblings" aria-label="${sequence?'递进':'并列'}节点，${siblings.length} 项">${siblings.map(n=>`<li class="tree-branch" data-tree-branch="${h(n.id)}">${circuitLink('entry')}${renderNode(n,depth)}<div class="tree-children" data-tree-children="${h(n.id)}" ${folded.has(foldKey(n.id))?'hidden':''}>${level(n.id,depth+1)}</div></li>`).join('')}</${tag}></div>`;
  }
  return `<section class="element-studio"><div class="element-studio-head"><div><h3>内容关系树 <small>${visibleNodes.length-1} 个内容字段</small></h3></div><button type="button" class="secondary" data-element-action="recognize" data-page="${i}">AI 识别关系 ↗</button></div><label class="checkbox relation-vision"><input type="checkbox" data-relation-vision="${i}">识别时一并发送本页图片给视觉模型</label><div class="element-tree circuit-tree" data-tree-page="${i}" data-tree-key="${p.id}:${i}" aria-label="第 ${i+1} 页内容关系树"><div class="tree-title-root" role="listitem" data-tree-branch="${h(pageTitle.id)}"><div class="tree-heading-family"><div class="page-title-field">${renderNode(pageTitle,0)}</div><div class="tree-heading-subtitles">${nodes.filter(n=>n.type==='text'&&n.role==='subtitle').map(n=>`<div class="tree-subtitle-branch" data-tree-branch="${h(n.id)}">${renderNode(n,1)}</div>`).join('')}</div></div><div class="tree-content-root tree-children" data-tree-children="${h(pageTitle.id)}">${nodes.filter(n=>n.type==='text'&&n.role==='subtitle').map(n=>`<div class="tree-children" data-tree-children="${h(n.id)}">${level(n.id,2)}</div>`).join('')}${level(pageTitle.id,1)}</div></div><div class="tree-root-drop" data-tree-root-drop>移回标题下方</div><div class="tree-live-status" role="status" aria-live="polite"></div></div><div class="element-add"><button class="text-button" type="button" data-tree-undo="${i}" disabled>↶ 撤销操作</button>${!nodes.some(n=>n.type==='text'&&n.role==='subtitle')?`<button type="button" class="secondary" data-element-action="subtitle" data-page="${i}">＋ 副标题</button>`:''}${['text','image','group',...(p.tableContentEnabled?['table']:[]),...(p.formulaContentEnabled?['formula']:[])].map(type=>`<button type="button" class="secondary" data-element-action="add" data-element-type="${type}" data-page="${i}">＋ ${names[type]}</button>`).join('')}<button type="button" class="secondary" data-material-image-picker="${i}">从材料插图 ↗</button><button type="button" class="primary" data-element-action="save" data-page="${i}" ${!p.pageContentSaveEnabled?'disabled title="重启服务后启用单页保存"':''}>保存本页内容 ↗</button></div><p class="element-save-state subtle" role="status"></p></section>`;
}
const nodesTitleId=s=>initialElements(s).find(n=>n.type==='text'&&n.role==='title').id;
export function collectElementSlide(el,s){let nodes=initialElements(s).map(n=>{const row=el.querySelector(`[data-node="${n.id}"]`);if(!row)return n;const next={...n};row.querySelectorAll('[data-node-field]').forEach(f=>{next[f.dataset.nodeField]=f.dataset.nodeField==='color'?f.value.slice(1):(['parentId','materialId'].includes(f.dataset.nodeField)?f.value||null:f.value);});if(next.type==='table'){next.headers=[...n.headers];next.rows=n.rows.map(row=>[...row]);row.querySelectorAll('[data-table-cell]').forEach(f=>{const cells=f.dataset.tableRow==='header'?next.headers:next.rows[Number(f.dataset.tableRow)];cells[Number(f.dataset.tableCell)]=f.value;});}if(next.type==='formula')Object.assign(next,collectFormula(row,n));if(next.type==='group')next.label=next.text;if(next.type==='text'&&next.role==='subtitle')next.parentId=nodesTitleId(s);if(next.id!==nodesTitleId(s)&&!next.parentId)next.parentId=nodesTitleId(s);return next;});
  const removedCaptions=new Set();
  el.querySelectorAll('[data-image-caption]').forEach(f=>{
    const id=f.dataset.captionNode,existing=nodes.find(n=>n.id===id),role=el.querySelector('select[data-caption-role="'+id+'"]')?.value||existing?.role||'caption';
    const duplicates=nodes.filter(n=>n.parentId===f.dataset.imageCaption&&isImageAnnotation(n));
    if(f.value===f.defaultValue&&(!existing||existing.role===role)&&duplicates.length<=1)return;
    const previousIds=duplicates.map(n=>n.id);nodes=setImageAnnotation(nodes,f.dataset.imageCaption,id,f.value,role);
    for(const previousId of previousIds)if(!nodes.some(n=>n.id===previousId))removedCaptions.add('element:'+previousId);
  });
  const changedImages=nodes.filter(n=>n.type==='image'&&n.materialId!==s.elements?.find(o=>o.id===n.id)?.materialId&&s.elements).map(n=>'element:'+n.id);const sourceLinks=(s.sourceLinks||[]).filter(l=>!changedImages.includes(l.target)&&!removedCaptions.has(l.target)).map(l=>{if(s.elements)return l;const target=l.target.startsWith('body:')?'element:body-'+l.target.slice(5):['title','subtitle','image'].includes(l.target)?'element:'+l.target:l.target;return {...l,target};});return syncLegacy({...s,elements:nodes,sourceLinks});}
export function syncCaptionFields(el,field){
  if(field.matches('[data-caption-role]')){
    const input=[...el.querySelectorAll('[data-image-caption]')].find(f=>f.dataset.captionNode===field.dataset.captionRole);
    if(input){const name=field.value==='imageTitle'?'图片标题':'图注';input.placeholder='添加'+name+'…';input.setAttribute('aria-label',name);}
    positionImageAnnotation(field);
  }else if(field.matches('[data-image-caption]')){
    const row=[...el.querySelectorAll('[data-node]')].find(n=>n.dataset.node===field.dataset.captionNode);
    const text=row?.querySelector('[data-node-field="text"]');if(text)text.value=field.value;
    if(text)resizeInlineText(text);
  }else if(field.matches('[data-node-field="text"],[data-node-field="role"],[data-node-field="parentId"]')){
    const row=field.closest('[data-node]'),input=[...el.querySelectorAll('[data-image-caption]')].find(f=>f.dataset.captionNode===row.dataset.node);
    if(!input)return;
    if(field.dataset.nodeField==='text')input.value=field.value;
    // Moving or reclassifying the caption leaves its text on the node, without recreating it under the image.
    else{input.value='';input.defaultValue='';}
  }
}
function positionImageAnnotation(select){
  const annotation=select.closest('.tree-image-annotation'),node=annotation?.closest('[data-node][data-field-type="image"]');
  if(!node)return;
  const host=node.querySelector(':scope > .element-node-head');
  if(!host)return;
  annotation.classList.add('tree-header-annotation');node.classList.add('has-header-annotation');
  if(annotation.parentElement!==host)host.append(annotation);
}
export function mutateElements(s,action,id,type){const nodes=s.elements,n=nodes.find(n=>n.id===id);if(action==='toggle-relation'){if(n?.type!=='group')throw Error('小标题已变化，请刷新后重试');n.childRelation=n.childRelation==='sequence'?'parallel':'sequence';return syncLegacy(s);}if(action.startsWith('table-')){if(n?.type!=='table')throw Error('表格项已变化，请刷新后重试');if(action==='table-add-row'){if(n.rows.length>=tableLimits.rows)throw Error('每个表格最多20行');n.rows.push(n.headers.map(()=>''));}if(action==='table-add-column'){if(n.headers.length>=tableLimits.columns)throw Error('每个表格最多12列');n.headers.push('新列');n.rows.forEach(row=>row.push(''));}const at=Number(type);if(action==='table-remove-row'){if(n.rows.length<=1||!Number.isInteger(at)||at<0||at>=n.rows.length)throw Error('须保留至少一行数据');n.rows.splice(at,1);}if(action==='table-remove-column'){if(n.headers.length<=1||!Number.isInteger(at)||at<0||at>=n.headers.length)throw Error('须保留至少一列表头');n.headers.splice(at,1);n.rows.forEach(row=>row.splice(at,1));}return syncLegacy(s);}if(action==='subtitle'){if(nodes.some(n=>n.type==='text'&&n.role==='subtitle'))throw Error('每页至多一个副标题');if(nodes.length>=40)throw Error('每页最多 40 个元素');const title=nodes.find(n=>n.type==='text'&&n.role==='title');nodes.splice(nodes.indexOf(title)+1,0,{id:'e-'+crypto.randomUUID(),type:'text',role:'subtitle',label:'副标题',text:'输入副标题',parentId:title.id,layout:'stack',materialId:null});}if(action==='add'||action==='child'){if(nodes.length>=40)throw Error('每页最多 40 个元素');nodes.push({id:'e-'+crypto.randomUUID(),type:action==='child'?'text':type,role:'body',label:action==='child'?'附属说明':{text:'新的文本',image:'新的图片',shape:'装饰色块',group:'新的小标题',table:'新的表格',formula:'新的公式'}[type],text:action==='child'?'补充说明':type==='text'?'输入新的文本':'',parentId:action==='child'?id:nodes.find(n=>n.type==='text'&&n.role==='title').id,layout:'stack',materialId:null,color:'FFF238',...(type==='formula'?{latex:'E=mc^2',markdown:'$$\nE=mc^2\n$$'}:{}),...(type==='table'?{headers:['项目','数值'],rows:[['','']]}:{})});}
  if(action==='remove'){if(n.role==='title')throw Error('页面标题不能删除');const ids=new Set([id,...(n.type==='image'?nodes.filter(o=>o.parentId===id&&isImageAnnotation(o)).map(o=>o.id):[])]);s.elements=nodes.filter(o=>!ids.has(o.id)).map(o=>ids.has(o.parentId)?{...o,parentId:n.parentId}:o);const removed=s.sourceLinks.filter(l=>ids.has(l.target.replace(/^element:/,'')));s.sourceLinks=s.sourceLinks.filter(l=>!ids.has(l.target.replace(/^element:/,'')));s.sources=s.sources.filter(m=>!removed.some(l=>l.materialId===m)||s.sourceLinks.some(l=>l.materialId===m));}
  if(action==='up'||action==='down'){if(n.type==='text'&&['title','subtitle'].includes(n.role))throw Error('主副标题不参与内容排序');const siblings=nodes.filter(o=>o.parentId===n.parentId&&!(o.type==='text'&&['title','subtitle'].includes(o.role))),pos=siblings.findIndex(o=>o.id===id),other=siblings[pos+(action==='up'?-1:1)];if(other){const a=nodes.indexOf(n),b=nodes.indexOf(other);[nodes[a],nodes[b]]=[nodes[b],nodes[a]];}}
  return syncLegacy(s);
}
export {moveElementBranch,syncLegacy};
function resizeInlineText(field){
  field.style.height='auto';field.style.height=Math.min(160,Math.max(25,field.scrollHeight+2))+'px';
}
let circuitCleanups=[];
function bindCircuitTraces(tree){
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  svg.classList.add('tree-traces');svg.setAttribute('aria-hidden','true');tree.prepend(svg);
  let frame=0;
  function draw(){
    frame=0;if(!tree.isConnected)return;
    const origin=tree.getBoundingClientRect(),groups=new Map(),fragment=document.createDocumentFragment();
    const add=(tag,attributes)=>{const el=document.createElementNS(ns,tag);for(const [key,value] of Object.entries(attributes))el.setAttribute(key,String(value));fragment.append(el);};
    const nodes=[...tree.querySelectorAll('[data-node]')],byId=new Map(nodes.map(node=>[node.dataset.node,node]));
    const subtitle=nodes.find(node=>node.dataset.fieldRole==='subtitle');
    for(const node of nodes){
      if(!node.getClientRects().length)continue;
      let parent=byId.get(node.dataset.parentNode);
      // This is a visual continuation only: content still belongs to the title in
      // the saved tree, while its circuit trunk starts below the subtitle if present.
      if(subtitle&&node!==subtitle&&parent?.dataset.fieldRole==='title')parent=subtitle;
      if(!parent)continue;
      if(!groups.has(parent))groups.set(parent,[]);groups.get(parent).push(node);
    }
    for(const [parent,children] of groups){
      const pr=parent.getBoundingClientRect(),points=children.map(node=>{const r=node.getBoundingClientRect();return{x:r.left-origin.left,y:r.top-origin.top+24};});
      const stem=Math.max(pr.left-origin.left+4,points[0].x-18),start=pr.bottom-origin.top+5,end=points.at(-1).y-(points.at(-1).x-stem);
      add('path',{d:`M${stem} ${start}V${end}`});
      add('rect',{x:stem-2,y:start-2,width:4,height:4,class:'tree-trace-junction'});
      for(const point of points){add('path',{d:`M${stem} ${point.y-(point.x-stem)}L${point.x} ${point.y}`});add('circle',{cx:point.x,cy:point.y,r:2.5});}
    }
    svg.setAttribute('viewBox',`0 0 ${origin.width} ${origin.height}`);svg.replaceChildren(fragment);
  }
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(draw);},observer=new ResizeObserver(schedule);
  observer.observe(tree);for(const node of tree.querySelectorAll('[data-node]'))observer.observe(node);
  tree.addEventListener('toggle',schedule,true);tree.addEventListener('click',schedule);schedule();
  return ()=>{observer.disconnect();cancelAnimationFrame(frame);tree.removeEventListener('toggle',schedule,true);tree.removeEventListener('click',schedule);svg.remove();};
}
export function bindTreeInteractions(root,{getNodes,onMove,canDrag}){
  for(const cleanup of circuitCleanups)cleanup();circuitCleanups=[];
  for(const select of root.querySelectorAll('[data-caption-role]'))positionImageAnnotation(select);
  for(const field of root.querySelectorAll('.tree-inline-text,.tree-caption-inline')){
    resizeInlineText(field);field.addEventListener('input',()=>resizeInlineText(field));
  }
  for(const tree of root.querySelectorAll('[data-tree-page]')){
    circuitCleanups.push(bindCircuitTraces(tree));
    tree.addEventListener('click',e=>{
      const b=e.target.closest('[data-tree-fold]');if(!b)return;
      const id=b.dataset.treeFold,key=tree.dataset.treeKey+':'+id,children=[...tree.querySelectorAll('[data-tree-children]')].find(c=>c.dataset.treeChildren===id);
      if(!children)return;children.hidden=!children.hidden;b.setAttribute('aria-expanded',String(!children.hidden));if(children.hidden)folded.add(key);else folded.delete(key);
    });
    tree.addEventListener('pointerdown',e=>{
      const handle=e.target.closest('[data-tree-drag]'),card=e.target.closest('[data-node]');
      if(!card||e.button!==0||!e.isPrimary||!canDrag()||(!handle&&e.target.closest('input,textarea,select,math-field,button,a,summary,details,.inline-text-editor')))return;
      if(handle)e.preventDefault();const capture=handle||card,page=Number(tree.dataset.treePage),id=card.dataset.node,nodes=getNodes(page),source=nodes.find(n=>n.id===id),branch=card.closest('[data-tree-branch]');if(source.type==='text'&&['title','subtitle'].includes(source.role))return;
      let active=false,mode=null,candidate=null,marked=null,last={x:e.clientX,y:e.clientY},raf=0,ghost=null;
      const start={...last},live=tree.querySelector('.tree-live-status');
      const clearMark=()=>{marked?.classList.remove('tree-drop-before','tree-drop-after','tree-drop-inside','tree-drop-invalid');marked=null;};
      function update(){
        if(!active)return;ghost.style.left=Math.min(innerWidth-225,last.x+18)+'px';ghost.style.top=Math.max(8,Math.min(innerHeight-60,last.y+18))+'px';clearMark();candidate=null;
        if(mode==='level'){
          const dx=last.x-start.x,direction=dx<0?'left':'right',verb=direction==='left'?'← 提升一级':'→ 下移一级';
          card.style.setProperty('--swipe-x',Math.max(-30,Math.min(30,dx*.25))+'px');
          if(Math.abs(dx)<48){ghost.textContent='继续向左 / 右滑动以调整一级';live.textContent=ghost.textContent;return;}
          try{candidate=elementLevelTarget(nodes,id,direction);marked=card;card.classList.add('tree-drop-inside');const target=nodes.find(n=>n.id===candidate.targetId),parent=nodes.find(n=>n.id===target.parentId);ghost.textContent=verb+' · '+(direction==='right'?'附属于「'+target.label+'」':parent?'与「'+target.label+'」并列':'移至页面顶层');}
          catch(error){marked=card;card.classList.add('tree-drop-invalid');ghost.textContent=error.message;}
          live.textContent=ghost.textContent;return;
        }
        const at=document.elementFromPoint(last.x,last.y);if(at?.closest('[data-tree-page]')!==tree){ghost.textContent=source.label+' · 移回当前页面';return;}
        const node=at.closest('[data-node]'),rootDrop=at.closest('[data-tree-root-drop],.tree-bus');
        if(node){const box=node.getBoundingClientRect(),edge=Math.min(28,box.height*.24);candidate={targetId:node.dataset.node,position:last.y<box.top+edge?'before':last.y>box.bottom-edge?'after':'inside'};marked=node;}
        else if(rootDrop){candidate={targetId:null,position:'root'};marked=rootDrop;}
        if(!candidate)return;
        try{moveElementBranch(nodes,id,candidate.targetId,candidate.position);marked.classList.add('tree-drop-'+(candidate.position==='root'?'inside':candidate.position));const target=nodes.find(n=>n.id===candidate.targetId);const message={before:'放到「'+target?.label+'」之前 · 并列',after:'放到「'+target?.label+'」之后 · 并列',inside:'附属于「'+target?.label+'」',root:'移回页面顶层'}[candidate.position];ghost.textContent=message;live.textContent=message;}
        catch(error){marked.classList.add('tree-drop-invalid');ghost.textContent=error.message;candidate=null;}
      }
      function frame(){if(!active||mode!=='reorder')return;const edge=64,delta=last.y<edge?-Math.ceil((edge-last.y)/4):last.y>innerHeight-edge?Math.ceil((last.y-innerHeight+edge)/4):0;if(delta){window.scrollBy(0,Math.max(-18,Math.min(18,delta)));update();}raf=requestAnimationFrame(frame);}
      function move(ev){
        if(ev.pointerId!==e.pointerId)return;last={x:ev.clientX,y:ev.clientY};const dx=Math.abs(last.x-start.x),dy=Math.abs(last.y-start.y);
        if(!mode){if(dx>12&&dx>dy*1.5)mode='level';else if(dy>12){if(!handle){cleanup();return;}mode='reorder';}}
        if(!active&&mode){active=true;tree.classList.add('tree-drag-active');branch.classList.add('tree-drag-source');if(mode==='level')card.classList.add('tree-level-swiping');document.body.classList.add('tree-is-dragging');ghost=document.createElement('div');ghost.className='tree-drag-ghost';ghost.setAttribute('aria-hidden','true');document.body.append(ghost);if(mode==='reorder')raf=requestAnimationFrame(frame);}
        if(active){ev.preventDefault();update();}
      }
      function cleanup(){cancelAnimationFrame(raf);clearMark();ghost?.remove();branch.classList.remove('tree-drag-source');card.classList.remove('tree-level-swiping');card.style.removeProperty('--swipe-x');tree.classList.remove('tree-drag-active');document.body.classList.remove('tree-is-dragging');document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);document.removeEventListener('pointercancel',cancel);document.removeEventListener('keydown',key);if(capture.hasPointerCapture?.(e.pointerId))capture.releasePointerCapture(e.pointerId);}
      function up(ev){if(ev.pointerId!==e.pointerId)return;const drop=candidate,message=live.textContent;cleanup();if(active&&drop){if(drop.position==='inside')folded.delete(tree.dataset.treeKey+':'+drop.targetId);live.textContent='正在保存关系…';onMove(page,id,drop.targetId,drop.position);}else live.textContent=active?(mode==='level'?(Math.abs(last.x-start.x)<48?'滑动不足 48px，层级未改变':message):'已取消拖动'):'';}
      function cancel(){cleanup();live.textContent='已取消拖动';}
      function key(ev){if(ev.key==='Escape'){ev.preventDefault();cancel();}}
      capture.setPointerCapture(e.pointerId);document.addEventListener('pointermove',move,{passive:false});document.addEventListener('pointerup',up);document.addEventListener('pointercancel',cancel);document.addEventListener('keydown',key);
    });
  }
}
