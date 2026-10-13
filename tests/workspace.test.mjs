import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import JSZip from 'jszip';
import {themes,scene} from '../lib/scene.mjs';
import {initialElements} from '../lib/elements.mjs';
import {pageDesignStamp,validatePageDesign} from '../lib/page-design.mjs';
import {validateReconstruction} from '../lib/reconstruction.mjs';
import {bindSources} from '../lib/sources.mjs';
function blankPDF(){const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>','<< /Length 0 >>\nstream\n\nendstream'];let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});const offset=Buffer.byteLength(pdf);pdf+='xref\n0 5\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n'+offset+'\n%%EOF';return Buffer.from(pdf);}
test('OCR 核对、分通道联通测试、单页设计稿及失效闸门',async t=>{
  let revisionPrompt=null,badDesign=false,badRebuild=false,sawRebuildImage=false,ocrCalls=0,designCalls=0,rebuildCalls=0;
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  const mock=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw),user=b.messages?.at(-1).content,prompt=Array.isArray(user)?user[0].text:user;let result;
    res.setHeader('content-type','application/json');if(b.model==='fail-model'){res.statusCode=401;res.end('{}');return;}if(req.url.endsWith('images/generations')){res.end(JSON.stringify({data:[{b64_json:png}]}));return;}
    if(prompt.includes('逐字识别这张材料')){assert.equal(b.model,'text-model');assert.ok(user[1].image_url.url.startsWith('data:image/png;base64,'));ocrCalls++;result={text:'扫描材料：先理解材料，再生成内容。'};}
    else if(prompt.includes('按照 pptx-workflow 1.3')){
      if(prompt.includes('用户修改意见：'))revisionPrompt=prompt;designCalls++;const nodes=JSON.parse(prompt.split('已有节点：')[1].split('\n使用的材料：')[0]);
      result={purpose:'解释内容生产流程',conclusion:'先理解材料再设计',logic:'承接材料输入，进入制作',layoutIntent:'小标题统领正文与图片，按树顺序阅读',style:'浅底深字，小标题 24pt，正文 18pt，亮黄强调，原生文本无框',readingOrder:nodes.map(n=>n.id),nodes:nodes.map(n=>({id:n.id,position:n.type==='image'?'右侧':'左侧',relativeSize:'中等',alignment:'左对齐',carrier:'无框直接排布',relation:n.parentId?'附属到 '+n.parentId:'顶层并列'})),differences:'减少装饰，保留材料原图',missingMaterials:[]};if(prompt.includes('用户修改意见：'))result.layoutIntent='图片放大并置于右侧，左侧突出核心结论';if(badDesign)result.nodes.pop();
    }else if(prompt.includes('原始清单：')){
      rebuildCalls++;assert.equal(b.model,'rebuild-model');sawRebuildImage=user[1].image_url.url.startsWith('data:image/png;base64,');
      result={elements:JSON.parse(prompt.split('原始清单：')[1].split('\n已确认内容关系：')[0])};const text=result.elements.find(e=>e.type==='text');text.color='123456';if(badRebuild)text.text='篡改准确文字';
    }else if(prompt.includes('concepts:'))result={concepts:themes};else{res.end(JSON.stringify({choices:[{message:{content:'连接成功'}}]}));return;}
    result.executionSummary='已核对输入内容与来源，按页面关系生成初稿。';
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const dir=path.resolve('work','workspace-test-'+Date.now()),port=4364,base='http://127.0.0.1:'+port;
  const app=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:dir},stdio:'ignore',windowsHide:true});t.after(()=>{app.kill();mock.close();});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;};
  let p=await call('/api/projects',{brief:{title:'新流程测试',pages:3}},201);const prefix='/api/projects/'+p.id,act=(action,extra={},status=200)=>call(prefix+'/action',{action,...extra},status);
  const wait=async()=>{for(let i=0;i<500;i++){p=await call(prefix);if(p.task?.status!=='running')return p;await new Promise(r=>setTimeout(r,25));}throw Error('任务超时');};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic-secret',model:'text-model'};
  p=await act('configure',{text:cfg,image:{...cfg,model:'image-model'},ocr:{...cfg,model:'ocr-model'},rebuild:{...cfg,model:'rebuild-model'}});assert.equal(p.ocrReady,true);assert.equal(p.provider.ocr,undefined);assert.equal(p.rebuildReady,true);assert.ok(!JSON.stringify(p).includes('synthetic-secret'));
  // Saving new optional settings must preserve existing in-memory credentials.
  await act('configure',{text:{...cfg,key:''},ocr:{...cfg,key:'',model:'ocr-model'},rebuild:{...cfg,key:'',model:'rebuild-model'}});
  for(const type of ['text','ocr','rebuild','image']){await act('testAPI',{type});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.apiTests[type].ok,true);if(type==='ocr')assert.equal(p.apiTests.ocr.model,'text-model');}
  await act('configure',{rebuild:{...cfg,model:'fail-model'}});await act('testAPI',{type:'rebuild'});p=await wait();assert.equal(p.task.status,'failed');assert.equal(p.apiTests.rebuild.ok,false);assert.match(p.apiTests.rebuild.message,/401/);await act('configure',{rebuild:{...cfg,model:'rebuild-model'}});
  p=await act('configure',{rebuild:null});assert.equal(p.rebuildReady,true);assert.equal(p.rebuildConfigured,false);assert.equal(p.rebuildSource,'text');assert.equal(p.rebuildModel,'text-model');
  await act('testAPI',{type:'rebuild'});p=await wait();assert.equal(p.task.status,'done');assert.equal(p.apiTests.rebuild.model,'text-model');assert.match(p.apiTests.rebuild.message,/主模型/);
  p=await act('configure',{rebuild:{...cfg,model:'rebuild-model'}});assert.equal(p.rebuildConfigured,true);assert.equal(p.rebuildSource,'rebuild');assert.equal(p.rebuildModel,'rebuild-model');
  p=await call(prefix+'/materials',{name:'scan.png',base64:png});const imageId=p.materials[0].id;await act('ocrMaterial',{id:imageId});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.materials[0].text,undefined);assert.equal(p.materials[0].ocr.approvedAt,null);assert.equal(p.materials[0].ocr.model,'text-model');
  assert.ok(p.task.finishedAt);assert.ok(p.task.progress.some(e=>e.kind==='request'&&e.status==='done'));assert.ok(p.task.progress.some(e=>e.kind==='summary'));assert.equal(p.task.progress.at(-1).kind,'result');
  p=await act('acceptOCR',{id:imageId,text:'扫描材料：先理解材料，再生成内容。'});assert.match(p.materials[0].text,/先理解/);assert.ok(p.materials[0].ocr.approvedAt);
  const sourceSlide={title:'流程',body:['先理解材料，再生成内容。'],sources:[imageId],sourceLinks:[{materialId:imageId,target:'body:0',quote:'先理解材料，再生成内容。',note:'OCR 原文'}]};bindSources(p,[sourceSlide]);assert.equal(sourceSlide.sourceLinks[0].location.line,1);
  p=await call(prefix+'/materials',{name:'scan.pdf',base64:blankPDF().toString('base64')});const pdfId=p.materials.at(-1).id;assert.equal(p.materials.at(-1).needsOCR,true);await act('ocrMaterial',{id:pdfId});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.match(p.materials.at(-1).ocr.text,/\[第 1 页\]/);assert.equal(ocrCalls,2);
  await act('requirements',{brief:p.brief});
  const elements=[{id:'title',type:'text',role:'title',text:'材料到内容',label:'标题',parentId:null},{id:'group',type:'group',label:'先理解，再设计',layout:'row',parentId:null},{id:'body',type:'text',role:'body',text:'先理解材料，再生成内容。',label:'正文',parentId:'group'},{id:'image',type:'image',label:'材料图片',materialId:imageId,parentId:'group'}];
  p=await act('saveContent',{slides:[{title:'材料到内容',body:[],sources:[imageId],elements,sourceLinks:[{materialId:imageId,target:'element:body',quote:'先理解材料，再生成内容。',note:'核对后的 OCR 文字'}]}]});
  assert.equal(p.slides[0].elements.find(n=>n.id==='group').text,'先理解，再设计');assert.ok(scene(p.slides[0],themes[0],0,1,{}).some(e=>e.text==='先理解，再设计'));
  await act('approvePageDesign',{index:0},400);p=await act('confirmPageLayout',{index:0});assert.equal(p.pageDesigns[0].layoutCurrent,true);
  badDesign=true;await act('designPage',{index:0});p=await wait();assert.equal(p.task.status,'failed');assert.equal(p.pageDesigns[0].markdown,undefined);badDesign=false;
  await act('designPage',{index:0});p=await wait();assert.equal(p.task.status,'done',p.task.message);const d=p.pageDesigns[0];assert.match(d.markdown,/嵌套排版树/);assert.match(d.markdown,/\*\*先理解，再设计\*\*/);assert.match(d.markdown,/原材料对应索引/);assert.equal(d.current,true);assert.equal(designCalls,2);
  assert.throws(()=>validatePageDesign({...d.plan,readingOrder:[...d.plan.readingOrder].reverse()},initialElements(p.slides[0])),/顺序/);
  const download=await fetch(base+prefix+'/page-design?index=0');assert.equal(download.status,200);assert.match(await download.text(),/图片意图/);
  await act('savePageDesign',{index:0,markdown:d.markdown.replace('**先理解，再设计**','**篡改内容**')},400);
  p=await act('savePageDesign',{index:0,markdown:d.markdown+'\n优先使用亮黄色强调。\n'});p=await act('approvePageDesign',{index:0});assert.equal(p.pageDesigns[0].approvedCurrent,true);
  const previous=structuredClone(p.pageDesigns[0]),tree=JSON.stringify(p.slides[0].elements);
  await act('revisePageDesign',{index:0,instruction:''},400);await act('revisePageDesign',{index:0,instruction:'x'.repeat(3001)},400);
  badDesign=true;await act('revisePageDesign',{index:0,instruction:'图片放大并移到右侧'});p=await wait();assert.equal(p.task.status,'failed');assert.equal(p.pageDesigns[0].markdown,previous.markdown);assert.equal(p.pageDesigns[0].approvedCurrent,true);badDesign=false;
  await act('revisePageDesign',{index:0,instruction:'图片放大并移到右侧',markdown:previous.markdown});p=await wait();assert.equal(p.task.status,'done',p.task.message);
  assert.match(revisionPrompt,/图片放大并移到右侧/);assert.ok(revisionPrompt.includes(JSON.stringify(previous.markdown)));assert.match(p.pageDesigns[0].markdown,/图片放大并置于右侧/);
  assert.equal(p.pageDesigns[0].approvedCurrent,false);assert.equal(p.pageDesigns[0].origin,'ai-revision');assert.equal(JSON.stringify(p.slides[0].elements),tree);
  const stamp=pageDesignStamp(p,0),slides=structuredClone(p.slides);slides[0].notes='更新备注';p=await act('saveContent',{slides});assert.notEqual(pageDesignStamp(p,0),stamp);assert.equal(p.pageDesigns[0].current,false);assert.equal(p.pageDesigns[0].layoutCurrent,false);await act('approvePageDesign',{index:0},400);
  await act('approveContent');await act('concepts',{},400);await act('build',{},400);await call(prefix+'/download',undefined,400);
  const saved=fs.readFileSync(path.join(dir,p.id,'project.json'),'utf8');assert.ok(!saved.includes('synthetic-secret'));
});
