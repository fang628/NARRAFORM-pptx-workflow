import test from 'node:test';
import assert from 'node:assert/strict';
import {fallbackThemePhotoReferences,themePhotoCandidates,themePhotoEligible} from '../public/theme-photo-policy.js';
import {validateThemePlanning} from '../lib/theme-planning.mjs';
import {validateSynthesis} from '../lib/materials.mjs';
import {themeAssetPrompt} from '../lib/theme-assets.mjs';
import {backgroundSubjectRule} from '../lib/theme-subject-policy.mjs';
import {fixtureDirections} from './visual-fixture.mjs';
const fixture=()=>({brief:{title:'学术汇报',pages:4,cover:true,toc:true},materials:[{id:'a',name:'照片A',kind:'image',file:'a.png',sha256:'hash-a'},{id:'b',name:'照片B',kind:'image',file:'b.png',sha256:'hash-b'},{id:'chart',kind:'image',file:'chart.png'},{id:'generated',kind:'image',file:'ai.png',generated:true}],analysis:{themeClarity:'unclear',readings:[{id:'a',category:'实拍照片',summary:'校园建筑'},{id:'b',category:'照片',summary:'现场人物'},{id:'chart',category:'图表'}]}});
test('没有明确主题时走实际照片主体；明确主题仍保留此前学术限制，AI物品或人物可作艺术主体',()=>{
  const p=fixture();assert(themePhotoEligible(p));assert.equal(themePhotoCandidates(p,{automatic:true}).length,2);assert.deepEqual(fallbackThemePhotoReferences(p),{'hero-image':'a','toc-image':'b'});p.analysis.themeClarity='clear';assert(!themePhotoEligible(p));assert.equal(fallbackThemePhotoReferences(p),undefined);assert.match(backgroundSubjectRule,/AI生成的物品或人物/);
  assert.equal(validateSynthesis({summary:'没有统一叙事',outline:[],questions:[],themeClarity:'unclear'},[]).themeClarity,'unclear');
});
test('只有一张照片或副本时只用于一个页型，单页不创建目录引用，手动显式引用优先',()=>{
  const p=fixture();p.materials[1].sha256='hash-a';assert.deepEqual(fallbackThemePhotoReferences(p),{'hero-image':'a'});p.brief.cover=false;assert.deepEqual(fallbackThemePhotoReferences(p),{'toc-image':'a'});p.brief.pages=1;assert.deepEqual(fallbackThemePhotoReferences(p),{});
  const both=fixture();assert.deepEqual(fallbackThemePhotoReferences(both,{'hero-image':'b'}),{'hero-image':'b','toc-image':'a'});
});
test('底图规划把照片兜底写入实际引用与提示词，后续继续沿用现有图生图路径',()=>{
  const p=fixture(),d=fixtureDirections()[0],planning=validateThemePlanning({...d,styleSelection:{matchingPresetIds:['A'],reason:'材料缺少统一主题，使用现场照片作主体'}},p);assert.equal(planning.photoReferences['hero-image'],'a');assert.equal(planning.photoReferences['toc-image'],'b');const prompt=themeAssetPrompt(p,{...d,...planning},'hero-image');assert.match(prompt,/参考照片中的校园建筑/);assert.match(prompt,/仅借用照片主体/);
});
