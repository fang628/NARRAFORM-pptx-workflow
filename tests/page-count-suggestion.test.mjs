import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {optionalPageCount,suggestPageCount} from '../lib/page-count.mjs';
import {materialPanel} from '../public/materials.js';
import {synthesizeMaterials} from '../lib/material-synthesis.mjs';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';

test('目标页数可留空，建议缺失或格式错误不影响理解，页数仍在1至30内',()=>{
  for(const value of [undefined,null,'','  '])assert.equal(optionalPageCount(value),null);
  for(const value of [0,31,-1,1.5,'abc'])assert.throws(()=>optionalPageCount(value),/页数/);
  assert.equal(optionalPageCount('1'),1);
  const options={brief:{cover:true,toc:true},outline:[{title:'背景'},{title:'结果'}],readings:[{readChars:6400,keyPoints:['甲','乙']}]};
  assert.equal(suggestPageCount(null,options).pages,6);
  assert.equal(suggestPageCount({pages:999,reason:'错误'},options).source,'estimate');
  assert.equal(suggestPageCount(null,{...options,readings:[{readChars:100000}]}).pages,30);
  assert.deepEqual(suggestPageCount({pages:1},options),{pages:1,source:'model'});
  assert.deepEqual(suggestPageCount({pages:3,reason:'旧接口理由'},options),{pages:3,source:'model'});
});

test('材料综合整理在同一次模型调用中建议页数，保留用户页数与旧接口兼容',async()=>{
  for(const requested of [null,9])for(const recommendation of [undefined,{pages:5}]){
    let calls=0;const brief={title:'演示',pages:requested,toc:true};
    const {synthesis}=await synthesizeMaterials({brief,system:'JSON',readings:[{id:'doc',keyPoints:['结果']}],materials:[{id:'doc',name:'报告'}],call:async(c,s,prompt)=>{
      calls++;assert.match(prompt,/pageCountSuggestion/);assert.match(prompt,/包含已选标题页、目录与致谢/);
      return {text:JSON.stringify({summary:'报告综述',outline:[{title:'背景',sourceIds:['doc']}],questions:[],pageCountSuggestion:recommendation})};
    }});
    assert.equal(calls,1);assert.equal(brief.pages,requested);assert.equal(synthesis.pageCountSuggestion.pages,recommendation?5:3);
    assert.equal(synthesis.pageCountSuggestion.reason,undefined);
  }
});

test('真实HTTP：空页数创建→理解建议→修改/采用→精确生成，单页与旧项目兼容',async t=>{
  let synthesisCalls=0,readingCalls=0;const contentCounts=[];
  const mock=http.createServer(async(req,res)=>{
    const body=await fixtureRequest(req),message=body.messages?.at(-1)?.content;
    const prompt=typeof message==='string'?message:message?.[0]?.text||'';
    let result;
    if(prompt.includes('识别与理解单份材料')){readingCalls++;result={category:'报告',summary:'项目背景和实验结果',keyPoints:['背景','结果'],facts:[],suggestedUse:'内容页',questions:[]};}
    else if(prompt.includes('汇总材料理解')){synthesisCalls++;const readings=JSON.parse(prompt.split('材料理解：')[1]);result={summary:'项目背景和结果汇总',outline:[{title:'背景与结果',sourceIds:[readings[0].id]}],questions:[],pageCountSuggestion:{pages:4}};}
    else if(prompt.startsWith('根据材料写恰好')){
      const count=Number(prompt.match(/恰好 (\d+) 页/)[1]);contentCounts.push(count);
      result={slides:Array.from({length:count},(_,i)=>({kind:i===0&&prompt.includes('第1页')?'cover':'content',title:'展示'+(i+1),body:[],sources:[]}))};
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify(result?{choices:[{message:{content:JSON.stringify(result)}}]}:fixtureReply(body)));
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:path.resolve('work','page-count-suggestion-'+Date.now()),PPT_AGENT_TEST:'1'},stdio:'ignore',windowsHide:true});t.after(()=>app.kill());
  const base='http://127.0.0.1:'+port;
  for(let i=0;i<200;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{
    const res=await fetch(base+url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const result=await res.json();assert.equal(res.status,status,JSON.stringify(result));return result;
  };
  let p=await call('/api/projects',{brief:{title:'页数建议',pages:'',cover:false,toc:true,thanks:true}},201);
  assert.equal(p.brief.pages,null);assert.equal(p.brief.toc,true);assert.equal(p.brief.thanks,true);
  const prefix='/api/projects/'+p.id,act=(action,b={},status=200)=>call(prefix+'/action',{action,...b},status);
  const wait=async()=>{for(let i=0;i<800;i++){p=await call(prefix);if(p.task?.status!=='running'){assert.equal(p.task.status,'done',p.task.message);return;}await new Promise(r=>setTimeout(r,20));}throw Error('任务超时');};
  await act('configure',{text:{baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'mock',key:'synthetic'}});
  p=await call(prefix+'/materials',{name:'报告.txt',base64:Buffer.from('项目背景与结果。').toString('base64')});
  p=await act('requirements',{brief:p.brief});await act('analyzeMaterials');await wait();
  assert.equal(p.brief.pages,4);assert.equal(p.analysis.pageCountSuggestion.pages,4);assert.equal(p.analysisCurrent,true);
  assert.equal(p.analysis.pageCountSuggestion.reason,undefined);
  assert.doesNotMatch(materialPanel(p,()=>'',[],''),/analysis-page-count|analysisPages|建议 4 页/);
  await act('approveAnalysis',{pages:0},400);p=await call(prefix);assert.equal(p.brief.pages,4);
  p=await act('approveAnalysis',{pages:3});assert.equal(p.brief.pages,3);assert.equal(p.analysisCurrent,true);assert.ok(p.analysis.approvedAt);
  await act('content');await wait();assert.equal(p.slides.length,3);assert.deepEqual(contentCounts,[3]);
  // Editing only the page count keeps the already-read materials current.
  p=await act('requirements',{brief:{...p.brief,pages:1}});assert.equal(p.analysisCurrent,true);assert.ok(p.analysis.approvedAt);assert.equal(p.brief.toc,false);assert.equal(p.brief.thanks,false);
  await act('content');await wait();assert.equal(p.slides.length,1);assert.deepEqual(contentCounts,[3,1]);assert.equal(synthesisCalls,1);assert.equal(readingCalls,1);
  // Blank can be restored and the suggestion adopted without a second understanding call.
  p=await act('requirements',{brief:{...p.brief,pages:null}});p=await act('approveAnalysis');assert.equal(p.brief.pages,4);assert.equal(p.analysisCurrent,true);
  // Existing explicit targets remain explicit when accepting analysis.
  p=await act('requirements',{brief:{...p.brief,pages:7}});await act('analyzeMaterials');await wait();assert.equal(p.brief.pages,7);assert.equal(p.analysisCurrent,true);p=await act('approveAnalysis');assert.equal(p.brief.pages,7);
  // Non-pagination requirement changes still invalidate material understanding.
  p=await act('requirements',{brief:{...p.brief,title:'新主题'}});assert.equal(p.analysisCurrent,false);
});
