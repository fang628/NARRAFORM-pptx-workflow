import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Resvg} from '@resvg/resvg-js';
import {themePhotoEligible,themePhotoCandidates,validateThemePhotoReferences,photoThemePrompt,themePhotoSelector} from '../public/theme-photo-policy.js';
import {themePhotoReference,validatePhotoSubmissions} from '../lib/theme-photo-reference.mjs';
import {themeAssetsStamp,stageThemePrompts,themePromptDrafts,generateThemeAssets,validateThemePromptSubmission} from '../lib/theme-assets.mjs';
import {validateThemePlanning} from '../lib/theme-planning.mjs';
import {materialStamp} from '../lib/materials.mjs';
import {registerStyleDirections} from '../lib/style-registry.mjs';
import {fixtureDirections,fixtureRequest} from './visual-fixture.mjs';
import {imageTaskRequest} from '../lib/image-task-queue.mjs';
import {imageEditExecution,prepareAIImageEdit} from '../lib/ai-image-edit.mjs';
import {themePromptReview} from '../public/theme-assets.js';

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(){
  const data=fs.mkdtempSync(path.resolve('work/theme-photo-')),id=crypto.randomUUID(),root=path.join(data,id);fs.mkdirSync(path.join(root,'assets'),{recursive:true});
  const p={id,version:1,brief:{title:'城市更新项目答辩',purpose:'毕业设计答辩',pages:3,cover:true,toc:true},materials:[],slides:[{kind:'cover',title:'城市更新'},{kind:'toc',title:'目录'},{kind:'content',title:'内容'}],styleRegistry:[],provider:{image:{model:'fixture'}},themePhotoReferenceEnabled:true};
  for(const [id,color]of [['photo-a','#f1c147'],['photo-b','#5099ab'],['chart','#778899']]){
    const bytes=new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${color}"/></svg>`).render().asPng();
    fs.writeFileSync(path.join(root,'assets',id+'.png'),bytes);p.materials.push({id,name:id+'.png',file:id+'.png',kind:'image',sha256:hash(bytes),size:bytes.length});
  }
  p.analysis={stamp:materialStamp(p),readings:p.materials.map(m=>({id:m.id,category:m.id==='chart'?'数据图表':'实拍照片',summary:m.id==='photo-a'?'城市街区建筑':'城市公园景观',keyPoints:[],facts:[]}))};
  const directions=registerStyleDirections(p,fixtureDirections().map(d=>({...d,assets:{},photoReferences:{'hero-image':'photo-a','toc-image':'photo-b'}})),'test');
  p.themeAssets={id:crypto.randomUUID(),stamp:themeAssetsStamp(p),directions};stageThemePrompts(p);return {p,data,root};
}

test('普通项目与答辩可选照片，其他学术汇报不采用；只自动推荐已理解照片，排除图表与生成图',()=>{
  const {p}=fixture();assert(themePhotoEligible(p));assert.equal(themePhotoCandidates(p,{automatic:true}).length,2);
  p.materials.push({id:'unknown',kind:'image',file:'unknown.png'},{id:'ai',kind:'image',file:'ai.png',generated:true});assert.equal(themePhotoCandidates(p,{automatic:true}).length,2);assert.equal(themePhotoCandidates(p).length,3);
  p.brief={title:'学术汇报',purpose:'研究进展'};assert(!themePhotoEligible(p));assert.equal(themePhotoCandidates(p).length,0);
  p.brief.purpose='博士毕业论文答辩';assert(themePhotoEligible(p));p.brief={title:'品牌发布'};assert(themePhotoEligible(p));
});
test('规划允许照片分支，同一方向封面目录禁同图及同内容副本，不允许图表和AI图',()=>{
  const {p}=fixture(),raw={...fixtureDirections()[0],styleSelection:{matchingPresetIds:['A'],reason:'城市主题适配'},photoReferences:{'hero-image':'photo-a','toc-image':'photo-b'}};
  assert.equal(validateThemePlanning(raw,p).photoReferences['hero-image'],'photo-a');
  for(const refs of [{'hero-image':'photo-a','toc-image':'photo-a'},{'hero-image':'chart'},{'content-background':'photo-a'}])assert.throws(()=>validateThemePhotoReferences(p,refs));
  p.materials.push({...p.materials[0],id:'copy',name:'换名副本.png'});assert.throws(()=>validateThemePhotoReferences(p,{'hero-image':'photo-a','toc-image':'copy'}),/同一张照片/);
  assert.throws(()=>validateThemePhotoReferences(p,{'hero-image':'missing'}),/有效照片/);
});
test('照片引用进提示词与确认弹窗，队列保留照片参数；主体要求不重复，取消后恢复艺术主体',()=>{
  const {p}=fixture(),drafts=themePromptDrafts(p),hero=drafts.find(e=>e.theme==='a'&&e.use==='hero-image');
  assert.equal(hero.photoMaterialId,'photo-a');assert.match(hero.prompt,/参考照片中的/);assert.equal((hero.prompt.match(/仅借用照片主体/g)||[]).length,1);
  const candidate=themePhotoCandidates(p)[0];assert.equal(photoThemePrompt(hero.prompt,candidate),hero.prompt);
  const removed=photoThemePrompt(hero.prompt,null,'交织光带');assert.doesNotMatch(removed,/参考照片|仅借用照片/);assert.match(removed,/交织光带/);
  const html=themePromptReview(p,[hero]);assert.match(html,/data-theme-photo-reference/);assert.match(html,/photo-a/);assert.match(themePhotoSelector(p,{theme:'a',use:'toc-image'}),/photo-b/);
  const request=imageTaskRequest({action:'generateThemeAssets',prompts:[{...hero,photoSourceHash:p.materials[0].sha256}]});assert.equal(request.prompts[0].photoMaterialId,'photo-a');assert.equal(request.prompts[0].photoSourceHash,p.materials[0].sha256);
  assert.equal(imageTaskRequest({action:'generateThemeAsset',photoMaterialId:'photo-b',photoSourceHash:'sha'}).photoMaterialId,'photo-b');
});
test('引用文件校验SHA；单页更换不能撞另一页，同批交换照片可规划，旧引用失效时拒绝',()=>{
  const {p,data,root}=fixture(),d=p.themeAssets.directions[0],env={data};
  const photo=themePhotoReference(p,'hero-image','photo-a',env);assert.equal(photo.sha256,p.materials[0].sha256);
  assert.throws(()=>themePhotoReference(p,'hero-image','photo-a',env,{expectedHash:'stale'}),/已变化/);
  d.assets={'hero-image':{photoReference:{materialId:'photo-a'}},'toc-image':{photoReference:{materialId:'photo-b'}}};
  assert.throws(()=>validatePhotoSubmissions(p,[{d,use:'hero-image',photoMaterialId:'photo-b'}]),/同一张照片/);
  assert.doesNotThrow(()=>validatePhotoSubmissions(p,[{d,use:'hero-image',photoMaterialId:'photo-b'},{d,use:'toc-image',photoMaterialId:'photo-a'}]));
  fs.writeFileSync(path.join(root,'assets','photo-a.png'),'changed');assert.throws(()=>themePhotoReference(p,'hero-image','photo-a',env),/已变化/);
});

test('实际Images edits仅附材料照片，重生成和撤回保留主体来源；配对交换一页失败不发布重复照片',{timeout:30000},async t=>{
  const previous=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';t.after(()=>previous===undefined?delete process.env.PPT_AGENT_TEST:process.env.PPT_AGENT_TEST=previous);
  const {p,data,root}=fixture(),requests=[];let failPrompt='';
  const output=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#eee"/></svg>').render().asPng();
  const mock=http.createServer(async(req,res)=>{const body=await fixtureRequest(req);requests.push({...body,endpoint:req.url});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body.prompt===failPrompt?{error:{message:'synthetic failure'}}:{data:[{b64_json:output.toString('base64')}]}));});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'fixture',model:'fixture'},env={data,root:path.resolve('.'),credentials:new Map([[p.id,{image:cfg}]]),run:promisify(execFile),save(){}};
  const signal=new AbortController().signal,entries=()=>themePromptDrafts(p).filter(e=>e.theme==='a'&&e.use!=='content-background');
  await generateThemeAssets(p,env,signal,{prompts:entries(),confirmed:true});
  const d=p.themeAssets.directions[0],originalHero=d.assets['hero-image'];assert.equal(originalHero.photoReference.materialId,'photo-a');assert.equal(originalHero.generationMode,'image-to-image');assert.equal(requests.filter(r=>r.prompt).length,2);
  for(const request of requests){assert.match(request.endpoint,/images\/edits/);assert.equal(request.referenceImages.length,1);assert([p.materials[0].sha256,p.materials[1].sha256].includes(request.referenceImages[0].sha256));}
  const ledger=JSON.parse(fs.readFileSync(path.join(root,originalHero.jobFile)));assert.equal(ledger.photoReference.materialId,'photo-a');
  const submission=entries()[0],imageEdit=imageEditExecution(p,{action:'generateThemeAsset',theme:'a',use:'hero-image',targetType:'theme',imageEditMode:'redraw',sourceHash:originalHero.previewHash,prompt:'用途：城市更新封面，16:9，以照片中街区主体重绘，右侧留白，无文字。'});
  await generateThemeAssets(p,env,signal,{prompts:[{...submission,photoMaterialId:'photo-a'}],confirmed:true,imageEdit});assert.equal(d.assets['hero-image'].editHistory.past.at(-1).photoReference.materialId,'photo-a');assert.equal(requests.at(-1).referenceImages.length,1);assert.equal(requests.at(-1).referenceImages[0].sha256,p.materials[0].sha256);
  const textRedraw=imageEditExecution(p,{action:'generateThemeAsset',theme:'a',use:'hero-image',targetType:'theme',imageEditMode:'redraw',sourceHash:d.assets['hero-image'].previewHash,prompt:'用途：城市更新封面，16:9，艺术化色面，中央留白，无文字。'});
  await generateThemeAssets(p,env,signal,{prompts:[{...entries()[0],photoMaterialId:null}],confirmed:true,imageEdit:textRedraw});assert.match(requests.at(-1).endpoint,/images\/generations/);assert(!d.assets['hero-image'].photoReference);assert.equal(d.assets['hero-image'].generationMode,'text-to-image');
  const oldHero=d.assets['hero-image'],oldToc=d.assets['toc-image'],swaps=entries().map(e=>({...e,photoMaterialId:e.use==='hero-image'?'photo-b':'photo-a',prompt:e.use==='hero-image'?'SWAP_HERO 照片重绘封面，16:9，留白，无文字':'FAIL_TOC 照片重绘目录，16:9，留白，无文字'}));
  failPrompt=swaps[1].prompt;await assert.rejects(()=>generateThemeAssets(p,env,signal,{prompts:swaps,confirmed:true}),/已保留/);
  assert.equal(d.assets['hero-image'].materialId,oldHero.materialId);assert.equal(d.assets['toc-image'].materialId,oldToc.materialId);assert(d.pendingPhotoAssets['hero-image']);
  assert(fs.existsSync(path.join(root,'assets','photo-a.png')));assert(fs.existsSync(path.join(root,'assets','photo-b.png')));
});

test('AI协助改写实际收到所选照片，草稿记录照片身份，最终仍交由用户确认后生图',{timeout:20000},async t=>{
  const previous=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';t.after(()=>previous===undefined?delete process.env.PPT_AGENT_TEST:process.env.PPT_AGENT_TEST=previous);
  const {p,data}=fixture(),requests=[],d=p.themeAssets.directions[0];
  d.assets['hero-image']={materialId:'old-background',normalized:'old.png',previewHash:'old-hash',prompt:'用途：城市更新封面，抽象艺术形态，16:9，无文字。'};
  const mock=http.createServer(async(req,res)=>{const body=await fixtureRequest(req);requests.push(body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({prompt:'用途：城市更新封面，16:9，主体为参考照片中的街区建筑，保留建筑轮廓，浅灰底，右侧留白，无文字。'})}}]}));});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'fixture',model:'fixture'},env={data,credentials:new Map([[p.id,{text:cfg}]]),system:'JSON'};
  const result=await prepareAIImageEdit(p,{targetType:'theme',theme:'a',use:'hero-image',imageEditMode:'redraw',sourceHash:'old-hash',photoMaterialId:'photo-a',photoSourceHash:p.materials[0].sha256,prompt:d.assets['hero-image'].prompt,instruction:'改用这张照片中的建筑主体'},env,new AbortController().signal);
  assert.equal(result.draft.photoMaterialId,'photo-a');assert.equal(result.draft.photoSourceHash,p.materials[0].sha256);assert.match(result.draft.prompt,/街区建筑/);
  assert.equal(requests.length,1);assert.equal(requests[0].messages.at(-1).content.filter(c=>c.type==='image_url').length,1);assert(!requests[0].prompt,'仅调用主模型整理，不自动生图');
});
