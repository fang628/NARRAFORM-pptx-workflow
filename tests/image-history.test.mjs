import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberImage,restoreImage,imageHistory} from '../lib/image-history.mjs';
import {reviewAndRepair} from '../lib/visual-repair.mjs';

const record=n=>({file:`${n}.png`,normalized:`${n}-base.png`,prompt:`提示词 ${n}`,previewHash:String(n),stamp:'same-content',images:[{nodeId:'image',id:'material',x:n,y:2,w:3,h:4}],previewReview:{status:'passed',issues:[]}});
test('图片历史支持多次撤回和重做，新修改清除重做分支；完整保存配图位置与检查记录',()=>{
  const a=record(1),b=rememberImage(a,record(2)),c=rememberImage(b,record(3));
  const restoredB=restoreImage(c,'undo'),restoredA=restoreImage(restoredB,'undo');
  assert.equal(restoredA.file,a.file);assert.deepEqual(restoredA.images,a.images);assert.deepEqual(restoredA.previewReview,a.previewReview);
  assert.equal(restoreImage(restoreImage(restoredA,'redo'),'redo').file,c.file);
  const branch=rememberImage(restoredA,record(4));assert.equal(imageHistory(branch).future.length,0);assert.equal(restoreImage(branch,'undo').file,a.file);
  assert.throws(()=>restoreImage(restoredA,'undo'),/没有可撤回/);assert.throws(()=>restoreImage(branch,'redo'),/没有可重做/);assert.throws(()=>restoreImage(c,'invalid'),/无效/);
  assert.equal(a.editHistory,undefined);assert.equal(c.editHistory.past.some(r=>r.editHistory),false,'快照不递归包含历史');
});
test('已有自动修正历史可恢复，后续自动修正继续保留人工版本栈',async()=>{
  const a=record(1),b=record(2);b.repairHistory=[a];assert.equal(restoreImage(b,'undo').file,a.file);
  const c=rememberImage(b,record(3));let checked=0;
  await reviewAndRepair(c,{review:async r=>{r.previewReview=checked++?{status:'passed',issues:[]}:{status:'needs_revision',issues:['调整图片']};},generate:async()=>record(4),save:async()=>{},signal:new AbortController().signal});
  assert.equal(c.file,'4.png');assert.equal(c.editHistory.past.length,3);const previous=restoreImage(c,'undo');assert.equal(previous.file,'3.png');assert.equal(previous.previewReview.status,'needs_revision');assert.equal(restoreImage(previous,'undo').file,'2.png');
  assert.deepEqual(restoreImage(JSON.parse(JSON.stringify(c)),'undo').images,previous.images,'重启后反序列化仍能撤回');
});
