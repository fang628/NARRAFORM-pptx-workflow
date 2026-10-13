import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureDirections} from './visual-fixture.mjs';
import {validateThemeDirections} from '../lib/theme-assets.mjs';
import {registerStyleDirections,requireStyleRegistration,describeStyle,deleteRegisteredStyle,registeredStyleContext,validateStyleDefinition} from '../lib/style-registry.mjs';
import {themeDirectionOptions,styleRegistryPanel} from '../public/theme-assets.js';

test('原创风格无须 A-F；完整登记、重复复用与修改留存旧版本',()=>{
  const raw=fixtureDirections();raw[0]={...raw[0],referenceStyleId:null,name:'珊瑚纸艺',coreColor:'#FFF4EC',style:'暖纸白、珊瑚红与炭灰',layoutLanguage:'连续折页展开与非对称证据轨道'};
  const p={id:'synthetic-project',styleRegistry:[]},directions=validateThemeDirections(raw);
  assert.equal(directions[0].referenceStyleId,null);
  assert.throws(()=>requireStyleRegistration(p,directions[0]),/尚未登记/);
  const registered=registerStyleDirections(p,directions,'theme-assets'),first=requireStyleRegistration(p,registered[0]);
  assert.equal(first.origin,'custom');assert.equal(first.definition.layoutLanguage,raw[0].layoutLanguage);assert.equal(p.styleRegistry.length,3);
  assert.deepEqual(registerStyleDirections(p,directions,'concepts').map(d=>d.styleRegistrationId),registered.map(d=>d.styleRegistrationId));assert.equal(p.styleRegistry.length,3);
  const changed=registerStyleDirections(p,[{...registered[0],coreColor:'#FFE7DC'}],'theme-assets')[0];assert.notEqual(changed.styleRegistrationId,first.id);assert.equal(p.styleRegistry.length,4);assert.equal(first.definition.coreColor,'#FFF4EC');
  const copied=JSON.parse(JSON.stringify(p));assert.deepEqual(requireStyleRegistration(copied,registered[0]),first,'登记可持久化恢复');
  assert.equal(requireStyleRegistration(p,{...registered[0],styleSummary:registered[0].style,style:describeStyle(registered[0])}).id,first.id,'整页描述与底图共用登记');
  assert.throws(()=>requireStyleRegistration(p,{...registered[0],typography:'未经登记的字体改动'}),/不一致/);
  copied.styleRegistry[0].definition.decoration='篡改登记';assert.throws(()=>requireStyleRegistration(copied,registered[0]),/不一致/);
  const html=styleRegistryPanel(p);assert.match(html,/原创/);assert.ok(html.includes(first.id));assert.ok(html.includes(raw[0].layoutLanguage));
  const escaped=styleRegistryPanel({...p,styleRegistry:[{...first,definition:{...first.definition,name:'<img src=x onerror=alert(1)>'}}]});assert.ok(!escaped.includes('<img'));assert.match(escaped,/&lt;img/);
});

test('不完整风格不登记，不伪造参考编号；可参考本项目已有登记',()=>{
  const p={styleRegistry:[]},raw=fixtureDirections().map(d=>({...d,referenceStyleId:null}));raw[1].typography='';
  assert.throws(()=>registerStyleDirections(p,raw,'theme-assets'),/typography/);assert.equal(p.styleRegistry.length,0,'批次全部验证后再登记');
  assert.throws(()=>validateThemeDirections(fixtureDirections().map(d=>({...d,referenceStyleId:'invented'}))),/参考风格编号不存在/);
  const [first]=registerStyleDirections(p,[fixtureDirections()[0]],'theme-assets');
  const [reuse]=registerStyleDirections(p,[{...fixtureDirections()[1],referenceStyleId:first.styleRegistrationId}],'theme-assets');
  assert.equal(requireStyleRegistration(p,reuse).definition.referenceStyleId,first.styleRegistrationId);
});

test('删除登记后不再展示或供新参考，既有方案来源可追溯且不复活',()=>{
  const p={id:'fixture',styleRegistry:[],styleRegistryDeletion:true};
  const [direction]=registerStyleDirections(p,[fixtureDirections()[0]],'theme-assets'),id=direction.styleRegistrationId;
  p.reuseCheckpoint={source:{styleRegistry:structuredClone(p.styleRegistry)}};
  deleteRegisteredStyle(p,id);
  assert.ok(p.styleRegistry[0].deletedAt);assert.ok(p.reuseCheckpoint.source.styleRegistry[0].deletedAt);
  assert.doesNotMatch(styleRegistryPanel(p),new RegExp(id));assert.doesNotMatch(themeDirectionOptions(p),new RegExp(id));assert.doesNotMatch(registeredStyleContext(p),new RegExp(id));
  assert.equal(requireStyleRegistration(p,direction).id,id);
  assert.equal(registerStyleDirections(p,[direction],'concepts')[0].styleRegistrationId,id);assert.ok(p.styleRegistry[0].deletedAt);
  assert.throws(()=>validateStyleDefinition({...fixtureDirections()[1],referenceStyleId:id},p),/不存在/);
  assert.throws(()=>deleteRegisteredStyle(p,id),/已删除/);
  const [fresh]=registerStyleDirections(p,[fixtureDirections()[0]],'theme-assets');
  assert.notEqual(fresh.styleRegistrationId,id);assert.equal(p.styleRegistry.filter(r=>!r.deletedAt).length,1);
});
