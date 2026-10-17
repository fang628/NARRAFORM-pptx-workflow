import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {navigationTexts,assignProgressSections,progressSceneBrief,suggestProgressSections} from '../lib/progress-navigation.mjs';
import {validateProgressSections,progressSectionsEditor,pageProgressSelector} from '../public/progress-sections.js';
import {validateSlides,scene,themes} from '../lib/scene.mjs';
import {materialStamp} from '../lib/materials.mjs';
import {pageDesignStamp} from '../lib/page-design.mjs';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';
import {materialPanel} from '../public/materials.js';
import {slideImagePrompt,effectiveSlideImagePrompt} from '../lib/slide-image-prompts.mjs';
const names=['研究背景','主要问题','方法方案','实验结果','总结展望'];
const project=()=>({brief:{title:'研究',progress:true,cover:true,toc:true},progressSections:validateProgressSections(names),materials:[],slides:[{kind:'cover',title:'封面',body:[],sources:[]},{kind:'toc',title:'目录',body:[],sources:[]},...Array.from({length:18},(_,i)=>({kind:'content',title:'内容'+i,body:[],sources:[],progressSectionId:'section-'+(Math.floor(i/4)+1)}))]});

test('01提供5或6个可编辑章节，非法段数或重名不落盘',()=>{
  for(const n of [1,4,7,30])assert.throws(()=>validateProgressSections(Array(n).fill('章节')),/5 或 6/);
  assert.throws(()=>validateProgressSections(['背景','背景','方法','结果','总结']),/重复/);
  const p=project(),html=progressSectionsEditor(p);assert.equal((html.match(/data-progress-section=/g)||[]).length,5);assert.match(html,/5 段/);assert.match(html,/6 段/);
  assert.equal(suggestProgressSections(['不完整'],[{title:'材料主题'}]).length,5);
  const six=validateProgressSections([...names,'后续安排']);assert.equal((progressSectionsEditor({...p,progressSections:six}).match(/data-progress-section=/g)||[]).length,6);
  assert.match(pageProgressSelector(p,p.slides[2]),/value="section-1" selected/);
  p.materials=[{id:'doc',name:'材料.txt',kind:'document',text:'原文'}];
  const intake=materialPanel(p,()=>'',[],'');
  assert.ok(intake.indexOf('class="progress-sections-editor"')>intake.indexOf('id="materialAnalysis"'),'进度章节在01的02材料理解框内');
  assert.equal((intake.match(/id="progressSectionCount"/g)||[]).length,1);
});

test('20页只用5段，多页共用所属章节；改页标题不改章节名，改章节名不使材料理解过期',()=>{
  const p=project();assignProgressSections(p);assert.deepEqual(navigationTexts(p,0),[]);assert.deepEqual(navigationTexts(p,1),[]);
  for(let i=2;i<p.slides.length;i++){const nav=navigationTexts(p,i);assert.equal(nav.length,5);assert.equal(nav.filter(n=>n.current).length,1);assert.deepEqual(nav.map(n=>n.text),names);}
  assert.equal(navigationTexts(p,2).find(n=>n.current).nodeId,navigationTexts(p,3).find(n=>n.current).nodeId);
  const stamp=materialStamp(p),design=pageDesignStamp(p,2);p.slides[2].title='不同的逐页标题';assert.deepEqual(navigationTexts(p,2).map(n=>n.text),names);
  p.progressSections[0].title='修改后的研究背景';assert.equal(materialStamp(p),stamp);assert.notEqual(pageDesignStamp(p,2),design);
  const native=scene(p.slides[2],themes[0],2,p.slides.length,progressSceneBrief(p,2));assert.equal(native.filter(n=>n.role==='navigation').length,5);assert.ok(native.filter(n=>n.role==='navigation').every(n=>n.y+n.h<100));
  p.brief.progress=false;assert.deepEqual(navigationTexts(p,2),[]);
});

test('预览提示词只包含当前01章节，旧稿中的逐页导航会被替换而非叠加',()=>{
  const p=project(),direction={id:'a',style:'白色与蓝色',coreColor:'#FFFFFF'};p.pageDesigns={2:{plan:{nodes:[],logic:'并列',layoutIntent:'并列展示'}}};
  const previous=slideImagePrompt(p,2,direction,[]);p.progressSections[0].title='修改后的背景';
  const prompt=effectiveSlideImagePrompt(p,2,direction,[],'full',previous),progress=prompt.split('- **进度条要求**：')[1].split('- **视觉关系要求**：')[0];
  assert.match(progress,/共5段/);assert.match(progress,/修改后的背景/);assert.doesNotMatch(progress,/研究背景/);assert.equal((prompt.match(/^- \*\*进度条要求/gm)||[]).length,1);
});

test('真实HTTP：材料理解自动建议章节，01修改保存后重新理解不覆盖，逐页分配并持久化',async t=>{
  const mock=http.createServer(async(req,res)=>{
    const b=await fixtureRequest(req),content=b.messages?.at(-1)?.content,prompt=typeof content==='string'?content:content?.[0]?.text||'';let result;
    if(prompt.includes('识别与理解单份材料'))result={category:'报告',summary:'背景、问题、方法与结果',keyPoints:['背景','方法'],facts:[],questions:[]};
    else if(prompt.includes('汇总材料理解')){assert.match(prompt,/progressSections/);result={summary:'研究内容',outline:[{title:'研究主题',sourceIds:[]}],questions:[],pageCountSuggestion:{pages:8},progressSections:names};}
    else if(prompt.startsWith('根据材料写恰好')){assert.match(prompt,/不按页数或逐页标题生成节点/);assert.match(prompt,/进度章节/);result={slides:Array.from({length:8},(_,i)=>({kind:'content',title:'单页'+i,body:[],sources:[],progressSectionId:i<4?'section-1':'section-2'}))};}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(result?{choices:[{message:{content:JSON.stringify(result)}}]}:fixtureReply(b)));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=path.resolve('work','progress-sections-'+Date.now()),base='http://127.0.0.1:'+port;
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:data},stdio:'ignore',windowsHide:true});t.after(()=>app.kill());
  for(let i=0;i<200;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,25));}
  const call=async(url,body,status=200)=>{const res=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),value=await res.json();assert.equal(res.status,status,JSON.stringify(value));return value;};
  let p=await call('/api/projects',{brief:{title:'章节进度',pages:null,cover:false,progress:true}},201);const prefix='/api/projects/'+p.id,act=(action,b={},status=200)=>call(prefix+'/action',{action,...b},status);
  const wait=async()=>{for(let i=0;i<700;i++){p=await call(prefix);if(p.task.status!=='running'){assert.equal(p.task.status,'done',p.task.message);return;}await new Promise(r=>setTimeout(r,20));}throw Error('任务超时');};
  await act('configure',{text:{baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic',model:'mock'}});
  p=await call(prefix+'/materials',{name:'source.txt',base64:Buffer.from('研究背景、主要问题、方法与实验结果。').toString('base64')});await act('requirements',{brief:p.brief});
  await act('analyzeMaterials');await wait();assert.deepEqual(p.progressSections.map(s=>s.title),names);assert.equal(p.analysisCurrent,true);
  p=await act('approveAnalysis');const approved=p.analysis.approvedAt,material=p.analysis.stamp;
  const edited=[...names,'后续研究'];edited[0]='项目缘起';p=await act('requirements',{brief:p.brief,progressSections:edited});assert.equal(p.analysisCurrent,true);assert.equal(p.analysis.stamp,material);assert.equal(p.analysis.approvedAt,approved);assert.deepEqual(p.analysis.progressSections.map(s=>s.title),edited);
  await act('requirements',{brief:p.brief,progressSections:['错误']},400);p=await call(prefix);assert.equal(p.progressSections.length,6);
  await act('analyzeMaterials');await wait();assert.deepEqual(p.progressSections.map(s=>s.title),edited);p=await act('approveAnalysis');await act('content');await wait();
  assert.equal(p.slides.length,8);assert.equal(p.slides[0].progressSectionId,'section-1');assert.equal(p.slides[3].progressSectionId,'section-1');assert.equal(p.slides[7].progressSectionId,'section-2');
  const saved=JSON.parse(fs.readFileSync(path.join(data,p.id,'project.json'),'utf8'));assert.equal(saved.progressSections.length,6);assert.equal(saved.progressSectionsManual,true);
  p=await act('saveContent',{slides:p.slides.map((s,i)=>i===0?{...s,progressSectionId:'section-3'}:s)});assert.equal(p.slides[0].progressSectionId,'section-3');assert.equal(navigationTexts(p,0).find(n=>n.current).text,edited[2]);
  assert.ok(validateSlides(p.slides).every(s=>s.progressSectionId));
});
