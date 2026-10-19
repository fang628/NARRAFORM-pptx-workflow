import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import JSZip from 'jszip';import {Resvg} from '@resvg/resvg-js';
import {visualTextStyle} from '../lib/visual-text-style.mjs';
import {nativeTextLines} from '../lib/native-text-lines.mjs';
import {validateAudit,nativeSVG,digest} from '../lib/visual-model.mjs';
import {optimizeTextLayout} from '../lib/text-layout.mjs';
import {buildVisualDeck} from '../lib/visual-build.mjs';
import {slideBackground} from '../lib/slide-background.mjs';
import {themeAssetsStamp} from '../lib/theme-assets.mjs';

 test('间距单位归一、合理边界与无效值；不引入段距字段',()=>{
 const style=visualTextStyle({key:'t',size:30,charSpacing:'1.2pt',lineSpacing:'1.5em',paraSpaceAfter:88},'body');
 assert.equal(style.charSpacing,2);assert.equal(style.lineSpacing,45);assert.ok(!('paraSpaceAfter' in style));
 assert.equal(visualTextStyle({size:30,lineSpacingMultiple:1.4},'body').lineSpacing,42);
 assert.equal(visualTextStyle({size:30,charSpacing:-100,lineSpacing:1},'body').charSpacing,-4.5);
 assert.throws(()=>visualTextStyle({key:'t',size:30,charSpacing:'invalid'},'body'),/间距无效/);
 assert.ok(!('lineSpacing' in visualTextStyle({size:30},'body')),'旧场景保持原默认值');
 });
 test('审计和工具修改贯通间距参数，不丢失模型提取值',()=>{
 const slide={title:'主标题',body:[],sources:[]};
 const [e]=validateAudit([{key:'title',type:'text',nodeId:'title',text:'主标题',x:100,y:100,w:800,h:90,size:40,charSpacing:2,lineSpacing:58}],slide,[]);
 assert.equal(e.charSpacing,2);assert.equal(e.lineSpacing,58);
 });
 test('本地预览按字距换行，按行距定位，不用额外空格模拟',()=>{
 assert.deepEqual(nativeTextLines('一二三四',60,20,2),['一二','三四']);
 const e={type:'text',key:'t',x:20,y:20,w:60,h:140,size:20,text:'一二三四',charSpacing:2,lineSpacing:44,color:'222222'};
 const svg=nativeSVG([e],()=>{});assert.match(svg,/letter-spacing="2"/);assert.match(svg,/dy="44"/);assert.equal((svg.match(/<tspan/g)||[]).length,2);
 });
 test('真实测量溢出后小幅调整行距或字距，不改文字字号段距，不侵入其他对象',()=>{
 const e={type:'text',key:'t',text:'甲乙\n丙丁',x:100,y:100,w:200,h:70,size:30,lineSpacing:45,charSpacing:0,paraSpaceAfter:17};
 const obstacle={type:'image',key:'image',x:100,y:174,w:200,h:100};
 const r=optimizeTextLayout([e,obstacle],[{key:'t',boundWidth:190,boundHeight:73,fontSize:30,lineCount:2,lineSpacing:45,maxLineCharacters:2,charSpacing:0}]);
 assert.equal(r.elements[0].size,30);assert.ok(r.elements[0].lineSpacing<45);assert.equal(r.elements[0].paraSpaceAfter,17);assert.equal(r.elements[0].text,e.text);assert.deepEqual(r.elements[1],obstacle);
 const h={...e,key:'h',text:'甲乙丙丁戊己庚辛壬癸',h:40,w:300,charSpacing:1};
 const right={type:'image',key:'right',x:401,y:100,w:100,h:100};
 const horizontal=optimizeTextLayout([h,right],[{key:'h',boundWidth:303,boundHeight:30,fontSize:30,lineCount:1,maxLineCharacters:10,charSpacing:1}]);
 assert.equal(horizontal.elements[0].size,30);assert.ok(horizontal.elements[0].charSpacing<1);assert.deepEqual(horizontal.elements[1],right);
 assert.deepEqual(optimizeTextLayout([e],[],{targetKeys:[]}).elements,[e]);
 });
 test('PPTX原生字距与固定行距写入，PowerPoint实际测量和显示吻合',{timeout:120000},async()=>{
 const dir=fs.mkdtempSync(path.resolve('work/text-spacing-')),bg=path.join(dir,'bg.png'),bytes=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="white"/></svg>').render().asPng();fs.writeFileSync(bg,bytes);
 const slide={kind:'content',title:'间距校准',body:[],sources:[]},p={id:'test',brief:{title:slide.title,cover:false,progress:false},slides:[slide],concepts:[],selectedTheme:'a',materials:[{id:'bg',kind:'image',file:bg,purpose:'workflow-background',sha256:digest(bytes)}]};
 p.themeAssets={stamp:themeAssetsStamp(p),directions:[{id:'a',assets:{'content-background':{materialId:'bg',normalized:bg,previewHash:digest(bytes)}}}]};
 const elements=[{key:'spacing',type:'text',text:'原生文字间距\n逐行还原预览\n保持文案完整',x:100,y:100,w:1000,h:220,size:40,charSpacing:2,lineSpacing:64,fontFace:'Microsoft YaHei',color:'222222',bold:false}];p.reconstruction={slides:[{background:slideBackground(p,0),elements}]};
 const deck=path.join(dir,'deck.pptx');await buildVisualDeck(p,deck,()=>bg);const zip=await JSZip.loadAsync(fs.readFileSync(deck)),xml=await zip.file('ppt/slides/slide1.xml').async('string');
 assert.match(xml,/spc="120"/);assert.match(xml,/<a:lnSpc><a:spcPts val="3840"\/><\/a:lnSpc>/);
 if(process.platform==='win32'){
 await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('tools/render_deck.ps1'),'-DeckPath',deck,'-OutputDir',dir],{windowsHide:true,timeout:100000,maxBuffer:1000000});
 const manifest=JSON.parse(fs.readFileSync(path.join(dir,'render-manifest.json'),'utf8')),m=manifest.pages[0].texts.find(t=>t.key==='spacing');
 assert.equal(m.lineCount,3);assert.ok(Math.abs(m.lineSpacing-64)<1,JSON.stringify(m));assert.ok(Math.abs(m.charSpacing-2)<.1,JSON.stringify(m));assert.ok(m.boundWidth<elements[0].w&&m.boundHeight<elements[0].h);
 }
 });
