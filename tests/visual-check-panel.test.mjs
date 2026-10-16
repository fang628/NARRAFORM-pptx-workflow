import test from 'node:test';
import assert from 'node:assert/strict';
import {pageCheckPanel} from '../public/visual-ui.js';
const p={id:'project',version:1,task:{status:'failed'},conceptReadiness:{},placeholderRatioTolerance:.05};

test('整页待检查时仍展示已完成的提示词和比例检查结果',()=>{
  const r={index:0,previewReview:{status:'pending',issues:[]},promptCheck:{status:'passed',issues:[]},placeholderReview:{status:'exhausted',attempts:2,limit:2,tolerance:.05,checks:[{label:'配图',expectedAspect:2,observedAspect:1.5,relativeError:.25,passed:false}]}};
  const html=pageCheckPanel(p,r,'concept','a');
  for(const text of ['部分检查完成 · 整页待检查','发送前提示词检查 · 已通过','已达修正上限','2.000:1','1.500:1','25.0%','已有修正记录，暂无保存的完整修改提示词'])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/本步检查 · 已通过/);
});

test('仅展示实际修正指令，恶意文本不能逃出只读输入框',()=>{
  const prompt='只调整占位框 </textarea><script>alert(1)</script>';
  const r={index:0,normalized:'image.png',previewReview:{status:'needs_revision',issues:['正文被图片遮挡'],warnings:['轻微色调偏差']},designChecks:{readability:false,image_integrity:true},generationAttempts:[{attempt:0,prompt:'完整旧设计'},{attempt:1,prompt,status:'failed'}]};
  const html=pageCheckPanel(p,r,'concept','a');
  assert.match(html,/占位框修正第 1 次 · 请求失败（实际发送）/);
  assert.doesNotMatch(html,/建议修改提示词|基于当前图片，仅修改以下问题/);
  assert.match(html,/文字可读性/);assert.match(html,/需调整/);
  assert.match(html,/textarea readonly/);assert.match(html,/&lt;\/textarea&gt;&lt;script&gt;/);
  assert.doesNotMatch(html,/<script>|完整旧设计/);
});

test('原图本地几何调整可查看实际指令，04保持只展示问题',()=>{
  const r={index:0,previewReview:{status:'passed',issues:[]},geometryAdjustment:{prompt:'只移动原图，不修改底稿。'},repairHistory:[]};
  assert.match(pageCheckPanel(p,r,'concept','a'),/只移动原图，不修改底稿/);
  assert.doesNotMatch(pageCheckPanel(p,r,'full'),/修改提示词|整页图片检查/);
});
