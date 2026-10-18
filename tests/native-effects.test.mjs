import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import JSZip from 'jszip';
import {Resvg} from '@resvg/resvg-js';
import {validateAudit,nativeSVG,digest} from '../lib/visual-model.mjs';
import {patchRebuiltScene} from '../lib/rebuild-tools.mjs';
import {nativeEffects} from '../lib/native-effects.mjs';
import {buildVisualDeck} from '../lib/visual-build.mjs';
import {themeAssetsStamp} from '../lib/theme-assets.mjs';
import {slideBackground} from '../lib/slide-background.mjs';

const gradient={type:'linear',angle:0,stops:[{position:0,color:'FF0000'},{position:1,color:'0000FF'}]};
const slide={kind:'content',title:'文字描边与阴影',body:['内阴影与独立文字'],sources:[]};
const title={key:'title',type:'text',nodeId:'title',text:slide.title,x:100,y:100,w:1350,h:130,size:80,color:'195EBC',bold:true,outline:{color:'rgba(255,255,255,.9)',width:4},shadow:{color:'000000',blur:5,offset:4,angle:60,opacity:.45},gradient};
const raw=[title,{...title,key:'body',nodeId:'body-0',text:slide.body[0],y:230,size:44,h:80,gradient:null,outline:null,shadow:{type:'inner',color:'000000',blur:0,offset:0,angle:90,opacity:.3}},
  {key:'gradient-arrow',type:'line',x:100,y:380,w:1000,h:0,color:'195EBC',strokeWidth:10,beginArrowType:'dot',endArrowType:'triangle',gradient},
  {key:'dashed-arrow',type:'line',x:100,y:500,w:1000,h:0,color:'195EBC',strokeWidth:5,dashType:'dashDot',beginArrowType:'oval',endArrowType:'stealth'},
  {key:'reverse-arrow',type:'line',x:1200,y:400,w:200,h:220,color:'195EBC',strokeWidth:4,flipV:true,beginArrowType:'diamond',endArrowType:'arrow'},
  {key:'block-arrow',type:'shape',shape:'rightArrow',x:100,y:650,w:900,h:110,fill:'195EBC',gradient}];

test('审计保留描边、内外阴影、圆点与箭头端点、虚线、方向及渐变，SVG场景可渲染',()=>{
  const elements=validateAudit(raw,slide,[]);
  assert.equal(elements[0].outline.opacity,.9);assert.equal(elements[0].outline.width,4);
  assert.equal(elements[1].shadow.type,'inner');assert.equal(elements[1].shadow.blur,0);assert.equal(elements[1].shadow.offset,0);
  assert.equal(elements[2].beginArrowType,'oval');assert.equal(elements[2].gradient.stops[1].color,'0000FF');
  assert.equal(elements[4].flipV,true);
  const svg=nativeSVG(elements,()=>''),png=new Resvg(svg,{font:{loadSystemFonts:true}}).render().asPng();
  assert(png.length>10000);assert.match(svg,/paint-order="stroke fill"/);assert.match(svg,/<filter id="native-shadow-/);
  assert.match(svg,/<circle cx="4" cy="4" r="2.5"/);assert.match(svg,/marker-start="url\(#native-begin-2\)"/);
  assert.match(svg,/<line[^>]+stroke="url\(#native-gradient-2\)"/);assert.match(svg,/stroke-dasharray=/);assert.match(svg,/scale\(1 -1\)/);
  for(const invalid of [{outline:{width:-1}},{shadow:{type:'blur'}},{shadow:{blur:Infinity}}])assert.throws(()=>validateAudit([{...title,...invalid},raw[1]],slide,[]));
  assert.throws(()=>nativeEffects({...raw[2],endArrowType:'invalid'}),/端点/);
});

test('单元素工具可修改与撤除文字效果，也可修改圆点/箭头、虚实和原生线条渐变',()=>{
  const elements=validateAudit(raw,slide,[]),ctx={slide,originalPage:{elements},assets:[],targetKey:'title'};
  const edited=patchRebuiltScene(elements,{edits:[{key:'title',properties:{outline:{color:'FFFFFF',width:6},shadow:{...elements[0].shadow,angle:90}}}]},ctx);
  assert.equal(edited[0].outline.width,6);assert.deepEqual(edited.slice(1),elements.slice(1));
  const plain=patchRebuiltScene(edited,{edits:[{key:'title',properties:{outline:null,shadow:{type:'none'}}}]},{...ctx,originalPage:{elements:edited}});
  assert.equal(plain[0].outline,null);assert.equal(plain[0].shadow,null);
  const arrows=patchRebuiltScene(elements,{edits:[{key:'gradient-arrow',properties:{beginArrowType:'circle',endArrowType:'oval',dashType:'dash',gradient:{...gradient,angle:45}}}]},{...ctx,targetKey:'gradient-arrow'});
  assert.equal(arrows[2].beginArrowType,'oval');assert.equal(arrows[2].endArrowType,'oval');assert.equal(arrows[2].gradient.angle,45);
});

test('真实PowerPoint渲染及保存保留原生文字效果、圆点箭头和线条渐变',{skip:process.platform!=='win32',timeout:120000},async()=>{
  const dir=fs.mkdtempSync(path.resolve('work/native-effects-')),bg=path.join(dir,'bg.png');
  const bytes=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#EEEEEE"/></svg>').render().asPng();fs.writeFileSync(bg,bytes);
  const p={brief:{title:slide.title,progress:false,cover:false},slides:[slide],selectedTheme:'a',concepts:[],materials:[{id:'bg',file:bg,kind:'image',purpose:'workflow-background',sha256:digest(bytes)}]};
  p.themeAssets={stamp:themeAssetsStamp(p),directions:[{id:'a',assets:{'content-background':{materialId:'bg',normalized:bg,previewHash:digest(bytes)}}}]};
  const elements=validateAudit(raw,slide,[]);p.reconstruction={slides:[{background:slideBackground(p,0),elements}]};
  const deck=path.join(dir,'effects.pptx');await buildVisualDeck(p,deck,()=>bg);
  const check=async file=>{
    const zip=await JSZip.loadAsync(fs.readFileSync(file)),xml=await zip.file('ppt/slides/slide1.xml').async('string'),shapes=xml.match(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g),shape=key=>shapes.find(s=>s.includes('name="'+key+'"'));
    assert.match(shape('title'),/<a:ln w="30480"/);assert.match(shape('title'),/<a:outerShdw\b/);assert.match(shape('title'),/<a:gradFill/);assert.match(shape('title'),/<a:t>文字描边与阴影<\/a:t>/);
    const inner=shape('body').match(/<a:innerShdw\b[^>]*>/)?.[0];assert(inner);
    // Office omits zero attributes; DrawingML's blurRad/dist defaults are zero.
    assert.equal(Number(inner.match(/blurRad="(\d+)"/)?.[1]??0),0);assert.equal(Number(inner.match(/dist="(\d+)"/)?.[1]??0),0);
    const line=shape('gradient-arrow').match(/<a:ln\b[^>]*>[\s\S]*?<\/a:ln>/)[0];
    assert.match(line,/<a:gradFill/);assert.match(line,/<a:headEnd type="oval"/);assert.match(line,/<a:tailEnd type="triangle"/);
    assert.match(shape('dashed-arrow'),/<a:prstDash val="dashDot"/);assert.match(shape('reverse-arrow'),/flipV="1"/);
    assert.match(shape('block-arrow'),/<a:prstGeom prst="rightArrow"/);assert.match(shape('block-arrow'),/<a:gradFill/);
    assert.equal(Object.keys(zip.files).filter(n=>/^ppt\/media\//.test(n)&&!zip.files[n].dir).length,1,'文字效果、线条与箭形均为原生对象');
  };
  await check(deck);
  // MotionSpec asks the actual Office renderer to save the same deck after parsing.
  const motion=path.join(dir,'motion.json');fs.writeFileSync(motion,JSON.stringify({version:1,settings:{enabled:false},pages:[{index:0,fade:false}]}));
  const result=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('tools/render_deck.ps1'),'-DeckPath',deck,'-OutputDir',dir,'-MotionSpec',motion],{windowsHide:true,timeout:110000,maxBuffer:2e6});
  const manifest=JSON.parse(result.stdout);assert.equal(manifest.pages.length,1);assert.equal(manifest.pages[0].texts.length,2);await check(deck);
  const python='from PIL import Image;import json,sys;im=Image.open(sys.argv[1]).convert("RGB");print(json.dumps([im.getpixel(p) for p in [(240,456),(1200,456),(120,444)]]))';
  const pixels=JSON.parse((await promisify(execFile)(path.resolve('.venv/Scripts/python.exe'),['-c',python,path.join(dir,'S01.png')],{windowsHide:true})).stdout);
  assert(pixels[0][0]>pixels[0][2]+100,'原生渐变线左段偏红');assert(pixels[1][2]>pixels[1][0]+100,'原生渐变线右段偏蓝');
  assert(pixels[2][0]>pixels[2][1]+70,'圆点端点在实际渲染中具有面积');
  fs.writeFileSync(path.join(dir,'scene.png'),new Resvg(nativeSVG(elements,()=> 'data:image/png;base64,'+bytes.toString('base64'),p.reconstruction.slides[0].background),{font:{loadSystemFonts:true}}).render().asPng());
  console.log('Native effects verified:',path.join(dir,'S01.png'));
});
