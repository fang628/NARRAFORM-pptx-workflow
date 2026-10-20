import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Resvg} from '@resvg/resvg-js';
import {progressRowMetrics,progressArrowRow,progressPlanningRule} from '../lib/progress-navigation.mjs';
import {prepareRebuildPresentation} from '../lib/rebuild-progress.mjs';
import {progressArrowPoints} from '../lib/native-shapes.mjs';
import {prepareProgressReference,validateProgressReference} from '../lib/progress-reference.mjs';
import {synthesizeMaterials} from '../lib/material-synthesis.mjs';
import {digest} from '../lib/visual-model.mjs';

test('两类横列低矮、单行、细微间距，长章节仅缩字号，左右靠近页边',()=>{
  const short=['研究背景','技术路线','实验结果','总结展望'],long=short.map(t=>t+'用于保留历史用户自行填写的完整长名称');
  for(const layout of ['chevron-row','bubble-row']){
    const style={x:28,y:10,w:1544,layout,gap:3,size:24};
    const small=progressRowMetrics(short.map(text=>({text})),style),large=progressRowMetrics(long.map(text=>({text})),style);
    assert.ok(large.h<=small.h&&small.h<=52);assert.ok(large.normalSize<small.normalSize);
    const row=progressArrowRow(long.map((text,i)=>({text,current:i===1})),style),tracks=row.filter(e=>e.key.startsWith('nf-progress-track-'));
    assert.equal(tracks[0].x,28);assert.ok(Math.abs(tracks.at(-1).x+tracks.at(-1).w-1572)<.001);
    for(let i=1;i<tracks.length;i++){
      if(layout==='bubble-row')assert.ok(Math.abs(tracks[i].x-tracks[i-1].x-tracks[i-1].w-3)<.001);
      else {const prev=progressArrowPoints(tracks[i-1]),next=progressArrowPoints(tracks[i]);assert.ok(Math.abs((tracks[i].x+next[5][0])-(tracks[i-1].x+prev[2][0])-3)<.001);}
    }
    assert.ok(row.filter(e=>e.type==='text').every(e=>e.noWrap&&e.size>0));
  }
});

test('六边形到箭形始终同一六点路径，只有左侧中点缓慢内凹',()=>{
  const make=leftTip=>progressArrowPoints({w:250,h:40,progressGeometry:{head:10,leftTip}}),start=make(0);
  for(const t of [0,.1,.25,.5,.75,1]){const points=make(20*t);assert.equal(points.length,6);assert.deepEqual(points.slice(0,5),start.slice(0,5));assert.equal(points[5][1],20);assert.equal(points[5][0],20*t);}
});

test('规划阶段自动精简长章节，不改写用户明确填写的章节',async()=>{
  assert.match(progressPlanningRule,/最多10字/);let calls=0;
  const call=async(c,s,prompt)=>{calls++;return {text:JSON.stringify(prompt.startsWith('仅精简页顶章节名称')?{progressSections:['研究背景','材料方法','实验结果','总结展望']}:{summary:'完整理解',outline:[],questions:[],progressSections:Array.from({length:4},(_,i)=>'研究章节'+i+'包含过于完整的实验条件与详细步骤')})};};
  const result=await synthesizeMaterials({brief:{title:'主题'},readings:[],call});assert.equal(calls,2);assert.ok(result.synthesis.progressSections.every(s=>s.title.length<=10));
  const manual=['用户自行填写的长章节名称','研究方法','实验结果','总结展望'];calls=0;const unchanged=await synthesizeMaterials({brief:{title:'主题'},readings:[],progressSections:manual,call});assert.equal(calls,1);assert.deepEqual(unchanged.synthesis.progressSections.map(s=>s.title),manual);
});

test('从单张参考预览取色，保存来源并缓存；布局或图片变化后重新选择',async()=>{
  const data=fs.mkdtempSync(path.resolve('work/progress-reference-')),id='test',dir=path.join(data,id);fs.mkdirSync(dir);
  const pages=[['245A8C','DBE4ED'],['8B4252','EDDCE1']].map(([accent,track],index)=>{
    const bytes=new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#FFFFFF"/><rect width="1600" height="120" fill="#${track}"/><rect x="32" y="27" width="250" height="72" fill="#${accent}"/><path d="M32 27h250" stroke="#112233" stroke-width="3"/></svg>`).render().asPng(),file='p'+index+'.png';fs.writeFileSync(path.join(dir,file),bytes);return {index,file,previewHash:digest(bytes)};
  });
  const p={id,selectedTheme:'a',brief:{progress:true},deliveryMotion:{progressLayout:'chevron'},slides:pages.map(()=>({kind:'content'})),visualPages:pages,concepts:[{id:'a',coreColor:'FFFFFF',style:'黄黑工业风'}],materials:[]};
  const env={root:path.resolve('.'),data,run:promisify(execFile),credentials:new Map([[id,{text:{key:'fixture',model:'mock'}}]]),save(){}};
  let calls=0;const request=async()=>{calls++;return {text:JSON.stringify({referenceIndex:1,box:[.02,.03,.96,.08],appearance:{accent:'8B4252',track:'EDDCE1',completedFill:'EDDCE1',ink:'112233',muted:'112233',indicatorInk:'FFFFFF',border:'112233',completedBorder:'112233',activeBorder:'112233',shadow:{color:'112233',opacity:.12,blur:2,offset:1,angle:90}},evidence:'第二页横列最接近，配色取自该页'})};};
  await prepareProgressReference(p,env,undefined,{request});assert.equal(p.progressStyleReference.index,1);assert.equal(p.progressStyleReference.appearance.accent,'8B4252');assert.equal(p.progressStyleReference.previewHash,pages[1].previewHash);assert.equal(p.progressStyleReference.mode,'preview-vision');
  prepareRebuildPresentation(p);assert.equal(p.rebuildPresentation.progress.accent,'8B4252');assert.equal(p.rebuildPresentation.progress.border,'112233');assert.equal(p.rebuildPresentation.progress.shadow.color,'112233');
  const positioned=p.rebuildPresentation.progress;
  assert.equal(positioned.referenceIndex,1);assert.equal(positioned.x,32);assert.equal(positioned.w,1536);assert(Math.abs(positioned.y+positioned.h/2-63)<1e-6);
  await prepareProgressReference(p,env,undefined,{request});assert.equal(calls,1);p.deliveryMotion.progressLayout='bubble';await prepareProgressReference(p,env,undefined,{request});assert.equal(calls,2);assert.equal(p.progressStyleReference.layout,'bubble');
  p.deliveryMotion.progressLayout='chevron';await prepareProgressReference(p,env,undefined,{request:async()=>{throw Error('模拟视觉接口不可用');}});assert.equal(p.progressStyleReference.mode,'preview-local');assert.ok([0,1].includes(p.progressStyleReference.index));assert.ok(p.progressStyleReference.warning.includes('视觉接口不可用'));assert.ok(p.progressStyleReference.appearance.accent);
  assert.throws(()=>validateProgressReference({referenceIndex:9},pages),/不存在/);
});
