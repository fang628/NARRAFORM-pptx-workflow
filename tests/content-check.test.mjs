import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {validateSlides,scene,themes} from '../lib/scene.mjs';
import {checkContentPages,contentCheckState,contentLayoutAdvice} from '../lib/content-check.mjs';
import {pageDesignInputCheck,pageDesignPrompt} from '../lib/page-design.mjs';
import {fixtureReply} from './visual-fixture.mjs';

function dense(doc='doc',photo='photo'){
  const elements=[{id:'title',type:'text',role:'title',text:'第4页：多层图文内容',parentId:null}];
  for(let i=0;i<6;i++)elements.push({id:'group'+i,type:'group',label:'主题'+i,parentId:'title'},
    {id:'text'+i,type:'text',role:'body',text:'依据材料保留研究条件与结论，采用图文分区表达。'.repeat(3),parentId:'group'+i},
    {id:'image'+i,type:'image',label:'证据图'+i,materialId:photo,parentId:'text'+i});
  return {kind:'content',title:'第4页',body:[],elements,sources:[doc,photo],sourceLinks:elements.filter(n=>n.type==='text'&&n.role==='body').map(n=>({materialId:doc,target:'element:'+n.id,excerptId:'E0001'}))};
}

test('复杂内容结束检查保留所有文字、层级、原图，模板容量仅提示设计优化',()=>{
  const slides=validateSlides([dense()]),p={brief:{progress:true},slides},before=structuredClone(slides);
  assert.throws(()=>scene(slides[0],themes[0],0,1,p.brief),e=>e.code==='NATIVE_LAYOUT_CAPACITY');
  assert.deepEqual(checkContentPages(p),{pages:1,complex:1});assert.deepEqual(slides,before);
  assert.equal(contentCheckState(p,0).nativeEstimate,'needs-layout');assert.equal(contentCheckState(p,0).metrics.images,6);
  assert.match(contentLayoutAdvice(p,0),/保留.*准确文字.*全部登记配图/);
  p.materials=[];assert.ok(pageDesignInputCheck(p,0).warnings.some(w=>w.includes('优化图文分区')));
  const checkedAt=p.contentChecks[0].checkedAt;assert.match(pageDesignPrompt(p,0),/不把内容树直接纵向堆叠/);assert.equal(p.contentChecks[0].checkedAt,checkedAt,'设计开始仅读取结束检查记录');
});

test('普通内容正常记录；内容或需求改变不复用过期估计',()=>{
  const p={brief:{progress:true},slides:validateSlides([{kind:'content',title:'简短页面',body:['结论。']}])};
  checkContentPages(p);assert.equal(contentCheckState(p,0).nativeEstimate,'fits');assert.deepEqual(contentCheckState(p,0).warnings,[]);
  p.slides[0].body[0]='新结论。';assert.equal(contentCheckState(p,0),null);checkContentPages(p);assert.ok(contentCheckState(p,0));
  p.brief.progress=false;assert.equal(contentCheckState(p,0),null);
});

test('真实 HTTP：第4页模板溢出仍完成内容与设计，确认/修改/关系识别/生图均不中断',async t=>{
  let doc,photo,designPrompt='',generationCalls=0;
  const mock=http.createServer(async(req,res)=>{
    let bytes='';for await(const c of req)bytes+=c;const request=JSON.parse(bytes),prompt=request.messages?.at(-1)?.content;let result;
    if(prompt?.startsWith('根据材料写恰好')){generationCalls++;result={slides:[1,2,3].map(i=>({kind:'content',title:'第'+i+'页',body:['材料结论。'],sources:[doc],sourceLinks:[{materialId:doc,target:'body:0',excerptId:'E0001'}]})).concat(dense(doc,photo))};}
    else if(prompt?.startsWith('只修改这一页'))result={slide:dense(doc,photo)};
    else if(prompt?.startsWith('识别本页已有文本')){const nodes=JSON.parse(prompt.split('已有元素：')[1].split('\n图片资料：')[0]);result={relationships:nodes.map(n=>({id:n.id,parentId:n.parentId,layout:n.layout})),groups:[]};}
    if(prompt?.startsWith('按照 pptx-workflow')&&prompt.includes('第4页：'))designPrompt=prompt;
    res.end(JSON.stringify(result?{choices:[{message:{content:JSON.stringify(result)}}]}:fixtureReply(request)));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=path.resolve('work','content-check-api-'+Date.now()),base=`http://127.0.0.1:${port}`,app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:data,PPT_AGENT_TEST:'1'},windowsHide:true,stdio:'ignore'});
  t.after(()=>{app.kill();mock.closeAllConnections();mock.close();});for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const r=await fetch(base+url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;};
  let p=await call('/api/projects',{brief:{title:'结束检查回归',pages:4,cover:false}},201);const prefix='/api/projects/'+p.id,act=(action,extra={},status=200)=>call(prefix+'/action',{action,...extra},status);
  const wait=async()=>{for(let i=0;i<500;i++){p=await call(prefix);if(p.task?.status!=='running')return;await new Promise(r=>setTimeout(r,20));}throw Error('任务超时');};
  p=await call(prefix+'/materials',{name:'材料.txt',base64:Buffer.from('依据材料保留研究条件与结论。').toString('base64')});doc=p.materials[0].id;
  p=await call(prefix+'/materials',{name:'事实图.png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='});photo=p.materials.at(-1).id;
  const cfg={baseURL:`http://127.0.0.1:${mock.address().port}/v1`,key:'synthetic',model:'mock'};
  await act('configure',{text:cfg});await act('requirements',{brief:p.brief});await act('analyzeMaterials');await wait();assert.equal(p.task.status,'done',p.task.message);await act('approveAnalysis');
  await act('content');await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(generationCalls,1);assert.equal(p.slides.length,4);assert.equal(p.slides[3].elements.length,19);assert.equal(p.contentChecks[3].nativeEstimate,'needs-layout');
  assert.ok(p.task.progress.some(e=>e.message.includes('内容结构与来源检查已完成')));assert.match(designPrompt,/不代表实际 PPT 放不下/);assert.equal(Object.values(p.pageDesigns).filter(d=>d.current).length,4);
  const before=structuredClone(p.slides);p=await act('saveContent',{slides:p.slides,confirm:true});assert.deepEqual(p.slides,before);assert.equal(p.approvals.content,p.version);
  p=await act('approvePageDesign',{index:3});assert.equal(p.pageDesigns[3].approvedCurrent,true);
  await act('designPage',{index:3});await wait();assert.equal(p.task.status,'done',p.task.message);
  await act('revise',{index:3,instruction:'保留文案，优化页面组织'});await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.contentChecks[3].nativeEstimate,'needs-layout');
  await act('recognizeRelations',{index:3});await wait();assert.equal(p.task.status,'done',p.task.message);
  await act('configure',{image:cfg});await act('image',{index:3,elementId:'image0',prompt:'补充示意元素',allowUpload:true});await wait();assert.equal(p.task.status,'done',p.task.message);assert.ok(p.task.resultImageId);assert.equal(p.slides[3].elements.filter(n=>n.type==='image').length,6);assert.equal(contentCheckState(p,3).nativeEstimate,'needs-layout');
});
