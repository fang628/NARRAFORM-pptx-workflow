import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {artifactInventory,cleanArtifactCache,publicArtifactReport} from '../lib/artifact-storage.mjs';
import {artifactStorageView} from '../public/artifact-storage.js';
import http from 'node:http';
import {spawn} from 'node:child_process';

function fixture(t){
  const data=fs.mkdtempSync(path.resolve('work/artifact-storage-')),id='a1234567-1234-1234-1234-123456789012',root=path.join(data,id);fs.mkdirSync(root);
  const write=(file,value='test')=>{const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);};
  const p={id,materials:[{id:'original',file:'original.pdf'},{id:'supplement',file:'supplement.png',generated:true,purpose:'supplement'},{id:'current-icon',file:'current.svg',reconstructed:true},{id:'old-icon',file:'old.svg',reconstructed:true},{id:'orphan-icon',file:'orphan.svg',reconstructed:true},{id:'old-bg',file:'old-bg.png',purpose:'workflow-background',generated:true}],reconstruction:{slides:[{elements:[{id:'current-icon'}]}]},visualPages:[{file:'visual/current.png',ledger:'visual/current-job.json'}],candidate:{dir:'exports/now',file:'deck.pptx',proofs:[{file:'S01.png'}]},rebuildEditHistory:[{state:{reconstruction:{slides:[{elements:[{id:'old-icon'}]}]},candidate:{dir:'exports/old',file:'deck.pptx'}}}],task:{status:'done'}};
  for(const m of p.materials)write('assets/'+m.file);
  for(const f of ['visual/current.png','visual/current-provider.png','visual/orphan.png','exports/now/deck.pptx','exports/now/S01.png','exports/old/deck.pptx','exports/abandoned/deck.pptx','notes/keep.txt','project.json','.api-credentials.dpapi'])write(f);
  write('visual/current-job.json',JSON.stringify({source:'visual/current-provider.png'}));
  return {p,data,root,write};
}
test('工件图区分当前、撤回与缓存，JSON账本引用可传递，原材料与补充图片受保护',t=>{
  const {p,data}=fixture(t),r=artifactInventory(p,data),files=new Map(r.files.map(f=>[f.file,f]));
  for(const f of ['assets/original.pdf','assets/supplement.png','assets/current.svg','visual/current-provider.png','exports/now/deck.pptx'])assert.equal(files.get(f).category,'current',f);
  for(const f of ['assets/old.svg','exports/old/deck.pptx'])assert.equal(files.get(f).category,'history',f);
  for(const f of ['assets/orphan.svg','assets/old-bg.png','visual/orphan.png','exports/abandoned/deck.pptx'])assert.equal(files.get(f).category,'cache',f);
  assert.equal(files.get('notes/keep.txt').category,'protected');assert.equal(files.get('.api-credentials.dpapi').category,'protected');
  assert(r.edges.some(e=>e.from==='material:current-icon'&&e.to==='assets/current.svg'));assert.equal(artifactInventory(p,data).token,r.token);
  const publicReport=publicArtifactReport(r);assert(!publicReport.files&&!publicReport.edges);assert.match(artifactStorageView(publicReport),/撤回历史/);
});
test('清理仅删除无引用工件，保留共享引用、撤回与用户文件，可重复执行',t=>{
  const {p,data,root}=fixture(t),before=artifactInventory(p,data),result=cleanArtifactCache(p,data,before.token);
  assert.equal(result.deleted.files,4);assert(!fs.existsSync(path.join(root,'assets/orphan.svg')));assert(!p.materials.some(m=>m.id==='orphan-icon'||m.id==='old-bg'));
  for(const f of ['assets/old.svg','assets/original.pdf','assets/supplement.png','exports/now/deck.pptx','exports/old/deck.pptx','notes/keep.txt','.api-credentials.dpapi'])assert(fs.existsSync(path.join(root,f)),f);
  assert.equal(cleanArtifactCache(p,data,result.report.token).deleted.files,0);
});
test('引用变化、文件变化或执行任务时拒绝旧清理计划',t=>{
  const {p,data,root,write}=fixture(t);let r=artifactInventory(p,data);p.reconstruction.slides[0].elements.push({id:'orphan-icon'});assert.throws(()=>cleanArtifactCache(p,data,r.token),/已变化/);assert(fs.existsSync(path.join(root,'assets/orphan.svg')));
  r=artifactInventory(p,data);write('visual/new.png');assert.throws(()=>cleanArtifactCache(p,data,r.token),/已变化/);
  p.task.status='running';assert.throws(()=>cleanArtifactCache(p,data,r.token),/任务/);p.task.status='done';p.imageTaskQueue=[{status:'queued'}];assert.throws(()=>cleanArtifactCache(p,data,r.token),/任务/);
});
test('共享素材当前引用优先于历史，历史中的独立素材登记也可追溯',t=>{
  const {p,data,write}=fixture(t);p.rebuildEditHistory.push({state:{materials:[{id:'history-only',file:'history-only.svg',reconstructed:true}],reconstruction:{slides:[{elements:[{id:'history-only'},{id:'current-icon'}]}]}}});write('assets/history-only.svg');
  const files=new Map(artifactInventory(p,data).files.map(f=>[f.file,f]));assert.equal(files.get('assets/current.svg').category,'current');assert.equal(files.get('assets/history-only.svg').category,'history');
});
test('图片撤回、重做和父图关系均保留历史，当前底图保持当前分类',t=>{
  const {p,data,write}=fixture(t);p.materials.push({id:'bg-now',file:'bg-now.png',generated:true,purpose:'workflow-background',parentImageId:'old-bg'});write('assets/bg-now.png');write('visual/past.png');write('visual/future.png');
  p.themeAssets={directions:[{assets:{hero:{materialId:'bg-now',editHistory:{past:[{file:'visual/past.png'}],future:[{file:'visual/future.png'}]}}}}]};
  const files=new Map(artifactInventory(p,data).files.map(f=>[f.file,f]));assert.equal(files.get('assets/bg-now.png').category,'current');assert.equal(files.get('assets/old-bg.png').category,'history');assert.equal(files.get('visual/past.png').category,'history');assert.equal(files.get('visual/future.png').category,'history');
});
test('路径越界与目录链接不会被清理',t=>{
  const {p,data,root,write}=fixture(t);assert.throws(()=>artifactInventory({...p,id:'../escape'},data),/编号/);
  const outside=path.join(data,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep.txt'),'keep');
  fs.symlinkSync(outside,path.join(root,'visual-linked'),process.platform==='win32'?'junction':'dir');
  const r=artifactInventory(p,data);assert(r.blockedLinks.includes('visual-linked'));cleanArtifactCache(p,data,r.token);assert(fs.existsSync(path.join(outside,'keep.txt')));
});

test('网页存储统计与清理接口使用预览令牌，入口与模块可加载，不需要模型配置', {timeout:20000},async t=>{
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=fs.mkdtempSync(path.resolve('work/artifact-storage-api-')),base='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:data},windowsHide:true,stdio:'ignore'});t.after(()=>child.kill());
  for(let n=0;n<150;n++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const response=await fetch(base+'/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({brief:{title:'工件管理测试',pages:1}})});assert.equal(response.status,201);const p=await response.json();assert(p.artifactStorageEnabled);
  const root=path.join(data,p.id);fs.mkdirSync(path.join(root,'visual'),{recursive:true});fs.writeFileSync(path.join(root,'visual','orphan.png'),'unused');
  let r=await (await fetch(base+'/api/projects/'+p.id+'/storage')).json();assert.equal(r.summary.cache.files,1);assert.equal(r.samples[0].file,'visual/orphan.png');
  const act=body=>fetch(base+'/api/projects/'+p.id+'/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await act({action:'cleanArtifactCache',token:'stale'})).status,400);assert(fs.existsSync(path.join(root,'visual/orphan.png')));
  const cleaned=await act({action:'cleanArtifactCache',token:r.token});assert.equal(cleaned.status,200);const result=await cleaned.json();assert.equal(result.artifactCleanup.deleted.files,1);assert(!fs.existsSync(path.join(root,'visual/orphan.png')));
  const html=await (await fetch(base+'/')).text();assert.match(html,/data-storage-open/);assert.equal((await fetch(base+'/artifact-storage.js')).status,200);
  const motion=await act({action:'setDeliveryMotion',settings:{enabled:false}});assert.equal(motion.status,200);assert.equal((await motion.json()).deliveryMotion.enabled,false);
});
