import vm from 'node:vm';
import {synthesizeMaterials} from '../lib/material-synthesis.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {spawn} from 'node:child_process';
import {regenerateProgressSections,validateProgressPlan} from '../lib/progress-regeneration.mjs';import {progressSectionsEditor,validateProgressSections} from '../public/progress-sections.js';
import {pageDesignStamp,renderPageDesign} from '../lib/page-design.mjs';import {pageStamp,visualStamp,fullPageCurrent,rebuiltCurrent} from '../lib/visual-model.mjs';import {initialElements} from '../lib/elements.mjs';import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';
const longTitles=['研究背景与问题','材料选择与方法','方案设计与实施','核心结果与比较','适用条件与限制','总结结论与展望'];
const titles=['研究背景','方法设计','结果分析','总结展望'];
function fixture(){
 const p={id:'test',version:1,brief:{title:'研究',cover:false,toc:false,progress:true},materials:[],slides:titles.map((title,i)=>({kind:'content',title,body:['准确正文'+i],sources:[],progressSectionId:'section-'+(i+1)})),progressSections:validateProgressSections(['原背景','原方法','原结果','原总结']),analysis:{summary:'原材料理解',outline:[]},approvals:{content:1,preview:1},pageDesigns:{},concepts:[{id:'a',mode:'ai',style:'蓝色',representatives:[]}],selectedTheme:'a',visualPages:{},candidate:{id:'old',file:'deck.pptx'},output:{old:true}};
 for(let i=0;i<4;i++){const nodes=initialElements(p.slides[i]),plan={missingMaterials:[],purpose:'表达',conclusion:p.slides[i].title,logic:'并列',readingOrder:nodes.map(n=>n.id),nodes:nodes.map(n=>({id:n.id,position:'中部',relativeSize:'适中',alignment:'左对齐',carrier:'无框',relation:'从属'}))};const stamp=pageDesignStamp(p,i);p.pageDesigns[i]={plan,markdown:renderPageDesign(p,i,plan),draftStamp:stamp,layoutStamp:stamp,approvedAt:'approved',layoutApprovedAt:'approved'};}
 for(let i=0;i<4;i++){const r={index:i,file:'image-'+i+'.png',previewHash:'hash-'+i,stamp:pageStamp(p,i,'a')};p.visualPages[i]=r;p.concepts[0].representatives.push(structuredClone(r));}return p;
}
const answer=p=>({progressSections:titles,assignments:p.slides.map((_,index)=>({index,section:index+1}))});
test('单独生成只更改导航，设计与图片继续可用；旧交付保留且需重建',async()=>{
 const p=fixture(),before=structuredClone(p);let calls=0;
 await regenerateProgressSections(p,{count:4,request:async(_c,_s,prompt,_signal,options)=>{calls++;assert.match(prompt,/不生成或改写逐页正文/);options.validate(answer(p));return {text:JSON.stringify(answer(p))};}});
 assert.equal(calls,1);assert.deepEqual(p.slides.map(s=>s.body),before.slides.map(s=>s.body));assert.equal(p.analysis.summary,before.analysis.summary);assert.deepEqual(p.candidate,before.candidate);assert.deepEqual(p.output,before.output);assert.equal(p.version,before.version);
 assert.deepEqual(p.progressSections.map(s=>s.title),titles);assert.equal(p.approvals.content,1);assert.equal(p.approvals.preview,null);assert.ok(p.slides.every((_,i)=>fullPageCurrent(p,i)));assert.equal(p.progressSectionsGeneration.exportNeedsRebuild,true);
 for(let i=0;i<4;i++){assert.equal(p.visualPages[i].file,before.visualPages[i].file);assert.equal(p.visualPages[i].previewHash,before.visualPages[i].previewHash);assert.equal(p.pageDesigns[i].approvedAt,'approved');assert.ok(p.pageDesigns[i].markdown.includes(titles[0]));}
});
test('已拆解页只替换程序导航，正文素材保持原样且无需重新拆解',async()=>{
 const p=fixture(),body={key:'body',type:'text',nodeId:'body-0',text:'准确正文',x:100,y:120,w:400,h:80,size:30,color:'222222'};
 p.reconstruction={mode:'free',stamp:visualStamp(p),slides:p.slides.map((_,index)=>({index,background:{id:'bg',sha256:'hash'},elements:[structuredClone(body)],audit:[structuredClone(body)]}))};
 assert.ok(rebuiltCurrent(p));await regenerateProgressSections(p,{count:4,request:async()=>({text:JSON.stringify(answer(p))})});assert.ok(rebuiltCurrent(p));
 for(const page of p.reconstruction.slides){assert.deepEqual(page.elements.find(e=>e.key==='body'),body);assert.equal(page.elements.filter(e=>e.key?.startsWith('nf-progress-label-')).length,4);assert.deepEqual(page.audit.find(e=>e.key==='body'),body);}
});
test('无效数量、长名称、遗漏或倒退归属不提交；失败和取消保留原章节',async()=>{
 const p=fixture(),before=structuredClone(p),plan=answer(p);assert.throws(()=>validateProgressPlan({...plan,progressSections:['过长章节名称'.repeat(4),...titles.slice(1)]},p,4),/10字/);assert.throws(()=>validateProgressPlan({...plan,assignments:[]},p,4),/全部正文/);assert.throws(()=>validateProgressPlan({...plan,assignments:[{index:0,section:2},{index:1,section:1},{index:2,section:3},{index:3,section:4}]},p,4),/倒退/);
 await assert.rejects(regenerateProgressSections(p,{count:4,request:async()=>({text:'{"progressSections":[]}'})}));assert.deepEqual(p,before);
 const c=new AbortController();await assert.rejects(regenerateProgressSections(p,{count:4,signal:c.signal,request:async()=>{c.abort();return {text:JSON.stringify(plan)};}}),/abort/i);assert.deepEqual(p,before);
});
test('章节编辑区提供独立入口，保留数量与输入，执行中禁用',()=>{
 const html=progressSectionsEditor({...fixture(),progressSectionsRegenerationEnabled:true});assert.equal((html.match(/data-regenerate-progress/g)||[]).length,1);assert.match(html,/type="button"/);assert.equal((html.match(/data-progress-section="/g)||[]).length,4);
 assert.match(progressSectionsEditor({...fixture(),progressSectionsRegenerationEnabled:true,task:{status:'running'}}),/data-regenerate-progress[^>]* disabled/);
 assert.doesNotMatch(progressSectionsEditor(fixture()),/data-regenerate-progress/);
});
test('真实HTTP：理解后单独按所选数量生成章节，只调用一次文字模型并持久化',{timeout:30000},async t=>{
 let calls=0;const model=http.createServer(async(req,res)=>{const body=await fixtureRequest(req),content=body.messages?.at(-1)?.content,prompt=typeof content==='string'?content:content?.[0]?.text||'';let reply=fixtureReply(body);
 if(prompt.startsWith('单独重新归纳页顶进度章节')){calls++;const count=Number(prompt.match(/严格只生成(\d+)段/)?.[1]);reply={choices:[{message:{content:JSON.stringify({progressSections:count===6?longTitles:titles,assignments:[]})}}]};}
 res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));});await new Promise(r=>model.listen(0,'127.0.0.1',r));t.after(()=>{model.closeAllConnections();model.close();});
 const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const data=fs.mkdtempSync(path.resolve('work/progress-regeneration-')),base='http://127.0.0.1:'+port,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:data,PPT_AGENT_TEST:'1'},stdio:'ignore',windowsHide:true});t.after(()=>server.kill());
 const until=async f=>{for(let i=0;i<500;i++){if(await f())return;await new Promise(r=>setTimeout(r,30));}throw Error('等待超时');};await until(async()=>{try{return (await fetch(base+'/api/health')).ok;}catch{return false;}});
 const call=async(url,body)=>{const r=await fetch(base+url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;};
 let p=await call('/api/projects',{brief:{title:'试验材料',pages:4,cover:false,toc:false,progress:true}}),prefix='/api/projects/'+p.id;const act=(action,extra={})=>call(prefix+'/action',{action,...extra}),wait=()=>until(async()=>{p=await call(prefix);if(p.task.status==='failed')throw Error(p.task.message);return p.task.status!=='running';});
 await call(prefix+'/materials',{name:'说明.txt',base64:Buffer.from('试验材料与结论。').toString('base64')});await act('configure',{text:{baseURL:'http://127.0.0.1:'+model.address().port+'/v1',key:'synthetic-only',model:'fixture'}});await act('analyzeMaterials');await wait();const before=structuredClone(p.analysis),slides=structuredClone(p.slides);
 await act('regenerateProgressSections',{count:4});await wait();assert.equal(calls,1);assert.deepEqual(p.progressSections.map(s=>s.title),titles);assert.equal(p.analysis.summary,before.summary);assert.deepEqual(p.slides,slides);assert.ok(p.progressSectionsRegenerationEnabled);
 await act('regenerateProgressSections',{count:6});await wait();assert.equal(calls,2);assert.deepEqual(p.progressSections.map(s=>s.title),longTitles);assert.equal(p.progressSections.length,6);assert.ok(p.progressSections.every(s=>s.title.length>=6&&s.title.length<=8));
 const saved=JSON.parse(fs.readFileSync(path.join(data,p.id,'project.json')));assert.deepEqual(saved.progressSections,p.progressSections);
});

test('改变段数调用整组生成，不截断、追加或显示旧数量占位项',async()=>{
 const p=fixture(),select={value:'6'},calls=[],source=fs.readFileSync('public/app.js','utf8');
 const start=source.indexOf("  const count=$('#progressSectionCount');if(count)count.onchange="),end=source.indexOf("  const pages=$('#briefForm",start);
 const ctx={p:{...p,apiReady:true,progressSectionsRegenerationEnabled:true},$:()=>select,progressSectionsOf:()=>p.progressSections,busy:()=>false,safe:fn=>fn(),act:async(action,args)=>calls.push({action,args}),openAPI(){}};
 vm.runInNewContext(source.slice(start,end),ctx);await select.onchange();assert.equal(calls[0].action,'regenerateProgressSections');assert.equal(calls[0].args.count,6);assert.equal(calls.length,1);assert.equal(p.progressSections.length,4);
 const pending=progressSectionsEditor({...p,progressSectionsRegenerationEnabled:true,task:{status:'running',label:'重新生成页顶进度章节',progressSectionCount:6}});assert.match(pending,/value="6" selected/);assert.match(pending,/正在按 6 段/);assert.doesNotMatch(pending,/data-progress-section="/);
});
test('材料理解先按内容选择段数，输出仅包含这一组名称；6–8字名称不触发压缩',async()=>{
 let calls=0;const result=await synthesizeMaterials({brief:{title:'全篇主题'},readings:[],call:async(_c,_s,prompt,_signal,options)=>{calls++;assert.match(prompt,/先根据内容主题跨度/);assert.match(prompt,/只生成选定段数的一组章节/);const raw={summary:'综合理解',outline:[],questions:[],progressSectionCount:6,progressSections:longTitles};options.validate(raw);return {text:JSON.stringify(raw)};}});
 assert.equal(calls,1);assert.equal(result.synthesis.progressSectionCount,6);assert.deepEqual(result.synthesis.progressSections.map(s=>s.title),longTitles);
});

test('改变段数只提交一组全新章节，沿用旧名称时进入模型修正且不覆盖原结果',async()=>{
 const p=fixture(),before=structuredClone(p);
 const copied={progressSections:[...p.progressSections.map(s=>s.title),'补充章节'],assignments:p.slides.map((_,index)=>({index,section:index+1}))};
 assert.throws(()=>validateProgressPlan(copied,p,5),/不得沿用旧名称/);
 const punctuation=structuredClone(copied);punctuation.progressSections[0]='原 背景。';
 assert.throws(()=>validateProgressPlan(punctuation,p,5),/不得沿用旧名称/);
 await assert.rejects(regenerateProgressSections(p,{count:5,request:async(_c,_s,prompt,_signal,options)=>{
  assert.match(prompt,/只返回一个progressSections数组/);assert.match(prompt,/重新命名全部章节/);
  options.validate(copied);return {text:JSON.stringify(copied)};
 }}),/不得沿用旧名称/);
 assert.deepEqual(p,before);
 const fresh={...copied,progressSections:longTitles.slice(0,5)};
 await regenerateProgressSections(p,{count:5,request:async(_c,_s,_prompt,_signal,options)=>{options.validate(fresh);return {text:JSON.stringify(fresh)};}});
 assert.equal(p.progressSections.length,5);assert.deepEqual(p.progressSections.map(s=>s.title),fresh.progressSections);
 assert.equal(p.progressSectionsGeneration.previous.length,4);
});

test('重生成以各页实际主题归纳篇章名和连续归属，排除无含义的树标签',async()=>{
 const p=fixture();
 const names=['问题来源与研究对象','分子修饰方案设计','稳定性与药代评价','研究结论及应用展望'];
 p.slides.forEach((s,i)=>{s.title=names[i];s.body=['该页关键结论'+i];s.elements=[{type:'group',label:'无实际含义的布局标签',text:'页面真实内容'+i}];});
 await regenerateProgressSections(p,{count:4,request:async(_c,_s,prompt,_signal,options)=>{
  assert.match(prompt,/生成的是PPT的篇章名/);assert.match(prompt,/优先依据每页标题、关键结论及正文主题/);
  assert.match(prompt,/当前各页主题为准/);assert.match(prompt,/不按页数平均切段/);assert.match(prompt,/不套用.*通用流程标签/);
  assert.doesNotMatch(prompt,/无实际含义的布局标签/);
  const pages=JSON.parse(prompt.split('正文页面：')[1]);assert.deepEqual(pages.map(s=>s.title),names);assert.equal(pages[2].body[0],'该页关键结论2');
  const raw={progressSections:names,assignments:p.slides.map((_,index)=>({index,section:index+1}))};options.validate(raw);return {text:JSON.stringify(raw)};
 }});
 assert.deepEqual(p.progressSections.map(s=>s.title),names);assert.deepEqual(p.slides.map(s=>s.progressSectionId),['section-1','section-2','section-3','section-4']);
});
