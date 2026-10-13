import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fixtureReply,fixtureRequest,fixtureDirections,fixturePlannedDirections} from './visual-fixture.mjs';
import {workflowLibraryVersion,workflowManifest,workflowFile,workflowPageContext,workflowStyleContext} from '../lib/workflow-library.mjs';
import {themeAssetUses,themeAssetPrompt,validateThemeDirections} from '../lib/theme-assets.mjs';
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');

test('工作流库副本来源可核验，按页型使用规范和六类风格参考',()=>{
  for(const entry of workflowManifest.files)assert.equal(hash(fs.readFileSync(workflowFile(entry.file))),entry.sha256,entry.file);
  assert.equal(workflowFile('../server.mjs'),null);assert.equal(workflowFile('shared/../../server.mjs'),null);
  assert.match(workflowStyleContext(),/A.*浅蓝白/s);assert.match(workflowStyleContext(),/F.*深褐朱红/s);
  assert.match(workflowStyleContext(),/仅用于工具界面，不构成 PPT 需求/);
  const cover=workflowPageContext({slides:[{kind:'cover'}]},0),toc=workflowPageContext({slides:[{kind:'toc'}]},0);
  assert.match(cover,/title-T01/);assert.match(toc,/toc-D01/);assert.match(cover,/文本框内尽量不要有渐变/);assert.match(cover,/风格要求/);
});

test('每方向封面/目录/背景共享底色、比例、复杂度和文字预留',()=>{
  const rawDirections=fixtureDirections().map(d=>({...d,contentSubject:'边角简化的肽链连接轮廓'}));const directions=validateThemeDirections(rawDirections);assert.equal(directions[0].contentSubject,rawDirections[0].contentSubject);assert.deepEqual(themeAssetUses({brief:{toc:false}}),['hero-image','content-background']);
  for(const d of directions)for(const use of themeAssetUses({brief:{toc:true}})){
    const prompt=themeAssetPrompt({brief:{title:'科研材料'}},d,use);assert.match(prompt,/16:9（1920×1080）/);assert.ok(prompt.includes(d.coreColor));assert.match(prompt,use==='content-background'?/不要过于复杂，不要抢夺视觉中心/:/主体为视觉重心/);assert.match(prompt,/不绘制可读文字、数字、图注、文本框或占位框/);assert.match(prompt,/阅读区/);assert.match(prompt,/主题元素须.*可辨识/);if(use==='content-background')assert.ok(prompt.includes(d.contentSubject));assert.ok(prompt.length<400);
  }
  assert.throws(()=>validateThemeDirections(fixtureDirections().slice(0,2)),/三个方向/);
  const bad=fixtureDirections();bad[0].coreColor='red';assert.throws(()=>validateThemeDirections(bad),/核心底色/);
});

test('材料理解后准备提示词，确认后生成底图；整页必须用对应底图图生图，缺少未使用用途不阻塞',async t=>{
  let backgroundChecks=0,active=0,peak=0,failImages=false,failStylePlan=false,mismatchedStyle=false;const requests=[],registeredBeforeImages=[],understandingBeforePlanning=[];
  const mock=http.createServer(async(req,res)=>{
    const b=await fixtureRequest(req);requests.push({...b,endpoint:req.url});res.setHeader('content-type','application/json');
    const user=b.messages?.at(-1)?.content,text=typeof user==='string'?user:user?.[0]?.text||'';
    if(b.prompt){registeredBeforeImages.push(JSON.parse(fs.readFileSync(path.join(dir,p.id,'project.json'),'utf8')).styleRegistry?.length);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,25));active--;if(failImages){res.statusCode=401;res.end('{}');return;}}
    let reply=fixtureReply(b,{backgroundIssue:text.startsWith('检查三方向底图：')&&backgroundChecks++===0});
    if(text.startsWith('检查三方向底图：')&&reply.choices[0].message.content){const result=JSON.parse(reply.choices[0].message.content);if(!result.passed)result.issues=['出现两个独立主题主体，须合为单一视觉主体'];if(result.passed){result.issues=['配色偏好建议，非严重问题'];reply.choices[0].message.content=JSON.stringify(result);}else reply.choices[0].message.content=JSON.stringify(result);}
    if(text.startsWith('三方向底图规划：')){const saved=JSON.parse(fs.readFileSync(path.join(dir,p.id,'project.json'),'utf8'));understandingBeforePlanning.push({status:saved.materialUnderstandingTask?.status,label:saved.task.label,summary:saved.analysis?.summary,finishedAt:saved.materialUnderstandingTask?.finishedAt,startedAt:saved.task.startedAt});}
    if(text.startsWith('三方向底图规划：'))reply.choices[0].message.content=JSON.stringify({directions:fixturePlannedDirections(text)});
    if(text.startsWith('更换单个底图方向：'))reply={choices:[{message:{content:JSON.stringify({direction:failStylePlan?{}:{...fixturePlannedDirections(text)[2],referenceStyleId:'D',name:'浅靛留白新风格',coreColor:'#ECEFFC',style:'浅靛底与墨蓝文字，单一蓝色强调'}})}}]};
    if(text.startsWith('更换单个底图方向：')&&mismatchedStyle){const result=JSON.parse(reply.choices[0].message.content);result.direction.styleSelection={matchingPresetIds:['A'],reason:'本次医学材料仅适合浅蓝白的证据表达，其他候选不适合'};reply.choices[0].message.content=JSON.stringify(result);}
    if(text.includes('识别与理解单份材料'))reply={choices:[{message:{content:JSON.stringify({category:'研究报告',summary:'材料关注分子修饰研究，底图只作主题示意',keyPoints:['药代动力学'],facts:[{claim:'测试材料明确给出研究范围',excerptId:'E0001'}],suggestedUse:'主题与叙事',questions:[]})}}]};
    if(text.startsWith('汇总材料理解')){const readings=JSON.parse(text.split('材料理解：')[1]);reply={choices:[{message:{content:JSON.stringify({summary:'研究分子修饰与递送，不生成虚假分子式或数据',outline:[{title:'研究目标',sourceIds:[readings[0].id]}],questions:[]})}}]};}
    res.end(JSON.stringify(reply||{choices:[{message:{content:'连接成功'}}]}));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const dir=path.resolve('work','theme-assets-'+Date.now()),base='http://127.0.0.1:4370';
  const app=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:'4370',PPT_AGENT_TEST:'1',PPT_AGENT_DATA:dir},stdio:'ignore',windowsHide:true});t.after(()=>{app.kill();mock.close();});
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const res=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),json=await res.json();assert.equal(res.status,status,JSON.stringify(json));return json;};
  let p=await call('/api/projects',{brief:{title:'学术汇报：分子修饰',toc:true,pages:3}},201);const prefix='/api/projects/'+p.id,act=(action,extra={},status=200)=>call(prefix+'/action',{action,...extra},status);
  const wait=async()=>{for(let i=0;i<1500;i++){p=await call(prefix);if(p.task?.status!=='running')return p;await new Promise(r=>setTimeout(r,30));}throw Error('超时');};
  p=await call(prefix+'/materials',{name:'report.txt',base64:Buffer.from('研究范围为分子修饰与递送，相关图只作非事实示意。').toString('base64')});
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic-background-key',model:'synthetic-theme'};
  await act('configure',{text:cfg,image:cfg});await act('requirements',{brief:p.brief});await act('setConcurrency',{limit:2});await act('analyzeMaterials');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.analysisCurrent,true);assert.equal(p.analysis.approvedAt,null);assert.equal(p.themeAssets.status,'awaiting_prompt');assert.equal(requests.filter(b=>b.prompt).length,0);assert.equal(p.concepts.length,0);
  assert.equal(p.materialUnderstandingTask.status,'done');assert.equal(p.task.label,'识别与理解材料');
  assert.equal(requests.some(b=>b.messages?.at(-1)?.content?.startsWith?.('三方向底图规划：')),false,'01材料理解不自动规划风格或底图');
  await act('generateThemeAssets',{},400);
  await act('saveContent',{slides:[{kind:'cover',title:'研究汇报',body:[],sources:[]},{kind:'toc',title:'目录',body:['研究目标','实施路径'],sources:[]},{kind:'content',title:'研究目标',body:['只依据原文与准确来源'],sources:[]}]});
  await act('generateThemeAssets');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.themeAssets.status,'awaiting_confirmation');assert.equal(p.themeAssets.libraryVersion,workflowLibraryVersion);
  assert.deepEqual(p.themeAssets.contentPlan.outline.map(s=>s.title),p.slides.map(s=>s.title));
  assert.ok(understandingBeforePlanning.length&&understandingBeforePlanning.every(r=>r.status==='done'&&r.label==='规划三方向底图提示词'&&r.summary&&r.finishedAt<=r.startedAt));
  const analysisEnd=p.events.findIndex(e=>e.message==='识别与理解材料完成'),backgroundStart=p.events.findIndex(e=>e.message==='规划三方向底图提示词开始');assert.ok(analysisEnd>=0&&backgroundStart>analysisEnd);
  await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(requests.filter(b=>b.prompt).length,9);assert.equal(p.themeAssets.status,'awaiting_confirmation');assert.match(p.themeAssets.directions.flatMap(d=>Object.values(d.assets)).find(r=>r.previewReview.status==='needs_revision').previewReview.issues[0],/两个独立主题主体/);
  await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts.filter(r=>r.status==='pending')});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.themeAssetsReady,true);assert.equal(peak,2);
  const lightChecks=requests.filter(b=>b.messages?.at(-1)?.content?.[0]?.text?.startsWith('检查三方向底图：'));assert.ok(lightChecks.every(b=>b.messages.at(-1).content.filter(c=>c.type==='image_url').length===1));assert.ok(lightChecks.every(b=>b.messages.at(-1).content[0].text.includes('轻量检查')));
  for(const request of lightChecks){const text=request.messages.at(-1).content[0].text;if(/当前封面底图|当前目录底图/.test(text)){assert.match(text,/一个明确主视觉铺满预定视觉区，明显可见/);assert.match(text,/不要求覆盖文字区/);assert.match(text,/只在存在多个竞争主体、拼贴或重复主视觉、/);assert.match(text,/一个整体的附属结构、低对比背景纹理不另计主体/);}else{assert.match(text,/不要求大主体/);assert.doesNotMatch(text,/铺满预定视觉区|存在多个独立主体/);}}
  for(const request of requests.filter(r=>typeof r.messages?.at(-1)?.content==='string'&&r.messages.at(-1).content.startsWith('三方向底图规划：'))){assert.match(request.messages.at(-1).content,/封面与目录每张各自只能有一个明确且贴合主题的视觉主体/);assert.match(request.messages.at(-1).content,/主体描述用一个短语，通常10–25字/);assert.doesNotMatch(request.messages.at(-1).content,/30–50字/);}
  const records=p.themeAssets.directions.flatMap(d=>Object.values(d.assets));assert.equal(records.length,9);assert.equal(p.materials.filter(m=>m.generated).length,10);assert.equal(p.materials.filter(m=>!m.generated).length,1);assert.ok(records.every(r=>r.previewReview.status==='passed'));assert.ok(records.some(r=>r.repairHistory?.length===1));
  assert.ok(records.every(r=>r.previewReview.mode==='lightweight'));assert.ok(records.some(r=>r.previewReview.suggestions?.length));assert.ok(records.every(r=>r.previewReview.issues.length===0),'建议不作为否决理由');
  assert.equal(p.styleRegistry.length,3);assert.equal(p.styleRegistry[0].origin,'reference-adaptation');assert.equal(p.themeAssets.directions[0].referenceStyleId,'A');assert.equal(p.themeAssets.directions[0].subjectSources.heroSubject.materialId,p.materials.find(m=>!m.generated).id);assert.ok(registeredBeforeImages.every(n=>n===3),'所有底图请求前风格已持久登记');
  const registration=await call(prefix+'/styles/'+p.themeAssets.directions[0].styleRegistrationId);assert.equal(registration.definition.name,'浅蓝科研');
  for(const r of records){assert.ok(p.styleRegistry.some(s=>s.id===r.styleRegistrationId));const job=JSON.parse(fs.readFileSync(path.join(dir,p.id,r.jobFile),'utf8'));assert.equal(job.styleRegistrationId,r.styleRegistrationId);assert.equal(job.promptVersion,'workflow-background-prompt-v9');assert.equal(job.prompt,r.prompt);assert.ok(r.prompt.length<500);assert.equal(r.prompt.split('用途：').length,2);}
  const firstCheck=requests.findIndex(b=>b.messages?.at(-1)?.content?.[0]?.text?.startsWith('检查三方向底图：'));assert.equal(requests.slice(0,firstCheck).filter(b=>b.prompt).length,9);
  assert.ok(requests.filter(b=>b.prompt).every(b=>b.endpoint.endsWith('/images/generations')&&!b.referenceImages?.length),'底图重试也仅文生图，先确认再请求');
  const library=await call('/api/workflow-library');assert.equal(library.styles.length,6);const document=await fetch(base+'/workflow-library/shared/design-principles.md');assert.equal(document.status,200);assert.match(await document.text(),/优先顺序/);
  await act('approveAnalysis');await act('saveContent',{slides:[{kind:'cover',title:'研究汇报',body:[],sources:[]},{kind:'toc',title:'目录',body:['研究目标','实施路径'],sources:[]},{kind:'content',title:'研究目标',body:['只依据原文与准确来源'],sources:[]}]});
  for(const index of [0,1]){await act('designPage',{index});p=await wait();assert.equal(p.task.status,'done',p.task.message);await act('approvePageDesign',{index});}
  const missingData=path.resolve('work','missing-theme-candidates-'+Date.now());fs.mkdirSync(missingData,{recursive:true});fs.cpSync(path.join(dir,p.id),path.join(missingData,p.id),{recursive:true});
  const missingProject=JSON.parse(fs.readFileSync(path.join(missingData,p.id,'project.json'),'utf8'));delete missingProject.themeAssets.directions[0].assets['toc-image'];fs.writeFileSync(path.join(missingData,p.id,'project.json'),JSON.stringify(missingProject));
  const missingApp=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:'4371',PPT_AGENT_TEST:'1',PPT_AGENT_DATA:missingData},stdio:'ignore',windowsHide:true});t.after(()=>missingApp.kill());
  const missingBase='http://127.0.0.1:4371';for(let i=0;i<150;i++){try{if((await fetch(missingBase+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const missingCall=async(body,status=200)=>{const res=await fetch(missingBase+prefix+(body?'/action':''),body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),v=await res.json();assert.equal(res.status,status,JSON.stringify(v));return v;};
  assert.equal((await missingCall()).themeAssetsReady,true,'缺少目录候选不要求补齐');await missingCall({action:'configure',text:cfg,image:cfg});const beforeMissing=requests.filter(r=>r.prompt).length;await missingCall({action:'concepts'},400);assert.equal(requests.filter(r=>r.prompt).length,beforeMissing,'缺少对应底图时不调用生图或退回文生图');let missingResult=await missingCall();const missingSlides=structuredClone(missingResult.slides);missingSlides[1].title='目录待重新确认';await missingCall({action:'saveContent',slides:missingSlides});await missingCall({action:'concepts'});
  for(let i=0;i<1000;i++){missingResult=await missingCall();if(missingResult.task.status!=='running')break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(missingResult.task.status,'done',missingResult.task.message);assert.ok(missingResult.concepts.every(c=>c.representatives.length===1&&c.representatives[0].index===0),'只生成已确认封面，不强制补齐未使用的目录底图');assert.equal(missingResult.concepts[0].representatives.find(r=>r.index===0).reference.purpose,'hero-image','现有合格底图仍采用');
  const beforeConcepts=requests.length;await act('concepts');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.concepts.length,3);assert.ok(p.concepts.every(c=>c.representatives.length===2));
  assert.equal(p.styleRegistry.length,3,'整页方案复用底图登记');for(const c of p.concepts)for(const r of c.representatives)assert.equal(r.styleRegistrationId,c.styleRegistrationId);
  const pageCalls=requests.slice(beforeConcepts).filter(b=>b.prompt);assert.equal(pageCalls.length,6);assert.ok(pageCalls.every(b=>b.endpoint.endsWith('/images/edits')&&b.referenceImages.length===1));
  for(const c of p.concepts)for(const r of c.representatives){const d=p.themeAssets.directions.find(d=>d.id===c.id),use=r.index===0?'hero-image':'toc-image';assert.equal(r.reference.purpose,use);assert.equal(r.reference.sha256,d.assets[use].previewHash);assert.deepEqual(r.images,[]);assert.match(r.prompt,/不为底图加图注/);assert.match(r.prompt,/只保留一个取自材料且明显可见的主视觉/);assert.match(r.prompt,/不形成竞争主体或重复主视觉/);assert.match(r.prompt,/\*\*简约要求\*\*：文本框内尽量不要有渐变/);assert.ok(r.prompt.includes(d.coreColor));assert.ok(!r.prompt.includes('浅灰底深字、亮黄色强调、独立渐变与圆形装饰'),'旧单页风格不应污染所选方向');assert.ok(!r.prompt.includes('若其旧配色或装饰描述冲突'),'不重复追加风格覆盖说明');}
  await act('selectTheme',{id:'a'});await act('generateFullPreview');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.deepEqual(p.fullPreviewPages,[true,true,false]);
  const currentImageCount=requests.filter(b=>b.prompt).length;await act('regenerateThemeDirection',{theme:'a'});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(requests.filter(b=>b.prompt).length,currentImageCount,'准备提示词不会调用生图');
  const coverHash=p.visualPages[0].previewHash;await act('setThemeBackgroundUse',{theme:'a',enabled:false});p=await call(prefix);assert.equal(p.themeAssets.directions[0].useContentBackground,true);assert.equal(p.visualPages[0].previewHash,coverHash);assert.equal(p.fullPreviewPages[0],true);
  await act('rewriteThemeAssetPrompt',{theme:'a',use:'hero-image',revision:p.themeAssetPrompts.find(r=>r.theme==='a'&&r.use==='hero-image').revision,instruction:'减少左侧细线'});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.match(p.themeAssetPrompts.find(r=>r.theme==='a'&&r.use==='hero-image').prompt,/减少左侧细线/);
  const rewrite=requests.findLast(r=>typeof r.messages?.at(-1)?.content==='string'&&r.messages.at(-1).content.startsWith('按自然语言修改无字主题底图提示词'));assert.match(rewrite.messages.at(-1).content,/一个明确主视觉铺满预定视觉区，明显可见/);assert.doesNotMatch(rewrite.messages.at(-1).content,/不要抢夺视觉中心/);
  failImages=true;const previous=p.themeAssets.directions[0].assets['hero-image'].previewHash;await act('generateThemeAsset',{theme:'a',use:'hero-image',confirmed:true,revision:p.themeAssetPrompts.find(r=>r.theme==='a'&&r.use==='hero-image').revision,prompt:'保留主体，进一步减少左侧细线。'});p=await wait();assert.equal(p.task.status,'failed');assert.equal(p.themeAssets.directions[0].assets['hero-image'].previewHash,previous,'request failure retains the existing background');assert.equal(p.output,null);assert.equal((await fetch(base+prefix+'/download')).status,400);
  assert.ok(!fs.readFileSync(path.join(dir,p.id,'project.json'),'utf8').includes('synthetic-background-key'));
  failImages=false;
  const otherDirections=structuredClone(p.themeAssets.directions.slice(1)),oldStyle=p.themeAssets.directions[0].styleRegistrationId,oldIds=Object.values(p.themeAssets.directions[0].assets).map(r=>r.materialId),beforeRegenerate=requests.length;
  await act('regenerateThemeDirection',{theme:'missing'},400);await act('changeThemeDirection',{theme:'a',referenceStyleId:'missing'},400);
  await act('regenerateThemeDirection',{theme:'a'});p=await wait();assert.equal(p.task.status,'done',p.task.message);await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts.filter(r=>r.theme==='a')});p=await wait();assert.equal(p.task.status,'done',p.task.message);
  assert.equal(p.themeAssets.directions[0].styleRegistrationId,oldStyle);assert.equal(p.styleRegistry.length,3);assert.equal(p.themeAssets.directions[0].useContentBackground,true);
  assert.deepEqual(p.themeAssets.directions.slice(1),otherDirections);assert.ok(Object.values(p.themeAssets.directions[0].assets).every(r=>!oldIds.includes(r.materialId)&&r.repairHistory.length));
  const regenerationCalls=requests.slice(beforeRegenerate).filter(b=>b.prompt);assert.equal(regenerationCalls.length,3);assert.ok(regenerationCalls.every(b=>b.endpoint.endsWith('/images/generations')),'同风格重生以新构图生成，而非编辑旧图');
  assert.equal(requests.slice(beforeRegenerate).filter(b=>typeof b.messages?.at(-1)?.content==='string').length,0,'同风格重生不重新规划风格');
  assert.deepEqual(p.concepts,[]);assert.equal(p.selectedTheme,null);assert.deepEqual(p.visualPages,{});assert.equal(p.output,null);
  const beforeFailedPlan=structuredClone(p.themeAssets);failStylePlan=true;
  await act('changeThemeDirection',{theme:'a'});p=await wait();assert.equal(p.task.status,'failed');assert.deepEqual(p.themeAssets,beforeFailedPlan,'规划失败保留原方向与图片');failStylePlan=false;
  const beforeMismatch=requests.length,registryBeforeMismatch=structuredClone(p.styleRegistry);mismatchedStyle=true;
  await act('changeThemeDirection',{theme:'a',referenceStyleId:'D'});p=await wait();assert.equal(p.task.status,'failed');assert.match(p.task.message,/不在贴合主题/);
  assert.deepEqual(p.themeAssets,beforeFailedPlan);assert.deepEqual(p.styleRegistry,registryBeforeMismatch);assert.equal(requests.slice(beforeMismatch).filter(b=>b.prompt).length,0,'偏题风格在生图和登记前拦截');mismatchedStyle=false;
  const beforeChange=requests.length,previousDirection=structuredClone(p.themeAssets.directions[0]);failImages=true;
  await act('changeThemeDirection',{theme:'a',referenceStyleId:'D',instruction:'采用浅靛留白，主体简洁'});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(requests.slice(beforeChange).filter(b=>b.prompt).length,0);await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts.filter(r=>r.theme==='a')});p=await wait();assert.equal(p.task.status,'failed');
  const changed=p.themeAssets.directions[0];assert.notEqual(changed.styleRegistrationId,oldStyle);assert.equal(p.styleRegistry.length,4);assert.equal(changed.referenceStyleId,'D');assert.match(requests.findLast(r=>typeof r.messages?.at(-1)?.content==='string'&&r.messages.at(-1).content.startsWith('更换单个底图方向：')).messages.at(-1).content,/每张各自只能有一个明确且贴合主题的视觉主体/);assert.match(requests.findLast(r=>typeof r.messages?.at(-1)?.content==='string'&&r.messages.at(-1).content.startsWith('更换单个底图方向：')).messages.at(-1).content,/主体描述用一个短语，通常10–25字/);assert.deepEqual(changed.assets,{});assert.deepEqual(changed.revisionHistory[0].assets,previousDirection.assets);assert.equal(changed.revisionHistory[0].styleRegistrationId,oldStyle);assert.deepEqual(p.themeAssets.directions.slice(1),otherDirections);
  assert.ok(requests.slice(beforeChange).filter(b=>b.prompt).every(b=>b.endpoint.endsWith('/images/generations')),'换风格不引用旧风格图片');assert.ok(registeredBeforeImages.slice(-3).every(n=>n===4),'新风格生图前先保存登记');
  failImages=false;const beforeResume=requests.length;await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts.filter(r=>r.theme==='a')});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.themeAssetsReady,true);assert.equal(requests.slice(beforeResume).filter(b=>b.prompt).length,3,'重试仅补齐新方向');assert.deepEqual(p.themeAssets.directions.slice(1),otherDirections);assert.ok(Object.values(p.themeAssets.directions[0].assets).every(r=>r.styleRegistrationId===changed.styleRegistrationId&&!r.reference));
  const beforeDeleteAssets=structuredClone(p.themeAssets);p=await act('deleteRegisteredStyle',{styleId:oldStyle});assert.equal(p.styleRegistryDeletion,true);assert.ok(p.styleRegistry.find(r=>r.id===oldStyle).deletedAt);assert.deepEqual(p.themeAssets,beforeDeleteAssets,'删除不破坏既有方向');await act('changeThemeDirection',{theme:'a',referenceStyleId:oldStyle},400);await act('deleteRegisteredStyle',{styleId:oldStyle},400);assert.equal((await call(prefix+'/styles/'+oldStyle)).id,oldStyle,'历史来源仍可追溯');
  await act('requirements',{brief:{...p.brief,title:'修改后的主题'}});p=await call(prefix);assert.equal(p.themeAssetsCurrent,false);assert.equal(p.themeAssetsReady,false);
  const savedRegistry=p.styleRegistry;await new Promise(r=>{app.once('exit',r);app.kill();});
  const restarted=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:'4370',PPT_AGENT_TEST:'1',PPT_AGENT_DATA:dir},stdio:'ignore',windowsHide:true});t.after(()=>restarted.kill());
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  assert.deepEqual((await call(prefix)).styleRegistry,savedRegistry,'重启后保留全部风格登记');
});
