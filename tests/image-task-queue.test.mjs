import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {enqueueImageTask,checkImageTaskGuard,publicImageTasks,interruptImageTasks,moveQueuedImageTask} from '../lib/image-task-queue.mjs';
import {imageTaskChoices,imageQueueView,taskChoicePayload} from '../public/task-progress.js';
import {fixtureRequest,fixtureReply} from './visual-fixture.mjs';

test('生图队列保存提交快照、拒绝重复与未确认、隔离密钥并保护过期目标',()=>{
  const p={brief:{title:'测试'},version:1,slides:[{title:'第一页'}],selectedTheme:'a'},body={action:'generateFullPreview',index:0,prompt:'完整提示词',key:'不得保存'};
  const record=enqueueImageTask(p,body);body.prompt='后来修改';assert.equal(record.request.prompt,'完整提示词');assert.equal(record.request.key,undefined);
  assert.throws(()=>enqueueImageTask(p,{...body,prompt:'完整提示词'}),/相同生图任务/);assert.equal(publicImageTasks(p)[0].request,undefined);
  assert.throws(()=>enqueueImageTask(p,{action:'image',index:0,prompt:'未确认'}),/确认/);
  assert.throws(()=>enqueueImageTask(p,{action:'generateThemeAssets',prompts:[]}),/确认/);
  checkImageTaskGuard(p,record);p.selectedTheme='b';assert.throws(()=>checkImageTaskGuard(p,record),/已变化/);
  interruptImageTasks(p);assert.equal(record.status,'interrupted');
  assert.match(imageQueueView(publicImageTasks(p),true),/任务列表/);assert.doesNotMatch(imageQueueView(publicImageTasks(p),true),/完整提示词|不得保存/);
  assert.equal(imageTaskChoices({imageTaskQueueEnabled:true,elementImageReady:true,slides:[{elements:[{id:'i1',type:'image',label:'机制图'}]}]})[0].request.elementId,'i1');
});

async function setup(t,{holdDesign=false}={}){
  const requests=[],waiting=[],designWaiting=[];let active=0,peak=0;
  const mock=http.createServer(async(req,res)=>{
    const body=await fixtureRequest(req);requests.push({...body,endpoint:req.url});
    if(body.prompt){active++;peak=Math.max(active,peak);await new Promise(resolve=>waiting.push(resolve));active--;}
    if(holdDesign&&JSON.stringify(body.messages||[]).includes('按照 pptx-workflow 1.3'))await new Promise(resolve=>designWaiting.push(resolve));
    if(body.prompt?.includes('模拟请求失败')){res.writeHead(401,{'content-type':'application/json'});res.end('{}');return;}
    const prompt=body.messages?.at(-1)?.content;
    const reply=typeof prompt==='string'&&prompt.startsWith('根据材料写恰好')?{choices:[{message:{content:JSON.stringify({slides:[0,1,2].map(i=>({kind:'content',title:'内容页'+(i+1),body:['用户要求的合成内容'],sources:[],sourceLinks:[]}))})}}]}:fixtureReply(body);
    res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{waiting.splice(0).forEach(r=>r());designWaiting.splice(0).forEach(r=>r());mock.closeAllConnections();mock.close();});
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=path.resolve('work','image-task-queue-'+port+'-'+Date.now()),base='http://127.0.0.1:'+port;
  const start=()=>spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:data},stdio:'ignore',windowsHide:true});
  let app=start();t.after(()=>app.kill());
  const ready=async()=>{for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,20));}throw Error('服务未启动');};await ready();
  const call=async(url,body,status=200)=>{const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v;};
  assert.equal((await fetch(base+'/task-progress.js')).status,200);
  let p=await call('/api/projects',{brief:{title:'分子研究',cover:false,toc:false,pages:3}},201);const prefix='/api/projects/'+p.id;
  const act=(action,extra={},status=200)=>call(prefix+'/action',{action,...extra},status),get=()=>call(prefix);
  const until=async fn=>{for(let i=0;i<1000;i++){p=await get();if(fn(p))return p;await new Promise(r=>setTimeout(r,20));}throw Error('等待超时');};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'mock',key:'synthetic-image-queue-key'};
  await act('configure',{text:cfg,image:cfg});await act('saveContent',{slides:[{kind:'content',title:'分子研究',body:['已有内容'],sources:[]}]});await act('generateThemeAssets');p=await until(p=>p.task.status!=='running');assert.equal(p.task.status,'done',p.task.message);
  return {act,get,until,data,p,requests,releaseDesign:()=>{assert.ok(designWaiting.length,'需有挂起设计请求');designWaiting.shift()();},waitDesign:async n=>{for(let i=0;i<1000;i++){if(requests.filter(r=>JSON.stringify(r.messages||[]).includes('按照 pptx-workflow 1.3')).length>=n&&designWaiting.length)return;await new Promise(r=>setTimeout(r,10));}throw Error('等待设计请求超时');},release:()=>{assert.ok(waiting.length,'需有挂起图片请求');waiting.shift()();},waitImage:async n=>{for(let i=0;i<1000;i++){if(requests.filter(r=>r.prompt).length>=n)return;await new Promise(r=>setTimeout(r,10));}throw Error('等待图片请求超时');},peak:()=>peak,restart:async()=>{await new Promise(r=>{app.once('exit',r);app.kill();});app=start();await ready();}};
}

test('生图执行中可追加、移除任务；按顺序执行，失败和过期任务不堵塞队列',async t=>{
  const x=await setup(t),[a,b,c]=x.p.themeAssetPrompts,submit=entry=>x.act('generateThemeAssets',{confirmed:true,prompts:[entry]});
  await submit(a);await x.waitImage(1);
  let p=await submit(b);assert.equal(p.imageTaskQueue.filter(j=>j.status==='queued').length,1);assert.equal(x.requests.filter(r=>r.prompt).length,1);
  await x.act('generateThemeAssets',{confirmed:true,prompts:[b]},400);
  p=await submit({...c,prompt:c.prompt+'人工最终稿，保持完整。'});const removed=p.imageTaskQueue.at(-1).id;
  await x.act('cancelQueuedImageTask',{id:removed});
  await submit({...c,revision:c.revision-1,prompt:c.prompt+'过期草稿。'});
  await submit({...c,prompt:c.prompt+'模拟请求失败。'});
  await submit({...c,prompt:c.prompt+'成功的最终稿。'});
  await x.act('requirements',{brief:x.p.brief},400);
  x.release();await x.waitImage(2);assert.equal(x.requests.filter(r=>r.prompt)[1].prompt,b.prompt);
  x.release();await x.waitImage(3);assert.match(x.requests.filter(r=>r.prompt)[2].prompt,/模拟请求失败/);
  x.release();await x.waitImage(4);x.release();p=await x.until(p=>p.task.status!=='running'&&!p.imageTaskQueue.some(t=>t.status==='queued'));
  assert.deepEqual(p.imageTaskQueue.map(t=>t.status),['done','done','cancelled','failed','failed','done']);
  assert.match(p.imageTaskQueue[3].message,/已更新/);assert.equal(x.peak(),1);
  assert.equal(x.requests.filter(r=>r.prompt).length,4);assert.ok(x.requests.filter(r=>r.prompt).every(r=>r.endpoint.endsWith('/images/generations')&&!r.referenceImages?.length));
  assert.ok(p.imageTaskQueue.every(t=>!t.request&&!t.guard&&!t.fingerprint));
  const saved=fs.readFileSync(path.join(x.data,p.id,'project.json'),'utf8');assert.ok(!saved.includes('synthetic-image-queue-key'));
});

test('取消全部阻止等待任务启动，重启后明确标记中断且不自动消耗 API',async t=>{
  const x=await setup(t),[a,b]=x.p.themeAssetPrompts,submit=entry=>x.act('generateThemeAssets',{confirmed:true,prompts:[entry]});
  await submit(a);await x.waitImage(1);await submit(b);await x.act('cancel');x.release();
  let p=await x.until(p=>p.task.status!=='running');assert.deepEqual(p.imageTaskQueue.map(t=>t.status),['cancelled','cancelled']);assert.equal(x.requests.filter(r=>r.prompt).length,1);
  await submit(a);await x.waitImage(2);await submit(b);await x.restart();x.release();p=await x.get();
  assert.deepEqual(p.imageTaskQueue.slice(-2).map(t=>t.status),['interrupted','interrupted']);assert.equal(p.apiReady,process.platform==='win32');assert.equal(x.requests.filter(r=>r.prompt).length,2,'恢复密钥后也不能自动重跑中断任务');
});

test('等待任务前后排序保留执行中与历史位置，拒绝过期或非法拖动',()=>{
  const records=[{id:'run',status:'running'},{id:'a',status:'queued'},{id:'history',status:'done'},{id:'b',status:'queued'},{id:'c',status:'queued'}],p={imageTaskQueue:structuredClone(records)};
  moveQueuedImageTask(p,{id:'c',targetId:'a',position:'before'});assert.deepEqual(p.imageTaskQueue.map(t=>t.id),['run','c','history','a','b']);
  moveQueuedImageTask(p,{id:'c',targetId:'b',position:'after'});assert.deepEqual(p.imageTaskQueue,records);
  const snapshot=structuredClone(p);
  for(const move of [{id:'run',targetId:'a',position:'before'},{id:'a',targetId:'history',position:'after'},{id:'missing',targetId:'b',position:'before'},{id:'a',targetId:'a',position:'before'},{id:'a',targetId:'b',position:'inside'}]){assert.throws(()=>moveQueuedImageTask(p,move));assert.deepEqual(p,snapshot);}
  const html=imageQueueView(publicImageTasks(p),true,true);assert.equal((html.match(/data-queue-sort-handle/g)||[]).length,3);
  assert.doesNotMatch(imageQueueView(publicImageTasks(p),true,false),/data-queue-sort-handle/);
  assert.ok(imageQueueView([{id:'waiting',status:'queued'},...Array.from({length:50},(_,i)=>({id:'old'+i,status:'done'}))],true,true).includes('data-image-task-id="waiting"'));
});

test('运行中调整等待顺序并持久保存，新增任务排到末尾，调度按新顺序执行',async t=>{
  const x=await setup(t),[a,b,c]=x.p.themeAssetPrompts,submit=entry=>x.act('generateThemeAssets',{confirmed:true,prompts:[entry]});
  await submit(a);await x.waitImage(1);await submit(b);await submit(c);let p=await submit({...a,prompt:a.prompt+'先生成这个新版本。'});
  assert.equal(p.imageTaskReorderEnabled,true);const [running,second,third,last]=p.imageTaskQueue;
  p=await x.act('moveQueuedImageTask',{id:last.id,targetId:second.id,position:'before'});
  assert.deepEqual(p.imageTaskQueue.map(t=>t.id),[running.id,last.id,second.id,third.id]);
  const saved=JSON.parse(fs.readFileSync(path.join(x.data,p.id,'project.json'),'utf8'));assert.deepEqual(saved.imageTaskQueue.map(t=>t.id),p.imageTaskQueue.map(t=>t.id));
  await x.act('moveQueuedImageTask',{id:running.id,targetId:last.id,position:'after'},400);
  await x.act('moveQueuedImageTask',{id:second.id,targetId:running.id,position:'before'},400);
  p=await submit({...b,prompt:b.prompt+'最后加入的任务。'});assert.equal(p.imageTaskQueue.at(-1).status,'queued');await x.act('cancelQueuedImageTask',{id:p.imageTaskQueue.at(-1).id});
  x.release();await x.waitImage(2);assert.match(x.requests.filter(r=>r.prompt)[1].prompt,/先生成这个新版本/);
  await x.act('moveQueuedImageTask',{id:second.id,targetId:last.id,position:'before'},400);
  x.release();await x.waitImage(3);assert.equal(x.requests.filter(r=>r.prompt)[2].prompt,b.prompt);
  x.release();await x.waitImage(4);assert.equal(x.requests.filter(r=>r.prompt)[3].prompt,c.prompt);x.release();
  p=await x.until(p=>p.task.status!=='running'&&!p.imageTaskQueue.some(t=>t.status==='queued'));assert.deepEqual(p.imageTaskQueue.map(t=>t.status),['done','done','done','done','cancelled']);assert.equal(x.peak(),1);
});

test('设计任务提交快照、修改意见校验与材料变更保护；主模型独立可用',()=>{
  const p={brief:{title:'研究'},version:1,approvals:{requirements:true},slides:[{title:'第一张',sources:['source'],elements:[]}],materials:[{id:'source',text:'原文'}],pageDesigns:{0:{markdown:'原设计稿'}}};
  const content=enqueueImageTask(p,{action:'content'});assert.match(content.label,/逐页内容与设计/);
  const revision=enqueueImageTask(p,{action:'revisePageDesign',index:0,instruction:'留白增大',markdown:'人工编辑稿',key:'secret'});
  assert.equal(revision.request.markdown,'人工编辑稿');assert.equal(revision.request.key,undefined);
  assert.throws(()=>enqueueImageTask(p,{action:'revisePageDesign',index:0,instruction:' '}),/修改意见/);
  assert.throws(()=>enqueueImageTask(p,{action:'designPage',index:2}),/页面不存在/);
  assert.throws(()=>enqueueImageTask({...p,approvals:{}},{action:'content'}),/先确认/);
  p.materials.push({id:'new-background',generated:true,purpose:'workflow-background'});checkImageTaskGuard(p,revision);
  p.pageDesigns[0].markdown='另一版本';assert.throws(()=>checkImageTaskGuard(p,revision),/设计稿已变化/);
  p.materials[0].text='更正原文';assert.throws(()=>checkImageTaskGuard(p,content),/材料或逐页内容已变化/);
  const choices=imageTaskChoices({...p,imageTaskQueueEnabled:true,designTaskQueueEnabled:true,apiReady:true});
  assert.deepEqual(choices.map(c=>c.key),['content','design:missing','design:0','design:revise:0']);
  assert.deepEqual(taskChoicePayload(choices[2]),{action:'designPage',index:0});
  assert.throws(()=>taskChoicePayload(choices[3],''),/修改意见/);
  assert.deepEqual(taskChoicePayload(choices[3],'图片放大'),{action:'revisePageDesign',index:0,markdown:'另一版本',instruction:'图片放大'});
  assert.equal(imageTaskChoices({...p,imageTaskQueueEnabled:true,apiReady:true}).length,0,'旧后端不暴露新入口');
});

test('生图与逐页设计共用任务列表，运行中可相互追加、排序和移除',async t=>{
  const x=await setup(t,{holdDesign:true}),[a,b]=x.p.themeAssetPrompts;
  await x.act('saveContent',{slides:[{title:'第一页',body:['第一段'],sources:[]},{title:'第二页',body:['第二段'],sources:[]}]});
  await x.act('generateThemeAssets',{confirmed:true,prompts:[a]});await x.waitImage(1);
  await x.act('designPage',{index:0});let p=await x.act('designPage',{index:1});
  assert.equal(p.designTaskQueueEnabled,true);assert.equal(p.imageTaskQueue.filter(j=>j.status==='queued').length,2);
  const [image,first,second]=p.imageTaskQueue;
  await x.act('moveQueuedImageTask',{id:second.id,targetId:first.id,position:'before'});
  p=await x.act('draftPageDesigns');await x.act('cancelQueuedImageTask',{id:p.imageTaskQueue.at(-1).id});
  await x.act('designPage',{index:0},400);
  x.release();await x.waitDesign(1);
  p=await x.get();assert.equal(p.imageTaskQueue.find(j=>j.id===second.id).status,'running');assert.equal(p.imageTaskQueue.find(j=>j.id===image.id).status,'done');
  assert.equal(p.pageDesigns[0],undefined);
  await x.act('generateThemeAssets',{confirmed:true,prompts:[b]});
  x.releaseDesign();await x.waitDesign(2);x.releaseDesign();await x.waitImage(2);x.release();
  p=await x.until(p=>p.task.status!=='running'&&!p.imageTaskQueue.some(j=>j.status==='queued'));
  assert.deepEqual(p.imageTaskQueue.map(j=>j.status),['done','done','done','cancelled','done']);
  assert.ok(p.pageDesigns[0].current&&p.pageDesigns[1].current);
  assert.ok(p.task.progress.some(e=>e.kind==='request'));
  assert.equal(x.requests.filter(r=>JSON.stringify(r.messages||[]).includes('按照 pptx-workflow 1.3')).length,2);
});

test('AI 内容与设计初稿本身进入任务列表，内部逐页设计保留并发和进度',async t=>{
  const x=await setup(t,{holdDesign:true});await x.act('requirements',{brief:x.p.brief});
  let p=await x.act('content');assert.match(p.imageTaskQueue[0].label,/逐页内容与设计/);assert.equal(p.imageTaskQueue[0].status,'running');
  await x.waitDesign(3);p=await x.get();assert.equal(p.slides.length,3);assert.equal(p.task.status,'running');
  p=await x.act('designPage',{index:0});assert.equal(p.imageTaskQueue.at(-1).status,'queued');await x.act('cancelQueuedImageTask',{id:p.imageTaskQueue.at(-1).id});
  for(let i=0;i<3;i++)x.releaseDesign();
  p=await x.until(p=>p.task.status!=='running');assert.equal(p.task.status,'done',p.task.message);
  assert.deepEqual(p.imageTaskQueue.map(j=>j.status),['done','cancelled']);assert.equal(Object.keys(p.pageDesigns).length,3);
  assert.equal(p.task.jobs.length,3);assert.ok(p.task.progress.some(e=>e.kind==='request'));
});
