import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {projectResultKey,captureLiveView,restoreLiveView} from '../public/task-progress.js';
import {previewImageURL} from '../public/visual-ui.js';

test('进度日志不重绘正文，内容、设计稿、图片与任务状态变化会同步',()=>{
  const p={id:'p',version:1,slides:[],pageDesigns:{},visualPages:{},task:{id:'t',status:'running',message:'等待'},events:[],updatedAt:'old'};
  const tick={...p,task:{...p.task,message:'模型执行中',progress:[{message:'进度'}]},events:[{message:'请求'}],updatedAt:'new',lastUsage:{tokens:20}};
  assert.equal(projectResultKey(p),projectResultKey(tick));
  for(const change of [{slides:[{title:'新内容'}]},{pageDesigns:{0:{markdown:'设计稿'}}},{visualPages:{0:{previewHash:'new'}}},{rebuildLive:{revision:2,pages:[{source:'scene'}]}},{candidate:{review:{pages:[{pending:false}]}}},{task:{id:'t',status:'done'}}])assert.notEqual(projectResultKey(p),projectResultKey({...p,...change}));
  const images={id:'p',version:1,updatedAt:'first',visualPages:{0:{previewHash:'hash-1'}},concepts:[{id:'a',representatives:[{index:0,previewHash:'concept-1'}]}]};
  assert.equal(previewImageURL(images,0),previewImageURL({...images,updatedAt:'tick'},0));
  assert.notEqual(previewImageURL(images,0),previewImageURL({...images,visualPages:{0:{previewHash:'hash-2'}}},0));
  assert.match(previewImageURL(images,0,'a'),/concept-1/);
});

function field(id,value,{original=value,tag='TEXTAREA',context='node',checked=false,defaultChecked=false}={}){
  const attrs=[{name:'id',value:id}],el={tagName:tag,type:tag==='INPUT'?'checkbox':'textarea',value,defaultValue:original,checked,defaultChecked,attributes:attrs,selectionStart:1,selectionEnd:2,disabled:false,
    getAttribute:name=>attrs.find(a=>a.name===name)?.value||null,closest:selector=>selector==='[data-node]'?{getAttribute:()=>context}:null,
    focus(){this.focused=true;},setSelectionRange(start,end){this.selection=[start,end];}};return el;
}
function root(fields,details=[],active=null){return {ownerDocument:{activeElement:active},querySelectorAll:selector=>selector==='details'?details:fields};}
test('刷新只恢复未提交输入、勾选、展开与光标，未修改字段显示最新 AI 值',()=>{
  const dirty=field('text','人工修改',{original:'原稿'}),clean=field('clean','旧 AI 文字'),checkbox=field('check','yes',{tag:'INPUT',checked:true}),detail=field('details','',{tag:'DETAILS'});detail.open=true;
  const snapshot=captureLiveView(root([dirty,clean,checkbox],[detail],dirty));assert.equal(snapshot.drafts.length,2);
  const nextDirty=field('text','AI 新稿'),nextClean=field('clean','新 AI 文字'),nextCheck=field('check','yes',{tag:'INPUT'}),nextDetail=field('details','',{tag:'DETAILS'});nextDetail.open=false;
  const result=restoreLiveView(root([nextDirty,nextClean,nextCheck],[nextDetail]),snapshot);result.focus();
  assert.equal(nextDirty.value,'人工修改');assert.equal(nextClean.value,'新 AI 文字');assert.equal(nextCheck.checked,true);assert.equal(nextDetail.open,true);assert.equal(nextDirty.focused,true);assert.deepEqual(nextDirty.selection,[1,2]);assert.equal(result.missing.length,0);
  const removed=restoreLiveView(root([]),snapshot);assert.equal(removed.missing[0].value,'人工修改');
});

function pollingHarness(p,tab=1){
  const source=fs.readFileSync('public/app.js','utf8'),code=source.slice(source.indexOf('function schedulePoll(){'),source.indexOf('async function create('));
  const ctx={p:structuredClone(p),tab,pollTimer:null,projectRequestRevision:0,renderedResultKey:projectResultKey(p),projectResultKey,activeTaskOrigin:{id:p.task.id,tab},renders:[],toasts:[],timers:[],visualEdit:null,themeAssetEdit:null,readerMaterialId:null,
    setTimeout(fn,delay){ctx.timers.push({fn,delay});return ctx.timers.length;},clearTimeout(){},api:async()=>structuredClone(ctx.response),busy:()=>ctx.p?.task?.status==='running',hasQueuedImages:()=>false,
    aiImageEditor:{refresh(){}},finishPromptTask(){},toast:v=>ctx.toasts.push(v),nav(){},syncImageLibrary(){},$:()=>({open:false}),
    render(options){ctx.renders.push({options,p:structuredClone(ctx.p),tab:ctx.tab});ctx.renderedResultKey=projectResultKey(ctx.p);}};
  ctx.response=structuredClone(p);vm.createContext(ctx);vm.runInContext(code+';schedulePoll();',ctx);
  return ctx;
}
test('真实前端轮询：任务仍运行时就显示逐页结果，空闲更新、失败恢复和切换页保护',async()=>{
  const p={id:'p',slides:[],task:{id:'t',status:'running',label:'生成逐页内容'},stage:2};
  const ctx=pollingHarness(p);ctx.response={...p,slides:[{title:'刚生成的内容树'}]};await ctx.timers.shift().fn();assert.equal(ctx.renders.length,1);assert.equal(ctx.renders[0].p.task.status,'running');assert.equal(ctx.renders[0].p.slides[0].title,'刚生成的内容树');assert.equal(ctx.renders[0].options.keepView,true);
  ctx.response={...ctx.response,task:{...p.task,message:'仅进度变化'}};await ctx.timers.shift().fn();assert.equal(ctx.renders.length,1);
  ctx.tab=0;ctx.response={...ctx.response,task:{...p.task,status:'done',message:'已完成'}};await ctx.timers.shift().fn();assert.equal(ctx.tab,0,'任务结束不把用户拉回原步骤');assert.equal(ctx.timers.at(-1).delay,3000);
  ctx.response={...ctx.response,slides:[{title:'另一个窗口的 AI 结果'}]};await ctx.timers.shift().fn();assert.equal(ctx.renders.at(-1).p.slides[0].title,'另一个窗口的 AI 结果');
  ctx.api=async()=>{throw Error('暂时断开');};await ctx.timers.shift().fn();assert.match(ctx.toasts.at(-1),/自动重试/);assert.ok(ctx.timers.length);
});
test('前端轮询的迟到响应不能覆盖刚提交的操作或切换后的项目',async()=>{
  const p={id:'p',slides:[],task:{id:'t',status:'running'}};
  for(const mutate of [ctx=>ctx.projectRequestRevision++,ctx=>ctx.p={...p,id:'other'},ctx=>ctx.p=null]){
    const ctx=pollingHarness(p);let resolve;ctx.api=()=>new Promise(r=>resolve=r);const pending=ctx.timers.shift().fn();mutate(ctx);resolve({...p,slides:[{title:'过期响应'}]});await pending;assert.equal(ctx.renders.length,0);assert.notEqual(ctx.p?.slides?.[0]?.title,'过期响应');
  }
});
