import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {generatedImage} from '../lib/provider.mjs';
import {imageResponse} from '../lib/image-response.mjs';
import {observeTask} from '../lib/task-progress.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64'),b64=png.toString('base64');
async function mock(t,handler){
  const previous=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';const calls=[];
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const raw=Buffer.concat(chunks),multipart=req.headers['content-type']?.startsWith('multipart/');
    const body=req.method==='GET'?null:multipart?await new Request('http://127.0.0.1',{method:'POST',headers:{'content-type':req.headers['content-type']},body:raw}).formData():JSON.parse(raw);
    calls.push({method:req.method,url:req.url,body});await handler(req,res,body,calls);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();if(previous===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=previous;});
  return {calls,config:{key:'PRIVATE_KEY',model:'fixture-image',baseURL:'http://127.0.0.1:'+server.address().port+'/v1'},base:'http://127.0.0.1:'+server.address().port};
}
const json=(res,result)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(result));};

test('读取兼容包装、多个结果、data URL，拒绝空或伪图片，不把聊天内容当成生图',()=>{
  for(const result of [{data:[{b64_json:b64}]},{data:[{}, {b64_json:b64}]},{data:{b64_json:b64}},{result:{images:[{base64:b64}]}},{output:[{image_base64:b64}]},{images:['data:image/png;base64,'+b64]},{url:'data:image/png;base64,'+b64},{image_url:{url:'data:image/png;base64,'+b64}}])assert.deepEqual(imageResponse(result).bytes,png);
  for(const result of [{data:[]},{data:[{b64_json:''}]},{data:[{b64_json:Buffer.from('<html>error</html>').toString('base64')}]},{type:'image_generation.partial_image',b64_json:b64}])assert.throws(()=>imageResponse(result),e=>e.retryable===true);
  assert.throws(()=>imageResponse({choices:[{message:{content:b64}}]}),e=>!e.retryable&&/文字聊天/.test(e.message));
  assert.throws(()=>imageResponse({task_id:'PRIVATE_TASK',status:'processing'}),e=>!e.retryable&&!e.message.includes('PRIVATE_'));
});

test('空结果自动重试后恢复，图生图提示词、参考图、接口保持一致且过程可见',async t=>{
  const {config,calls}=await mock(t,(req,res,body,calls)=>json(res,calls.length===1?{data:[]}:{result:{images:[{base64:b64}]}}));
  const c=new AbortController(),progress=[];observeTask(c.signal,e=>progress.push(e));
  const bytes=await generatedImage(config,'PRIVATE_PROMPT',c.signal,{size:'1920x1080',references:[{bytes:png}]});
  assert.deepEqual(bytes,png);assert.equal(calls.length,2);
  for(const call of calls){assert.equal(call.url,'/v1/images/edits');assert.equal(call.body.get('prompt'),'PRIVATE_PROMPT');assert.equal(call.body.get('size'),'1920x1080');assert.deepEqual(Buffer.from(await call.body.get('image').arrayBuffer()),png);}
  assert.equal(progress.filter(e=>e.kind==='retry').length,1);assert.ok(!JSON.stringify(progress).includes('PRIVATE_'));
});

test('持续空结果最多三次，拒绝/额度/异步结果不重试，取消可中止重试等待',async t=>{
  let mode='empty';const {config,calls}=await mock(t,(req,res)=>json(res,mode==='quota'?{error:{code:'insufficient_quota',message:'PRIVATE_KEY'}}:mode==='refusal'?{error:{code:'content_policy_violation'}}:mode==='pending'?{data:{task_id:'private',status:'processing'}}:{data:[]}));
  await assert.rejects(generatedImage(config,'test'),/最多 3 次.*停止重试/);assert.equal(calls.length,3);
  for(const next of ['quota','refusal','pending']){mode=next;const start=calls.length;await assert.rejects(generatedImage(config,'test'),e=>!e.retryable&&!e.message.includes('PRIVATE_'));assert.equal(calls.length,start+1);}
  mode='empty';const controller=new AbortController();observeTask(controller.signal,e=>{if(e.kind==='retry')controller.abort();});const start=calls.length;
  await assert.rejects(generatedImage(config,'test',controller.signal));assert.equal(calls.length,start+1);
});

test('同步二进制、SSE 完整事件均可读取，部分帧不会提前交付',async t=>{
  let stream=false;const {config}=await mock(t,(req,res)=>{
    if(!stream){res.setHeader('content-type','image/png');res.end(png);return;}
    res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({type:'image_generation.partial_image',b64_json:b64})+'\n\ndata: '+JSON.stringify({type:'image_generation.completed',b64_json:b64})+'\n\ndata: [DONE]\n\n');
  });
  assert.deepEqual(await generatedImage(config,'test'),png);stream=true;assert.deepEqual(await generatedImage(config,'test'),png);
});

test('结果 URL 下载异常只重试下载，不重复生成，也不外传 API 密钥',async t=>{
  let base,downloads=0;const fixture=await mock(t,(req,res)=>{
    if(req.method==='POST'){json(res,{data:[{url:base+'/image.png?signature=PRIVATE_SIGN'}]});return;}
    assert.equal(req.headers.authorization,undefined);downloads++;
    if(downloads===1){res.statusCode=503;res.end('gateway');return;}res.setHeader('content-type','image/png');res.end(png);
  });base=fixture.base;
  assert.deepEqual(await generatedImage(fixture.config,'test'),png);assert.equal(fixture.calls.filter(c=>c.method==='POST').length,1);assert.equal(downloads,2);
});

test('较大的合法 base64 返回不会撞上文字响应的15 MB限制',async t=>{
  const bytes=Buffer.concat([png,Buffer.alloc(11_500_000)]);
  const {config}=await mock(t,(req,res)=>json(res,{data:[{b64_json:bytes.toString('base64')}]}));
  assert.deepEqual(await generatedImage(config,'test'),bytes);
});
