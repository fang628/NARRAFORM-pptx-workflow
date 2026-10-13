import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewAndRepair,visualRepairLimit} from '../lib/visual-repair.mjs';

const original=()=>({file:'original.png',jobFile:'original-job.json',prompt:'已确认标题与事实，16:9',images:[{id:'original-material'}],manualReview:{previewHash:'old'}});
function harness({passAt=1,generateError,reviewError,controller=new AbortController()}={}){
  let reviews=0,generations=0;const saved=[],logs=[],prompts=[];
  return {
    saved,logs,prompts,controller,get generations(){return generations;},get reviews(){return reviews;},
    options:{signal:controller.signal,
      review:async r=>{reviews++;if(reviewError)throw Error(reviewError);r.previewReview={status:reviews>=passAt?'passed':'needs_revision',issues:reviews>=passAt?[]:['文字被装饰遮挡']};},
      generate:async prompt=>{generations++;prompts.push(prompt);if(generateError)throw Error(generateError);return {file:`repair-${generations}.png`,jobFile:`repair-${generations}-job.json`,prompt,images:[{id:'original-material'}]};},
      save:async r=>saved.push(structuredClone(r)),progress:(status,message)=>logs.push({status,message})}
  };
}

test('通过的图片不重生；质量失败自动修正并保留非递归历史',async()=>{
  const a=harness(),good=original();assert.equal(await reviewAndRepair(good,a.options),good);assert.equal(a.generations,0);assert.ok(!good.autoRepair);
  const b=harness({passAt:3}),r=original();assert.equal(await reviewAndRepair(r,b.options),r);assert.equal(b.generations,2);assert.equal(b.reviews,3);assert.equal(r.autoRepair.status,'passed');assert.equal(r.autoRepair.attempts,2);assert.deepEqual(r.repairHistory.map(h=>h.file),['original.png','repair-1.png']);assert.ok(r.repairHistory.every(h=>!h.repairHistory&&!h.autoRepair));assert.ok(!r.manualReview);assert.equal(r.images[0].id,'original-material');assert.ok(b.saved.some(s=>s.file==='repair-1.png'&&!s.previewReview));assert.ok(b.prompts.every(p=>p.includes('文字被装饰遮挡')&&p.includes('不得编造图注')));assert.equal(b.prompts[1].split('【本步自动视觉修正】').length,2,'correction instructions do not accumulate');
});

test('持续失败达到两次上限，保留失败结论，不无限生图',async()=>{
  const h=harness({passAt:99}),r=original();await reviewAndRepair(r,h.options);assert.equal(h.generations,visualRepairLimit);assert.equal(r.autoRepair.status,'exhausted');assert.equal(r.previewReview.status,'needs_revision');assert.equal(r.repairHistory.length,2);assert.match(h.logs.at(-1).message,/停留在当前步骤/);
});

test('接口或检查解析失败不作为质量问题重试，保留最后可用图片',async()=>{
  const h=harness({passAt:99,generateError:'生图接口失败'}),r=original();await assert.rejects(reviewAndRepair(r,h.options),/生图接口失败/);assert.equal(h.generations,1);assert.equal(r.file,'original.png');assert.equal(r.autoRepair.status,'failed');assert.equal(r.previewReview.status,'needs_revision');
  const bad=harness({reviewError:'检查返回格式错误'});await assert.rejects(reviewAndRepair(original(),bad.options),/检查返回格式错误/);assert.equal(bad.generations,0);
});

test('修正已保存后复查失败或取消仍可查看新版与旧版',async()=>{
  for(const cancel of [false,true]){
    const h=harness({passAt:99}),r=original();let reviews=0;
    h.options.review=async page=>{if(reviews++){throw Error('复查失败');}page.previewReview={status:'needs_revision',issues:['文字重叠']};};
    const generate=h.options.generate;h.options.generate=async prompt=>{const next=await generate(prompt);if(cancel)h.controller.abort();return next;};
    await assert.rejects(reviewAndRepair(r,h.options),cancel?/取消/:/复查失败/);assert.equal(r.file,'repair-1.png');assert.equal(r.repairHistory[0].file,'original.png');assert.equal(r.autoRepair.status,cancel?'cancelled':'failed');assert.equal(h.generations,1);
  }
});
