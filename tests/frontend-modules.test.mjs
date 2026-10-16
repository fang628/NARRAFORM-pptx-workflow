import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';

test('浏览器启动模块及全部静态依赖均可加载为 JavaScript',async t=>{
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));
  const port=socket.address().port;await new Promise(r=>socket.close(r));
  const base='http://127.0.0.1:'+port;
  const app=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:path.resolve('work','frontend-modules-'+Date.now())},windowsHide:true,stdio:'ignore'});
  t.after(()=>app.kill());
  let started=false;
  for(let i=0;i<150;i++){
    try{if((await fetch(base+'/api/health')).ok){started=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,30));
  }
  assert.ok(started,'测试服务应启动');
  const pending=[base+'/app.js'],seen=new Set();
  while(pending.length){
    const url=pending.shift();if(seen.has(url))continue;seen.add(url);
    const response=await fetch(url);assert.equal(response.status,200,url);
    assert.match(response.headers.get('content-type'),/javascript/,url);
    const source=await response.text();
    for(const match of source.matchAll(/\b(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?['"]([^'"]+)['"]/g)){
      assert.match(match[1],/^\.?\.?\//,'浏览器模块不可依赖裸包名');
      pending.push(new URL(match[1],url).href);
    }
  }
  assert.ok(seen.has(base+'/elements-model.js'));
  assert.ok(seen.has(base+'/image-caption-rules.mjs'));
});
