import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fixtureRequest,fixtureReply} from './visual-fixture.mjs';
import {reuseConceptPreviews} from '../lib/visual-pipeline.mjs';
import {visualConcepts} from '../public/visual-ui.js';
import {crossImageSelection,crossImageRequest} from '../public/theme-cross-edit.js';

test('选中方向的三张成品直接进入全篇，仅生成其余页面；单页重生和切换方向保持正确来源',async t=>{
  let lastImageRequest=null;let draws=0,failReviews=true,brokenReview=false,incompleteReviews=false;
  const mock=http.createServer(async(req,res)=>{const b=await fixtureRequest(req);if(b.prompt){draws++;lastImageRequest={...b,endpoint:req.url};}res.setHeader('content-type','application/json');const reply=fixtureReply(b),text=b.messages?.at(-1)?.content?.[0]?.text||'';if(failReviews&&text.startsWith('检查生图整页成品：')){const r=JSON.parse(reply.choices[0].message.content);if(!brokenReview){delete r.designChecks.readability;brokenReview=true;}r.passed=false;r.issues=['正文不可读'];if(r.designChecks.readability!==undefined)r.designChecks.readability=false;r.designChecks.reason='正文不可读';reply.choices[0].message.content=JSON.stringify(r);}if(incompleteReviews&&text.startsWith('检查生图整页成品：'))reply.choices[0].message.content=JSON.stringify({passed:true,issues:[],notes:'仅返回部分结果'});res.end(JSON.stringify(reply));});
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
  await act('approveContent');await act('concepts');await wait();const original=p.concepts[0].representatives;assert.equal(original.length,3);assert.ok(p.concepts.flatMap(c=>c.representatives).some(r=>r.reviewResponseValidation.attempts===1));
  assert.equal(p.conceptReadiness.a.passed,false);assert.equal(p.conceptReadiness.a.selectable,true);
  const html=visualConcepts(p,()=>'',()=> '');assert.match(html,/<button class="secondary" data-theme="a" >仍选择此方向 →/);failReviews=false;
  const before=draws;p=await act('selectTheme',{id:'a'});assert.equal(draws,before);assert.ok(p.visualDirectionSelection.acceptedReviewIssues.length);assert.equal(p.visualPages[original[0].index].previewReview.status,'needs_revision');
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
  // Quality failures remain selectable; stale or missing artifacts never get reused.
  const copy=structuredClone(p);copy.visualPages={};const reps=copy.concepts[1].representatives;
  reps[0].stamp='stale';reps[1].previewReview.status='failed';reps[2].file='missing.png';assert.deepEqual(reuseConceptPreviews(copy,{data}),[reps[1].index]);assert.equal(copy.visualPages[reps[1].index].previewReview.status,'failed');copy.visualPages={};
  copy.concepts[1].representatives=structuredClone(p.concepts[1].representatives);assert.equal(reuseConceptPreviews(copy,{data}).length,3);
  copy.visualPages[index].previewReview.status='failed';assert.equal(copy.concepts[1].representatives.find(r=>r.index===index).previewReview.status,p.concepts[1].representatives.find(r=>r.index===index).previewReview.status);
  incompleteReviews=true;const beforeCheck=draws,hash=p.visualPages[index].previewHash;await act('checkVisualPage',{kind:'full',index});await wait();assert.equal(p.visualPages[index].previewReview.status,'inconclusive');assert.equal(p.visualPages[index].previewHash,hash);assert.equal(draws,beforeCheck);assert.equal(p.visualPages[index].previewReviewHistory.slice(-3).length,3);
  incompleteReviews=false;
  const sourceCross=structuredClone(p.concepts[1].representatives.find(r=>r.index===index)),targetCross=structuredClone(p.concepts[0].representatives.find(r=>r.index===index)),beforeCross=draws;
  const currentTarget={targetType:'visual',kind:'concept',theme:'a',index},crossRequest=crossImageRequest(p,currentTarget,crossImageSelection(p,currentTarget,'b',targetCross.previewHash),'降低反光');assert.equal(crossRequest.theme,'a');assert.equal(crossRequest.crossStyleSource.theme,'b');await act('generateConceptPage',crossRequest);await wait();
  const crossed=p.concepts[0].representatives.find(r=>r.index===index);
  assert.equal(draws,beforeCross+1);assert.ok(lastImageRequest.endpoint.endsWith('/images/edits'));assert.equal(lastImageRequest.referenceImages.length,2);assert.match(lastImageRequest.prompt,/保留全部文字与图注/);assert.match(lastImageRequest.prompt,/保留原框数量及宽高比/);assert.doesNotMatch(lastImageRequest.prompt,/不含文字/);
  assert.equal(crossed.crossStyle.sourceDirection,'b');assert.notEqual(crossed.jobFile,targetCross.jobFile);assert.equal(p.concepts[1].representatives.find(r=>r.index===index).jobFile,sourceCross.jobFile);assert.equal(p.visualPages[index].jobFile,sourceCross.jobFile,'其他方向的已选预览保持不变');
  p=await act('restoreAIImage',{targetType:'visual',kind:'concept',theme:'a',index,direction:'undo',sourceHash:crossed.previewHash,sourceRevision:crossed.jobFile});assert.equal(p.concepts[0].representatives.find(r=>r.index===index).jobFile,targetCross.jobFile);
  p=await act('restoreAIImage',{targetType:'visual',kind:'concept',theme:'a',index,direction:'redo',sourceHash:targetCross.previewHash,sourceRevision:targetCross.jobFile});assert.equal(p.concepts[0].representatives.find(r=>r.index===index).jobFile,crossed.jobFile);assert.equal(draws,beforeCross+1);

});
