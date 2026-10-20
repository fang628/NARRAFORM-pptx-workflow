import test from 'node:test';
import assert from 'node:assert/strict';
import {runModelTools} from '../lib/model-tools.mjs';
import {rebuildTools,patchRebuiltScene,safeDecorationCrop,validateRebuiltScene} from '../lib/rebuild-tools.mjs';
import {rebuildReviewLoop} from '../lib/rebuild-review-loop.mjs';
import {validateAudit,nativeSVG} from '../lib/visual-model.mjs';
import {Resvg} from '@resvg/resvg-js';

const slide={title:'准确标题',body:['准确正文'],sources:[]},text=(id,text,y)=>({key:id,type:'text',nodeId:id,text,x:50,y,w:800,h:80,size:30,color:'272727',bold:false}),originalPage={elements:[text('title',slide.title,100),text('body-0',slide.body[0],250),{key:'original',type:'image',id:'original-id',nodeId:'photo',x:1000,y:200,w:400,h:250},{key:'ornament',type:'ellipse',x:1000,y:750,w:50,h:50,fill:'FFF238',opacity:1}]},context={slide,originalPage,assets:[]};

test('工具修改原生图形与排版，保持准确文字、登记原图和可编辑性',()=>{
  const next=patchRebuiltScene(originalPage.elements,{edits:[{key:'body-0',properties:{x:100,w:750,fill:undefined,fontFace:'SimSun',italic:true}}],add:[{key:'diamond',type:'shape',shape:'diamond',x:950,y:700,w:70,h:70,fill:'#fff238'}],remove:['ornament']},context);
  assert.equal(next[1].x,100);assert.equal(next.at(-1).shape,'diamond');assert.equal(next.at(-1).fill,'FFF238');assert.equal(next[1].text,slide.body[0]);assert.equal(originalPage.elements[1].x,50);
  assert.equal(next[1].fontFace,'SimSun');assert.equal(next[1].italic,true);assert.match(nativeSVG(next,()=>''),/font-family="SimSun" font-style="italic"/);
  for(const patch of [{edits:[{key:'title',properties:{text:'篡改'}}]},{remove:['title']},{remove:['original']},{add:[{key:'fake',type:'image',id:'fake'}]},{order:['title']},{edits:[{key:'body-0',properties:{x:2000}}]}])assert.throws(()=>patchRebuiltScene(originalPage.elements,patch,context));
  assert.throws(()=>validateRebuiltScene([...originalPage.elements,{key:'unregistered',type:'image',id:'fake',implementation:'svg',x:1,y:1,w:30,h:30}],context),/通过工具登记/);
});

test('抠图仅裁取独立局部装饰，禁止文字、登记原图和大块排版',()=>{
  assert.equal(safeDecorationCrop({x:900,y:700,w:300,h:180},originalPage).w,300);
  for(const crop of [{x:0,y:0,w:1600,h:900},{x:1000,y:200,w:100,h:100},{x:50,y:100,w:100,h:50}])assert.throws(()=>safeDecorationCrop(crop,originalPage),/只允许|不得包含/);
});

test('原生function calling按tool_call_id返回结果，工具白名单及失败反馈可继续纠正',async()=>{
  const bodies=[],executed=[];let step=0;
  const result=await runModelTools({config:{model:'main'},system:'JSON',content:'修改页面',tools:rebuildTools,requestModel:async(c,e,b)=>{bodies.push(structuredClone(b));return {choices:[{message:step++===0?{tool_calls:[{id:'one',type:'function',function:{name:'apply_page_patch',arguments:'{"edits":[]}'}},{id:'two',type:'function',function:{name:'shell',arguments:'{}'}}]}:{content:'{"done":true,"summary":"修改完成"}'}}]};},execute:async(name,args)=>{executed.push(name);return {output:{changed:true}};}});
  assert.deepEqual(executed,['apply_page_patch']);assert.equal(result.history[1].status,'failed');assert.equal(bodies[1].messages.find(m=>m.tool_call_id==='one').role,'tool');assert.match(bodies[1].messages.find(m=>m.tool_call_id==='two').content,/未授权/);assert.equal(result.mode,'native');
});

test('不支持原生工具时明确使用同模型JSON指令；权限失败不切换模型',async()=>{
  let step=0,executions=0;const configs=[];
  const result=await runModelTools({config:{model:'same-main'},system:'JSON',content:'改排版',tools:rebuildTools,requestModel:async(c,e,b)=>{configs.push(c.model);if(step++===0)throw Object.assign(Error('unsupported tools'),{toolsUnsupported:true});return {choices:[{message:{content:step===2?'{"calls":[{"name":"inspect_page","arguments":{}}]}':'{"done":true}'}}]};},execute:async()=>{executions++;return {output:{}};}});
  assert.equal(result.mode,'json');assert.equal(executions,1);assert.deepEqual(configs,['same-main','same-main','same-main']);
  await assert.rejects(runModelTools({config:{},tools:rebuildTools,requestModel:async()=>{throw Error('HTTP401');}}),/HTTP401/);
});

test('真实渲染闭环多轮修改，只传失败页，到上限仍失败则不开放下载',async()=>{
  let renders=0;const repairs=[];
  const candidate=await rebuildReviewLoop({render:async()=>({id:'c'+renders++,review:{pages:[{index:0,passed:true,issues:[]},{index:1,passed:renders>2,issues:renders>2?[]:['readability']}]}}),repair:async(pages,round)=>{repairs.push({pages:pages.map(r=>r.index),round});return {changed:true};}});
  assert.equal(renders,3);assert.equal(candidate.visualRepair.rounds,2);assert.equal(candidate.visualRepair.status,'passed');assert.deepEqual(repairs,[{pages:[1],round:1},{pages:[1],round:2}]);
  renders=0;const failed=await rebuildReviewLoop({render:async()=>({id:'fail'+renders++,review:{pages:[{index:0,passed:false,issues:['academic_fill']}]}}),repair:async()=>({changed:true})});assert.equal(renders,5);assert.equal(failed.visualRepair.status,'exhausted');assert.equal(failed.review.pages[0].passed,false);
  const stopped=await rebuildReviewLoop({render:async()=>({review:{pages:[{index:0,passed:false,issues:['layout']}]}}),repair:async()=>({changed:false,errors:['工具失败']})});assert.equal(stopped.visualRepair.status,'stalled');
});

test('即使视觉验收通过，用户素材增删意见也会触发工具修改和新一轮实际渲染',async()=>{
  let renders=0;const requests=[];
  const candidate=await rebuildReviewLoop({feedback:[{index:1,instruction:'删除装饰old，新增连接线'}],render:async()=>({id:'r'+renders++,review:{pages:[{index:0,passed:true,issues:[]},{index:1,passed:true,issues:[]}]}}),repair:async pages=>{requests.push(pages);return {changed:true,changedIndices:[1]};}});
  assert.equal(renders,2);assert.equal(requests.length,1);assert.equal(requests[0][0].userInstruction,'删除装饰old，新增连接线');assert.deepEqual(candidate.visualRepair.pendingFeedback,[]);assert.equal(candidate.visualRepair.status,'passed');
});

test('新增复杂原生几何保留独立shape身份并可渲染SVG对照',()=>{
  for(const kind of ['roundRect','triangle','rtTriangle','diamond','hexagon','pentagon','chevron','parallelogram','trapezoid']){
    const elements=validateAudit([text('title',slide.title,100),text('body-0',slide.body[0],250),{key:'shape',type:'shape',shape:kind,x:1000,y:600,w:250,h:150,fill:'#eeeeee',color:'#222',strokeWidth:2}],slide,[]);assert.equal(elements[2].shape,kind);new Resvg(nativeSVG(elements,()=>'' )).render().asPng();
  }
});

test('自动修正无有效变化时保留工具错误并报告已尝试轮数，不以0轮掩盖接口失败',async()=>{
 const messages=[],c=await rebuildReviewLoop({feedback:[{index:0,regionScope:{},instruction:'抠出书法字'}],render:async()=>({id:'old',review:{pages:[{index:0,passed:false,issues:['标题字形不符']} ]}}),repair:async()=>({changed:false,errors:['书法字抠图接口暂不可用（HTTP 503）']}),progress:m=>messages.push(m)});
 assert.equal(c.visualRepair.status,'stalled');assert.equal(c.visualRepair.attemptedRounds,1);assert.equal(c.visualRepair.pendingFeedback.length,1);assert.match(c.visualRepair.errors[0],/503/);assert.match(messages.at(-1),/503/);
});
