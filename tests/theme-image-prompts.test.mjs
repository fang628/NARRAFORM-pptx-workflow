import {promptColor} from '../lib/prompt-colors.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {themeAssetPrompt,themeAssetSubject} from '../lib/theme-image-prompts.mjs';

const p={brief:{title:'分子定点修饰研究'}};

test('内容底图不重复追加已有边角与低对比描述，留白只在构图字段处理',()=>{
  const direction={name:'浅色',coreColor:'#F5F8FC',style:'浅色',contentSubject:'右下低对比肽链轮廓',textArea:'内容页中央留白'};
  assert.equal(themeAssetSubject(p,direction,'content-background'),direction.contentSubject);
  const prompt=themeAssetPrompt(p,direction,'content-background');
  assert.equal(prompt.split('低对比').length,2);assert.equal(prompt.split('中央留白').length,2);
  assert.doesNotMatch(prompt,/主体为视觉重心，细节简洁，阅读区安静/);
});
const d={name:'冷白蓝绿·分子医学',coreColor:'#F5F8FC',style:'核心底色 #F5F8FC，全组三张沿用；主色 #14344D 深蓝用于标题与文字；辅助色 #A9CFD7；强调 #087F8C 青绿仅用于节点；正文框内不要渐变；装饰边界清晰',typography:'不应进入底图的字体规范',frames:'不应进入底图的文本框规范',decoration:'不应重复追加的整页装饰规范',heroSubject:'右下具象肽链实体，非真实分子构象',tocSubject:'同一肽链实体的具象近景',textArea:'封面左侧和中上方为长标题与副标题连续留白；目录左侧预留四条章节导航；内容页上部标题与中央证据区保持平静'};

test('材料元素名带括号说明时不再与已包含该主体的构图描述重复拼接',()=>{
  const direction={...d,heroSubject:'mPEG2000-TP5 偶联物实体示意：PEG 链连接肽段，位于右侧',subjectSources:{heroSubject:{element:'mPEG2000-TP5 偶联物实体示意（PEG 链与肽段）'}}};
  const prompt=themeAssetPrompt(p,direction,'hero-image');assert.equal(prompt.split('mPEG2000-TP5').length,2);assert.ok(prompt.includes(direction.heroSubject));
  const other=themeAssetPrompt(p,{...direction,heroSubject:'右侧留白构图'},'hero-image');assert.ok(other.includes(direction.subjectSources.heroSubject.element),'缺少来源身份时仍需补齐');
});

test('底图单段只写实际绘图要求，无凑字数下限，保留配色和页型阅读区',()=>{
  const snapshot=structuredClone(d);
  for(const use of ['hero-image','toc-image','content-background']){
    const prompt=themeAssetPrompt(p,d,use);
    assert.ok(prompt.length<=260,prompt.length);
    assert.doesNotMatch(prompt,/\n|不应进入|不应重复|检查|登记|全组三张|框内不要渐变/);
    const labels=['用途：','16:9（1920×1080）','风格：','底色 ','主体：','构图：'];
    assert.deepEqual(labels.map(s=>prompt.indexOf(s)),labels.map(s=>prompt.indexOf(s)).sort((a,b)=>a-b));
    assert.doesNotMatch(prompt,/#[\da-f]{6}\b/i);for(const color of ['#F5F8FC','#14344D','#A9CFD7','#087F8C'])assert.ok(prompt.includes(promptColor(color)));
    assert.ok(prompt.includes(p.brief.title));
    assert.doesNotMatch(prompt,/局部造型自由发挥|细节简洁|纹理与光效克制|伪造证据|全篇|取自材料|视觉中心/);
    if(use==='content-background')assert.doesNotMatch(prompt,/主体区与文字留白区用边界线分隔/);else assert.equal(prompt.split('主体区与文字留白区用边界线分隔').length,2);
    if(use==='hero-image'){assert.ok(prompt.includes(d.heroSubject));assert.match(prompt,/长标题与副标题/);assert.doesNotMatch(prompt,/四条章节导航|中央证据区/);}
    if(use==='toc-image'){assert.ok(prompt.includes(d.tocSubject));assert.match(prompt,/四条章节导航/);assert.doesNotMatch(prompt,/长标题与副标题|中央证据区/);}
    if(use==='content-background'){assert.match(prompt,/中央证据区/);assert.doesNotMatch(prompt,/长标题与副标题|四条章节导航/);}
  }
  assert.deepEqual(d,snapshot,'压缩发送内容不改动已登记风格定义');
});

test('三种用途都要求主题对象，正文使用独立主题元素且旧方向可回退',()=>{
  const direction={...d,contentSubject:'右下简化的聚合物连接位点与肽链轮廓'};
  for(const use of ['hero-image','toc-image','content-background']){
    const prompt=themeAssetPrompt(p,direction,use);
    assert.match(prompt,/主体：/);
    if(use==='content-background'){assert.match(prompt,/低对比/);assert.doesNotMatch(prompt,/主体占满视觉区|单一具象主体/);}else{assert.match(prompt,/单一具象主体占满视觉区，可配少量主题点缀/);assert.doesNotMatch(prompt,/不要抢夺视觉中心/);}
    assert.ok(prompt.includes(use==='hero-image'?d.heroSubject:use==='toc-image'?d.tocSubject:direction.contentSubject));
    assert.ok(prompt.length<=400,prompt.length);
  }
  assert.ok(themeAssetPrompt(p,d,'content-background').includes(d.heroSubject));
  const contentOnly=themeAssetPrompt(p,{...d,heroSubject:'不使用',tocSubject:'不使用'},'content-background');
  assert.ok(contentOnly.includes('与“'+p.brief.title+'”相关的具体主题对象'));
  assert.doesNotMatch(contentOnly,/主体：不使用/);
});

