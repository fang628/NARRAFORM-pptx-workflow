import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewPreviewImage} from '../lib/preview-review.mjs';
import {designCheckKeys} from '../lib/design-rules.mjs';
import {reviewAndRepair} from '../lib/visual-repair.mjs';
const project={brief:{progress:false},slides:[{kind:'cover',title:'测试'}]};
const valid=()=>({passed:true,issues:[],notes:'实际画面清晰完整',designChecks:{...Object.fromEntries(designCheckKeys.map(k=>[k,true])),reason:'实际看图没有明显问题'}});
const run=options=>reviewPreviewImage({project,index:0,...options});

test('成品检查缺布尔字段自动恢复，不重绘图片，保留每轮返回',async()=>{
  const history=[],requests=[];let calls=0;
  const result=await run({request:async correction=>{requests.push(correction);const raw=valid();if(calls++===0)delete raw.designChecks.readability;return {text:JSON.stringify(raw)};},record:entry=>history.push(entry)});
  assert.equal(calls,2);assert.equal(result.previewReview.status,'passed');assert.equal(history[0].status,'invalid_response');assert.match(requests[1],/不生成或修改图片/);
});

test('terminated 和只读超时错误可重试，仍无结果则保留图片并标记检查未完成',async()=>{
  for(const error of [Error('terminated'),new DOMException('timeout','TimeoutError')]){
    let calls=0;
    const result=await run({request:async()=>{calls++;throw error;}});
    assert.equal(calls,3);assert.equal(result.previewReview.status,'inconclusive');assert.equal(result.designChecks,null);assert.equal(result.history.length,3);
    let modifications=0;const record={file:'saved.png',previewHash:'saved-hash'};
    await reviewAndRepair(record,{review:async r=>Object.assign(r,result),generate:async()=>{modifications++;}});
    assert.equal(record.file,'saved.png');assert.equal(record.previewHash,'saved-hash');assert.equal(modifications,0);
  }
});

test('部分检查失败时保存明确结论，缺失项保持未知，不能补成通过',async()=>{
  const raw=valid();delete raw.designChecks.readability;raw.designChecks.image_integrity=false;raw.issues=['原图标签被裁切'];
  const result=await run({request:async()=>({text:JSON.stringify(raw)})});
  assert.equal(result.previewReview.status,'inconclusive');assert.equal(result.designChecks.image_integrity,false);assert.equal(result.designChecks.readability,null);assert.ok(result.previewReview.issues.includes('原图标签被裁切'));
});

test('明确字符串布尔可兼容，真实质量问题仍保留，用户取消立即停止',async()=>{
  const raw=valid();raw.passed='false';raw.designChecks.readability='false';raw.issues=['正文被图片遮挡'];
  const result=await run({request:async()=>({text:JSON.stringify(raw)})});assert.equal(result.previewReview.status,'needs_revision');assert.equal(result.designChecks.readability,false);
  const c=new AbortController();c.abort();let calls=0;await assert.rejects(run({signal:c.signal,request:async()=>{calls++;}}));assert.equal(calls,0);
});
