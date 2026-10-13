import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {credentialStore} from '../lib/credential-store.mjs';
import {apiPersistenceMessage} from '../public/api-config.js';

test('Windows 用户加密：密钥不以明文落盘，按项目绑定，坏配置不覆盖原副本', {skip:process.platform!=='win32'},async()=>{
  const data=path.resolve('work','credential-vault-'+Date.now()),id=crypto.randomUUID(),other=crypto.randomUUID(),vault=credentialStore(data);
  const c={text:{baseURL:'https://example.com/v1',model:'mock',key:'synthetic-"秘钥\n$()'},image:{baseURL:'https://image.example.com/v1',model:'image',key:'synthetic-image-key'}};
  assert.equal(vault.mode,'windows-dpapi');assert.equal(await vault.load(id),null);
  await vault.save(id,c);const file=path.join(data,id,'.api-credentials.dpapi'),encrypted=fs.readFileSync(file,'utf8');
  for(const key of [c.text.key,c.image.key,'example.com'])assert.ok(!encrypted.includes(key));
  assert.deepEqual(await vault.load(id),c);
  await assert.rejects(vault.save(id,{text:{...c.text,key:'x'.repeat(2001)}}),/配置无效/);assert.equal(fs.readFileSync(file,'utf8'),encrypted);
  fs.mkdirSync(path.join(data,other),{recursive:true});fs.copyFileSync(file,path.join(data,other,'.api-credentials.dpapi'));
  await assert.rejects(vault.load(other),/无法解密/);
  await assert.rejects(vault.load('../escape'),/项目编号无效/);
  fs.writeFileSync(file,'invalid');await assert.rejects(vault.load(id),/无法解密/);
  vault.clear(id);assert.equal(await vault.load(id),null);vault.clear(id);
});

test('提示准确区分本机加密、旧服务内存模式及解密错误',()=>{
  assert.match(apiPersistenceMessage({apiPersistence:'windows-dpapi'}),/重启服务自动恢复/);
  assert.match(apiPersistenceMessage({}),/重启后需要重新填写/);
  assert.equal(apiPersistenceMessage({apiPersistence:'windows-dpapi',apiPersistenceWarning:'需要重填'}),'需要重填');
});

test('真实 HTTP 与重启：四通道恢复、真实授权头、清除持久化、项目隔离及损坏恢复', {skip:process.platform!=='win32'},async t=>{
  const data=path.resolve('work','credential-restart-'+Date.now());let app,output='',lastAuthorization;
  const mock=http.createServer((req,res)=>{lastAuthorization=req.headers.authorization;req.resume();req.on('end',()=>res.end(JSON.stringify({choices:[{message:{content:'连接成功'}}]})));});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const base='http://127.0.0.1:'+port;
  const stop=async()=>{if(!app||app.exitCode!==null)return;await new Promise(r=>{app.once('exit',r);app.kill();});};
  t.after(async()=>{await stop();mock.closeAllConnections();mock.close();});
  const start=async()=>{
    app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:data},windowsHide:true,stdio:['ignore','pipe','pipe']});
    app.stdout.on('data',c=>output+=c);app.stderr.on('data',c=>output+=c);
    for(let i=0;i<250;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,30));}throw Error('服务未启动');
  };
  const call=async(url,body,status=200)=>{
    const r=await fetch(base+url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;
  };
  await start();let p=await call('/api/projects',{brief:{title:'密钥持久化',pages:3}},201),other=await call('/api/projects',{brief:{title:'独立配置',pages:3}},201);
  const route='/api/projects/'+p.id,second='/api/projects/'+other.id;
  const config=Object.fromEntries(['text','image','elementImage','rebuild'].map(type=>[type,{baseURL:`http://127.0.0.1:${mock.address().port}/v1`,model:type,key:'synthetic-secret-'+type}]));
  p=await call(route+'/action',{action:'configure',...config});await call(second+'/action',{action:'configure',text:config.text});
  assert.equal(p.apiPersistence,'windows-dpapi');assert.ok(p.apiReady&&p.imageReady&&p.elementImageReady&&p.rebuildConfigured);
  const file=path.join(data,p.id,'.api-credentials.dpapi');assert.ok(fs.existsSync(file));
  for(const c of Object.values(config)){
    assert.ok(!JSON.stringify(p).includes(c.key));assert.ok(!fs.readFileSync(file,'utf8').includes(c.key));assert.ok(!fs.readFileSync(path.join(data,p.id,'project.json'),'utf8').includes(c.key));
  }
  await call(route+'/.api-credentials.dpapi',undefined,404);
  await stop();await start();p=await call(route);assert.ok(p.apiReady&&p.imageReady&&p.elementImageReady&&p.rebuildConfigured);assert.equal(p.provider.rebuild.model,'rebuild');assert.equal(p.apiPersistenceWarning,null);
  await call(route+'/action',{action:'testAPI',type:'text'});
  for(let i=0;i<100;i++){p=await call(route);if(p.task?.status!=='running')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(p.task.status,'done',p.task.message);assert.equal(lastAuthorization,'Bearer '+config.text.key);
  const replacement={...config.image,key:'synthetic-replacement-image-key'};
  p=await call(route+'/action',{action:'configure',text:{...config.text,key:''},image:replacement,elementImage:null});assert.equal(p.rebuildConfigured,true);
  await stop();await start();p=await call(route);assert.equal(p.provider.elementImage,null);assert.equal(p.elementImageReady,true,'独立通道删除后仍沿用通用生图');
  assert.equal((await credentialStore(data).load(p.id)).image.key,replacement.key);
  await call(route+'/action',{action:'forgetKey'});assert.equal(fs.existsSync(file),false);
  await stop();await start();p=await call(route);assert.equal(p.apiReady,false);assert.equal(p.imageReady,false);assert.equal(p.rebuildConfigured,false);assert.equal((await call(second)).apiReady,true);
  const secondFile=path.join(data,other.id,'.api-credentials.dpapi');fs.writeFileSync(secondFile,'broken encrypted config');
  await stop();await start();other=await call(second);assert.equal(other.apiReady,false);assert.match(other.apiPersistenceWarning,/无法解密/);
  other=await call(second+'/action',{action:'configure',text:config.text});assert.equal(other.apiPersistenceWarning,null);assert.equal(other.apiReady,true);
  await call(second+'/archive',{archived:true});await stop();await start();assert.equal((await call(second)).apiReady,true,'归档后仍恢复配置');
  await call(second+'/delete',{confirmTitle:other.brief.title});assert.equal(fs.existsSync(secondFile),false);
  for(const c of Object.values(config))assert.ok(!output.includes(c.key),'服务日志不暴露密钥');
});
