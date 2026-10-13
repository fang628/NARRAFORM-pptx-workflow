import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

test('项目归档、恢复、删除确认、目录隔离、会话密钥保留、忙碌保护与重启持久化',async t=>{
  const dir=path.resolve('work','archive-test-'+Date.now()),base='http://127.0.0.1:4381';let app;
  const mock=http.createServer((req,res)=>{req.resume();req.on('end',()=>setTimeout(()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'连接成功'}}]}));},250));});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{app?.kill();mock.close();});
  async function start(){app=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:'4381',PPT_AGENT_TEST:'1',PPT_AGENT_DATA:dir},stdio:'ignore',windowsHide:true});for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,30));}throw Error('服务未启动');}
  const call=async(url,b,status=200)=>{const response=await fetch(base+url,b===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}),json=await response.json();assert.equal(response.status,status,JSON.stringify(json));return json;};
  await start();let p=await call('/api/projects',{brief:{title:'归档回归项目',pages:3},demo:true},201);const route='/api/projects/'+p.id;
  p=await call(route+'/materials',{name:'source.txt',base64:Buffer.from('需要完整保留的原始材料').toString('base64')});
  const before={version:p.version,slides:p.slides,materials:p.materials,approvals:p.approvals,stage:p.stage};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic-archive-key',model:'synthetic'};
  await call(route+'/action',{action:'configure',text:cfg});await call(route+'/action',{action:'testAPI',type:'text'});
  await call(route+'/archive',{archived:true},400);
  const busyDeletion=await call(route+'/delete',{confirmTitle:p.brief.title},400);assert.match(busyDeletion.error,/任务或材料发送中/);
  for(let i=0;i<100;i++){p=await call(route);if(p.task.status!=='running')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(p.task.status,'done');await call(route+'/archive',{archived:'true'},400);
  p=await call(route+'/archive',{archived:true});assert.ok(p.archivedAt);assert.equal(p.apiReady,true,'归档不清除会话密钥');
  assert.ok(!(await call('/api/projects')).some(x=>x.id===p.id));assert.equal((await call('/api/projects?archived=true')).filter(x=>x.id===p.id).length,1);assert.equal((await call('/api/projects?archived=all')).filter(x=>x.id===p.id).length,1);
  for(const [key,value] of Object.entries(before))assert.deepEqual(p[key],value,key);
  const archivedAt=p.archivedAt,eventCount=p.events.length;p=await call(route+'/archive',{archived:true});assert.equal(p.archivedAt,archivedAt);assert.equal(p.events.length,eventCount,'重复归档不重复记事件');
  await call(route+'/action',{action:'requirements',brief:{...p.brief,title:'不允许偷偷编辑归档'}},400);await call(route+'/materials',{name:'new.txt',base64:'YQ=='},400);
  assert.ok(!fs.readFileSync(path.join(dir,p.id,'project.json'),'utf8').includes(cfg.key));
  const material=p.materials[0];assert.equal(fs.readFileSync(path.join(dir,p.id,'assets',material.file),'utf8'),'需要完整保留的原始材料','材料文件仍完整保留');
  await new Promise(r=>{app.once('exit',r);app.kill();});await start();p=await call(route);assert.equal(p.archivedAt,archivedAt);assert.ok(!(await call('/api/projects')).some(x=>x.id===p.id));
  p=await call(route+'/archive',{archived:false});assert.equal(p.archivedAt,null);assert.ok((await call('/api/projects')).some(x=>x.id===p.id));assert.equal((await call('/api/projects?archived=true')).length,0);
  for(const [key,value] of Object.entries(before))assert.deepEqual(p[key],value,key);
  await call(route+'/action',{action:'requirements',brief:p.brief});
  const survivor=await call('/api/projects',{brief:{title:'不应被删除的项目',pages:3}},201);
  const survivorFile=path.join(dir,survivor.id,'keep.txt');fs.writeFileSync(survivorFile,'其他项目的文件');
  assert.match((await call(route+'/delete',{confirmTitle:p.brief.title},400)).error,/仅可删除已归档/);
  await call(route+'/archive',{archived:true});
  assert.match((await call(route+'/delete',{},400)).error,/删除确认/);
  assert.match((await call(route+'/delete',{confirmTitle:'错误的项目名'},400)).error,/删除确认/);
  assert.ok(fs.existsSync(path.join(dir,p.id,'project.json')),'错误确认不能删除文件');
  const crossSite=await fetch(base+route+'/delete',{method:'POST',headers:{'content-type':'application/json',origin:'https://example.com'},body:JSON.stringify({confirmTitle:p.brief.title})});assert.equal(crossSite.status,403);
  // Junctions must not allow deletion outside the selected project directory.
  const projectDir=path.join(dir,p.id),backupDir=path.join(dir,p.id+'-backup');
  fs.renameSync(projectDir,backupDir);
  try{
    fs.symlinkSync(path.join(dir,survivor.id),projectDir,process.platform==='win32'?'junction':'dir');
    assert.match((await call(route+'/delete',{confirmTitle:p.brief.title},400)).error,/项目目录/);
    assert.equal(fs.readFileSync(survivorFile,'utf8'),'其他项目的文件');
  }finally{if(fs.existsSync(projectDir))fs.unlinkSync(projectDir);fs.renameSync(backupDir,projectDir);}
  assert.deepEqual(await call(route+'/delete',{confirmTitle:p.brief.title}),{deleted:true,id:p.id});
  assert.equal(fs.existsSync(projectDir),false,'项目材料和记录目录已移除');
  assert.equal(fs.readFileSync(survivorFile,'utf8'),'其他项目的文件');
  assert.ok(!(await call('/api/projects?archived=all')).some(x=>x.id===p.id));
  assert.match((await call(route,undefined,400)).error,/项目不存在/);
  await new Promise(r=>{app.once('exit',r);app.kill();});await start();
  assert.ok(!(await call('/api/projects?archived=all')).some(x=>x.id===p.id),'重启不会恢复已删除项目');
  assert.equal((await call('/api/projects/'+survivor.id)).brief.title,survivor.brief.title);
});
