import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {backgroundUsesForBrief,isTOCPage,pageStructurePrompt,validateGeneratedTitlePage} from '../lib/page-options.mjs';
import {navigationTexts,pageNeedsImage} from '../lib/design-rules.mjs';
import {scene,themes,validateSlides} from '../lib/scene.mjs';
import {fixtureRequest,fixtureReply} from './visual-fixture.mjs';

test('标题页默认开启；四种标题页/目录组合按需生成底图',()=>{
  assert.deepEqual(backgroundUsesForBrief({}),['hero-image','content-background']);
  assert.deepEqual(backgroundUsesForBrief({toc:true}),['hero-image','toc-image','content-background']);
  assert.deepEqual(backgroundUsesForBrief({cover:false,toc:true}),['toc-image','content-background']);
  assert.deepEqual(backgroundUsesForBrief({cover:false,toc:false}),['content-background']);
  assert.match(pageStructurePrompt({cover:false,toc:true}),/目录位于第一页/);
  assert.match(pageStructurePrompt({toc:true}),/目录位于第二页/);
  const slides=validateSlides([{title:'开始正文',body:['内容']}],{cover:false});assert.equal(slides[0].kind,'content');
  validateGeneratedTitlePage(slides,{cover:false});assert.throws(()=>validateGeneratedTitlePage([{kind:'cover'}],{cover:false}),/仍返回封面/);
  assert.throws(()=>validateGeneratedTitlePage(slides,{}),/唯一标题页/);
});

test('无标题页时目录前移，正文导航和渲染不丢失第二页',()=>{
  const p={brief:{cover:false,toc:true,progress:true},materials:[],slides:[{kind:'toc',title:'目录',body:['核心内容']},{kind:'content',title:'核心内容',body:['具体内容']}]};
  assert.equal(isTOCPage(p.slides[0],0,p.brief),true);assert.equal(isTOCPage(p.slides[1],1,p.brief),false);
  assert.equal(pageNeedsImage(p,0),false);assert.equal(pageNeedsImage(p,1),true);
  assert.deepEqual(navigationTexts(p,0),[]);assert.equal(navigationTexts(p,1).length,5);assert.equal(navigationTexts(p,1).filter(n=>n.current).length,1);
  assert.ok(scene(p.slides[1],themes[0],1,2,p.brief).some(e=>e.managed==='progress'));
  assert.ok(!scene(p.slides[0],themes[0],0,2,p.brief).some(e=>e.managed==='progress'));
  p.brief.toc=false;assert.equal(pageNeedsImage(p,1),true);assert.equal(navigationTexts(p,1).length,5);
  const structured=validateSlides([{title:'第二页',body:['正文']}])[0];structured.elements=[{id:'title',type:'text',role:'title',text:'第二页',parentId:null},{id:'body',type:'text',role:'body',text:'正文',parentId:'title'}];structured.kind='content';
  assert.ok(scene(structured,themes[0],1,2,{cover:false,toc:true,progress:true}).some(e=>e.managed==='progress'));
});

test('标题页选项在真实服务中保存，约束内容与底图，旧项目默认不重置',async t=>{
  let wrongCover=false;const requests=[];
  const mock=http.createServer(async(req,res)=>{
    const b=await fixtureRequest(req);requests.push(b);const user=b.messages?.at(-1)?.content,text=typeof user==='string'?user:user?.[0]?.text||'';
    let reply=fixtureReply(b);
    if(text.startsWith('根据材料写恰好'))reply={choices:[{message:{content:JSON.stringify({slides:[{kind:wrongCover?'cover':text.includes('目录位于第一页')?'toc':'content',title:'第一页',body:[],sources:[]},{kind:'content',title:'研究内容',body:['材料与目标'],sources:[]},{kind:'content',title:'实施安排',body:['明确任务'],sources:[]}]})}}]};
    res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const data=path.resolve('work','page-options-'+Date.now()),legacyId=crypto.randomUUID(),legacyBrief={title:'旧项目',audience:'',purpose:'',pages:3,language:'中文',toc:false,thanks:false,progress:true,speaker:false};
  const legacy={id:legacyId,brief:legacyBrief,materials:[],slides:[{kind:'cover',title:'已有标题页',body:[],sources:[]}],concepts:[],version:1,stage:2,approvals:{},events:[]};
  fs.mkdirSync(path.join(data,legacyId),{recursive:true});fs.writeFileSync(path.join(data,legacyId,'project.json'),JSON.stringify(legacy));
  const app=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:'4394',PPT_AGENT_TEST:'1',PPT_AGENT_DATA:data},windowsHide:true,stdio:'ignore'});t.after(()=>{app.kill();mock.close();});
  const base='http://127.0.0.1:4394';for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body)=>{const res=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),json=await res.json();assert.ok(res.ok,JSON.stringify(json));return json;};
  assert.equal((await call('/api/health')).titlePageOption,true);
  const unchanged=await call('/api/projects/'+legacyId+'/action',{action:'requirements',brief:{...legacyBrief,cover:true}});assert.equal(unchanged.version,1);assert.equal(unchanged.slides[0].title,'已有标题页');assert.equal(unchanged.brief.cover,undefined);
  let p=await call('/api/projects',{brief:{title:'无标题页演示',pages:3,cover:false,toc:false}}),prefix='/api/projects/'+p.id;
  const act=(action,extra={})=>call(prefix+'/action',{action,...extra}),wait=async()=>{for(let i=0;i<1000;i++){p=await call(prefix);if(p.task.status!=='running')return p;await new Promise(r=>setTimeout(r,30));}throw Error('超时');};
  const config={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic-cover-key',model:'synthetic-cover'};await act('configure',{text:config,image:config});await act('requirements',{brief:p.brief});
  await act('content');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.ok(p.slides.every(s=>s.kind==='content'));assert.equal(Object.keys(p.pageDesigns).length,3);
  const oldSlides=structuredClone(p.slides);wrongCover=true;await act('content');p=await wait();assert.equal(p.task.status,'failed');assert.match(p.task.message,/已关闭标题页/);assert.deepEqual(p.slides,oldSlides);wrongCover=false;
  const firstBackground=requests.length;await act('generateThemeAssets');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.themeAssets.status,'awaiting_confirmation');await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.themeAssetsReady,true);assert.equal(requests.slice(firstBackground).filter(b=>b.prompt).length,3);assert.ok(p.themeAssets.directions.every(d=>Object.keys(d.assets).join()==='content-background'));
  await act('requirements',{brief:{...p.brief,toc:true}});await act('content');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.slides[0].kind,'toc');assert.ok(p.slides.every(s=>s.kind!=='cover'));
  const withToc=requests.length;await act('generateThemeAssets');p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.themeAssets.status,'awaiting_confirmation');await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts});p=await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(requests.slice(withToc).filter(b=>b.prompt).length,6);assert.ok(p.themeAssets.directions.every(d=>!d.assets['hero-image']&&d.assets['toc-image']&&d.assets['content-background']));
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,p.id,'project.json'),'utf8')).brief.cover,false);
  const demo=await call('/api/projects',{demo:true,brief:{title:'无标题页示例',cover:false,pages:3}});assert.ok(demo.slides.every(s=>s.kind!=='cover'));
});
