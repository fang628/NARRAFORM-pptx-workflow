import fs from 'node:fs';
import {visualPreview} from '../public/visual-ui.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {sourcePanel,sourceTextView,rememberSourceExpansion} from '../public/provenance.js';
import {designPreview,pageDesignPanel,rememberDesignExpansion,confirmAllPageDesigns,saveAndConfirmPageDesigns,batchDesignResult} from '../public/page-design.js';

test('原文定位保留重复摘录的准确位置，失效坐标重新定位且不误高亮',()=>{
  const text='重复证据\n[第 2 页]\n再次重复证据\n目标 <script>alert(1)</script> 证据';
  const second=text.lastIndexOf('重复证据');
  let view=sourceTextView({text},{quote:'重复证据',location:{start:second,end:second+4}});
  assert.equal(view.location.start,second);assert.equal(view.location.page,2);assert.equal(view.location.line,3);
  view=sourceTextView({kind:'image',text},{quote:'目标<script>alert(1)</script>证据',location:{start:0,end:3}});
  assert.equal(view.location.start,text.indexOf('目标'));assert.match(view.html,/<mark[^>]+>目标 &lt;script&gt;/);assert.doesNotMatch(view.html,/<script>/);
  const absent=sourceTextView({text},{quote:'已经删除的摘录',location:{start:0,end:4}});assert.equal(absent.missing,true);assert.equal(absent.location,null);assert.doesNotMatch(absent.html,/<mark/);
});

test('内容和设计稿索引独立折叠，定位按钮绑定具体页面和材料，设计稿记住展开',()=>{
  const p={id:'navigation-test',materials:[{id:'material',name:'报告 <img>'}],slides:[{sourceLinks:[{id:'link',target:'body:0',materialId:'material',quote:'原文',location:{start:0,end:2,line:18,page:2}}]}],pageDesigns:{}};
  const html=sourcePanel(p,p.slides[0],0);assert.match(html,/<details class="source-relations"[^>]+>/);assert.doesNotMatch(html.split('>')[0],/\bopen\b/);
  assert.match(html,/source-position[^>]+data-read-material="material" data-source-quote="link" data-source-slide="0"/);assert.match(html,/第 2 页 · 提取文字第 18 行/);assert.doesNotMatch(html,/<img>/);
  rememberSourceExpansion({dataset:{sourcePanel:p.id+':0:edit'},open:true});assert.match(sourcePanel(p,p.slides[0],0).split('>')[0],/\bopen\b/);
  const design=designPreview('## 内容\n准确文案\n## 原材料对应索引\n- 旧索引展示\n## 顶部进度条要求\n保留后文',p,0);
  assert.match(design,/data-source-panel="navigation-test:0:design"/);assert.match(design,/source-position/);assert.doesNotMatch(design,/旧索引展示/);assert.match(design,/保留后文/);
  p.pageDesigns[0]={markdown:'## 内容\n设计正文',current:true};
  const panel=pageDesignPanel(p,0);assert.match(panel,/^<section class="page-design-panel"/);
  assert.doesNotMatch(panel.match(/<details class="design-document"[^>]*>/)[0],/\bopen\b/);
  rememberDesignExpansion({dataset:{designFold:p.id+':0'},open:true});assert.match(pageDesignPanel(p,0).match(/<details class="design-document"[^>]*>/)[0],/\bopen\b/);
});
test('只折叠设计正文，检查提示、操作按钮和自然语言修改始终位于折叠区域之外',()=>{
  const p={id:'design-document-only',slides:[{sourceLinks:[]}],materials:[],executionConcurrency:3,pageDesigns:{0:{markdown:'设计正文',current:true,inputCheck:{warnings:['需要核对材料']}}}};
  const html=pageDesignPanel(p,0),start=html.indexOf('<details class="design-document"'),end=html.indexOf('</details>',start);
  assert.doesNotMatch(html,/<details class="page-design-panel"|<details class="design-input-check"|<details class="design-feedback"/);
  assert.ok(html.indexOf('需要核对材料')<start);
  for(const action of ['designPage','savePageDesign','approvePageDesign','revisePageDesign']){
    const at=html.indexOf('data-page-design-action="'+action+'"');assert.ok(at>=0&&(at<start||at>end),action);
  }
  assert.ok(html.indexOf('data-design-feedback="0"')>end);assert.ok(html.indexOf('design-dirty')<start);
  assert.ok(html.indexOf('design-edit-hint')<html.indexOf('<details class="design-edit"'));
  p.pageDesigns[0].current=false;p.initialDesign={failed:[{index:0,message:'模型连接失败'}]};
  const failed=pageDesignPanel(p,0);assert.ok(failed.indexOf('模型连接失败')<failed.indexOf('<details class="design-document"'));
  p.pageDesigns={};const empty=pageDesignPanel(p,0);assert.match(empty,/data-page-design-action="designPage"/);assert.doesNotMatch(empty,/<details class="design-document"/);
});

test('一键确认沿用逐页批准，保留编辑稿，跳过失效页面且单页失败不阻塞其余页',async()=>{
  const p={id:'batch-confirm',slides:Array.from({length:7},()=>({sourceLinks:[]})),pageDesigns:Object.fromEntries([0,1,2,3,4,5].map(i=>[i,{markdown:'设计稿'+i,current:i!==2,approvedCurrent:i===1,inputCheck:{warnings:['仅建议，不增加批准门槛']}}]))};p.slides[3].sourceLinks=[{stale:true}];
  let active=0,peak=0;const calls=[];
  const result=await confirmAllPageDesigns(p,new Map([[0,'人工编辑稿']]),async(project,index,markdown)=>{
    calls.push({index,markdown});active++;peak=Math.max(peak,active);await Promise.resolve();active--;
    if(index===4)throw Error('准确文案被修改，请核对');
    const next=structuredClone(project);next.pageDesigns[index].approvedCurrent=true;next.pageDesigns[index].markdown=markdown;return next;
  });
  assert.equal(peak,1);assert.deepEqual(calls.map(c=>c.index),[0,4,5]);assert.equal(calls[0].markdown,'人工编辑稿');
  assert.deepEqual(result.confirmed,[0,5]);assert.deepEqual(result.already,[1]);assert.deepEqual(result.skipped.map(s=>s.index),[2,3,4,6]);assert.equal(p.pageDesigns[0].approvedCurrent,false);
  assert.match(batchDesignResult(result.project),/4 页暂未确认/);assert.match(batchDesignResult(result.project),/第 5 页：准确文案被修改/);
});

test('全篇预览显示单层可展开的材料索引和准确原文入口',()=>{
  const p={id:'preview-index',version:1,visualMode:'ai',selectedTheme:'a',slides:[{title:'页面',sources:['m'],sourceLinks:[{id:'q',target:'body:0',materialId:'m',quote:'证据',location:{line:12,page:2}}]}],materials:[{id:'m',name:'报告.txt'}],concepts:[],confirmedVisualPages:[0],fullPreviewPages:[true],visualPages:{0:{}},designStandards:{passed:true,issues:[],pages:[]}};
  const html=visualPreview(p,()=>'',()=>'',sourcePanel);
  assert.equal((html.match(/class="source-relations"/g)||[]).length,1);assert.match(html,/data-source-panel="preview-index:0:preview"/);
  assert.match(html,/<div class="preview-source"><details class="source-relations"/);assert.match(html,/原材料对应索引/);assert.match(html,/data-source-quote="q" data-source-slide="0"/);
  const css=fs.readFileSync(new URL('../public/style.css',import.meta.url),'utf8');assert.doesNotMatch(css,/\.preview-source \.source-heading\{display:none/);
});
test('合并确认先保存内容，再以保存后的有效状态批准设计，保留人工编辑稿',async()=>{
  const p={id:'combined-confirm',version:1,approvals:{content:null},slides:[{}, {}, {}],pageDesigns:{0:{markdown:'旧稿',current:true},1:{markdown:'未改页',current:true}}},events=[];
  const slides=[{title:'新内容'}, {}, {}];
  const result=await saveAndConfirmPageDesigns(p,slides,new Map([[0,'人工编辑稿'],[1,'新的设计说明']]),async(project,input)=>{
    assert.equal(input,slides);events.push('save');
    return {...project,version:2,approvals:{content:2},slides:input,pageDesigns:{0:{markdown:'旧稿',current:false},1:{markdown:'未改页',current:true}}};
  },async(project,index,markdown)=>{
    assert.equal(project.approvals.content,2);events.push('approve:'+index);assert.equal(markdown,'新的设计说明');
    return {...project,pageDesigns:{...project.pageDesigns,[index]:{markdown,current:true,approvedCurrent:true}}};
  });
  assert.deepEqual(events,['save','approve:1']);assert.deepEqual(result.confirmed,[1]);
  assert.deepEqual(result.skipped.map(s=>s.reason),['设计稿已过期','尚未生成设计稿']);
  assert.equal(result.project.approvals.content,2);
});
test('内容保存或确认失败时不批准设计稿',async()=>{
  const p={id:'failed-save',version:1,slides:[]};let approvals=0;
  const approve=async()=>{approvals++;};
  await assert.rejects(saveAndConfirmPageDesigns(p,[],new Map(),async()=>{throw Error('材料对应待核对');},approve),/材料对应待核对/);
  await assert.rejects(saveAndConfirmPageDesigns(p,[],new Map(),async()=>({...p,approvals:{content:null}}),approve),/内容未确认/);
  assert.equal(approvals,0);
});
