import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Resvg} from '@resvg/resvg-js';
import {prepareRebuildPresentation,normalizeRebuildProgress,rebuildProgressRegion} from '../lib/rebuild-progress.mjs';
import {prepareProgressReference,validateProgressReference} from '../lib/progress-reference.mjs';
import {digest} from '../lib/visual-model.mjs';

const appearance={accent:'245A8C',track:'DBE4ED',completedFill:'DBE4ED',ink:'112233',muted:'112233',indicatorInk:'FFFFFF',border:'112233',completedBorder:'112233',activeBorder:'112233',shadow:{color:'112233',opacity:.12,blur:2,offset:1,angle:90}};
const project=()=>({brief:{progress:true,title:'Reference alignment'},materials:[],selectedTheme:'a',concepts:[{id:'a',coreColor:'FFFFFF'}],progressSections:['材料与需求','内容规划','视觉方案','导出交付'].map((title,i)=>({id:String(i),title})),slides:[{kind:'cover'},{kind:'toc'},{kind:'content',progressSectionId:'0'},{kind:'content',progressSectionId:'2'}].map(s=>({...s,title:'标题',body:[],sources:[]}))});

test('both native layouts align to one preview, with stable edges/center and readable padding',()=>{
  for(const layout of ['chevron','bubble']){
    const p=project();p.deliveryMotion={progressLayout:layout};
    p.progressStyleReference={layout,theme:'a',index:2,box:[.045,.065,.91,.065],appearance};
    prepareRebuildPresentation(p);const style=p.rebuildPresentation.progress;
    assert.equal(style.x,72);assert.equal(style.w,1456);assert.equal(style.referenceIndex,2);
    const rows=[2,3].map(i=>normalizeRebuildProgress(p,i,[]));
    for(const row of rows){
      const tracks=row.filter(e=>e.key.startsWith('nf-progress-track-'));
      assert.equal(tracks[0].x,72);assert(Math.abs(tracks.at(-1).x+tracks.at(-1).w-1528)<1e-6);
      assert(Math.abs(tracks[0].y+tracks[0].h/2-(.065+.065/2)*900)<1e-6);
      for(const label of row.filter(e=>e.type==='text'))assert(label.y>=style.y+6-1e-6&&label.y+label.h<=style.y+style.h-6+1e-6);
    }
    assert.deepEqual(rows[0].filter(e=>e.key.startsWith('nf-progress-track-')).map(({x,y,w,h})=>({x,y,w,h})),rows[1].filter(e=>e.key.startsWith('nf-progress-track-')).map(({x,y,w,h})=>({x,y,w,h})));
    assert.equal(rebuildProgressRegion(p,2).h,style.y+style.h+12);
    assert.deepEqual(normalizeRebuildProgress(p,0,[]),[]);assert.deepEqual(normalizeRebuildProgress(p,1,[]),[]);
    p.progressStyleReference.theme='other';prepareRebuildPresentation(p);assert.equal(p.rebuildPresentation.progress.x,28);assert.equal(p.rebuildPresentation.progress.y,10);
    p.progressStyleReference.theme='a';p.progressStyleReference.box=[0,0,0,0];prepareRebuildPresentation(p);assert.equal(p.rebuildPresentation.progress.y,10);
  }
  assert.throws(()=>validateProgressReference({referenceIndex:2,appearance},[{index:2}]),/实际横列/);
});

test('local fallback detects the aligned row instead of using the whole header as its position',async()=>{
  for(const layout of ['chevron','bubble']){
    const data=fs.mkdtempSync(path.resolve('work/progress-align-')),id='test',dir=path.join(data,id);fs.mkdirSync(dir);
    const shapes=Array.from({length:4},(_,i)=>{
      const x=80+i*360;
      return layout==='bubble'?`<rect x="${x}" y="65" width="340" height="52" rx="20" fill="#245A8C" stroke="#112233" stroke-width="2"/>`:`<path d="M${x+12} 65h316l12 26-12 26H${x+12}l12-26Z" fill="#245A8C" stroke="#112233" stroke-width="2"/>`;
    }).join('');
    const bytes=new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#DBE4ED"/>${shapes}</svg>`).render().asPng();fs.writeFileSync(path.join(dir,'preview.png'),bytes);
    const p=project();Object.assign(p,{id,deliveryMotion:{progressLayout:layout},visualPages:{2:{index:2,file:'preview.png',previewHash:digest(bytes)}}});
    const env={root:path.resolve('.'),data,run:promisify(execFile),credentials:new Map([[id,{}]]),save(){}};
    await prepareProgressReference(p,env,undefined,{request:async()=>{throw Error('offline fixture');}});
    assert.equal(p.progressStyleReference.mode,'preview-local');const box=p.progressStyleReference.box;assert(box);
    assert(Math.abs(box[1]*900-64)<4);assert(Math.abs((box[1]+box[3]/2)*900-91)<3);assert(box[2]>.8&&box[3]<.08);
    prepareRebuildPresentation(p);const style=p.rebuildPresentation.progress;assert(Math.abs(style.y+style.h/2-91)<3);assert.equal(style.referenceIndex,2);
  }
});
