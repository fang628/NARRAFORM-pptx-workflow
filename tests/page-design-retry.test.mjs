import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {generatePageDesign,draftPageDesigns,pageDesignState,pageDesignPrompt} from '../lib/page-design.mjs';
import {pageDesignPanel} from '../public/page-design.js';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';
const project=()=>({id:'p',brief:{title:'重试验证',pages:3,cover:false},slides:['正常页','恢复页','待补页'].map(title=>({kind:'content',title,body:['保留原文'],sources:[]})),materials:[],pageDesigns:{},task:{},executionConcurrency:2});
const reply=prompt=>fixtureReply({messages:[{role:'user',content:prompt}]}).choices[0].message.content;

test('初次设计和意见修订均要求页面创意，并在设计意图解释表达作用',()=>{
  const p=project();
  for(const options of [{},{instruction:'突出两组对比',markdown:'已有设计稿'}]){
    const prompt=pageDesignPrompt(p,0,options);assert.match(prompt,/页面排版须有创意/);assert.match(prompt,/说明本页创意与表达作用/);assert.match(prompt,/避免每页机械套用同一平铺模板/);assert.match(prompt,/不改写文案、分组名、素材身份、节点层级或顺序/);
    assert.match(prompt,/哪些具体内容之间加哪种箭头、表达什么联系/);assert.match(prompt,/并列不连箭头/);assert.doesNotMatch(prompt,/connections:\[|from:"已有起点|to:"已有终点/);
    assert.match(prompt,/适合时必须采用特殊分块/);assert.match(prompt,/确定适合的方向必须落实到 layoutIntent、节点 position\/carrier 和 style/);assert.match(prompt,/多个方向均适合时选表达作用最强的一种/);
  }
});

test('本页格式错误与节点遗漏触发重生成，第三次恢复；过程可见且不改变内容树',async()=>{
  const p=project(),original=structuredClone(p.slides);let calls=0;
  const result=await generatePageDesign(p,0,{config:{model:'mock'},system:'JSON',signal:new AbortController().signal,request:async(c,s,prompt)=>{
    calls++;if(calls>1)assert.match(prompt,/重新生成完整的本页设计 JSON/);
    const text=reply(prompt),raw=JSON.parse(text);if(calls===2)raw.nodes.pop();
    return {text:calls===1?'JSON 截断':JSON.stringify(raw)};
  }});
  assert.equal(calls,3);assert.equal(result.generation.status,'passed');assert.equal(result.generation.attempt,2);assert.equal(result.generation.history.length,2);assert.deepEqual(p.slides,original);
});

test('取消立即结束；认证失败不盲目重发，已确认上一版和批准状态完整保留',async()=>{
  const p=project(),signal=new AbortController().signal;
  const valid=await generatePageDesign(p,0,{config:{},signal,request:async(c,s,prompt)=>({text:reply(prompt)})});
  p.pageDesigns[0]={draftStamp:valid.stamp,plan:valid.plan,markdown:'已确认设计稿',approvedAt:'confirmed'};
  let calls=0;
  await assert.rejects(generatePageDesign(p,0,{config:{},signal,request:async()=>{calls++;const error=Error('API 返回 HTTP 401');error.httpStatus=401;throw error;}}),/401/);
  assert.equal(calls,1);assert.equal(p.pageDesigns[0].markdown,'已确认设计稿');assert.equal(pageDesignState(p,0).approvedCurrent,true);
  const controller=new AbortController();calls=0;
  await assert.rejects(generatePageDesign(p,1,{config:{},signal:controller.signal,request:async()=>{calls++;controller.abort();throw Error('请求取消');}}));
  assert.equal(calls,1);assert.equal(p.pageDesigns[1].generation.status,'cancelled');
});

test('真实请求批量设计：失败只重生本页，其他页继续，后续补齐不重生成功页',async t=>{
  const previous=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';t.after(()=>{if(previous===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=previous;});
  const counts=new Map();let recoverAll=false;
  const mock=http.createServer(async(req,res)=>{
    const b=await fixtureRequest(req),prompt=b.messages.at(-1).content,slide=JSON.parse(prompt.split('本页：')[1].split('\n')[0]),count=(counts.get(slide.title)||0)+1;counts.set(slide.title,count);
    const response=fixtureReply(b);
    if(!recoverAll&&(slide.title==='恢复页'&&count<3||slide.title==='待补页'))response.choices[0].message.content='{"nodes":[]}';
    res.setHeader('content-type','application/json');res.end(JSON.stringify(response));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const p=project(),cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'mock',key:'synthetic'},env={credentials:new Map([[p.id,{text:cfg}]]),system:'JSON',ensure:(_,ok,message)=>{if(!ok)throw Error(message);},save(){}};
  await draftPageDesigns(p,env,new AbortController().signal,{all:true});
  assert.deepEqual(p.initialDesign.completed,[0,1]);assert.deepEqual(p.initialDesign.failed.map(f=>f.index),[2]);assert.deepEqual([...counts.values()],[1,3,3]);assert.match(p.task.completionMessage,/已跳过并继续任务列表/);
  const successful=structuredClone(p.pageDesigns[0]);recoverAll=true;
  await draftPageDesigns(p,env,new AbortController().signal);
  assert.deepEqual(p.initialDesign.completed,[2]);assert.deepEqual(p.initialDesign.failed,[]);assert.deepEqual(p.pageDesigns[0],successful);assert.equal(counts.get('正常页'),1);assert.equal(counts.get('待补页'),4);
});

test('网页显示本页自动重试和保留上一版，不隐藏最终未完成状态',()=>{
  const p={id:'p',slides:[{}],materials:[],pageDesigns:{0:{markdown:'上一版',current:true,approvedCurrent:true,inputCheck:{warnings:[]},generation:{current:true,status:'failed',attempt:2,limit:2,history:[{message:'节点遗漏'}]}}}};
  assert.match(pageDesignPanel(p,0),/节点遗漏.*上一版已保留.*其他任务继续/);
  p.pageDesigns[0].generation.status='running';assert.match(pageDesignPanel(p,0),/自动重新生成 2\/2/);
});

test('真实HTTP任务列表：单页持续失败也不终止后续设计任务',async t=>{
  let entered,release,first=true;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const mock=http.createServer(async(req,res)=>{
    const b=await fixtureRequest(req),prompt=b.messages.at(-1).content,response=fixtureReply(b),slide=JSON.parse(prompt.split('本页：')[1].split('\n')[0]);
    if(slide.title==='失败页'){if(first){first=false;entered();await gate;}response.choices[0].message.content='{"nodes":[]}';}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(response));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{release();mock.closeAllConnections();mock.close();});
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const dir=path.resolve('work','page-design-retry-'+Date.now()),base='http://127.0.0.1:'+port;
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:dir,PPT_AGENT_TEST:'1'},windowsHide:true,stdio:'ignore'});t.after(()=>app.kill());
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body)=>{const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),j=await r.json();assert.ok(r.ok,JSON.stringify(j));return j;};
  let p=await call('/api/projects',{brief:{title:'任务继续',pages:2,cover:false}});const prefix='/api/projects/'+p.id,act=(action,b={})=>call(prefix+'/action',{action,...b});
  await act('configure',{text:{baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'mock',key:'synthetic'}});
  await act('saveContent',{slides:['失败页','成功页'].map(title=>({title,kind:'content',body:['准确内容'],sources:[]}))});
  await act('designPage',{index:0});await started;await act('designPage',{index:1});release();
  for(let i=0;i<600;i++){p=await call(prefix);if(p.task.status!=='running'&&!p.imageTaskQueue.some(q=>q.status==='queued'))break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(p.task.status,'done',p.task.message);assert.deepEqual(p.imageTaskQueue.map(q=>q.status),['done','done']);
  assert.equal(p.pageDesigns[0].generation.status,'failed');assert.equal(p.pageDesigns[0].markdown,undefined);assert.equal(p.pageDesigns[1].current,true);assert.ok(p.pageDesigns[1].markdown);
  const saved=JSON.parse(fs.readFileSync(path.join(dir,p.id,'project.json'),'utf8'));assert.equal(saved.pageDesigns[0].generation.history.length,3);
});
