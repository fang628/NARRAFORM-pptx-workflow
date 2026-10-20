import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import JSZip from 'jszip';
import {Resvg} from '@resvg/resvg-js';
import {buildVisualDeck} from '../lib/visual-build.mjs';
import {digest,visualStamp} from '../lib/visual-model.mjs';
import {themeAssetsStamp} from '../lib/theme-assets.mjs';
import {deliveryMotionPlan} from '../lib/rebuild-progress.mjs';
import {reusableCandidatePages,copyReusablePageFiles} from '../lib/candidate-page-cache.mjs';
const python=path.resolve('.venv/Scripts/python.exe');
function fixture(){
 const dir=fs.mkdtempSync(path.resolve('work/page-reuse-')),bg=path.join(dir,'bg.png'),asset=path.join(dir,'icon.svg');
 const bytes=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#eee"/></svg>').render().asPng();fs.writeFileSync(bg,bytes);
 fs.writeFileSync(asset,'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path d="M0 0L100 100L100 0Z" fill="#888"/></svg>');
 const p={id:'p',version:1,brief:{title:'增量测试',progress:false},slides:Array.from({length:3},(_,i)=>({kind:'content',title:'标题'+i,body:['正文'+i],sources:[]})),selectedTheme:'a',concepts:[{id:'a',coreColor:'EEEEEE'}],materials:[{id:'bg',kind:'image',purpose:'workflow-background',file:bg,sha256:digest(bytes)},{id:'icon',file:asset,kind:'image',sha256:digest(fs.readFileSync(asset))}],visualPages:{}};
 p.themeAssets={stamp:themeAssetsStamp(p),directions:[{id:'a',assets:{'content-background':{materialId:'bg',previewHash:digest(bytes),normalized:bg}}}]};
 p.reconstruction={mode:'free',slides:p.slides.map((s,i)=>({background:{id:'bg',sha256:digest(bytes)},elements:[{key:'title',type:'text',role:'title',nodeId:'title',text:s.title,x:80,y:100,w:800,h:90,size:40,color:'222222'},{key:'body',type:'text',nodeId:'body-0',text:s.body[0],x:80,y:300,w:800,h:90,size:28,color:'222222'},{key:'icon',type:'image',id:'icon',implementation:'svg',x:1200,y:400,w:100,h:100}]}))};
 for(let i=0;i<3;i++)p.visualPages[i]={previewHash:digest(bytes),stamp:'preview'+i};
 const getImage=(_,id)=>id==='bg'?bg:asset;
 return {p,dir,bg,getImage};
}
test('仅组装修改页，保留未改页的OOXML和关系；完整PPT的背景、素材、文字与结构有效',async()=>{
 const {p,dir,getImage}=fixture(),base=path.join(dir,'base.pptx'),next=path.join(dir,'next.pptx');p.reconstruction.slides[0].elements[0].gradient={type:'linear',angle:90,stops:[{position:0,color:'FFFFFF',opacity:1},{position:1,color:'77CCFF',opacity:1}]};p.reconstruction.slides[2].elements.push({key:'untouched-gradient',type:'rect',x:1000,y:700,w:200,h:80,fill:'112233',color:'112233',strokeWidth:0,gradient:{type:'linear',angle:0,stops:[{position:0,color:'112233',opacity:1},{position:1,color:'445566',opacity:1}]}});await buildVisualDeck(p,base,getImage);
 const prior=await JSZip.loadAsync(fs.readFileSync(base));p.slides[1].body=['修改后的正文'];p.reconstruction.slides[1].elements[1].text='修改后的正文';
 let calls=0;await buildVisualDeck(p,next,(...args)=>{calls++;return getImage(...args);},{reuse:{deck:base,indices:[1]}});assert.equal(calls,2,'仅读取修改页底图和素材');
 const updated=await JSZip.loadAsync(fs.readFileSync(next));
 for(const page of [1,3])for(const part of [`ppt/slides/slide${page}.xml`,`ppt/slides/_rels/slide${page}.xml.rels`])assert.equal(await updated.file(part).async('string'),await prior.file(part).async('string'));
 assert.match(await updated.file('ppt/slides/slide2.xml').async('string'),/修改后的正文/);
 const spec=path.join(dir,'spec.json');fs.writeFileSync(spec,JSON.stringify({slides:p.reconstruction.slides.map(s=>s.elements),backgrounds:p.reconstruction.slides.map(s=>s.background)}));
 const structure=JSON.parse(execFileSync(python,['tools/release_check.py',next,spec],{encoding:'utf8'}));assert(structure.passed);assert.equal(structure.slides.length,3);
 const baseline=path.join(dir,'baseline.json');fs.writeFileSync(baseline,JSON.stringify(structure));const partial=JSON.parse(execFileSync(python,['tools/release_check.py',next,spec,'--pages','1','--baseline',baseline],{encoding:'utf8'}));assert(partial.passed);assert.deepEqual(partial.slides,structure.slides);
});
test('复用只在页面、动画、底图、素材和工件哈希一致时成立；失败页也保留原检查结果',async()=>{
 const {p,dir,bg,getImage}=fixture(),base=path.join(dir,'exports');fs.mkdirSync(base);await buildVisualDeck(p,path.join(base,'deck.pptx'),getImage);
 const write=(name,value)=>fs.writeFileSync(path.join(base,name),typeof value==='string'?value:JSON.stringify(value));
 write('deck-spec.json',{slides:p.reconstruction.slides.map(s=>s.elements),backgrounds:p.reconstruction.slides.map(s=>s.background)});write('motion-plan.json',deliveryMotionPlan(p));
 const pages=Array.from({length:3},(_,i)=>({index:i,file:`S0${i+1}.png`,texts:[]}));
 for(let i=0;i<3;i++)for(const file of [pages[i].file,`approved-${i}.png`,`rebuilt-${i}.png`,`compare-${i}.png`])fs.copyFileSync(bg,path.join(base,file));
 write('render-manifest.json',{pages});write('structure-report.json',{passed:true,slides:[{index:0},{index:1},{index:2}]});
 const review={pages:[0,1,2].map(index=>({index,passed:index!==2,issues:index===2?['原有问题']:[]}))};write('qa-review.json',review);write('content.json',{materials:p.materials});
 p.candidate={id:'old',dir:'exports',file:'deck.pptx',version:1,stamp:visualStamp(p),review,proofs:fs.readdirSync(base).map(file=>({file,sha256:digest(fs.readFileSync(path.join(base,file)))}))};
 const env={data:path.dirname(dir),getImage};const actualId=p.id;p.id=path.basename(dir);p.candidate.stamp=visualStamp(p);
 assert.deepEqual(reusableCandidatePages(p,env).indices,[0,1,2]);p.reconstruction.slides[1].elements[1].x+=1;assert.deepEqual(reusableCandidatePages(p,env).indices,[0,2]);
 const destination=path.join(dir,'copied');fs.mkdirSync(destination);copyReusablePageFiles(reusableCandidatePages(p,env),destination);assert(fs.existsSync(path.join(destination,'compare-2.png')));assert(!fs.existsSync(path.join(destination,'compare-1.png')));
 fs.writeFileSync(path.join(base,'S01.png'),'tampered');assert.deepEqual(reusableCandidatePages(p,env).indices,[2]);p.id=actualId;
});

test('实际PowerPoint增量渲染只导出指定页，未修改页无需重新测量，合并素材关系可正常打开',{skip:process.platform!=='win32',timeout:120000},async()=>{
 const {p,dir,getImage}=fixture(),deck=path.join(dir,'base.pptx'),full=path.join(dir,'full');fs.mkdirSync(full);await buildVisualDeck(p,deck,getImage);
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const run=promisify(execFile),motion=path.join(dir,'motion.json');fs.writeFileSync(motion,JSON.stringify(deliveryMotionPlan(p)));
 await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('tools/render_deck.ps1'),'-DeckPath',deck,'-OutputDir',full,'-MotionSpec',motion],{timeout:110000,windowsHide:true});
 p.reconstruction.slides[1].elements[1].text='只更新此页';const next=path.join(dir,'next.pptx');await buildVisualDeck(p,next,getImage,{reuse:{deck,indices:[1]}});
 const delta=path.join(dir,'delta');fs.mkdirSync(delta);fs.writeFileSync(motion,JSON.stringify({...deliveryMotionPlan(p),pages:deliveryMotionPlan(p).pages.filter(page=>page.index===1)}));
 await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('tools/render_deck.ps1'),'-DeckPath',next,'-OutputDir',delta,'-MotionSpec',motion,'-PageIndices','1'],{timeout:110000,windowsHide:true});
 const manifest=JSON.parse(fs.readFileSync(path.join(delta,'render-manifest.json'),'utf8'));assert.deepEqual(manifest.pages.map(page=>page.index),[1]);assert(fs.existsSync(path.join(delta,'S02.png')));assert(!fs.existsSync(path.join(delta,'S01.png')));assert(!fs.existsSync(path.join(delta,'deck.pdf')));
 const spec=path.join(dir,'spec.json');fs.writeFileSync(spec,JSON.stringify({slides:p.reconstruction.slides.map(s=>s.elements),backgrounds:p.reconstruction.slides.map(s=>s.background)}));
 assert(JSON.parse(execFileSync(python,['tools/release_check.py',next,spec],{encoding:'utf8'})).passed);
});
