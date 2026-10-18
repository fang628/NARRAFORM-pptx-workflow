import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {Resvg} from '@resvg/resvg-js';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';
import {auditedElements,completeAuditEntries} from '../lib/visual-audit-repair.mjs';
import {canonicalTexts} from '../lib/visual-model.mjs';
import {digest} from '../lib/visual-model.mjs';
import {repairRebuiltPage} from '../lib/rebuild-tools.mjs';
import {rebuildAssetInventory,rebuildAssetImage} from '../lib/rebuild-output.mjs';
import {visualDelivery} from '../public/visual-ui.js';

test('审计多次失败仍带回独立有效元素，后续传输失败也不丢前次结果',async()=>{
  const slide={title:'标题',body:['正文'],sources:[]},texts=canonicalTexts(slide).map((n,i)=>({...n,key:n.nodeId,type:'text',x:50,y:100+i*100,w:800,h:60,size:30,color:'272727'}));
  const raw={elements:[texts[0],{key:'carrier',type:'rect',x:1000,y:600,w:200,h:100,fill:'eee'}]};
  await assert.rejects(auditedElements({slide,images:[],request:async()=>({text:JSON.stringify(raw)})}),error=>error.partialAudit.length===2&&error.partialAudit[0].text==='标题'&&error.auditValidation.attempts===2);
  let calls=0;await assert.rejects(auditedElements({slide,images:[],request:async()=>{if(calls++)throw Error('请求失败');return {text:JSON.stringify(raw)};}}),error=>error.partialAudit.length===2&&error.message==='请求失败');
  const truncated=JSON.stringify(raw).slice(0,-2)+',{"key":"unfinished"';
  assert.equal(completeAuditEntries(truncated).length,2);
  await assert.rejects(auditedElements({slide,images:[],request:async()=>({text:truncated})}),error=>error.partialAudit.length===2&&error.auditValidation.status==='partial');
});

test('工具成功生成素材后模型请求失败，仍展示素材快照且不假装整页修改已通过',async()=>{
  const data=fs.mkdtempSync(path.resolve('work','rebuild-tool-partial-')),dir=path.join(data,'p','assets');fs.mkdirSync(dir,{recursive:true});
  const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M5 5L55 30L5 55Z" fill="#123456"/></svg>';fs.writeFileSync(path.join(dir,'new.svg'),svg);
  const slide={title:'标题',body:[],sources:[]},elements=[{key:'title',type:'text',nodeId:'title',text:'标题',x:50,y:80,w:800,h:60,size:30,color:'272727'}],p={id:'p',version:1,concepts:[],brief:{progress:false},slides:[slide],materials:[],visualPages:[{images:[]}],reconstruction:{slides:[{elements}],assets:[]}};
  let turns=0;
  await assert.rejects(repairRebuiltPage({p,index:0,round:1,review:{issues:[]},env:{data,save:()=>{},credentials:new Map([['p',{text:{key:'fixture',model:'main'}}]])},reference:'ref',rendered:'render',background:'bg',createAsset:async()=>({id:'new',file:'new.svg',svg:true,kind:'image',reconstructed:true,sha256:digest(svg)}),renderScene:async()=>'',record:()=>{},requestModel:async()=>{
    if(turns++)throw Error('后续模型请求失败');return {choices:[{message:{tool_calls:[{id:'create',type:'function',function:{name:'create_visual_asset',arguments:JSON.stringify({method:'svg',key:'new-icon',x:1100,y:700,w:60,h:60,svg})}}]}}]};
  }}),/后续模型请求失败/);
  assert.equal(p.rebuildAssetPreview.status,'partial');assert.equal(p.materials.length,1);assert.equal(p.reconstruction.slides[0].elements.length,1,'未通过的整页修改不提交为成功');
  assert(rebuildAssetInventory(p)[0].elements.some(e=>e.key==='new-icon'));assert(rebuildAssetImage(p,{data},0,'new-icon').length>100);
});

test('05故障模拟：审计耗尽、抠图不透明、接口连续失败均保留元素及最后图片，重试复用成功素材',async t=>{
  let faulty=true,imageFailures=0;const auditCalls=new Map();
  // Neutral backgrounds can now be recovered safely by cutout_alpha.py. Use a
  // colored, ambiguous matte to exercise the real unrecoverable-alpha branch.
  const opaque=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#b96d87"/><circle cx="100" cy="100" r="60" fill="#fff238"/></svg>').render().asPng();
  const mock=http.createServer(async(req,res)=>{
    try{
      const b=await fixtureRequest(req),content=b.messages?.at(-1)?.content,prompt=typeof content==='string'?content:content?.[0]?.text||'';let reply=fixtureReply(b);
      if(faulty&&b.prompt?.includes('ALPHA_FAILURE'))reply={data:[{b64_json:opaque.toString('base64')}]};
      if(faulty&&b.prompt?.includes('IMAGE_FAILURE')){imageFailures++;reply={data:[]};}
      if(prompt.startsWith('自由元素审计：')||prompt.startsWith('修正当前页的元素审计JSON')){
        const raw=JSON.parse(reply.choices[0].message.content),page=raw.elements.find(e=>e.nodeId==='title').text;
        auditCalls.set(page,(auditCalls.get(page)||0)+1);
        raw.elements.push({key:'native-carrier',type:'rect',x:50,y:600,w:500,h:100,fill:'eee'});
        if(faulty&&page==='01 测试页')raw.elements=raw.elements.filter(e=>e.nodeId!=='body-0');
        if(faulty&&page==='02 测试页'){
          raw.elements.push(...['ALPHA_FAILURE','IMAGE_FAILURE'].map((label,i)=>({key:'failed-'+i,type:'cutout',x:1100+i*200,y:750,w:100,h:100,sourceBox:{x:1100+i*200,y:750,w:100,h:100},prompt:label+' 保留局部装饰主体，移除背景输出透明图片',nonFactual:true,description:label})));
          raw.elements.push({key:'after-error-icon',type:'svg',x:900,y:700,w:60,h:60,svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M5 5L55 30L5 55Z" fill="#123456"/></svg>'});
        }
        reply.choices[0].message.content=JSON.stringify(raw);
      }
      res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
    }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=fs.mkdtempSync(path.resolve('work','rebuild-partial-')),base='http://127.0.0.1:'+port;
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:data},stdio:'ignore',windowsHide:true});t.after(()=>app.kill());
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;};
  let p=await call('/api/projects',{brief:{title:'分子修饰',pages:2,cover:false,toc:false,progress:false}},201);const prefix='/api/projects/'+p.id,act=(action,extra={})=>call(prefix+'/action',{action,...extra});
  const wait=async(expected='done')=>{for(let i=0;i<1800;i++){p=await call(prefix);if(p.task?.status!=='running'){assert.equal(p.task?.status,expected,p.task?.message);return;}await new Promise(r=>setTimeout(r,30));}throw Error('任务超时');};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'synthetic',key:'fixture'};
  await act('configure',{text:cfg,image:cfg,elementImage:cfg});p=await call(prefix+'/materials',{name:'材料.txt',base64:Buffer.from('分子修饰研究。').toString('base64')});
  await act('requirements',{brief:p.brief});await act('analyzeMaterials');await wait();await act('approveAnalysis');
  await act('saveContent',{slides:['01 测试页','02 测试页'].map(title=>({kind:'content',title,body:['准确正文'],sources:[]}))});await act('approveContent');
  for(let i=0;i<2;i++){await act('confirmPageLayout',{index:i});await act('designPage',{index:i});await wait();await act('approvePageDesign',{index:i});}
  await act('generateThemeAssets');await wait();await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts});await wait();
  await act('concepts');await wait();await act('selectTheme',{id:'a'});await act('generateFullPreview');await wait();
  await act('approvePreview',{confirmAllPages:true,acceptIssues:true,approvalStamp:p.previewApprovalState.stamp});
  await act('reconstructPreview');await wait('failed');
  assert.equal(auditCalls.get('01 测试页'),3);assert.ok(imageFailures>=2);assert.equal(p.rebuildAssetPreview.status,'partial');assert.equal(p.rebuildAssets.length,2);assert.equal(p.visualReconstructionCurrent,false);
  assert(p.rebuildAssets.every(page=>page.elements.some(e=>e.key==='content-icon')));assert(p.rebuildAssets[0].textStyles.some(e=>e.text==='01 测试页'));
  assert(p.rebuildAssets[1].elements.some(e=>e.key==='after-error-icon'));assert.equal(p.rebuildAssets[1].failedElements.length,2);assert(p.rebuildAssets[1].elements.find(e=>e.key==='failed-0').needsAttention);
  for(const [index,key] of [[0,'content-icon'],[0,'native-carrier'],[1,'failed-0'],[1,'after-error-icon']]){const r=await fetch(base+prefix+'/rebuild-asset-image?index='+index+'&key='+key);assert.equal(r.status,200,key);assert((await r.arrayBuffer()).byteLength>100);}
  const html=visualDelivery(p,()=>'',()=>{},(_a,_b,_c,actions)=>actions);assert.match(html,/部分元素已保留/);assert.match(html,/待调整/);assert.match(html,/未完成 · 已保留其他元素/);assert.match(html,/data-action="reconstructPreview"/);
  const saved=JSON.parse(fs.readFileSync(path.join(data,p.id,'project.json'),'utf8'));assert.equal(saved.rebuildAssetPreview.status,'partial');assert(saved.materials.some(m=>m.failedCandidate));
  const id=p.rebuildAssets[0].elements.find(e=>e.key==='content-icon').id;
  assert.equal(p.rebuildPageRetryEnabled,true);assert.match(html,/data-retry-rebuild-page="0"/);
  const otherFailed=structuredClone(p.rebuildAssetPreview.pages[1]),otherReads=auditCalls.get('02 测试页'),oldImages=imageFailures;
  await act('retryRebuildPage',{index:0});await wait('failed');
  assert.equal(auditCalls.get('02 测试页'),otherReads);assert.equal(imageFailures,oldImages);assert.deepEqual(p.rebuildAssetPreview.pages[1],otherFailed);assert(p.rebuildAssets[0].elements.some(e=>e.id===id),'失败重试不清空已有素材');
  faulty=false;await act('retryRebuildPage',{index:0});await wait();
  assert.equal(p.visualReconstructionCurrent,false);assert.match(p.task.message,/其余 1 页/);assert.deepEqual(p.rebuildAssetPreview.pages[1],otherFailed);assert.equal(auditCalls.get('02 测试页'),otherReads);
  const recoveredFirst=structuredClone(p.rebuildAssetPreview.pages[0]),firstReads=auditCalls.get('01 测试页');
  await act('retryRebuildPage',{index:1});await wait();
  assert.equal(p.visualReconstructionCurrent,true);assert.equal(p.rebuildAssetPreview.status,'done');assert.deepEqual(p.rebuildAssetPreview.pages[0],recoveredFirst);assert.equal(auditCalls.get('01 测试页'),firstReads);assert.equal(p.reconstruction.slides[0].elements.find(e=>e.key==='content-icon').id,id);assert.equal(p.reconstruction.slides[1].elements.find(e=>e.key==='content-icon').id,id);
  const completedFirst=structuredClone(p.reconstruction.slides[0]);await act('retryRebuildPage',{index:1});await wait();assert.deepEqual(p.reconstruction.slides[0],completedFirst);assert.equal(auditCalls.get('01 测试页'),firstReads);assert(p.rebuildUndo.pages[1].available);
  const beforeBuild=Object.fromEntries(auditCalls);await act('build');await wait();assert.deepEqual(Object.fromEntries(auditCalls),beforeBuild,'构建直接使用重试后的完整拆解，不重新请求其他页');assert.equal(p.candidate.structure.passed,true);
  for(const index of [-1,2,null,'0'])await call(prefix+'/action',{action:'retryRebuildPage',index},400);
  assert.equal(new Set(p.materials.map(m=>m.id)).size,p.materials.length);
});
