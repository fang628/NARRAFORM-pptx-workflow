import test from 'node:test';
import assert from 'node:assert/strict';
import {rebuildPageComplete,savedRebuildPages,incompleteRebuildPages,preservePartialElements} from '../lib/rebuild-page-state.mjs';
import {visualStamp} from '../lib/visual-model.mjs';
import {themeAssetsStamp} from '../lib/theme-assets.mjs';
import {visualDelivery,rebuildAssetsPanel} from '../public/visual-ui.js';

test('恢复旧版完成页的背景和审计状态，部分失败页不被当作完整结果',()=>{
  const p={id:'p',version:1,brief:{progress:false},materials:[{id:'bg',kind:'image',generated:true,purpose:'workflow-background',sha256:'hash'}],selectedTheme:'a',slides:[{title:'甲',kind:'content',body:[],sources:[]},{title:'乙',kind:'content',body:[],sources:[]}],concepts:[],visualPages:[]};
  p.themeAssets={stamp:themeAssetsStamp(p),directions:[{id:'a',assets:{'content-background':{normalized:'bg.png',materialId:'bg',previewHash:'hash'}}}]};
  const elements=[{key:'block',type:'rect',x:10,y:10,w:100,h:100,fill:'EEEEEE'}];
  p.rebuildAssetPreview={stamp:visualStamp(p),version:1,status:'partial',pages:[{index:0,status:'done',elements},{index:1,status:'partial',elements,issues:['素材未生成']}],materials:[]};
  const before=structuredClone(p.rebuildAssetPreview),pages=savedRebuildPages(p);
  assert.deepEqual(p.rebuildAssetPreview,before,'读取状态不修改已保存结果');assert(rebuildPageComplete(pages[0]));assert(!rebuildPageComplete(pages[1]));assert.deepEqual(incompleteRebuildPages(p,pages),[1]);assert.equal(pages[0].background.id,'bg');
  assert(!rebuildPageComplete({...pages[0],elements:[{...elements[0],needsAttention:true}]}));
  p.version++;assert.equal(savedRebuildPages(p).length,0,'版本变化后不能复用旧拆解');
});

test('单页重试失败保留原素材，已重新识别的同一节点不重复显示',()=>{
  const previous=[{key:'old-title',type:'text',nodeId:'title',text:'标题'},{key:'icon',type:'image',implementation:'svg',id:'original',x:10,y:10,w:100,h:100}];
  const next=[{key:'new-title',type:'text',nodeId:'title',text:'标题'}],result=preservePartialElements(previous,next);
  assert.equal(result.length,2);assert.equal(result[0].key,'icon');assert.equal(result[1].key,'new-title');assert.equal(previous[0].key,'old-title');
});

test('单页重试入口覆盖已拆解页、空结果页和执行中禁用状态',()=>{
  const p={id:'p',version:1,visualMode:'ai',approvals:{preview:1},fullPreviewPages:[true,true],slides:[{title:'已完成'},{title:'尚无元素'}],task:{status:'failed'},rebuildPageRetryEnabled:true,rebuildAssets:[{index:0,status:'partial',issues:['问题'],elements:[],textStyles:[]}]};
  const html=visualDelivery(p,()=>'',()=>{});assert.equal((html.match(/data-retry-rebuild-page=/g)||[]).length,2);assert.match(html,/data-retry-rebuild-page="0"/);assert.match(html,/data-retry-rebuild-page="1"/);assert.match(rebuildAssetsPanel(p,0),/重试本页拆解/);
  p.task.status='running';assert.match(rebuildAssetsPanel(p,0),/data-retry-rebuild-page="0" disabled/);
  p.rebuildPageRetryEnabled=false;assert.doesNotMatch(visualDelivery(p,()=>'',()=>{}),/data-retry-rebuild-page/);
});
