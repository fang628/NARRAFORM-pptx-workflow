import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fixtureRequest,fixtureReply} from './visual-fixture.mjs';
import {captureReusableResults,downstreamReuseState,reuseDownstream} from '../lib/downstream-reuse.mjs';
import {themeAssetsStamp} from '../lib/theme-assets.mjs';

test('前置修改可跳过设计与整页重生，新文案进入原生元素，交付验收仍失效',async t=>{
  let imageCalls=0,auditCalls=0;
  const mock=http.createServer(async(req,res)=>{const b=await fixtureRequest(req);if(b.prompt)imageCalls++;if(b.messages?.at(-1)?.content?.[0]?.text?.startsWith('自由元素审计：'))auditCalls++;res.setHeader('content-type','application/json');res.end(JSON.stringify(fixtureReply(b)));});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=path.resolve('work','reuse-'+Date.now()),app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:data,PPT_AGENT_TEST:'1'},stdio:'ignore',windowsHide:true});t.after(()=>app.kill());
  const base='http://127.0.0.1:'+port;
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),p=await r.json();assert.equal(r.status,status,JSON.stringify(p));return p;};
  let p=await call('/api/projects',{brief:{title:'复用布局研究',pages:3,cover:true,progress:false}},201);const prefix='/api/projects/'+p.id,act=(action,extra={},status=200)=>call(prefix+'/action',{action,...extra},status);
  const wait=async()=>{for(let i=0;i<800;i++){p=await call(prefix);if(p.task?.status!=='running'){assert.equal(p.task.status,'done',p.task.message);return p;}await new Promise(r=>setTimeout(r,30));}throw Error('timeout');};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic-only',model:'mock'};
  await act('configure',{text:cfg,image:cfg});await act('requirements',{brief:p.brief});
  await act('saveContent',{slides:[{kind:'cover',title:'研究封面',body:[],sources:[]},{kind:'content',title:'研究内容',body:['原版结论'],sources:[]},{kind:'content',title:'研究结果',body:['最终结果'],sources:[]}]});
  await act('generateThemeAssets');p=await wait();await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts});await wait();
  for(const index of [0,1,2]){await act('confirmPageLayout',{index});await act('designPage',{index});await wait();await act('approvePageDesign',{index});}
  p=await call(prefix);assert.equal(p.downstreamReuse.pending,false,'初次设计过程不提示前置变更');
  await act('approveContent');await act('concepts');await wait();await act('selectTheme',{id:'a'});await act('generateFullPreview');await wait();
  for(const index of [0,1,2])await act('reviewPreviewPage',{index,checked:true});await act('approvePreview');await act('reconstructPreview');p=await wait();
  const beforeImages=imageCalls,beforeAudits=auditCalls,files=p.visualPages,oldGeometry=p.reconstruction.slides[1].elements.map(e=>[e.key,e.x,e.y,e.w,e.h]);
  const slides=structuredClone(p.slides);slides[1].body=['最新结论已同步'];
  p=await act('saveContent',{slides});assert.equal(p.downstreamReuse.pending,true);assert.equal('reuseCheckpoint' in p,false,'内部快照不暴露到网页');assert.equal(p.fullPreviewPages[1],false);
  p=await act('reuseDownstream');assert.equal(p.downstreamReuse.pending,false);assert.equal(p.pageDesigns[1].approvedCurrent,true);assert.match(p.pageDesigns[1].markdown,/最新结论已同步/);assert.deepEqual(p.fullPreviewPages,[true,true,true]);
  assert.equal(p.visualPages[1].file,files[1].file);assert.equal(p.visualPages[1].reused.mode,'layout-reference');assert.equal(p.visualPages[1].manualReview,null);
  assert.equal(p.visualReconstructionCurrent,true);assert.ok(p.reconstruction.slides[1].elements.some(e=>e.text==='最新结论已同步'));assert.ok(!p.reconstruction.slides[1].elements.some(e=>e.text==='原版结论'));assert.deepEqual(p.reconstruction.slides[1].elements.map(e=>[e.key,e.x,e.y,e.w,e.h]),oldGeometry);
  assert.equal(imageCalls,beforeImages);assert.equal(auditCalls,beforeAudits);assert.equal(p.output,null);assert.equal(p.candidate,null);assert.equal(p.approvals.preview,null);assert.equal(p.releaseCurrent,false);assert.equal((await fetch(base+prefix+'/download')).status,400);
  await act('reuseDownstream',{},400);
  // Added text can reuse the layout reference, but cannot masquerade as an already rebuilt native object.
  const more=structuredClone(p.slides);more[1].body.push('新增字段');p=await act('saveContent',{slides:more});p=await act('reuseDownstream');assert.equal(p.pageDesigns[1].approvedCurrent,true);assert.match(p.pageDesigns[1].markdown,/新增字段/);assert.equal(p.visualReconstructionCurrent,false);assert.ok(p.downstreamReuse.last.skipped.some(s=>s.includes('重新拆解')));assert.equal(imageCalls,beforeImages);
  // Requirement changes retain the edited text while restoring the reusable layout.
  p=await act('requirements',{brief:{...p.brief,audience:'新的评审受众'}});assert.equal(p.downstreamReuse.pending,true);p=await act('reuseDownstream');assert.equal(p.brief.audience,'新的评审受众');assert.ok(p.slides[1].body.includes('新增字段'));assert.equal(p.pageDesigns[1].approvedCurrent,true);
  // A page explicitly regenerated by the user takes precedence over the older checkpoint.
  await act('generateFullPreview',{index:1});p=await wait();const freshFile=p.visualPages[1].file,freshCalls=imageCalls;
  const later=structuredClone(p.slides);later[2].body=['另一页的新文案'];await act('saveContent',{slides:later});p=await act('reuseDownstream');assert.equal(p.visualPages[1].file,freshFile);assert.equal(p.visualPages[1].reused,undefined);assert.equal(imageCalls,freshCalls);assert.match(p.pageDesigns[2].markdown,/另一页的新文案/);
});

test('待核对证据不能通过跳过更新绕过；失败不改动项目',()=>{
  const p={brief:{title:'测试'},materials:[],slides:[{title:'标题',body:[],sources:[],sourceLinks:[]}],pageDesigns:{0:{plan:{},markdown:'旧稿'}},version:1};captureReusableResults(p);
  p.slides[0].sourceLinks=[{stale:true}];const before=structuredClone(p);assert.throws(()=>reuseDownstream(p),/待核对/);assert.deepEqual(p,before);
});

test('仅有底图时也能跳过前置要求导致的重生，并保留新要求',()=>{
  const p={brief:{title:'原主题',pages:3},materials:[],slides:[],pageDesigns:{},concepts:[],approvals:{requirements:1},version:1,themeAssets:{id:'background-set',directions:[{id:'a',assets:{'hero-image':{materialId:'original',previewHash:'hash'}}}]}};
  p.themeAssets.stamp=themeAssetsStamp(p);captureReusableResults(p);p.brief.audience='新受众';p.version++;p.approvals={};
  assert.equal(downstreamReuseState(p).pending,true);reuseDownstream(p);assert.equal(p.brief.audience,'新受众');assert.equal(p.themeAssets.stamp,themeAssetsStamp(p));assert.equal(p.themeAssets.directions[0].assets['hero-image'].materialId,'original');assert.equal(downstreamReuseState(p).pending,false);assert.equal(p.stage,1);
});
