import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewRenderedPage,renderReviewSchema} from '../lib/render-review.mjs';
import {rebuildReviewLoop} from '../lib/rebuild-review-loop.mjs';

const project={brief:{progress:false},slides:[{kind:'cover',title:'示例页'}]};
const valid=()=>{const raw=JSON.parse(renderReviewSchema);for(const k of Object.keys(raw.checks))raw.checks[k]=true;for(const k of Object.keys(raw.designChecks))if(k!=='reason')raw.designChecks[k]=true;for(const k of ['aesthetics','layout','previewSimilarity'])raw.visualAssessment[k]=true;return raw;};
const run=options=>reviewRenderedPage({project,index:0,structure:{passed:true},...options});

test('渲染验收：说明文字、截断与缺字段有界纠正，保存每次原始返回',async()=>{
  for(const broken of ['只有说明文字','{"checks":','{"checks":{"visual":true},"notes":"看图依据"}']){
    const records=[],corrections=[];let calls=0;
    const review=await run({request:async correction=>{corrections.push(correction);return {text:calls++===0?broken:JSON.stringify(valid())};},record:r=>records.push(r)});
    assert.equal(review.passed,true);assert.equal(calls,2);assert.equal(review.responseValidation.attempts,1);assert.equal(records[0].response,broken);assert.equal(records[0].status,'invalid_response');assert.match(corrections[1],/同一组实际图片/);assert.match(corrections[1],/本次仅纠正验收返回格式/);
  }
});

test('渲染验收：最多两次纠正，完整输出但length截断标记也须重新核对',async()=>{
  let calls=0;const raw=valid();
  const review=await run({request:async()=>({text:JSON.stringify(raw),finishReason:++calls<3?'length':'stop'})});
  assert.equal(calls,3);assert.equal(review.passed,true);assert.equal(review.responseValidation.attempts,2);
});

test('渲染验收：持续无效时保留失败记录，禁止据此调用布局修正或放行',async()=>{
  let calls=0,repairs=0;const records=[];
  const unavailable=await run({request:async()=>{calls++;return {text:'返回始终不可解析'};},record:r=>records.push(r)});
  assert.equal(calls,3);assert.equal(records.length,3);assert.equal(unavailable.passed,false);assert.equal(unavailable.reviewUnavailable,true);assert.equal(unavailable.designChecks,null);
  const candidate=await rebuildReviewLoop({render:async()=>({id:'existing',review:{pages:[unavailable,{index:1,passed:true,issues:[]}]}}),repair:async()=>{repairs++;return {changed:true};}});
  assert.equal(repairs,0);assert.equal(candidate.visualRepair.status,'review_unavailable');assert.equal(candidate.review.pages[1].passed,true);
});

test('渲染验收：真实质量失败不会被当格式问题重试，字符串布尔不能默认为通过',async()=>{
  let calls=0;const raw=valid();raw.checks.visual=false;raw.designChecks.readability=false;raw.issues=['正文遮挡'];
  const review=await run({request:async()=>{calls++;return {text:JSON.stringify(raw)};}});
  assert.equal(calls,1);assert.equal(review.passed,false);assert(!review.reviewUnavailable);assert(review.issues.some(s=>s.includes('readability')));
  raw.checks.visual='true';calls=0;
  const malformed=await run({request:async()=>{calls++;return {text:JSON.stringify(raw)};}});assert.equal(calls,3);assert.equal(malformed.reviewUnavailable,true);
});

test('渲染验收：权限错误和取消直接停止；传输格式错误可纠正',async()=>{
  let calls=0;
  await assert.rejects(run({request:async()=>{calls++;throw Object.assign(Error('HTTP 401'),{httpStatus:401});}}),/401/);assert.equal(calls,1);
  const controller=new AbortController();controller.abort();await assert.rejects(run({signal:controller.signal,request:async()=>{calls++;}}));assert.equal(calls,1);
  const recovered=await run({request:async()=>{if(calls++===1)throw Object.assign(Error('HTTP 200 HTML'),{responseFormat:true});return {text:JSON.stringify(valid())};}});assert.equal(recovered.passed,true);assert.equal(calls,3);
});

test('渲染验收：合法外围说明与旧版无visualAssessment结果兼容，真实结构失败仍不通过',async()=>{
  const raw=valid();delete raw.visualAssessment;
  const review=await run({structure:{passed:false},request:async()=>({text:'结果如下：\n```json\n'+JSON.stringify(raw)+'\n```'})});
  assert.equal(review.passed,false);assert.equal(review.reviewUnavailable,undefined);assert.equal(review.checks.editability,false);assert.equal(review.visualAssessment.source,'legacy-checks');
});
