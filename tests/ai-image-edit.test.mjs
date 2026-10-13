import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';
import {aiImageTarget,imageEditExecution} from '../lib/ai-image-edit.mjs';
import {imageEditTarget,initAIImageEditor,createPromptHistory} from '../public/provenance.js';
import {imageTaskRequest} from '../lib/image-task-queue.mjs';
import {digest} from '../lib/visual-model.mjs';

test('图生图可直接发送人工意见或修改后的整理稿，仅当前图片身份必须匹配',()=>{
  const image={id:'m',kind:'image',generated:true,file:'m.png',sha256:'hash',prompt:'完整原稿'},p={id:'p',materials:[image],slides:[],themeAssets:{directions:[]}};
  const b={targetType:'image',sourceImageId:'m',imageEditMode:'redraw',prompt:'  最终稿\n保留空格  ',sourceHash:'hash'};
  assert.equal(aiImageTarget(p,b).key,imageEditTarget(p,b).key);
  assert.equal(imageEditExecution(p,b).prompt,b.prompt);
  assert.throws(()=>imageEditExecution(p,{...b,sourceHash:'old'}),/图片已变化/);
  const adjust={...b,imageEditMode:'adjust',adjustmentRevision:2,instruction:'上移主体。'};
  assert.equal(imageEditExecution(p,adjust).prompt,adjust.instruction,'不要求存在 AI 草稿');
  p.aiImageEditDrafts={[aiImageTarget(p,b).key]:{mode:'adjust',sourceHash:'hash',revision:2,instruction:adjust.instruction}};
  assert.equal(imageEditExecution(p,adjust).prompt,adjust.instruction);
  assert.equal(imageEditExecution(p,{...adjust,instruction:'  人工继续修改\n保留空格  ',adjustmentRevision:1}).prompt,'  人工继续修改\n保留空格  ');
  for(const instruction of ['', '  ',null,42,'x'.repeat(3001)])assert.throws(()=>imageEditExecution(p,{...adjust,instruction}),/1–3000/);
  assert.equal(imageEditExecution(p,{...adjust,instruction:'x'.repeat(3000)}).prompt.length,3000);
  assert.throws(()=>imageEditExecution(p,{...adjust,sourceHash:'old'}),/图片已变化/);
  const queued=imageTaskRequest({action:'image',...adjust,key:'must-not-store'});
  assert.equal(queued.sourceHash,'hash');assert.equal(queued.adjustmentRevision,2);assert.equal(queued.imageEditMode,'adjust');assert.equal(queued.key,undefined);
});

test('图片修改弹窗只有一个输入框，人工直接提交与 AI 回填后编辑共用同一路径',async()=>{
  const previous=globalThis.document,fields=new Map(),calls=[],errors=[];let html='',running=false;
  const field=key=>{if(!fields.has(key))fields.set(key,{id:key.slice(1),value:'',checked:false,disabled:false,dataset:{},handlers:{},textContent:'',setAttribute(){},hasAttribute(){return false;},addEventListener(name,fn){this.handlers[name]=fn;},closest(){return this;}});return fields.get(key);};
  const dialog={open:false,handlers:{},querySelector:field,addEventListener(name,fn){this.handlers[name]=fn;},showModal(){this.open=true;},close(){this.open=false;}};
  globalThis.document={body:{insertAdjacentHTML(_,value){html=value;}},querySelector:()=>dialog};
  try{
    const image={id:'m',kind:'image',generated:true,file:'m.png',sha256:'hash',prompt:'完整旧稿'},p={id:'p',apiReady:true,imageReady:true,imageTaskQueueEnabled:true,materials:[image],slides:[]},target={targetType:'image',sourceImageId:'m'};
    const editor=initAIImageEditor({getProject:()=>p,busy:()=>running,openAPI:()=>errors.push('API'),onError:e=>errors.push(e),act:async(action,b)=>{
      calls.push({action,...b});
      if(action==='prepareAIImageEdit')p.aiImageEditDrafts={[aiImageTarget(p,target).key]:{mode:b.imageEditMode,sourceHash:'hash',revision:(p.aiImageEditDrafts?.[aiImageTarget(p,target).key]?.revision||0)+1,instruction:'AI 整理后的意见',prompt:'AI 整理后的完整稿'}};
    }});
    const flush=()=>new Promise(r=>setImmediate(r)),input=field('#aiEditInstruction'),consent=field('#aiEditConsent');
    const submit=async()=>{field('#aiImageEditForm').handlers.submit({preventDefault(){},stopPropagation(){}});await flush();};
    const click=async key=>{dialog.handlers.click({stopPropagation(){},target:field(key)});await flush();};
    assert.equal((html.match(/<textarea\b/g)||[]).length,1);
    editor.open(target);assert.equal(field('#aiEditGenerate').disabled,false);
    input.value='  直接调整主体\n保留留白。  ';input.handlers.input();consent.checked=true;await submit();
    assert.equal(calls.length,1);assert.equal(calls[0].action,'image');assert.equal(calls[0].instruction,input.value);assert.equal(calls[0].adjustmentRevision,undefined);
    editor.open(target);input.value='整理这段';await click('#aiEditPrepare');assert.equal(input.value,'AI 整理后的意见');
    await click('#aiEditPromptUndo');assert.equal(input.value,'整理这段');await click('#aiEditPromptRedo');assert.equal(input.value,'AI 整理后的意见');
    input.value+='，再缩小一点';input.handlers.input();consent.checked=true;await submit();assert.equal(calls.at(-1).instruction,input.value);
    editor.open(target);field('[data-edit-mode="redraw"]').dataset.editMode='redraw';await click('[data-edit-mode="redraw"]');assert.equal(input.value,'完整旧稿');
    input.value='改过的完整稿，主体靠右';await click('#aiEditPrepare');assert.equal(calls.at(-1).prompt,'改过的完整稿，主体靠右');assert.equal(input.value,'AI 整理后的完整稿');
    input.value+='，最终人工修订';input.handlers.input();await click('#aiEditPromptUndo');assert.equal(input.value,'AI 整理后的完整稿');await click('#aiEditPromptRedo');assert.equal(input.value,'AI 整理后的完整稿，最终人工修订');
    consent.checked=true;await submit();assert.equal(calls.at(-1).prompt,input.value);assert.equal(calls.at(-1).instruction,undefined);
    editor.open(target);running=true;editor.refresh();assert.equal(field('#aiEditGenerate').disabled,false,'支持向运行中的任务队列直接添加');
    assert.deepEqual(errors,[]);assert.equal(fields.has('#aiEditOutput'),false,'不引用旧的第二输入框');
  }finally{globalThis.document=previous;}
});

test('提示词连续撤回、重做与分支编辑保持最终输入，不污染其他输入框',()=>{
  const h=createPromptHistory('原稿'),other=createPromptHistory('另一页');h.record('人工改稿');h.record('AI 整理');h.record('AI 整理');assert.equal(h.undo(),'人工改稿');assert.equal(h.undo(),'原稿');assert.equal(h.canUndo,false);assert.equal(h.redo(),'人工改稿');h.record('新分支');assert.equal(h.canRedo,false);assert.equal(h.undo(),'人工改稿');assert.equal(other.value,'另一页');
});

test('内容原子确认及底图、素材、代表页、全篇预览的两条修改路径使用真实接口协议',async t=>{
  const requests=[];let badRatio=false,detections=0;
  const mock=http.createServer(async(req,res)=>{
    const b=await fixtureRequest(req);requests.push({...b,endpoint:req.url});const content=b.messages?.at(-1)?.content,text=typeof content==='string'?content:content?.[0]?.text||'';
    let answer;
    if(text.startsWith('整理图生图局部调整意见'))answer={choices:[{message:{content:JSON.stringify({instruction:'将主体略微向右移动，保留其余部分。'})}}]};
    else if(text.startsWith('按用户意见改写文生图完整提示词'))answer={choices:[{message:{content:JSON.stringify({prompt:'  完整最终重绘提示词：研究主题，主体靠右，16:9。\n留白。  '})}}]};
    else answer=fixtureReply(b);
    if(badRatio&&text.startsWith('定位图片预留区：')){const r=JSON.parse(answer.choices[0].message.content);for(const image of r.images)image.h=image.w/(image.aspect*(detections++?1:1.4));answer.choices[0].message.content=JSON.stringify(r);}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(answer));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=path.resolve('work','ai-image-edit-'+Date.now()),base='http://127.0.0.1:'+port;
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:data},windowsHide:true,stdio:'ignore'});t.after(()=>app.kill());
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;};
  let p=await call('/api/projects',{brief:{title:'分子修饰研究',pages:3,cover:true,toc:false}},201);const prefix='/api/projects/'+p.id,act=(action,extra={},status)=>call(prefix+'/action',{action,...extra},status);
  const wait=async()=>{for(let i=0;i<1500;i++){p=await call(prefix);if(p.task?.status!=='running'){assert.equal(p.task?.status,'done',p.task?.message);return p;}await new Promise(r=>setTimeout(r,30));}throw Error('timeout');};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'synthetic',key:'synthetic-key'};
  await act('configure',{text:cfg,image:cfg});
  p=await call(prefix+'/materials',{name:'材料.txt',base64:Buffer.from('分子修饰及递送研究。').toString('base64')});
  await act('requirements',{brief:p.brief});await act('analyzeMaterials');await wait();await act('approveAnalysis');p=await call(prefix);
  await act('saveContent',{slides:[{kind:'cover',title:'研究封面',body:[],sources:[]}]});await act('generateThemeAssets');await wait();
  await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts.filter(d=>d.use==='hero-image')});await wait();
  // Atomic content confirmation remains on the same version when nothing changes.
  p=await act('saveContent',{slides:[{kind:'cover',title:'研究封面',body:[],sources:[]}],confirm:true});assert.equal(p.approvals.content,p.version);assert.equal(p.pageDesigns[0].layoutCurrent,true);assert.equal(p.pageDesigns[0].approvedCurrent,false);
  const version=p.version;p=await act('saveContent',{slides:p.slides,confirm:true});assert.equal(p.version,version);assert.equal(p.approvals.content,version);
  const changed=structuredClone(p.slides);changed[0].title='已修改标题';p=await act('saveContent',{slides:changed,confirm:true});assert.equal(p.version,version+1);assert.equal(p.approvals.content,p.version);
  const rejected=structuredClone(p.slides);rejected[0].title='不应写入';rejected[0].sources=[p.materials[0].id];rejected[0].sourceLinks=[{id:'stale',materialId:p.materials[0].id,target:'title',quote:'分子修饰',boundText:p.slides[0].title,stale:true}];
  const rejection=await act('saveContent',{slides:rejected,confirm:true},400);assert.match(rejection.error,/核对待核对/);const unchanged=await call(prefix);assert.equal(unchanged.version,p.version);assert.equal(unchanged.slides[0].title,p.slides[0].title);
  const runMode=async(target,mode,{aiRedraw=false,ratioRepair=false,direct=false}={})=>{
    const before=aiImageTarget(p,target),ui=imageEditTarget(p,target);assert.equal(before.key,ui.key);assert.equal(before.prompt,ui.prompt);
    let request={...before.request,imageEditMode:mode,sourceHash:before.sourceHash};
    const start=requests.length;
    if(mode==='adjust'&&!direct||aiRedraw){
      await act('prepareAIImageEdit',{...target,imageEditMode:mode,sourceHash:before.sourceHash,instruction:'主体向右移动',prompt:before.prompt});await wait();
      const input=requests.slice(start).find(r=>typeof r.messages?.at(-1)?.content==='string').messages.at(-1).content;
      if(target.targetType==='theme'&&mode==='redraw')assert.match(input,/主体描述用一个短语，通常10–25字/);
      if(mode==='adjust')assert.doesNotMatch(input,/主体描述用一个短语/,'局部编辑仍仅整理用户意见');
      const draft=p.aiImageEditDrafts[before.key];request={...request,...(mode==='adjust'?{instruction:draft.instruction,adjustmentRevision:draft.revision,...(target.targetType==='theme'?{prompt:before.prompt}:{})}:{prompt:draft.prompt})};
    }else if(mode==='adjust')request.instruction='  主体向右移动，标题不变。\n保留其他内容。  ';
    else request.prompt='  用户最终完整重绘稿：分子修饰主题，16:9。\n保留用户空格。  ';
    const drawStart=requests.length;badRatio=ratioRepair;detections=0;
    const {action,...extra}=request;await act(action,extra);await wait();badRatio=false;
    const draws=requests.slice(drawStart).filter(r=>r.prompt);assert.ok(draws.length>=1);const draw=draws[0];
    if(mode==='adjust'){
      assert.equal(draw.prompt.replace(/\r\n/g,'\n'),request.instruction);assert.ok(draw.endpoint.endsWith('/images/edits'));assert.equal(draw.referenceImages.length,1);
      assert.equal(draw.referenceImages[0].sha256,digest(fs.readFileSync(path.join(data,p.id,before.sourceFile))));
      const organize=requests.slice(start,drawStart).find(r=>r.messages);if(direct)assert.equal(organize,undefined,'直接提交不调用主模型整理');else assert.ok(!JSON.stringify(organize.messages.at(-1).content).includes(before.prompt),'局部调整不发送完整旧设计');
    }else{if(aiRedraw&&target.targetType==='visual'){const rewrite=requests.slice(start,drawStart).find(r=>r.messages).messages.at(-1).content;assert.match(rewrite,/多层 Markdown 列表/);assert.match(rewrite,/当前内容关系/);assert.match(rewrite,/适合时积极优先采用/);assert.match(rewrite,/用户要求重新设计排版时/);assert.match(rewrite,/\n  - 标题：已修改标题\n    - 图片：配图/);}assert.equal(draw.prompt,request.prompt);assert.ok(draw.endpoint.endsWith('/images/generations'));assert.equal(draw.referenceImages,undefined);}
    if(ratioRepair){assert.equal(draws.length,2);assert.ok(draws[1].endpoint.endsWith('/images/edits'));assert.equal(draws[1].referenceImages.length,1);assert.ok(!draws[1].prompt.includes(request.prompt));}
    if(target.targetType!=='image'){
      const after=structuredClone(aiImageTarget(p,target).image),count=requests.length;
      const restore=async(direction,record=aiImageTarget(p,target).image)=>{await act('restoreAIImage',{...target,sourceHash:record.previewHash,sourceRevision:record.jobFile||record.file,direction});p=await call(prefix);};
      assert.ok(after.editHistory.past.length);
      await act('restoreAIImage',{...target,sourceHash:after.previewHash,sourceRevision:before.image.jobFile,direction:'undo'},400);
      await restore('undo');const restored=aiImageTarget(p,target).image;assert.equal(restored.file,before.image.file);assert.equal(restored.prompt,before.image.prompt);assert.deepEqual(restored.images,before.image.images);assert.deepEqual(restored.previewReview,before.image.previewReview);
      assert.equal(p.approvals.preview,null);assert.equal(p.output,null);assert.equal(p.reconstruction,null);assert.equal(p.candidate,null);
      await restore('redo');assert.equal(aiImageTarget(p,target).image.file,after.file);assert.equal(aiImageTarget(p,target).image.prompt,after.prompt);assert.equal(requests.length,count,'撤回/重做不调用任何模型');
      const saved=JSON.parse(fs.readFileSync(path.join(data,p.id,'project.json')));assert.ok(aiImageTarget(saved,target).image.editHistory.past.length,'历史记录保存到项目');
    }
    return p;
  };
  await runMode({targetType:'theme',theme:'a',use:'hero-image'},'adjust');
  await runMode({targetType:'theme',theme:'a',use:'hero-image'},'adjust',{direct:true});
  await runMode({targetType:'theme',theme:'a',use:'hero-image'},'redraw',{aiRedraw:true});
  await act('image',{index:0,prompt:'分子修饰主题概念插画，无文字',allowUpload:true});await wait();let sourceImageId=p.task.resultImageId;
  await runMode({targetType:'image',sourceImageId},'adjust');sourceImageId=p.task.resultImageId;
  await runMode({targetType:'image',sourceImageId},'adjust',{direct:true});sourceImageId=p.task.resultImageId;
  await runMode({targetType:'image',sourceImageId},'redraw');
  // A factual original is pasted locally and never transmitted to the image endpoint.
  const image=p.materials.find(m=>m.id===p.task.resultImageId);p=await act('saveContent',{slides:[{...p.slides[0],imageId:image.id}],confirm:true});
  await act('confirmPageLayout',{index:0});await act('designPage',{index:0});await wait();await act('approvePageDesign',{index:0});
  await act('concepts');await wait();
  await runMode({targetType:'visual',kind:'concept',theme:'a',index:0},'adjust');
  await runMode({targetType:'visual',kind:'concept',theme:'a',index:0},'adjust',{direct:true});
  await runMode({targetType:'visual',kind:'concept',theme:'a',index:0},'redraw',{aiRedraw:true});
  await act('selectTheme',{id:'a'});await act('generateFullPreview');await wait();
  await runMode({targetType:'visual',kind:'full',index:0},'adjust');
  await runMode({targetType:'visual',kind:'full',index:0},'adjust',{direct:true});
  await runMode({targetType:'visual',kind:'full',index:0},'redraw',{ratioRepair:true});
  assert.equal(p.visualPages[0].placeholderReview.attempts,1);assert.equal(p.visualPages[0].placeholderReview.status,'passed');assert.equal(p.visualPages[0].images[0].id,image.id);assert.equal(p.visualPages[0].imageEditMode,'redraw');
  const since=requests.length;await act('generateFullPreview',{index:0,imageEditMode:'adjust',sourceHash:'stale',adjustmentRevision:1,instruction:'invalid'},400);assert.equal(requests.length,since);
});
