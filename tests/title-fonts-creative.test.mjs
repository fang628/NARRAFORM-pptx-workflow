import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import {Resvg} from '@resvg/resvg-js';
import {unifyTitleFonts} from '../lib/title-fonts.mjs';
import {prepareElementFonts} from '../lib/automatic-fonts.mjs';
import {buildVisualDeck} from '../lib/visual-build.mjs';
import {digest} from '../lib/visual-model.mjs';
import {themeAssetsStamp} from '../lib/theme-assets.mjs';
import {creativeStyleInstruction,pageCreativeDesignGuidance,specialLayoutDesignGuidance,activeCreativeDesignRule,creativePromptWritingRule} from '../lib/layout-guidance.mjs';
import {pageDesignPrompt} from '../lib/page-design.mjs';

const text=(face,role='title')=>({key:role,type:'text',nodeId:role,role,text:role==='title'?'页面标题':'正文内容',fontFace:face,x:100,y:role==='title'?100:250,w:1000,h:100,size:40,bold:true,italic:true,color:'222222'});
function project(){return {selectedTheme:'a',brief:{title:'字体一致性',cover:true,progress:false},slides:[{kind:'cover'},{kind:'content'},{kind:'content'}],concepts:[],reconstruction:{slides:[{elements:[text('KaiTi'),text('SimSun','body')]},{elements:[text('Arial')]},{elements:[text('Arial')]}]}};}

test('全篇页标题采用内容页共识字体，保留字号字重斜体及其他角色字体',()=>{
  const p=project(),original=p.reconstruction.slides[0].elements;
  const r=unifyTitleFonts(p,original,['KaiTi','SimSun','Arial']);
  assert.equal(r.elements[0].fontFace,'Arial');assert.equal(r.elements[0].size,40);assert.equal(r.elements[0].italic,true);
  assert.equal(r.elements[1],original[1]);assert.equal(p.rebuildTitleFont.fontFace,'Arial');
  for(const role of ['heading','subtitle','caption','imageTitle','navigation'])assert.equal(unifyTitleFonts(p,[text('SimSun',role)]).elements[0].fontFace,'SimSun');
});

test('同方向单页重试保持共同字体，换方向重新选字，失效替换请求不覆盖统一结果',()=>{
  const p=project();unifyTitleFonts(p,[text('KaiTi')],['Arial','KaiTi']);
  const r=unifyTitleFonts(p,[{...text('KaiTi'),requestedFontFace:'Old Font',fontSubstitution:{}}]);
  assert.equal(r.elements[0].fontFace,'Arial');assert.equal(r.elements[0].requestedFontFace,undefined);
  p.selectedTheme='b';p.reconstruction.slides=p.reconstruction.slides.map(()=>({elements:[text('SimSun')]}));
  assert.equal(unifyTitleFonts(p,[text('Arial')]).fontFace,'SimSun');
  assert.equal(unifyTitleFonts(project(),[text('Calibri')],['Calibri']).fontFace,'Calibri','参考字体全不可用时使用已匹配的本页字体');
});

test('自动补齐与工具字形匹配结果也使用全篇标题字体',async()=>{
  const p=project(),result=await prepareElementFonts(p,{},[text('KaiTi')],undefined,{inventory:async()=>['Arial','KaiTi']});
  assert.equal(result.elements[0].fontFace,'Arial');assert.ok(result.changes.some(c=>c.reason==='统一全篇页标题字体族'));
});

test('实际PPTX各页主标题为同一原生字体，正文与斜体保持',async()=>{
  const p=project();p.slides.forEach(s=>s.sources=[]);const dir=fs.mkdtempSync(path.resolve('work','title-fonts-')),bg=path.join(dir,'bg.png');
  const bytes=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#eee"/></svg>').render().asPng();fs.writeFileSync(bg,bytes);
  p.materials=[{id:'bg',file:bg,kind:'image',purpose:'workflow-background',sha256:digest(bytes)}];
  p.themeAssets={stamp:themeAssetsStamp(p),directions:[{id:'a',assets:Object.fromEntries(['hero-image','content-background'].map(use=>[use,{materialId:'bg',previewHash:digest(bytes),normalized:bg}]))}]};
  p.reconstruction.slides.forEach(page=>page.background={id:'bg',sha256:digest(bytes)});
  const deck=path.join(dir,'titles.pptx');await buildVisualDeck(p,deck,()=>bg);const zip=await JSZip.loadAsync(fs.readFileSync(deck));
  for(let i=1;i<=3;i++){const xml=await zip.file('ppt/slides/slide'+i+'.xml').async('string');assert.match(xml,/typeface="Arial"/);assert.doesNotMatch(xml,/typeface="KaiTi"/);assert.match(xml,/<a:rPr[^>]*i="1"/);if(i===1)assert.match(xml,/typeface="SimSun"/);}
});

test('创意明确落实在文本框与分块上，预设框形保留且图标只作辅助',()=>{
  const request=pageDesignPrompt({brief:{title:'结果比较'},slides:[{kind:'content',title:'两项结果对照',body:['结果甲','结果乙'],sources:[]}],materials:[]},0);
  assert.ok(request.includes(activeCreativeDesignRule),'实际设计请求须主动选择并落实创意，而非仅删掉提示词说明');
  assert.ok(specialLayoutDesignGuidance.includes(activeCreativeDesignRule));
  assert.ok(creativePromptWritingRule.includes(activeCreativeDesignRule),'提示词改写同样积极使用创意，已确认版式仍保留');
  assert.match(pageCreativeDesignGuidance,/创意对象是文本框和内容分块，而非图标/);assert.match(pageCreativeDesignGuidance,/不为每个标题、分点或卡片机械配图标/);
  assert.match(specialLayoutDesignGuidance,/不以图标造型创新/);
  const custom=creativeStyleInstruction({layoutIntent:'左右对照，以斜切承载两组正文'});
  assert.equal(custom,'创意设计：以斜切承载两组正文。');
  const icons=creativeStyleInstruction({layoutIntent:'文本框并列，右侧用金字塔图标点缀'});
  assert.equal(icons,'');
  assert.equal(creativeStyleInstruction({}, {preset:true}),'');
  assert.match(creativeStyleInstruction({nodes:[{carrier:'斜切楔形文本框'}]}),/创意设计：斜切楔形文本框/);
  assert.equal(creativeStyleInstruction({logic:'三个等级分级和处理流程',layoutIntent:'普通网格'}),'');
  assert.equal(creativeStyleInstruction({layoutIntent:'背景用波浪装饰，文本常规排列'}),'');
  assert.match(creativeStyleInstruction({}, {presetLayout:'正文采用阶梯式文本分区'}),/创意设计：正文采用阶梯式文本分区/);
  assert.equal(creativeStyleInstruction({layoutIntent:'无特殊分块，普通网格'}),'');
  assert.equal(creativeStyleInstruction({style:'建议采用金字塔分区'}),'');
  assert.equal(creativeStyleInstruction({style:'创意设计：采用折纸拼接文本框'}),'创意设计：采用折纸拼接文本框。');
});
