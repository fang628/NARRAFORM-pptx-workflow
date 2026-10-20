import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import JSZip from 'jszip';
import {Resvg} from '@resvg/resvg-js';
import {normalizeDirectionalElement} from '../lib/directional-geometry.mjs';
import {normalizeCurvedArrow} from '../lib/curved-arrows.mjs';
import {validateAudit,canonicalTexts,nativeSVG,digest} from '../lib/visual-model.mjs';
import {patchRebuiltScene} from '../lib/rebuild-tools.mjs';
import {auditedElements} from '../lib/visual-audit-repair.mjs';
import {buildVisualDeck} from '../lib/visual-build.mjs';
import {themeAssetsStamp} from '../lib/theme-assets.mjs';
import {slideBackground} from '../lib/slide-background.mjs';

const slide={kind:'content',title:'箭头与编号',body:['处理样本'],sources:[]};
const texts=()=>canonicalTexts(slide).map((n,i)=>({...n,type:'text',key:'text-'+i,x:50,y:50+i*60,w:1000,h:50,size:32,color:'222222'}));
const number=()=>({key:'step-01',type:'text',nodeId:'visual-number-step-01',forNodeId:canonicalTexts(slide)[1].nodeId,role:'visual-number',numberKind:'ordinal',text:'01',x:100,y:680,w:100,h:60,sourceBox:{x:100,y:680,w:100,h:60},size:40,color:'2255AA'});
const curve=()=>({key:'curved-arrow',type:'svg',x:500,y:480,w:800,h:300,curveArrow:{start:{x:600,y:650},control1:{x:900,y:500},end:{x:1200,y:650},headAt:'end',endDirection:'downRight',color:'2255AA',strokeWidth:4,headSize:20}});

test('弧线尖端严格沿端点切线，方向相反不能只改三角形，支持两端及三次曲线',()=>{
  const q=normalizeCurvedArrow(curve());assert.match(q.svg,/Q 400 20 700 170/);assert.equal((q.svg.match(/<polygon/g)||[]).length,1);
  assert.throws(()=>normalizeCurvedArrow({...curve(),curveArrow:{...curve().curveArrow,endDirection:'upLeft'}}),/切线与登记朝向不符/);
  assert.throws(()=>normalizeCurvedArrow({...curve(),curveArrow:{...curve().curveArrow,endDirection:undefined}}),/朝向不符/);
  const cubic=normalizeCurvedArrow({...curve(),curveArrow:{...curve().curveArrow,control2:{x:1200,y:550},headAt:'both',startDirection:'downLeft',endDirection:'down'}});
  assert.match(cubic.svg,/C 400 20 700 70 700 170/);assert.equal((cubic.svg.match(/<polygon/g)||[]).length,2);
  const degenerate=normalizeCurvedArrow({...curve(),curveArrow:{...curve().curveArrow,control2:curve().curveArrow.end}});
  assert.ok(degenerate.svg,'末控制点重合时采用最后一个有效切线');
  const shifted=curve();shifted.x+=50;for(const key of ['start','control1','end'])shifted.curveArrow[key].x+=50;
  assert.equal(normalizeCurvedArrow(shifted).svg,q.svg,'位置不同但轮廓相同的弧线仍可复用同一SVG素材');
  const shaded=normalizeCurvedArrow({...curve(),curveArrow:{...curve().curveArrow,gradient:{type:'linear',angle:0,stops:[{position:0,color:'FF0000'},{position:1,color:'0000FF'}]}}});
  assert.match(shaded.svg,/<linearGradient/);assert.match(shaded.svg,/<polygon[^>]+fill="url\(#curve-gradient\)"/);
  assert.throws(()=>normalizeCurvedArrow({...curve(),w:100}),/边框/);
});

test('弧线朝向错误在本步自动纠正，保留其他正确元素',async()=>{
  let calls=0;const result=await auditedElements({slide,images:[],request:async prompt=>{
    calls++;if(calls===2)assert.match(prompt,/弧线箭头.*朝向/);
    return {text:JSON.stringify({elements:[...texts(),{...curve(),curveArrow:{...curve().curveArrow,endDirection:calls===1?'upLeft':'downRight'}}]})};
  }});
  assert.equal(calls,2);assert.equal(result.audit.at(-1).curveArrow.endDirection,'downRight');
});

test('显式起止点决定八种线条方向，翻转不改变哪端带箭头，后续可继续移动',()=>{
  for(const end of [{x:100,y:100},{x:400,y:100},{x:700,y:100},{x:100,y:400},{x:700,y:400},{x:100,y:700},{x:400,y:700},{x:700,y:700}]){
    const e={key:'line',type:'line',start:{x:400,y:400},end,endArrowType:'triangle',color:'2255AA',strokeWidth:3};
    const valid=validateAudit([...texts(),e],slide,[]).at(-1);
    assert.equal(valid.x+(valid.flipH?valid.w:0),400);assert.equal(valid.y+(valid.flipV?valid.h:0),400);
    assert.equal(valid.x+(valid.flipH?0:valid.w),end.x);assert.equal(valid.y+(valid.flipV?0:valid.h),end.y);
    assert.equal(valid.endArrowType,'triangle');assert.equal(valid.start,undefined);
    const current=[...texts(),valid],ctx={slide,originalPage:{elements:current},assets:[]};
    const changed=patchRebuiltScene(current,{edits:[{key:'line',properties:{start:{x:500,y:500},end:{x:300,y:300}}}]},ctx);
    assert.equal(changed.at(-1).start,undefined,'端点输入归一化后不能残留，以免覆盖后续坐标修改');
    const moved=patchRebuiltScene(changed,{edits:[{key:'line',properties:{x:310}}]},{...ctx,originalPage:{elements:changed}});
    assert.equal(moved.at(-1).x,310);
  }
  assert.throws(()=>normalizeDirectionalElement({type:'line',start:{x:0,y:0},end:{x:0,y:0}}),/起止点/);
  assert.throws(()=>normalizeDirectionalElement({type:'line',start:{x:0,y:0},end:{x:100,y:100},rotate:90}),/rotate/);
});

test('箭形按尾部轮廓归一化，真正的六边形和程序进度条不被误改',()=>{
  for(const direction of ['right','left','up','down']){
    const input={key:'arrow',type:'shape',shape:'hexagon',x:100,y:300,w:300,h:90,fill:'2255AA',arrowDirection:direction};
    const notch=validateAudit([...texts(),{...input,arrowTail:'notched'}],slide,[]).at(-1);
    assert.equal(notch.shape,'chevron');assert.equal(notch.arrowDirection,direction);
    const flat=validateAudit([...texts(),{...input,arrowTail:'flat'}],slide,[]).at(-1);
    assert.equal(flat.shape,direction+'Arrow');
    const svg=nativeSVG([notch],()=>''),points=svg.match(/polygon points="([^"]+)"/)[1];
    assert.equal(points.split(' ').length,6);
  }
  const hex={type:'shape',shape:'hexagon',x:100,y:100,w:100,h:100};assert.equal(normalizeDirectionalElement(hex),hex);
  const progress={...hex,managed:'progress',arrowDirection:'right',arrowTail:'notched'};assert.equal(normalizeDirectionalElement(progress),progress);
});

test('预览额外序号可原生重建和由修正工具补回，不能冒充事实数据或改写正文',()=>{
  const result=validateAudit([...texts(),number()],slide,[]),n=result.at(-1);
  assert.equal(n.text,'01');assert.equal(n.role,'visual-number');assert.deepEqual(n.sourceBox,number().sourceBox);
  const context={slide,originalPage:{elements:texts()},assets:[]};
  assert.equal(patchRebuiltScene(texts(),{add:[number()]},context).at(-1).text,'01');
  for(const invalid of [{text:'35%'},{text:'2026'},{forNodeId:'missing'},{sourceBox:{x:1590,y:0,w:100,h:60}}]){
    assert.throws(()=>validateAudit([...texts(),{...number(),...invalid}],slide,[]));
  }
  assert.throws(()=>patchRebuiltScene(result,{edits:[{key:n.key,properties:{text:'02'}}]},{...context,originalPage:{elements:result}}),/不能修改文案/);
});

test('独立数字清点发现遗漏会在本步补齐，后续返回不能删除清点记录蒙混通过',async()=>{
  let calls=0;const n=number(),prompts=[];
  const result=await auditedElements({slide,images:[],request:async prompt=>{
    prompts.push(prompt);calls++;
    return {text:JSON.stringify(calls===1?{elements:texts(),numberInventory:[{key:n.key,text:n.text}]}:calls===2?{elements:texts(),numberInventory:[]}:{elements:[...texts(),n]})};
  }});
  assert.equal(calls,3);assert.match(prompts[1],/遗漏已清点数字/);assert.match(prompts[2],/step-01/);
  assert.equal(result.audit.at(-1).text,'01');assert.deepEqual(result.auditValidation.numberInventory,[{key:n.key,text:'01'}]);
});

test('实际PPT保留左向箭头和内凹尾，场景预览的起点箭头也朝外',{skip:process.platform!=='win32',timeout:120000},async()=>{
  const dir=fs.mkdtempSync(path.resolve('work/directional-elements-')),bg=path.join(dir,'bg.png');
  const bytes=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="white"/></svg>').render().asPng();fs.writeFileSync(bg,bytes);
  const raw=[...texts(),number(),
    {key:'start-arrow',type:'line',start:{x:100,y:230},end:{x:700,y:230},beginArrowType:'triangle',color:'2255AA',strokeWidth:5},
    {key:'left-arrow',type:'line',start:{x:1200,y:230},end:{x:850,y:230},endArrowType:'triangle',color:'2255AA',strokeWidth:5},
    {key:'notched',type:'shape',shape:'hexagon',arrowDirection:'right',arrowTail:'notched',x:100,y:350,w:300,h:100,fill:'2255AA'},
    {key:'flat',type:'shape',shape:'hexagon',arrowDirection:'right',arrowTail:'flat',x:600,y:350,w:300,h:100,fill:'2255AA'}];
  const elements=validateAudit(raw,slide,[]),curved=validateAudit([...texts(),curve()],slide,[]).at(-1),curveDraft=path.join(dir,'curve.draft.svg'),curveFile=path.join(dir,'curve.svg');
  fs.writeFileSync(curveDraft,curved.svg);
  await promisify(execFile)(path.resolve('.venv/Scripts/python.exe'),[path.resolve('tools/visual_assets.py'),'svg',curveDraft,curveFile,'960','360'],{windowsHide:true});
  elements.push({...curved,type:'image',id:'curve',implementation:'svg',curveArrow:undefined,sourceCurveArrow:curved.curveArrow});
  const p={brief:{title:slide.title,progress:false,cover:false},slides:[slide],selectedTheme:'a',concepts:[],materials:[{id:'bg',file:bg,kind:'image',purpose:'workflow-background',sha256:digest(bytes)}]};
  p.themeAssets={stamp:themeAssetsStamp(p),directions:[{id:'a',assets:{'content-background':{materialId:'bg',normalized:bg,previewHash:digest(bytes)}}}]};
  p.reconstruction={slides:[{background:slideBackground(p,0),elements}]};
  const getImage=(_p,id)=>id==='curve'?curveFile:bg;
  const deck=path.join(dir,'arrows.pptx');await buildVisualDeck(p,deck,getImage);
  const zip=await JSZip.loadAsync(fs.readFileSync(deck)),xml=await zip.file('ppt/slides/slide1.xml').async('string');
  const shape=key=>(xml.match(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g)||[]).find(s=>s.includes('name="'+key+'"'));
  assert.match(shape('left-arrow'),/flipH="1"/);assert.match(shape('left-arrow'),/<a:tailEnd type="triangle"/);
  assert.match(shape('notched'),/<a:custGeom>/);assert.doesNotMatch(shape('notched'),/prst="hexagon"/);
  assert.match(shape('flat'),/<a:custGeom>/);assert.match(shape('step-01'),/<a:t>01<\/a:t>/);
  const svg=nativeSVG(elements,id=>id==='curve'?'data:image/svg+xml;base64,'+fs.readFileSync(curveFile).toString('base64'):'data:image/png;base64,'+bytes.toString('base64'),p.reconstruction.slides[0].background);
  assert.match(svg,/refX="1"[^>]*orient="auto"[^>]*><g transform="rotate\(180 4 4\)"/);
  const scene=path.join(dir,'scene.png');fs.writeFileSync(scene,new Resvg(svg,{font:{loadSystemFonts:true}}).render().asPng());
  await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('tools/render_deck.ps1'),'-DeckPath',deck,'-OutputDir',dir],{windowsHide:true,timeout:110000,maxBuffer:2e6});
  const script='from PIL import Image;import json,sys;im=Image.open(sys.argv[1]).convert("RGB");pts=[(112,234),(85,234),(862,234),(835,234),(110,400),(140,360),(610,400),(1182,646),(1218,654)];print(json.dumps([im.getpixel((round(x*1.2),round(y*1.2))) for x,y in pts]))';
  for(const file of [scene,path.join(dir,'S01.png')]){
    const colors=JSON.parse((await promisify(execFile)(path.resolve('.venv/Scripts/python.exe'),['-c',script,file],{windowsHide:true})).stdout);
    const blue=c=>c[2]>c[0]+60,white=c=>c.every(v=>v>230);
    assert.ok(blue(colors[0])&&white(colors[1]),file+': 起点箭头朝左，不能朝向线内');
    assert.ok(blue(colors[2])&&white(colors[3]),file+': 反向线条终点箭头朝左');
    assert.ok(white(colors[4])&&blue(colors[5])&&blue(colors[6]),file+': 凹尾与平尾轮廓不能变成六边形');
    assert.ok(blue(colors[7])&&white(colors[8]),file+': 弧线尖端与最后切线一致，朝右下');
  }
  console.log('Directional elements verified:',path.join(dir,'S01.png'));
});
