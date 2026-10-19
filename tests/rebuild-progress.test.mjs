import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import JSZip from 'jszip';
import {Resvg} from '@resvg/resvg-js';
import {prepareRebuildPresentation,normalizeRebuildProgress,stripRebuildProgress,rebuildProgressRegion,deliveryMotionPlan,deliveryMotionSettings} from '../lib/rebuild-progress.mjs';
import {buildVisualDeck} from '../lib/visual-build.mjs';
import {digest,validateAudit,canonicalTexts} from '../lib/visual-model.mjs';
import {themeAssetsStamp} from '../lib/theme-assets.mjs';
import {slideBackground} from '../lib/slide-background.mjs';
import {deliveryPresentationPanel} from '../public/visual-ui.js';
import {patchRebuiltScene} from '../lib/rebuild-tools.mjs';
import {progressLabelSize,progressSceneElements,progressArrowRow,progressRowMetrics} from '../lib/progress-navigation.mjs';
import {nativeShapeGeometry} from '../lib/native-shapes.mjs';

function fixture(){
  const p={brief:{progress:true,toc:true,title:'统一进度与原生动画'},progressSections:[{id:'a',title:'背景'},{id:'b',title:'方法'},{id:'c',title:'结果'},{id:'d',title:'总结'}],slides:[{kind:'cover',title:'标题'},{kind:'toc',title:'目录'},{kind:'content',title:'背景',progressSectionId:'a'},{kind:'content',title:'结果',progressSectionId:'c'}].map(s=>({...s,body:[],sources:[]})),selectedTheme:'a',concepts:[{id:'a',coreColor:'102030',style:'深蓝底，浅色字，青色强调 #82CED0'}],materials:[]};
  prepareRebuildPresentation(p);return p;
}
test('4–6段箭形的相邻多边形边界保留细微间距，整行不越界，高亮与底层使用相同轮廓',()=>{
  for(const count of [4,5,6]){
    const p=fixture();p.progressSections=Array.from({length:count},(_,i)=>({id:'section-'+(i+1),title:'章节'+(i+1)}));prepareRebuildPresentation(p);
    const elements=normalizeRebuildProgress(p,2,[]),tracks=elements.filter(e=>e.key.startsWith('nf-progress-track-'));
    const vertices=e=>nativeShapeGeometry(e).match(/points="([^"]+)"/)[1].split(' ').map(s=>s.split(',').map(Number));
    const near=(a,b)=>assert(Math.abs(a-b)<.0001);
    for(let i=1;i<count;i++){
      const prev=vertices(tracks[i-1]),next=vertices(tracks[i]);
      for(const [a,b]of [[prev[1],next[0]],[prev[2],next[5]],[prev[3],next[4]]]){near(a[0]+p.rebuildPresentation.progress.gap,b[0]);near(a[1],b[1]);}
    }
    near(tracks[0].x,p.rebuildPresentation.progress.x);near(tracks.at(-1).x+tracks.at(-1).w,p.rebuildPresentation.progress.x+p.rebuildPresentation.progress.w);
    const indicator=elements.find(e=>e.key==='nf-progress-indicator');assert.deepEqual(vertices(indicator),vertices(tracks.find(e=>e.x===indicator.x)));
  }
});
test('05统一进度条的几何和字体，封面目录隐藏；同章节不滑动，跨章节滑动',()=>{
  const p=fixture(),original=[{key:'title',type:'text',nodeId:'title',text:'背景',x:80,y:120,w:800,h:60,size:40,color:'ffffff'},{key:'bad-nav',type:'text',nodeId:'navigation-a',text:'背景',x:1,y:1,w:2,h:2},{key:'bad-nav-rail',type:'rect',x:10,y:5,w:300,h:3,fill:'000000'}];
  const pages=p.slides.map((s,i)=>({elements:normalizeRebuildProgress(p,i,i===2?original:[])}));p.reconstruction={slides:pages};
  assert.equal(pages[0].elements.length,0);assert.equal(pages[1].elements.length,0);
  assert.equal(pages[2].elements.filter(e=>e.role==='navigation').length,4);assert(!pages[2].elements.some(e=>e.key==='bad-nav'||e.key==='bad-nav-rail'));assert.equal(pages[2].elements[0].key,'title');
  const labels=pages[2].elements.filter(e=>e.role==='navigation');for(const label of labels){const other=pages[3].elements.find(e=>e.key===label.key);assert(Math.abs((other.y+other.h/2)-(label.y+label.h/2))<.001);assert(Math.abs((other.x+other.w/2)-(label.x+label.w/2))<.001);assert(Math.abs(other.w/other.size-label.w/label.size)<.001);assert.equal(other.fontFace,label.fontFace);assert.equal(label.size,label.bold?30:24);assert.equal(other.size,other.bold?30:24);}
  assert.equal(p.rebuildPresentation.progress.accent,'82CED0','不得把网页黄色强加给PPT');
  const arrows=pages[2].elements.filter(e=>e.managed==='progress'&&e.type==='shape');assert.equal(arrows.length,5);assert(arrows.every(e=>e.shape===(e.x===p.rebuildPresentation.progress.x?'hexagon':'chevron')));
  for(const label of labels){const arrow=arrows.find(e=>e.key==='nf-progress-track-'+label.key.at(-1));assert(label.y>=arrow.y&&label.y+label.h<=arrow.y+arrow.h);assert.equal(label.align,'center');assert.equal(label.valign,'mid');}
  assert.deepEqual(normalizeRebuildProgress(p,2,pages[2].elements),pages[2].elements);
  const plan=deliveryMotionPlan(p);assert(!plan.pages[2].progress);assert.equal(plan.pages[3].progress.toX,pages[3].elements.find(e=>e.key==='nf-progress-indicator').x);assert(plan.pages[3].progress.offset<0);
  assert.equal(plan.pages[3].transition.type,'morph');assert.equal(plan.pages[3].transition.startDelay,0);assert.equal(plan.pages[3].progress.startDelay,0);
  assert.equal(plan.pages[3].labelChanges.length,2);assert(plan.pages[3].labelChanges.some(c=>c.fromSize<c.toSize&&c.toBold));assert(plan.pages[3].labelChanges.some(c=>c.fromSize>c.toSize&&!c.toBold));
  p.slides[3].progressSectionId='section-1';p.reconstruction.slides[3].elements=normalizeRebuildProgress(p,3,[]);assert(!deliveryMotionPlan(p).pages[3].progress);
  assert.equal(deliveryMotionPlan(p).pages[3].transition.type,'morph');assert.deepEqual(deliveryMotionPlan(p).pages[3].labelChanges,[]);
  p.deliveryMotion={enabled:false};assert(deliveryMotionPlan(p).pages.every(s=>!s.fade&&!s.progress));
  assert(deliveryMotionPlan(p).pages.every(s=>s.transition.type==='none'));
});

test('已过章节、当前章节和未到章节三种底色可区分，箭形具有清晰原生描边',()=>{
  const p=fixture(),elements=normalizeRebuildProgress(p,3,[]),passed=elements.find(e=>e.key==='nf-progress-track-0'),future=elements.find(e=>e.key==='nf-progress-track-3'),current=elements.find(e=>e.key==='nf-progress-indicator');
  assert.equal(passed.progressState,'completed');assert.equal(future.progressState,'upcoming');assert.equal(current.progressState,'current');
  assert.notEqual(passed.fill,future.fill);assert.notEqual(passed.fill,current.fill);assert.notEqual(future.fill,current.fill);assert.notDeepEqual(passed.gradient,future.gradient);
  assert(elements.filter(e=>e.type==='shape').every(e=>e.strokeWidth>=1.2&&e.color));
});

test('当前章节字号放大25%，长名称预留放大空间；场景与05重建使用同一字号规则',()=>{
  const text='用于验证章节文字较长时仍然保持完整显示的名称',width=1420/6-10;
  const normal=progressLabelSize(text,width),active=progressLabelSize(text,width,{current:true});
  assert.equal(active,normal*1.25);assert(active*[...text].length<=width+.001);
  const p=fixture(),elements=progressSceneElements({...p.brief,progressSections:p.progressSections,progressNavigation:[{text:'背景',current:true},{text:'方法',current:false}]},2,4,p.slides[2],{accent:'82CED0',muted:'888888'});
  assert.deepEqual(elements.filter(e=>e.type==='text').map(e=>e.size),[30,24]);
  const old=p.rebuildPresentation;p.rebuildPresentation={...old,signature:'旧版字号规则'};delete p.rebuildPresentation.progress.activeScale;
  prepareRebuildPresentation(p);assert.equal(p.rebuildPresentation.progress.activeScale,1.25);
  p.progressSections[1].title=text;
  const labels=normalizeRebuildProgress(p,2,[]).filter(e=>e.type==='text');
  const inactive=labels.filter(e=>!e.bold);assert.equal(new Set(inactive.map(e=>e.size)).size,1);
  assert(labels.find(e=>e.bold).size>Math.max(...inactive.map(e=>e.size)),'当前章节不能因名称较长而比其他章节小');
  assert(labels.every(e=>e.size>0&&e.noWrap),'长名称缩字号且保持单行');
});

test('箭形和气泡横列均保留原生渐变、描边及阴影；切换版式使交付版本失效',()=>{
  const p=fixture(),arrow=normalizeRebuildProgress(p,2,[]),old=p.rebuildPresentation.signature;
  for(const e of arrow.filter(e=>e.type==='shape')){assert.equal(e.gradient.stops.length,2);assert(e.strokeWidth>0);assert.equal(e.shadow.type,'outer');assert.equal(e.shape,e.x===p.rebuildPresentation.progress.x?'hexagon':'chevron');}
  p.deliveryMotion=deliveryMotionSettings({progressLayout:'bubble'});prepareRebuildPresentation(p);assert.notEqual(p.rebuildPresentation.signature,old);
  const bubble=normalizeRebuildProgress(p,2,[]);assert(bubble.filter(e=>e.type==='shape').every(e=>e.shape==='roundRect'&&e.adjustments.adj===50000));
  p.reconstruction={slides:p.slides.map((s,i)=>({elements:normalizeRebuildProgress(p,i,[])}))};assert(deliveryMotionPlan(p).pages[3].progress);
  const panel=deliveryPresentationPanel({unifiedRebuildProgress:true,deliveryMotion:p.deliveryMotion});assert.match(panel,/data-delivery-progress-layout/);assert.match(panel,/value="bubble" selected/);
  assert.throws(()=>deliveryMotionSettings({progressLayout:'unknown'}));
});
test('程序生成导航符合审计准确文案要求，关闭进度条不增添对象',()=>{
  const p=fixture(),s=p.slides[2],title={key:'title',type:'text',nodeId:'title',text:s.title,x:80,y:120,w:800,h:60,size:40,color:'ffffff',fontFace:'Microsoft YaHei',bold:true};
  const elements=normalizeRebuildProgress(p,2,[title]);assert.doesNotThrow(()=>validateAudit(elements,s,[],p,2));
  assert.throws(()=>patchRebuiltScene(elements,{edits:[{key:'nf-progress-indicator',properties:{x:500}}]},{project:p,slide:s,index:2,originalPage:{elements},assets:[]}),/统一生成/);
  p.brief.progress=false;assert.equal(normalizeRebuildProgress(p,2,elements).length,1);
  assert.throws(()=>deliveryMotionSettings({enabled:'yes'}));assert.throws(()=>deliveryMotionSettings({progressSeconds:12}));
  assert.match(deliveryPresentationPanel({unifiedRebuildProgress:true}),/data-delivery-motion/);
});

test('审计排除旧导航与匿名顶栏素材，保留同名正文、原图，长章节使用实际导航高度',()=>{
  const p=fixture();p.progressSections[1].title='用于验证多行章节标题的完整长名称';prepareRebuildPresentation(p);
  const region=rebuildProgressRegion(p,2);assert.equal(region.h,68);assert.equal(rebuildProgressRegion(p,0),null);
  const elements=[
    {key:'title',type:'text',nodeId:'title',text:'背景',x:80,y:20,w:500,h:45},
    {key:'old-text',type:'text',text:'背景',x:80,y:20,w:100,h:45},
    {key:'old-svg',type:'svg',x:30,y:0,w:100,h:region.h-1},
    {key:'old-cutout',type:'cutout',role:'navigation',x:30,y:100,w:100,h:50},
    {key:'original',type:'image',nodeId:'photo',id:'original',x:30,y:0,w:100,h:50},
    {key:'content',type:'rect',x:80,y:region.h+10,w:700,h:100}
  ];
  assert.deepEqual(stripRebuildProgress(p,2,elements).map(e=>e.key),['title','original','content']);
  const result=normalizeRebuildProgress(p,2,elements);assert.equal(result.filter(e=>e.role==='navigation').length,4);assert(!result.some(e=>e.key.startsWith('old-')));
});

test('两种版式自动匹配所选风格配色，切换风格后重新取色',()=>{
  const p=fixture();p.concepts.push({id:'b',coreColor:'F4F0EE',style:'浅色学术',paletteSource:{palette:{accent:'8350AC'}}});
  for(const layout of ['chevron','bubble']){
    p.deliveryMotion=deliveryMotionSettings({progressLayout:layout});p.selectedTheme='a';prepareRebuildPresentation(p);
    assert.equal(p.rebuildPresentation.progress.accent,'82CED0');
    p.selectedTheme='b';prepareRebuildPresentation(p);assert.equal(p.rebuildPresentation.progress.accent,'8350AC');
    const row=normalizeRebuildProgress(p,2,[]),first=row.find(e=>e.key==='nf-progress-track-0'),active=row.find(e=>e.key==='nf-progress-indicator');
    assert.equal(first.shape,layout==='bubble'?'roundRect':'hexagon');assert.equal(active.shape,first.shape);assert.equal(active.fill,'8350AC');
    const panel=deliveryPresentationPanel({...p,unifiedRebuildProgress:true});assert.match(panel,/value="chevron"/);assert.match(panel,/value="bubble"/);assert.match(panel,/取自一张最接近/);
  }
});

test('两种横列强制保留渐变、轻阴影与细描边，缺省或零效果不会退化为纯色色块',()=>{
  const items=['背景','材料与方法','结果分析','总结'].map((text,i)=>({text,current:i===1}));
  for(const layout of ['chevron-row','bubble-row']){
    const row=progressArrowRow(items,{x:86,y:12,w:1420,layout,accent:'315678',track:'CCDDEE',strokeWidth:0,shadow:{opacity:0,blur:0},activeGradient:{stops:[{color:'315678'},{color:'315678'}]}});
    for(const e of row.filter(e=>e.type==='shape')){
      assert(e.strokeWidth>=.8&&e.strokeWidth<=1.5);assert.equal(e.shadow.type,'outer');assert(e.shadow.opacity>=.08&&e.shadow.opacity<=.2);assert(e.shadow.blur>0);
      assert(e.gradient.stops.length>=2);assert.notEqual(e.gradient.stops[0].color,e.gradient.stops.at(-1).color);
    }
  }
});

test('按实际文字分配单框长度并减小字号；跨页不抖动，长名称不换行增高',()=>{
  const short=['背景','方法','结果','总结'],mixed=['背景','材料预处理与实验设计及验证方法的数据处理与分析','结果','总结'];
  const dense=Array.from({length:6},(_,i)=>'章节'+i+'材料处理与实验结果比较分析以及后续研究方向');
  for(const layout of ['chevron-row','bubble-row']){
    const style={x:86,y:12,w:1420,layout,size:28,minSize:22,gap:8,accent:'315678',track:'CCDDEE'};
    const metrics=names=>progressRowMetrics(names.map(text=>({text})),style),simple=metrics(short),complex=metrics(mixed),full=metrics(dense);
    assert(complex.segments[1].w>complex.segments[0].w*1.5);assert(complex.h<=simple.h);assert(full.h<=complex.h);assert(full.normalSize<simple.normalSize);assert(full.normalSize>0);
    for(const names of [short,mixed,dense,['A','Research design','图像与数据融合','结论'],['背景','第一阶段\n第二阶段','结果','总结']]){
      const rows=names.map((_,active)=>progressArrowRow(names.map((text,i)=>({text,current:i===active})),style));
      const tracks=rows[0].filter(e=>e.key.startsWith('nf-progress-track-'));
      assert(Math.abs(tracks.at(-1).x+tracks.at(-1).w-1506)<.001);
      for(let i=1;i<tracks.length;i++)assert(Math.abs(tracks[i].x-(tracks[i-1].x+tracks[i-1].w)-(layout==='bubble-row'?6:-14))<.001);
      for(const row of rows){
        assert.deepEqual(row.filter(e=>e.key.startsWith('nf-progress-track-')).map(({x,y,w,h})=>({x,y,w,h})),tracks.map(({x,y,w,h})=>({x,y,w,h})));
        for(const label of row.filter(e=>e.type==='text')){const track=tracks[Number(label.key.split('-').at(-1))];assert(label.size>0&&label.noWrap);assert(label.x>=track.x&&label.x+label.w<=track.x+track.w+.001);assert(label.y+label.h<=track.y+track.h+.001);}
      }
    }
  }
});
test('实际PowerPoint保存同步Morph与文字几何缩放，正文仅淡化，无延迟路径，原生背景保留',{skip:process.platform!=='win32',timeout:120000},async()=>{
  const p=fixture(),folder=fs.mkdtempSync(path.resolve('work/native-motion-')),bg=path.join(folder,'background.png');
  p.progressSections[2].title='用于验证章节文字较长时仍然保持完整显示的名称';prepareRebuildPresentation(p);
  fs.writeFileSync(bg,new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#102030"/></svg>').render().asPng());
  const sha=digest(fs.readFileSync(bg));p.materials=[{id:'bg',file:'background.png',purpose:'workflow-background',kind:'image',sha256:sha}];
  const asset={materialId:'bg',previewHash:sha,normalized:'background.png'};p.themeAssets={stamp:themeAssetsStamp(p),directions:[{id:'a',assets:{'hero-image':asset,'toc-image':asset,'content-background':asset}}]};
  p.reconstruction={slides:p.slides.map((s,i)=>({index:i,background:slideBackground(p,i),elements:normalizeRebuildProgress(p,i,[{key:'title',type:'text',nodeId:'title',text:s.title,x:86,y:125,w:1100,h:100,size:60,color:'F4F4EF',bold:true}])}))};
  const deck=path.join(folder,'deck.pptx'),spec=path.join(folder,'motion-plan.json');await buildVisualDeck(p,deck,()=>bg);fs.writeFileSync(spec,JSON.stringify(deliveryMotionPlan(p)));
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('tools/render_deck.ps1'),'-DeckPath',deck,'-OutputDir',folder,'-MotionSpec',spec],{timeout:110000,maxBuffer:2e6,windowsHide:true});
  const manifest=JSON.parse(stdout);assert.equal(manifest.pages.length,4);assert.equal(manifest.pptx_sha256,digest(fs.readFileSync(deck)));
  const animations=JSON.parse(fs.readFileSync(path.join(folder,'animation-manifest.json')));assert.equal(animations.pages[3].transition,'morph');assert.equal(animations.pages[3].progressEffects,0);assert.equal(animations.pages[3].progressMorph,true);assert.equal(animations.pages[3].labelMorphCount,2);assert.equal(animations.pages[3].startDelay,0);assert.equal(animations.pages[2].transition,'fade');
  const zip=await JSZip.loadAsync(fs.readFileSync(deck)),xml=await zip.file('ppt/slides/slide4.xml').async('string');
  assert.match(xml,/<p:transition/);assert.match(xml,/<p159:morph[^>]+option="byObject"/);assert.doesNotMatch(xml,/<p:animMotion/);assert.match(xml,/<p:bg>/);assert.match(xml,/name="!!nf-progress-label-0"/);assert.match(xml,/name="!!nf-page-3--title"/);
  const arrow=(xml.match(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g)||[]).find(s=>s.includes('name="!!nf-progress-indicator"'));assert.match(arrow,/<a:custGeom>/);assert.equal((arrow.match(/<a:pt /g)||[]).length,6);
  const firstTrack=(xml.match(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g)||[]).find(s=>s.includes('name="!!nf-progress-track-0"'));assert.match(firstTrack,/<a:custGeom>/);assert.match(firstTrack,/<a:pt x="0" y="50000"/);
  assert.match(arrow,/<a:gradFill/);assert.match(arrow,/<a:outerShdw/);assert.match(arrow,/<a:ln w="9144"/);assert.match(arrow,/<a:close\/>/);
  const third=await zip.file('ppt/slides/slide3.xml').async('string');assert.doesNotMatch(third,/<p:animMotion/);
  assert(manifest.pages[3].texts.some(t=>t.key==='nf-progress-label-0'));
  for(const page of manifest.pages.slice(2)){
    const labels=page.texts.filter(t=>t.key.startsWith('nf-progress-label-'));
    const active=page.index===2?'nf-progress-label-0':'nf-progress-label-2';
    for(const label of labels){
      const expected=p.reconstruction.slides[page.index].elements.find(e=>e.key===label.key).size;
      assert(Math.abs(label.fontSize-expected)<.01,'原生PowerPoint保留各章节字号');
    }
    assert(labels.find(t=>t.key===active).fontSize>0);
    assert(labels.every(t=>t.boundWidth<=t.w+1&&t.boundHeight<=t.h+1),'实际PowerPoint文字不得出框');
  }
  const labelSize=(index,key)=>manifest.pages[index].texts.find(t=>t.key===key).fontSize;
  assert(Math.abs(labelSize(2,'nf-progress-label-0')/labelSize(3,'nf-progress-label-0')-1.25)<.01);
  assert(Math.abs(labelSize(3,'nf-progress-label-2')/labelSize(2,'nf-progress-label-2')-1.25)<.01);
  p.deliveryMotion=deliveryMotionSettings({progressLayout:'bubble'});prepareRebuildPresentation(p);
  p.reconstruction.slides.forEach((page,i)=>{page.elements=normalizeRebuildProgress(p,i,page.elements);});
  const bubbleDeck=path.join(folder,'bubble.pptx'),bubbleDir=path.join(folder,'bubble');await buildVisualDeck(p,bubbleDeck,()=>bg);fs.writeFileSync(spec,JSON.stringify(deliveryMotionPlan(p)));
  await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('tools/render_deck.ps1'),'-DeckPath',bubbleDeck,'-OutputDir',bubbleDir,'-MotionSpec',spec],{timeout:110000,maxBuffer:2e6,windowsHide:true});
  const saved=await JSZip.loadAsync(fs.readFileSync(bubbleDeck)),bubbleXML=await saved.file('ppt/slides/slide4.xml').async('string');
  const pill=bubbleXML.match(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g).find(s=>s.includes('name="!!nf-progress-indicator"'));
  assert.match(pill,/<a:prstGeom prst="roundRect"/);assert.match(pill,new RegExp('<a:gd name="adj" fmla="val '+Math.round(p.reconstruction.slides[3].elements.find(e=>e.key==='nf-progress-indicator').adjustments.adj)+'"'));assert.match(pill,/<a:gradFill/);assert.match(pill,/<a:outerShdw/);assert.match(bubbleXML,/<p159:morph/);assert.doesNotMatch(bubbleXML,/<p:animMotion/);
  // Applying the same transition again must not stack prefixes or animations.
  const again=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('tools/render_deck.ps1'),'-DeckPath',bubbleDeck,'-OutputDir',bubbleDir,'-MotionSpec',spec],{timeout:110000,maxBuffer:2e6,windowsHide:true});
  assert(JSON.parse(again.stdout).pages[3].texts.some(t=>t.key==='nf-progress-label-0'));
  const same=await JSZip.loadAsync(fs.readFileSync(bubbleDeck)),sameXML=await same.file('ppt/slides/slide4.xml').async('string');assert.equal((sameXML.match(/name="!!nf-progress-indicator"/g)||[]).length,1);assert.doesNotMatch(sameXML,/!!!!|!!nf-page-3--!!/);
  p.deliveryMotion.enabled=false;fs.writeFileSync(spec,JSON.stringify(deliveryMotionPlan(p)));
  await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('tools/render_deck.ps1'),'-DeckPath',bubbleDeck,'-OutputDir',bubbleDir,'-MotionSpec',spec],{timeout:110000,maxBuffer:2e6,windowsHide:true});
  const disabled=await JSZip.loadAsync(fs.readFileSync(bubbleDeck)),disabledXML=await disabled.file('ppt/slides/slide4.xml').async('string');assert.doesNotMatch(disabledXML,/<p159:morph|<p:animMotion|name="!!/);assert.match(disabledXML,/name="nf-progress-indicator"/);
});

test('真实PowerPoint：六个长章节在两种自适应横列中均完整可读且保留三种原生效果',{skip:process.platform!=='win32',timeout:120000},async()=>{
  const p=fixture(),folder=fs.mkdtempSync(path.resolve('work/adaptive-progress-')),bg=path.join(folder,'background.png');
  p.progressSections=Array.from({length:6},(_,i)=>({title:'章节'+i+'材料处理与实验结果比较分析以及后续研究方向'}));p.slides[2].progressSectionId='section-1';p.slides[3].progressSectionId='section-4';
  fs.writeFileSync(bg,new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#102030"/></svg>').render().asPng());
  const sha=digest(fs.readFileSync(bg)),asset={materialId:'bg',previewHash:sha,normalized:'background.png'};
  p.materials=[{id:'bg',file:'background.png',purpose:'workflow-background',kind:'image',sha256:sha}];p.themeAssets={stamp:themeAssetsStamp(p),directions:[{id:'a',assets:{'hero-image':asset,'toc-image':asset,'content-background':asset}}]};
  for(const layout of ['chevron','bubble']){
    p.deliveryMotion=deliveryMotionSettings({progressLayout:layout});prepareRebuildPresentation(p);
    const top=p.rebuildPresentation.progress.y+p.rebuildPresentation.progress.h+32;
    p.reconstruction={slides:p.slides.map((s,i)=>({index:i,background:slideBackground(p,i),elements:normalizeRebuildProgress(p,i,[{key:'title',type:'text',nodeId:'title',text:s.title,x:86,y:top,w:1100,h:100,size:60,color:'F4F4EF',bold:true}])}))};
    for(const [i,page]of p.reconstruction.slides.entries())assert.doesNotThrow(()=>validateAudit(page.elements,p.slides[i],[],p,i));
    const dir=path.join(folder,layout);fs.mkdirSync(dir);const deck=path.join(dir,'deck.pptx'),spec=path.join(dir,'motion.json');await buildVisualDeck(p,deck,()=>bg);fs.writeFileSync(spec,JSON.stringify(deliveryMotionPlan(p)));
    const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('tools/render_deck.ps1'),'-DeckPath',deck,'-OutputDir',dir,'-MotionSpec',spec],{timeout:110000,maxBuffer:2e6,windowsHide:true});
    const manifest=JSON.parse(stdout);
    for(const page of manifest.pages.slice(2)){
      const labels=page.texts.filter(t=>t.key.startsWith('nf-progress-label-'));assert.equal(labels.length,6);assert(labels.every(t=>t.fontSize>0&&t.boundWidth<=t.w+1&&t.boundHeight<=t.h+1),'长章节保持单行，按实际字号渲染且不出框');
      if(layout==='bubble')assert(p.reconstruction.slides[page.index].elements.filter(e=>e.type==='shape').every(e=>e.h<=44),'气泡须保持低矮');
    }
    const zip=await JSZip.loadAsync(fs.readFileSync(deck)),xml=await zip.file('ppt/slides/slide4.xml').async('string');
    const shapes=(xml.match(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g)||[]).filter(s=>/name="!!nf-progress-(?:track|indicator)/.test(s));assert.equal(shapes.length,7);
    for(const shape of shapes){assert.match(shape,/<a:gradFill/);assert.match(shape,/<a:outerShdw/);assert.match(shape,/<a:ln w="[1-9]/);}
    assert.match(xml,/<p159:morph/);assert.match(xml,/wrap="none"/);
  }
});
