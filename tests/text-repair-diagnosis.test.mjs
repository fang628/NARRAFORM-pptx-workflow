import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chat} from '../lib/provider.mjs';
import {textFieldValidator} from '../lib/text-retry.mjs';
import {generatePageDesign,validatePageDesign} from '../lib/page-design.mjs';
import {fixtureReply} from './visual-fixture.mjs';
import {runModelTools} from '../lib/model-tools.mjs';
import {observeTask} from '../lib/task-progress.mjs';

const project=()=>({id:'repair',brief:{title:'模拟修正',pages:1,cover:false},slides:[{kind:'content',title:'准确标题',body:['准确正文'],sources:[]}],materials:[],pageDesigns:{}});
const design=prompt=>JSON.parse(fixtureReply({messages:[{role:'user',content:prompt}]}).choices[0].message.content);
async function mock(t,handle){
  const old=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';const calls=[];
  const server=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));calls.push(body);res.setHeader('content-type','application/json');await handle(res,body,calls.length);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();if(old===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=old;});
  return {calls,config:{baseURL:'http://127.0.0.1:'+server.address().port+'/v1',model:'mock',key:'synthetic'}};
}
const answer=(res,value,extra={})=>res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)},...extra}]}));

test('缺字段后只明确修正该字段，并提供上一版有效字段，原始输入保持不变',async t=>{
  const {config,calls}=await mock(t,(res,b,n)=>answer(res,n===1?{prompt:null,kept:'已有效字段'}:{prompt:'完整提示词',kept:'已有效字段'}));
  const signal=new AbortController().signal,logs=[];observeTask(signal,e=>logs.push(e));
  const result=await chat(config,'输出 JSON','原始材料和要求',signal,{validate:textFieldValidator('prompt')});
  assert.equal(result.value.kept,'已有效字段');assert.equal(calls.length,2);
  assert.match(calls[1].messages[0].content,/补齐 prompt 字段.*不能为 null/);
  assert.match(calls[1].messages[0].content,/已有效字段/);
  assert.equal(calls[1].messages[1].content,'原始材料和要求');
  assert.match(logs.find(e=>e.kind==='retry').message,/定位：.*prompt.*处理：补齐 prompt/);
});

test('设计稿准确定位缺失ID、阅读顺序和节点字段，保留上一版正确设计',async()=>{
  for(const fault of ['missing','order','field']){
    const p=project();let count=0,original,missing;
    const result=await generatePageDesign(p,0,{config:{},request:async(c,s,prompt)=>{
      const raw=design(prompt);count++;
      if(count===1){
        original=structuredClone(raw);
        if(fault==='missing'){missing=raw.nodes.pop().id;}
        if(fault==='order')raw.readingOrder.reverse();
        if(fault==='field')raw.nodes[0].alignment=null;
      }else{
        assert.match(prompt,/待修正模型输出/);
        if(fault==='missing')assert.ok(prompt.includes('补齐缺失节点 '+JSON.stringify([missing])));
        if(fault==='order')assert.ok(prompt.includes('把 readingOrder 改为 '+JSON.stringify(original.readingOrder)));
        if(fault==='field')assert.ok(prompt.includes('nodes['+original.nodes[0].id+'].alignment'));
      }
      return {text:JSON.stringify(raw)};
    }});
    assert.equal(count,2);assert.deepEqual(result.plan,original);assert.equal(result.generation.history[0].category,'schema');assert.ok(result.generation.history[0].action);
  }
  assert.throws(()=>validatePageDesign({nodes:[null]},[{id:'title'}]),e=>e.textValidation&&e.repairInstruction.includes('title'));
});

test('截断后增加输出额度和紧凑输出；中转拒绝长度参数时主动移除，仍限三次',async t=>{
  const {config,calls}=await mock(t,(res,b,n)=>{
    if(n===1){res.end(JSON.stringify({choices:[{message:{content:'{"prompt":"未结束'},finish_reason:'length'}],usage:{completion_tokens:4096}}));return;}
    if(n===2){res.statusCode=400;res.end(JSON.stringify({error:{param:'max_tokens',message:'Unsupported parameter max_tokens'}}));return;}
    answer(res,{prompt:'第三次完整返回'});
  });
  const result=await chat(config,'输出 JSON','原始要求',undefined,{validate:textFieldValidator('prompt')});
  assert.equal(result.value.prompt,'第三次完整返回');assert.equal(calls.length,3);
  assert.equal(calls[0].max_tokens,undefined);assert.equal(calls[1].max_tokens,8192);assert.equal(calls[2].max_tokens,undefined);
  assert.match(calls[1].messages[0].content,/紧凑的完整 JSON/);assert.doesNotMatch(calls[1].messages[0].content,/可额外提供 executionSummary/);
  assert.match(calls[2].messages[0].content,/移除不兼容/);
});

test('单页设计自管重试时也针对截断提高额度，不叠加通用重试',async()=>{
  const p=project(),options=[];
  const result=await generatePageDesign(p,0,{config:{},request:async(c,s,prompt,signal,o)=>{
    options.push(o);return options.length===1?{text:'{"purpose":',finishReason:'length',usage:{completion_tokens:5000}}:{text:JSON.stringify(design(prompt))};
  }});
  assert.equal(result.generation.attempt,1);assert.equal(options.length,2);assert.equal(options[1].outputTokenBudget,10000);assert.ok(options.every(o=>o.retryLimit===0));
});

test('工具轮输出说明文字后修复协议，上一轮已执行工具不重复',async t=>{
  const {config,calls}=await mock(t,(res,b,n)=>{
    if(n===1){res.end(JSON.stringify({choices:[{message:{tool_calls:[{id:'one',function:{name:'inspect',arguments:'{}'}}]}}]}));return;}
    if(n===2){res.end(JSON.stringify({choices:[{message:{content:'只给说明文字，未给工具JSON'}}]}));return;}
    answer(res,{done:true,summary:'已完成'});
  });
  let executed=0;const result=await runModelTools({config,system:'JSON',content:'核对一页',tools:[{type:'function',function:{name:'inspect'}}],execute:async()=>{executed++;return {output:{ok:true}};}});
  assert.equal(executed,1);assert.equal(calls.length,3);assert.equal(result.history.length,1);
  assert.match(calls[2].messages[0].content,/当前轮修正要求/);assert.ok(calls[2].messages.some(m=>m.tool_call_id==='one'));
});
