import test from 'node:test';
import assert from 'node:assert/strict';
import {themeMaterialContext,validateThemePlanning,validateStyleSelection} from '../lib/theme-planning.mjs';
import {themeAssetPrompt} from '../lib/theme-image-prompts.mjs';
import {validateThemeDirections} from '../lib/theme-assets.mjs';
import {fixtureDirections} from './visual-fixture.mjs';
import {workflowStyleContext} from '../lib/workflow-library.mjs';

function fixture(){
  const p={brief:{title:'肽链修饰',cover:true,toc:true},materials:[{id:'report',name:'报告',text:'研究对象为肽链与聚合物。'},{id:'generated',generated:true,text:'不存在的主题对象'}],analysis:{readings:[{id:'report',summary:'肽链修饰研究',keyPoints:['肽链','聚合物'],facts:[{claim:'研究对象',quote:'研究对象为肽链与聚合物。'}]}]},styleRegistry:[]};
  const direction={...fixtureDirections()[0],styleSelection:{matchingPresetIds:['A'],fullyMatchingPresetIds:['A'],reason:'医学研究题材适配浅蓝白'},subjectSources:Object.fromEntries(['heroSubject','tocSubject','contentSubject'].map(k=>[k,{materialId:'report',evidenceId:'F1',element:'肽链'}]))};
  return {p,direction};
}

test('主体只引用原始材料的现有证据编号，禁用页型不强求来源',()=>{
  const {p,direction}=fixture(),context=themeMaterialContext(p);
  assert.deepEqual(context.map(m=>m.id),['report']);assert.equal(context[0].evidence[0].quote,p.materials[0].text);
  const valid=validateThemePlanning(direction,p);assert.equal(valid.subjectSources.heroSubject.evidence.quote,p.materials[0].text);
  const raw=fixtureDirections().map(d=>({...direction,...d,styleSelection:{matchingPresetIds:['A','B','D'],reason:'符合研究主题'}}));
  const planned=validateThemeDirections(raw,p,{requirePlanning:true});assert.equal(planned[0].subjectSources.heroSubject.evidenceId,'F1');
  for(const materialId of ['generated','missing'])assert.equal(validateThemePlanning({...direction,subjectSources:{...direction.subjectSources,heroSubject:{materialId,element:'抽象光带',evidenceId:'F1'}}},p).subjectSources.heroSubject.materialId,undefined);
  assert.equal(validateThemePlanning({...direction,subjectSources:{...direction.subjectSources,heroSubject:{materialId:'report',element:'抽象光带',evidenceId:'F99'}}},p).subjectSources.heroSubject.evidenceId,undefined);
  p.brief.cover=false;p.brief.toc=false;
  assert.deepEqual(Object.keys(validateThemePlanning({...direction,subjectSources:{contentSubject:direction.subjectSources.contentSubject}},p).subjectSources),['contentSubject']);
});

test('艺术意象可以来自全材料的主题启发，不要求实物证据；保留全篇主线说明',()=>{
  const {p,direction}=fixture(),inspiration='以连续流动表达肽链改造、性能与应用的全篇主线';
  const raw={...direction,heroSubject:'流动光带',tocSubject:'交织薄片',subjectSources:{heroSubject:{kind:'artistic',element:'流动光带',inspiration}}};
  const planned=validateThemePlanning(raw,p);assert.equal(planned.subjectSources.heroSubject.inspiration,inspiration);assert.equal(planned.subjectSources.heroSubject.kind,'artistic');assert.equal(planned.subjectSources.heroSubject.materialId,undefined);
});

test('匹配预设时禁止无依据原创，允许均不匹配、明确指定或沿用预设登记',()=>{
  const {p,direction}=fixture();
  assert.throws(()=>validateStyleSelection({...direction,referenceStyleId:null},p),/已有符合主题的预设/);
  assert.throws(()=>validateStyleSelection({...direction,referenceStyleId:'B'},p),/不在贴合主题/);
  p.styleRegistry=[{id:'STYLE-child',definition:{referenceStyleId:'A'}}];
  assert.deepEqual(validateStyleSelection({...direction,referenceStyleId:'STYLE-child'},p).matchingPresetIds,['A']);
  assert.doesNotThrow(()=>validateStyleSelection({...direction,referenceStyleId:null,styleSelection:{matchingPresetIds:[],reason:'预设不适合当前受众'}},p));
  assert.throws(()=>validateStyleSelection({...direction,referenceStyleId:'B'},p,{referenceStyleId:'B'}),/不在贴合主题/);
  assert.doesNotThrow(()=>validateStyleSelection({...direction,referenceStyleId:'B',styleSelection:{matchingPresetIds:['B'],reason:'技术研究受众适合深蓝结构与清晰证据层级'}},p,{referenceStyleId:'B'}));
  assert.throws(()=>validateStyleSelection({...direction,styleSelection:{matchingPresetIds:['unknown'],reason:'错误编号'}},p),/适配判断/);
});

test('排除的预设不能因空匹配、登记继承或指定参考被重新采用，方向差异不能以偏题换取',()=>{
  const {p,direction}=fixture(),none={matchingPresetIds:[],reason:'这些预设的装饰语气均不适合本次严肃医学证据汇报'};
  assert.throws(()=>validateStyleSelection({...direction,styleSelection:none},p),/不在贴合主题/);
  p.styleRegistry=[{id:'STYLE-child',definition:{referenceStyleId:'B'}},{id:'STYLE-grandchild',definition:{referenceStyleId:'STYLE-child'}},{id:'STYLE-custom',definition:{referenceStyleId:null}}];
  for(const ref of ['B','STYLE-child','STYLE-grandchild'])assert.throws(()=>validateStyleSelection({...direction,referenceStyleId:ref},p,{referenceStyleId:ref}),/不在贴合主题/);
  assert.doesNotThrow(()=>validateStyleSelection({...direction,referenceStyleId:'STYLE-custom',styleSelection:none},p));
  const same=fixtureDirections().map(d=>({...direction,id:d.id}));
  assert.deepEqual(validateThemeDirections(same,p,{requirePlanning:true}).map(d=>d.referenceStyleId),['A','A','A']);
  const context=workflowStyleContext();assert.match(context,/三种方向可以采用同一合适预设/);assert.match(context,/不能只因配色好看/);assert.match(context,/指定参考也不能绕过主题适配/);
});

test('登记的材料对象进入短提示词，同时允许陪衬且维持清晰主次',()=>{
  const {p,direction}=fixture(),d={...direction,...validateThemePlanning(direction,p)};
  for(const use of ['hero-image','toc-image']){
    const prompt=themeAssetPrompt(p,d,use);
    const source=d.subjectSources[use==='hero-image'?'heroSubject':'tocSubject'];
    assert.equal(source.materialId,'report');assert.equal(source.evidence.quote,p.materials[0].text);
    assert.match(prompt,/主体：/);assert.match(prompt,use==='hero-image'?/艺术主视觉占满视觉区/:/艺术主视觉位于边侧/);
    assert.match(prompt,/可配少量主题点缀/);assert.doesNotMatch(prompt,/取自材料|明显可见/);
    assert.ok(prompt.length<=400,prompt.length);assert.doesNotMatch(prompt,/F1|report|evidenceId|匹配预设/);
  }
});

test('符合主题的预设必须采用，不以完全匹配字段或局部配色调整为跳过理由',()=>{
  const {p,direction}=fixture();
  for(const fullyMatchingPresetIds of [[],undefined]){
    const styleSelection={matchingPresetIds:['A'],fullyMatchingPresetIds,reason:'主题与用途适配，局部配色和构图可调整'};
    assert.throws(()=>validateStyleSelection({...direction,referenceStyleId:null,styleSelection},p),error=>error.code==='STYLE_PRESET_REQUIRED');
    assert.doesNotThrow(()=>validateStyleSelection({...direction,referenceStyleId:'A',styleSelection},p));
  }
  assert.throws(()=>validateStyleSelection({...direction,styleSelection:{...direction.styleSelection,fullyMatchingPresetIds:['B']}},p),/必须属于/);
});
