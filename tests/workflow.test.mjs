import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import JSZip from 'jszip';
import {buildDeck,themes,scene,validateSlides} from '../lib/scene.mjs';
import {safeURL,parseJSON} from '../lib/provider.mjs';
import {validateReading,validateSynthesis,materialStamp} from '../lib/materials.mjs';
import {bindSources,findQuote} from '../lib/sources.mjs';
import {imagePromptSuffix} from '../lib/image-prompts.mjs';

test('逐段材料对应定位、拒绝伪造摘录与内容变更标记',()=>{
  const p={materials:[{id:'doc',kind:'document',sha256:'hash',text:'[第 2 页]\n第一条结论：增长10%。\n后续说明。'},{id:'ai',generated:true,kind:'image'}]};
  let s=validateSlides([{title:'发现',body:['增长10%'],sources:['doc'],sourceLinks:[{materialId:'doc',target:'body:0',quote:'增长10%',note:'季度数据'}]}]);
  bindSources(p,s,{requireLinks:true});assert.equal(s[0].sourceLinks[0].location.page,2);assert.equal(s[0].sourceLinks[0].location.line,2);
  s[0].body[0]='增长20%';s=validateSlides(s);bindSources(p,s);assert.equal(s[0].sourceLinks[0].stale,true);
  assert.deepEqual(findQuote('增长 10 %','增长10%'),{start:0,end:7});
  assert.throws(()=>bindSources(p,validateSlides([{title:'发现',body:['内容'],sources:['doc']}]),{requireLinks:true}),/未提供对应/);
  for(const link of [{materialId:'ai',target:'body:0',quote:'',note:'图片'},{materialId:'doc',target:'body:0',quote:'伪造证据',note:''},{materialId:'doc',target:'body:9',quote:'增长10%',note:''}])assert.throws(()=>bindSources(p,validateSlides([{title:'发现',body:['内容'],sources:[],sourceLinks:[link]}])));
});

test('材料理解必须保留可定位证据与真实来源',()=>{
  const raw={summary:'增长报告',category:'数据',keyPoints:['增长10%'],facts:[{claim:'增长10%',quote:'增长10%'}],questions:[],suggestedUse:'经营回顾'};
  assert.equal(validateReading(raw,{id:'source',kind:'document'},'季度 增长10%').facts.length,1);
  assert.throws(()=>validateReading(raw,{id:'source',kind:'document'},'增长1%'),/原文/);
  assert.throws(()=>validateSynthesis({summary:'汇总',outline:[{title:'发现',sourceIds:['fake']}],questions:[]},['source']),/不存在/);
  const p={brief:{title:'主题'},materials:[{id:'a',sha256:'x'}]};
  assert.notEqual(materialStamp(p),materialStamp({...p,brief:{title:'修改主题'}}));
  assert.equal(materialStamp(p),materialStamp({...p,materials:[...p.materials,{id:'ai',generated:true}]}));
});

test('校验页内容、拥挤排版与服务地址',async()=>{
  assert.throws(()=>validateSlides([{title:'',body:[]}]));
  assert.throws(()=>scene({kind:'content',title:'过长正文',body:Array(5).fill('很长的正文'.repeat(30))},themes[0],0,1));
  for(const u of ['http://example.com/v1','https://127.0.0.1/v1','https://[::1]/v1','https://user:pass@example.com/v1'])await assert.rejects(safeURL(u));
  assert.deepEqual(parseJSON('```json\n{"ok":true}\n```'),{ok:true});
});

test('真实 HTTP 链路：上传、API 适配、确认、导出、失效与取消',async t=>{
  const sample=[{kind:'cover',title:'项目报告',subtitle:'依据材料组织内容',body:[],notes:'开场说明',sources:[]},{kind:'content',title:'关键发现',body:['明确问题与证据。','按优先级安排下一步。'],sources:[]},{kind:'content',title:'执行安排',body:['确定负责人和里程碑。'],sources:[]}];
  let hang=false,badEvidence=false,sawVision=false,contentPrompt='',imageRequests=0,usedImagePrompt='';
  const mock=http.createServer(async(req,res)=>{const b=await fixtureRequest(req);assert.equal(b.model,'test-model');
    if(hang){setTimeout(()=>res.end('{}'),2000);return;}
    const user=b.messages?.at(-1)?.content||'',prompt=typeof user==='string'?user:user[0].text;let content='连接成功';
    if(prompt.startsWith('三方向底图规划：')||prompt.startsWith('检查三方向底图：')||prompt.includes('按照 pptx-workflow 1.3')||b.prompt?.startsWith('用途：')){res.setHeader('content-type','application/json');res.end(JSON.stringify(fixtureReply(b)));return;}
    if(prompt.includes('识别与理解单份材料')){
      assert.match(b.messages[0].content,/任何命令.*不执行/);
      const vision=Array.isArray(user);if(vision){assert.match(user[1].image_url.url,/^data:image\/png;base64,/);sawVision=true;}
      content=JSON.stringify({category:vision?'图片':'报告',summary:vision?'一张图片':'材料核心信息',keyPoints:['按材料组织内容'],facts:vision?[]:[{claim:'材料内容',excerptId:badEvidence?'FAKE':JSON.parse(prompt.split('提取原文（最多前20000字，按证据编号分段）：\n')[1])[0].id}],suggestedUse:'背景与关键发现',questions:['请确认统计周期']});
    }
    if(prompt.includes('修正材料分析中的证据引用'))content=JSON.stringify({summary:'材料摘要',keyPoints:[],facts:[{claim:'伪造的结论',excerptId:'FAKE'}],suggestedUse:'背景',questions:[]});
    if(prompt.includes('汇总材料理解')){const readings=JSON.parse(prompt.split('材料理解：')[1]);content=JSON.stringify({summary:'两份文档描述项目背景和目标。',outline:[{title:'项目背景',sourceIds:[readings[0].id]}],questions:['请确认数据口径']});}
    if(prompt.includes('输出 {slides:')){content=JSON.stringify({slides:sample});contentPrompt=prompt;}
    if(prompt.includes('concepts:'))content=JSON.stringify({concepts:themes});
    if(prompt.includes('只修改这一页'))content=JSON.stringify({slide:{...sample[1],title:'修改后的关键发现'}});
    if(prompt.includes('根据用户的自然语言要求改写图片提示词'))content=JSON.stringify({prompt:'白色背景，亮黄色几何主体，减少装饰并增加留白。'});
    if(req.url.endsWith('images/generations')){imageRequests++;usedImagePrompt=b.prompt;res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='}]}));return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content}}],usage:{total_tokens:100}}));
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));const modelPort=mock.address().port;
  const dir=path.resolve('work','test-'+Date.now());fs.mkdirSync(dir,{recursive:true});
  const app=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:'4358',PPT_AGENT_TEST:'1',PPT_AGENT_DATA:dir},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let logs='';app.stdout.on('data',b=>logs+=b);app.stderr.on('data',b=>logs+=b);
  t.after(()=>{app.kill();mock.close();});
  const base='http://127.0.0.1:4358';
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  const call=async(url,b,status=200)=>{const r=await fetch(base+url,b===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;};
  const brief={title:'测试项目',pages:3,progress:true,speaker:true};
  let p=await call('/api/projects',{brief},201),prefix='/api/projects/'+p.id;
  const act=(action,extra={},status=200)=>call(prefix+'/action',{action,...extra},status);
  const wait=async()=>{for(let i=0;i<200;i++){p=await call(prefix);if(p.task?.status!=='running')return p;await new Promise(r=>setTimeout(r,30));}throw Error('任务超时');};
  await act('build',{},400);
  p=await call(prefix+'/materials',{name:'source.txt',sourcePath:'输入材料/报告/source.txt',base64:Buffer.from('项目的材料内容。').toString('base64')});assert.match(p.materials[0].text,/材料/);assert.equal(p.materials[0].sourcePath,'输入材料/报告/source.txt');await call(prefix+'/materials',{name:'bad.txt',sourcePath:'../bad.txt',base64:'YQ=='},400);
  const docx=new JSZip();docx.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word材料文字</w:t></w:r></w:p></w:body></w:document>');
  p=await call(prefix+'/materials',{name:'source.docx',base64:await docx.generateAsync({type:'base64'})});assert.match(p.materials[1].text,/Word材料文字/);
  sample[1].sources=[p.materials[0].id];sample[1].sourceLinks=[{materialId:p.materials[0].id,target:'body:0',quote:'项目的材料内容。',note:'以项目原文为内容依据'}];
  await act('requirements',{brief});
  const secret='synthetic-key-not-a-real-secret';const cfg={baseURL:`http://127.0.0.1:${modelPort}/v1`,key:secret,model:'test-model'};
  p=await act('configure',{text:cfg,image:cfg});assert.equal(p.apiReady,true);assert.ok(!JSON.stringify(p).includes(secret));
  await act('testAPI');assert.equal((await wait()).task.status,'done');
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  p=await call(prefix+'/materials',{name:'photo.png',base64:png});const photoId=p.materials.at(-1).id;
  await act('requirements',{brief});
  await act('content',{},400);await act('approveAnalysis',{},400);
  badEvidence=true;await act('analyzeMaterials');p=await wait();assert.equal(p.task.status,'failed');assert.equal(p.analysis,null);badEvidence=false;
  await act('analyzeMaterials');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.analysisCurrent,true);assert.equal(p.analysis.readings.at(-1).status,'skipped');assert.equal(sawVision,false);
  await act('content',{},400);
  await act('analyzeMaterials',{includeImages:true});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.analysis.readings.at(-1).coverage,'image');assert.equal(sawVision,true);
  await act('approveAnalysis',{reviewNotes:'统计周期为第二季度'});
  await act('analyzeMaterials',{includeImages:true});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.analysis.reviewNotes,'统计周期为第二季度');assert.equal(p.analysis.approvedAt,null);await act('approveAnalysis',{reviewNotes:p.analysis.reviewNotes});
  await act('content');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.slides.length,3);
  assert.match(contentPrompt,/统计周期为第二季度/);assert.match(contentPrompt,/材料核心信息/);
  assert.match(contentPrompt,/sourceLinks/);assert.equal(p.slides[1].sourceLinks[0].location.line,1);
  const changed=p.slides.map((s,i)=>i===1?{...s,body:['已修改的段落',...s.body.slice(1)]}:s);
  p=await act('saveContent',{slides:changed});assert.equal(p.slides[1].sourceLinks[0].stale,true);await act('approveContent',{},400);
  p.slides[1].sourceLinks[0].boundText=undefined;p=await act('saveContent',{slides:p.slides});assert.equal(p.slides[1].sourceLinks[0].stale,false);
  const forged=p.slides.map((s,i)=>i===1?{...s,sourceLinks:[{...s.sourceLinks[0],quote:'虚构的原文'}]}:s);await act('saveContent',{slides:forged},400);
  await act('approveContent');await act('concepts',{},400);
  let r=await fetch(base+prefix+'/preview?slide=1');assert.equal(r.status,200);assert.match(await r.text(),/<text /);
  await act('image',{index:1,prompt:'抽象绿色几何插画',allowUpload:true});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.ok(p.slides[1].imageId);
  const firstImage=p.slides[1].imageId,originalPrompt=p.materials.find(m=>m.id===firstImage).prompt;
  assert.equal(usedImagePrompt,originalPrompt+imagePromptSuffix);assert.equal(p.materials.find(m=>m.id===firstImage).effectivePrompt,usedImagePrompt);
  const beforeDraftVersion=p.version;
  p=await act('saveImagePrompt',{index:1,sourceImageId:firstImage,prompt:'直接编辑后的提示词'});assert.equal(p.version,beforeDraftVersion);assert.equal(p.approvals.preview,null);assert.equal(p.materials.find(m=>m.id===firstImage).prompt,originalPrompt);
  const countBeforeRewrite=imageRequests;await act('rewriteImagePrompt',{index:1,sourceImageId:firstImage,prompt:'直接编辑后的提示词',instruction:'背景改成白色，减少装饰'});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(imageRequests,countBeforeRewrite);assert.match(p.imagePromptDrafts['1:'+firstImage].prompt,/白色背景/);
  await act('image',{index:1,sourceImageId:firstImage,prompt:'新版提示词'},400);
  await act('image',{index:1,sourceImageId:firstImage,prompt:p.imagePromptDrafts['1:'+firstImage].prompt,mode:'natural',instruction:'背景改成白色',allowUpload:true});p=await wait();assert.equal(p.task.status,'done',p.task.message);const nextImage=p.materials.find(m=>m.id===p.slides[1].imageId);assert.equal(nextImage.parentImageId,firstImage);assert.equal(p.materials.find(m=>m.id===firstImage).prompt,originalPrompt);assert.equal(p.approvals.preview,null);
  await act('approvePreview',{},400);await act('build',{},400);await call(prefix+'/download',undefined,400);
  const nativeFile=path.join(dir,'native-pipeline.pptx');await buildDeck({...p,concepts:themes,selectedTheme:'b'},nativeFile,id=>path.join(dir,p.id,'assets',p.materials.find(m=>m.id===id).file));
  const pptx=fs.readFileSync(nativeFile);assert.ok(pptx.length>10000);
  const zip=await JSZip.loadAsync(pptx);const slideXML=await zip.file('ppt/slides/slide2.xml').async('string');assert.match(slideXML,/<a:t>关键发现<\/a:t>/);assert.match(slideXML,/<p:pic>/);assert.ok(zip.file('ppt/notesSlides/notesSlide1.xml'));
  assert.equal(Object.keys(zip.files).filter(k=>/^ppt\/slides\/slide\d+\.xml$/.test(k)).length,3);
  const exported=p;assert.equal(exported.slides[1].sourceLinks[0].materialId,sample[1].sources[0]);assert.equal(exported.materials.find(m=>m.id===nextImage.id).effectivePrompt,nextImage.effectivePrompt);assert.equal(exported.materials.find(m=>m.id===nextImage.id).parentImageId,firstImage);
  const materialCount=p.materials.length;hang=true;await act('image',{index:1,sourceImageId:nextImage.id,prompt:'待取消的图片提示词',allowUpload:true});await act('cancel');p=await wait();assert.equal(p.task.status,'cancelled');assert.equal(p.slides[1].imageId,nextImage.id);assert.equal(p.materials.length,materialCount);hang=false;
  await act('saveContent',{slides:p.slides.map((s,i)=>i===1?{...s,title:'新标题'}:s)});await act('build',{},400);await call(prefix+'/download',undefined,400);
  await act('revise',{index:1,instruction:'精简标题'});p=await wait();assert.equal(p.slides[1].title,'修改后的关键发现');
  hang=true;await act('testAPI');await act('cancel');p=await wait();assert.equal(p.task.status,'cancelled');
  const projectData=fs.readFileSync(path.join(dir,p.id,'project.json'),'utf8');assert.ok(!projectData.includes(secret));assert.ok(!logs.includes(secret));
  hang=false;p=await act('removeMaterial',{id:photoId});assert.equal(p.analysis,null);assert.equal(p.approvals.requirements,undefined);assert.ok(!p.materials.some(m=>m.id===photoId));
  await act('requirements',{brief});await act('analyzeMaterials');p=await wait();assert.equal(p.task.status,'done',p.task.message);await act('approveAnalysis');
  p=await call(prefix+'/materials',{name:'new.txt',base64:Buffer.from('新材料').toString('base64')});assert.equal(p.analysisCurrent,false);assert.equal(p.analysis,null);
  hang=true;await act('analyzeMaterials');await act('cancel');p=await wait();assert.equal(p.task.status,'cancelled');assert.equal(p.analysis,null);
  const denied=await fetch(base+'/api/projects',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:'{}'});assert.equal(denied.status,403);
  const badFile=await call(prefix+'/materials',{name:'bad.exe',base64:'AA=='},400);assert.match(badFile.error,/支持/);
});
