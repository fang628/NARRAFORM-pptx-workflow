import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {alignContentPageCount} from '../lib/content-page-count.mjs';
import {contentPageCountNotice} from '../public/page-design.js';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';
const slide=title=>({kind:'content',title,body:['材料支持的内容'],sources:[]});

test('少页只插入缺页，准确保留已有内容树、原图、图注及来源',async()=>{
  const original=[{...slide('封面'),kind:'cover',elements:[{id:'title',role:'title',text:'封面'}],sourceLinks:[{materialId:'m',target:'title',excerptId:'E0001'}]}, {...slide('内容'),imageId:'original-image'}],before=structuredClone(original);
  let calls=0;
  const actual=await alignContentPageCount({slides:original,expected:4,structure:'包含封面和目录，总页数包含所有页面。',request:async prompt=>{
    calls++;assert.match(prompt,/仅补 2 个缺页/);assert.match(prompt,/最终页序/);
    return {insertions:[{index:3,slide:slide('补充内容')},{index:1,slide:{...slide('目录'),kind:'toc'}}]};
  }});
  assert.equal(calls,1);assert.equal(actual.length,4);assert.deepEqual(actual[0],before[0]);assert.deepEqual(actual[2],before[1]);assert.deepEqual(original,before);
  assert.equal(actual[1].kind,'toc');
});

test('多页必须完整覆盖原页，不能通过截取数组或漏页凑数量',async()=>{
  const original=Array.from({length:5},(_,i)=>slide('主题'+i));let attempts=0;
  const result=await alignContentPageCount({slides:original,expected:3,request:async prompt=>{
    assert.match(prompt,/不直接截去末尾页/);attempts++;
    return {slides:[slide('合并一'),slide('合并二'),slide('合并三')],sourceCoverage:[{targetIndex:0,sourceIndices:[0,1]},{targetIndex:1,sourceIndices:[2]},{targetIndex:2,sourceIndices:attempts===1?[3]:[3,4]}]};
  }});
  assert.equal(attempts,2);assert.equal(result.length,3);assert.equal(original.length,5);
});

test('一致页数不增加请求；持续错误最多修正两次并保留原稿，取消立即停止',async()=>{
  const originals=[slide('保留原稿')],states=[];let calls=0;
  await alignContentPageCount({slides:originals,expected:1,request:()=>{throw Error('不应调用');}});
  await assert.rejects(alignContentPageCount({slides:originals,expected:3,onState:s=>states.push(s),request:async()=>{calls++;return {insertions:[{index:3,slide:slide('越界')},{index:3,slide:slide('重复')} ]};}}),error=>error.code==='CONTENT_PAGE_COUNT_MISMATCH');
  assert.equal(calls,2);assert.equal(states.at(-1).status,'failed');assert.deepEqual(states.at(-1).slides,originals);
  const controller=new AbortController();calls=0;
  await assert.rejects(alignContentPageCount({slides:originals,expected:2,signal:controller.signal,request:async()=>{calls++;controller.abort();return {insertions:[]};}}),{name:'AbortError'});
  assert.equal(calls,1);
});

test('01目标页数、02实际页数与未完成初稿状态可区分，不把部分结果当成功',()=>{
  const notice=contentPageCountNotice({brief:{pages:8},slides:[slide('旧内容')],contentDraftAvailable:true,contentPageCount:{actual:6,status:'failed'}});
  assert.match(notice,/实际 1 \/ 目标 8 页/);assert.match(notice,/初稿 6 页已保留，可继续调整/);
  assert.doesNotMatch(contentPageCountNotice({brief:{pages:1},slides:[slide('完整页')]}),/页数不一致/);
});

test('真实HTTP：缺页自动补齐；持续失败保留现有内容和初稿，重试从初稿继续，需求变化不用旧稿',async t=>{
  let mode='ok',initialCalls=0,repairCalls=0;
  const mock=http.createServer(async(req,res)=>{
    const b=await fixtureRequest(req),content=b.messages?.at(-1)?.content,prompt=typeof content==='string'?content:content?.[0]?.text||'';
    let response;
    if(prompt.includes('调整逐页内容的总页数。')){
      repairCalls++;const expected=Number(prompt.match(/目标恰好 (\d+) 页/)[1]);
      response={insertions:mode==='fail'?[]:Array.from({length:expected-1},(_,i)=>({index:i+1,slide:slide('补齐页'+i)}))};
    }else if(prompt.startsWith('根据材料写恰好')){initialCalls++;response={slides:[slide('初稿'+initialCalls)]};}
    const reply=response?{choices:[{message:{content:JSON.stringify(response)}}]}:fixtureReply(b);
    res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=path.resolve('work','content-page-count-'+Date.now()),base='http://127.0.0.1:'+port;
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:data,PPT_AGENT_TEST:'1'},stdio:'ignore',windowsHide:true});t.after(()=>app.kill());
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body)=>{const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const p=await r.json();assert.ok(r.ok,JSON.stringify(p));return p;};
  let p=await call('/api/projects',{brief:{title:'页数校正',pages:3,cover:false}});const prefix='/api/projects/'+p.id,act=(action,b={})=>call(prefix+'/action',{action,...b});
  const wait=async()=>{for(let i=0;i<600;i++){p=await call(prefix);if(p.task?.status!=='running')return p;await new Promise(r=>setTimeout(r,20));}throw Error('任务超时');};
  await act('configure',{text:{baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'mock',key:'synthetic'}});await act('requirements',{brief:p.brief});
  await act('content');await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(p.slides.length,3);assert.equal(p.slides[0].title,'初稿1');assert.equal(Object.keys(p.pageDesigns).length,3);assert.equal(initialCalls,1);assert.equal(repairCalls,1);
  const confirmed=structuredClone(p.slides);mode='fail';await act('content');await wait();assert.equal(p.task.status,'failed');assert.deepEqual(p.slides,confirmed);assert.equal(p.contentDraftAvailable,true);assert.equal(p.contentPageCount.actual,1);assert.equal(initialCalls,2);assert.equal(repairCalls,3);
  assert.equal(p.contentGenerationDraft,undefined,'原始未校验草稿不直接暴露为正式内容');
  const saved=JSON.parse(fs.readFileSync(path.join(data,p.id,'project.json'),'utf8'));assert.equal(saved.contentGenerationDraft.slides[0].title,'初稿2');
  mode='ok';await act('content');await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(initialCalls,2,'继续补页，不重写正确初稿');assert.equal(p.slides[0].title,'初稿2');assert.equal(p.slides.length,3);assert.equal(p.contentDraftAvailable,false);
  mode='fail';await act('content');await wait();const previous=initialCalls;assert.equal(p.contentDraftAvailable,true);
  await act('requirements',{brief:{...p.brief,pages:2}});p=await call(prefix);assert.equal(p.contentDraftAvailable,false);
  mode='ok';await act('content');await wait();assert.equal(p.task.status,'done',p.task.message);assert.equal(initialCalls,previous+1);assert.equal(p.slides.length,2);assert.equal(p.brief.pages,2);
});
