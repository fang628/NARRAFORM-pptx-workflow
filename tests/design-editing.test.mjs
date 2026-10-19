import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {initialElements} from '../lib/elements.mjs';
import {pageDesignPrompt,pageDesignStamp,renderPageDesign,checkDesignEdits,pageDesignState} from '../lib/page-design.mjs';
import {syncPageDesignText} from '../lib/page-design-text.mjs';
import {designEditingActive,designOutputBusy} from '../public/design-editing.js';
import {enqueueImageTask,checkImageTaskGuard} from '../lib/image-task-queue.mjs';
import {enterVisualStage} from '../lib/content-stage.mjs';
import {pageDesignPanel} from '../public/page-design.js';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';
function project(){
 const p={id:'p',version:1,brief:{title:'测试',cover:false,progress:false},slides:['第一页','第二页'].map(title=>({title,kind:'content',body:['原文内容'],sources:[]})),materials:[],pageDesigns:{},approvals:{}};
 for(let i=0;i<2;i++){
  p.slides[i].elements=initialElements(p.slides[i]);
  const plan=JSON.parse(fixtureReply({messages:[{role:'user',content:pageDesignPrompt(p,i)}]}).choices[0].message.content),stamp=pageDesignStamp(p,i);
  p.pageDesigns[i]={plan,contentSnapshot:structuredClone(p.slides[i]),draftStamp:stamp,layoutStamp:stamp,layoutApprovedAt:'old',approvedAt:'old',markdown:renderPageDesign(p,i,plan)+'\n用户保留的设计说明：使用弧形布局。'};
 }
 return p;
}
test('仅同步文案不请求模型，保留排版与自定义设计说明，更新准确内容后重新确认',()=>{
 const p=project(),before=structuredClone(p.pageDesigns[0]),node=p.slides[0].elements.find(n=>n.type==='text'&&n.role==='body');node.text='修改后的准确文案';p.slides[0].body=['修改后的准确文案'];
 const d=syncPageDesignText(p,0);
 assert.deepEqual(d.plan.nodes,before.plan.nodes);assert.deepEqual(d.plan.readingOrder,before.plan.readingOrder);
 assert.match(d.markdown,/修改后的准确文案/);assert.doesNotMatch(d.markdown,/原文内容/);assert.match(d.markdown,/用户保留的设计说明：使用弧形布局/);
 assert.equal(checkDesignEdits(d.markdown,p,0,d.plan),d.markdown);assert.ok(pageDesignState(p,0).current);assert.equal(d.approvedAt,null);
 const other=structuredClone(p.pageDesigns[1]);node.text='第二次修改';p.slides[0].body=['第二次修改'];syncPageDesignText(p,0);assert.match(p.pageDesigns[0].markdown,/第二次修改/);assert.deepEqual(p.pageDesigns[1],other);
});
test('结构、素材或设计依据改变时拒绝伪装为文案同步；旧项目支持原设计快照回退',()=>{
 for(const change of [p=>p.slides[0].elements.at(-1).layout='row',p=>p.slides[0].elements.pop(),p=>p.brief.title='不同需求']){
  const p=project(),before=structuredClone(p.pageDesigns[0]);change(p);assert.throws(()=>syncPageDesignText(p,0),/变化/);assert.deepEqual(p.pageDesigns[0],before);
 }
 const p=project(),old=structuredClone(p.slides[0]);delete p.pageDesigns[0].contentSnapshot;
 p.reuseCheckpoint={source:{slides:[{...old,title:'无关旧版本'}]}};
 p.slides[0].elements.at(-1).text='兼容旧项目的新文案';syncPageDesignText(p,0,old);assert.match(p.pageDesigns[0].markdown,/兼容旧项目的新文案/);
});
test('编辑权限仅在设计任务放开，排队单页设计不被其他页文案修改作废',()=>{
 const p=project();p.task={status:'running',contentEditing:true,designIndices:[0]};assert.ok(designEditingActive(p));assert.ok(designOutputBusy(p,0));assert.equal(designOutputBusy(p,1),false);
 const q=enqueueImageTask(p,{action:'designPage',index:1});p.version++;p.slides[0].body=['修改别页'];checkImageTaskGuard(p,q);p.slides[1].body=['修改目标页'];assert.throws(()=>checkImageTaskGuard(p,q),/已变化/);
 p.task={status:'running',label:'生图任务'};assert.equal(designEditingActive(p),false);
 const html=pageDesignPanel({...project(),designConcurrentEditingEnabled:true},0);assert.match(html,/data-page-design-action="syncPageDesignText"/);
});
test('真实HTTP：设计生成时可保存其他页、直接同步及确认，不覆盖编辑，过期本页结果不提交',{timeout:30000},async t=>{
 let release,entered,hold=false,calls=0;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const model=http.createServer(async(req,res)=>{
  const b=await fixtureRequest(req);calls++;const reply=fixtureReply(b);
  if(hold){hold=false;entered();await gate;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
 });await new Promise(r=>model.listen(0,'127.0.0.1',r));t.after(()=>{release();model.closeAllConnections();model.close();});
 const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:path.resolve('work','design-editing-'+port+'-'+Date.now()),PPT_AGENT_TEST:'1'},windowsHide:true,stdio:'ignore'});t.after(()=>app.kill());
 const base='http://127.0.0.1:'+port;
 for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,20));}
 const api=async(url,body,status=200)=>{const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v;};
 let p=await api('/api/projects',{brief:{title:'并行编辑测试',cover:false,pages:2}} ,201);const url='/api/projects/'+p.id,act=(action,extra={},status=200)=>api(url+'/action',{action,...extra},status);
 const idle=async()=>{for(let i=0;i<800;i++){p=await api(url);if(p.task.status!=='running'&&!p.imageTaskQueue.some(q=>q.status==='queued'))return p;await new Promise(r=>setTimeout(r,20));}throw Error('任务超时');};
 await act('configure',{text:{baseURL:'http://127.0.0.1:'+model.address().port+'/v1',model:'mock',key:'synthetic'}});
 await act('requirements',{brief:p.brief});
 p=await act('saveContent',{slides:project().slides});
 for(const index of [0,1]){await act('designPage',{index});await idle();}
 hold=true;await act('designPage',{index:0});await started;p=await api(url);assert.ok(p.task.contentEditing);
 const targetMarkdown=p.pageDesigns[0].markdown,slides=structuredClone(p.slides);slides[1].elements.find(n=>n.role==='body').text='别页新文案';slides[1].body=['别页新文案'];
 p=await act('saveContent',{slides});assert.equal(p.task.status,'running');
 const beforeCalls=calls;p=await act('syncPageDesignText',{index:1,slides:p.slides});assert.equal(calls,beforeCalls);assert.match(p.pageDesigns[1].markdown,/别页新文案/);
 p=await act('approvePageDesign',{index:1});assert.ok(p.pageDesigns[1].approvedCurrent);
 await act('syncPageDesignText',{index:0,slides:p.slides},400);
 await act('requirements',{brief:p.brief},400);
 const newer=structuredClone(p.slides);newer[0].elements.find(n=>n.role==='body').text='生成期间修改本页';newer[0].body=['生成期间修改本页'];
 await act('saveContent',{slides:newer});release();await idle();
 assert.equal(p.pageDesigns[0].markdown,targetMarkdown);assert.equal(p.pageDesigns[0].generation.status,'stale');assert.equal(p.slides[0].body[0],'生成期间修改本页');assert.ok(p.pageDesigns[1].approvedCurrent);
 p=await act('syncPageDesignText',{index:0,slides:p.slides});assert.ok(p.pageDesigns[0].current);assert.match(p.pageDesigns[0].markdown,/生成期间修改本页/);
 const beforeEntryCalls=calls;p=await act('enterVisualStage',{slides:p.slides});assert.equal(calls,beforeEntryCalls);assert.equal(p.approvals.content,p.version);assert.ok(p.pageDesigns[0].approvedCurrent&&p.pageDesigns[1].approvedCurrent);assert.deepEqual(p.confirmedVisualPages,[0,1]);assert.ok(p.enterVisualStageEnabled);
});

test('网页实际禁用策略允许文本、保存和其他页设计说明，只保护生成中的设计稿',()=>{
 const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),start=source.indexOf('const canEditDuringDesign='),end=source.indexOf('const canAddWhileBusy=',start);
 const p={designConcurrentEditingEnabled:true,task:{status:'running',contentEditing:true,designIndices:[0]}};
 const context={p,designEditingActive,designOutputBusy};vm.createContext(context);vm.runInContext(source.slice(start,end)+';globalThis.allowed=canEditDuringDesign;',context);
 const field=(selectors,dataset={},inside=true)=>({dataset,closest:()=>inside?{}:null,matches:query=>query.split(',').some(s=>selectors.includes(s.trim()))});
 assert.ok(context.allowed(field(['textarea'])));
 assert.ok(context.allowed(field(['#slidesForm button[type=submit]'],{},false)));
 assert.ok(context.allowed(field(['textarea','[data-design-markdown]'],{designMarkdown:'1'})));
 assert.equal(context.allowed(field(['textarea','[data-design-markdown]'],{designMarkdown:'0'})),false);
 assert.ok(context.allowed(field(['[data-page-design-action=syncPageDesignText]'],{page:'1'})));
 assert.equal(context.allowed(field(['[data-page-design-action=syncPageDesignText]'],{page:'0'})),false);
 assert.equal(context.allowed(field(['input'],{},false)),false,'全局需求仍保护共享设计依据');
 p.task.contentEditing=false;assert.equal(context.allowed(field(['textarea'])),false);
});

test('下一步默认批准所有有效设计，保存设计说明与文案；不需要逐页确认',()=>{
 const p=project();p.approvals.requirements=1;for(const d of Object.values(p.pageDesigns))d.approvedAt=null;
 const slides=structuredClone(p.slides);slides[0].body=['下一步同步的正文'];slides[0].elements.find(n=>n.role==='body').text='下一步同步的正文';
 const markdown=p.pageDesigns[1].markdown+'\n额外人工说明：使用斜切。';
 const result=enterVisualStage(p,{slides,designDrafts:[{index:1,markdown}]},{contentChanged:d=>{d.version++;d.approvals.content=null;d.stage=2;}});
 assert.deepEqual(result.accepted,[0,1]);assert.deepEqual(result.synced,[0]);assert.equal(p.approvals.content,p.version);assert.equal(p.stage,3);
 assert.ok(p.slides.every((_,i)=>pageDesignState(p,i).approvedCurrent));assert.match(p.pageDesigns[0].markdown,/下一步同步的正文/);assert.match(p.pageDesigns[1].markdown,/额外人工说明：使用斜切/);
 assert.equal(p.pageDesigns[1].approvalMethod.mode,'enter-next-stage');
 const html=pageDesignPanel({...p,enterVisualStageEnabled:true,pageDesigns:{0:pageDesignState(p,0)}},0);assert.doesNotMatch(html,/data-page-design-action="approvePageDesign"/);assert.match(html,/进入下一步时默认确认/);
});
test('下一步不强制等待全部页面，未完成页留在原步骤；无有效设计时原子保留编辑',()=>{
 const p=project();p.approvals.requirements=1;delete p.pageDesigns[1];
 const result=enterVisualStage(p);assert.deepEqual(result.accepted,[0]);assert.equal(result.skipped[0].index,1);assert.ok(pageDesignState(p,0).approvedCurrent);
 const q=project();q.approvals.requirements=1;const before=structuredClone(q),slides=structuredClone(q.slides);for(const s of slides)s.elements.pop();
 assert.throws(()=>enterVisualStage(q,{slides},{contentChanged:d=>d.version++}),/暂无可用设计稿/);assert.deepEqual(q,before);
});
