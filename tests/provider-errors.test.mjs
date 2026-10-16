import test from 'node:test';
import assert from 'node:assert/strict';
import {contextualError} from '../lib/errors.mjs';
import {lookupAPIAddresses,providerTimeoutMs,generatedImage,safeURL} from '../lib/provider.mjs';

test('给只读 DOMException 加阶段说明不遮蔽原始原因，并保留错误元数据',()=>{
  const original=new DOMException('The operation was aborted due to timeout','TimeoutError');
  const wrapped=contextualError(original,'方向 C · 第 3 页 · 生图请求');
  assert.match(wrapped.message,/方向 C.*原|方向 C.*timeout/);assert.equal(wrapped.cause,original);
  assert.equal(original.message,'The operation was aborted due to timeout');
  const http=Object.assign(Error('权限不足'),{httpStatus:401,retryable:false,responseFormat:true});
  const next=contextualError(http,'模型请求');assert.equal(next.httpStatus,401);assert.equal(next.retryable,false);assert.equal(next.responseFormat,true);
});

test('DNS 只在提交前有限重试，恢复后使用解析结果；持续失败给出真实域名原因',async()=>{
  let calls=0;const waits=[];
  const addresses=await lookupAPIAddresses('provider.example',undefined,{lookup:async()=>{if(++calls<3)throw Object.assign(Error('getaddrinfo ENOTFOUND provider.example'),{code:'ENOTFOUND'});return [{address:'8.8.8.8'}];},wait:async ms=>waits.push(ms)});
  assert.equal(calls,3);assert.deepEqual(waits,[300,600]);assert.equal(addresses[0].address,'8.8.8.8');
  calls=0;
  await assert.rejects(lookupAPIAddresses('invalid.example',undefined,{lookup:async()=>{calls++;throw Object.assign(Error('getaddrinfo ENOTFOUND invalid.example'),{code:'ENOTFOUND'});},wait:async()=>{}}),e=>{assert.match(e.message,/API 域名解析失败.*invalid.example.*ENOTFOUND/);assert.equal(e.code,'ENOTFOUND');return true;});
  assert.equal(calls,3);
  const controller=new AbortController();controller.abort();calls=0;
  await assert.rejects(lookupAPIAddresses('provider.example',controller.signal,{lookup:async()=>{calls++;},wait:async()=>{}}));assert.equal(calls,0);
  await assert.rejects(safeURL('https://192.168.1.2/v1'),/不允许访问/);
});

test('生图响应体超时诊断明确，不重发可能已计费的生图请求',async t=>{
  const previous=process.env.PPT_AGENT_TEST,fetch=globalThis.fetch;process.env.PPT_AGENT_TEST='1';
  t.after(()=>{globalThis.fetch=fetch;if(previous===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=previous;});
  let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));controller.error(new DOMException('body timeout','TimeoutError'));}}),{status:200,headers:{'content-type':'application/json'}});};
  assert.equal(providerTimeoutMs('chat/completions'),180000);assert.equal(providerTimeoutMs('images/edits'),600000);assert.equal(providerTimeoutMs('images/generations'),600000);
  await assert.rejects(generatedImage({baseURL:'http://127.0.0.1:1/v1',model:'mock',key:'synthetic'},'测试'),e=>{assert.match(e.message,/生图请求超过 600 秒/);assert.equal(e.code,'API_TIMEOUT');assert.equal(e.retryable,false);assert.equal(e.cause.name,'TimeoutError');return true;});assert.equal(calls,1);
});
