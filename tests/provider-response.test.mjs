import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chat,generatedImage,parseJSON} from '../lib/provider.mjs';
import {observeTask} from '../lib/task-progress.mjs';

async function mock(t,handler){
  const previous=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';
  const calls=[],server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push(body);handler(res,body,calls.length);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();if(previous===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=previous;});
  return {calls,config:{baseURL:`http://127.0.0.1:${server.address().port}/v1`,model:'mock',key:'PRIVATE_KEY'}};
}
const answer=(res,content,finish_reason='stop')=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content,reasoning_content:'PRIVATE_REASONING'},finish_reason}]}));};

test('JSON 外围说明与围栏可兼容，截断和多个对象不得猜测修补',()=>{
  const expected={images:[{label:'引号 " 和括号 }',w:320,h:180}]};
  for(const text of ['\uFEFF'+JSON.stringify(expected),'```JSON\n'+JSON.stringify(expected)+'\n```','结果如下：\n'+JSON.stringify(expected)+'\n处理完成。'])assert.deepEqual(parseJSON(text),expected);
  for(const text of ['{"images":[','没有输出','{"a":1} {"b":2}','{"text":"缺少闭引号}'])assert.throws(()=>parseJSON(text),/JSON/);
});

test('中转忽略 stream=false 时仍正确拼接 SSE，排除推理字段',async t=>{
  const {config,calls}=await mock(t,(res)=>{res.setHeader('content-type','text/event-stream');
    const chunks=[{choices:[{index:0,delta:{reasoning_content:'PRIVATE_REASONING'}}]},{choices:[{index:0,delta:{content:'{"images":['}}]},{choices:[{index:0,delta:{content:']}'}}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]}];
    res.end(': keepalive\r\n\r\n'+chunks.map(c=>'data: '+JSON.stringify(c)+'\r\n\r\n').join('')+'data: [DONE]\r\n\r\n');
  });const result=await chat(config,'只输出 JSON','检查占位框');assert.deepEqual(parseJSON(result.text),{images:[]});assert.equal(calls.length,1);assert.equal(calls[0].stream,false);assert.ok(!result.text.includes('PRIVATE_REASONING'));
});

test('文字模型格式失败自动重试一次，保留原任务和图像输入',async t=>{
  const {config,calls}=await mock(t,(res,body,count)=>answer(res,count===1?'这是说明文字':'{"images":[]}'));
  const controller=new AbortController(),entries=[];observeTask(controller.signal,e=>entries.push(e));
  const user=[{type:'text',text:'PRIVATE_PROMPT'},{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj'}}];
  const result=await chat(config,'只输出 JSON',user,controller.signal);assert.deepEqual(parseJSON(result.text),{images:[]});assert.equal(calls.length,2);assert.deepEqual(calls[1].messages[1].content,user);assert.match(calls[1].messages[0].content,/上次响应格式不正确/);
  assert.equal(entries.filter(e=>e.kind==='retry').length,1);assert.ok(!JSON.stringify(entries).includes('PRIVATE_'));
});

test('HTTP 200 HTML 错误页诊断明确，文字最多两次，生图最多三次',async t=>{
  const {config,calls}=await mock(t,res=>{res.setHeader('content-type','text/html');res.end('<html>PRIVATE_KEY PRIVATE_PROMPT upstream unavailable</html>');});
  await assert.rejects(chat(config,'JSON','test'),e=>{assert.match(e.message,/chat\/completions.*HTML.*HTTP 200.*text\/html/);assert.ok(!e.message.includes('PRIVATE_'));return true;});assert.equal(calls.length,2);
  await assert.rejects(generatedImage(config,'test'),/images\/generations.*停止重试/);assert.equal(calls.length,5);
});

test('空响应、不完整 SSE 与输出长度截断均有界失败',async t=>{
  let mode='empty';const {config,calls}=await mock(t,res=>{if(mode==='empty')res.end('');else if(mode==='sse'){res.setHeader('content-type','text/event-stream');res.end('data: {"choices":[{"delta":{"content":"{\\\"a\\\":1}"}}]}\n\n');}else answer(res,'{"a":1}','length');});
  await assert.rejects(chat(config,'JSON','test'),/空响应/);assert.equal(calls.length,2);
  mode='sse';await assert.rejects(chat(config,'JSON','test'),/不完整.*SSE/);assert.equal(calls.length,4);
  mode='length';await assert.rejects(chat(config,'JSON','test'),/长度上限被截断/);assert.equal(calls.length,6);
});

test('权限错误与取消不重试，非结构化文字测试保持兼容',async t=>{
  let mode='auth';const {config,calls}=await mock(t,res=>{if(mode==='auth'){res.statusCode=401;res.end('{}');}else answer(res,'连接成功');});
  await assert.rejects(chat(config,'JSON','test'),/401/);assert.equal(calls.length,1);
  mode='text';assert.equal((await chat(config,'简单回复','test')).text,'连接成功');assert.equal(calls.length,2);
  const controller=new AbortController();controller.abort();await assert.rejects(chat(config,'JSON','test',controller.signal),/取消/);assert.equal(calls.length,2);
});
