import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {themeAssetForPage,themeAssetsStamp,requireThemeAssetForPage} from '../lib/theme-assets.mjs';
import {fixtureRequest,fixtureReply} from './visual-fixture.mjs';

test('旧底图检查未通过也不会阻止用户点击继续，仍要求实际底图存在',()=>{
  const p={brief:{title:'测试',pages:1,cover:true},materials:[],slides:[{kind:'cover',title:'测试'}]},asset={normalized:'cover.png',previewHash:'hash',previewReview:{status:'needs_revision',issues:['旧检查意见']}};
  p.themeAssets={stamp:themeAssetsStamp(p),directions:[{id:'a',assets:{'hero-image':asset}}]};
  assert.equal(themeAssetForPage(p,0,'a'),asset);assert.equal(requireThemeAssetForPage(p,0,'a'),asset);
  delete p.themeAssets.directions[0].assets['hero-image'];assert.throws(()=>requireThemeAssetForPage(p,0,'a'),/需要对应的封面底图/);
});

test('真实接口：底图结束只展示，无自动检查修正；用户点击后才生成三版预览',async t=>{
  const requests=[],submitted=[];
  const mock=http.createServer(async(req,res)=>{const body=await fixtureRequest(req);requests.push({...body,endpoint:req.url});res.setHeader('content-type','application/json');res.end(JSON.stringify(fixtureReply(body)));});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=path.resolve('work','theme-continuation-'+Date.now()),base='http://127.0.0.1:'+port;
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:data},stdio:'ignore',windowsHide:true});t.after(()=>app.kill());
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const res=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),result=await res.json();assert.equal(res.status,status,JSON.stringify(result));return result;};
  let p=await call('/api/projects',{brief:{title:'材料核心对象',pages:1,cover:true}},201);const prefix='/api/projects/'+p.id;
  const act=(action,extra={})=>{submitted.push(action);return call(prefix+'/action',{action,...extra});};
  const wait=async()=>{for(let i=0;i<1000;i++){p=await call(prefix);if(p.task?.status!=='running'&&!p.imageTaskQueue?.some(j=>['queued','running'].includes(j.status))){assert.equal(p.task?.status,'done',p.task?.message);return p;}await new Promise(r=>setTimeout(r,30));}throw Error('任务超时');};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic-continuation',model:'mock'};
  await act('configure',{text:cfg,image:cfg});await act('requirements',{brief:p.brief});await act('saveContent',{slides:[{kind:'cover',title:'材料核心对象',body:[],sources:[]}],confirm:true});
  await act('designPage',{index:0});await wait();await act('approvePageDesign',{index:0});
  await act('generateThemeAssets');await wait();assert.equal(requests.filter(r=>r.prompt).length,0);
  await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts});await wait();
  assert.equal(p.themeAutoContinue,false);assert.equal(p.themeBackgroundReview,false);assert.equal(p.concepts.length,0);assert.equal(requests.filter(r=>r.prompt).length,3);
  assert.equal(requests.some(r=>r.messages?.at(-1)?.content?.[0]?.text?.startsWith('检查三方向底图：')),false);
  await act('concepts');await wait();assert.equal(p.concepts.length,3);assert.ok(p.concepts.every(c=>c.representatives.length===1));
  const images=requests.filter(r=>r.prompt);assert.equal(images.length,6);assert.equal(images.filter(r=>r.endpoint.endsWith('/images/edits')).length,3);
  const saved=JSON.parse(fs.readFileSync(path.join(data,p.id,'project.json'),'utf8'));
  assert.equal(saved.imageTaskQueue.filter(j=>j.automaticFrom==='theme-assets').length,0);
});
