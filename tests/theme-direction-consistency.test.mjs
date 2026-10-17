import {promptColor} from '../lib/prompt-colors.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {harmonizeThemeDirections,themeColorDistance,themeColorFamily,distinctThemeColorFamilies} from '../lib/theme-direction-consistency.mjs';
import {themeAssetPrompt} from '../lib/theme-image-prompts.mjs';
import {registerStyleDirections,requireStyleRegistration} from '../lib/style-registry.mjs';
import {fixtureDirections} from './visual-fixture.mjs';
import {freshThemeDirections} from '../lib/theme-assets.mjs';

test('整组重选不能只给旧方案改名、改描述或调换顺序，必须更新实际视觉定义',()=>{
  const previous=fixtureDirections();
  assert.equal(freshThemeDirections(previous,previous.map(d=>({...d,name:'新的名称',description:'新的理由'}))),false);
  assert.equal(freshThemeDirections(previous,[previous[2],previous[0],previous[1]]),false);
  assert.equal(freshThemeDirections(previous,previous.map(d=>({...d,layoutLanguage:'新的非对称分区'}))),true);
});

const p=()=>({brief:{title:'肽链修饰',toc:true},styleRegistry:[]});
const make=()=>fixtureDirections().map((d,i)=>({...d,referenceStyleId:null,coreColor:['#F5F8FC','#f5f8fc','#F7F5FA'][i],style:'主背景 #F5F8FC，强调色 #445566',
  heroSubject:['右侧肽链','右侧设备','右侧细胞'][i],tocSubject:'右侧蛋白口袋',contentSubject:'左下聚合物',
  subjectSources:Object.fromEntries(['heroSubject','tocSubject','contentSubject'].map(field=>[field,{materialId:'doc'+i,evidenceId:'F1',element:i?'设备':'肽链',evidence:{quote:'材料中的肽链'}}]))}));

test('三方向重复或近似底色自动区分，艺术主体不被强制统一',()=>{
  const project=p(),original=make(),snapshot=structuredClone(original),directions=harmonizeThemeDirections(original,project);
  assert.deepEqual(original,snapshot);
  for(let i=0;i<directions.length;i++)for(let j=0;j<i;j++)assert.ok(themeColorDistance(directions[i].coreColor,directions[j].coreColor)>=16);
  for(let i=0;i<directions.length;i++)for(const field of ['heroSubject','tocSubject','contentSubject']){assert.equal(directions[i][field],original[i][field]);assert.deepEqual(directions[i].subjectSources[field],original[i].subjectSources[field]);}
  const registered=registerStyleDirections(project,directions,'test');
  for(const d of registered){assert.equal(requireStyleRegistration(project,d).definition.coreColor,d.coreColor);
    assert.ok(d.style.includes('主背景 '+d.coreColor)||d.style.includes('主背景底色 '+d.coreColor));
    for(const use of ['hero-image','toc-image','content-background']){const prompt=themeAssetPrompt(project,d,use);assert.ok(prompt.includes(promptColor(d.coreColor)));assert.ok(prompt.includes(use==='hero-image'?d.heroSubject:use==='toc-image'?d.tocSubject:d.contentSubject));}
  }
});

test('更换单个方向只调整新定义，保留其他方向底图，保留新艺术意象并避开既有主色',()=>{
  const project=p(),others=harmonizeThemeDirections(make(),project),snapshot=structuredClone(others);
  const raw={...make()[1],coreColor:others[0].coreColor};
  const [changed]=harmonizeThemeDirections([raw],project,{reservedColors:others.map(d=>d.coreColor)});
  assert.deepEqual(others,snapshot);assert.equal(changed.subjectSources.heroSubject.materialId,'doc1');
  for(const other of others)assert.ok(themeColorDistance(changed.coreColor,other.coreColor)>=16);
});

test('换风格的撞色修正不得落回旧色，未撞色但沿用旧色也要给出可见变化',()=>{
  const project=p(),previousColor='#49364F',reservedColors=['#E2EFF9','#F4E3C3'];
  for(const coreColor of ['#E2EFF9',previousColor,'#4A3750']){
    const input={...make()[0],coreColor,style:'主背景 '+coreColor+'，强调色 #445566'},snapshot=structuredClone(input);
    const [changed]=harmonizeThemeDirections([input],project,{reservedColors,previousColor});
    assert.ok(themeColorDistance(changed.coreColor,previousColor)>=16);
    for(const color of reservedColors)assert.ok(distinctThemeColorFamilies(changed.coreColor,color));
    assert.ok(changed.style.includes('主背景 '+changed.coreColor));
    assert.ok(themeAssetPrompt(project,changed,'hero-image').includes('底色 '+promptColor(changed.coreColor)));
    assert.deepEqual(input,snapshot);
    const [registered]=registerStyleDirections(project,[changed],'theme-style-change');
    assert.equal(requireStyleRegistration(project,registered).definition.coreColor,changed.coreColor);
  }
});

test('无需调整的三种明显不同主色保留；单页内容模式不引入封面或目录对象',()=>{
  const project=p(),input=make();input.forEach((d,i)=>d.coreColor=['#FFFFFF','#102030','#E4B643'][i]);
  assert.deepEqual(harmonizeThemeDirections(input,project).map(d=>d.coreColor),input.map(d=>d.coreColor));
  project.brief={title:'内容页',pages:1,cover:false};
  const [d]=harmonizeThemeDirections([{...input[0],heroSubject:'不使用',tocSubject:'不使用'}],project);
  assert.equal(d.heroSubject,'不使用');assert.equal(d.tocSubject,'不使用');assert.equal(d.contentSubject,input[0].contentSubject);
});

test('同色系即使色差很大也必须调整，蓝与邻近青蓝不算两个色系',()=>{
  assert.equal(themeColorFamily('#D6E5F8'),'blue');assert.equal(themeColorFamily('#102E59'),'blue');
  assert.ok(themeColorDistance('#D6E5F8','#102E59')>16);
  assert.equal(distinctThemeColorFamilies('#D6E5F8','#102E59'),false);
  assert.equal(distinctThemeColorFamilies('#1AA5B3','#173E6C'),false);
  for(const colors of [['#D6E5F8','#416FAC','#102E59'],['#FAFAFA','#808080','#202020']]){
    const original=make().map((d,i)=>({...d,coreColor:colors[i]})),directions=harmonizeThemeDirections(original,p());
    assert.equal(new Set(directions.map(d=>themeColorFamily(d.coreColor))).size,3);
    for(let i=0;i<directions.length;i++)for(let j=0;j<i;j++)assert.ok(distinctThemeColorFamilies(directions[i].coreColor,directions[j].coreColor));
    assert.deepEqual(directions.map(d=>d.referenceStyleId),original.map(d=>d.referenceStyleId),'调整色系不改变风格预设来源');
  }
});

test('单个方向更换时避开其他方向的整个色系，已是不同色系则保留原色',()=>{
  const project=p(),others=['#D6E5F8','#F4E3C3'];
  const [changed]=harmonizeThemeDirections([{...make()[0],coreColor:'#102E59'}],project,{reservedColors:others});
  for(const color of others)assert.ok(distinctThemeColorFamilies(changed.coreColor,color));
  const colors=['#C64B3B','#3166B5','#3A9554'];
  const result=harmonizeThemeDirections(make().map((d,i)=>({...d,coreColor:colors[i]})),project);
  assert.deepEqual(result.map(d=>d.coreColor),colors);
});
