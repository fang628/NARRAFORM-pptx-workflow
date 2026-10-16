import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {validateFigureRegions,materialImageAction} from '../lib/material-images.mjs';
import {validateElements,initialElements,moveElementBranch,elementLevelTarget,orderedElements} from '../lib/elements.mjs';
import {originalMaterialCount,extractAllImagesButton} from '../public/material-images.js';
import {materialPanel} from '../public/materials.js';
const python=path.resolve('.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const fixture=path.resolve('work','material-images-test-'+Date.now());
execFileSync(python,['tests/material-image-fixture.py',fixture],{windowsHide:true});
const extract=(...args)=>JSON.parse(execFileSync(python,['tools/extract_images.py',...args],{windowsHide:true,encoding:'utf8'}));

test('一键提取复用文档提取流程，保留来源、去重，单份失败不影响其他文档',async()=>{
  const data=path.join(fixture,'batch'),id='batch-project',assets=path.join(data,id,'assets');fs.mkdirSync(assets,{recursive:true});
  const materials=['pdf','docx','pptx'].map(ext=>{fs.copyFileSync(path.join(fixture,'source.'+ext),path.join(assets,'source.'+ext));return {id:ext,name:'材料.'+ext,file:'source.'+ext,sha256:'source-'+ext,kind:'document'};});
  fs.writeFileSync(path.join(assets,'broken.pdf'),'not a pdf');materials.push({id:'broken',name:'损坏.pdf',file:'broken.pdf',kind:'document'});
  const p={id,materials,analysis:{old:true},task:{status:'running'}};let worker;
  const env={root:process.cwd(),data,run:promisify(execFile),credentials:new Map(),ensure:(_p,ok,message)=>{if(!ok)throw Error(message);},save(){},launch(_p,_label,fn){worker=fn;}};
  assert.equal(await materialImageAction(p,{action:'extractAllMaterialImages'},env),true);
  await worker(new AbortController().signal);
  assert.equal(p.task.imageExtractionBatch.completed,3);assert.equal(p.task.imageExtractionBatch.failures.length,1);assert.equal(p.task.imageExtractionBatch.added,3);
  assert.deepEqual(p.materials.filter(m=>m.extracted).map(m=>m.sourceMaterialId),['pdf','docx','pptx']);assert.equal(p.task.resultImageIds.length,3);assert.equal(p.analysis,null);
  await materialImageAction(p,{action:'extractAllMaterialImages'},env);await worker(new AbortController().signal);
  assert.equal(p.task.imageExtractionBatch.added,0);assert.equal(p.task.imageExtractionBatch.duplicates,3);assert.equal(p.materials.filter(m=>m.extracted).length,3);
  assert.match(materialPanel(p,()=>'',[],'',null),/data-extract-all-images disabled/);
  assert.equal(extractAllImagesButton({materials:materials.map(m=>({...m,generated:true}))}), '');
  assert.equal(extractAllImagesButton({materials:materials.map(m=>({...m,extracted:true}))}), '');
  assert.equal(extractAllImagesButton({materials:materials.map(m=>({...m,reconstructed:true}))}), '');
});

test('主副标题独立成族，副标题可删除且不进入正文并列或拖动',async()=>{
  const s={title:'主标题',subtitle:'副标题附文',body:['正文甲','正文乙'],sources:[],sourceLinks:[]},nodes=validateElements(initialElements(s));
  assert.deepEqual(orderedElements(nodes).map(n=>n.id),['title','subtitle','body-0','body-1']);assert.equal(nodes[1].parentId,'title');
  assert.throws(()=>moveElementBranch(nodes,'subtitle','body-0','after'),/不参与内容排序/);
  assert.throws(()=>moveElementBranch(nodes,'body-0','subtitle','after'),/不参与内容并列/);
  assert.throws(()=>elementLevelTarget(nodes,'body-0','right'),/前方没有/);
  assert.throws(()=>validateElements([...nodes,{...nodes[1],id:'second-subtitle'}]),/至多一个/);
  const source=fs.readFileSync('public/element-editor.js','utf8').replace("'/elements-model.js'",JSON.stringify(pathToFileURL(path.resolve('lib/elements.mjs')).href)).replace("'./provenance.js'",JSON.stringify(pathToFileURL(path.resolve('public/provenance.js')).href));
  const {elementEditor,mutateElements}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const html=elementEditor({id:'test',materials:[]},s,0);assert.match(html,/class="tree-subtitle-branch"/);assert.match(html,/并列 · 02/);assert.doesNotMatch(html,/并列 · 03/);
  const subtitle=html.slice(html.indexOf('data-node="subtitle"'),html.indexOf('data-tree-children="subtitle"'));assert.match(subtitle,/data-element-action="remove"/);assert.match(subtitle,/data-tree-drag="subtitle" disabled/);assert.doesNotMatch(subtitle,/data-element-action="up"/);
  const edited=mutateElements({...s,elements:nodes},'remove','subtitle');assert.equal(edited.subtitle,'');assert.equal(edited.elements.some(n=>n.role==='subtitle'),false);assert.equal(edited.title,'主标题');
  const emptyHTML=elementEditor({id:'test',materials:[]},edited,0);assert.match(emptyHTML,/data-element-action="subtitle"/);assert.doesNotMatch(html,/data-element-action="subtitle"/);
  const restored=mutateElements(edited,'subtitle'),added=restored.elements.find(n=>n.role==='subtitle');assert.equal(added.parentId,'title');assert.equal(restored.subtitle,'输入副标题');assert.equal(validateElements(restored.elements).filter(n=>n.role==='subtitle').length,1);assert.equal(orderedElements(restored.elements)[1].id,added.id);assert.throws(()=>mutateElements(restored,'subtitle'),/至多一个/);assert.match(elementEditor({id:'test',materials:[]},restored,0),/class="subtitle-circuit"/);
});
test('文档原图提取：PDF 多页追溯、Word 部件、PPTX 页码和无损裁片',()=>{
  for(const ext of ['pdf','docx','pptx']){
    const result=extract('embedded',path.join(fixture,'source.'+ext),path.join(fixture,ext));assert.equal(result.images.length,1,JSON.stringify(result));const im=result.images[0];assert.equal(im.width,200);assert.equal(im.height,100);
    if(ext==='pdf')assert.deepEqual(im.locations.map(l=>l.page),[1,2]);
    if(ext==='docx'){assert.equal(im.locations[0].part,'word/document.xml');assert.equal(im.locations[0].page,undefined);}
    if(ext==='pptx')assert.equal(im.locations[0].page,1);
  }
  const spec=path.join(fixture,'regions.json');fs.writeFileSync(spec,JSON.stringify([{label:'右侧原图',page:1,box:{x:500,y:0,w:500,h:1000}}]));const crop=extract('crop',path.join(fixture,'source.png'),path.join(fixture,'crop'),spec);
  assert.equal(crop.images[0].width,100);assert.equal(crop.images[0].height,100);
  execFileSync(python,['-c','from PIL import Image;import sys;im=Image.open(sys.argv[1]);assert im.getpixel((50,50))==(53,53,53,255)',path.join(fixture,'crop',crop.images[0].file)],{windowsHide:true});
  assert.equal(originalMaterialCount({materials:[{}, {extracted:true},{reconstructed:true}]}),1);
});
test('区域检测仅接受有限的原图内部坐标',()=>{
  assert.deepEqual(validateFigureRegions([]),[]);assert.throws(()=>validateFigureRegions([{label:'图',box:{x:900,y:0,w:200,h:100}}]),/有效/);assert.throws(()=>validateFigureRegions([{label:'图',box:{x:NaN,y:0,w:100,h:100}}]),/有效/);
});
test('HTTP：分离图片插入内容树与原材料对应；AI 初次设计、失败重试和用户确认',async t=>{
  let designCalls=0,failOnce=true,sawRegion=false,initialPrompt='';
  const mock=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw),user=b.messages.at(-1).content,prompt=typeof user==='string'?user:user[0].text;let result;
    if(prompt.includes('识别材料页中可独立')){sawRegion=Array.isArray(user)&&user[1].image_url.url.startsWith('data:image/png;base64,');result={regions:[{label:'右半原图',box:{x:500,y:0,w:500,h:1000}}]};}
    else if(prompt.includes('输出 {slides:')){initialPrompt=prompt;result={slides:Array.from({length:3},(_,i)=>({kind:i?'content':'cover',title:'AI 初稿 '+i,subtitle:'附文 '+i,body:['第一项','第二项'],sources:[],elements:[{id:'title',type:'text',role:'title',label:'主标题',text:'AI 初稿 '+i,parentId:null},{id:'subtitle',type:'text',role:'subtitle',label:'副标题',text:'附文 '+i,parentId:'title'},{id:'group',type:'group',label:'两项安排',parentId:'title',layout:'row'},{id:'a',type:'text',role:'body',label:'第一项',text:'第一项',parentId:'group'},{id:'b',type:'text',role:'body',label:'第二项',text:'第二项',parentId:'group'}]}))};}
    else if(prompt.includes('按照 pptx-workflow 1.3')){
      designCalls++;const nodes=JSON.parse(prompt.split('已有节点：')[1].split('\n使用的材料：')[0]);result={purpose:'呈现安排',conclusion:'两项安排',logic:'标题到小标题再到两项正文',layoutIntent:'标题区与正文区分离，正文并列',style:'高可读性浅底深字',readingOrder:nodes.map(n=>n.id),nodes:nodes.map(n=>({id:n.id,position:'页面主要区域',relativeSize:'依据角色区分',alignment:'左对齐',carrier:'无框',relation:n.role==='subtitle'?'从属主标题':n.parentId?'附属于 '+n.parentId:'根项'})),differences:'内容决定分块',missingMaterials:[]};
      if(failOnce&&designCalls===2){result.nodes.pop();failOnce=false;}
    }else result={};res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const dir=path.join(fixture,'data'),port=4366,base='http://127.0.0.1:'+port;
  const app=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:dir},stdio:'ignore',windowsHide:true});t.after(()=>{app.kill();mock.close();});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;};
  let p=await call('/api/projects',{brief:{title:'分离图片测试',pages:3}},201),prefix='/api/projects/'+p.id;
  const act=(action,extra={},status=200)=>call(prefix+'/action',{action,...extra},status),wait=async()=>{for(let i=0;i<500;i++){p=await call(prefix);if(p.task?.status!=='running')return p;await new Promise(r=>setTimeout(r,25));}throw Error('任务超时');};
  p=await call(prefix+'/materials',{name:'材料.pdf',base64:fs.readFileSync(path.join(fixture,'source.pdf')).toString('base64')});const original=p.materials[0];await act('extractMaterialImages',{id:original.id});p=await wait();assert.equal(p.task.status,'done',p.task.message);const image=p.materials.find(m=>m.extracted);assert.ok(image);assert.equal(image.sourceMaterialHash,original.sha256);assert.deepEqual(image.sourceLocations.map(l=>l.page),[1,2]);
  await act('extractMaterialImages',{id:original.id});p=await wait();assert.equal(p.materials.length,2);assert.equal(p.materials[0].imageExtraction.duplicates,1);
  for(const ext of ['docx','pptx'])p=await call(prefix+'/materials',{name:'材料.'+ext,base64:fs.readFileSync(path.join(fixture,'source.'+ext)).toString('base64')});
  await act('extractAllMaterialImages');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.task.imageExtractionBatch.completed,3);assert.equal(p.task.imageExtractionBatch.added,2);assert.equal(p.task.imageExtractionBatch.duplicates,1);assert.equal(p.task.resultImageIds.length,2);
  p=await act('saveContent',{slides:[{title:'图片来源',body:[],sources:[],elements:[{id:'title',type:'text',role:'title',text:'图片来源'},{id:'photo',type:'image',label:'材料配图',materialId:image.id,parentId:'title'}]}]});assert.equal(p.slides[0].sourceLinks[0].materialId,image.id);assert.match(p.slides[0].sourceLinks[0].note,/材料.pdf/);assert.equal(p.slides[0].elements[1].parentId,'title');assert.ok((await fetch(base+prefix+'/assets/'+image.id)).ok);
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic-secret',model:'test-vision'};await act('configure',{text:cfg});p=await call(prefix+'/materials',{name:'scan.png',base64:fs.readFileSync(path.join(fixture,'source.png')).toString('base64')});const scan=p.materials.at(-1);await act('separateMaterialImages',{id:scan.id});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.ok(sawRegion);const crop=p.materials.at(-1);assert.equal(crop.width,100);assert.equal(crop.height,100);assert.equal(crop.sourceMaterialId,scan.id);assert.equal(crop.needsRegionReview,true);
  await act('removeMaterial',{id:original.id});p=await call(prefix);assert.equal(p.materials.some(m=>m.id===image.id),false);assert.equal(p.slides[0].elements.find(n=>n.id==='photo').materialId,null);assert.equal(p.slides[0].sourceLinks.length,0);
  p=await call('/api/projects',{brief:{title:'AI 初次设计测试',pages:3}},201);prefix='/api/projects/'+p.id;await act('configure',{text:cfg});await act('requirements',{brief:p.brief});await act('content');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.slides.length,3);assert.match(initialPrompt,/交付用户可直接修改的完整初稿/);assert.equal(p.initialDesign.completed.length,2);assert.equal(p.initialDesign.failed.length,1);assert.equal(p.pageDesigns[0].current,true);assert.equal(p.pageDesigns[0].approvedCurrent,false);assert.equal(p.pageDesigns[0].layoutCurrent,false);assert.equal(p.approvals.content,null);
  await act('draftPageDesigns');p=await wait();assert.equal(designCalls,4);assert.equal(p.initialDesign.failed.length,0);assert.equal(Object.keys(p.pageDesigns).length,3);assert.ok(Object.values(p.pageDesigns).every(d=>d.current&&!d.approvedCurrent));
  await act('approvePageDesign',{index:0});p=await call(prefix);assert.equal(p.pageDesigns[0].approvedCurrent,true);assert.equal(p.pageDesigns[0].layoutCurrent,true);assert.equal(p.pageDesigns[1].approvedCurrent,false);
  const slides=structuredClone(p.slides);slides[0].elements.find(n=>n.id==='subtitle').text='用户修改的副标题';p=await act('saveContent',{slides});assert.equal(p.pageDesigns[0].current,false);await act('approvePageDesign',{index:0},400);await act('draftPageDesigns');p=await wait();assert.equal(designCalls,5);assert.equal(p.slides[0].subtitle,'用户修改的副标题');assert.equal(p.pageDesigns[0].approvedCurrent,false);
});
