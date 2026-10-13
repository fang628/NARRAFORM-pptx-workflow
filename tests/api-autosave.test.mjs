import test from 'node:test';
import assert from 'node:assert/strict';
import {apiTypes,apiConfigurationPlan,createAPIAutosave} from '../public/api-config.js';
const blanks=()=>Object.fromEntries(apiTypes.map(type=>[type,{baseURL:'',model:'',key:''}]));
const configured={baseURL:'https://example.com/v1',model:'main-model'};
test('通道独立保存：不完整选填项不阻塞主模型，不覆盖旧配置，改模型须重填密钥',()=>{
  const values=blanks();values.text={...configured,key:'synthetic'};values.image={baseURL:'https://images.example.com/v1',model:'',key:''};
  const p={provider:{},apiReady:false};let plan=apiConfigurationPlan(values,p);assert.deepEqual(Object.keys(plan.payload),['text']);assert.deepEqual(plan.pending,['生图模型']);
  p.provider={text:configured,image:{baseURL:values.image.baseURL,model:'old-image'}};p.apiReady=true;values.text.key='';
  plan=apiConfigurationPlan(values,p);assert.deepEqual(plan.payload,{});assert.deepEqual(plan.pending,['生图模型']);
  values.text.model='new-model';plan=apiConfigurationPlan(values,p);assert.ok(!plan.payload.text);assert.ok(plan.pending.includes('主模型'));
  values.text={...configured,key:''};values.image={baseURL:'',model:'',key:''};assert.equal(apiConfigurationPlan(values,p).payload.image,null);
  p.apiReady=false;assert.deepEqual(apiConfigurationPlan(values,p).payload,{});
  p.apiReady=true;p.rebuildReady=true;p.rebuildConfigured=false;p.provider.rebuild={baseURL:'https://vision.example.com/v1',model:'vision'};values.rebuild={...p.provider.rebuild,key:''};
  plan=apiConfigurationPlan(values,p);assert.ok(plan.pending.includes('高性能视觉模型'));assert.ok(!plan.payload.rebuild);
});

test('保存中继续修改会串行保存最新值；失败显示错误且可手动重试',async()=>{
  let p={id:'project',provider:{},apiReady:false},values=blanks(),calls=[],release,entered,states=[];
  values.text={...configured,key:'first-key'};
  const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const saver=createAPIAutosave({read:()=>({project:structuredClone(p),values:structuredClone(values)}),blocked:()=>false,state:(kind,message)=>states.push({kind,message}),
    save:async(id,payload)=>{calls.push(structuredClone(payload));if(calls.length===1){entered();await gate;}return {id,provider:{text:{baseURL:payload.text.baseURL,model:payload.text.model}},apiReady:true};},
    applied:(result,snapshot)=>{p=result;if(values.text.key===snapshot.values.text.key)values.text.key='';}
  },10000);
  const first=saver.flush();await started;values.text.key='latest-key';saver.schedule();release();await first;
  assert.equal(calls.length,2);assert.equal(calls[0].text.key,'first-key');assert.equal(calls[1].text.key,'latest-key');assert.equal(states.at(-1).kind,'saved');saver.reset();
  let fail=true;values.text.key='retry-key';
  const failed=createAPIAutosave({read:()=>({project:p,values}),blocked:()=>false,state:(kind)=>states.push({kind}),save:async()=>{if(fail)throw Error('网络断开');return p;},applied:()=>values.text.key=''});
  await assert.rejects(failed.flush(),/网络断开/);assert.equal(states.at(-1).kind,'error');assert.equal(values.text.key,'retry-key');fail=false;await failed.flush();assert.equal(states.at(-1).kind,'saved');failed.reset();
});

test('停止输入触发自动保存；切换项目取消延迟任务，已保存配置不会重复请求',async()=>{
  let values=blanks(),p={id:'one',provider:{},apiReady:false},count=0,finish;
  const completed=new Promise(r=>finish=r);values.text={...configured,key:'synthetic'};
  const saver=createAPIAutosave({read:()=>({project:p,values}),blocked:()=>false,state:kind=>{if(kind==='saved')finish();},save:async()=>{count++;return {id:p.id,apiReady:true,provider:{text:configured}};},applied:result=>{p=result;values.text.key='';}},5);
  saver.schedule();await completed;assert.equal(count,1);await saver.flush();assert.equal(count,1);
  values.text.key='unsent';saver.schedule();saver.reset();p={id:'two',apiReady:false,provider:{}};await new Promise(r=>setTimeout(r,15));assert.equal(count,1);saver.reset();
});
