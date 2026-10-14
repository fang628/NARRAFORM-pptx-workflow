import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {Resvg} from '@resvg/resvg-js';
import {supplementImageInput,supplementImagePlan,supplementImagePlanningPrompt} from '../lib/supplement-images.mjs';
import {materialStamp} from '../lib/materials.mjs';
import {materialPanel} from '../public/materials.js';
import {imageLibrary,supplementImageRequests,supplementImageDialog} from '../public/material-images.js';
import {enqueueImageTask,checkImageTaskGuard} from '../lib/image-task-queue.mjs';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';

const fixture=()=>{
  const p={brief:{title:'样品制备与验证',pages:1},materials:[{id:'source',name:'材料.txt',sha256:'source-hash',kind:'document'}],slides:[],version:1};
  p.analysis={stamp:materialStamp(p),summary:'样品制备后进行表征，最后验证。',reviewNotes:'不画未提供的动物实验。',outline:[],readings:[{id:'source',status:'read',summary:'制备、表征与验证三个阶段',keyPoints:['三个阶段依次进行'],facts:[{claim:'先制备后表征',quote:'样品制备后进行表征'}]}]};return p;
};
test('补充图片依据当前材料理解和用户描述，允许图内标签，拒绝失效材料与虚构来源',()=>{
  const p=fixture(),b={imageType:'roadmap',instruction:'突出三个研究阶段',academicStyle:true},input=supplementImageInput(p,b),prompt=supplementImagePlanningPrompt(p,input);
  for(const value of ['样品制备后进行表征','突出三个研究阶段','不画未提供的动物实验','路线图','中文短标签'])assert(prompt.includes(value));
  const plan=supplementImagePlan({name:'研究路线',caption:'制备—表征—验证',prompt:'三个阶段依次连接',sourceMaterialIds:['source']},input);assert(plan.prompt.length<4000);assert.deepEqual(plan.sourceMaterialIds,['source']);assert(!plan.prompt.includes('不含文字'));
  assert.throws(()=>supplementImagePlan({prompt:'图示',sourceMaterialIds:['invented']},input),/未理解/);assert.throws(()=>supplementImageInput(p,{...b,imageType:'bad'}),/图片类型/);
  p.materials[0].sha256='changed';assert.throws(()=>supplementImageInput(p,b),/识别与理解/);
});
test('补充图片使用独立多选弹窗，01移除入口，图库沿用普通图片插入且排除重建素材',()=>{
  const p=fixture();p.id='p';p.analysisCurrent=true;p.provider={elementImage:{model:'extra-image'}};
  assert.match(supplementImageDialog,/name="imageTypes" type="checkbox"/);assert.match(supplementImageDialog,/科研学术风格（可选）/);
  p.materials.push({id:'science',name:'AI 补充图片',kind:'image',file:'science.png',generated:true,purpose:'supplement'},{id:'rebuild',name:'重建素材',kind:'image',file:'rebuild.png',generated:true,reconstructed:true,purpose:'reconstruction'},{id:'background',kind:'image',file:'background.png',generated:true,purpose:'workflow-background'});
  const html=imageLibrary(p,{page:0});assert.match(html,/data-insert-material-image="science"/);assert.match(html,/data-image-prompt="science"/);assert(!html.includes('data-insert-material-image="rebuild"'));assert(!html.includes('data-insert-material-image="background"'));
  p.analysisCurrent=false;const inbox=materialPanel(p,()=>'',[],'');assert.match(inbox,/data-read-material="science"/);assert(!inbox.includes('data-read-material="rebuild"'));assert(!inbox.includes('supplementImageForm'));assert(!inbox.includes('scientificFigureForm'));
});

test('多选图片分成独立快照任务，科研风格仅在勾选时应用',()=>{
  const p=fixture(),requests=supplementImageRequests({imageTypes:['illustration','flowchart','illustration'],instruction:'配一张主题图和流程图',academicStyle:false,allowUpload:true});
  assert.equal(requests.length,2);assert.deepEqual(requests.map(r=>r.imageType),['illustration','flowchart']);
  const jobs=requests.map(r=>enqueueImageTask(p,r));requests[0].instruction='修改后的意见';assert.equal(jobs[0].request.instruction,'配一张主题图和流程图');assert.equal(jobs[1].request.academicStyle,false);
  const input=supplementImageInput(p,jobs[0].request),prompt=supplementImagePlanningPrompt(p,input);assert(!prompt.includes('科研学术风格'));assert(prompt.includes('风格与材料主题及用户描述一致'));
  const academic=supplementImageInput(p,{...jobs[1].request,academicStyle:true});assert(supplementImagePlanningPrompt(p,academic).includes('科研学术风格'));
  assert.throws(()=>supplementImageRequests({imageTypes:[],instruction:'测试',allowUpload:true}),/至少勾选/);assert.throws(()=>supplementImageRequests({imageTypes:['bad'],instruction:'测试',allowUpload:true}),/至少勾选/);
  assert.throws(()=>supplementImageRequests({imageTypes:['scene'],instruction:'测试'}),/确认/);
});
test('补充图片排队保留类型和用户描述，材料理解变化后不能执行旧任务',()=>{
  const p=fixture(),record=enqueueImageTask(p,{action:'supplementImage',imageType:'mechanism',imageName:'作用机理',instruction:'展示材料中的作用过程',allowUpload:true});
  assert.equal(record.request.imageType,'mechanism');assert.match(record.label,/作用机理/);checkImageTaskGuard(p,record);p.analysis.reviewNotes='新纠正';assert.throws(()=>checkImageTaskGuard(p,record),/理解已变化/);
});

test('补充图片真实网页管线：额外生图优先、通用回退、普通图片插入与修改、失败保留材料',async t=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'ppt-supplement-')),requests=[],png=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#eee"/><text x="40" y="150">A → B → C</text></svg>').render().asPng();let sourceId,denyImage=false,app,releaseImage;
  let imageGate=null;
  const mock=http.createServer(async(req,res)=>{try{
    const body=await fixtureRequest(req);requests.push({path:req.url,...body});res.setHeader('content-type','application/json');
    if(req.url.includes('/images/')){if(imageGate)await imageGate;if(denyImage){res.statusCode=403;res.end('{"error":{"message":"denied"}}');return;}res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));return;}
    const user=body.messages.at(-1).content,prompt=typeof user==='string'?user:user[0].text;
    const reply=prompt.startsWith('补充图片内容整理：')?{choices:[{message:{content:JSON.stringify({name:'科研路线',caption:'材料中的制备、表征与验证',prompt:'- 内容：制备、表征、验证三个节点。\n- 关系：三个步骤按材料顺序连接。\n- 构图：横向流程，显示中文标签。',sourceMaterialIds:[sourceId]})}}]}:fixtureReply(body);
    res.end(JSON.stringify(reply));
  }catch(error){res.statusCode=500;res.end(JSON.stringify({error:{message:error.message}}));}});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  t.after(async()=>{if(app&&app.exitCode===null){app.kill();await new Promise(r=>app.once('exit',r));}mock.closeAllConnections();await new Promise(r=>mock.close(r));fs.rmSync(data,{recursive:true,force:true});});
  app=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:data},stdio:'ignore',windowsHide:true});const base='http://127.0.0.1:'+port;
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const r=await fetch(base+url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;};
  let p=await call('/api/projects',{brief:{title:'分子修饰研究',pages:1,cover:false}},201);const prefix='/api/projects/'+p.id,act=(action,b={},status)=>call(prefix+'/action',{action,...b},status);
  const wait=async(status='done')=>{for(let i=0;i<500;i++){p=await call(prefix);if(p.task.status!=='running'){assert.equal(p.task.status,status,p.task.message);return;}await new Promise(r=>setTimeout(r,30));}throw Error('任务超时');};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'main',key:'synthetic-key'};
  await act('configure',{text:cfg,image:{...cfg,model:'general'},elementImage:{...cfg,model:'extra'}});
  const request={imageType:'roadmap',instruction:'展示材料中的研究路线',allowUpload:true};await act('supplementImage',request,400);
  p=await call(prefix+'/materials',{name:'材料.txt',base64:Buffer.from('分子修饰及递送研究。').toString('base64')});sourceId=p.materials[0].id;
  await act('analyzeMaterials');await wait();const stamp=p.analysis.stamp;
  await act('supplementImage',{...request,allowUpload:false},400);await act('configure',{image:null});imageGate=new Promise(r=>releaseImage=r);await act('supplementImage',request);
  const queued=await act('supplementImage',{...request,imageType:'scene',academicStyle:true});assert(queued.imageTaskQueue.some(t=>t.status==='queued'));releaseImage();imageGate=null;
  for(let i=0;i<500;i++){p=await call(prefix);if(!p.imageTaskQueue.some(t=>['running','queued'].includes(t.status)))break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(p.imageTaskQueue.filter(t=>t.status==='done').length,2);assert(!p.imageTaskQueue.some(t=>['running','queued'].includes(t.status)));
  const science=p.materials.find(m=>m.supplementImage?.type==='roadmap'),scene=p.materials.find(m=>m.supplementImage?.type==='scene');assert.equal(science.purpose,'supplement');assert.equal(science.providerType,'elementImage');assert.equal(science.model,'extra');assert.deepEqual(science.supplementImage.sourceMaterialIds,[sourceId]);assert.equal(p.analysis.stamp,stamp);assert.equal(p.analysisCurrent,true);assert(science.effectivePrompt.includes('中文标签'));assert(!science.effectivePrompt.includes('不含文字'));assert(!science.effectivePrompt.includes('科研学术风格'));assert(scene.effectivePrompt.includes('科研学术风格'));assert.equal(requests.filter(r=>r.path.includes('/images/')).at(-1).size,'1920x1080');
  p=await act('saveContent',{slides:[{kind:'content',title:'研究路线',body:[],sources:[],elements:[{id:'title',type:'text',role:'title',text:'研究路线',parentId:null},{id:'figure',type:'image',label:science.supplementImage.name,materialId:science.id,parentId:'title'},{id:'caption',type:'text',role:'caption',text:science.supplementImage.caption,parentId:'figure'}]}]});assert.equal(p.slides[0].imageId,science.id);assert(!p.slides[0].sourceLinks.some(l=>l.materialId===science.id),'补充图不冒充原材料证据');
  await act('image',{index:0,elementId:'figure',sourceImageId:science.id,imageEditMode:'adjust',sourceHash:science.sha256,instruction:'将箭头改为深蓝色',allowUpload:true});await wait();const revised=p.materials.find(m=>m.id===p.task.resultImageId);assert.equal(revised.purpose,'supplement');assert.equal(revised.model,'extra');assert.deepEqual(revised.supplementImage,science.supplementImage);assert.equal(requests.filter(r=>r.path.includes('/images/')).at(-1).prompt,'将箭头改为深蓝色');assert.equal(p.slides[0].imageId,revised.id);
  await act('configure',{text:cfg,image:{...cfg,model:'general'},elementImage:null});
  await act('supplementImage',{...request,imageType:'mechanism'});await wait();assert.equal(p.materials.find(m=>m.id===p.task.resultImageId).providerType,'image');
  const count=p.materials.length;denyImage=true;await act('supplementImage',request);await wait('failed');assert.equal(p.materials.length,count);
});
