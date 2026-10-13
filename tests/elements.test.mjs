import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import JSZip from 'jszip';
import {validateElements,initialElements,syncLegacy,orderedElements,moveElementBranch,elementLevelTarget,setImageCaption} from '../lib/elements.mjs';
import {canonicalTexts} from '../lib/visual-model.mjs';
import {buildDeck,validateSlides,scene,svg,themes} from '../lib/scene.mjs';
import {bindSources} from '../lib/sources.mjs';
const nodes=[{id:'title',type:'text',role:'title',text:'元素关系测试',label:'标题',parentId:null},{id:'group',type:'group',label:'并列内容',layout:'row',parentId:null},{id:'claim',type:'text',role:'body',text:'原文结论',label:'结论',parentId:'group'},{id:'detail',type:'text',role:'caption',text:'这是附属说明',label:'说明',parentId:'claim'},{id:'photo',type:'image',label:'原始配图',materialId:'photo-id',parentId:'group'},{id:'art',type:'image',label:'元素插画',materialId:null,parentId:'group'}];
test('图片图注：新增、编辑、清空、随图片移动及进入成品准确文案',()=>{
  const original=validateElements(nodes),snapshot=JSON.stringify(original);
  let edited=validateElements(setImageCaption(original,'photo','photo-caption','原始配图说明'));
  edited=setImageCaption(edited,'photo','photo-caption','修改后的图注');
  assert.equal(edited.filter(n=>n.id==='photo-caption').length,1);
  assert.ok(canonicalTexts({elements:edited}).some(n=>n.nodeId==='photo-caption'&&n.role==='caption'&&n.text==='修改后的图注'));
  edited=moveElementBranch(edited,'photo','claim','inside');assert.equal(edited.find(n=>n.id==='photo-caption').parentId,'photo');
  const cleared=setImageCaption([...edited,{id:'note',type:'text',role:'body',text:'保留的补充说明',parentId:'photo-caption'}],'photo','photo-caption','');
  assert.ok(!cleared.some(n=>n.id==='photo-caption'));assert.equal(cleared.find(n=>n.id==='note').parentId,'photo');
  assert.ok(cleared.some(n=>n.id==='detail'));assert.equal(JSON.stringify(original),snapshot);
  assert.throws(()=>setImageCaption(edited,'photo','detail','不能覆盖其他说明'),/已变化/);
});
test('重复提交图注使用既有节点和来源身份，不因临时编号不同而重复新增',()=>{
  const original=setImageCaption(validateElements(nodes),'photo','stable-caption','已有图注');
  const updated=setImageCaption(original,'photo','temporary-caption','更新图注');
  const captions=updated.filter(n=>n.type==='text'&&n.role==='caption'&&n.parentId==='photo');
  assert.equal(captions.length,1);assert.equal(captions[0].id,'stable-caption');assert.equal(captions[0].text,'更新图注');
  assert.ok(updated.some(n=>n.id==='detail'&&n.text==='这是附属说明'));
  assert.equal(setImageCaption(updated,'photo','another-temporary','').some(n=>n.id==='stable-caption'),false);
  assert.equal(original.find(n=>n.id==='stable-caption').text,'已有图注');
});
test('结构化元素：并列、附属、循环校验、来源和成品场景',()=>{
  const s=validateSlides([{title:'旧标题',body:[],elements:nodes,sources:[],sourceLinks:[{materialId:'doc',target:'element:claim',quote:'原文结论',note:'证据'}]}])[0];
  assert.equal(s.title,'元素关系测试');assert.deepEqual(s.body,['原文结论']);assert.equal(s.imageId,'photo-id');
  bindSources({materials:[{id:'doc',kind:'document',text:'这是原文结论。'}]},[s]);s.elements.find(n=>n.id==='claim').text='改变的结论';bindSources({materials:[{id:'doc',kind:'document',text:'这是原文结论。'}]},[s]);assert.equal(s.sourceLinks[0].stale,true);
  assert.deepEqual(orderedElements(s.elements).map(n=>[n.id,n.depth]),[['title',0],['group',1],['claim',2],['detail',3],['photo',2],['art',2]]);
  const e=scene(s,themes[1],0,1),image=e.find(n=>n.type==='image'),claim=e.find(n=>n.text==='改变的结论');assert.ok(image.x>claim.x);assert.ok(e.some(n=>n.text==='这是附属说明'));
  assert.match(svg(s,themes[1],0,1,{},()=> 'data:image/png;base64,TEST'),/href="data:image\/png;base64,TEST"/);
  assert.throws(()=>validateElements(nodes.map(n=>n.id==='group'?{...n,parentId:'claim'}:n)),/循环/);
  assert.throws(()=>validateElements(nodes.map(n=>n.id==='claim'?{...n,parentId:'missing'}:n)),/不存在/);
  assert.equal(initialElements({title:'旧版',body:['内容'],imageId:'img'}).length,3);
});
test('拖动分支：顺序、缩进、子树保留、循环与标题保护',()=>{
  const original=validateElements(nodes),snapshot=JSON.stringify(original);
  let moved=moveElementBranch(original,'photo','claim','before');assert.deepEqual(orderedElements(moved).map(n=>n.id),['title','group','photo','claim','detail','art']);
  moved=moveElementBranch(original,'claim','art','after');assert.deepEqual(orderedElements(moved).map(n=>n.id),['title','group','photo','art','claim','detail']);assert.equal(moved.find(n=>n.id==='detail').parentId,'claim');
  moved=moveElementBranch(original,'photo','claim','inside');assert.equal(moved.find(n=>n.id==='photo').parentId,'claim');assert.equal(moved.find(n=>n.id==='photo').materialId,'photo-id');
  moved=moveElementBranch(original,'claim',null,'root');assert.equal(moved.find(n=>n.id==='claim').parentId,'title');assert.equal(moved.find(n=>n.id==='detail').parentId,'claim');
  assert.throws(()=>moveElementBranch(original,'group','detail','inside'),/自身/);assert.throws(()=>moveElementBranch(original,'claim','claim','before'),/自身/);assert.throws(()=>moveElementBranch(original,'title','claim','inside'),/顶层/);
  const deep=validateElements([...original,{id:'d3',type:'group',parentId:'detail'},{id:'d4',type:'group',parentId:'d3'}]);assert.throws(()=>moveElementBranch(deep,'photo','d4','inside'),/5 层/);
  assert.equal(original.filter(n=>!n.parentId).length,1);assert.equal(original[0].id,'title');assert.throws(()=>moveElementBranch(original,'group','title','before'),/不能参与并列/);assert.throws(()=>moveElementBranch(original,'group','title','after'),/不能参与并列/);assert.equal(JSON.stringify(original),snapshot);
});
test('左右滑动：逐级调整、前一个同级项、保留子树及边界保护',()=>{
  const original=validateElements(nodes),snapshot=JSON.stringify(original);
  const shift=(list,id,direction)=>{const t=elementLevelTarget(list,id,direction);return moveElementBranch(list,id,t.targetId,t.position);};
  let moved=shift(original,'photo','right');assert.equal(moved.find(n=>n.id==='photo').parentId,'claim');assert.equal(moved.find(n=>n.id==='photo').materialId,'photo-id');
  assert.deepEqual(orderedElements(moved).map(n=>n.id),['title','group','claim','detail','photo','art']);
  moved=shift(moved,'photo','left');assert.equal(moved.find(n=>n.id==='photo').parentId,'group');assert.deepEqual(orderedElements(moved).map(n=>n.id),orderedElements(original).map(n=>n.id));
  moved=shift(original,'claim','left');assert.equal(moved.find(n=>n.id==='claim').parentId,'title');assert.equal(moved.find(n=>n.id==='detail').parentId,'claim');assert.deepEqual(orderedElements(moved).map(n=>n.id),['title','group','photo','art','claim','detail']);
  moved=shift(moved,'claim','right');assert.equal(moved.find(n=>n.id==='claim').parentId,'group');assert.equal(moved.find(n=>n.id==='detail').parentId,'claim');
  moved=shift(original,'detail','left');assert.equal(moved.find(n=>n.id==='detail').parentId,'group');
  assert.throws(()=>shift(original,'group','left'),/顶层/);assert.throws(()=>shift(original,'claim','right'),/前方没有/);assert.throws(()=>shift(original,'title','right'),/顶层/);
  const headers=validateElements([{...nodes[1]},nodes[0]]);assert.throws(()=>shift(headers,'title','right'),/顶层/);
  const deep=validateElements([...original,{id:'d3',type:'group',parentId:'detail'},{id:'d4',type:'group',parentId:'d3'},{id:'last',type:'group',parentId:'d3'}]);assert.throws(()=>shift(deep,'last','right'),/5 层/);
  assert.equal(JSON.stringify(original),snapshot);
});
test('独立元素 API、关系识别保留内容、多图合成预览与 PPTX 导出',async t=>{
  let bad=false,sawImages=false,elementRequests=0,regularRequests=0;
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  const mock=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);res.setHeader('content-type','application/json');
    if(req.url.endsWith('images/generations')){if(b.model==='element-model')elementRequests++;else regularRequests++;assert.match(b.prompt,/独立的演示文稿视觉元素/);res.end(JSON.stringify({data:[{b64_json:png}]}));return;}
    const user=b.messages.at(-1).content,prompt=typeof user==='string'?user:user[0].text;sawImages=Array.isArray(user);let result;
    if(prompt.includes('识别本页已有文本')){const original=JSON.parse(prompt.split('已有元素：')[1].split('\n图片资料：')[0]);result={relationships:original.map(n=>({id:n.id,parentId:n.parentId,layout:n.layout})),groups:[]};if(bad)result.relationships.pop();}
    else if(prompt.includes('concepts:'))result={concepts:themes};else result={prompt:'独立图标，亮黄色几何构成'};
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const dir=path.resolve('work','element-test-'+Date.now()),port=4362;const app=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:dir},stdio:'ignore',windowsHide:true});t.after(()=>{app.kill();mock.close();});
  const base='http://127.0.0.1:'+port;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;};
  let p=await call('/api/projects',{brief:{title:'结构测试',pages:3}},201);const prefix='/api/projects/'+p.id,act=(action,extra={},status=200)=>call(prefix+'/action',{action,...extra},status);
  const wait=async()=>{for(let i=0;i<200;i++){p=await call(prefix);if(p.task?.status!=='running')return p;await new Promise(r=>setTimeout(r,20));}throw Error('超时');};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic-secret',model:'text-model'};p=await act('configure',{text:cfg,elementImage:{...cfg,model:'element-model'}});assert.equal(p.imageReady,false);assert.equal(p.elementImageReady,true);assert.ok(!JSON.stringify(p).includes('synthetic-secret'));
  p=await call(prefix+'/materials',{name:'original.png',base64:png});const photoId=p.materials[0].id;await act('requirements',{brief:p.brief});
  const s={title:'结构测试',body:[],elements:setImageCaption(nodes.map(n=>n.id==='photo'?{...n,materialId:photoId}:n),'photo','photo-caption','可编辑图片图注'),sources:[]};p=await act('saveContent',{slides:[s]});assert.equal(p.slides[0].sourceLinks[0].target,'element:photo');
  const original=JSON.stringify(p.slides);bad=true;await act('recognizeRelations',{index:0});p=await wait();assert.equal(p.task.status,'failed');assert.equal(JSON.stringify(p.slides),original);bad=false;
  await act('recognizeRelations',{index:0,includeImages:true});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(sawImages,true);assert.equal(p.slides[0].elements.find(n=>n.id==='detail').text,'这是附属说明');
  await act('image',{index:0,elementId:'art',prompt:'独立工业风图标',allowUpload:true});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(elementRequests,1);assert.equal(regularRequests,0);const artId=p.slides[0].elements.find(n=>n.id==='art').materialId;assert.equal(p.slides[0].elements.find(n=>n.id==='photo').materialId,photoId);assert.equal(p.materials.at(-1).providerType,'elementImage');
  await act('saveImagePrompt',{index:0,elementId:'art',sourceImageId:artId,prompt:'修改后的元素提示词'});p=await call(prefix);assert.equal(p.imagePromptDrafts['0:'+artId+':art'].prompt,'修改后的元素提示词');
  await act('image',{index:0,elementId:'art',sourceImageId:artId,prompt:'新版元素图',allowUpload:true});p=await wait();assert.equal(p.task.status,'done');const current=p.slides[0].elements.find(n=>n.id==='art').materialId;assert.equal(p.materials.find(m=>m.id===current).parentImageId,artId);
  const preview=await (await fetch(base+prefix+'/preview?slide=0')).text();assert.equal((preview.match(/<image /g)||[]).length,2);assert.equal((preview.match(/data:image\/png;base64/g)||[]).length,2);
  await act('approveContent');await act('concepts',{},400);await act('build',{},400);await call(prefix+'/download',undefined,400);
  const nativeFile=path.join(dir,'native-elements.pptx');await buildDeck({...p,concepts:themes,selectedTheme:'b'},nativeFile,id=>path.join(dir,p.id,'assets',p.materials.find(m=>m.id===id).file));  const zip=await JSZip.loadAsync(fs.readFileSync(nativeFile)),xml=await zip.file('ppt/slides/slide1.xml').async('string');assert.equal((xml.match(/<p:pic>/g)||[]).length,2);assert.match(xml,/这是附属说明/);assert.match(xml,/可编辑图片图注/);
  const saved=fs.readFileSync(path.join(dir,p.id,'project.json'),'utf8');assert.ok(!saved.includes('synthetic-secret'));const exported=p;assert.equal(exported.slides[0].elements.length,7);assert.equal(exported.materials.find(m=>m.id===current).purpose,'element');
});
