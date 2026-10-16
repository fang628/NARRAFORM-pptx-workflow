import test from 'node:test';
import assert from 'node:assert/strict';
import {nonConcreteSubject,validateConcreteBackgroundSubjects,validateDeckSubjectScope} from '../lib/theme-subject-policy.mjs';
import {themeSharedSubject} from '../lib/theme-direction-consistency.mjs';
import {themeAssetSubjectRule} from '../lib/theme-image-prompts.mjs';

test('封面目录排除抽象图表、数字、结构式及研究概念，接受具象宏观与微观物体',()=>{
  for(const subject of ['右侧抽象分子主体','柱状图','右侧分子结构式','2026','数字组成的主体','化学式','概念关系图','分子修饰']){
    assert.equal(nonConcreteSubject(subject),true,subject);
    assert.throws(()=>validateConcreteBackgroundSubjects({heroSubject:subject,tocSubject:'细胞实体'},{cover:true,toc:true}),error=>error.code==='BACKGROUND_SUBJECT_NOT_CONCRETE');
  }
  for(const subject of ['数字显微镜','球形纳米颗粒','蛋白质实体表面','DNA双螺旋实体','材料中的细胞，非真实实验影像','右侧建筑实体']){
    assert.equal(nonConcreteSubject(subject),false,subject);
    assert.doesNotThrow(()=>validateConcreteBackgroundSubjects({heroSubject:subject,tocSubject:subject},{cover:true,toc:true}));
  }
});

test('主体来源本身不能指向抽象结构式，仅有内容背景时不强制封面主体限制',()=>{
  assert.throws(()=>validateConcreteBackgroundSubjects({heroSubject:'微观实体',subjectSources:{heroSubject:{element:'化学结构式'}}},{cover:true}),/具象宏观或微观物体/);
  assert.doesNotThrow(()=>validateConcreteBackgroundSubjects({heroSubject:'结构式',tocSubject:'图表',contentSubject:'边角概念轮廓'},{pages:1,cover:false}));
  for(const use of ['hero-image','toc-image'])assert.match(themeAssetSubjectRule(use),/具象宏观或微观物体/);
  assert.doesNotMatch(themeAssetSubjectRule('content-background'),/具象宏观或微观物体/);
});

test('旧方案的抽象主体不再锁定新一轮规划，保留具象对象时继续共用材料身份',()=>{
  const p={brief:{cover:true,toc:true}};
  assert.equal(themeSharedSubject([{heroSubject:'抽象分子图表',tocSubject:'化学结构式'}],p),null);
  const source={materialId:'doc',evidenceId:'F1',element:'球形纳米颗粒'};
  assert.deepEqual(themeSharedSubject([{heroSubject:'纳米颗粒',subjectSources:{heroSubject:source}}],p),{element:'球形纳米颗粒',source});
});

test('封面目录拒绝局部案例主体，新规划要求全篇代表性，旧方案不锁定未经判断的对象',()=>{
  const brief={cover:true,toc:true},source={materialId:'doc',evidenceId:'F1',element:'显微镜',scope:'section-only',scopeReason:'仅在实验方法一段中出现'};
  const raw={subjectSources:{heroSubject:source,tocSubject:source}};
  assert.throws(()=>validateDeckSubjectScope(raw,brief),error=>error.code==='BACKGROUND_SUBJECT_NOT_DECK_WIDE');
  assert.throws(()=>validateDeckSubjectScope({},brief,{required:true}),error=>error.code==='BACKGROUND_SUBJECT_NOT_DECK_WIDE');
  assert.doesNotThrow(()=>validateDeckSubjectScope(raw,{cover:false,pages:1},{required:true}));
  const core={...source,element:'肽链',scope:'whole-deck',scopeReason:'全篇围绕肽链的结构、改造和应用展开，无需每页重复名称'};
  assert.doesNotThrow(()=>validateDeckSubjectScope({subjectSources:{heroSubject:core,tocSubject:core}},brief,{required:true}));
  const p={brief},local={heroSubject:'实验方法中的显微镜',subjectSources:{heroSubject:source}},global={heroSubject:'肽链实体',subjectSources:{heroSubject:core}};
  assert.deepEqual(themeSharedSubject([local,global],p,{requireDeckScope:true}),{element:'肽链',source:core});
  assert.equal(themeSharedSubject([{heroSubject:'显微镜',subjectSources:{heroSubject:{element:'显微镜'}}}],p,{requireDeckScope:true}),null);
  for(const use of ['hero-image','toc-image'])assert.match(themeAssetSubjectRule(use),/贯穿全篇.*不选局部案例对象/);
});
