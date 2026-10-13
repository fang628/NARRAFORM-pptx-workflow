import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {editedOutline,materialStamp} from '../lib/materials.mjs';

test('主题编辑保留材料来源，拒绝空白、超长或数量不匹配的输入',()=>{
  const original=[{title:'原主题',sourceIds:['doc-1']}];
  assert.deepEqual(editedOutline(original,[' 新主题 ']),[{title:'新主题',sourceIds:['doc-1']}]);
  assert.equal(original[0].title,'原主题');
  assert.equal(editedOutline(original,undefined),original);
  for(const titles of [[],[''],['  '],[42],['x'.repeat(151)]])assert.throws(()=>editedOutline(original,titles),/主题/);
});

test('确认主题编辑持久保存、保留来源并使旧内容确认失效',async t=>{
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const dir=path.resolve('work','outline-edit-test-'+Date.now());const id='12345678-1234-1234-1234-123456789abc';
  const p={id,brief:{title:'主题编辑验证',pages:3},materials:[{id:'doc-1',name:'材料.txt',text:'原文证据',sha256:'test'}],slides:[],concepts:[{id:'old'}],selectedTheme:'old',version:1,stage:5,approvals:{requirements:'yes',content:'yes',preview:'yes'},events:[],output:{file:'old.pptx'}};
  p.analysis={stamp:materialStamp(p),summary:'综合理解',readings:[],outline:[{title:'原主题',sourceIds:['doc-1']}],questions:[],approvedAt:'confirmed',reviewNotes:''};
  fs.mkdirSync(path.join(dir,id),{recursive:true});const file=path.join(dir,id,'project.json');fs.writeFileSync(file,JSON.stringify(p));
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:dir},stdio:'ignore',windowsHide:true});t.after(()=>app.kill());
  const url=`http://127.0.0.1:${port}/api/projects/${id}`;
  for(let i=0;i<100;i++){try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const approve=outlineTitles=>fetch(url+'/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'approveAnalysis',reviewNotes:'',outlineTitles})});
  const invalid=await approve([' ']);assert.equal(invalid.status,400);assert.equal(JSON.parse(fs.readFileSync(file)).analysis.outline[0].title,'原主题');
  const response=await approve(['用户修改后的主题']);assert.equal(response.status,200);const saved=await response.json();
  assert.equal(saved.analysis.outline[0].title,'用户修改后的主题');assert.deepEqual(saved.analysis.outline[0].sourceIds,['doc-1']);assert.equal(saved.analysisCurrent,true);assert.ok(saved.analysis.approvedAt);
  assert.equal(saved.version,2);assert.equal(saved.approvals.content,null);assert.equal(saved.approvals.preview,null);assert.equal(saved.output,null);
  assert.equal((await(await fetch(url)).json()).analysis.outline[0].title,'用户修改后的主题');
  assert.equal(JSON.parse(fs.readFileSync(file)).analysis.outline[0].title,'用户修改后的主题');
  await approve(undefined);assert.equal((await(await fetch(url)).json()).version,2);
});
