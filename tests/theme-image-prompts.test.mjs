import test from 'node:test';
import assert from 'node:assert/strict';
import {themeAssetPrompt,themeAssetSubject,themeReadingArea,themePromptWritingRuleFor} from '../lib/theme-image-prompts.mjs';
import {promptColor} from '../lib/prompt-colors.mjs';

const p={brief:{title:'分子定点修饰研究'},visualTreatment:'flat'};
const d={name:'冷白蓝绿·分子医学',coreColor:'#F5F8FC',style:'底色 #F5F8FC，主色 #14344D，辅助色 #A9CFD7，强调 #087F8C',heroSubject:'右下具象肽链实体',tocSubject:'同一肽链实体的具象近景',contentSubject:'右下低对比肽链轮廓',textArea:'封面：左上长标题与副标题留白；目录：左中四条卡片导航；内容页：标题置顶、三栏卡片与底部数据条'};

test('内容背景中央大片留空，不再把旧规划中的分栏卡片与文字版式写入底图',()=>{
  const prompt=themeAssetPrompt(p,d,'content-background');
  assert.equal(themeAssetSubject(p,d,'content-background'),d.contentSubject);
  assert.equal(prompt.split('低对比').length,2);assert.equal(prompt.split('中央大片留空').length,2);
  assert.match(prompt,/不画分框、卡片、分栏或区域分隔线/);
  assert.doesNotMatch(prompt,/三栏卡片|底部数据条|标题置顶|构图：|边界线分隔/);
  assert.equal(themeReadingArea(d,'content-background'),'中央大片留空');
});

test('封面留白按页型提取；目录不生成条目、文本框与边界分区',()=>{
  for(const separator of ['；','，',',','\n','']){
    const direction={...d,textArea:['封面：左上标题空区','目录：左中条目空区','内容页：中央证据空区'].join(separator)};
    const hero=themeAssetPrompt(p,direction,'hero-image');
    assert.match(hero,/左上标题空区/);assert.doesNotMatch(hero,/左中条目空区|中央证据空区/);
    const toc=themeAssetPrompt(p,direction,'toc-image');
    assert.match(toc,/目录文字区连续留空/);assert.doesNotMatch(toc,/条目空区|中央证据空区|边界线分隔/);
  }
  assert.doesNotMatch(themePromptWritingRuleFor('content-background'),/封面|目录|占满视觉区/);
  assert.match(themePromptWritingRuleFor('toc-image'),/不画文本框、卡片或占位框/);
});

test('每次只发当前页的具体主体名，不发登记风格名，不用同一主体代称',()=>{
  for(const use of ['hero-image','toc-image','content-background']){
    const prompt=themeAssetPrompt(p,d,use);
    assert.match(prompt,/主体：/);assert.match(prompt,/肽链/);
    assert.ok(!prompt.includes(d.name));assert.doesNotMatch(prompt,/风格：|同一肽链|三张底图/);
    assert.match(prompt,/16:9（1920×1080）/);assert.ok(prompt.length<320);
  }
});

test('材料来源补齐主体身份，不重复拼接已经指名的主体',()=>{
  const subject='mPEG2000-TP5 偶联物实体示意：PEG 链连接肽段，位于右侧';
  const direction={...d,heroSubject:subject,subjectSources:{heroSubject:{element:'mPEG2000-TP5 偶联物实体示意（PEG 链与肽段）'}}};
  const prompt=themeAssetPrompt(p,direction,'hero-image');
  assert.ok(prompt.includes(subject));assert.equal(prompt.split('mPEG2000-TP5').length,2);
  const missing=themeAssetPrompt(p,{...direction,heroSubject:'右侧留白'},'hero-image');
  assert.ok(!missing.includes(direction.subjectSources.heroSubject.element),'艺术意象不被材料实物强制覆盖');
});

test('绘画表现和配色保留，模板不改写登记定义',()=>{
  const snapshot=structuredClone(d);
  for(const use of ['hero-image','toc-image','content-background']){
    const prompt=themeAssetPrompt(p,d,use);
    assert.match(prompt,/表现：背景与装饰用简洁平面色块、点阵/);assert.doesNotMatch(prompt,/#[\da-f]{6}\b/i);
    for(const color of ['#F5F8FC','#14344D','#A9CFD7','#087F8C'])assert.ok(prompt.includes(promptColor(color)));
    assert.match(prompt,/不含文字、数字、图注、文本框或占位框/);
    if(use==='hero-image')assert.match(prompt,/主体区与文字留白区用边界线分隔/);
  }
  assert.deepEqual(d,snapshot);
});
