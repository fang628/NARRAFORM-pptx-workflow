import test from 'node:test';
import assert from 'node:assert/strict';
import {placeholderReport,placeholderCorrectionPrompt,repairPlaceholders} from '../lib/placeholder-review.mjs';
import {fittedImagePlans} from '../lib/image-geometry.mjs';
const image=(factor=1)=>({nodeId:'figure',id:'original',label:'结果配图',x:1000,y:120,w:400*factor,h:200,aspect:2});

test('占位框按相对比例判断，2%边界内合格，未知比例不虚报通过',()=>{
  assert.equal(placeholderReport([image(1.02)])[0].passed,true);
  assert.equal(placeholderReport([image(.98)])[0].passed,true);
  assert.equal(placeholderReport([image(1.021)])[0].passed,false);
  assert.equal(placeholderReport([image(.979)])[0].passed,false);
  assert.throws(()=>placeholderReport([{...image(),aspect:undefined}]),/有效比例/);
  const once=placeholderCorrectionPrompt(placeholderReport([image(1.4)]));
  const twice=placeholderCorrectionPrompt(placeholderReport([image(1.2)]));
  assert.equal(twice.split('【占位框比例修正】').length,2);
  assert.ok(once.startsWith('【占位框比例修正】'));assert.ok(twice.startsWith('【占位框比例修正】'));assert.doesNotMatch(twice,/完整任务|用户修改保留|2.800:1/);assert.match(twice,/图片2是对应底图/);assert.match(twice,/改为 2.000:1/);
  const single=placeholderCorrectionPrompt(placeholderReport([image(1.2)]),{foundation:false});assert.doesNotMatch(single,/图片2/);assert.match(single,/随附图片/);
});

test('先复查再决定修正，比例接近即停止；最多2次修正后放行贴回',async()=>{
  for(const [ratios,attempts,status] of [[[1.4,1.02],1,'passed'],[[1.3,1.3,1.3],2,'exhausted'],[[1.01],0,'passed']]){
    const order=[],signal=new AbortController().signal;
    const r=await repairPlaceholders({initial:0,signal,inspect:async n=>{order.push('inspect'+n);return [image(ratios[n])];},regenerate:async(n,checks,attempt)=>{assert.equal(checks[0].passed,false);order.push('repair'+attempt);return attempt;}});
    assert.equal(r.review.attempts,attempts);assert.equal(r.review.limit,2);assert.equal(r.review.status,status);assert.equal(r.review.history.length,attempts+1);
    assert.equal(order[0],'inspect0');assert.equal(order.at(-1),'inspect'+attempts);
    assert.equal(r.candidate,attempts);assert.equal(r.images[0].w,400*ratios.at(-1));
  }
});

test('占位框2%检查与原图铺满分离，修框上限之后仍按实际框贴满',async()=>{
  const r=await repairPlaceholders({initial:0,inspect:async()=>[image(1.04)],regenerate:async(_,checks,attempt)=>attempt});
  assert.equal(r.review.status,'exhausted');assert.equal(r.review.attempts,2);assert.equal(r.review.tolerance,.02);assert.equal(r.review.checks[0].passed,false);
  const [fit]=fittedImagePlans(r.images);assert.equal(fit.imageFit,'fill');assert.ok(Math.abs(fit.aspectAdjustment-.04)<1e-9);assert.equal(fit.w,r.images[0].w);assert.equal(fit.h,r.images[0].h);
});

test('无原图跳过检查；取消或测量失败不放行合成',async()=>{
  const r=await repairPlaceholders({initial:0,inspect:async()=>[],regenerate:()=>assert.fail('不应生图')});assert.equal(r.review.status,'not_needed');
  const c=new AbortController();let inspections=0;
  await assert.rejects(repairPlaceholders({initial:0,signal:c.signal,inspect:async()=>{inspections++;return [image(1.4)];},regenerate:async()=>{c.abort();return 1;}}),/abort/i);assert.equal(inspections,1);
  await assert.rejects(repairPlaceholders({initial:0,inspect:async()=>{throw Error('测量失败');},regenerate:()=>assert.fail('不能猜测占位位置')}),/测量失败/);
});

test('修正生图失败时沿用上张已定位底稿，不中断贴回或虚报比例通过',async()=>{
  let calls=0;const progress=[];
  const result=await repairPlaceholders({initial:'saved-image',inspect:async()=>[image(1.4)],regenerate:async()=>{calls++;throw Error('生图响应未包含有效图片，重试耗尽');},progress:(state,message)=>progress.push(message)});
  assert.equal(calls,1);assert.equal(result.candidate,'saved-image');assert.equal(result.review.status,'fallback');assert.equal(result.review.attempts,1);assert.equal(result.review.checks[0].passed,false);assert.match(result.review.error,/未包含有效图片/);assert.match(progress.at(-1),/上一张已定位底稿/);
  const measured=await repairPlaceholders({initial:0,inspect:async n=>{if(n===1)throw Error('新图定位响应无效');return [image(1.3)];},regenerate:async()=>1});
  assert.equal(measured.candidate,0);assert.equal(measured.review.status,'fallback');assert.match(measured.review.error,/定位/);
  const c=new AbortController();await assert.rejects(repairPlaceholders({initial:0,signal:c.signal,inspect:async()=>[image(1.3)],regenerate:async()=>{c.abort();throw Error('已取消');}}),/取消/);
});
