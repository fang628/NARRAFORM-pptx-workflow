import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import {box,validateAudit,nativeSVG,digest} from '../lib/visual-model.mjs';
import {patchRebuiltScene} from '../lib/rebuild-tools.mjs';
import {buildVisualDeck} from '../lib/visual-build.mjs';
import {themeAssetsStamp} from '../lib/theme-assets.mjs';
import {Resvg} from '@resvg/resvg-js';

const slide={kind:'content',title:'直线测试',body:[],sources:[]};
const title={key:'title',type:'text',nodeId:'title',text:slide.title,x:50,y:80,w:800,h:80,size:40,color:'272727',bold:true};
const lines=[{key:'vertical',type:'line',x:690,y:307,w:0,h:420,color:'3577CC',strokeWidth:2},{key:'horizontal',type:'line',x:656,y:307,w:34,h:0,color:'3577CC',strokeWidth:2}];

test('水平/竖直原生线条可为零宽/零高，文本、图片与裁剪区域仍须正面积',()=>{
  const elements=validateAudit([title,...lines],slide,[]);
  assert.equal(elements[1].w,0);assert.equal(elements[2].h,0);
  const changed=patchRebuiltScene(elements,{edits:[{key:'vertical',properties:{h:400}}]},{slide,originalPage:{elements},assets:[]});
  assert.equal(changed[1].h,400);assert.equal(changed[1].w,0);
  for(const type of ['rect','image','text',undefined])assert.throws(()=>box({...lines[0],type}),/视觉元素坐标/);
  for(const values of [{w:0,h:0},{w:-1},{h:NaN},{x:1590,w:20},{y:890,h:20}])assert.throws(()=>box({...lines[0],...values}),/视觉元素坐标/);
  assert.throws(()=>validateAudit([title,{key:'crop',type:'crop',x:800,y:500,w:60,h:60,sourceBox:{x:900,y:400,w:0,h:50}}],slide,[]),/视觉元素坐标/);
  const icon=key=>({key,type:'cutout',x:900,y:400,w:80,h:80,sourceBox:{x:40,y:70,w:90,h:80},prompt:'提取完整图标主体，去除周围背景',nonFactual:true});
  assert.throws(()=>validateAudit([title,icon('icon-one'),icon('icon-two')],slide,[]),error=>error.message.includes('icon-one')&&error.message.includes('icon-two')&&error.message.includes('protectedElement')&&error.message.includes('sourceBox'));
  const rendered=new Resvg(nativeSVG(elements,()=>''),{font:{loadSystemFonts:true}}).render().asPng();assert(rendered.length>100);
});

test('零宽与零高直线实际导出为PowerPoint原生线条，保留方向与长度',async()=>{
  const dir=fs.mkdtempSync(path.resolve('work/axis-lines-')),bg=path.join(dir,'bg.png');
  const bytes=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="white"/></svg>').render().asPng();fs.writeFileSync(bg,bytes);
  const p={brief:{title:slide.title,pages:1,cover:false,progress:false},slides:[slide],selectedTheme:'a',materials:[{id:'bg',file:'bg.png',kind:'image',generated:true,purpose:'workflow-background',sha256:digest(bytes)}]};
  p.themeAssets={stamp:themeAssetsStamp(p),directions:[{id:'a',assets:{'content-background':{materialId:'bg',normalized:'bg.png',previewHash:digest(bytes)}}}]};
  p.reconstruction={slides:[{background:{id:'bg',sha256:digest(bytes)},elements:validateAudit([title,...lines],slide,[])}]};
  const deck=path.join(dir,'lines.pptx');await buildVisualDeck(p,deck,()=>bg);const zip=await JSZip.loadAsync(fs.readFileSync(deck)),xml=await zip.file('ppt/slides/slide1.xml').async('string');
  const shapes=xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g)||[];
  for(const [name,axis] of [['vertical','cx'],['horizontal','cy']]){
    const shape=shapes.find(s=>s.includes('name="'+name+'"'));assert(shape);assert.match(shape,/<a:prstGeom prst="line"/);assert.match(shape,new RegExp('<a:ext[^>]*'+axis+'="0"'));
  }
});
