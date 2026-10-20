import test from 'node:test';
import assert from 'node:assert/strict';
import {progressArrowRow,progressRowMetrics} from '../lib/progress-navigation.mjs';
import {prepareRebuildPresentation} from '../lib/rebuild-progress.mjs';

for(const layout of ['chevron-row','bubble-row'])test(`${layout} enlarged labels have vertical breathing room and stable centers`,()=>{
  for(const text of ['材料分析','材料处理与实验结果比较分析以及后续研究方向']){
    const items=Array.from({length:6},(_,i)=>({text,current:i===2}));
    const style={x:28,y:10,w:1544,size:24,activeScale:1.25,layout};
    const metrics=progressRowMetrics(items,style);
    assert(metrics.h<=52);
    const elements=progressArrowRow(items,style);
    for(const label of elements.filter(e=>e.type==='text')){
      assert(label.h>=label.size*1.25-1e-6,'reserve line height at both active and normal sizes');
      assert(label.y-style.y>=6-1e-6);
      assert(style.y+metrics.h-label.y-label.h>=6-1e-6);
      assert.equal(label.noWrap,true);
    }
    const next=progressArrowRow(items.map((n,i)=>({...n,current:i===3})),style);
    for(const label of elements.filter(e=>e.type==='text')){
      const after=next.find(e=>e.key===label.key);
      assert(Math.abs(label.y+label.h/2-after.y-after.h/2)<1e-6);
    }
    if(text==='材料分析')assert.equal(metrics.normalSize,24);
  }
});
test('large active scale reduces type instead of clipping and old presentation metrics refresh',()=>{
  const metrics=progressRowMetrics([{text:'背景'}],{w:1544,activeScale:2,size:24});
  assert(metrics.h<=52);assert(metrics.h-12>=metrics.normalSize*2*1.25);
  const p={brief:{progress:true},progressSections:[{title:'背景'},{title:'方法'},{title:'结果'},{title:'总结'}],selectedTheme:'a',concepts:[{id:'a',coreColor:'102030'}]};
  prepareRebuildPresentation(p);
  p.rebuildPresentation.signature=p.rebuildPresentation.signature.replace('[13,','[12,');p.rebuildPresentation.progress.h=44;
  prepareRebuildPresentation(p);assert.equal(p.rebuildPresentation.progress.h,50);
});
