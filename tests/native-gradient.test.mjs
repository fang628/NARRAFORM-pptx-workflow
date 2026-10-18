import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import JSZip from 'jszip';
import {Resvg} from '@resvg/resvg-js';
import {visualGradient,gradientFillXML,nativeGradientRule} from '../lib/visual-gradient.mjs';
import {validateAudit,nativeSVG,digest} from '../lib/visual-model.mjs';
import {patchRebuiltScene} from '../lib/rebuild-tools.mjs';
import {buildVisualDeck} from '../lib/visual-build.mjs';
import {themeAssetsStamp} from '../lib/theme-assets.mjs';
import {slideBackground} from '../lib/slide-background.mjs';
import {validateRebuildMethods} from '../lib/rebuild-methods.mjs';

const run=promisify(execFile),linear={type:'linear',angle:0,stops:[{position:0,color:'#ff0000'},{position:.5,color:'yellow'},{position:1,color:'#0000ff'}]};
const radial={type:'radial',stops:[{position:0,color:'FFFFFF'},{position:1,color:'0000FF'}]};
test('原生渐变保留色标、方向与透明度，拒绝不完整数据',()=>{
  const gradient=visualGradient({...linear,angle:-270,stops:[{position:1,color:'rgba(0,0,255,.5)',opacity:.5},{position:0,color:'#f00'}]});
  assert.equal(gradient.angle,90);assert.deepEqual(gradient.stops,[{position:0,color:'FF0000',opacity:1},{position:1,color:'0000FF',opacity:.25}]);
  assert.match(gradientFillXML(gradient,.5),/ang="5400000"/);assert.match(gradientFillXML(gradient,.5),/alpha val="12500"/);
  for(const raw of [{}, {...linear,stops:[]},{...linear,stops:[{position:2,color:'fff'},linear.stops[0]]},{...linear,stops:[linear.stops[0],linear.stops[0]]},{...linear,angle:Infinity},{...radial,center:{x:-1,y:.5}}])assert.throws(()=>visualGradient(raw),/原生渐变格式无效/);
  assert.match(nativeGradientRule,/字形填充/);assert.equal(visualGradient(null),undefined);
  const flat='<svg><defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/></svg>';
  assert.throws(()=>validateRebuildMethods([{key:'gradient-block',type:'svg',svg:flat}]),/简单渐变色块须改为原生/);
  assert.doesNotThrow(()=>validateRebuildMethods([{type:'svg',svg:flat.replace('<rect width="100" height="100"','<path d="M0 0L100 20L50 100Z"')}]),'复杂几何仍可保留SVG');
});

function fixture(){
  const slide={kind:'content',title:'原生渐变标题',body:['渐变文字仍可编辑','普通文字保留纯色'],sources:[]};
  const elements=validateAudit([
    {key:'title',type:'text',nodeId:'title',text:slide.title,x:80,y:60,w:1250,h:145,size:82,color:'000000',bold:true,gradient:linear},
    {key:'subtitle',type:'text',nodeId:'body-0',text:slide.body[0],x:80,y:240,w:1000,h:95,size:52,color:'000000',gradient:{...linear,angle:90}},
    {key:'plain',type:'text',nodeId:'body-1',text:slide.body[1],x:850,y:240,w:680,h:95,size:42,color:'272727'},
    {key:'linear-block',type:'rect',x:80,y:410,w:600,h:170,fill:'000000',color:'222222',strokeWidth:2,gradient:linear},
    {key:'radial-block',type:'ellipse',x:850,y:410,w:450,h:280,fill:'000000',gradient:radial},
    {key:'arrow',type:'shape',shape:'chevron',x:80,y:650,w:550,h:140,fill:'000000',opacity:.8,fillOpacity:.75,gradient:{...linear,angle:135}},
  ],slide,[]);
  return {slide,elements};
}
test('渐变随原生文字与色块进入审计和场景渲染，工具可单独修改或移除',()=>{
  const {slide,elements}=fixture(),p={brief:{progress:false},slides:[slide]};
  assert.equal(elements[0].gradient.stops.length,3);assert.equal(elements[5].fillOpacity,.75);
  const svg=nativeSVG(elements,()=>''),render=new Resvg(svg,{font:{loadSystemFonts:true}}).render();assert.ok(render.asPng().length>1000);
  assert.match(svg,/<text[^>]+fill="url\(#native-gradient-0\)"/);assert.match(svg,/<rect[^>]+fill="url\(#native-gradient-3\)"/);
  const context={slide,project:p,index:0,originalPage:{elements},assets:[],targetKey:'title'};
  const edited=patchRebuiltScene(elements,{edits:[{key:'title',properties:{gradient:{...linear,angle:45}}}]},context);
  assert.equal(edited[0].gradient.angle,45);assert.deepEqual(edited.slice(1),elements.slice(1));
  const plain=patchRebuiltScene(elements,{edits:[{key:'title',properties:{gradient:null,color:'123456'}}]},context);
  assert.equal(plain[0].gradient,null);assert.equal(plain[0].color,'123456');
});

test('PPTX原生渐变可在真实PowerPoint编辑、渲染及往返保存，文字不栅格化',async()=>{
  const dir=fs.mkdtempSync(path.resolve('work','native-gradient-')),backgroundFile=path.join(dir,'background.png'),{slide,elements}=fixture();
  const background=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="white"/></svg>').render().asPng();fs.writeFileSync(backgroundFile,background);
  const p={brief:{title:'原生渐变验证',progress:false,cover:false},slides:[slide],materials:[{id:'bg',file:backgroundFile,kind:'image',purpose:'workflow-background',sha256:digest(background)}],concepts:[],selectedTheme:'a',themeAssets:{directions:[{id:'a',assets:{'content-background':{materialId:'bg',normalized:backgroundFile,previewHash:digest(background),previewReview:{status:'passed'}}}}]}};p.themeAssets.stamp=themeAssetsStamp(p);
  p.reconstruction={slides:[{background:slideBackground(p,0),elements}]};const deck=path.join(dir,'native-gradient.pptx');
  await buildVisualDeck(p,deck,(_p,id)=>p.materials.find(m=>m.id===id).file);
  const zip=await JSZip.loadAsync(fs.readFileSync(deck)),xml=await zip.file('ppt/slides/slide1.xml').async('string'),shapes=xml.match(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g);
  const shape=key=>shapes.find(s=>s.includes(`name="${key}"`));
  for(const key of ['title','subtitle','linear-block','radial-block','arrow'])assert.match(shape(key),/<a:gradFill/);
  assert.doesNotMatch(shape('title').match(/<p:spPr>[\s\S]*?<\/p:spPr>/)[0],/<a:gradFill/,'字形渐变不应给文字加底框');
  assert.match(shape('title'),/<a:t>原生渐变标题<\/a:t>/);assert.match(shape('arrow'),/alpha val="60000"/);
  assert.match(shape('radial-block'),/<a:path path="circle">/);assert.doesNotMatch(shape('plain'),/<a:gradFill/);
  assert.equal(Object.keys(zip.files).filter(name=>/^ppt\/media\//.test(name)&&!zip.files[name].dir).length,1,'只有已登记背景图片，渐变未导出SVG或位图');
  const scene=nativeSVG(elements,()=> 'data:image/png;base64,'+background.toString('base64'),p.reconstruction.slides[0].background);
  fs.writeFileSync(path.join(dir,'scene.svg'),scene);fs.writeFileSync(path.join(dir,'scene.png'),new Resvg(scene,{font:{loadSystemFonts:true}}).render().asPng());
  const output=path.join(dir,'render');
  const result=await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('tests/native-gradient-render.ps1'),'-DeckPath',deck,'-OutputDir',output],{windowsHide:true,timeout:180000,maxBuffer:1000000});
  const manifest=JSON.parse(result.stdout);assert.equal(manifest.renderer,'Microsoft PowerPoint');
  for(const key of ['title','subtitle','linear-block','radial-block','arrow']){
    const item=manifest.objects.find(e=>e.name===key);assert.equal(item.fillType,3,key+' must be a native gradient');assert.ok(item.stops.length>=2);
  }
  assert.equal(manifest.objects.find(e=>e.name==='title').text,'原生渐变标题');assert.equal(manifest.objects.find(e=>e.name==='plain').fillType,1);
  const roundtrip=await JSZip.loadAsync(fs.readFileSync(path.join(output,'roundtrip.pptx'))),saved=await roundtrip.file('ppt/slides/slide1.xml').async('string');
  assert.match(saved,/<a:gradFill/);assert.match(saved,/<a:t>原生渐变标题<\/a:t>/);assert.match(saved,/<a:srgbClr val="00FF00"/);
  const pixelScript='from PIL import Image;import json,sys;files=sys.argv[1:];points=[(110,580),(790,580),(1290,660),(1290,500)];print(json.dumps([[list(Image.open(f).convert("RGB").getpixel(p)) for p in points] for f in files]))';
  const pixels=JSON.parse((await run(path.resolve('.venv/Scripts/python.exe'),['-c',pixelScript,path.join(output,'S01.png'),path.join(output,'S01-edited.png')],{windowsHide:true})).stdout);
  assert.ok(pixels[0][0][0]>220&&pixels[0][0][2]<50,'左端实际渲染为红色');assert.ok(pixels[0][1][2]>220&&pixels[0][1][0]<50,'右端实际渲染为蓝色');
  assert.ok(pixels[0][2][0]>210&&pixels[0][2][1]>210,'径向渐变中心偏白');assert.ok(pixels[0][3][2]>pixels[0][3][0]+60,'径向渐变向外变蓝');
  assert.ok(pixels[1][0][1]>220&&pixels[1][0][0]<50,'直接编辑原生色标后实际渲染为绿色');
  console.log('Native gradient PowerPoint render:',path.join(output,'S01.png'));
});
