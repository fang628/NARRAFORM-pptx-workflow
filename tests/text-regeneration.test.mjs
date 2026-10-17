import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chat,request} from '../lib/provider.mjs';
import {regenerateText,textFieldValidator} from '../lib/text-retry.mjs';
import {observeTask} from '../lib/task-progress.mjs';
import {runModelTools} from '../lib/model-tools.mjs';

async function server(t,handler){
  const old=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';
  const calls=[],mock=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));calls.push(body);await handler(res,body,calls.length);});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  t.after(()=>{mock.closeAllConnections();mock.close();if(old===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=old;});
  return {calls,config:{baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'same-model',key:'synthetic-private-key'}};
}
const answer=(res,value)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value),reasoning_content:'private-reasoning'}}]}));};

test('网络和字段结构错误统一有界重生成，同模型、同材料图像和已有结果不变',async t=>{
  const {config,calls}=await server(t,(res,body,count)=>{if(count===1){res.statusCode=503;res.end('{}');}else answer(res,count===2?{prompt:null}:{prompt:'完整的新提示词'});});
  const signal=new AbortController().signal,entries=[];observeTask(signal,e=>entries.push(e));
  const user=[{type:'text',text:'保留确认文案'},{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj'}}];
  const result=await chat(config,'JSON',user,signal,{validate:textFieldValidator('prompt')});
  assert.equal(result.value.prompt,'完整的新提示词');assert.equal(calls.length,3);
  assert.ok(calls.every(b=>b.model==='same-model'&&JSON.stringify(b.messages[1].content)===JSON.stringify(user)));
  assert.match(calls[2].messages[0].content,/上次结构问题/);assert.equal(entries.filter(e=>e.kind==='retry').length,2);
  assert.doesNotMatch(JSON.stringify(entries),/synthetic-private-key|private-reasoning/);
});

test('持续格式失败最多三次，取消和权限错误立即停止',async t=>{
  let mode='invalid';const {config,calls}=await server(t,res=>{if(mode==='auth'){res.statusCode=403;res.end('{}');}else answer(res,{});});
  await assert.rejects(chat(config,'JSON','任务',undefined,{validate:textFieldValidator('prompt')}),error=>error.textRetriesExhausted===true);
  assert.equal(calls.length,3);mode='auth';await assert.rejects(chat(config,'JSON','任务'),/403/);assert.equal(calls.length,4);
  const controller=new AbortController();controller.abort();await assert.rejects(chat(config,'JSON','任务',controller.signal),/取消/);assert.equal(calls.length,4);
  let attempts=0;const waits=[];
  await assert.rejects(regenerateText(async()=>{attempts++;throw Object.assign(Error('network'),{code:'API_NETWORK'});},{wait:async ms=>waits.push(ms)}));
  assert.equal(attempts,3);assert.deepEqual(waits,[300,600]);
});

test('文字超时可重生成；由阶段负责重试时不叠加默认次数',async t=>{
  const originalFetch=globalThis.fetch,old=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';
  t.after(()=>{globalThis.fetch=originalFetch;if(old===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=old;});
  let calls=0;
  globalThis.fetch=async()=>{if(++calls===1)throw new DOMException('timeout','TimeoutError');return new Response(JSON.stringify({choices:[{message:{content:'{"prompt":"恢复结果"}'}}]}),{headers:{'content-type':'application/json'}});};
  const config={baseURL:'http://127.0.0.1:1/v1',model:'mock',key:'synthetic'};
  assert.equal((await chat(config,'JSON','任务')).text,'{"prompt":"恢复结果"}');assert.equal(calls,2);
  calls=0;await assert.rejects(chat(config,'JSON','任务',undefined,{deferJSONValidation:true,retryLimit:0}),/超时|超过/);assert.equal(calls,1);
});

test('模型工具请求只重试失败的当前轮，已完成工具不重复执行',async t=>{
  const {config,calls}=await server(t,(res,body,count)=>{
    res.setHeader('content-type','application/json');
    if(count===1){res.end(JSON.stringify({choices:[{message:{tool_calls:[{id:'one',function:{name:'inspect_page',arguments:'{}'}}]}}]}));return;}
    if(count===2){res.statusCode=502;res.end('{}');return;}
    answer(res,{done:true,summary:'完成'});
  });
  let executions=0;
  const result=await runModelTools({config,system:'JSON',content:'重建当前页',tools:[{type:'function',function:{name:'inspect_page'}}],execute:async()=>{executions++;return {output:{ok:true}};}});
  assert.equal(executions,1);assert.equal(result.history.length,1);assert.equal(calls.length,3);assert.ok(calls[2].messages.some(m=>m.role==='tool'&&m.tool_call_id==='one'));
});

test('原生工具响应缺少 message 也会先自动恢复，而非直接终止',async t=>{
  const {config,calls}=await server(t,(res,body,count)=>{if(count<3){res.setHeader('content-type','application/json');res.end('{"choices":[]}');}else answer(res,{done:true});});
  const result=await request(config,'chat/completions',{messages:[]},undefined,{validate:value=>{if(!value.choices[0]?.message)throw Error('缺少 message');return value;}});
  assert.ok(result.choices[0].message);assert.equal(calls.length,3);
});
