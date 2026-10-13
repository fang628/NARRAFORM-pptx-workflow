import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {evidenceCatalog,validateReading} from '../lib/materials.mjs';
import {readMaterialWithEvidence} from '../lib/material-reading.mjs';
import {materialPanel} from '../public/materials.js';

const reading=facts=>({summary:'依据原材料整理',category:'报告',keyPoints:[],facts,suggestedUse:'报告',questions:[]});
test('选择原文编号由程序回填，不受模型改写、PDF 换行和特殊字符影响',()=>{
  const original='[第 1 页]\n营收增长 １０％，\n计划按季度复核。\n'+('后续原文段落。\n'.repeat(200));
  const catalog=evidenceCatalog(original);assert.ok(catalog.length>1);
  for(const entry of catalog){assert.equal(entry.text,original.slice(entry.start,entry.end));assert.ok(entry.text.length<=500);}
  const result=validateReading(reading([{claim:'报告给出增长数据',excerptId:'E0001',quote:'模型改写的内容，不应采用'}]),{id:'doc',kind:'document'},original,catalog);
  assert.equal(result.facts[0].quote,catalog[0].text);assert.equal(result.facts[0].location.start,0);
  assert.throws(()=>validateReading(reading([{claim:'结论',excerptId:'E9999',quote:original.slice(0,20)}]),{id:'doc',kind:'document'},original),/编号不存在/);
  assert.throws(()=>validateReading(reading([{claim:'增长20%',quote:'增长20%'}]),{id:'doc',kind:'document'},original),/无法在原文/);
  const compatible=validateReading(reading([{claim:'旧协议',quote:'报告给出\n证据'}]),{id:'doc',kind:'document'},'报告 给出证据');assert.equal(compatible.facts[0].quote,'报告 给出证据');
});

test('只修正一次非法证据，修正成功回填原文，持续失败给出文件与字段',async t=>{
  process.env.PPT_AGENT_TEST='1';t.after(()=>delete process.env.PPT_AGENT_TEST);
  let calls=0,fail=false;
  const mock=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls++;
    const repair=body.messages.at(-1).content.includes('修正材料分析中的证据引用');
    const result=reading(repair?[{claim:'增长10%',excerptId:fail?'MISSING':'E0001'}]:[{claim:'增长10%',quote:'营收大幅上升十个百分点'}]);
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
  const args={config:{baseURL:`http://127.0.0.1:${mock.address().port}/v1`,key:'synthetic',model:'mock'},system:'JSON',user:'分析材料',material:{id:'a',kind:'document',name:'季度报告.pdf'},examinedText:'营收增长10%。',signal:new AbortController().signal};
  const result=await readMaterialWithEvidence(args);assert.equal(calls,2);assert.equal(result.reading.facts[0].quote,args.examinedText);
  fail=true;calls=0;await assert.rejects(readMaterialWithEvidence(args),/季度报告.pdf.*第 1 条.*MISSING/);assert.equal(calls,2);
});

test('批量失败保留已读材料，重试复用；材料或需求变化使断点失效',async t=>{
  let active=0,peak=0,fail=true,counts={first:0,second:0,repair:0};
  const mock=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const prompt=JSON.parse(raw).messages.at(-1).content;let value;
    if(prompt.includes('修正材料分析中的证据引用')){counts.repair++;value=reading([{claim:'结论',excerptId:'INVALID'}]);}
    else if(prompt.includes('识别与理解单份材料')){active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,60));active--;const second=prompt.includes('second.txt');counts[second?'second':'first']++;value=reading([{claim:second?'第二份结论':'第一份结论',excerptId:second&&fail?'INVALID':'E0001'}]);}
    else {const inputs=JSON.parse(prompt.split('材料理解：')[1]);value={summary:'综合理解',outline:[{title:'主要结论',sourceIds:inputs.map(r=>r.id)}],questions:[]};}
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const dir=path.resolve('work','evidence-test-'+Date.now()),port=4369,base=`http://127.0.0.1:${port}`;
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:dir},stdio:'ignore',windowsHide:true});t.after(()=>{app.kill();mock.close();});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body)=>{const response=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  let p=await call('/api/projects',{brief:{title:'证据校验测试',pages:3}});const prefix='/api/projects/'+p.id,act=(action,extra={})=>call(prefix+'/action',{action,...extra});
  const wait=async()=>{for(let i=0;i<200;i++){p=await call(prefix);if(p.task?.status!=='running')return p;await new Promise(r=>setTimeout(r,20));}throw Error('task timeout');};
  for(const name of ['first.txt','second.txt'])await call(prefix+'/materials',{name,base64:Buffer.from(name+' 原始数据。').toString('base64')});
  await act('configure',{text:{baseURL:`http://127.0.0.1:${mock.address().port}/v1`,key:'synthetic',model:'mock'}});
  p=await act('setConcurrency',{limit:2});assert.equal(p.executionConcurrency,2);
  await act('analyzeMaterials');await wait();assert.equal(peak,2);assert.equal(p.task.jobs.length,2);assert.equal(p.task.jobs.filter(j=>j.status==='failed').length,1);assert.equal(p.task.status,'failed');assert.match(p.task.message,/second.txt/);assert.equal(p.analysisDraft.readings.length,1);assert.equal(p.analysisResumeCount,1);assert.equal(p.analysis,null);
  const ui=materialPanel(p,()=>'',[],'');assert.match(ui,/继续识别材料/);assert.match(ui,/已保存 1 份已读材料/);
  fs.writeFileSync(path.join(dir,'failure-checkpoint.json'),JSON.stringify(p,null,2));
  fail=false;await act('analyzeMaterials');await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(counts.first,1);assert.equal(counts.second,2);assert.equal(p.analysisDraft,null);assert.ok(p.task.progress.some(e=>e.message.includes('已复用')));
  fail=true;peak=0;await act('setConcurrency',{limit:1});await act('analyzeMaterials');await wait();assert.equal(p.task.status,'failed');assert.equal(peak,1);const before=counts.first;
  await act('requirements',{brief:{...p.brief,title:'修改需求'}});assert.equal((await call(prefix)).analysisDraft,null);
  fail=false;await act('analyzeMaterials');await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(counts.first,before+1);
  const saved=fs.readFileSync(path.join(dir,p.id,'project.json'),'utf8');assert.ok(!saved.includes('Bearer'));
});
