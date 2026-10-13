import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import JSZip from 'jszip';
import {Resvg} from '@resvg/resvg-js';
import {buildVisualDeck} from '../lib/visual-build.mjs';
import {digest,nativeSVG,visualStamp,rebuiltCurrent} from '../lib/visual-model.mjs';
import {themeAssetsStamp} from '../lib/theme-assets.mjs';
import {slideBackground} from '../lib/slide-background.mjs';
import {visualConcepts} from '../public/visual-ui.js';
import {designRulesFor} from '../lib/design-rules.mjs';
import {materialFidelityPolicy} from '../lib/content-policy.mjs';

test('对应无字底图写入真正PPT背景，原生文字/SVG仍独立，release核对背景原件哈希',async()=>{
  const folder=path.resolve('work','slide-background-'+Date.now());fs.mkdirSync(folder,{recursive:true});
  const p={brief:{title:'底图构建',toc:true,progress:false},selectedTheme:'b',materials:[],concepts:[],pageDesigns:{},slides:['cover','toc','content','content'].map((kind,i)=>({kind,title:'原生标题'+i,body:[],sources:[]})),visualPages:{}};
  p.themeAssets={directions:['a','b','c'].map((id,i)=>({id,assets:Object.fromEntries(['hero-image','toc-image','content-background'].map((use,n)=>{
    const materialId=id+'-'+n,file=path.join(folder,materialId+'.png'),png=new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="${['#112233','#ddeeff','#fefabc'][i]}"/><circle cx="1400" cy="700" r="${40+n*20}" fill="#aabbcc"/></svg>`).render().asPng();fs.writeFileSync(file,png);
    const sha256=digest(png);p.materials.push({id:materialId,file,kind:'image',generated:true,purpose:'workflow-background',sha256});return [use,{materialId,normalized:file,previewHash:sha256,previewReview:{status:'passed'}}];
  }))}))};p.themeAssets.stamp=themeAssetsStamp(p);
  const icon=path.join(folder,'icon.svg');fs.writeFileSync(icon,'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50"><circle cx="25" cy="25" r="20" fill="#334455"/></svg>');p.materials.push({id:'icon',file:icon,kind:'image',generated:true,purpose:'reconstruction',sha256:digest(fs.readFileSync(icon))});
  p.reconstruction={mode:'free',stamp:visualStamp(p),slides:p.slides.map((s,i)=>({background:slideBackground(p,i),elements:[{key:'title',type:'text',text:s.title,x:90,y:100,w:900,h:90,size:40,color:'272727',bold:true},{key:'icon',type:'image',id:'icon',x:1050,y:700,w:50,h:50}]}))};
  assert.deepEqual(p.reconstruction.slides.map(s=>s.background.use),['hero-image','toc-image','content-background','content-background']);assert.ok(p.reconstruction.slides.every(s=>s.background.theme==='b'));assert.equal(rebuiltCurrent(p),true);
  const image=(p,id)=>p.materials.find(m=>m.id===id)?.file,deck=path.join(folder,'deck.pptx');await buildVisualDeck(p,deck,image);
  const zip=await JSZip.loadAsync(fs.readFileSync(deck));
  for(let i=0;i<p.slides.length;i++){
    const xml=await zip.file(`ppt/slides/slide${i+1}.xml`).async('string');assert.match(xml,/<p:bg><p:bgPr><a:blipFill/);assert.match(xml,/原生标题/);assert.doesNotMatch(xml,/__ppt_agent_background__/);assert.equal((xml.match(/<p:pic>/g)||[]).length,1,'背景不计入可编辑内容对象');
    const id=xml.match(/<p:bg>[\s\S]*?r:embed="([^"]+)"/)[1],rels=await zip.file(`ppt/slides/_rels/slide${i+1}.xml.rels`).async('string'),attrs=rels.match(/<Relationship\s+[^>]+>/g).find(r=>r.includes(`Id="${id}"`)),target=attrs.match(/Target="([^"]+)"/)[1];assert.equal(digest(await zip.file(path.posix.normalize('ppt/slides/'+target)).async('nodebuffer')),p.reconstruction.slides[i].background.sha256);
  }
  const spec={slides:p.reconstruction.slides.map(s=>s.elements),backgrounds:p.reconstruction.slides.map(s=>s.background)},specFile=path.join(folder,'spec.json');fs.writeFileSync(specFile,JSON.stringify(spec));
  const check=JSON.parse(execFileSync(path.resolve('.venv/Scripts/python.exe'),['tools/release_check.py',deck,specFile],{encoding:'utf8',windowsHide:true}));assert.equal(check.passed,true);assert.equal(check.slides[0].background,'b-0');
  spec.backgrounds[0].sha256='wrong';fs.writeFileSync(specFile,JSON.stringify(spec));assert.throws(()=>execFileSync(path.resolve('.venv/Scripts/python.exe'),['tools/release_check.py',deck,specFile],{stdio:'pipe',windowsHide:true}),/Command failed/);
  const svg=nativeSVG(p.reconstruction.slides[0].elements,id=>'data:image/png;base64,'+fs.readFileSync(image(p,id)).toString('base64'),p.reconstruction.slides[0].background);assert.ok(svg.indexOf('width="1600" height="900" preserveAspectRatio="none"')<svg.indexOf('<text '));
  delete p.reconstruction.slides[0].background;assert.equal(rebuiltCurrent(p),false);await assert.rejects(buildVisualDeck(p,path.join(folder,'missing.pptx'),image),/重建底图已变化/);
});

test('03包含三方向底图和风格确认入口，底图先于预览；材料仅校验制作忠实性',()=>{
  const p={id:'ui',brief:{cover:true,toc:true,pages:3},slides:[{kind:'cover',title:'封面',body:[],sources:[]}],materials:[],concepts:[],confirmedVisualPages:[],pageDesigns:{},themePromptConfirmation:true,previewImageToImage:true,conceptFoundationReadiness:{passed:false,issues:[]},workflowLibrary:{styles:[],documents:[],standards:[],version:'test',fileCount:0}};
  const html=visualConcepts(p,()=>'<header></header>',()=>'<main></main>');assert.match(html,/STYLE FOUNDATIONS \/ 03/);assert.match(html,/规划三种风格与底图/);assert.doesNotMatch(html,/01 需求与材料|data-nav="0"/);assert.ok(html.indexOf('id="themeAssets"')<html.indexOf('从确认的一页开始'));
  const app=fs.readFileSync('public/app.js','utf8'),intake=app.slice(app.indexOf('function intake()'),app.indexOf('function content()'));assert.doesNotMatch(intake,/themeAssetsPanel/);
  for(const stage of ['content','design','review','rebuild'])assert.ok(designRulesFor(p,0,stage).includes(materialFidelityPolicy));assert.match(materialFidelityPolicy,/材料自身的论证不足不能作为生成失败/);assert.match(materialFidelityPolicy,/误写、遗漏、改换原图/);
});
