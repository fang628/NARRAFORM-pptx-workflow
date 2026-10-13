import test from 'node:test';
import assert from 'node:assert/strict';
import {repairRebuiltPage,patchRebuiltScene} from '../lib/rebuild-tools.mjs';
import {extractionScope,validateExtractionScope} from '../lib/rebuild-region.mjs';
import {rememberRebuildEdit,undoRebuildEdit,rebuildUndoState} from '../lib/rebuild-undo.mjs';
import {rebuildReviewLoop} from '../lib/rebuild-review-loop.mjs';
import {visualStamp,validateAudit} from '../lib/visual-model.mjs';
import {expectedRebuildText,splitHeadingNumber} from '../lib/rebuild-text-parts.mjs';
import {regionFromPoints,logicalRegionPoint} from '../public/visual-ui.js';
import {rebuildAssetsPanel,visualDelivery} from '../public/visual-ui.js';

const text=(key,nodeId,value,y)=>({key,type:'text',nodeId,text:value,x:50,y,w:800,h:70,size:30,bold:false,color:'272727',align:'left'});
const slide={title:'准确标题',body:['准确正文'],sources:[]};
const elements=()=>[text('title','title',slide.title,80),text('body','body-0',slide.body[0],250),{key:'icon',type:'image',id:'old',implementation:'svg',x:1100,y:650,w:100,h:100,description:'平面图标'},{key:'block',type:'rect',x:1000,y:450,w:200,h:100,fill:'EEEEEE',color:'333333',strokeWidth:0,opacity:1}];
function project(){const p={id:'test',version:1,brief:{progress:false},slides:[slide],concepts:[],visualPages:[{images:[],previewHash:'preview'}],materials:[{id:'old',kind:'image'}],approvals:{preview:1},task:{status:'done'}};p.reconstruction={mode:'free',stamp:visualStamp(p),slides:[{index:0,elements:elements()}],assets:['old']};return p;}
async function toolEdit(p,review,commands){let turns=0;const records=[],requests=[];const result=await repairRebuiltPage({p,index:0,review,round:1,env:{system:'JSON',credentials:new Map([[p.id,{text:{key:'fixture',model:'main'}}]])},reference:'reference',rendered:'rendered',background:'background',createAsset:async()=>({id:'new',sha256:'hash',kind:'image'}),renderScene:async()=>'',record:r=>records.push(structuredClone(r)),requestModel:async(c,e,b)=>{requests.push(b);return {choices:[{message:turns++===0?{content:null,tool_calls:commands.map(([name,args],i)=>({id:'tool-'+i,type:'function',function:{name,arguments:JSON.stringify(args)}}))}:{content:'{"done":true}'}}]};}});return {result,records,requests};}

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
  rememberRebuildEdit(p,'修改图标');p.reconstruction.slides[0].elements[2].id='new';p.candidate={id:'new'};p.output=null;p.rebuildLive.revision=8;
  assert.equal(rebuildUndoState(p).available,true);undoRebuildEdit(p);assert.deepEqual(p.reconstruction,original);assert.equal(p.candidate.id,'original');assert.equal(p.output.file,'deck.pptx');assert.equal(p.rebuildLive.revision,7);
  rememberRebuildEdit(p,'再次修改');p.version++;assert.equal(rebuildUndoState(p).available,false);assert.throws(()=>undoRebuildEdit(p),/版本/);
});

test('编号与小标题/目录文字必须独立，分拆不改变准确文案，正文年份不误拆',()=>{
  const s={title:'标题',body:[],elements:[{id:'title',type:'text',role:'title',text:'标题',parentId:null},{id:'group',type:'group',role:'body',label:'01 研究背景',parentId:'title'}]},raw=[text('title','title','标题',80),text('group','group','01 研究背景',200)];
  assert.throws(()=>validateAudit(raw,s,[]),/独立文字/);
  const parts=[raw[0],{...raw[1],key:'number',part:'number',text:'01',w:100},{...raw[1],key:'label',part:'label',text:'研究背景',x:170,w:600}];const audit=validateAudit(parts,s,[]);assert.equal(audit[1].sourceText,'01 研究背景');assert.equal(audit[2].text,'研究背景');assert.throws(()=>validateAudit(parts.slice(0,2),s,[]),/遗漏/);
  assert.equal(splitHeadingNumber('2024年研究'),null);assert.deepEqual(splitHeadingNumber('1.2 研究方法'),{number:'1.2',label:'研究方法'});
  const p={brief:{toc:true,cover:false},slides:[{kind:'toc'}]},nodes=[{nodeId:'body-0',role:'body',text:'研究目标'}];assert.equal(expectedRebuildText({nodeId:'toc-number-body-0',forNodeId:'body-0',role:'toc-number',text:'01'},nodes,p,0).synthetic,true);assert.throws(()=>expectedRebuildText({nodeId:'toc-number-body-0',forNodeId:'body-0',role:'toc-number',text:'02'},nodes,p,0));
});

test('05按页分框、元素滚动、黄色问题可收起，修改只有原对比位置且可撤回',()=>{
  const p=project();p.visualMode='ai';p.fullPreviewPages=[true];p.rebuildAssets=[{index:0,elements:[{key:'icon',description:'<图标>',targetStamp:'stamp',type:'image',implementation:'svg'}],textStyles:[]}];p.visualReconstructionCurrent=true;p.singleElementEditing=true;p.regionExtraction=true;p.rebuildUndo={available:true};p.candidate={id:'candidate',structure:{passed:true},designStandards:{passed:false,issues:[]},review:{pages:[{index:0,passed:false,issues:['<字号过小>'],deviations:[],notes:''}]}};
  const html=visualDelivery(p,()=>'',()=>''),assets=rebuildAssetsPanel(p,0);assert.match(html,/data-release-page="0"/);assert.match(html,/rebuild-assets-scroll/);assert.match(html,/<details class="release-issue-panel"><summary>检查问题/);assert.match(html,/&lt;字号过小&gt;/);assert(!html.includes('rebuild-live-grid'));assert.match(html,/undoRebuildEdit/);assert.match(assets,/data-revise-rebuild-element="icon"/);assert.match(html,/data-extract-rebuild-region="0"/);
});
