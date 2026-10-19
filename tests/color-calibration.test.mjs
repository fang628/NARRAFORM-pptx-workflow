import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import JSZip from 'jszip';import {Resvg} from '@resvg/resvg-js';
import {adjustedColor,applyNativeColorAdjustments,colorAdjustment} from '../lib/color-adjustment.mjs';
import {applyColorCalibration,measureColorCalibration} from '../lib/color-calibration.mjs';
import {buildVisualDeck} from '../lib/visual-build.mjs';import {nativeSVG,digest} from '../lib/visual-model.mjs';import {slideBackground} from '../lib/slide-background.mjs';import {themeAssetsStamp} from '../lib/theme-assets.mjs';
const run=promisify(execFile),root=path.resolve('.'),python=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const png=svg=>new Resvg(svg).render().asPng();
const canvas=color=>png(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="white"/><rect x="100" y="100" width="600" height="300" fill="#${color}"/></svg>`);
test('显示参数校验、原生色值与SVG滤镜保留素材身份和结构',()=>{
 assert.throws(()=>colorAdjustment({saturation:9}),/微调范围/);assert.equal(adjustedColor('6699CC',{saturation:1,brightness:0}),'6699CC');
 const e={key:'shape',type:'rect',x:100,y:100,w:200,h:100,fill:'6699CC',color:'6699CC',colorAdjustment:{saturation:.88,brightness:.03}};
 assert.doesNotMatch(nativeSVG([e],()=>''),/feColorMatrix/);
 const xml='<p:sp><p:nvSpPr><p:cNvPr id="1" name="shape"/></p:nvSpPr><a:solidFill><a:srgbClr val="6699CC"/></a:solidFill></p:sp>';
 assert.equal(applyNativeColorAdjustments(xml,[e]),xml);assert.equal(e.fill,'6699CC');
});
test('复渲染实际色差改善后接受，失败或样本缺失则回退，导航不微调',()=>{
 const page={background:{id:'bg'},elements:[{key:'a',type:'image',implementation:'cutout'},{key:'nf-progress-track-0',type:'shape'}]},state={pending:new Map(),blocked:new Set()};
 const proposal={key:'a',status:'proposed',error:10,saturation:.9,brightness:.03};
 assert.ok(applyColorCalibration(page,{regions:[proposal]},state).changed);assert.equal(page.elements[0].colorAdjustment.saturation,.9);
 const accepted=applyColorCalibration(page,{regions:[{key:'a',status:'unchanged',error:5}]},state);assert.equal(accepted.records[0].status,'accepted');
 applyColorCalibration(page,{regions:[{...proposal,error:5}]},state);const reverted=applyColorCalibration(page,{regions:[{key:'a',status:'unchanged',error:8}]},state);assert.equal(reverted.records[0].status,'reverted');assert.equal(page.elements[0].colorAdjustment.saturation,.9);
 const protectedPage={background:{},elements:[{key:'text',type:'text'},{key:'native',type:'rect'},{key:'original',type:'image'},{key:'vector',type:'image',implementation:'svg'}]};assert.equal(applyColorCalibration(protectedPage,{regions:protectedPage.elements.map(e=>({...proposal,key:e.key}))}).changed,false);
 const bgState={pending:new Map(),blocked:new Set()};applyColorCalibration(page,{regions:[{...proposal,key:'__background__'}]},bgState);applyColorCalibration(page,{regions:[]},bgState);assert.equal(page.background.colorAdjustment,undefined);
 assert.equal(applyColorCalibration(page,{regions:[{...proposal,key:'nf-progress-track-0'}]}).changed,false);
});
test('遮罩区域的HSV判断与Lab拟合找到明暗差，不把色相差当作饱和度问题',async()=>{
 const dir=fs.mkdtempSync(path.resolve('work/color-fit-')),actual=path.join(dir,'actual.png'),ref=path.join(dir,'ref.png');fs.writeFileSync(actual,canvas('6699CC'));fs.writeFileSync(ref,canvas(adjustedColor('6699CC',{saturation:.88,brightness:-.03})));
 const elements=[{key:'box',type:'image',implementation:'cutout',x:100,y:100,w:600,h:300}];
 const result=await measureColorCalibration({root,run},python,[{reference:ref,rendered:actual,elements}],path.join(dir,'fit'));
 const fit=result.pages[0].regions.find(r=>r.key==='box');assert.equal(fit.status,'proposed',JSON.stringify(fit));assert.ok(fit.predictedError<fit.error*.8);assert.equal(result.pages[0].regions.find(r=>r.key==='__background__').status,'unchanged');
 fs.writeFileSync(ref,canvas('DD8833'));const hue=await measureColorCalibration({root,run},python,[{reference:ref,rendered:actual,elements}],path.join(dir,'hue'));assert.equal(hue.pages[0].regions.find(r=>r.key==='box').status,'hue_mismatch');
 const failed=await measureColorCalibration({root,run:async()=>{throw Error('unavailable');}},python,[{reference:ref}],path.join(dir,'unavailable'));assert.equal(failed.pages[0].status,'unavailable');
});
test('透明素材只用实心主体取样，参考图色差不能被透明留白淹没',async()=>{
 const dir=fs.mkdtempSync(path.resolve('work/color-alpha-')),source=path.join(dir,'source.png'),actual=path.join(dir,'actual.png'),ref=path.join(dir,'reference.png');
 const svg=color=>`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="white"/><circle cx="400" cy="250" r="35" fill="#${color}"/></svg>`;
 fs.writeFileSync(actual,png(svg('6699CC')));fs.writeFileSync(ref,png(svg(adjustedColor('6699CC',{saturation:.88,brightness:-.06}))));
 fs.writeFileSync(source,png('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><circle cx="300" cy="150" r="35" fill="#6699CC"/></svg>'));
 const result=await measureColorCalibration({root,run},python,[{reference:ref,rendered:actual,elements:[{key:'cutout',type:'image',implementation:'cutout',id:'source',x:100,y:100,w:600,h:300}],assetFiles:{source}}],path.join(dir,'analysis'));
 const region=result.pages[0].regions.find(r=>r.key==='cutout');assert.equal(region.status,'proposed',JSON.stringify(region));
});
test('PPT图片和底图以原生显示效果调整，原始媒体哈希不变，实际PowerPoint可渲染',{timeout:120000},async()=>{
 const dir=fs.mkdtempSync(path.resolve('work/color-native-')),bg=path.join(dir,'bg.png'),photo=path.join(dir,'photo.png'),bgBytes=png('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#6688AA"/></svg>');fs.writeFileSync(bg,bgBytes);fs.writeFileSync(photo,png('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#CC7755"/></svg>'));
 const slide={kind:'content',title:'显示调整',body:[],sources:[]},p={brief:{title:slide.title,cover:false,progress:false},slides:[slide,slide],concepts:[],selectedTheme:'a',materials:[{id:'bg',file:bg,kind:'image',purpose:'workflow-background',sha256:digest(bgBytes)}]};p.themeAssets={stamp:themeAssetsStamp(p),directions:[{id:'a',assets:{'content-background':{materialId:'bg',normalized:bg,previewHash:digest(bgBytes)}}}]};
 const adjustment={saturation:.88,brightness:.06},e={key:'image',type:'image',id:'photo',x:100,y:100,w:300,h:300};p.reconstruction={slides:[{background:slideBackground(p,0),elements:[e]},{background:{...slideBackground(p,1),colorAdjustment:adjustment},elements:[{...e,implementation:'cutout',colorAdjustment:adjustment}]}]};
 const deck=path.join(dir,'deck.pptx');await buildVisualDeck(p,deck,(_,id)=>id==='bg'?bg:photo);const zip=await JSZip.loadAsync(fs.readFileSync(deck)),xml=await zip.file('ppt/slides/slide2.xml').async('string');assert.match(xml,/<a:satMod amt="88000"/);assert.match(xml,/<a:lum bright="6000"/);
 const hashes=await Promise.all(Object.keys(zip.files).filter(n=>n.startsWith('ppt/media/')&&!zip.files[n].dir).map(async n=>digest(await zip.file(n).async('nodebuffer'))));assert.ok(hashes.includes(digest(bgBytes)));assert.ok(hashes.includes(digest(fs.readFileSync(photo))));
 if(process.platform==='win32'){
 await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'tools/render_deck.ps1'),'-DeckPath',deck,'-OutputDir',dir],{windowsHide:true,timeout:100000,maxBuffer:1000000});
 const result=JSON.parse((await run(python,['-c','from PIL import Image;import json,sys;a=Image.open(sys.argv[1]).convert("RGB");b=Image.open(sys.argv[2]).convert("RGB");print(json.dumps([list(a.getpixel((20,800))),list(b.getpixel((20,800))),list(a.getpixel((200,200))),list(b.getpixel((200,200)))]))',path.join(dir,'S01.png'),path.join(dir,'S02.png')])).stdout);
 assert.notDeepEqual(result[0],result[1]);assert.notDeepEqual(result[2],result[3]);assert.ok(result[1].reduce((a,b)=>a+b)>result[0].reduce((a,b)=>a+b));
 }
});
