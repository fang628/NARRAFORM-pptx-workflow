import test from 'node:test';
import assert from 'node:assert/strict';
import {deliveryPageKey} from '../public/delivery-update.js';
import {rebuildAssetsPanel} from '../public/visual-ui.js';

test('轮询进度或其他页变化不刷新当前页；本页结果变化才更新',()=>{
  const p={id:'p',slides:[{title:'甲'},{title:'乙'}],task:{status:'running'},rebuildLive:{pages:[{index:0,revision:1},{index:1,revision:1}]},rebuildAssets:[{index:0,status:'done',elements:[],textStyles:[]},{index:1,status:'done',elements:[],textStyles:[]}]};
  const first=deliveryPageKey(p,0);p.task.message='下一条进度';p.rebuildLive.pages[1].revision++;
  assert.equal(deliveryPageKey(p,0),first);p.rebuildLive.pages[0].revision++;assert.notEqual(deliveryPageKey(p,0),first);
  const changed=deliveryPageKey(p,0);p.task.status='done';assert.notEqual(deliveryPageKey(p,0),changed,'结束时按钮状态需更新');
});

test('缩略图地址仅按元素版本更新，素材批次或其他页面刷新不使全部图片失效',()=>{
  const p={id:'p',rebuildAssets:[{index:0,status:'done',elements:[{key:'a',targetStamp:'stable-element',type:'rect',description:'色块'}],textStyles:[]}],rebuildLive:{revision:1},rebuildAssetPreview:{revision:2}};
  const html=rebuildAssetsPanel(p,0),url=html.match(/<img src="([^"]+)"/)?.[1];assert.ok(url);assert.match(html,/loading="lazy" decoding="async"/);
  p.rebuildLive.revision=123;p.rebuildAssetPreview.revision=99;
  assert.equal(rebuildAssetsPanel(p,0).match(/<img src="([^"]+)"/)?.[1],url);
  p.rebuildAssets[0].elements[0].targetStamp='changed-element';assert.notEqual(rebuildAssetsPanel(p,0).match(/<img src="([^"]+)"/)?.[1],url);
});
