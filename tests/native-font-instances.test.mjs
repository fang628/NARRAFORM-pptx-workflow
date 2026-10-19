import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import {Resvg} from '@resvg/resvg-js';
import {visualTextStyle,visualTextStyleRule} from '../lib/visual-text-style.mjs';
import {availableNativeFonts,nativeFontContext,resolveNativeFonts} from '../lib/native-fonts.mjs';
import {auditInstanceGroups,deduplicateAuditElements,insertedInstanceManifest} from '../lib/rebuild-reuse.mjs';
import {auditedElements} from '../lib/visual-audit-repair.mjs';
import {buildVisualDeck} from '../lib/visual-build.mjs';
import {themeAssetsStamp} from '../lib/theme-assets.mjs';
import {slideBackground} from '../lib/slide-background.mjs';
import {digest,canonicalTexts} from '../lib/visual-model.mjs';

test('书法艺术字体保留为原生字体，未知字体按本机字形类别替换并记录',async()=>{
  assert.equal(visualTextStyle({key:'t',fontFace:'华文行楷',fontCategory:'calligraphy',size:65,bold:false},'title').fontFace,'STXingkai');
  assert.match(visualTextStyleRule,/书法.*原生text/);
  const elements=[{key:'calligraphy',type:'text',fontFace:'缺失的书法字体',fontCategory:'calligraphy'},{key:'art',type:'text',fontFace:'缺失的艺术字体',fontCategory:'artistic'},{key:'known',type:'text',fontFace:'华文行楷'}];
  const result=resolveNativeFonts(elements,['Microsoft YaHei','STXingkai','STHupo']);assert.equal(result.elements[0].fontFace,'STXingkai');assert.equal(result.elements[1].fontFace,'STHupo');assert.equal(result.elements[2],elements[2]);assert.equal(result.changes.length,2);assert.equal(result.elements[0].requestedFontFace,'缺失的书法字体');
  assert.match(nativeFontContext(['STXingkai','STHupo']),/STXingkai/);const fonts=await availableNativeFonts();assert.ok(Array.isArray(fonts));if(process.platform==='win32')assert.ok(fonts.length>0,'读取真实已安装字体');
});

test('重复实例清单保留每处坐标、大小、顺序；明确登记的叠放实例不被素材去重删掉',()=>{
  const icon={key:'i1',type:'rect',x:100,y:500,w:40,h:40,fill:'FFFF00'},raw={elements:[icon,{...icon,key:'i2',x:500},{...icon,key:'i3'}],repeatedElements:[{label:'三个标记',count:3,keys:['i1','i2','i3']}]};
  const result=deduplicateAuditElements(raw);assert.equal(result.raw.elements.length,3);const groups=auditInstanceGroups(result.raw);assert.equal(groups[0].count,3);assert.deepEqual(groups[0].instances.map(i=>i.x),[100,500,100]);
  assert.throws(()=>auditInstanceGroups({...raw,elements:raw.elements.slice(0,2)}),/遗漏/);assert.throws(()=>auditInstanceGroups({...raw,repeatedElements:[{count:3,keys:['i1','i2']}]}),/数量/);
  const manifest=insertedInstanceManifest(raw.elements.map(e=>({...e,type:'image',id:'shared'})));assert.equal(manifest.groups.length,1);assert.equal(manifest.groups[0].count,3);assert.deepEqual(manifest.groups[0].instances.map(i=>i.z),[0,1,2]);
});

test('声明了三处却少返回一处时，在05审计内自动补齐，失败也保留正确实例',async()=>{
  const slide={kind:'content',title:'重复图形',body:[],sources:[]},title={...canonicalTexts(slide)[0],key:'title',type:'text',x:100,y:100,w:700,h:90,size:50,fontFace:'STXingkai'},a={key:'a',type:'rect',x:100,y:500,w:50,h:50,fill:'EECC33'},b={...a,key:'b',x:400},c={...a,key:'c',x:700},repeatedElements=[{label:'三个标记',count:3,keys:['a','b','c']}];let calls=0;
  const result=await auditedElements({slide,images:[],request:async correction=>{calls++;if(calls>1)assert.match(correction,/实例遗漏/);return {text:JSON.stringify({elements:[title,a,b,...(calls>1?[c]:[])],repeatedElements})};}});assert.equal(calls,2);assert.equal(result.auditValidation.instanceGroups[0].count,3);assert.equal(result.audit.length,4);
  await assert.rejects(auditedElements({slide,images:[],request:async()=>({text:JSON.stringify({elements:[title,a,b],repeatedElements})})}),error=>{assert.ok(error.partialAudit.some(e=>e.key==='b'));assert.equal(error.partialAudit.length,3);return true;});
});

test('真实PPTX包含书法艺术字体的原生文字及同素材三个独立位置，仅保存一份媒体',async()=>{
  const dir=fs.mkdtempSync(path.resolve('work/native-font-instance-')),bg=path.join(dir,'bg.png'),asset=path.join(dir,'icon.png'),bytes=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#eeeeee"/></svg>').render().asPng();fs.writeFileSync(bg,bytes);fs.writeFileSync(asset,new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="30" fill="#ffaa00"/></svg>').render().asPng());
  const slide={kind:'content',title:'山川万象',body:['艺术表达'],sources:[]},p={brief:{title:slide.title,progress:false,cover:false},slides:[slide],concepts:[],selectedTheme:'a',materials:[{id:'bg',file:bg,kind:'image',purpose:'workflow-background',sha256:digest(bytes)}]};p.themeAssets={stamp:themeAssetsStamp(p),directions:[{id:'a',assets:{'content-background':{materialId:'bg',normalized:bg,previewHash:digest(bytes)}}}]};
  const elements=[{key:'calligraphy',type:'text',text:slide.title,x:100,y:100,w:1000,h:150,size:85,fontFace:'STXingkai',color:'222222',bold:false},{key:'artistic',type:'text',text:'艺术表达',x:100,y:300,w:1000,h:120,size:70,fontFace:'STHupo',color:'333333',bold:false},...[100,500,900].map((x,i)=>({key:'icon-'+i,type:'image',id:'same-icon',x,y:600,w:90,h:90}))];p.reconstruction={slides:[{background:slideBackground(p,0),elements}]};
  const deck=path.join(dir,'fonts-and-instances.pptx');await buildVisualDeck(p,deck,(_,id)=>id==='bg'?bg:asset);const zip=await JSZip.loadAsync(fs.readFileSync(deck)),xml=await zip.file('ppt/slides/slide1.xml').async('string');assert.match(xml,/typeface="STXingkai"/);assert.match(xml,/typeface="STHupo"/);assert.match(xml,/<a:t>山川万象<\/a:t>/);assert.equal((xml.match(/<p:pic>/g)||[]).length,3);for(const key of ['icon-0','icon-1','icon-2'])assert.ok(xml.includes(key));assert.equal(Object.keys(zip.files).filter(n=>/^ppt\/media\//.test(n)&&!zip.files[n].dir).length,2);
});
