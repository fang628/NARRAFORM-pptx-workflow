import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {cropSelection,adjustCrop,extractionButtons,imageOrigin} from '../public/material-images.js';

test('手动框选、移动和八方向缩放保持原图范围，裁片和原图都有独立入口',()=>{
  assert.deepEqual(cropSelection({x:1100,y:800},{x:-10,y:100}),{x:0,y:100,w:1000,h:700});
  const box={x:200,y:100,w:300,h:400};assert.deepEqual(adjustCrop(box,900,-400),{x:700,y:0,w:300,h:400});
  for(const handle of ['nw','n','ne','e','se','s','sw','w'])for(const delta of [-2000,2000]){const r=adjustCrop(box,delta,delta,handle);assert.ok(r.x>=0&&r.y>=0&&r.w>=1&&r.h>=1&&r.x+r.w<=1000&&r.y+r.h<=1000);}
  assert.match(extractionButtons({id:'m',kind:'image',extracted:true}),/data-crop-material="m"/);assert.equal(extractionButtons({kind:'image',generated:true}),'');assert.match(imageOrigin({extractionMethod:'manual-crop',sourceMaterialName:'原图'}),/原图.*手动裁片/);
});

test('HTTP 手动裁切只新增原像素裁片并重新理解；失败、缺少模型和重试都保留原图与裁片',async t=>{
  const python=path.resolve('.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),work=path.resolve('work','manual-crop-'+Date.now());
  execFileSync(python,['tests/material-image-fixture.py',work],{windowsHide:true});const originalBytes=fs.readFileSync(path.join(work,'source.png'));
  const requests=[];let failReading=false;
  const mock=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw),user=b.messages.at(-1).content,prompt=typeof user==='string'?user:user[0].text;requests.push(user);
    if(failReading&&Array.isArray(user)){res.writeHead(500);res.end('synthetic failure');return;}
    const answer=prompt.includes('汇总材料理解')?{summary:'已按原图和裁片整理',outline:[{title:'各区域',sourceIds:JSON.parse(prompt.split('材料理解：')[1]).map(r=>r.id)}],questions:[]}:{category:'图片',summary:'已理解这张独立图片',keyPoints:['区域内容'],facts:[],suggestedUse:'单独用于PPT',questions:[]};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(answer)}}]}));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const reserved=http.createServer();await new Promise(r=>reserved.listen(0,'127.0.0.1',r));const port=reserved.address().port;await new Promise(r=>reserved.close(r));
  const data=path.join(work,'data'),base='http://127.0.0.1:'+port,app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:data},windowsHide:true,stdio:'ignore'});t.after(()=>app.kill());
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;};
  let p=await call('/api/projects',{brief:{title:'组合图分离',pages:1}},201),prefix='/api/projects/'+p.id;
  const act=(action,extra={},status=200)=>call(prefix+'/action',{action,...extra},status),wait=async()=>{for(let i=0;i<1000;i++){p=await call(prefix);if(p.task?.status!=='running')return p;await new Promise(r=>setTimeout(r,20));}throw Error('timeout');};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic-local',model:'mock-vision'};await act('configure',{text:cfg});
  p=await call(prefix+'/materials',{name:'组合图.png',base64:originalBytes.toString('base64')});const original=p.materials[0];
  const regions=[{label:'左图',box:{x:0,y:0,w:500,h:1000}},{label:'右图',box:{x:500,y:0,w:500,h:1000}}];
  await act('analyzeMaterials',{includeImages:true});await wait();assert.equal(p.task.status,'done',p.task.message);await act('approveAnalysis',{reviewNotes:'保留原始像素'});
  const beforeReads=requests.filter(Array.isArray).length;
  await act('cropMaterialImages',{id:original.id,sourceHash:original.sha256,regions});await wait();assert.equal(p.task.status,'done',p.task.message);
  assert.equal(p.materials.length,3);assert.equal(p.analysisCurrent,true);assert.equal(p.analysis.approvedAt,null);assert.equal(p.analysis.reviewNotes,'保留原始像素');assert.deepEqual(p.pendingImageUnderstanding,[]);
  assert.equal(requests.filter(Array.isArray).length-beforeReads,2,'仅重新理解两个新增裁片，复用未变化原图');
  const crops=p.materials.filter(m=>m.extractionMethod==='manual-crop');for(const crop of crops){assert.notEqual(crop.file,original.file);assert.equal(crop.sourceMaterialId,original.id);assert.equal(crop.width,100);assert.equal(crop.height,100);assert.equal(p.analysis.readings.find(r=>r.id===crop.id).coverage,'image');}
  assert.deepEqual(fs.readFileSync(path.join(data,p.id,'assets',original.file)),originalBytes,'原图字节完全不变');assert.equal(p.materials[0].sha256,original.sha256);
  execFileSync(python,['-c','from PIL import Image;import sys;left=Image.open(sys.argv[1]);right=Image.open(sys.argv[2]);assert left.getpixel((50,50))==(255,242,56,255);assert right.getpixel((50,50))==(53,53,53,255)',...crops.map(m=>path.join(data,p.id,'assets',m.file))],{windowsHide:true});
  const count=requests.length;await act('cropMaterialImages',{id:original.id,sourceHash:original.sha256,regions});await wait();assert.equal(p.materials.length,3);assert.equal(requests.length,count,'重复裁片不重复调用模型');
  await act('cropMaterialImages',{id:original.id,sourceHash:'stale',regions},400);await act('cropMaterialImages',{id:original.id,sourceHash:original.sha256,regions:[{label:'越界',box:{x:990,y:0,w:20,h:100}}]},400);
  failReading=true;await act('cropMaterialImages',{id:crops[0].id,sourceHash:crops[0].sha256,regions:[{label:'继续拆分',box:{x:0,y:0,w:500,h:1000}}]});await wait();assert.equal(p.task.status,'failed');assert.match(p.task.message,/裁片已保存/);assert.equal(p.materials.length,4);assert.equal(p.pendingImageUnderstanding.length,1);assert.equal(p.analysisCurrent,false);
  failReading=false;await act('analyzeMaterials',{includeImages:false});await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.analysisCurrent,true);assert.equal(p.analysis.readings.find(r=>r.id===p.materials.at(-1).id).coverage,'image','待理解裁片不能通过关闭图片识别跳过');
  await act('removeMaterial',{id:original.id});p=await call(prefix);assert.equal(p.materials.length,0,'移除原图时清理所有层级裁片引用');
  p=await call('/api/projects',{brief:{title:'离线裁切',pages:1}},201);prefix='/api/projects/'+p.id;p=await call(prefix+'/materials',{name:'离线原图.png',base64:originalBytes.toString('base64')});const offline=p.materials[0];
  await act('cropMaterialImages',{id:offline.id,sourceHash:offline.sha256,regions});await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.materials.length,3);assert.equal(p.pendingImageUnderstanding.length,2);assert.equal(p.analysisCurrent,false);assert.match(p.task.message,/配置主模型/);assert.deepEqual(fs.readFileSync(path.join(data,p.id,'assets',offline.file)),originalBytes);
});
