const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const foldHint='<span class="fold-action"><span class="fold-open-label">展开</span><span class="fold-close-label">收起</span><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></span>';
export const targetLabel=t=>t.startsWith('element:')?'元素 '+t.slice(8,20):({title:'标题',subtitle:'副标题',notes:'演讲备注',image:'配图'}[t]||(/^body:\d+$/.test(t)?`正文 ${Number(t.split(':')[1])+1}`:'内容'));
export const promptButton=(id,index,elementId)=>`<button class="text-button image-prompt-button" type="button" data-image-prompt="${h(id)}" ${elementId?`data-prompt-element="${h(elementId)}"`:""} ${index===undefined?'':`data-prompt-index="${index}"`}>查看 / 修改提示词 ↗</button>`;
export function slideImage(p,s,index){const images=s.elements?s.elements.filter(n=>n.type==='image'&&n.materialId).map(n=>({id:n.materialId,node:n.id,label:n.label})):s.imageId?[{id:s.imageId}]:[];return images.map(o=>{const m=p.materials.find(m=>m.id===o.id);return m?`<div class="slide-image-asset"><img src="/api/projects/${p.id}/assets/${m.id}" alt="${h(o.label||m.name)}"><div><span class="tag">${m.generated?'AI 生成':'原始图片'}</span><small>${h(o.label||m.name)}</small>${m.generated?promptButton(m.id,index,o.node):`<button class="text-button" type="button" data-read-material="${m.id}">查看原图 ↗</button>`}</div></div>`:'';}).join('');}
const sourceExpansion=new Map();
export function rememberSourceExpansion(target){
  const key=target?.dataset?.sourcePanel;if(!key||target.isConnected===false)return;
  sourceExpansion.set(key,!!target.open);
}
export function sourceTextView(m,link){
  const document=m.documentView?.richText?m.documentView:m;
  const text=document.text||'',quote=link?.quote||'',normalize=v=>v.replace(/\s/g,'');
  let location=null;
  if(quote){
    const old=link.location;
    if(document!==m&&old&&document.sourceMap&&Number.isInteger(old.start)&&Number.isInteger(old.end)&&old.start>=0&&old.end>old.start&&old.end<=(m.text||'').length&&normalize(m.text.slice(old.start,old.end))===normalize(quote)){
      const matches=document.sourceMap.flatMap(([a,b,n])=>{const start=Math.max(a,old.start),end=Math.min(a+n,old.end);return end>start?[{start:b+start-a,end:b+end-a}]:[];});
      if(matches.length)location={start:Math.min(...matches.map(v=>v.start)),end:Math.max(...matches.map(v=>v.end))};
    }
    if(!location&&old&&Number.isInteger(old.start)&&Number.isInteger(old.end)&&old.start>=0&&old.end>old.start&&old.end<=text.length&&normalize(text.slice(old.start,old.end))===normalize(quote))location={start:old.start,end:old.end};
    if(!location){let start=text.indexOf(quote);if(start>=0)location={start,end:start+quote.length};else{
      const chars=[],offsets=[];for(let i=0;i<text.length;i++)if(!/\s/.test(text[i])){chars.push(text[i]);offsets.push(i);}
      const key=normalize(quote);start=key?chars.join('').indexOf(key):-1;
      if(start>=0)location={start:offsets[start],end:offsets[start+key.length-1]+1};
    }}
  }
  if(location){const prefix=text.slice(0,location.start),page=[...prefix.matchAll(/\[第 (\d+) 页\]/g)].at(-1);location={...location,line:prefix.split('\n').length,page:page?Number(page[1]):null};}
  const html=document.richText?.version===1?richSourceHTML(text,document.richText,location):location?h(text.slice(0,location.start))+'<mark id="sourceQuoteMark" tabindex="-1">'+h(text.slice(location.start,location.end))+'</mark>'+h(text.slice(location.end)):h(text||'未提取到文字');
  return {html,location,rich:document.richText?.version===1,missing:!!quote&&!location};
}
const mathTags=new Set('math mrow mi mn mo mtext mspace mfrac msqrt mroot msup msub msubsup munder mover munderover mtable mtr mtd mstyle mpadded mphantom menclose mfenced mmultiscripts mprescripts none'.split(' '));
export function sourceMathHTML(node,depth=0){
  if(!node||depth>80||!mathTags.has(node.tag))return '';
  const attrs=Object.entries(node.attributes||{}).filter(([k,v])=>['display','mathvariant','stretchy','fence','separator','columnalign','rowalign','columnspan','rowspan','width','height','depth','lspace','rspace','notation'].includes(k)&&typeof v==='string'&&v.length<100).map(([k,v])=>' '+k+'="'+h(v)+'"').join('');
  return '<'+node.tag+attrs+'>'+h(node.text||'')+(node.children||[]).map(c=>sourceMathHTML(c,depth+1)).join('')+'</'+node.tag+'>';
}
export function richSourceHTML(text,rich,location){
  const spans=(rich.spans||[]).filter(s=>Number.isInteger(s.start)&&Number.isInteger(s.end)&&s.end>s.start).sort((a,b)=>a.start-b.start);
  const structures=(rich.structures||[]).filter(s=>Number.isInteger(s.start)&&Number.isInteger(s.end)&&s.start>=0&&s.end>s.start&&s.end<=text.length);
  let marked=false;
  const mark=(html,start,end)=>{if(!location||end<=location.start||start>=location.end)return html;const attrs=marked?'class="source-quote-mark"':'id="sourceQuoteMark" tabindex="-1"';marked=true;return '<mark '+attrs+'>'+html+'</mark>';};
  function run(value,s){
    const css=[];
    if(Number.isFinite(s?.fontSize)&&s.fontSize>0&&s.fontSize<=512)css.push('font-size:'+s.fontSize+'pt');
    if(typeof s?.bold==='boolean')css.push('font-weight:'+(s.bold?'700':'400'));
    if(typeof s?.italic==='boolean')css.push('font-style:'+(s.italic?'italic':'normal'));
    const decoration=[s?.underline?'underline':'',s?.strike?'line-through':''].filter(Boolean).join(' ');if(decoration)css.push('text-decoration:'+decoration);
    if(s?.vertical==='superscript')css.push('vertical-align:super');if(s?.vertical==='subscript')css.push('vertical-align:sub');
    if(s?.code)css.push('font-family:monospace');
    return css.length?'<span style="'+css.join(';')+'">'+h(value)+'</span>':h(value);
  }
  function plain(start,end){
    const local=spans.filter(s=>s.start<end&&s.end>start),cuts=new Set([start,end]);
    for(const s of local){cuts.add(Math.max(start,s.start));cuts.add(Math.min(end,s.end));}
    if(location){if(location.start>start&&location.start<end)cuts.add(location.start);if(location.end>start&&location.end<end)cuts.add(location.end);}
    const points=[...cuts].sort((a,b)=>a-b);let si=0;return points.slice(0,-1).map((a,i)=>{const b=points[i+1];while(si<local.length&&local[si].end<=a)si++;const style=local[si]?.start<=a&&local[si]?.end>=b?local[si]:null;return mark(run(text.slice(a,b),style),a,b);}).join('');
  }
  function render(start,end,insideTable=false){
    const blocks=structures.filter(s=>s.start>=start&&s.end<=end&&(insideTable?s.type==='formula':s.type==='table'||!structures.some(t=>t.type==='table'&&t.start<=s.start&&t.end>=s.end))).sort((a,b)=>a.start-b.start);
    let at=start,html='';
    for(const s of blocks){if(s.start<at)continue;html+=plain(at,s.start);
      if(s.type==='table'){
        const rows=s.rows||[];html+='<div class="source-table-scroll"><table class="source-document-table"><tbody>'+rows.map((row,ri)=>'<tr>'+row.map((cell,ci)=>{
          if(cell.start<start||cell.end>end||cell.end<cell.start)return '';
          if(cell.merge==='continue')return '';
          let rowspan=1;if(cell.merge==='restart')while(rows[ri+rowspan]?.[ci]?.merge==='continue')rowspan++;
          const tag=cell.header?'th':'td';return '<'+tag+' colspan="'+Math.max(1,Math.min(100,Number(cell.colspan)||1))+'" rowspan="'+rowspan+'">'+render(cell.start,cell.end,true)+'</'+tag+'>';
        }).join('')+'</tr>').join('')+'</tbody></table></div>';
      }else if(s.type==='formula'){
        const math=sourceMathHTML(s.math);html+=math?mark('<span class="source-formula'+(s.block?' source-formula-block':'')+'" title="'+h(text.slice(s.start,s.end))+'">'+math+'</span>',s.start,s.end):plain(s.start,s.end);
      }else html+=plain(s.start,s.end);
      at=s.end;
    }
    return html+plain(at,end);
  }
  return text?render(0,text.length):h('未提取到文字');
}
function sourceExcerptHTML(m,group){
  if(!m?.richText||!Number.isInteger(group.start)||!Number.isInteger(group.end))return h(group.quote||group.link.quote);
  const start=group.start,end=group.end,rich=m.richText;
  const spans=(rich.spans||[]).filter(v=>v.start<end&&v.end>start).map(v=>({...v,start:Math.max(start,v.start)-start,end:Math.min(end,v.end)-start}));
  const structures=(rich.structures||[]).filter(v=>v.type==='formula'&&v.start>=start&&v.end<=end).map(v=>({...v,start:v.start-start,end:v.end-start}));
  return richSourceHTML((m.text||'').slice(start,end),{spans,structures});
}
export function sourcePanel(p,s,i,readonly=false,scope=readonly?'read':'edit'){
  const links=s.sourceLinks||[],linked=new Set(links.filter(l=>!l.stale&&(['title','subtitle','notes'].includes(l.target)||l.target.startsWith('body:')||(l.target.startsWith('element:')&&s.elements?.find(n=>n.id===l.target.slice(8))?.type==='text'))).map(l=>l.target)),legacy=(s.sources||[]).filter(id=>!links.some(l=>l.materialId===id));
  const key=p.id+':'+i+':'+scope;
  const grouped=groupSourceLinks(p,links);
  return '<details class="source-relations" data-source-panel="'+h(key)+'" '+(sourceExpansion.get(key)?'open':'')+'><summary class="source-heading"><div><span class="eyebrow">SOURCE CONNECTION</span><h4>原材料对应索引 <small>'+linked.size+' 处文本已关联 · '+grouped.length+' 处原文</small></h4></div>'+foldHint+'</summary><div class="source-relations-body">'+(readonly?'':'<div class="source-tools"><button class="text-button" type="button" data-link-source="'+i+'">＋ 关联原材料</button></div>')+(!links.length&&!legacy.length?'<p class="source-empty">尚未关联原材料。用户自拟内容可保留为空；取自材料的结论请补充摘录。</p>':'')+grouped.map(group=>{const l=group.link;
    const m=p.materials.find(m=>m.id===l.materialId),read='data-read-material="'+h(l.materialId)+'" data-source-quote="'+h(l.id)+'" data-source-slide="'+i+'"'+(Number.isInteger(group.start)&&Number.isInteger(group.end)?' data-source-start="'+group.start+'" data-source-end="'+group.end+'"':''),position=l.location?(l.location.page?'第 '+l.location.page+' 页 · ':'')+'提取文字第 '+l.location.line+' 行'+(l.location.table?' · 表 '+l.location.table+'，第 '+l.location.row+' 行第 '+l.location.column+' 列':l.location.formula?' · 公式 '+l.location.formula:l.location.columnStart?' · 第 '+l.location.columnStart+'–'+l.location.columnEnd+' 字':''):m?.kind==='image'?'查看原图':'查看原文';
    const targets=group.links.map(item=>{const node=item.target.startsWith('element:')?s.elements?.find(n=>n.id===item.target.slice(8)):null,label=node?.label||targetLabel(item.target),value=node?.text||(item.target==='title'?s.title:item.target==='subtitle'?s.subtitle:item.target.startsWith('body:')?s.body?.[Number(item.target.slice(5))]:'');return '<div class="source-link-target"><span>'+h(label)+(value?'：'+h(value):'')+(item.stale?'<small>待核对</small>':'')+'</span>'+(readonly?'':'<div><button class="text-button" type="button" data-link-source="'+i+'" data-link-id="'+h(item.id)+'">修改</button><button class="text-button" type="button" data-unlink-source="'+h(item.id)+'" data-source-slide="'+i+'">移除</button></div>')+'</div>';}).join('');
    const excerpt=group.quote||l.quote;
    return '<article class="source-link '+(group.links.some(item=>item.stale)?'source-stale':'')+'"><div class="source-link-top"><span>'+group.links.length+' 个字段对应此处</span><b>'+(group.links.some(item=>item.stale)?'内容已变更 · 待核对':m?.kind==='image'&&!l.location?'图片参考':'摘录已定位')+'</b></div><button class="source-material-name" type="button" '+read+(m?'':' disabled')+'>'+h(m?.name||'材料已移出')+' ↗</button>'+(excerpt?'<blockquote>'+sourceExcerptHTML(m,group)+'</blockquote>':'')+'<div class="source-link-targets">'+targets+'</div>'+[...new Set(group.links.map(item=>item.note).filter(Boolean))].map(note=>'<p>'+h(note)+'</p>').join('')+'<div class="source-link-bottom"><button class="text-button source-position" type="button" '+read+(m?'':' disabled')+'>'+h(position)+' ↗</button></div></article>';
  }).join('')+legacy.map(id=>'<div class="legacy-source"><button class="text-button" type="button" data-read-material="'+h(id)+'">'+h(p.materials.find(m=>m.id===id)?.name||id)+' ↗</button><small>已关联材料，尚未定位具体段落</small></div>').join('')+'</div></details>';
}
export function groupSourceLinks(p,links){
  const groups=[];
  for(const link of links){
    const material=p.materials.find(m=>m.id===link.materialId),text=material?.text||'',loc=link.location;
    let start=loc?.start,end=loc?.end,key=link.quote?.replace(/\s/g,'')||'image';
    if(Number.isInteger(start)&&Number.isInteger(end)&&end>start&&end<=text.length){
      const cell=(material.richText?.structures||[]).flatMap(v=>v.type==='table'?v.rows.flat():[]).find(v=>v.start<=start&&v.end>=end);
      const paragraphStart=cell?.start??text.lastIndexOf('\n',Math.max(0,start-1))+1;
      const next=text.indexOf('\n',Math.max(start,end-1)),paragraphEnd=cell?.end??(next<0?text.length:next);
      key='range:'+paragraphStart+':'+paragraphEnd;
    }
    let group=groups.find(g=>g.materialId===link.materialId&&g.key===key);
    if(!group){group={materialId:link.materialId,key,link,links:[],start,end,quote:link.quote};groups.push(group);}
    group.links.push(link);
    if(loc&&Number.isInteger(start)&&Number.isInteger(end)&&group.start!==undefined){group.start=Math.min(group.start,start);group.end=Math.max(group.end,end);group.quote=text.slice(group.start,group.end);}
  }
  return groups;
}
export function conceptPrompts(p){return [...new Set([0,Math.min(1,p.slides.length-1)])].flatMap(i=>{const s=p.slides[i],images=s.elements?s.elements.filter(n=>n.type==='image'&&n.materialId).map(n=>({id:n.materialId,node:n.id})):s.imageId?[{id:s.imageId}]:[];return images.filter(o=>p.materials.some(m=>m.id===o.id&&m.generated)).map(o=>`<div class="concept-image-prompt"><small>第 ${i+1} 页 AI 图片</small>${promptButton(o.id,i,o.node)}</div>`);}).join('');}
export const provenanceDialogs=`
<dialog id="sourceDialog"><form id="sourceForm"><div class="modal-heading"><div><span class="eyebrow">CONNECT TO SOURCE</span><h2>关联原材料</h2></div><button type="button" class="close" data-close="sourceDialog" aria-label="关闭材料对应">×</button></div><div class="form-grid"><label>对应的页面内容<select id="sourceTarget" name="target"></select></label><label>原材料<select id="sourceMaterial" name="materialId" required></select></label></div><p class="source-current-text" id="sourceCurrentText"></p><label id="sourceQuoteLabel">原文摘录<textarea name="quote" id="sourceQuote" rows="3" maxlength="3000" placeholder="从下方原文复制对应的证据，摘录会自动定位。"></textarea></label><label>对应说明<input name="note" maxlength="1000" placeholder="说明这段材料支持了页面中的哪一条结论。"></label><div id="sourceEvidenceChoices" class="source-evidence-choices"></div><details class="source-original" open><summary>查看材料提取原文 / 图片</summary><div id="sourceOriginal"></div></details><p class="subtle">摘录定位用于追溯来源，仍需核对摘录是否真正支持页面结论。</p><div class="modal-actions"><button class="primary" type="submit">保存对应关系</button></div></form></dialog>
<dialog id="imagePromptDialog"><form id="imagePromptForm"><div class="modal-heading"><div><span class="eyebrow">IMAGE PROMPT STUDIO</span><h2 id="imagePromptTitle">图片提示词</h2></div><button type="button" class="close" data-close="imagePromptDialog" aria-label="关闭图片提示词">×</button></div><div id="promptImageContext"></div><div class="prompt-modes" role="group" aria-label="提示词修改方式"><button type="button" data-prompt-mode="direct" aria-pressed="true">直接修改提示词</button><button type="button" data-prompt-mode="natural" aria-pressed="false">自然语言修改</button></div><div id="naturalPromptFields" hidden><label>你希望怎么改？<textarea id="imageInstruction" rows="3" maxlength="3000" placeholder="例如：保留主体，把背景改成浅灰，减少装饰，增加留白。"></textarea></label><button class="secondary" id="rewriteImagePrompt" type="button">用 AI 改写提示词</button><p class="subtle">改写仅调用文字模型；新版提示词仍可直接编辑。</p></div><label>下一版提示词<textarea id="imagePromptText" name="prompt" rows="6" required maxlength="4000" placeholder="描述主题、构图、色彩和画面风格。"></textarea></label><p id="imagePromptState" class="subtle" role="status"></p><label class="checkbox"><input id="imagePromptConsent" type="checkbox">确认将提示词发送给配置的生图供应商，并消耗生图额度</label><p class="subtle" id="imagePromptDestination"></p><p class="subtle">当前采用文生图重新生成，原图及历史提示词保留。附加生成要求：仅作概念插画，不伪造实际事件、数据或证据，不含文字。</p><div class="modal-actions"><button class="text-button" id="cancelPromptTask" type="button" hidden>取消全部任务</button><button class="secondary" id="saveImagePrompt" type="button">保存提示词草稿</button><button class="primary" type="submit">按此提示词生成图片 ↗</button></div></form></dialog>`;


export function imageEditTarget(p,b){
  if(b.targetType==='theme'){
    const d=p.themeAssets?.directions.find(d=>d.id===b.theme),image=d?.assets[b.use];
    if(!image)throw Error('请先生成这张底图');
    return {key:`theme:${b.theme}:${b.use}`,image,prompt:image.redrawPrompt||d.promptDrafts?.[b.use]?.prompt||image.prompt,request:{action:'generateThemeAsset',theme:b.theme,use:b.use,revision:d.promptDrafts?.[b.use]?.revision||0,confirmed:true},url:`/api/projects/${p.id}/assets/${image.materialId}`};
  }
  if(b.targetType==='visual'){
    const theme=b.kind==='concept'?b.theme:p.selectedTheme,image=b.kind==='concept'?p.concepts.find(c=>c.id===theme)?.representatives.find(r=>r.index===b.index):p.visualPages?.[b.index];
    if(!image)throw Error('请先生成这页预览');
    return {key:`visual:${b.kind}:${theme}:${b.index}`,image,prompt:image.redrawPrompt||image.promptDraft||image.prompt,request:{action:b.kind==='concept'?'generateConceptPage':'generateFullPreview',index:b.index,...(b.kind==='concept'?{theme}:{}),force:true},url:`/api/projects/${p.id}/preview?slide=${b.index}&theme=${b.kind==='concept'?theme:''}&t=${encodeURIComponent(p.updatedAt)}`};
  }
  const image=p.materials.find(m=>m.id===b.sourceImageId&&m.generated&&m.kind==='image');
  if(!image)throw Error('请先生成 AI 图片');
  return {key:`image:${b.index??'library'}:${b.sourceImageId}:${b.elementId||''}`,image,prompt:image.redrawPrompt||image.prompt,request:{action:'image',index:b.index??null,sourceImageId:b.sourceImageId,elementId:b.elementId||null,allowUpload:true},url:`/api/projects/${p.id}/assets/${image.id}`};
}

export function createPromptHistory(value=''){
  let values=[value],index=0;
  return {get value(){return values[index];},get canUndo(){return index>0;},get canRedo(){return index<values.length-1;},
    record(next){if(next===values[index])return next;values=values.slice(0,index+1);values.push(next);if(values.length>100)values.shift();index=values.length-1;return next;},
    undo(){if(index>0)index--;return values[index];},redo(){if(index<values.length-1)index++;return values[index];}};
}

const promptBindings=new WeakMap();
export function setPromptInput(input,value,{reset=false,onChange}={}){
  if(!input)return;
  let binding=promptBindings.get(input);
  if(!binding){
    const tools=document.createElement('div');tools.className='prompt-edit-tools';tools.setAttribute('role','group');tools.setAttribute('aria-label','提示词版本');
    tools.innerHTML='<button type="button" class="text-button" data-prompt-history="undo">↶ 撤回提示词</button><button type="button" class="text-button" data-prompt-history="redo">↷ 重做提示词</button>';
    input.insertAdjacentElement('afterend',tools);
    binding={history:createPromptHistory(input.value),onChange};promptBindings.set(input,binding);
    binding.refresh=()=>{for(const button of tools.querySelectorAll('button'))button.disabled=input.disabled||!(button.dataset.promptHistory==='undo'?binding.history.canUndo:binding.history.canRedo);};
    input.addEventListener('input',()=>{binding.history.record(input.value);binding.refresh();});
    tools.addEventListener('click',e=>{const button=e.target.closest('[data-prompt-history]');if(!button)return;e.preventDefault();e.stopPropagation();if(input.disabled)return;
      binding.history.record(input.value);input.value=button.dataset.promptHistory==='undo'?binding.history.undo():binding.history.redo();binding.onChange?.();binding.refresh();});
  }
  if(onChange)binding.onChange=onChange;
  if(reset)binding.history=createPromptHistory(value);
  else{binding.history.record(input.value);binding.history.record(value);}
  input.value=value;binding.refresh();return binding;
}

export function initAIImageEditor({getProject,act,busy,openAPI,onError}){
  document.body.insertAdjacentHTML('beforeend',`<dialog id="aiImageEditDialog"><form id="aiImageEditForm"><div class="modal-heading"><div><span class="eyebrow">REVISION SHEET / IMAGE</span><h2 id="aiEditTitle">修改 AI 图片</h2></div><button type="button" class="close" data-edit-close aria-label="关闭图片修改">×</button></div><div class="ai-edit-body"><div class="ai-edit-context"><img id="aiEditImage" alt="当前 AI 图片"><p id="aiEditContext"></p></div><div class="ai-edit-image-history" role="group" aria-label="图片版本"><button type="button" id="aiEditImageUndo" class="text-button" hidden>↶ 撤回图片修改</button><button type="button" id="aiEditImageRedo" class="text-button" hidden>↷ 重做图片修改</button></div><div class="prompt-modes" role="group" aria-label="图片修改方式"><button type="button" data-edit-mode="adjust">图生图小修改</button><button type="button" data-edit-mode="redraw">文生图重绘</button></div><p id="aiEditHint" class="subtle"></p><label><span id="aiEditInputName">修改意见</span><textarea id="aiEditInstruction" rows="7" maxlength="3000" placeholder="例如：缩小右侧主体，标题区域增加留白。"></textarea></label><div class="prompt-edit-tools" role="group" aria-label="提示词版本"><button type="button" id="aiEditPromptUndo" class="text-button">↶ 撤回提示词</button><button type="button" id="aiEditPromptRedo" class="text-button">↷ 重做提示词</button><button type="button" id="aiEditPrepare" class="secondary">AI 整理调整意见</button></div><p id="aiEditState" class="subtle" role="status"></p></div><div class="modal-actions"><label class="checkbox"><input type="checkbox" id="aiEditConsent">确认将本次指令发送给配置的生图供应商并消耗额度</label><button type="submit" id="aiEditGenerate" class="primary">确认并图生图小修改 ↗</button></div></form></dialog>`);
  const dialog=document.querySelector('#aiImageEditDialog'),$=s=>dialog.querySelector(s),histories=new Map();let ctx=null,mode='adjust',seen=0,pending=null,textHistory=null;
  const run=fn=>Promise.resolve().then(fn).catch(e=>onError(e.message));
  function setMode(next){
    mode=next;pending=null;seen=getProject()?.aiImageEditDrafts?.[ctx.key]?.revision||0;
    $('[data-edit-mode="adjust"]').setAttribute('aria-pressed',String(mode==='adjust'));
    $('[data-edit-mode="redraw"]').setAttribute('aria-pressed',String(mode==='redraw'));
    const key=ctx.projectId+':'+ctx.key+':'+ctx.sourceHash+':'+mode,draft=getProject()?.aiImageEditDrafts?.[ctx.key];
    if(!histories.has(key)){
      const applicable=draft?.mode===mode&&draft.sourceHash===ctx.sourceHash;
      const history=createPromptHistory(applicable&&draft.previousText!==undefined?draft.previousText:mode==='redraw'?ctx.prompt||'':'');
      if(applicable)history.record(mode==='adjust'?draft.instruction:draft.prompt);
      histories.set(key,history);
    }
    textHistory=histories.get(key);$('#aiEditInstruction').value=textHistory.value;
    $('#aiEditInstruction').maxLength=mode==='adjust'?3000:ctx.target.targetType==='image'?4000:30000;
    $('#aiEditInstruction').placeholder=mode==='adjust'?'例如：缩小右侧主体，标题区域增加留白。':'编辑完整提示词；也可在框内写入修改意见，再点击 AI 协助整理。';
    $('#aiEditConsent').checked=false;
    $('#aiEditInputName').textContent=mode==='adjust'?'修改意见（直接发送）':'完整最终提示词（直接发送）';
    $('#aiEditPrepare').textContent=mode==='adjust'?'AI 整理调整意见（可选）':'AI 协助修改完整提示词';
    $('#aiEditGenerate').textContent=mode==='adjust'?'确认并图生图小修改 ↗':'确认并文生图重绘 ↗';
    $('#aiEditHint').textContent=mode==='adjust'?'附上当前图片，直接发送下方修改意见；也可先用 AI 整理，再自行修改。':'只发送输入框中的完整最终提示词，直接文生图重绘；AI 可将框内草稿与修改意见整理为最终稿。';
    $('#aiEditState').textContent='';refresh();
  }
  function refresh(){
    if(!dialog.open||!ctx)return;const p=getProject();if(p?.id!==ctx.projectId){dialog.close();return;}
    const draft=p.aiImageEditDrafts?.[ctx.key];
    if(pending&&draft?.revision>seen&&draft.mode===mode&&draft.sourceHash===ctx.sourceHash){
      seen=draft.revision;pending=null;
      $('#aiEditInstruction').value=textHistory.record(mode==='adjust'?draft.instruction:draft.prompt);
      $('#aiEditConsent').checked=false;$('#aiEditState').textContent=mode==='adjust'?'AI 已整理到修改意见中，可继续编辑，核对后直接生成。':'AI 已整理，请核对下方实际发送内容，再确认生成。';
    }else if(pending&&!busy()){$('#aiEditState').textContent=p.task?.message||'整理未完成，请重试';pending=null;}
    const running=busy();$('#aiEditPrepare').disabled=running;$('#aiEditGenerate').disabled=!!pending||running&&!p.imageTaskQueueEnabled;
    $('#aiEditInstruction').disabled=!!pending;
    $('#aiEditPromptUndo').disabled=!!pending||!textHistory?.canUndo;$('#aiEditPromptRedo').disabled=!!pending||!textHistory?.canRedo;
    let current;try{current=imageEditTarget(p,ctx.target).image;}catch{current=ctx.image;}
    const history=current.editHistory||{past:current.repairHistory||[],future:[]};
    for(const [id,count] of [['#aiEditImageUndo',history.past.length],['#aiEditImageRedo',history.future.length]]){$(id).hidden=!p.aiImageUndo||ctx.target.targetType==='image';$(id).disabled=running||!!pending||!count;}
  }
  dialog.addEventListener('click',e=>{e.stopPropagation();const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-edit-close'))dialog.close();else if(b.dataset.editMode)setMode(b.dataset.editMode);else if(['aiEditPromptUndo','aiEditPromptRedo'].includes(b.id)){
    if(pending)return;textHistory.record($('#aiEditInstruction').value);$('#aiEditInstruction').value=b.id==='aiEditPromptUndo'?textHistory.undo():textHistory.redo();$('#aiEditConsent').checked=false;$('#aiEditState').textContent=b.id==='aiEditPromptUndo'?'已撤回提示词修改。':'已重做提示词修改。';refresh();
  }else if(['aiEditImageUndo','aiEditImageRedo'].includes(b.id))run(async()=>{
    if(busy()||pending)throw Error('请等待当前任务完成后恢复图片');
    const target=ctx.target;await act('restoreAIImage',{...target,sourceHash:ctx.sourceHash,sourceRevision:ctx.image.jobFile||ctx.image.file,direction:b.id==='aiEditImageUndo'?'undo':'redo'});
    const value=imageEditTarget(getProject(),target);ctx={...ctx,...value,sourceHash:value.image.previewHash||value.image.sha256};
    for(const editMode of ['adjust','redraw'])histories.delete(ctx.projectId+':'+ctx.key+':'+ctx.sourceHash+':'+editMode);
    $('#aiEditImage').src=value.url;setMode(mode);$('#aiEditState').textContent='已恢复图片及对应提示词，无需重新生图。';
  });else if(b.id==='aiEditPrepare')run(async()=>{
    const p=getProject();if(!p.apiReady){openAPI();return;}if(busy())throw Error('请等待当前任务完成');
    const instruction=$('#aiEditInstruction').value;if(!instruction.trim())throw Error('请填写修改意见');
    textHistory.record(instruction);
    pending={instruction};$('#aiEditConsent').checked=false;$('#aiEditState').textContent='AI 正在整理，尚未发送生图请求…';
    try{await act('prepareAIImageEdit',{...ctx.target,imageEditMode:mode,sourceHash:ctx.sourceHash,instruction:mode==='adjust'?instruction:'将输入框中的草稿与修改意见整理为可独立文生图的完整最终提示词，保留未要求改变的内容。',prompt:mode==='redraw'?instruction:undefined});refresh();}catch(e){pending=null;refresh();throw e;}
  });});
  $('#aiEditInstruction').addEventListener('input',()=>{textHistory?.record($('#aiEditInstruction').value);$('#aiEditConsent').checked=false;refresh();});
  $('#aiImageEditForm').addEventListener('submit',e=>{e.preventDefault();e.stopPropagation();run(async()=>{
    const p=getProject();if(p?.id!==ctx.projectId)throw Error('项目已变化，请重新打开图片修改');
    const element=['element','supplement','scientific'].includes(ctx.image.purpose)||ctx.target.elementId;if(!(element?p.elementImageReady:p.imageReady)){openAPI();return;}
    if(!$('#aiEditConsent').checked)throw Error('请确认发送本次指令');
    if(pending)throw Error('请等待 AI 整理完成');
    if(!$('#aiEditInstruction').value.trim())throw Error(mode==='adjust'?'请填写修改意见':'请填写完整的重绘提示词');
    const {action,...request}=ctx.request,extra={...request,imageEditMode:mode,sourceHash:ctx.sourceHash,...(mode==='adjust'?{instruction:$('#aiEditInstruction').value}:{prompt:$('#aiEditInstruction').value})};
    if(mode==='adjust'&&ctx.target.targetType==='theme')extra.prompt=ctx.prompt;
    await act(action,extra);dialog.close();
  });});
  return {open(target){const p=getProject(),value=imageEditTarget(p,target);ctx={...value,target,projectId:p.id,sourceHash:value.image.previewHash||value.image.sha256};$('#aiEditTitle').textContent=target.targetType==='theme'?'修改底图':target.targetType==='visual'?'修改预览图':'修改 AI 图片';$('#aiEditImage').src=value.url;$('#aiEditContext').textContent=(target.targetType==='theme'?'主题底图':target.targetType==='visual'?'整页预览 · 第 '+(target.index+1)+' 页':'AI 素材')+' · '+(value.image.model||'已配置的生图模型');dialog.showModal();setMode('adjust');},refresh,close(){dialog.close();ctx=null;}};
}
