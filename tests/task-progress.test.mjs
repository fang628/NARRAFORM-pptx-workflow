import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chat} from '../lib/provider.mjs';
import {observeTask,recordProgress,reportTask} from '../lib/task-progress.mjs';
import {taskProgress} from '../public/task-progress.js';

test('任务记录有界，更新请求条目，前端转义模型与材料文字',()=>{
  const task={status:'running',label:'<script>alert(1)</script>',startedAt:new Date().toISOString()};
  recordProgress(task,{id:'call',kind:'request',status:'running',message:'<img onerror=alert(1)>'});
  recordProgress(task,{id:'call',kind:'request',status:'done',message:'完成',durationMs:1200});
  assert.equal(task.progress.length,1);assert.equal(task.progress[0].durationMs,1200);
  recordProgress(task,{kind:'summary',message:'<svg onload=alert(1)>'});
  const html=taskProgress(task);assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<svg onload'));assert.match(html,/&lt;svg/);
  for(let i=0;i<150;i++)recordProgress(task,{message:'x'.repeat(1000),key:'should-not-copy'});
  assert.equal(task.progress.length,100);assert.equal(task.progress[0].message.length,600);assert.equal(task.progress[0].key,undefined);
});

test('真实请求生命周期与返回摘要可观察，忽略私有推理；失败和取消保留状态',async t=>{
  process.env.PPT_AGENT_TEST='1';t.after(()=>delete process.env.PPT_AGENT_TEST);
  let mode='success',release,entered;
  const received=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);assert.match(body.messages[0].content,/executionSummary/);
    if(mode==='success'){entered();await gate;res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({answer:'ok',executionSummary:'已按材料来源整理主题，疑点等待核实。'}),reasoning_content:'PRIVATE_REASONING'}}]}));}
    else if(mode==='failure'){res.statusCode=401;res.end('{}');}
    else res.end('invalid JSON');
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const config={baseURL:`http://127.0.0.1:${server.address().port}/v1`,key:'SECRET_KEY',model:'mock-model'};
  const task={},controller=new AbortController(),stop=observeTask(controller.signal,entry=>recordProgress(task,entry));
  const pending=chat(config,'输出 JSON','PRIVATE_PROMPT',controller.signal);await received;
  assert.equal(task.progress[0].status,'running');release();await pending;
  assert.equal(task.progress[0].status,'done');assert.equal(task.progress[1].kind,'summary');assert.match(task.progress[1].message,/材料来源/);
  const output=JSON.stringify(task);for(const secret of ['SECRET_KEY','PRIVATE_PROMPT','PRIVATE_REASONING'])assert.ok(!output.includes(secret));
  mode='failure';await assert.rejects(chat(config,'JSON','test',controller.signal),/401/);assert.equal(task.progress.at(-1).status,'failed');
  controller.abort();await assert.rejects(chat(config,'JSON','test',controller.signal),/取消/);assert.equal(task.progress.at(-1).status,'cancelled');
  stop();const count=task.progress.length;reportTask(controller.signal,{message:'ignored'});assert.equal(task.progress.length,count);
});
