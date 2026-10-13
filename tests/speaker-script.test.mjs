import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {speakerOptions,speakerScriptStamp,speakerScriptPublic,speakerPageContext,validateSpeakerPage} from '../lib/speaker-script.mjs';
import {pageDesignStamp} from '../lib/page-design.mjs';
import {pageStamp} from '../lib/visual-model.mjs';
import {designCheckKeys,designPolicyVersion} from '../lib/design-rules.mjs';
import {speakerScriptPanel} from '../public/visual-ui.js';

function fixture(){
  const p={id:crypto.randomUUID(),version:1,stage:6,visualMode:'ai',brief:{title:'材料到演示：讲述设计',audience:'项目评审',language:'中文',purpose:'介绍材料与内容规划',pages:2,cover:true,toc:false,progress:false},approvals:{content:1,preview:1},analysis:{summary:'从材料整理到内容表达',outline:[{title:'材料整理与内容表达',sourceIds:['material-1']}]},materials:[{id:'material-1',name:'项目规划.md',kind:'text',text:'项目先整理材料，再建立内容关系。讲述应忠实于已有内容。'}],slides:[{kind:'cover',title:'从材料，到清晰表达',subtitle:'项目讲述与内容规划',body:[],sources:['material-1'],notes:'开场介绍主题。'},{kind:'content',title:'让关系清晰，让表达自然',body:['整理材料，保留来源。','建立层级，围绕主题展开。','逐页确认，形成完整讲述。'],sources:['material-1'],sourceLinks:[{materialId:'material-1',quote:'项目先整理材料，再建立内容关系。'}]}],concepts:[{id:'a',style:'纸白灰'}],selectedTheme:'a',pageDesigns:{},visualPages:{},events:[]};
  for(let i=0;i<2;i++){p.pageDesigns[i]={draftStamp:pageDesignStamp(p,i),approvedAt:'approved',markdown:'按内容关系组织观点与依据。'};p.visualPages[i]={stamp:pageStamp(p,i),previewHash:'image-'+i,file:'preview.png',previewReview:{status:'passed',issues:[]},designChecks:{...Object.fromEntries(designCheckKeys.map(k=>[k,true])),policyVersion:designPolicyVersion}};}
  return p;
}
const raw={opening:'这一页介绍如何让材料形成清晰的讲述。',paragraphs:['我们先保留材料来源，再建立内容之间的关系。这能帮助听众把握每一页的核心观点。'],transition:'下面进一步说明内容组织的方法。',evidence:['material-1','invented']};

test('讲稿沿用页序、内容树与设计规划；忽略未登记引用，选项不影响PPT确认',()=>{
  const p=fixture(),ctx=speakerPageContext(p,1);assert.equal(ctx.sources[0].quotes[0],p.slides[1].sourceLinks[0].quote);assert.match(ctx.design,/内容关系/);assert.ok(ctx.contentTree.some(n=>n.role==='title'));
  const page=validateSpeakerPage(raw,p,0);assert.equal(page.title,p.slides[0].title);assert.equal(page.id,'S01');assert.deepEqual(page.evidence,['material-1']);assert.ok(page.seconds>10);
  assert.throws(()=>validateSpeakerPage({...raw,paragraphs:[]},p,0),/格式无效/);assert.throws(()=>speakerOptions(p,{minutes:0}),/1–180/);
  const stamp=speakerScriptStamp(p);p.speakerScriptOptions={enabled:true};assert.equal(speakerScriptStamp(p),stamp);p.speakerScriptOptions.enabled=false;assert.equal(speakerScriptStamp(p),stamp);
  p.speakerScript={stamp};assert.equal(speakerScriptPublic(p).speakerScriptCurrent,true);p.slides[0].title+='新版本';assert.equal(speakerScriptPublic(p).speakerScriptCurrent,false);assert.equal(p.approvals.preview,1);
});

test('05可选讲稿区提供时长与要求；未生成不显示下载，输出转义',()=>{
  const p={...fixture(),speakerScriptEnabled:true,speakerScriptOptions:{enabled:false}};
  assert.match(speakerScriptPanel(p),/生成讲稿 PDF/);assert.doesNotMatch(speakerScriptPanel(p),/speakerMinutes/);
  p.speakerScriptOptions={enabled:true,instruction:'<script>bad()</script>',minutes:8};let html=speakerScriptPanel(p);assert.match(html,/speakerMinutes/);assert.doesNotMatch(html,/<script>/);assert.doesNotMatch(html,/下载讲稿 PDF/);
  Object.assign(p,{speakerScriptCurrent:true,speakerScript:{pageCount:2,totalSeconds:130}});html=speakerScriptPanel(p);assert.match(html,/speaker-script\?type=pdf/);assert.match(html,/2.2 分钟/);
});

test('HTTP生成中文讲稿PDF、进度和下载；可选开关不使PPT失效，旧讲稿与篡改文件禁止下载',async t=>{
  const requests=[];let mode='valid';
  const mock=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const b=JSON.parse(Buffer.concat(chunks)),prompt=b.messages.at(-1).content;requests.push(prompt);const page=JSON.parse(prompt.split('当前页内容：')[1]);
    const paragraphs=page.page===2?Array.from({length:8},(_,i)=>`第${i+1}个讲述段落。我们按照已有规划介绍材料整理、层级关系与逐页确认。听众可以从主题进入要点，再了解每个要点的依据。演讲时保留自然停顿，避免机械重复画面上的全部文字。<文字符号>不会被当作排版标签。`):raw.paragraphs;
    const value=mode==='invalid'?{paragraphs:[]}:{...raw,paragraphs,transition:page.nextTitle?'下面进入'+page.nextTitle+'。':'以上就是本次讲述的主要内容，谢谢。'};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));});await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const p=fixture(),data=path.resolve('work','speaker-script-test-'+Date.now()),dir=path.join(data,p.id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'project.json'),JSON.stringify(p));
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const app=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:data},windowsHide:true,stdio:'ignore'});t.after(()=>app.kill());const base='http://127.0.0.1:'+port,prefix='/api/projects/'+p.id;
  for(let i=0;i<200;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(action,extra={},status=200)=>{const r=await fetch(base+prefix+'/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...extra})}),j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;};
  const get=async()=>await (await fetch(base+prefix)).json(),wait=async()=>{for(let i=0;i<400;i++){const r=await get();if(r.task?.status!=='running')return r;await new Promise(r=>setTimeout(r,30));}throw Error('讲稿任务超时');};
  await call('generateSpeakerScript',{},400);await call('configure',{text:{baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'mock-script',key:'test-only'}});
  const before=await get();await call('setSpeakerScriptOption',{enabled:true,minutes:8,instruction:'语气自然，围绕内容层级展开'});await call('generateSpeakerScript',{minutes:8,instruction:'语气自然，围绕内容层级展开'});let result=await wait();assert.equal(result.task.status,'done',result.task.message);assert.equal(result.speakerScriptCurrent,true);assert.equal(result.speakerScript.pageCount,2);assert.equal(result.approvals.preview,before.approvals.preview);assert.equal(result.version,before.version);assert.equal(result.task.jobs.length,2);assert.ok(result.task.jobs.every(j=>j.status==='done'));assert.equal(requests.length,2);assert.match(requests[0],/全篇规划/);assert.match(requests[1],/contentTree/);
  const pdf=await fetch(base+prefix+'/speaker-script');assert.equal(pdf.headers.get('content-type'),'application/pdf');assert.ok(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).equals(Buffer.from('%PDF-')));
  const notes=await (await fetch(base+prefix+'/speaker-script?type=json')).json();assert.deepEqual(notes.pages.map(s=>s.title),p.slides.map(s=>s.title));assert.ok(notes.pages.every(s=>s.evidence.includes('material-1')));
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'project.json'))),pdfPath=path.join(dir,saved.speakerScript.dir,'speaker-script.pdf');
  const inspected=JSON.parse(execFileSync(path.resolve('.venv/Scripts/python.exe'),['-c','import pymupdf as fitz,json,sys;d=fitz.open(sys.argv[1]);print(json.dumps({"pages":len(d),"pageTexts":[p.get_text() for p in d],"text":"".join(p.get_text() for p in d)},ensure_ascii=False))',pdfPath],{encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}}));assert.ok(inspected.pages>=2);assert.match(inspected.pageTexts[0],/01\. 从材料，到清晰表达/);assert.match(inspected.pageTexts[0],/02\. 让关系清晰，让表达自然/,'不同PPT页的讲稿可在同一PDF页连续排版');assert.match(inspected.pageTexts[0],/对应PPT第2页/);assert.match(inspected.text,/从材料，到清晰表达/);assert.match(inspected.text,/让关系清晰，让表达自然/);assert.match(inspected.text,/<文字符号>/);
  await call('setSpeakerScriptOption',{enabled:false});result=await get();assert.equal(result.speakerScriptCurrent,true);assert.equal(result.approvals.preview,1);await call('setSpeakerScriptOption',{enabled:true});assert.equal((await fetch(base+prefix+'/speaker-script?type=wrong')).status,400);
  mode='invalid';await call('generateSpeakerScript');result=await wait();assert.equal(result.task.status,'failed');assert.equal(result.speakerScriptCurrent,true,'失败保留已有有效讲稿');
  await call('setSpeakerScriptOption',{instruction:'换一种讲述口吻'});assert.equal((await get()).speakerScriptCurrent,false);assert.equal((await fetch(base+prefix+'/speaker-script')).status,400);
  await call('setSpeakerScriptOption',{instruction:'语气自然，围绕内容层级展开'});assert.equal((await get()).speakerScriptCurrent,true);fs.appendFileSync(pdfPath,'tampered');assert.equal((await fetch(base+prefix+'/speaker-script')).status,400);fs.writeFileSync(pdfPath,fs.readFileSync(pdfPath).subarray(0,-8));
  fs.writeFileSync(path.resolve('work','speaker-script-latest.json'),JSON.stringify({data,projectId:p.id,pdfPath}));
});
