import test from 'node:test';
import assert from 'node:assert/strict';
import {synthesizeMaterials} from '../lib/material-synthesis.mjs';

const readings=[{id:'doc-a',summary:'甲报告给出实验结果',status:'read'},{id:'doc-b',summary:'乙报告给出成本',status:'read'}];
const materials=[{id:'doc-a',name:'实验.pdf'},{id:'doc-b',name:'成本.docx'},{id:'unread',name:'未读.png'}];
const args={brief:{title:'报告'},readings,materials,system:'JSON',signal:new AbortController().signal};
const raw=outline=>({summary:'正确的综合摘要',outline,questions:['原始待确认事项']});
const response=value=>({text:JSON.stringify(value),usage:{total_tokens:1}});

test('文件名、对象引用、空格和来源短编号确定性匹配，不引入未读材料',async()=>{
  let calls=0;
  const {synthesis}=await synthesizeMaterials({...args,call:async()=>{calls++;return response(raw([{title:'实验结果',sourceIds:[' doc-a ','实验.pdf',{materialId:'doc-a'},' m1 ']},{title:'成本',sourceIds:'M2'}]));}});
  assert.equal(calls,1);assert.deepEqual(synthesis.outline.map(o=>o.sourceIds),[['doc-a'],['doc-b']]);
});

test('自动修复只更新无效来源，第二轮只修复剩余项，摘要主题与正确引用保留',async()=>{
  const prompts=[];
  const outputs=[raw([{title:'实验',sourceIds:['doc-a','bad']},{title:'成本',sourceIds:['unknown']},{title:'已有正确来源',sourceIds:['doc-b']}]),
    {references:[{index:1,sourceIds:['M1']},{index:2,sourceIds:['doc-b','bad-again']},{index:3,sourceIds:['doc-a']}]},
    {references:[{index:2,sourceIds:['M2']}]}];
  const {synthesis}=await synthesizeMaterials({...args,call:async(_c,_s,prompt)=>{prompts.push(prompt);return response(outputs.shift());}});
  assert.equal(prompts.length,3);assert.equal(synthesis.summary,'正确的综合摘要');assert.deepEqual(synthesis.questions,['原始待确认事项']);
  assert.deepEqual(synthesis.outline.map(o=>[o.title,o.sourceIds]),[['实验',['doc-a']],['成本',['doc-b']],['已有正确来源',['doc-b']]]);
  const remaining=JSON.parse(prompts[2].split('待修正主题：')[1].split('\n来源目录：')[0]);assert.deepEqual(remaining.map(i=>i.index),[2]);assert.deepEqual(remaining[0].validSourceIds,['doc-b']);
});

test('持续无效、重复文件名和未读材料不会乱配，保留有效分析并标记来源待核对',async()=>{
  let calls=0;
  const {synthesis}=await synthesizeMaterials({...args,materials:[...materials,{id:'doc-b',name:'实验.pdf'}],call:async()=>response(calls++?{references:[{index:1,sourceIds:['未读.png','fake']}]}
    :raw([{title:'混合来源',sourceIds:['doc-a','实验.pdf','未读.png']},{title:'无来源',sourceIds:[]}]))});
  assert.equal(calls,3);assert.equal(synthesis.summary,'正确的综合摘要');assert.deepEqual(synthesis.outline[0].sourceIds,['doc-a']);assert.equal(synthesis.outline[0].sourceReviewRequired,true);assert.equal(synthesis.outline[1].sourceReviewRequired,undefined);assert.equal(synthesis.questions.length,2);
});

test('修复返回无效JSON或接口失败仍保留正确结果，取消则停止',async()=>{
  let calls=0;
  const {synthesis}=await synthesizeMaterials({...args,call:async()=>{
    calls++;if(calls===2)return {text:'输出截断'};if(calls===3)throw Error('网关失败');return response(raw([{title:'实验',sourceIds:['doc-a','fake']}]));
  }});
  assert.equal(calls,3);assert.deepEqual(synthesis.outline[0].sourceIds,['doc-a']);assert.equal(synthesis.outline[0].sourceReviewRequired,true);
  const controller=new AbortController();let cancelCalls=0;
  await assert.rejects(synthesizeMaterials({...args,signal:controller.signal,call:async()=>{cancelCalls++;controller.abort();return response(raw([]));}}),/取消/);assert.equal(cancelCalls,1);
});
