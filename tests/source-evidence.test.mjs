import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {bindSources,evidenceCatalog,sourceEvidenceCatalog,findQuote} from '../lib/sources.mjs';
import {validateSlides} from '../lib/scene.mjs';
import {contentWithEvidence} from '../lib/content-evidence.mjs';
import {fixtureReply} from './visual-fixture.mjs';
import {pageDesignStamp,pageDesignState} from '../lib/page-design.mjs';

const original='[第 2 页]\n第一条结论：增长 10 %。\n补充说明。';
const project=()=>({materials:[{id:'doc',name:'报告.txt',kind:'document',text:original,sha256:'hash'}]});
const slide=(link={excerptId:'E0001'})=>({title:'主要发现',body:['增长10%'],sources:['doc'],sourceLinks:[{materialId:'doc',target:'body:0',note:'材料依据',...link}]});
const validate=(p,raw)=>{const slides=validateSlides(raw);bindSources(p,slides,{requireLinks:true});return slides;};

test('原文片段首尾空白与重复片段：无修改保存确认保持引用坐标和设计版本',()=>{
  // PDF extraction commonly leaves a newline at each evidence chunk boundary.
  const chunk='\n'+'证据'.repeat(249)+'。';
  const p={materials:[{id:'doc',name:'报告.pdf',kind:'document',text:chunk+chunk,sha256:'original'}],brief:{progress:true},slides:[]};
  p.slides=validate(p,[slide({excerptId:'E0002'})]);
  const before=structuredClone(p.slides),stamp=pageDesignStamp(p,0);
  assert.equal(before[0].sourceLinks[0].location.start,500);
  p.pageDesigns={0:{draftStamp:stamp,layoutStamp:stamp,approvedAt:'confirmed',layoutApprovedAt:'confirmed'}};
  for(let i=0;i<3;i++){
    p.slides=validateSlides(p.slides);bindSources(p,p.slides);
    assert.deepEqual(p.slides,before,'无修改保存不能改写原文摘录或定位');
    assert.equal(pageDesignState(p,0).approvedCurrent,true);
    assert.equal(pageDesignState(p,0).layoutCurrent,true);
  }
  p.slides[0].body[0]='真实文案修改';
  assert.equal(pageDesignState(p,0).current,false);
  p.slides=structuredClone(before);p.materials[0].sha256='replaced';
  assert.equal(pageDesignState(p,0).current,false);
});

test('材料引用兼容空值和省略的可选字段，仍须有真实证据才能通过',()=>{
  for(const empty of [null,undefined,'']){
    const slides=validate(project(),[slide({excerptId:'E0001',quote:empty,note:empty})]);
    assert.equal(slides[0].sourceLinks[0].quote,original);
    assert.equal(slides[0].sourceLinks[0].note,'');
    const legacy=validate(project(),[slide({excerptId:empty,quote:'第一条结论：增长10%。',note:empty})]);
    assert.equal(legacy[0].sourceLinks[0].quote,'第一条结论：增长 10 %。');
    assert.equal(Object.hasOwn(legacy[0].sourceLinks[0],'excerptId'),false);
    assert.throws(()=>validate(project(),[slide({excerptId:empty,quote:empty,note:empty})]),e=>e.code==='SOURCE_EVIDENCE_MISMATCH');
  }
  const omitted=slide();delete omitted.sourceLinks[0].quote;delete omitted.sourceLinks[0].note;
  assert.equal(validate(project(),[omitted])[0].sourceLinks[0].quote,original);
  const p=project();p.materials.push({id:'img',name:'原图.png',kind:'image'});
  const image=validate(p,[{title:'图示',body:[],imageId:'img',sourceLinks:[{materialId:'img',target:'image',excerptId:null,quote:null,note:'本页原图'}]}]);
  assert.equal(image[0].sourceLinks[0].materialId,'img');
  assert.equal(image[0].sourceLinks[0].location,null);
  assert.equal(Object.hasOwn(image[0].sourceLinks[0],'excerptId'),false);
  const forged=validateSlides(image);forged[0].sourceLinks[0].materialId='doc';
  assert.throws(()=>bindSources(p,forged),/配图来源必须为图片材料/);
});

test('真实格式错误明确指出页码、引用和字段，不把错误类型转换成证据',()=>{
  for(const [key,value] of [['quote',{}],['note',[]],['excerptId',123],['materialId',null],['target',' '],['quote','甲'.repeat(3001)],['note','甲'.repeat(1001)],['excerptId','E'.repeat(61)]]){
    const bad=slide({[key]:value});bad.sourceLinks.unshift({...slide().sourceLinks[0]});
    assert.throws(()=>validateSlides([slide(),bad]),e=>e.message.includes('第 2 页第 2 条材料对应关系格式无效')&&e.message.includes(key));
  }
  for(const value of [null,[],false])assert.throws(()=>validateSlides([{title:'测试',body:[],sourceLinks:[value]}]),/第 1 页第 1 条/);
});

test('逐页来源按真实编号回填原文，保存后原文定位与文案变更标记仍有效',()=>{
  const p=project(),slides=validate(p,[slide({excerptId:'E0001',quote:'不采用模型改写的摘要'})]);
  assert.equal(slides[0].sourceLinks[0].quote,original);
  assert.equal(slides[0].sourceLinks[0].location.start,0);
  assert.equal(slides[0].sourceLinks[0].excerptId,'E0001');
  const saved=validateSlides(slides);bindSources(p,saved);assert.equal(saved[0].sourceLinks[0].quote,original);
  saved[0].body[0]='改变的结论';bindSources(p,saved);assert.equal(saved[0].sourceLinks[0].stale,true);
  saved[0].sourceLinks[0].quote='虚构的数据';assert.throws(()=>bindSources(p,saved),/无法在原材料中定位/);
});

test('原文编号按材料独立解析，不接受不存在、越界或未经确认的OCR证据',()=>{
  const p=project();p.materials.push({id:'other',name:'另一份材料',kind:'document',text:'另一份真实原文'});
  const slides=validate(p,[{...slide({materialId:'other',excerptId:'E0001'}),sources:['other']}]);assert.equal(slides[0].sourceLinks[0].quote,'另一份真实原文');
  assert.throws(()=>validate(p,[slide({excerptId:'E9999'})]),/编号不存在/);
  assert.deepEqual(sourceEvidenceCatalog({kind:'image',text:original}),[]);
  assert.equal(sourceEvidenceCatalog({kind:'image',text:original,ocrTextApprovedAt:'confirmed'})[0].text,original);
  const long={kind:'document',text:'甲'.repeat(20500)};assert.equal(sourceEvidenceCatalog(long).at(-1).end,20000);
  assert.equal(evidenceCatalog(original)[0].text,original);
});

test('旧格式只容忍空白差异，校验失败收集全部错误且不部分写入',()=>{
  const p=project(),slides=validateSlides([slide({quote:'第一条结论：增长10%。'}),slide({quote:'并不存在的第二条'}),slide({quote:'第三条也不存在'})]);
  const before=structuredClone(slides);
  assert.throws(()=>bindSources(p,slides,{requireLinks:true}),e=>e.code==='SOURCE_EVIDENCE_MISMATCH'&&e.issues.length===2&&e.issues[0].slideIndex===1);
  assert.deepEqual(slides,before);
  const valid=validate(p,[slide({quote:'第一条结论：增长10%。'})]);assert.equal(valid[0].sourceLinks[0].quote,'第一条结论：增长 10 %。');
  assert.equal(findQuote(original,'   '),null);
  assert.throws(()=>validate(p,[slide({quote:'增长20%'})]),/无法在原材料/);
});

test('逐页来源一次批量修正只改引用，持续失败、重复字段与缺证据均停止',async t=>{
  process.env.PPT_AGENT_TEST='1';t.after(()=>delete process.env.PPT_AGENT_TEST);
  let mode='valid',calls=0,repairPrompt='';
  const raw=[slide({quote:null,excerptId:null,note:null}),slide({excerptId:'INVALID'})];
  const mock=http.createServer(async(req,res)=>{
    let body='';for await(const c of req)body+=c;const prompt=JSON.parse(body).messages.at(-1).content;calls++;
    let result={slides:raw};
    if(prompt.startsWith('修正逐页内容的来源编号')){
      repairPrompt=prompt;
      result={references:[{slideIndex:0,linkIndex:0,excerptId:mode==='invalid'?'BAD':mode==='missing'?null:'E0001'},{slideIndex:mode==='duplicate'?0:1,linkIndex:0,excerptId:'E0001'}]};
    }
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
  const p=project(),args={project:p,config:{baseURL:`http://127.0.0.1:${mock.address().port}/v1`,key:'synthetic',model:'mock'},system:'JSON',user:'生成内容',decode:v=>v.slides,validate:raw=>validate(p,raw),signal:new AbortController().signal};
  const result=await contentWithEvidence(args);assert.equal(calls,2);
  assert.equal(result.slides[0].sourceLinks[0].quote,original);assert.equal(result.slides[1].sourceLinks[0].quote,original);
  assert.deepEqual(result.slides.map(s=>[s.title,s.body]),raw.map(s=>[s.title,s.body]));
  assert.match(repairPrompt,/只修复下列引用/);assert.match(repairPrompt,/原文证据目录/);
  for(const [next,error] of [['invalid',/自动修正一次后仍未通过/],['duplicate',/重复或无关/],['missing',/未找到支持文案的原文依据/]]){mode=next;calls=0;await assert.rejects(contentWithEvidence(args),error);assert.equal(calls,mode==='duplicate'?4:2);}
  calls=0;await assert.rejects(contentWithEvidence({...args,validate:()=>{throw Error('模型返回页数错误');}}),/页数错误/);assert.equal(calls,3);
});

test('真实API路径：生成内容和单页修改都使用证据目录与一次修正，人工伪造仍拒绝',async t=>{
  const original='\n[第 2 页]\n第一条结论：增长 10 %。\n补充说明。\n  ';
  let materialId,repairCount=0,contentPrompt='',revisePrompt='';
  const mock=http.createServer(async(req,res)=>{
    let body='';for await(const c of req)body+=c;const request=JSON.parse(body),prompt=request.messages.at(-1).content;
    let result;
    if(prompt.startsWith('根据材料写恰好')){contentPrompt=prompt;result={slides:[0,1,2].map(i=>({...slide(),kind:'content',title:'发现'+(i+1),sources:[materialId],sourceLinks:[{materialId,target:'body:0',excerptId:i===0?'E0001':null,quote:i===2?'增长了百分之十':null,note:null}]}))};}
    else if(prompt.startsWith('只修改这一页')){revisePrompt=prompt;result={slide:{...slide(),kind:'content',title:'更新后的发现',sources:[materialId],sourceLinks:[{materialId,target:'body:0',quote:'增长了百分之十',excerptId:null}]}};}
    else if(prompt.startsWith('修正逐页内容的来源编号')){repairCount++;const refs=JSON.parse(prompt.split('待修引用：')[1].split('\n原文证据目录：')[0]);result={references:refs.map(({slideIndex,linkIndex})=>({slideIndex,linkIndex,excerptId:'E0001'}))};}
    res.end(JSON.stringify(result?{choices:[{message:{content:JSON.stringify(result)}}]}:fixtureReply(request)));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const data=path.resolve('work','source-evidence-api-'+Date.now()),port=4394,base=`http://127.0.0.1:${port}`;
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:data,PPT_AGENT_TEST:'1'},windowsHide:true,stdio:'ignore'});t.after(()=>{app.kill();mock.close();});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const response=await fetch(base+url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;};
  let p=await call('/api/projects',{brief:{title:'证据链回归',pages:3,cover:false}},201);const prefix='/api/projects/'+p.id,act=(action,extra={},status=200)=>call(prefix+'/action',{action,...extra},status);
  const wait=async()=>{for(let i=0;i<300;i++){p=await call(prefix);if(p.task?.status!=='running')return;await new Promise(r=>setTimeout(r,20));}throw Error('Task timeout');};
  p=await call(prefix+'/materials',{name:'证据.txt',base64:Buffer.from(original).toString('base64')});materialId=p.materials[0].id;
  await act('configure',{text:{baseURL:`http://127.0.0.1:${mock.address().port}/v1`,key:'synthetic',model:'mock'}});
  await act('requirements',{brief:p.brief});await act('analyzeMaterials');await wait();assert.equal(p.task.status,'done',p.task.message);
  await act('approveAnalysis');await act('content');await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(repairCount,1);
  assert.match(contentPrompt,/excerpts/);assert.match(contentPrompt,/excerptId/);assert.ok(contentPrompt.includes(original.replace(/\n/g,'\\n')));
  assert.ok(p.slides.every(s=>s.sourceLinks[0].quote===original));assert.ok(p.task.progress.some(e=>e.message.includes('正在按原文编号修正一次')));
  const generatedVersion=p.version,stamps=Object.values(p.pageDesigns).map(d=>d.draftStamp);
  p=await act('saveContent',{slides:p.slides,confirm:true});
  assert.ok(p.slides.every(s=>s.sourceLinks[0].quote===original));
  assert.equal(p.version,generatedVersion,'无修改确认不能提升内容版本');
  assert.equal(p.approvals.content,p.version);
  assert.ok(Object.values(p.pageDesigns).every(d=>d.current));
  assert.deepEqual(Object.values(p.pageDesigns).map(d=>d.draftStamp),stamps);
  for(let index=0;index<p.slides.length;index++)p=await act('approvePageDesign',{index});
  assert.ok(Object.values(p.pageDesigns).every(d=>d.approvedCurrent));
  await act('revise',{index:1,instruction:'调整标题'});await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(repairCount,2);assert.match(revisePrompt,/excerpts/);assert.equal(p.slides[1].title,'更新后的发现');
  const forged=structuredClone(p.slides);forged[1].sourceLinks[0].quote='虚构原文';await act('saveContent',{slides:forged},400);
  assert.equal((await call(prefix)).slides[1].sourceLinks[0].quote,original);
});
