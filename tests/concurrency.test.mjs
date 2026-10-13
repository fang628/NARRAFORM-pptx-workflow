import test from 'node:test';
import assert from 'node:assert/strict';
import {runConcurrent,createRequestGate,concurrencyLimit} from '../lib/concurrency.mjs';
import {observeTask,recordProgress,reportTask} from '../lib/task-progress.mjs';
import {taskProgress} from '../public/task-progress.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('并发上限、输入顺序、子任务归属和失败后等待在途任务',async()=>{
  const controller=new AbortController(),task={},gates=Array.from({length:4},deferred),entered=Array.from({length:4},deferred);let active=0,peak=0,ended=false;
  const stop=observeTask(controller.signal,e=>recordProgress(task,e));
  const pending=runConcurrent([0,1,2,3],async n=>{active++;peak=Math.max(peak,active);entered[n].resolve();await gates[n].promise;reportTask(controller.signal,{kind:'summary',message:'依据 '+n});active--;if(n===1)throw Error('合成失败');return n;},{signal:controller.signal,limit:2,label:n=>'第 '+n+' 页',settle:true}).then(r=>{ended=true;return r;});
  await Promise.all([entered[0].promise,entered[1].promise]);assert.equal(active,2);assert.equal(task.jobs.filter(j=>j.status==='queued').length,2);
  gates[1].resolve();await entered[2].promise;assert.equal(ended,false);gates[2].resolve();await entered[3].promise;gates[3].resolve();gates[0].resolve();
  const result=await pending;assert.equal(peak,2);assert.equal(active,0);assert.deepEqual(result.map(r=>r.status),['fulfilled','rejected','fulfilled','fulfilled']);assert.equal(result[3].value,3);
  for(let n=0;n<4;n++){const job=task.jobs.find(j=>j.message==='第 '+n+' 页');assert.ok(task.progress.some(e=>e.jobId===job.id&&e.message==='依据 '+n));}
  assert.match(taskProgress({...task,status:'done',label:'并行验证',startedAt:new Date().toISOString()}),/并发上限 2/);stop();
});
test('取消排队任务，不启动新工作；请求额度可取消且及时释放',async()=>{
  const controller=new AbortController(),gate=deferred(),entered=deferred(),task={};let calls=0;
  const stop=observeTask(controller.signal,e=>recordProgress(task,e));
  const pending=runConcurrent([0,1,2],async()=>{calls++;entered.resolve();await gate.promise;},{signal:controller.signal,limit:1});await entered.promise;controller.abort();gate.resolve();await assert.rejects(pending,/取消/);assert.equal(calls,1);assert.ok(task.jobs.every(j=>j.status==='cancelled'));stop();
  const acquire=createRequestGate(1),release=await acquire(),abort=new AbortController(),waiting=acquire(abort.signal);abort.abort();await assert.rejects(waiting,/取消/);release();const release2=await acquire();release2();release2();
  assert.equal(concurrencyLimit(),3);assert.throws(()=>concurrencyLimit(7),/1–6/);assert.throws(()=>concurrencyLimit(1.5),/1–6/);
});
