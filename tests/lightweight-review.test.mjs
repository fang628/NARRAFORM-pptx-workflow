import test from 'node:test';
import assert from 'node:assert/strict';
import {partitionVisualIssues,previewReviewConclusion} from '../lib/lightweight-review.mjs';
import {applicableDesignChecks} from '../lib/design-rules.mjs';

test('轻微审美意见只记录，严重遮挡与多余占位框仍须处理',()=>{
  const result=partitionVisualIssues(['轻微色调偏差','渐变不够克制','装饰遮挡了正文','存在多余图片占位框']);
  assert.deepEqual(result.warnings,['轻微色调偏差','渐变不够克制']);
  assert.deepEqual(result.issues,['装饰遮挡了正文','存在多余图片占位框']);
});

test('装饰和学术填充不单独否决预览，实际原图损坏仍不通过',()=>{
  const p={brief:{progress:false},slides:[{kind:'content',title:'测试'}],materials:[]};
  const keys=applicableDesignChecks(p,0);
  assert.ok(!keys.includes('academic_fill'));assert.ok(!keys.includes('restrained_decoration'));
  const checks={academic_fill:false,restrained_decoration:false,reason:'新增装饰过多，存在渐变'};
  const review={passed:false,issues:[],notes:'装饰可精简'};
  const result=previewReviewConclusion(review,checks,keys);
  assert.deepEqual(result.issues,[]);assert.ok(result.warnings.length);
  checks.image_integrity=false;checks.reason='原图被裁切，重要图例缺失';
  assert.ok(previewReviewConclusion(review,checks,keys).issues.length);
});
