import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSlides,scene,themes} from '../lib/scene.mjs';
import {canonicalTexts} from '../lib/visual-model.mjs';
import {nestedContentList} from '../lib/prompt-structure.mjs';
import {pageDesignPrompt,canonicalDesignTree} from '../lib/page-design.mjs';
import {slideImagePrompt} from '../lib/slide-image-prompts.mjs';
import {contentWritingRules} from '../lib/content-writing.mjs';
import {targetText} from '../lib/sources.mjs';

const fixture=()=>{
  const slide=validateSlides([{kind:'content',sources:[],body:[],elements:[
    {id:'title',type:'text',role:'title',label:'EDITOR_LABEL_TITLE',text:'方案比较',parentId:null},
    {id:'group',type:'group',label:'实际比较维度',parentId:'title'},
    {id:'methodA',type:'text',role:'body',label:'EDITOR_LABEL_A_FAKE_HEADING',text:'口服给药 · 操作简便',parentId:'group'},
    {id:'methodB',type:'text',role:'body',label:'EDITOR_LABEL_B_FAKE_HEADING',text:'静脉给药 · 起效迅速',parentId:'group'}]}])[0];
  const plan={layoutIntent:'左右并列对照',logic:'比较两种方法',nodes:slide.elements.map(n=>({id:n.id,position:n.id==='methodA'?'紧邻 methodB':'左侧',relativeSize:'中等',alignment:'左对齐',carrier:'无框',relation:'同级并列'}))};
  return {slide,plan,p:{brief:{title:'方法汇报',progress:false},materials:[],slides:[slide],pageDesigns:{0:{plan}}}};
};

test('文本标签不进入准确文案、来源正文或渲染；真实小标题和独立短语保持',()=>{
  const {slide,p}=fixture(),texts=canonicalTexts(slide),list=nestedContentList(slide.elements),rendered=scene(slide,themes[0],0,1,p.brief);
  assert.deepEqual(texts.map(n=>n.text),['方案比较','实际比较维度','口服给药 · 操作简便','静脉给药 · 起效迅速']);
  assert.equal(texts.filter(n=>n.role==='heading').length,1);
  for(const output of [JSON.stringify(texts),list,rendered.filter(n=>n.type==='text').map(n=>n.text).join('')]){assert.doesNotMatch(output,/EDITOR_LABEL/);assert.match(output,/实际比较维度/);}
  assert.equal(targetText(slide,'element:methodA'),'口服给药 · 操作简便');assert.equal(targetText(slide,'element:group'),'实际比较维度');
  const changed=structuredClone(slide);changed.elements.filter(n=>n.type==='text').forEach(n=>n.label='完全无关的内部标签');assert.deepEqual(canonicalTexts(changed),texts);
});

test('设计模型看不到文本标签，预览中的节点引用不把标签当成小标题',()=>{
  const {slide,plan,p}=fixture(),instruction=pageDesignPrompt(p,0),tree=canonicalDesignTree(p,0,plan),prompt=slideImagePrompt(p,0,{id:'a',coreColor:'#ffffff',style:'白底蓝灰'},[]);
  assert.doesNotMatch(instruction,/EDITOR_LABEL/);assert.doesNotMatch(tree,/EDITOR_LABEL/);assert.doesNotMatch(prompt,/EDITOR_LABEL/);
  const nodes=JSON.parse(instruction.split('已有节点：')[1].split('\n使用的材料：')[0]);
  assert.ok(nodes.filter(n=>n.type==='text').every(n=>!Object.hasOwn(n,'label')));
  assert.equal(nodes.find(n=>n.type==='group').label,'实际比较维度');
  assert.match(prompt,/小标题：实际比较维度/);assert.match(prompt,/正文：口服给药 · 操作简便/);assert.match(prompt,/正文：静脉给药 · 起效迅速/);
  assert.deepEqual(p.slides[0],slide,'仅屏蔽模型输入，不删除用户编辑器里的标签');
});

test('逐页设计无小标题节点时明确禁止从文本标签补造，修订设计也使用相同限制',()=>{
  const {p}=fixture();p.slides[0].elements=p.slides[0].elements.filter(n=>n.type!=='group').map(n=>n.parentId==='group'?{...n,parentId:'title'}:n);
  for(const options of [{},{instruction:'调整左右排布',markdown:'上一版设计稿'}]){
    const prompt=pageDesignPrompt(p,0,options);
    assert.match(prompt,/本页实际小标题：\[\]/);assert.match(prompt,/本页没有小标题，不得从文本标签补造小标题/);assert.doesNotMatch(prompt,/EDITOR_LABEL/);
  }
});

test('内容阶段明确并列信息必须拆点，短语组合不强制补成完整句或新增小标题',()=>{
  assert.match(contentWritingRules,/并列信息时必须拆为独立分点/);assert.match(contentWritingRules,/独立text节点，共用真实父项/);
  assert.match(contentWritingRules,/准确的短语组合表达，不要求补成完整句子/);
  assert.match(contentWritingRules,/关键结论必须用一句完整的话/);assert.match(contentWritingRules,/text 的 label 只是网页排版树中的内部识别标签/);
  assert.match(contentWritingRules,/不把文本标签升级为小标题/);
});
