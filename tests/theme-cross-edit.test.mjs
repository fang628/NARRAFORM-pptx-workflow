import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Resvg} from '@resvg/resvg-js';
import {crossThemeEdit,themeCrossStyleOptions} from '../lib/theme-cross-edit.mjs';
import {crossThemeRequest,crossImageSelection,crossImageRequest} from '../public/theme-cross-edit.js';
import {themeAssetsPanel} from '../public/theme-assets.js';
import {imageTaskRequest,imageTaskLabel} from '../lib/image-task-queue.mjs';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';

test('交叉修改锁定结构源与目标版本，队列保留参数，界面显示同一指令',()=>{
  const directions=['a','b'].map((id,i)=>({id,name:id,style:'主题色 #445566',coreColor:'#445566',styleRegistrationId:'style-'+id,heroSubject:'右侧主体',textArea:'左侧留白',assets:{'hero-image':{normalized:id+'.png',previewHash:'hash-'+id,materialId:id}}}));
  const p={id:'p',brief:{title:'演示'},themeAssetsCurrent:true,themeAssets:{directions},themeAssetPrompts:[{theme:'b',use:'hero-image',revision:1,prompt:'最终完整底图提示词'}]};
  p.themeCrossStyleOptions=themeCrossStyleOptions(p);
  const b=crossThemeRequest(p,{sourceTheme:'a',targetTheme:'b',use:'hero-image',sourceHash:'hash-a',targetStyleId:'style-b',targetHash:'hash-b',instruction:'减弱反光'}),edit=crossThemeEdit(p,b);
  assert.equal(edit.mode,'adjust');assert.equal(edit.references.length,2);assert.equal(edit.references[0].sha256,'hash-a');assert.equal(edit.references[1].role,'style-only');
  assert.match(edit.prompt,/保留主体身份、轮廓、形状、部件数量、连接关系、位置、比例和构图/);assert.match(edit.prompt,/图片2仅参考色调/);assert.match(edit.prompt,/减弱反光/);
  const queued=imageTaskRequest({action:'generateThemeAsset',...b});assert.deepEqual(queued.crossStyleSource,b.crossStyleSource);assert.equal(queued.crossStyleTargetHash,'hash-b');assert.match(imageTaskLabel(queued),/A → B/);
  assert.throws(()=>crossThemeEdit(p,{...b,crossStyleSource:{theme:'a',sourceHash:'old'}}),/结构来源图片已变化/);
  assert.throws(()=>crossThemeEdit(p,{...b,crossStyleTargetStyleId:'old'}),/目标风格或底图已变化/);
  assert.throws(()=>crossThemeEdit(p,{...b,theme:'a'}),/不同方向/);
});

test('真实HTTP：两图图生图交叉修改只替换目标底图，源图不变，单图撤回重做恢复图片与提示词',async t=>{
  const requests=[];let imageCount=0;
  const mock=http.createServer(async(req,res)=>{
    const b=await fixtureRequest(req);requests.push({endpoint:req.url,...b});res.setHeader('content-type','application/json');
    if(b.prompt){imageCount++;const png=new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="${['#ddddcc','#ccccdd','#ddcccc'][imageCount-1]||'#cccccc'}"/><circle cx="1200" cy="450" r="180" fill="#555555"/></svg>`).render().asPng();res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));}
    else res.end(JSON.stringify(fixtureReply(b)));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:path.resolve('work','theme-cross-'+Date.now()),PPT_AGENT_TEST:'1'},windowsHide:true,stdio:'ignore'});t.after(()=>app.kill());
  const base='http://127.0.0.1:'+port;
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body)=>{const r=await fetch(base+url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j;};
  const created=await fetch(base+'/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({brief:{title:'主题实体',pages:1,cover:true,toc:false}})});let p=await created.json();assert.equal(created.status,201);
  const prefix='/api/projects/'+p.id,act=(action,b={})=>call(prefix+'/action',{action,...b});
  const wait=async()=>{for(let i=0;i<500;i++){p=await call(prefix);if(p.task?.status!=='running'){assert.equal(p.task?.status,'done',p.task?.message);return;}await new Promise(r=>setTimeout(r,25));}throw Error('任务超时');};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'synthetic',key:'synthetic'};
  await act('configure',{text:cfg,image:cfg});await act('saveContent',{slides:[{kind:'cover',title:'主题实体',body:[],sources:[]}]});await act('generateThemeAssets');await wait();
  await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts.filter(r=>r.use==='hero-image'&&r.theme!=='c')});await wait();
  const source=structuredClone(p.themeAssets.directions[1].assets['hero-image']),previous=structuredClone(p.themeAssets.directions[0].assets['hero-image']);
  const currentTarget={targetType:'theme',theme:'a',use:'hero-image'},payload=crossImageRequest(p,currentTarget,crossImageSelection(p,currentTarget,'b',previous.previewHash),'保留柔和材质');assert.equal(payload.theme,'a');assert.equal(payload.crossStyleSource.theme,'b');
  await act('generateThemeAsset',payload);await wait();
  const next=structuredClone(p.themeAssets.directions[0].assets['hero-image']),request=requests.filter(r=>r.prompt).at(-1);
  assert.ok(request.endpoint.endsWith('/images/edits'));assert.equal(request.referenceImages.length,2);assert.equal(request.referenceImages[0].sha256,source.previewHash);assert.equal(request.referenceImages[1].sha256,previous.previewHash);
  assert.deepEqual(p.themeAssets.directions[1].assets['hero-image'],source);assert.notEqual(next.previewHash,previous.previewHash);assert.equal(next.styleRegistrationId,previous.styleRegistrationId);assert.equal(next.crossStyle.sourceDirection,'b');assert.equal(next.generationMode,'image-to-image');
  assert.match(themeAssetsPanel(p),/data-theme-cross-restore="undo"/);assert.doesNotMatch(themeAssetsPanel(p),/data-theme-cross-edit=/,'每张底图只保留统一图片编辑入口');
  p=await act('restoreAIImage',{targetType:'theme',theme:'a',use:'hero-image',direction:'undo',sourceHash:next.previewHash,sourceRevision:next.jobFile||next.file});assert.equal(p.themeAssets.directions[0].assets['hero-image'].previewHash,previous.previewHash);assert.equal(p.themeAssets.directions[0].assets['hero-image'].prompt,previous.prompt);
  assert.match(themeAssetsPanel(p),/已撤回交叉修改/);
  p=await act('restoreAIImage',{targetType:'theme',theme:'a',use:'hero-image',direction:'redo',sourceHash:previous.previewHash,sourceRevision:previous.jobFile||previous.file});assert.equal(p.themeAssets.directions[0].assets['hero-image'].previewHash,next.previewHash);assert.equal(p.themeAssets.directions[0].assets['hero-image'].prompt,next.prompt);assert.equal(imageCount,3,'撤回重做不调用生图');
});
