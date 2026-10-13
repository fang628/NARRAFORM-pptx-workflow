import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fixtureRequest,fixtureReply} from './visual-fixture.mjs';
import {reuseConceptPreviews} from '../lib/visual-pipeline.mjs';

test('选中方向的三张成品直接进入全篇，仅生成其余页面；单页重生和切换方向保持正确来源',async t=>{
  let draws=0;
  const mock=http.createServer(async(req,res)=>{const b=await fixtureRequest(req);if(b.prompt)draws++;res.setHeader('content-type','application/json');res.end(JSON.stringify(fixtureReply(b)));});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=path.resolve('work','concept-reuse-'+Date.now()),base='http://127.0.0.1:'+port;
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:data,PPT_AGENT_TEST:'1'},windowsHide:true,stdio:'ignore'});t.after(()=>app.kill());
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body)=>{const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),p=await r.json();assert.equal(r.status,200,JSON.stringify(p));return p;};
  const created=await fetch(base+'/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({brief:{title:'材料研究汇报',pages:5,cover:true,toc:true,progress:false}})});
  let p=await created.json();assert.equal(created.status,201);const prefix='/api/projects/'+p.id,act=(action,extra={})=>call(prefix+'/action',{action,...extra});
  const wait=async()=>{for(let i=0;i<1500;i++){p=await call(prefix);if(p.task?.status!=='running'){assert.equal(p.task.status,'done',p.task.message);return p;}await new Promise(r=>setTimeout(r,30));}throw Error('timeout');};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'mock',key:'synthetic'};
  await act('configure',{text:cfg,image:cfg});await act('requirements',{brief:p.brief});
  await act('saveContent',{slides:[{kind:'cover',title:'研究封面',body:[],sources:[]},{kind:'toc',title:'目录',body:['研究目标','研究结果'],sources:[]},...['研究目标','研究方法','研究结果'].map(title=>({kind:'content',title,body:['忠实于材料'],sources:[]}))]});
  await act('generateThemeAssets');await wait();await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts});await wait();
  for(let index=0;index<5;index++){await act('designPage',{index});await wait();await act('approvePageDesign',{index});}
  await act('approveContent');await act('concepts');await wait();const original=p.concepts[0].representatives;assert.equal(original.length,3);
  const before=draws;p=await act('selectTheme',{id:'a'});assert.equal(draws,before);
  for(const page of original){const full=p.visualPages[page.index];assert.equal(full.file,page.file);assert.equal(full.previewHash,page.previewHash);assert.deepEqual(full.images,page.images);assert.deepEqual(full.previewReview,page.previewReview);assert.equal(full.conceptSource.theme,'a');assert.equal(full.manualReview,null);assert.equal(p.fullPreviewPages[page.index],true);}
  assert.equal(p.fullPreviewPages.filter(Boolean).length,3);
  await act('generateFullPreview');await wait();assert.equal(draws-before,2);assert.ok(p.fullPreviewPages.every(Boolean));
  for(const page of original)assert.equal(p.visualPages[page.index].jobFile,page.jobFile);
  const complete=draws;await act('generateFullPreview');await wait();assert.equal(draws,complete);
  const index=original[0].index;await act('generateFullPreview',{index});await wait();const edited=p.visualPages[index].jobFile;assert.notEqual(edited,original[0].jobFile);assert.equal(p.visualPages[index].conceptSource,undefined);
  p=await act('selectTheme',{id:'a'});assert.equal(p.visualPages[index].jobFile,edited,'再次选择不覆盖用户重生结果');
  const otherIndex=original[1].index,otherFile=p.visualPages[otherIndex].file;
  await act('generateConceptPage',{theme:'a',index});await wait();assert.equal(p.visualPages[index].jobFile,p.concepts[0].representatives.find(r=>r.index===index).jobFile);assert.equal(p.visualPages[otherIndex].file,otherFile,'更新代表页保留其他全篇页面');
  p=await act('selectTheme',{id:'b'});assert.equal(p.fullPreviewPages.filter(Boolean).length,3);assert.ok(Object.values(p.visualPages).every(r=>r.conceptSource.theme==='b'));
  // Reuse rejects stale, failed and missing files and keeps records independent.
  const copy=structuredClone(p);copy.visualPages={};const reps=copy.concepts[1].representatives;
  reps[0].stamp='stale';reps[1].previewReview.status='failed';reps[2].file='missing.png';assert.deepEqual(reuseConceptPreviews(copy,{data}),[]);
  copy.concepts[1].representatives=structuredClone(p.concepts[1].representatives);assert.equal(reuseConceptPreviews(copy,{data}).length,3);
  copy.visualPages[index].previewReview.status='failed';assert.equal(copy.concepts[1].representatives.find(r=>r.index===index).previewReview.status,'passed');
});
