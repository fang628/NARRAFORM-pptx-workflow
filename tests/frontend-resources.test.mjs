import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';

test('浏览器全部模块及其传递依赖可加载，新增public模块无需维护路由清单',async t=>{
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=fs.mkdtempSync(path.resolve('work','frontend-resources-')),base='http://127.0.0.1:'+port;
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:data},windowsHide:true,stdio:'ignore'});t.after(()=>app.kill());
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const visited=new Set(),queue=fs.readdirSync('public').filter(name=>name.endsWith('.js')).map(name=>'/'+name);
  while(queue.length){
    const url=queue.shift();if(visited.has(url))continue;visited.add(url);
    const response=await fetch(base+url);assert.equal(response.status,200,url);assert.match(response.headers.get('content-type'),/javascript/,url);assert.equal(response.headers.get('cache-control'),'no-store');
    const source=await response.text();assert.doesNotMatch(source,/^\s*(?:<!doctype|<html)/i,url);
    for(const match of source.matchAll(/\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?['"]([^'"]+)['"]/g)){
      if(match[1].startsWith('.')||match[1].startsWith('/'))queue.push(new URL(match[1],base+url).pathname);
    }
  }
  assert.ok(visited.has('/image-edit-region.js'));assert.ok(visited.has('/image-region-model.js'));assert.ok(visited.has('/elements-model.js'));
  for(const url of ['/server.mjs','/package.json','/data/project.json','/lib/provider.mjs','/does-not-exist.js'])assert.equal((await fetch(base+url)).status,404,url);
  const html=await (await fetch(base+'/')).text();assert.match(html,/id="main"/);assert.match(html,/页面加载失败/);
});
