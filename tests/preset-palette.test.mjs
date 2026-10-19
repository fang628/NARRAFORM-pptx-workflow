import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {workflowStyles,workflowStyleContext,workflowPageContext,workflowManifest} from '../lib/workflow-library.mjs';
import {preserveReferencedDesign} from '../lib/preset-design.mjs';
import {registerStyleDirections,requireStyleRegistration} from '../lib/style-registry.mjs';
import {validateThemeDirections} from '../lib/theme-assets.mjs';
import {validateStyleSelection} from '../lib/theme-planning.mjs';
import {harmonizeThemeDirections} from '../lib/theme-direction-consistency.mjs';
import {themeAssetPrompt} from '../lib/theme-image-prompts.mjs';
import {imageStyle} from '../lib/image-prompts.mjs';
import {fixtureCustomDirections} from './visual-fixture.mjs';
import {styleRegistryPanel} from '../public/theme-assets.js';
import {agentManagedLibraryPaths,applyLibraryPolicy} from '../tools/workflow-library-policy.mjs';

test('简约风格单独优先复用适配预设配色，不继承字体、装饰、渐变与卡片版式',()=>{
  const p={visualTreatment:'flat',brief:{title:'材料主题'},styleRegistry:[]},snapshot=structuredClone(workflowStyles);
  const raw={...fixtureCustomDirections()[0],paletteReferenceId:'A',styleSelection:{matchingPresetIds:[],matchingPaletteIds:['A'],reason:'医疗主题适用此配色，写实装饰和字体不适用'}};
  assert.doesNotThrow(()=>validateStyleSelection(raw,p));
  const d=preserveReferencedDesign(raw,p),source=workflowStyles.find(s=>s.id==='A');
  assert.equal(d.coreColor,source.palette.colors[0].hex);assert.deepEqual(JSON.parse(d.style).colors,source.palette.colors);
  for(const field of ['name','typography','frames','decoration','layoutLanguage'])assert.equal(d[field],raw[field]);
  assert.ok(!d.presetDesign);assert.doesNotMatch(d.style,/gradient|毛笔|反射/);
  const [registered]=registerStyleDirections(p,[d],'test');assert.match(registered.styleRegistrationId,/^STYLE-/);
  const saved=JSON.parse(JSON.stringify({p,d:registered}));assert.equal(requireStyleRegistration(saved.p,saved.d).origin,'palette-adaptation');
  const [reused]=registerStyleDirections(p,[{...raw,paletteReferenceId:undefined,referenceStyleId:registered.styleRegistrationId}],'reuse');assert.equal(reused.paletteReferenceId,'A');requireStyleRegistration(p,reused);
  const html=styleRegistryPanel(p);assert.match(html,/配色参考 A/);assert.match(html,/仅复用配色/);
  const prompt=themeAssetPrompt(p,{...d,heroSubject:'修饰肽实体',contentSubject:'修饰肽轮廓'},'content-background');
  assert.match(prompt,/简洁平面/);assert.ok(!prompt.includes(source.name));assert.doesNotMatch(imageStyle(d,{visualTreatment:'flat'}),/采用毛笔|采用书法|汉仪尚巍|气泡高光|渐变倒影/);assert.match(imageStyle(d,{visualTreatment:'flat'}),/避免书法体、毛笔字和手写体/);
  assert.deepEqual(workflowStyles,snapshot);
});

test('规划遗漏配色编号时从适配清单回填，色系协调不会改写预设配色',()=>{
  const p={visualTreatment:'flat',brief:{title:'主题',cover:false,toc:false},materials:[],styleRegistry:[]};
  const raw=fixtureCustomDirections().map((d,i)=>({...d,contentSubject:'材料主体边角轮廓',styleSelection:{matchingPresetIds:[],matchingPaletteIds:[['A','C','E'][i]],reason:'配色适合主题，其他设计需平面化'}}));
  const directions=validateThemeDirections(raw,p,{requirePlanning:true});
  assert.deepEqual(directions.map(d=>d.paletteReferenceId),['A','C','E']);
  for(const d of directions)assert.equal(d.coreColor,workflowStyles.find(s=>s.id===d.paletteReferenceId).palette.colors[0].hex);
  const [d]=harmonizeThemeDirections([directions[0]],p,{reservedColors:['#FFFFFF'],previousColor:'#FFFFFF'});assert.notEqual(d.coreColor,'#FFFFFF');assert.equal(d.paletteReferenceId,undefined);assert.equal(d.colorSelection.previousReference,'A');
  const registered=registerStyleDirections(p,directions,'test');assert.equal(p.styleRegistry.length,3);registered.forEach(d=>requireStyleRegistration(p,d));
});

test('不合主题的配色不能复用，无适配配色可原创；完整预设沿用原设计',()=>{
  const raw={...fixtureCustomDirections()[0],paletteReferenceId:'A',styleSelection:{matchingPresetIds:[],matchingPaletteIds:[],reason:'不匹配'}},p={visualTreatment:'flat'};
  assert.throws(()=>validateStyleSelection(raw,p),/配色范围/);
  assert.throws(()=>preserveReferencedDesign({...raw,paletteReferenceId:'UNKNOWN'},p),/配色编号/);
  assert.doesNotThrow(()=>validateStyleSelection({...raw,paletteReferenceId:null},p));
  const whole=preserveReferencedDesign({...raw,referenceStyleId:'A'},p);assert.ok(whole.presetDesign);assert.ok(!whole.paletteReferenceId);
  assert.equal(whole.name,workflowStyles[0].name);
  assert.doesNotThrow(()=>validateStyleSelection({...raw,styleSelection:{matchingPresetIds:['B'],matchingPaletteIds:['A'],reason:'只复用适合的配色'}},p));
});

test('当前规范按阶段注入，不再混入旧配额、九项结构与占位框宽松阈值，同步保护新口径',()=>{
  for(const file of agentManagedLibraryPaths)assert.ok(workflowManifest.files.some(e=>e.file===file),file);
  const text=agentManagedLibraryPaths.map(file=>fs.readFileSync('workflow-library/'+file,'utf8')).join('\n');
  assert.doesNotMatch(text,/特殊分块的页面数必须严格大于|Markdown九项|默认\s*12%|放宽至\s*15%|建议采用不同画面主体|第二页固定为唯一目录页/);
  const context=workflowStyleContext();assert.match(context,/paletteReferenceId/);assert.match(context,/简约平面/);assert.match(context,/原样复用/);
  const page=workflowPageContext({slides:[{kind:'content'}]},0);assert.match(page,/不因图片数减少分点/);assert.match(page,/文本标签是编辑标识/);assert.match(page,/Agent 七项分点结构/);assert.doesNotMatch(page,/详细描述所有文本框|生成独立的编号底座|缺失才占位/);
  const before=fs.readFileSync('workflow-library/stages/13-design/references/gen-prompt-scope.md','utf8');applyLibraryPolicy('workflow-library');assert.equal(fs.readFileSync('workflow-library/stages/13-design/references/gen-prompt-scope.md','utf8'),before);
  const sync=fs.readFileSync('tools/sync_workflow_library.mjs','utf8');assert.match(sync,/agentManagedLibraryPaths\.includes\(relative\)/);
});
