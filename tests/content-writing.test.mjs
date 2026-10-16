import test from 'node:test';
import assert from 'node:assert/strict';
import {contentWritingRules,longContentFields} from '../lib/content-writing.mjs';
import {designRulesFor} from '../lib/design-rules.mjs';
import {validateSlides} from '../lib/scene.mjs';
import {checkContentPages} from '../lib/content-check.mjs';

test('短字段和结论写法仅注入内容阶段，相关图片按组实际插入',()=>{
  const p={brief:{title:'实验结果',progress:false},slides:[{kind:'content',title:'结果'}],materials:[]};
  const content=designRulesFor(p,0,'content');
  assert.equal(content.split(contentWritingRules).length,2);
  assert.match(content,/关键结论必须用一句完整的话/);
  assert.match(content,/其余语段可用短语、短分点/);
  assert.match(content,/不把每个数据写成完整叙述句/);
  assert.match(content,/先逐组查找可用配图/);
  assert.match(content,/必须实际插入 elements 的 image 节点/);
  assert.match(content,/讲稿notes不受上屏短字段/);
  for(const stage of ['design','image','review','rebuild'])assert.ok(!designRulesFor(p,0,stage).includes(contentWritingRules));
});

test('长字段只在内容结束时提示，不截断原文、公式或讲稿，不新增后续阻断',()=>{
  const text='在相同实验条件下，完整保留比较口径、数据单位及材料给出的限定条件。'.repeat(3);
  const slides=validateSlides([{kind:'content',notes:'长讲稿'.repeat(200),sources:[],elements:[
    {id:'title',type:'text',role:'title',text:'比较结果',parentId:null},
    {id:'group',type:'group',label:'处理与对照',parentId:'title'},
    {id:'result',type:'text',role:'body',text:'转化率 32%（对照 20%）',parentId:'group'},
    {id:'conditions',type:'text',role:'body',text,parentId:'result'}]}]);
  const before=structuredClone(slides),p={brief:{progress:false},slides};
  checkContentPages(p);
  assert.deepEqual(slides,before);
  assert.deepEqual(p.contentChecks[0].longFields,[{id:'conditions',role:'body',length:Array.from(text).length,recommendedMax:60}]);
  assert.ok(p.contentChecks[0].warnings.some(w=>w.includes('不影响继续制作')));
  assert.doesNotThrow(()=>validateSlides(slides));
  assert.equal(longContentFields([{id:'unicode',type:'text',text:'😀'.repeat(60)}]).length,0);
});
