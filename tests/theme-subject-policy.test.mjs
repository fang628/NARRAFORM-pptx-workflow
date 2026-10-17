import test from 'node:test';
import assert from 'node:assert/strict';
import {backgroundSubjectRule,backgroundVariationRule,distinguishBackgroundVisuals} from '../lib/theme-subject-policy.mjs';
import {themeAssetSubjectRule,themeAssetPrompt,themeAssetSubject} from '../lib/theme-image-prompts.mjs';
import {validateThemePlanning} from '../lib/theme-planning.mjs';
import {workflowStyles,workflowPageContext} from '../lib/workflow-library.mjs';
import {harmonizeThemeDirections} from '../lib/theme-direction-consistency.mjs';
import {registerStyleDirections,requireStyleRegistration} from '../lib/style-registry.mjs';
import {fixtureCustomDirections} from './visual-fixture.mjs';

const brief={title:'材料主线',cover:true,toc:true,pages:3};
test('艺术主体可抽象，无材料实物证据也能规划；主题与全材料主线要求仍保留',()=>{
  const p={brief,materials:[{id:'doc',name:'报告',text:'不同章节共同讨论研究的变化与连接。'}]},raw={...fixtureCustomDirections()[0],heroSubject:'流动光带',tocSubject:'交织薄片',contentSubject:'低对比波纹',subjectSources:{heroSubject:{kind:'artistic',element:'流动光带',inspiration:'以连续变化与连接呼应全篇共同主线'}}};
  const plan=validateThemePlanning(raw,p);assert.equal(plan.subjectSources.heroSubject.kind,'artistic');assert.equal(plan.subjectSources.heroSubject.materialId,undefined);assert.equal(plan.subjectSources.heroSubject.element,'流动光带');
  assert.match(backgroundSubjectRule,/必须符合主题并贯穿全篇材料的共同主线/);assert.match(backgroundSubjectRule,/不能只代表某一小节/);assert.match(backgroundSubjectRule,/不要求是主题对应的具体物质/);
  assert.match(themeAssetSubjectRule('hero-image'),/抽象形态/);assert.match(backgroundVariationRule,/任何风格/);
});

test('所有完整预设和表现类型都区分封面与目录，仅移位置或镜像不算区别',()=>{
  const snapshot=structuredClone(workflowStyles);
  for(const visualTreatment of ['flat','realistic'])for(const preset of workflowStyles){
    const p={brief,visualTreatment,styleRegistry:[]},raw={...fixtureCustomDirections()[0],referenceStyleId:preset.id,heroSubject:'左侧流动光带',tocSubject:'右侧镜像流动光带',contentSubject:'低对比波纹'};
    const [d]=harmonizeThemeDirections([raw],p);assert.notEqual(d.tocSubject,raw.tocSubject);assert.equal(d.heroSubject,raw.heroSubject);
    const [registered]=registerStyleDirections(p,[d],'test');requireStyleRegistration(p,registered);assert.equal(registered.styleRegistrationId,preset.id);
    const hero=themeAssetPrompt(p,registered,'hero-image'),toc=themeAssetPrompt(p,registered,'toc-image');
    assert.ok(hero.includes(raw.heroSubject));assert.ok(toc.includes(visualTreatment==='realistic'?'分层透光轮廓':'错位叠片'));
    assert.equal(themeAssetSubject(p,registered,'toc-image'),registered.tocSubject);assert.equal(p.styleRegistry.length,0);
  }
  assert.deepEqual(workflowStyles,snapshot);
});

test('不同主体、形状或视觉效果任一差异均可；不强制给已有创意叠加固定形状',()=>{
  for(const [heroSubject,tocSubject] of [['流动光带','交织薄片'],['圆环','展开的环带'],['光带的磨砂色面','光带的透光折射']]){
    const d={heroSubject,tocSubject};assert.deepEqual(distinguishBackgroundVisuals(d,brief,'flat'),d);
  }
  const d={heroSubject:'流动光带',tocSubject:'流动光带'};
  assert.deepEqual(distinguishBackgroundVisuals(d,{cover:false,toc:true,pages:3}),d);
  const once=distinguishBackgroundVisuals(d,brief,'flat');assert.deepEqual(distinguishBackgroundVisuals(once,brief,'flat'),once);
});

test('当前规范与阶段注入不再强制同一材料实物，仍保留全篇主题与目录留白',()=>{
  const page=workflowPageContext({slides:[{kind:'toc'}]},0);
  assert.match(page,/全材料共同主线/);assert.match(page,/至少一项与封面明显不同/);assert.match(page,/目录文字区连续留空/);
  assert.doesNotMatch(page,/材料中贯穿全篇的具象物体|延续封面的共同主体/);
});
