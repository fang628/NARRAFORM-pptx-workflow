import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {initialElements} from '../lib/elements.mjs';
import {validateSlides} from '../lib/scene.mjs';

test('仅打开旧内容树不改写页面，实际编辑与添加节点只物化目标页',async()=>{
  const editor=fs.readFileSync('public/element-editor.js','utf8').replace("'/elements-model.js'",JSON.stringify(pathToFileURL(path.resolve('lib/elements.mjs')).href)).replace("'./provenance.js'",JSON.stringify(pathToFileURL(path.resolve('public/provenance.js')).href));
  const {collectElementSlide}=await import('data:text/javascript;base64,'+Buffer.from(editor).toString('base64'));
  const p={slides:validateSlides([{title:'第一页',body:['原文'],sources:[]},{title:'第二页',body:['保留确认'],sources:[]}])};
  const rows=p.slides.map((s,i)=>({dataset:{slide:String(i)},querySelector(selector){const id=selector.match(/data-node="([^"]+)"/)[1],n=initialElements(s).find(n=>n.id===id);return {querySelectorAll(){return Object.entries(n).filter(([k])=>['label','text','role','parentId','layout'].includes(k)).map(([k,v])=>({dataset:{nodeField:k},value:v??''}));}};} ,querySelectorAll(){return [];}}));
  const app=fs.readFileSync('public/app.js','utf8'),fn=app.slice(app.indexOf('function collectSlides('),app.indexOf('async function saveSlides'));
  const collect=vm.runInNewContext(fn+';collectSlides',{p,$$:()=>rows,collectElementSlide,initialElements,structuredClone});
  assert.equal(JSON.stringify(collect()),JSON.stringify(p.slides));
  assert.equal(JSON.stringify(collect(0)[1]),JSON.stringify(p.slides[1]));
  assert.ok(collect(0)[0].elements);
  const original=rows[0].querySelector.bind(rows[0]);rows[0].querySelector=selector=>{const row=original(selector),fields=row.querySelectorAll();if(selector.includes('body-0'))fields.find(f=>f.dataset.nodeField==='text').value='实际修改';return {querySelectorAll:()=>fields};};
  const edited=collect();assert.equal(edited[0].body[0],'实际修改');assert.ok(edited[0].elements);assert.equal(JSON.stringify(edited[1]),JSON.stringify(p.slides[1]));
});
test('图注始终融入图片条目，已有图注不再显示独立节点',async()=>{
  const editor=fs.readFileSync('public/element-editor.js','utf8').replace("'/elements-model.js'",JSON.stringify(pathToFileURL(path.resolve('lib/elements.mjs')).href)).replace("'./provenance.js'",JSON.stringify(pathToFileURL(path.resolve('public/provenance.js')).href));
  const {elementEditor}=await import('data:text/javascript;base64,'+Buffer.from(editor).toString('base64'));
  const s={title:'图注显示测试',body:[],sources:[],elements:[{id:'title',type:'text',role:'title',label:'标题',text:'图注显示测试',parentId:null},{id:'pic',type:'image',label:'材料图',parentId:'title'},{id:'caption',type:'text',role:'caption',label:'图注',text:'唯一图注内容',parentId:'pic'}]};
  const html=elementEditor({id:'caption-ui',materials:[]},s,0);
  assert.equal(html.split('唯一图注内容').length-1,1);
  assert.doesNotMatch(html,/data-node="caption"|class="element-type">图注<\/span>|class="tree-image-caption"/);
  assert.equal((html.match(/data-image-caption="pic"/g)||[]).length,1);assert.match(html,/data-caption-node="caption"/);
  const empty=elementEditor({id:'caption-ui',materials:[]},{...s,elements:s.elements.slice(0,2)},0);
  assert.equal((empty.match(/data-image-caption="pic"/g)||[]).length,1);
});

test('图片内编辑图注沿用节点与来源；清空后移除对应来源并保留附属文字',async()=>{
  const editor=fs.readFileSync('public/element-editor.js','utf8').replace("'/elements-model.js'",JSON.stringify(pathToFileURL(path.resolve('lib/elements.mjs')).href)).replace("'./provenance.js'",JSON.stringify(pathToFileURL(path.resolve('public/provenance.js')).href));
  const {elementEditor,collectElementSlide}=await import('data:text/javascript;base64,'+Buffer.from(editor).toString('base64'));
  const s=validateSlides([{title:'图片说明',body:[],sources:['doc'],sourceLinks:[{materialId:'doc',target:'element:cap',quote:'原始图注'}],elements:[
    {id:'title',type:'text',role:'title',text:'图片说明',parentId:null},
    {id:'pic',type:'image',label:'材料图',parentId:'title'},
    {id:'cap',type:'text',role:'caption',text:'原始图注',parentId:'pic'},
    {id:'detail',type:'text',role:'body',text:'保留的附属文字',parentId:'cap'}
  ]}])[0];
  const html=elementEditor({id:'caption-edit',materials:[]},s,0);assert.match(html,/data-node="detail"/);assert.doesNotMatch(html,/data-node="cap"/);
  const field={dataset:{imageCaption:'pic',captionNode:'cap'},value:'修改图注',defaultValue:'原始图注'};
  const dom={querySelector:()=>null,querySelectorAll:()=>[field]};
  const changed=collectElementSlide(dom,s);assert.equal(changed.elements.find(n=>n.id==='cap').text,'修改图注');assert.equal(changed.elements.filter(n=>n.role==='caption').length,1);assert.equal(changed.sourceLinks[0].target,'element:cap');assert.equal(changed.elements.find(n=>n.id==='detail').parentId,'cap');
  field.value='';const cleared=collectElementSlide(dom,s);assert.ok(!cleared.elements.some(n=>n.id==='cap'));assert.equal(cleared.sourceLinks.length,0);assert.equal(cleared.elements.find(n=>n.id==='detail').parentId,'pic');
  assert.equal(s.elements.find(n=>n.id==='cap').text,'原始图注');
});
