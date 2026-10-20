import test from 'node:test';
import assert from 'node:assert/strict';
import {repairRebuiltPage,patchRebuiltScene} from '../lib/rebuild-tools.mjs';
import {extractionScope,validateExtractionScope} from '../lib/rebuild-region.mjs';
import {rememberRebuildEdit,undoRebuildEdit,rebuildUndoState} from '../lib/rebuild-undo.mjs';
import {rebuildReviewLoop} from '../lib/rebuild-review-loop.mjs';
import {visualStamp,validateAudit} from '../lib/visual-model.mjs';
import {expectedRebuildText,splitHeadingNumber} from '../lib/rebuild-text-parts.mjs';
import {regionFromPoints,logicalRegionPoint} from '../public/visual-ui.js';
import {rebuildAssetsPanel,visualDelivery,rebuildFeedbackRequest} from '../public/visual-ui.js';
import {prepareRebuildPresentation,rebuildPresentationStamp} from '../lib/rebuild-progress.mjs';

const text=(key,nodeId,value,y)=>({key,type:'text',nodeId,text:value,x:50,y,w:800,h:70,size:30,bold:false,color:'272727',align:'left'});
const slide={title:'准确标题',body:['准确正文'],sources:[]};
const elements=()=>[text('title','title',slide.title,80),text('body','body-0',slide.body[0],250),{key:'icon',type:'image',id:'old',implementation:'svg',x:1100,y:650,w:100,h:100,description:'平面图标'},{key:'block',type:'rect',x:1000,y:450,w:200,h:100,fill:'EEEEEE',color:'333333',strokeWidth:0,opacity:1}];
function project(){const p={id:'test',version:1,brief:{progress:false},slides:[slide],concepts:[],visualPages:[{images:[],previewHash:'preview'}],materials:[{id:'old',kind:'image'}],approvals:{preview:1},task:{status:'done'}};p.reconstruction={mode:'free',stamp:visualStamp(p),slides:[{index:0,elements:elements()}],assets:['old']};return p;}
test('动画设置变化后单页撤回不能复用旧动画交付，必须按当前设置重新渲染',()=>{
  const p=project();prepareRebuildPresentation(p);p.candidate={id:'old-motion',presentationStamp:rebuildPresentationStamp(p)};rememberRebuildEdit(p,'第 1 页修改',0);p.reconstruction.slides[0].elements[0].x=100;p.deliveryMotion={enabled:false};
  const result=undoRebuildEdit(p,0);assert.equal(result.requiresRender,true);assert.equal(p.candidate,null);assert.equal(p.reconstruction.slides[0].elements[0].x,50);assert.equal(p.deliveryMotion.enabled,false);
});
async function toolEdit(p,review,commands,options={}){let turns=0;const records=[],requests=[];const result=await repairRebuiltPage({p,index:0,review,round:1,env:{system:'JSON',credentials:new Map([[p.id,{text:{key:'fixture',model:'main'}}]]),...(options.env||{})},reference:'reference',rendered:'rendered',background:'background',createAsset:options.createAsset|| (async()=>({id:'new',sha256:'hash',kind:'image'})),renderScene:async()=>'',record:r=>records.push(structuredClone(r)),requestModel:async(c,e,b)=>{requests.push(b);options.onRequest?.(turns,p);return {choices:[{message:turns++===0?{content:null,tool_calls:commands.map(([name,args],i)=>({id:'tool-'+i,type:'function',function:{name,arguments:JSON.stringify(args)}}))}:{content:'{"done":true}'}}]};}});return {result,records,requests};}

test('单项原生斜体修正真正应用字体回退，未指定元素不随选字发生变化',async()=>{
  const p=project(),before=structuredClone(p.reconstruction.slides[0].elements);
  await toolEdit(p,{targetKey:'body',issues:[]},[['apply_page_patch',{edits:[{key:'body',properties:{fontFace:'Missing Sans Fixture',italic:true}}]}],['render_page',{}]]);
  const page=p.reconstruction.slides[0],body=page.elements.find(e=>e.key==='body');
  assert.notEqual(body.fontFace,'Missing Sans Fixture');assert.equal(body.italic,true);
  assert.equal(body.requestedFontFace,'Missing Sans Fixture');assert.equal(body.fontSubstitution.used,body.fontFace);
  assert.deepEqual(page.elements.filter(e=>e.key!=='body'),before.filter(e=>e.key!=='body'));
  assert.ok(page.fontSubstitutions.some(e=>e.key==='body'));
});

test('单元素修改在工具层拒绝旁改、增删、重排，SVG替换保留key和其他元素',async()=>{
  const p=project(),before=structuredClone(p.reconstruction.slides[0].elements),ctx={slide,project:p,index:0,originalPage:p.reconstruction.slides[0],assets:p.materials,targetKey:'block'};
  const next=patchRebuiltScene(before,{edits:[{key:'block',properties:{fill:'FFF137'}}]},ctx);assert.equal(next[3].fill,'FFF137');assert.deepEqual(next.slice(0,3),before.slice(0,3));
  for(const patch of [{edits:[{key:'body',properties:{size:60}}]},{add:[{key:'other',type:'rect',x:1,y:1,w:1,h:1}]},{remove:['icon']},{order:before.map(e=>e.key).reverse()}])assert.throws(()=>patchRebuiltScene(before,patch,ctx),/单元素/);
  const edited=await toolEdit(p,{targetKey:'icon',userInstruction:'重绘为简洁三角图标',issues:[]},[['create_visual_asset',{method:'svg',key:'wrong',x:1100,y:650,w:100,h:100,svg:'irrelevant'}],['create_visual_asset',{method:'svg',key:'icon',x:1100,y:650,w:100,h:100,svg:'irrelevant'}]]);
  assert.equal(edited.result.changed,true);assert.equal(p.reconstruction.slides[0].elements[2].id,'new');assert.deepEqual(p.reconstruction.slides[0].elements.filter(e=>e.key!=='icon'),before.filter(e=>e.key!=='icon'));assert(edited.result.session.history.some(e=>e.status==='failed'));assert.match(edited.requests[0].messages[1].content[0].text,/单元素修改范围/);
});

test('区域只是定位提示，可超出框选精确补拆；已有对象仍锁定',async()=>{
  const p=project(),before=structuredClone(p.reconstruction.slides[0].elements),scope=extractionScope({x:1400,y:700,w:50,h:50},before),newShape={key:'missing',type:'shape',shape:'hexagon',x:1000,y:780,w:130,h:80,fill:'EEEEEE',color:'333333'};
  assert.doesNotThrow(()=>validateExtractionScope([...before,newShape],scope));assert.throws(()=>validateExtractionScope([{...before[0],size:80},...before.slice(1),newShape],scope),/已有元素/);
  await toolEdit(p,{regionScope:scope,userInstruction:'补拆完整蜂窝形状',issues:[]},[['apply_page_patch',{add:[newShape]}]]);
  assert.deepEqual(p.reconstruction.slides[0].elements.slice(0,before.length),before);assert(p.reconstruction.slides[0].elements.some(e=>e.key==='missing'));
  assert.deepEqual(logicalRegionPoint(60,40,{left:10,top:10,width:100,height:90}),{x:800,y:300});assert.deepEqual(regionFromPoints({x:300,y:200},{x:100,y:50}),{x:100,y:50,w:200,h:150});
});

test('局部修改的后续纠正不会扩散至其他页面或丢失目标范围',async()=>{
  const seen=[];let rounds=0;
  const final=await rebuildReviewLoop({feedback:[{index:0,targetKey:'icon',instruction:'只调此图标'}],render:async()=>({review:{pages:[{index:0,passed:rounds++>1,issues:['target']},{index:1,passed:false,issues:['unrelated']}]}}),repair:async pages=>{seen.push(pages);return {changed:true,changedIndices:[0]};}});
  assert.equal(seen.length,2);assert(seen.every(pages=>pages.length===1&&pages[0].index===0&&pages[0].targetKey==='icon'));assert.equal(final.visualRepair.status,'scope_complete');assert.equal(final.review.pages[1].passed,false);
});

test('撤回恢复原始对象、候选PPT、图片和交付状态；版本变更后拒绝旧撤回',()=>{
  const p=project();p.candidate={id:'original'};p.output={file:'deck.pptx'};p.rebuildLive={revision:7};const original=structuredClone(p.reconstruction);
  rememberRebuildEdit(p,'修改图标',0);p.reconstruction.slides[0].elements[2].id='new';p.candidate={id:'new'};p.output=null;p.rebuildLive.revision=8;
  assert.equal(rebuildUndoState(p,0).available,true);undoRebuildEdit(p,0);assert.deepEqual(p.reconstruction,original);assert.equal(p.candidate.id,'original');assert.equal(p.output.file,'deck.pptx');assert.equal(p.rebuildLive.revision,7);
  p.candidate=null;rememberRebuildEdit(p,'未有旧导出时修改',0);p.reconstruction.slides[0].elements[0].x=110;assert.equal(undoRebuildEdit(p,0).requiresRender,true,'没有可复用旧导出时仍需更新导出');
  rememberRebuildEdit(p,'再次修改',0);p.version++;assert.equal(rebuildUndoState(p,0).available,false);assert.throws(()=>undoRebuildEdit(p,0),/版本/);
});

test('编号与小标题/目录文字必须独立，分拆不改变准确文案，正文年份不误拆',()=>{
  const s={title:'标题',body:[],elements:[{id:'title',type:'text',role:'title',text:'标题',parentId:null},{id:'group',type:'group',role:'body',label:'01 研究背景',parentId:'title'}]},raw=[text('title','title','标题',80),text('group','group','01 研究背景',200)];
  assert.throws(()=>validateAudit(raw,s,[]),/独立文字/);
  const parts=[raw[0],{...raw[1],key:'number',part:'number',text:'01',w:100},{...raw[1],key:'label',part:'label',text:'研究背景',x:170,w:600}];const audit=validateAudit(parts,s,[]);assert.equal(audit[1].sourceText,'01 研究背景');assert.equal(audit[2].text,'研究背景');assert.throws(()=>validateAudit(parts.slice(0,2),s,[]),/遗漏/);
  assert.equal(splitHeadingNumber('2024年研究'),null);assert.deepEqual(splitHeadingNumber('1.2 研究方法'),{number:'1.2',label:'研究方法'});
  const p={brief:{toc:true,cover:false},slides:[{kind:'toc'}]},nodes=[{nodeId:'body-0',role:'body',text:'研究目标'}];assert.equal(expectedRebuildText({nodeId:'toc-number-body-0',forNodeId:'body-0',role:'toc-number',text:'01'},nodes,p,0).synthetic,true);assert.throws(()=>expectedRebuildText({nodeId:'toc-number-body-0',forNodeId:'body-0',role:'toc-number',text:'02'},nodes,p,0));
});

test('05按页分框、元素滚动、黄色问题可收起，修改只有原对比位置且可撤回',()=>{
  const p=project();p.visualMode='ai';p.fullPreviewPages=[true];p.rebuildAssets=[{index:0,elements:[{key:'icon',description:'<图标>',targetStamp:'stamp',type:'image',implementation:'svg'}],textStyles:[]}];p.visualReconstructionCurrent=true;p.singleElementEditing=true;p.regionExtraction=true;p.rebuildUndo={pages:{0:{available:true}}};p.candidate={id:'candidate',structure:{passed:true},designStandards:{passed:false,issues:[]},review:{pages:[{index:0,passed:false,issues:['<字号过小>'],deviations:[],notes:''}]}};
  const html=visualDelivery(p,()=>'',()=>''),assets=rebuildAssetsPanel(p,0);assert.match(html,/data-release-page="0"/);assert.match(html,/rebuild-assets-scroll/);assert.match(html,/<details class="release-issue-panel"><summary>检查问题/);assert.match(html,/&lt;字号过小&gt;/);assert(!html.includes('rebuild-live-grid'));assert.match(html,/data-undo-rebuild-page="0"/);assert(!html.includes('class="rebuild-header panel"'));assert(!assets.includes('data-revise-rebuild-element'));assert.match(assets,/data-rebuild-mention-key="icon"/);assert(!assets.includes('role="listbox"'));assert(!html.includes('本页交付复核'));assert(!html.includes('data-action="release"'));assert.match(html,/data-extract-rebuild-region="0"/);
});

test('@单元素与整页修改分流，禁止未知或多目标；传递当前元素身份而不覆盖同页其他元素',()=>{
  const p={rebuildAssets:[{index:0,elements:[{key:'icon-1',description:'图标',targetStamp:'current'}],textStyles:[{key:'title',text:'标题',targetStamp:'text-stamp'}]}]};
  assert.deepEqual(rebuildFeedbackRequest(p,0,'@icon-1 放大一点'),{action:'reviseRebuildElement',payload:{index:0,key:'icon-1',targetStamp:'current',instruction:'放大一点'}});
  assert.equal(rebuildFeedbackRequest(p,0,'@title 增大字号').payload.key,'title');assert.equal(rebuildFeedbackRequest(p,0,'新增一条分隔线').action,'reviseRebuildAssets');
  for(const value of ['@unknown 放大','@title @icon-1 放大','@title','@标题 放大'])assert.throws(()=>rebuildFeedbackRequest(p,0,value));
});

test('多页交错修改后可分别撤回，各页历史独立，不能用整体旧文件覆盖另一页',()=>{
  const p=project();p.slides.push(structuredClone(slide));p.visualPages.push({images:[],previewHash:'second'});p.reconstruction.slides.push({index:1,elements:elements()});p.reconstruction.stamp=visualStamp(p);p.rebuildAssetFeedback={0:{instruction:'旧0'},1:{instruction:'旧1'}};
  const original=structuredClone(p.reconstruction.slides);rememberRebuildEdit(p,'第 1 页修改',0);p.reconstruction.slides[0].elements[0].x=100;p.rebuildAssetFeedback[0]={instruction:'新0'};
  rememberRebuildEdit(p,'第 2 页修改',1);p.reconstruction.slides[1].elements[0].x=200;p.rebuildAssetFeedback[1]={instruction:'新1'};p.candidate={id:'both-modified'};const second=structuredClone(p.reconstruction.slides[1]);
  assert.equal(rebuildUndoState(p).pages[0].available,true);assert.equal(rebuildUndoState(p).pages[1].available,true);assert.throws(()=>undoRebuildEdit(p),/指定/);
  const undone=undoRebuildEdit(p,0);assert.equal(undone.requiresRender,true);assert.deepEqual(p.reconstruction.slides[0],original[0]);assert.deepEqual(p.reconstruction.slides[1],second);assert.equal(p.rebuildAssetFeedback[1].instruction,'新1');assert.equal(p.candidate,null,'不能提供包含另一页旧内容的整体导出');assert.equal(rebuildUndoState(p,1).available,true);
  undoRebuildEdit(p,1);assert.deepEqual(p.reconstruction.slides,original);assert.equal(rebuildUndoState(p,0).available,false);assert.equal(rebuildUndoState(p,1).available,false);
});


test('书法补拆仅替换用户指定文字，透明图保留文案，其他项不变且可撤回',async()=>{
  const p=project(),before=structuredClone(p.reconstruction.slides[0].elements);
  const scope=extractionScope({x:70,y:90,w:60,h:30},before,'title');
  rememberRebuildEdit(p,'书法补拆',0);
  const {result,requests}=await toolEdit(p,{regionScope:scope,userInstruction:'保留标题的毛笔字笔触',issues:[]},[['create_visual_asset',{key:'title',method:'cutout',x:50,y:80,w:800,h:70,sourceBox:{x:50,y:80,w:800,h:70},prompt:'抠出完整书法字，保留笔触并移除背景'}]]);
  assert(result.changed);const after=p.reconstruction.slides[0].elements;
  assert.equal(after[0].type,'image');assert.equal(after[0].artisticText,true);assert.equal(after[0].text,slide.title);assert.equal(after[0].nodeId,'title');assert.deepEqual(after.slice(1),before.slice(1));
  assert.match(requests[0].messages[1].content[0].text,/本次用户明确要求书法字/);
  assert.doesNotThrow(()=>validateAudit(after.map(e=>e.implementation==='svg'?{...e,type:'svg',svg:'<svg/>'}:e),slide,[],p,0));
  await toolEdit(p,{targetKey:'title',userInstruction:'保持字形，只微调位置',issues:[]},[['create_visual_asset',{key:'title',method:'cutout',x:60,y:80,w:800,h:70,prompt:'保持完整字迹与原有笔触，透明背景'}]]);
  assert.equal(p.reconstruction.slides[0].elements[0].artisticText,true);assert.equal(p.reconstruction.slides[0].elements[0].x,60);assert.equal(p.reconstruction.slides[0].elements[0].text,slide.title);
  undoRebuildEdit(p,0);assert.deepEqual(p.reconstruction.slides[0].elements,before);
});
test('书法补拆拒绝越权替换和改字，普通补拆仍不能抠取文字',async()=>{
  const p=project(),before=structuredClone(p.reconstruction.slides[0].elements),scope=extractionScope({x:50,y:80,w:800,h:70},before,'title');
  assert.throws(()=>validateExtractionScope(before.map(e=>e.key==='body'?{...e,size:90}:e),scope),/已有元素/);
  assert.throws(()=>validateExtractionScope(before.map(e=>e.key==='title'?{...e,type:'image',id:'new',implementation:'cutout',artisticText:true,text:'改写标题'}:e),scope),/已有元素/);
  const ordinary=await toolEdit(p,{regionScope:extractionScope({x:50,y:80,w:800,h:70},before),userInstruction:'抠出文字',issues:[]},[['create_visual_asset',{method:'cutout',key:'new-text',x:50,y:80,w:800,h:70,sourceBox:{x:50,y:80,w:800,h:70},prompt:'提取文字并保持完整'}]]);
  assert(!ordinary.result.changed);assert(ordinary.result.session.history.some(e=>e.status==='failed'));
  const image={...before[0],type:'image',id:'unregistered',implementation:'cutout',artisticText:true};
  assert.throws(()=>validateAudit([image,...before.slice(1).map(e=>e.implementation==='svg'?{...e,type:'svg',svg:'<svg/>'}:e)],slide,[],p,0),/用户指定/);
});

test('只框选时模型自动识别书法字并替换原生文字，新素材key自动映射，失败后可重试且其他项锁定',async()=>{
 const p=project(),before=structuredClone(p.reconstruction.slides[0].elements),regionScope=extractionScope({x:60,y:90,w:100,h:40},before,undefined,{automaticTarget:true});
 rememberRebuildEdit(p,'统一框选补拆',0);
 const {result,requests}=await toolEdit(p,{regionScope,userInstruction:'提取框选区域中的完整目标并自动选择重建方式',issues:[]},[
 ['inspect_page',{}],
 ['create_visual_asset',{method:'cutout',key:'new-calligraphy',contentType:'artistic_text',textKey:'not-a-node',x:50,y:80,w:800,h:70,sourceBox:{x:50,y:80,w:800,h:70},prompt:'抠出完整书法字并保留笔触'}],
 ['create_visual_asset',{method:'cutout',key:'new-calligraphy',contentType:'artistic_text',x:50,y:80,w:800,h:70,sourceBox:{x:50,y:80,w:800,h:70},prompt:'抠出完整书法字并保留笔触'}]
 ]);
 assert(result.changed);assert.equal(p.reconstruction.slides[0].elements.length,before.length);
 assert.equal(p.reconstruction.slides[0].elements[0].key,'title');assert.equal(p.reconstruction.slides[0].elements[0].type,'image');assert.equal(p.reconstruction.slides[0].elements[0].text,slide.title);assert.deepEqual(p.reconstruction.slides[0].elements.slice(1),before.slice(1));
 assert(result.session.history.some(e=>e.status==='failed'));const inspect=result.session.history.find(e=>e.name==='inspect_page');assert(inspect.result.artisticTextCandidates.some(e=>e.key==='title'));assert.match(requests[0].messages[1].content[0].text,/统一框选/);
 undoRebuildEdit(p,0);assert.deepEqual(p.reconstruction.slides[0].elements,before);
});
test('统一框选提取普通SVG图标不修改任何文字，也不会启用书法字替换',async()=>{
 const p=project(),before=structuredClone(p.reconstruction.slides[0].elements),regionScope=extractionScope({x:1300,y:600,w:100,h:100},before,undefined,{automaticTarget:true});
 const {result}=await toolEdit(p,{regionScope,userInstruction:'提取框选中的完整目标',issues:[]},[['create_visual_asset',{method:'svg',contentType:'visual',key:'new-icon',x:1300,y:600,w:100,h:100,svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M0 0L100 100L0 100Z"/></svg>'}]]);
 assert(result.changed);assert(!regionScope.artisticText);assert.deepEqual(p.reconstruction.slides[0].elements.slice(0,before.length),before);
});

test('统一框选后端接受空说明与纯区域请求，进入自动匹配路径，不调用AI或修改项目结果',async()=>{
 const {visualAction}=await import('../lib/visual-pipeline.mjs');
 const p=project(),before=structuredClone(p.reconstruction);let launched;
 const accepted=await visualAction(p,{action:'extractRebuildRegion',index:0,previewHash:'preview',region:{x:60,y:90,w:100,h:40}}, {ensure:(_p,ok,message)=>{if(!ok)throw Error(message);},launch:(_p,label,run)=>{launched={label,run};},save(){},event(){}});
 assert.equal(accepted,true);assert.equal(typeof launched.run,'function');assert.equal(launched.label,'框选区域补拆与渲染');assert.deepEqual(p.reconstruction,before);assert.match(Object.values(p.rebuildElementFeedback)[0].instruction,/自动选择重建方式/);
});

test('书法抠图接口503在传输重试耗尽后停止工具会话，保留原文字并准确返回失败原因',async()=>{
 const p=project(),before=structuredClone(p.reconstruction.slides[0]),materials=structuredClone(p.materials);
 const regionScope=extractionScope({x:50,y:80,w:800,h:70},before.elements,undefined,{automaticTarget:true});let generationCalls=0;
 const {result,requests}=await toolEdit(p,{regionScope,userInstruction:'抽出框中的书法字',issues:[]},[
 ['create_visual_asset',{key:'glyph',method:'cutout',contentType:'artistic_text',textKey:'title',x:50,y:80,w:800,h:70,sourceBox:{x:50,y:80,w:800,h:70},prompt:'保留完整书法字与笔触，透明背景'}],
 ['apply_page_patch',{edits:[{key:'title',properties:{size:90}}]}]
 ],{createAsset:async()=>{generationCalls++;throw Object.assign(Error('API 返回 HTTP 503；本次最多3次请求后仍未获得图片'),{httpStatus:503,retryable:true});}});
 assert.equal(generationCalls,1,'不让模型重复触发已耗尽的生图重试');assert.equal(requests.length,1);assert.equal(result.session.stopped,true);assert.equal(result.session.calls,1);assert.equal(result.changed,false);assert.equal(result.session.history[0].result.httpStatus,503);assert.match(result.errors[0],/书法字抠图接口暂不可用.*503/);assert.deepEqual(p.reconstruction.slides[0].elements,before.elements);assert.deepEqual(p.materials,materials);
});

test('书法字备用本地素材仍自动替换原生文字并按本实例裁边定位，可撤回',async()=>{
 const p=project(),before=structuredClone(p.reconstruction.slides[0].elements),regionScope=extractionScope({x:50,y:80,w:800,h:70},before,undefined,{automaticTarget:true});
 rememberRebuildEdit(p,'本地替代路径',0);
 const {result}=await toolEdit(p,{regionScope,userInstruction:'提取框选目标',issues:[]},[['create_visual_asset',{key:'glyph',method:'cutout',contentType:'artistic_text',textKey:'title',x:50,y:80,w:800,h:70,sourceBox:{x:50,y:80,w:800,h:70},prompt:'保留原有书法字形'}]],{createAsset:async()=>({id:'new',kind:'image',sha256:'hash',localCutout:true,localTrim:{left:.1,top:.1,width:.8,height:.8}})});
 assert(result.changed);const glyph=p.reconstruction.slides[0].elements[0];assert.equal(glyph.type,'image');assert.equal(glyph.text,slide.title);assert.equal(glyph.cutoutMethod,'local-reference');assert.equal(glyph.x,130);assert.equal(glyph.w,640);assert.deepEqual(p.reconstruction.slides[0].elements.slice(1),before.slice(1));undoRebuildEdit(p,0);assert.deepEqual(p.reconstruction.slides[0].elements,before);
});

test('成功抠图立即发布可查看素材，下一轮模型仍运行时清单已替换，最终提交后保持一致',async()=>{
 const {rebuildAssetInventory}=await import('../lib/rebuild-output.mjs');
 const p=project(),regionScope=extractionScope({x:50,y:80,w:800,h:70},p.reconstruction.slides[0].elements,undefined,{automaticTarget:true});let checked=false,saves=0;
 const {result}=await toolEdit(p,{regionScope,userInstruction:'抠出书法字',issues:[]},[['create_visual_asset',{key:'glyph',method:'cutout',contentType:'artistic_text',textKey:'title',x:50,y:80,w:800,h:70,sourceBox:{x:50,y:80,w:800,h:70},prompt:'抠出书法字'}]],{env:{save(){saves++;}},onRequest(turn,p){if(turn===1){checked=true;assert.equal(p.reconstruction.slides[0].elements[0].type,'text');const glyph=rebuildAssetInventory(p)[0].elements.find(e=>e.key==='title');assert(glyph.artisticText);assert.equal(glyph.id,'new');assert.equal(p.rebuildAssetPreview.status,'partial');}}});
 assert(result.changed&&checked);assert(saves>0);assert.equal(p.reconstruction.slides[0].elements[0].type,'image');assert.equal(p.rebuildAssetPreview.status,'done');
});
