import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import JSZip from 'jszip';
import {Resvg} from '@resvg/resvg-js';
import {digest} from '../lib/visual-model.mjs';
import {imagePromptVersion} from '../lib/slide-image-prompts.mjs';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';
import {validateAudit} from '../lib/visual-model.mjs';

test('自由拆解保护准确文字、原图和局部裁剪边界',()=>{
  const s={title:'准确标题',body:[],sources:[]},text={key:'title',type:'text',nodeId:'title',text:'准确标题',x:50,y:40,w:800,h:80,size:40,color:'272727',bold:true};
  assert.throws(()=>validateAudit([],s,[]),/元素审计/);
  assert.throws(()=>validateAudit([{...text,text:'篡改'}],s,[]),/准确文字/);
  assert.throws(()=>validateAudit([text,{key:'crop',type:'crop',x:0,y:500,w:200,h:100,sourceBox:{x:0,y:0,w:1000,h:800}}],s,[]),/整页/);
  assert.throws(()=>validateAudit([text,{key:'crop',type:'crop',x:0,y:500,w:100,h:100,sourceBox:{x:50,y:40,w:100,h:60}}],s,[]),/不能包含文字/);
  assert.equal(validateAudit([text,{key:'decoration',type:'ellipse',x:1000,y:700,w:100,h:100,fill:'fff238'}],s,[]).length,2);
});

test('按页确认、生图、自由重建、实际 PowerPoint 渲染及 release 下载闸门',async t=>{
  let imageActive=0,imagePeak=0,badRatio=false,badAudit=false,badReview=true,extraAssets=true,hang=false,conflictingSplit=true,badDecoration=true,badPageReview=false,decorationReviews=0,placeholderRatios=null,placeholderDetections=0,emptyRepair=false;const requests=[];
  const mock=http.createServer(async(req,res)=>{const b=await fixtureRequest(req);requests.push({...b,endpoint:req.url});if(hang){setTimeout(()=>res.end('{}'),1000);return;}
    if(b.prompt){imageActive++;imagePeak=Math.max(imagePeak,imageActive);await new Promise(r=>setTimeout(r,80));imageActive--;}
    const user=b.messages?.at(-1)?.content,text=typeof user==='string'?user:user?.[0]?.text||'';
    if(emptyRepair&&b.prompt?.startsWith('【占位框比例修正】')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[]}));return;}
    const failDecoration=badDecoration&&text.startsWith('检查生图整页成品：')&&text.includes('风格：纸白和灰')&&decorationReviews++===0;
    let reply=fixtureReply(b,{customDirections:true,badRatio,badAudit,badReview,extraAssets,conflictingSplit,badDecoration:failDecoration,badPageReview})||{choices:[{message:{content:'连接成功'}}]};if(text.startsWith('自由元素审计：')){const audit=JSON.parse(reply.choices[0].message.content);for(const e of audit.elements){if(e.color)e.color='#'+e.color;if(e.fill)e.fill='#'+e.fill;}reply.choices[0].message.content=JSON.stringify(audit);}if(text.startsWith('定位图片预留区：')&&placeholderRatios){const r=JSON.parse(reply.choices[0].message.content),factor=placeholderRatios[Math.min(placeholderDetections++,placeholderRatios.length-1)];for(const e of r.images)e.h=e.w/(e.aspect*factor);reply.choices[0].message.content=JSON.stringify(r);}res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const dir=path.resolve('work','visual-pipeline-'+Date.now()),base='http://127.0.0.1:4365';
  const app=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:'4365',PPT_AGENT_TEST:'1',PPT_AGENT_DATA:dir},stdio:'ignore',windowsHide:true});t.after(()=>{app.kill();mock.close();});
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;};
  let p=await call('/api/projects',{brief:{title:'整页生图与交付验收',pages:3,speaker:true}},201),prefix='/api/projects/'+p.id;const act=(action,extra={},status=200)=>call(prefix+'/action',{action,...extra},status);
  const wait=async()=>{for(let i=0;i<2400;i++){p=await call(prefix);if(p.task?.status!=='running')return p;await new Promise(r=>setTimeout(r,50));}throw Error('任务超时');};
  await act('setConcurrency',{limit:2});
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'synthetic-visual',key:'synthetic-only-key'};
  p=await act('configure',{text:{...cfg,model:'synthetic-main'},image:cfg,elementImage:cfg});assert.equal(p.rebuildReady,true);assert.equal(p.rebuildConfigured,false);await act('requirements',{brief:p.brief});
  const originalPNG=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#c83250"/></svg>').render().asPng().toString('base64');p=await call(prefix+'/materials',{name:'original.png',base64:originalPNG});const imageId=p.materials[0].id;await act('requirements',{brief:p.brief});
  await act('analyzeMaterials',{includeImages:true});p=await wait();assert.equal(p.task.status,'done',p.task.message);await act('approveAnalysis');
  p=await act('saveContent',{slides:[{kind:'cover',title:'封面',body:[],sources:[],imageId},{kind:'content',title:'尚未确认页面',body:['材料和内容保持一致'],sources:[],imageId},{kind:'content',title:'最后一页',body:['原生交付'],sources:[]}]});
  await act('generateThemeAssets');p=await wait();await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts});p=await wait();assert.equal(p.task.status,'done',p.task.message);requests.length=0;imagePeak=0;
  await act('approveContent');await act('concepts',{},400);
  const confirm=async i=>{await act('confirmPageLayout',{index:i});await act('designPage',{index:i});p=await wait();assert.equal(p.task.status,'done',p.task.message);await act('approvePageDesign',{index:i});};
  await confirm(0);await act('concepts');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.concepts.length,3);assert.equal(imagePeak,2);assert.equal(p.task.concurrency,2);assert.equal(p.task.jobs.filter(j=>j.status==='done').length,6);assert.equal(p.task.jobs.some(j=>j.status==='running'),false);assert.ok(p.concepts.every(c=>c.representatives.every(r=>r.index===0)));assert.deepEqual(p.confirmedVisualPages,[0]);const pasted=p.concepts[0].representatives[0];const pixelScript='from PIL import Image;import json,sys;print(json.dumps([list(Image.open(f).convert("RGBA").getpixel((1566,258))) for f in sys.argv[1:]]))';const pixels=JSON.parse(execFileSync(path.resolve('.venv/Scripts/python.exe'),['-c',pixelScript,path.join(dir,p.id,pasted.file),path.join(dir,p.id,pasted.normalized)],{encoding:'utf8',windowsHide:true}));assert.deepEqual(pixels[0],[200,50,80,255]);assert.notDeepEqual(pixels[1],pixels[0]);assert.ok(p.concepts.every(c=>c.representatives[0].images[0].id===imageId));assert.ok(p.concepts.every(c=>c.representatives[0].previewHash!==c.representatives[0].providerHash));assert.ok(requests.filter(b=>b.prompt&&b.size==='1920x1080').every(b=>b.prompt.includes('占位块')&&b.prompt.includes('无字')));
  assert.equal(requests.filter(b=>b.prompt&&b.size==='1920x1080').length,3);
  for(const c of p.concepts){const r=c.representatives[0];assert.equal(r.designChecks.special_split,undefined);assert.equal(r.review.designChecks.special_split,undefined);assert.equal(r.designChecks.warnings,undefined);assert.ok(fs.existsSync(path.join(dir,p.id,r.file)));}
  assert.equal(requests.filter(b=>b.messages?.at(-1)?.content?.[0]?.text?.startsWith('检查生图整页成品：')).length,3);
  assert.equal(p.conceptReadiness.a.passed,true);assert.equal(p.conceptReadiness.c.passed,true);
  const unrepaired=p.concepts[2].representatives[0];assert.equal(unrepaired.previewReview.status,'passed');assert.ok(unrepaired.previewReview.warnings.some(w=>w.includes('装饰')));assert.ok(!unrepaired.autoRepair,'装饰问题不能在贴回后重绘整页');assert.ok(!unrepaired.repairHistory);
  const firstCheck=requests.findIndex(b=>b.messages?.at(-1)?.content?.[0]?.text?.startsWith('检查生图整页成品：'));assert.equal(requests.slice(0,firstCheck).filter(b=>b.prompt).length,3);assert.equal(requests.slice(firstCheck).filter(b=>b.prompt).length,0,'贴回后的检查不触发生图');
  badDecoration=false;await act('checkVisualPage',{kind:'concept',theme:'c',index:0});p=await wait();assert.equal(p.task.status,'done');assert.equal(p.conceptReadiness.c.passed,true);assert.equal(requests.filter(b=>b.prompt&&b.size==='1920x1080').length,3);
  const beforeRewriteImages=requests.filter(b=>b.prompt).length;
  await act('rewriteVisualPrompt',{kind:'concept',theme:'a',index:0,instruction:'增加留白，精简重复说明'});p=await wait();assert.equal(p.task.status,'done',p.task.message);
  const rewritten=p.concepts[0].representatives[0].promptDraft;
  assert.equal([...rewritten.matchAll(/^- \*\*/gm)].length,7);assert.ok(!rewritten.includes('【本次生成边界】'));assert.match(rewritten,/增加留白并精简装饰/);
  assert.equal(requests.filter(b=>b.prompt).length,beforeRewriteImages,'修改提示词不自行生图');
  const rewriteRequest=requests.find(b=>typeof b.messages?.at(-1)?.content==='string'&&b.messages.at(-1).content.startsWith('按用户要求修改以下整页生图提示词'));
  assert.doesNotMatch(rewriteRequest.messages.at(-1).content,/任务结构示例：/);assert.match(rewriteRequest.messages.at(-1).content,/不设置凑字数的下限/);
  assert.ok(p.concepts.every(c=>c.representatives.every(r=>r.promptVersion===imagePromptVersion)));
  badPageReview=true;
  await act('selectTheme',{id:'b'});await act('generateFullPreview',{index:1},400);await act('generateFullPreview',{force:true});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.deepEqual(p.fullPreviewPages,[true,false,false]);let hash=p.visualPages[0].previewHash;
  assert.equal(p.visualPages[0].geometryAdjustment.mode,'local-composite');assert.equal(p.visualPages[0].normalized,p.visualPages[0].repairHistory[0].normalized);assert.equal(p.visualPages[0].prompt,p.visualPages[0].repairHistory[0].prompt);assert.equal(p.visualPages[0].images[0].background,undefined);
  assert.equal(p.visualPages[0].autoRepair.attempts,2);assert.equal(p.visualPages[0].autoRepair.status,'exhausted');assert.equal(p.visualPages[0].repairHistory.length,2);assert.equal(p.visualPages[0].previewReview.status,'needs_revision');assert.match(p.visualPages[0].previewReview.issues[0],/遮挡/);assert.equal(p.designStandards.passed,false);
  const beforeRecheck=requests.filter(b=>b.prompt).length;badPageReview=false;await act('checkVisualPage',{kind:'full',index:0});p=await wait();assert.equal(p.task.status,'done');assert.equal(p.visualPages[0].previewReview.status,'passed');assert.equal(p.visualPages[0].previewHash,hash);assert.equal(requests.filter(b=>b.prompt).length,beforeRecheck);
  for(const [ratios,attempts,status] of [[[1.4,1.02],1,'passed'],[[1.3,1.3,1.3],2,'exhausted']]){
    placeholderRatios=ratios;placeholderDetections=0;const since=requests.length;
    await act('generateFullPreview',{index:0});p=await wait();assert.equal(p.task.status,'done',p.task.message);
    const page=p.visualPages[0],draws=requests.slice(since).filter(r=>r.prompt),locates=requests.slice(since).filter(r=>r.messages?.at(-1)?.content?.[0]?.text?.startsWith('定位图片预留区：'));
    assert.equal(draws.length,attempts+1);assert.equal(locates.length,attempts+1);assert.equal(page.placeholderReview.attempts,attempts);assert.equal(page.placeholderReview.status,status);assert.equal(page.previewReview.status,'passed');
    assert.equal(page.generationAttempts.length,attempts+1);assert.equal(page.placeholderReview.history.length,attempts+1);
    assert.ok(draws.every(r=>r.endpoint.endsWith('/images/edits')));assert.equal(draws[0].referenceImages.length,1);
    const foundation=p.themeAssets.directions.find(d=>d.id==='b').assets['hero-image'];
    for(let n=0;n<draws.length;n++){
      const job=page.generationAttempts[n];assert.equal(draws[n].referenceImages.at(-1).sha256,foundation.previewHash);
      assert.ok(draws[n].referenceImages.every(r=>r.sha256!==digest(Buffer.from(originalPNG,'base64'))),'事实原图不发送给生图接口');
      assert.equal(digest(Buffer.from(locates[n].messages.at(-1).content[1].image_url.url.split(',')[1],'base64')),digest(fs.readFileSync(path.join(dir,p.id,job.normalized))),'比例检查只查看尚未贴回原图的底稿');
      if(n){assert.equal(draws[n].referenceImages.length,2);assert.equal(draws[n].referenceImages[0].sha256,digest(fs.readFileSync(path.join(dir,p.id,page.generationAttempts[n-1].normalized))));assert.equal(draws[n].prompt.split('【占位框比例修正】').length,2);assert.ok(draws[n].prompt.startsWith('【占位框比例修正】'));assert.doesNotMatch(draws[n].prompt,/\*\*比例要求\*\*|\*\*内容要求\*\*|\*\*风格要求\*\*/,'修正请求只发送局部指令，不拼接原设计提示词');}
    }
    assert.equal(page.placeholderReview.limit,2);assert.ok(p.task.progress.some(e=>e.kind==='placeholder'&&e.message.includes('修正 '+attempts+'/2')));
    const pair=JSON.parse(execFileSync(path.resolve('.venv/Scripts/python.exe'),['-c',pixelScript,path.join(dir,p.id,page.file),path.join(dir,p.id,page.normalized)],{encoding:'utf8',windowsHide:true}));assert.deepEqual(pair[0],[200,50,80,255]);assert.notDeepEqual(pair[1],pair[0]);
    const ledger=JSON.parse(fs.readFileSync(path.join(dir,p.id,page.jobFile),'utf8'));assert.equal(ledger.generationMode,'image-to-image');assert.equal(page.generationMode,'image-to-image');assert.equal(page.references.at(-1).materialId,foundation.materialId);assert.equal(ledger.placeholderReview.status,status);
  }
  emptyRepair=true;placeholderRatios=[1.3];placeholderDetections=0;const beforeFallback=requests.length;
  await act('generateFullPreview',{index:0});p=await wait();assert.equal(p.task.status,'done',p.task.message);
  const fallback=p.visualPages[0];assert.equal(fallback.placeholderReview.status,'fallback');assert.equal(fallback.placeholderReview.attempts,1);assert.equal(fallback.normalized,fallback.generationAttempts[0].normalized);assert.equal(fallback.generationAttempts[1].status,'failed');assert.equal(fallback.previewReview.status,'passed');assert.match(p.task.message,/上一张已定位底稿/);assert.equal(requests.slice(beforeFallback).filter(r=>r.prompt).length,4,'初次成功，修正空响应最多3次后沿用上一图');assert.ok(p.task.progress.some(e=>e.kind==='retry'));
  const fallbackPixels=JSON.parse(execFileSync(path.resolve('.venv/Scripts/python.exe'),['-c',pixelScript,path.join(dir,p.id,fallback.file),path.join(dir,p.id,fallback.normalized)],{encoding:'utf8',windowsHide:true}));assert.deepEqual(fallbackPixels[0],[200,50,80,255]);assert.notDeepEqual(fallbackPixels[1],fallbackPixels[0]);emptyRepair=false;
  placeholderRatios=null;hash=p.visualPages[0].previewHash;
  assert.equal(p.visualPages[0].designChecks.special_split,undefined);assert.equal(p.designStandards.specialPages,undefined);assert.equal(p.designStandards.passed,false);conflictingSplit=false;
  const slides=structuredClone(p.slides);slides[1].title='编辑未确认页面';p=await act('saveContent',{slides});assert.equal(p.fullPreviewPages[0],true);assert.equal(p.visualPages[0].previewHash,hash);assert.equal(p.selectedTheme,'b');
  await confirm(1);await confirm(2);await act('approveContent');badRatio=true;await act('generateFullPreview');p=await wait();assert.equal(p.task.status,'failed');assert.deepEqual(p.fullPreviewPages,[true,false,false]);badRatio=false;
  await act('generateFullPreview');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.deepEqual(p.fullPreviewPages,[true,true,true]);assert.equal(p.designStandards.passed,true);assert.equal(p.visualPages[0].previewHash,hash);assert.equal(p.visualPages[1].images[0].id,imageId);const preview=await fetch(base+prefix+'/preview?slide=1');assert.equal(preview.headers.get('content-type'),'image/png');
  badPageReview=true;await act('generateFullPreview',{index:0});p=await wait();assert.equal(p.designStandards.passed,false);assert.equal(p.previewApprovalState.ready,true);
  const acceptanceStamp=p.previewApprovalState.stamp;
  await act('approvePreview',{confirmAllPages:true,approvalStamp:acceptanceStamp},400);await act('approvePreview',{confirmAllPages:true,acceptIssues:true,approvalStamp:'stale'},400);
  p=await act('approvePreview',{confirmAllPages:true,acceptIssues:true,approvalStamp:acceptanceStamp});assert.equal(p.stage,6);assert.equal(p.approvals.preview,p.version);assert.equal(p.visualPages[0].previewReview.status,'needs_revision');assert.ok(p.previewApproval.acceptedIssues.length);assert.equal(p.previewApproval.pageChecks[0].status,'needs_revision');
  await act('reconstructPreview');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.visualReconstructionCurrent,true,'检查未通过但已确认时可执行05拆解');await call(prefix+'/download',undefined,400);
  assert.ok(requests.some(r=>r.messages?.at(-1)?.content?.[0]?.text?.includes('用户已确认继续的预览检查记录')));
  badPageReview=false;await act('checkVisualPage',{kind:'full',index:0});p=await wait();assert.equal(p.previewApproval,null);await act('approvePreview',{confirmAllPages:true,acceptIssues:true,approvalStamp:acceptanceStamp},400);
  assert.match(p.visualPages[0].redrawPrompt,/\*\*内容要求\*\*/,'完整重绘稿与局部修正指令独立保留');
  await act('generateFullPreview',{index:0,prompt:p.visualPages[0].redrawPrompt+'\n保留这条用户修改：蓝色细线。'});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.match(p.visualPages[0].prompt,/保留这条用户修改：蓝色细线/);assert.ok(!p.visualPages[0].prompt.includes('设计规范版本：'));assert.ok(!p.visualPages[0].prompt.includes('【本次生成边界】'));await act('approvePreview',{},400);for(let i=0;i<3;i++)await act('reviewPreviewPage',{index:i,checked:true});await act('approvePreview');await act('release',{},400);await call(prefix+'/download',undefined,400);
  badAudit=true;await act('reconstructPreview');p=await wait();assert.equal(p.task.status,'failed');assert.equal(p.reconstruction,null);badAudit=false;
  await act('build');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.visualReconstructionCurrent,true);assert.equal(p.candidate.status,'failed');assert.equal(p.candidate.structure.passed,true);assert.equal(p.candidate.renderer,'Microsoft PowerPoint');assert.equal(p.output,null);assert.ok(p.reconstruction.assets.length>=9);await act('release',{},400);await call(prefix+'/download',undefined,400);
  assert.equal(p.candidateDownload.available,true,'视觉不通过仍可下载最后实际渲染版');
  const draftURL=prefix+'/candidate-download?candidate='+p.candidate.id,draft=await fetch(base+draftURL+'&type=pptx');assert.equal(draft.status,200);assert.match(draft.headers.get('content-disposition'),/review-required/);assert.equal(draft.headers.get('x-ppt-agent-status'),'review-required');assert.ok((await JSZip.loadAsync(await draft.arrayBuffer())).file('ppt/slides/slide1.xml'));
  const draftPDF=await fetch(base+draftURL+'&type=pdf');assert.equal(draftPDF.status,200);assert.ok(Buffer.from(await draftPDF.arrayBuffer()).subarray(0,5).equals(Buffer.from('%PDF-')));
  const draftReport=await call(draftURL+'&type=report');assert.equal(draftReport.releasePassed,false);assert.ok(draftReport.pages.some(r=>!r.passed));await call(prefix+'/candidate-download?candidate=wrong',undefined,400);
  assert.equal(p.reconstruction.model,'synthetic-main');assert.equal(p.candidate.review.model,'synthetic-main');
  assert.deepEqual(p.reconstruction.slides.map(s=>s.background.use),['hero-image','content-background','content-background']);
  assert.ok(p.reconstruction.slides.every(s=>s.background.theme==='b'&&p.candidate.assetIds.includes(s.background.id)));
  assert.ok(requests.filter(b=>b.messages?.at(-1)?.content?.[0]?.text?.startsWith('自由元素审计：')).every(b=>b.messages.at(-1).content.filter(c=>c.type==='image_url').length===2));
  assert.ok(p.candidate.structure.slides.every(s=>s.background),'实际PowerPoint文件通过背景身份和哈希校验');
  assert.equal(p.styleRegistry.length,3,'整页方案复用底图的三个已登记原创方向');assert.ok(p.styleRegistry.every(s=>s.origin==='custom'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,p.id,p.candidate.dir,'style-registry.json'),'utf8')),p.styleRegistry,'交付证据保留风格登记');
  p=await act('configure',{rebuild:{...cfg,model:'synthetic-rebuild'}});assert.equal(p.rebuildConfigured,true);
  badReview=false;extraAssets=false;await act('build');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.candidate.status,'awaiting_review');assert.equal(p.candidate.review.pages.length,3);assert.equal(p.reconstruction.model,'synthetic-rebuild');assert.equal(p.candidate.review.model,'synthetic-rebuild');
  assert.ok(requests.filter(b=>b.messages?.at(-1)?.content?.[0]?.text?.startsWith('渲染对照验收：')).every(b=>b.messages.at(-1).content.filter(c=>c.type==='image_url').length===4));
  assert.ok(p.candidate.review.pages.every(r=>r.diagnostics.status==='available'));
  assert.ok(p.reconstruction.slides.every(s=>s.geometry.status==='available'));
  assert.equal((await fetch(base+prefix+'/review-image?index=0&kind=difference&candidate='+p.candidate.id)).status,200);
  const textLayout=JSON.parse(fs.readFileSync(path.join(dir,p.id,p.candidate.dir,'text-layout.json'),'utf8'));
  assert.ok(textLayout.some(page=>page.measured>0),'真实PowerPoint文字尺寸已反馈到局部排版搜索');
  await act('reviewReleasePage',{index:0,checks:{visual:true},notes:'不完整复核'},400);const checks={visual:true,content:true,photos:true,editability:true,preview_match:true};
  for(let i=0;i<3;i++)await act('reviewReleasePage',{index:i,checks,notes:'合成测试复核：所有工件与实际 PowerPoint 渲染已生成，核对下载闸门。',acceptDeviations:true});
  p=await act('release');assert.equal(p.releaseCurrent,true);assert.equal(p.output.release.passed,true);const download=await fetch(base+prefix+'/download');assert.equal(download.status,200);const zip=await JSZip.loadAsync(await download.arrayBuffer());const xml=await zip.file('ppt/slides/slide2.xml').async('string');assert.match(xml,/编辑未确认页面/);assert.match(xml,/<p:pic>/);assert.ok(Object.keys(zip.files).some(n=>n.endsWith('.svg')));const pdf=await fetch(base+prefix+'/download?type=pdf');assert.equal(pdf.status,200);
  const report=await call(prefix+'/download?type=release');assert.equal(report.designStandards.passed,true);assert.equal(report.checks.visualComparison,true);assert.equal(report.pages.length,3);
  const disk=fs.readFileSync(path.join(dir,p.id,'project.json'),'utf8');assert.ok(!disk.includes('synthetic-only-key'));
  const renderFile=path.join(dir,p.id,p.candidate.dir,'S01.png'),copy=fs.readFileSync(renderFile);fs.appendFileSync(renderFile,'tamper');await call(prefix+'/download',undefined,400);fs.writeFileSync(renderFile,copy);
  const modified=structuredClone(p.slides);modified[1].notes='修改已确认页';p=await act('saveContent',{slides:modified});assert.deepEqual(p.fullPreviewPages,[true,false,true]);assert.equal(p.releaseCurrent,false);await call(prefix+'/download',undefined,400);
  hash=p.visualPages[0].previewHash;await confirm(1);await act('approveContent');hang=true;await act('generateFullPreview');await act('cancel');p=await wait();assert.equal(p.task.status,'cancelled');assert.equal(p.visualPages[0].previewHash,hash);hang=false;
});
