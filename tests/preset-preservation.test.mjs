import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {workflowStyles,workflowStyleContext} from '../lib/workflow-library.mjs';
import {preserveReferencedDesign,presetPageColor,presetLayout} from '../lib/preset-design.mjs';
import {registerStyleDirections,requireStyleRegistration} from '../lib/style-registry.mjs';
import {harmonizeThemeDirections} from '../lib/theme-direction-consistency.mjs';
import {themeAssetPrompt} from '../lib/theme-image-prompts.mjs';
import {imageStyle} from '../lib/image-prompts.mjs';
import {fixtureDirections} from './visual-fixture.mjs';
import {validateThemeDirections} from '../lib/theme-assets.mjs';
import {promptColor} from '../lib/prompt-colors.mjs';
import {styleRegistryPanel,themeDirectionOptions} from '../public/theme-assets.js';

test('选择A–F原样复用库设计，模型擅改字段与撞色调整均不能覆盖',()=>{
  const snapshot=structuredClone(workflowStyles),p={brief:{title:'合成主题'},styleRegistry:[]};
  for(const preset of workflowStyles){
    const raw={...fixtureDirections()[0],referenceStyleId:preset.id,coreColor:'#C01033',typography:'模型擅改为黑体',frames:'模型擅改为无框',layoutLanguage:'模型擅改为左右列表'};
    const [d]=harmonizeThemeDirections([raw],p);
    assert.equal(d.name,preset.name);assert.equal(d.coreColor,preset.palette.colors[0].hex);assert.deepEqual(JSON.parse(d.typography),preset.typography);assert.deepEqual(JSON.parse(d.layoutLanguage),preset.layout);
    const [registered]=registerStyleDirections(p,[d],'test'),record=requireStyleRegistration(p,registered);
    assert.equal(registered.styleRegistrationId,preset.id);assert.equal(p.styleRegistry.length,0,'预设不新增项目登记');
    assert.equal(record.origin,'preset');assert.deepEqual(record.presetDesign.source,preset);assert.deepEqual(registered.presetDesign.source,preset);
    assert.doesNotMatch(registered.typography+registered.frames+registered.layoutLanguage,/模型擅改/);
    const another=registerStyleDirections(p,[raw],'test')[0];assert.equal(another.styleRegistrationId,registered.styleRegistrationId);
    for(const use of ['hero-image','toc-image','content-background']){
      const prompt=themeAssetPrompt(p,registered,use);assert.ok(prompt.includes(promptColor(registered.coreColor)));assert.ok(!prompt.includes(preset.name));if(use==='content-background'){assert.match(prompt,/中央大片留空/);assert.ok(!prompt.includes(presetLayout(registered,use)));}
    }
    assert.match(imageStyle(registered),new RegExp(preset.typography.title.family.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    const locked=imageStyle(registered,{foundationLocked:true});assert.doesNotMatch(locked,/原预设版式/);assert.match(locked,/框形与装饰沿用/);assert.ok(locked.includes(preset.typography.title.family));
  }
  assert.deepEqual(workflowStyles,snapshot,'不写回或修改风格库原件');
});

test('预设跨阶段和持久化后直接复用库编号，来源定义或快照被改动则拒绝',()=>{
  const p={styleRegistry:[]},[direction]=registerStyleDirections(p,[fixtureDirections()[0]],'theme-assets');
  const [concept]=registerStyleDirections(p,[direction],'concepts'),saved=JSON.parse(JSON.stringify({p,concept}));
  assert.equal(requireStyleRegistration(saved.p,saved.concept).id,'A');assert.equal(saved.p.styleRegistry.length,0);
  assert.throws(()=>requireStyleRegistration(p,{...direction,frames:'擅自改为无框'}),/不一致/);
  const legacy={id:'STYLE-preset-old',origin:'preset',definition:requireStyleRegistration(p,direction).definition};
  p.styleRegistry.push(legacy);assert.doesNotMatch(styleRegistryPanel(p),/STYLE-preset-old/);assert.doesNotMatch(themeDirectionOptions(p),/STYLE-preset-old/);
});

test('全套固定同一底色，预设其余设计保留，复用项目登记不能重新改写',()=>{
  const p={styleRegistry:[]},[d]=registerStyleDirections(p,[{...fixtureDirections()[0],referenceStyleId:'D'}],'test');
  for(const use of ['hero-image','toc-image','content-background'])assert.equal(presetPageColor(d,use),'#1B4381');
  assert.doesNotMatch(presetLayout(d,'content-background'),/白底/);assert.match(presetLayout(d,'content-background'),/统一底色/);
  const [reused]=registerStyleDirections(p,[{...fixtureDirections()[1],referenceStyleId:d.styleRegistrationId,coreColor:'#FFFFFF',frames:'错误框形'}],'test');
  for(const key of ['name','style','coreColor','typography','frames','decoration','layoutLanguage'])assert.equal(reused[key],d[key]);
  assert.deepEqual(reused.presetDesign,d.presetDesign);requireStyleRegistration(p,reused);
  for(const use of ['hero-image','toc-image','content-background'])assert.ok(themeAssetPrompt({brief:{title:'主题'}},d,use).includes('底色 '+promptColor(d.coreColor)+'（全套统一）'));
  const duplicate={...d,presetDesign:structuredClone(d.presetDesign)};duplicate.presetDesign.source.typography.title.family='被篡改';assert.throws(()=>requireStyleRegistration(p,duplicate),/快照/);
});

test('模型引用预设时缺少风格字段，直接从库回填，不要求AI重新设计',()=>{
  const raw=['a','b','c'].map(id=>({id,referenceStyleId:'A',heroSubject:'材料主体',tocSubject:'材料主体',contentSubject:'材料轮廓',textArea:'留白'}));
  const directions=validateThemeDirections(raw);
  assert.ok(directions.every(d=>d.presetDesign?.id==='A'&&d.coreColor==='#FFFFFF'&&d.typography.includes('毛笔书法体')));
});

test('新选择锁定原预设，已生成旧衍生风格仍可追溯和继续使用',()=>{
  const raw=fixtureDirections()[0],definition=Object.fromEntries(['name','description','style','coreColor','typography','frames','decoration','layoutLanguage','referenceStyleId'].map(k=>[k,raw[k]]));
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify(definition)).digest('hex'),p={styleRegistry:[{id:'STYLE-old',fingerprint,definition,origin:'reference-adaptation'}]},old={...raw,styleRegistrationId:'STYLE-old'};
  assert.equal(requireStyleRegistration(p,old).id,'STYLE-old');assert.equal(registerStyleDirections(p,[old],'reuse')[0].styleRegistrationId,'STYLE-old');
  const [fresh]=registerStyleDirections(p,[raw],'new-choice');assert.notEqual(fresh.styleRegistrationId,'STYLE-old');assert.ok(fresh.presetDesign);assert.deepEqual(p.styleRegistry[0].definition,definition);
});

test('原创仍可创新和区分主色，已选预设不为色差被改色',()=>{
  const p={brief:{title:'主题'}},input=fixtureDirections().map((d,i)=>({...d,referenceStyleId:i===1?'B':null,coreColor:'#01126B'})),directions=harmonizeThemeDirections(input,p);
  assert.equal(directions[1].coreColor,'#01126B');assert.notEqual(directions[0].coreColor,'#01126B');assert.notEqual(directions[2].coreColor,'#01126B');
  const inherited=preserveReferencedDesign(input[1],p);assert.deepEqual(inherited.presetDesign.source,workflowStyles.find(s=>s.id==='B'));
  assert.match(workflowStyleContext(),/原样复用/);assert.doesNotMatch(workflowStyleContext(),/可随主题调整|可在该预设内自由创造|不机械复制参考中的艺术字/);
});
