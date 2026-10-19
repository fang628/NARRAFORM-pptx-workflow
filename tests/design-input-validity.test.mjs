import {downstreamReuseState} from '../lib/downstream-reuse.mjs';
import {applyProgressPlan} from '../lib/progress-regeneration.mjs';
import {validateProgressSections} from '../public/progress-sections.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {pageDesignStamp,pageDesignInputStamp,pageDesignState,pageDesignPrompt,renderPageDesign} from '../lib/page-design.mjs';
import {themeAssetsStamp,themeAssetsInputStamp,themeAssetsCurrent} from '../lib/theme-assets.mjs';
import {visualPublic} from '../lib/visual-pipeline.mjs';
import {visualConcepts} from '../public/visual-ui.js';
import {syncPageDesignText} from '../lib/page-design-text.mjs';
import {enterVisualStage} from '../lib/content-stage.mjs';
import {fixtureReply,fixtureDirections} from './visual-fixture.mjs';
const previousLibrary='previous-library';
function project(){
 const p={id:'version-check',version:1,stage:3,brief:{title:'对象介绍',cover:true,toc:true,progress:false,pages:3},materials:[{id:'doc',kind:'document',name:'材料',sha256:'original'}],slides:['cover','toc','content'].map((kind,i)=>({kind,title:'页面'+i,body:['准确文案'],sources:['doc']})),pageDesigns:{},approvals:{requirements:1,content:1},concepts:[],visualPages:{},styleRegistry:[]};
 for(let i=0;i<3;i++){
  const plan=JSON.parse(fixtureReply({messages:[{role:'user',content:pageDesignPrompt(p,i)}]}).choices[0].message.content),stamp=pageDesignStamp(p,i,{libraryVersion:previousLibrary});
  p.pageDesigns[i]={plan,markdown:renderPageDesign(p,i,plan),draftStamp:stamp,layoutStamp:stamp,approvedAt:'approved',layoutApprovedAt:'approved',contentSnapshot:structuredClone(p.slides[i])};
 }
 p.themeAssets={id:'backgrounds',libraryVersion:previousLibrary,stamp:themeAssetsStamp(p,{libraryVersion:previousLibrary}),status:'ready',directions:fixtureDirections().map(d=>({...d,assets:Object.fromEntries(['hero-image','toc-image','content-background'].map(use=>[use,{materialId:d.id+'-'+use,file:'kept.png',normalized:'kept.png',previewHash:'kept'}]))}))};
 return p;
}
test('规范版本变化不使已有设计与底图失效，三版预览按钮可用，读取不改写工件',()=>{
 const p=project(),before=structuredClone(p);
 assert.notEqual(p.pageDesigns[0].draftStamp,pageDesignStamp(p,0));assert.notEqual(p.themeAssets.stamp,themeAssetsStamp(p));
 for(let i=0;i<3;i++){const d=pageDesignState(p,i);assert.ok(d.current&&d.approvedCurrent&&d.layoutCurrent);assert.ok(d.policyUpdated);}
 const state=visualPublic(p);assert.deepEqual(state.confirmedVisualPages,[0,1,2]);assert.ok(state.themeAssetsCurrent&&state.themeAssetsReady&&state.conceptFoundationReadiness.passed);
 const html=visualConcepts({...p,...state},(_code,_title,_description,actions)=>actions,()=>'<empty>');assert.match(html,/<button class="primary" data-action="concepts"\s*>/);
 assert.deepEqual(p,before);
});
test('实际修改页面只使该页过期；需求、材料或表现类型变化仍使相关结果过期',()=>{
 const p=project();p.slides[2].body=['新文案'];assert.equal(pageDesignState(p,2).current,false);assert.ok(pageDesignState(p,0).current);
 for(const change of [p=>p.brief.title='新主题',p=>p.materials[0].sha256='changed']){
  const p=project();change(p);assert.equal(pageDesignState(p,0).current,false);assert.equal(themeAssetsCurrent(p),false);
 }
 const q=project();q.visualTreatment='flat';assert.equal(themeAssetsCurrent(q),false);
 const unknown=project();unknown.themeAssets.libraryVersion='unrelated';assert.equal(pageDesignState(unknown,0).current,false);assert.equal(themeAssetsCurrent(unknown),false,'未知版本不能盲目跳过实际校验');
});
test('新结果保存真实输入签名，后续规范变化可沿用，真实输入变化仍失效',()=>{
 const p=project();for(let i=0;i<3;i++)p.pageDesigns[i].contentInputStamp=pageDesignInputStamp(p,i);p.themeAssets.inputStamp=themeAssetsInputStamp(p);
 p.themeAssets.libraryVersion='unrecorded-policy';for(const d of Object.values(p.pageDesigns))d.draftStamp='unrecorded-policy-stamp';p.themeAssets.stamp='unrecorded-policy-stamp';
 assert.ok(pageDesignState(p,0).current&&themeAssetsCurrent(p));
 p.slides[0].title='新标题';assert.equal(pageDesignState(p,0).current,false);
 p.materials[0].sha256='changed';assert.equal(themeAssetsCurrent(p),false);
});
test('旧规范设计可直接同步文案并进入下一步，不丢失原排版与图片',()=>{
 const p=project(),before=structuredClone(p.slides[2]),nodes=structuredClone(p.pageDesigns[2].plan.nodes),backgrounds=structuredClone(p.themeAssets);
 p.slides[2].body=['同步后的文案'];syncPageDesignText(p,2,before);assert.ok(pageDesignState(p,2).current);assert.deepEqual(p.pageDesigns[2].plan.nodes,nodes);
 const result=enterVisualStage(p);assert.deepEqual(result.accepted,[0,1,2]);assert.deepEqual(p.themeAssets,backgrounds);assert.ok(p.pageDesigns[2].contentInputStamp);
});
test('缺少有效设计时明确列出阻塞原因，而非底图就绪却只禁用按钮',()=>{
 const p=project();for(const s of p.slides)s.body=['已修改'];const state=visualPublic(p);assert.equal(state.conceptFoundationReadiness.passed,false);assert.match(state.conceptFoundationReadiness.issues.join('；'),/设计稿/);
});

test('仅规范变化后修改章节，已有设计正常更新导航，不再次变成过期稿',()=>{
 const p=project();applyProgressPlan(p,{sections:validateProgressSections(['研究背景与目标','设计方法与实现','结果评价与比较','应用边界与展望']),assignments:p.slides.map((_,index)=>({index,section:index+1}))});
 for(let i=0;i<3;i++){assert.ok(pageDesignState(p,i).current);assert.equal(p.pageDesigns[i].contentInputStamp,pageDesignInputStamp(p,i));}
});

test('删页后残留的历史设计不会使状态检查崩溃',()=>{
 const p=project();p.reuseCheckpoint={source:structuredClone(p),inputs:'before',version:1,materialHashes:{doc:'original'}};p.slides.pop();
 assert.equal(pageDesignState(p,2),null);assert.doesNotThrow(()=>downstreamReuseState(p));assert.equal(downstreamReuseState(p).pending,true);
});
