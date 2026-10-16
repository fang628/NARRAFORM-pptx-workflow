import test from 'node:test';
import assert from 'node:assert/strict';
import {previewApprovalState,previewApprovalRecord} from '../lib/preview-approval.mjs';
import {pageDesignStamp} from '../lib/page-design.mjs';
import {pageStamp} from '../lib/visual-model.mjs';
import {designCheckKeys,designPolicyVersion} from '../lib/design-rules.mjs';
import {visualPreview,previewApprovalDialogContent} from '../public/visual-ui.js';

function fixture(status='needs_revision'){
  const p={id:'fixture',version:1,visualMode:'ai',selectedTheme:'a',brief:{cover:true,progress:false,toc:false,pages:1},materials:[],slides:[{kind:'cover',title:'预览确认',body:[],sources:[]}],approvals:{content:1},concepts:[{id:'a',style:'浅灰编辑'}],pageDesigns:{},visualPages:{}};
  p.pageDesigns[0]={draftStamp:pageDesignStamp(p,0),approvedAt:'approved',markdown:'已确认设计'};
  p.visualPages[0]={stamp:pageStamp(p,0),previewHash:'current-image-hash',file:'preview.png',previewReview:{status,issues:status==='passed'?[]:['装饰过量']},designChecks:{...Object.fromEntries(designCheckKeys.map(k=>[k,true])),policyVersion:designPolicyVersion,restrained_decoration:status==='passed',reason:'合成检查'},review:{passed:status==='passed',issues:status==='passed'?[]:['装饰过量'],notes:'看图检查记录'}};
  return p;
}

test('检查未通过、失败或未完成可明确确认继续，原检查结果保留且确认绑定当前版本',()=>{
  for(const status of ['needs_revision','failed','pending','inconclusive']){
    const p=fixture(status),state=previewApprovalState(p),before=structuredClone(p.visualPages);
    assert.equal(state.ready,true);assert.equal(state.requiresAcceptance,true);assert.equal(state.issues.filter(v=>v.includes('装饰过量')).length,1,'同一检查问题不重复列出');
    assert.throws(()=>previewApprovalRecord(p,{confirmAllPages:true,approvalStamp:state.stamp}),/明确确认接受/);
    assert.throws(()=>previewApprovalRecord(p,{confirmAllPages:true,acceptIssues:true,approvalStamp:'old'}),/已变化/);
    const approval=previewApprovalRecord(p,{confirmAllPages:true,acceptIssues:true,approvalStamp:state.stamp});
    assert.ok(approval.acceptedIssues.some(v=>v.includes('装饰过量')));assert.equal(approval.pageChecks[0].status,status);assert.deepEqual(p.visualPages,before,'确认不会把模型检查改成通过');
    p.visualPages[0].previewHash='new-image';assert.throws(()=>previewApprovalRecord(p,{confirmAllPages:true,acceptIssues:true,approvalStamp:state.stamp}),/已变化/);
  }
});

test('缺图、过期或内容未确认不能通过接受问题继续；检查通过兼容原逐页批准',()=>{
  let p=fixture('passed'),state=previewApprovalState(p);assert.equal(state.requiresAcceptance,false);
  assert.throws(()=>previewApprovalRecord(p,{}),/逐页检查/);
  p.visualPages[0].manualReview={previewHash:p.visualPages[0].previewHash};assert.deepEqual(previewApprovalRecord(p,{}).acceptedIssues,[]);
  p.approvals.content=null;assert.throws(()=>previewApprovalRecord(p,{confirmAllPages:true,approvalStamp:state.stamp}),/确认当前内容/);
  p=fixture();delete p.visualPages[0];assert.throws(()=>previewApprovalRecord(p,{confirmAllPages:true,acceptIssues:true}),/补齐/);
  p=fixture();p.slides[0].title='内容已改';assert.equal(previewApprovalState(p).ready,false);assert.throws(()=>previewApprovalRecord(p,{confirmAllPages:true,acceptIssues:true}),/补齐/);
});

test('未通过检查时确认入口仍可用，问题列表转义且明确说明接受后进入05',()=>{
  const p=fixture();Object.assign(p,{previewApprovalEnabled:true,previewApprovalState:previewApprovalState(p),fullPreviewPages:[true],confirmedVisualPages:[0],designStandards:{passed:false,issues:['问题'],pages:[]}});
  const html=visualPreview(p,(a,b,c,actions)=>actions,()=>'',()=>''),button=html.match(/<button[^>]*data-open-preview-approval[^>]*>/)[0];
  assert.ok(!button.includes('disabled'));assert.match(html,/确认预览，进入05/);
  const dialog=previewApprovalDialogContent({requiresAcceptance:true,issues:['<script>bad()</script>']});assert.match(dialog,/确认接受后仍可进入05/);assert.doesNotMatch(dialog,/<script>/);assert.match(dialog,/&lt;script&gt;/);
  p.previewApprovalState.ready=false;assert.match(visualPreview(p,(a,b,c,actions)=>actions,()=>'',()=>''),/data-open-preview-approval disabled/);
});
