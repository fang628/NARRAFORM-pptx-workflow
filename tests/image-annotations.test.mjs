import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateElements,setImageAnnotation,moveElementBranch,validateImageAnnotations} from '../lib/elements.mjs';
import {canonicalTexts,validateAudit} from '../lib/visual-model.mjs';
import {pageDesignInputCheck,pageDesignPrompt} from '../lib/page-design.mjs';
import {nestedContentList} from '../lib/prompt-structure.mjs';
import {orderedElements} from '../lib/elements.mjs';
import {visualTextStyle} from '../lib/visual-text-style.mjs';
import {scene,themes} from '../lib/scene.mjs';

const base=()=>[
  {id:'title',type:'text',role:'title',text:'研究结果',parentId:null},
  {id:'group',type:'group',label:'稳定性评价',parentId:'title'},
  {id:'photo',type:'image',label:'仅用于编辑的标签',materialId:'original',parentId:'group'}
];
const project=nodes=>({id:'annotations',brief:{title:'研究结果',progress:false,pages:1,cover:false},materials:[{id:'original',kind:'image',name:'结果图.png'}],slides:[{title:'研究结果',body:[],sources:[],elements:nodes}]});
const loadEditor=async()=>{
  const source=fs.readFileSync('public/element-editor.js','utf8').replace("'/elements-model.js'",JSON.stringify(pathToFileURL(path.resolve('lib/elements.mjs')).href)).replace("'./provenance.js'",JSON.stringify(pathToFileURL(path.resolve('public/provenance.js')).href));
  return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
};

test('图片标题与图注互斥，切换沿用原节点、来源身份与附属项',()=>{
  const original=validateElements(setImageAnnotation(base(),'photo','annotation','稳定性对比','imageTitle'));
  assert.throws(()=>validateImageAnnotations(base(),{required:true}),/必须补充一个图片标题或一条图注/);
  assert.doesNotThrow(()=>validateImageAnnotations(original,{required:true}));
  assert.equal(original.find(n=>n.id==='annotation').role,'imageTitle');
  let changed=setImageAnnotation([...original,{id:'note',type:'text',role:'body',text:'原有说明',parentId:'annotation'}],'photo','temporary','图1 稳定性对比','caption');
  assert.equal(changed.filter(n=>n.parentId==='photo'&&n.type==='text').length,1);
  assert.equal(changed.find(n=>n.id==='annotation').role,'caption');assert.equal(changed.find(n=>n.id==='note').parentId,'annotation');
  changed=setImageAnnotation(changed,'photo','another-id','稳定性对比','imageTitle');
  assert.equal(changed.find(n=>n.id==='annotation').role,'imageTitle');assert.equal(changed.some(n=>n.id==='another-id'),false);
  const duplicate={id:'duplicate',type:'text',role:'caption',text:'重复图注',parentId:'photo'};
  assert.throws(()=>validateElements([...changed,duplicate]),/只能有一个图片标题或一条图注/);
  const repaired=setImageAnnotation([...changed,duplicate],'photo','annotation','稳定性对比','imageTitle');assert.equal(repaired.some(n=>n.id==='duplicate'),false);
  const moved=moveElementBranch(repaired,'photo','title','inside');assert.equal(moved.find(n=>n.id==='annotation').parentId,'photo');
  assert.throws(()=>validateElements(original.map(n=>n.id==='annotation'?{...n,parentId:'group'}:n)),/图片标题必须直接从属于/);
});

test('图片标题是独立图片说明，不生成小标题、重复图注或目录序号',()=>{
  const nodes=validateElements(setImageAnnotation(base(),'photo','annotation','01 稳定性比较','imageTitle')),p=project(nodes);
  assert.deepEqual(pageDesignInputCheck(p,0).warnings,[]);
  const list=nestedContentList(orderedElements(nodes));assert.match(list,/小标题：稳定性评价/);assert.match(list,/图片标题：01 稳定性比较/);assert.doesNotMatch(list,/小标题：01 稳定性比较|图注：/);
  assert.match(pageDesignPrompt(p,0),/每张插入图片必须且只能有一个图片标题或一条图注/);
  const texts=canonicalTexts(p.slides[0],p,0);assert.equal(texts.find(n=>n.nodeId==='annotation').role,'imageTitle');
  assert.ok(visualTextStyle({},'imageTitle').size<visualTextStyle({},'heading').size);
  const native=scene(p.slides[0],themes[0],0,1,p.brief),picture=native.find(n=>n.type==='image'),annotation=native.find(n=>n.text==='01 稳定性比较');
  assert.ok(annotation.y+annotation.h<=picture.y,'图片标题在图片上方');
  const raw=texts.map((n,i)=>({key:'t'+i,type:'text',nodeId:n.nodeId,text:n.text,x:50,y:50+i*90,w:500,h:70}));
  const image={nodeId:'photo',id:'original',x:800,y:200,w:200,h:400,aspect:3,imageFit:'fill'};
  const toc={...p,slides:[{...p.slides[0],kind:'toc'}]};
  assert.doesNotThrow(()=>validateAudit([...raw,{...image,key:'image',type:'image'}],p.slides[0],[image],toc,0,{requireSeparatedNumbers:false}));
});

test('网页仅有一个说明输入框与类型选择，切换不会丢来源或新增图注',async()=>{
  const {elementEditor,collectElementSlide,mutateElements}=await loadEditor();
  const nodes=validateElements(setImageAnnotation(base(),'photo','annotation','稳定性对比','imageTitle')),p=project(nodes),s={...p.slides[0],sourceLinks:[{target:'element:annotation',materialId:'doc'}]};
  const html=elementEditor(p,s,0);assert.equal((html.match(/data-image-caption=/g)||[]).length,1);assert.equal((html.match(/data-caption-role=/g)||[]).length,1);
  assert.match(html,/value="imageTitle" selected/);assert.doesNotMatch(html,/data-node="annotation"/);
  const field={dataset:{imageCaption:'photo',captionNode:'annotation'},value:'稳定性对比',defaultValue:'稳定性对比'};
  const role={value:'caption'};
  const dom={querySelector:selector=>selector.startsWith('select')?role:null,querySelectorAll:()=>[field]};
  const changed=collectElementSlide(dom,s);assert.equal(changed.elements.find(n=>n.id==='annotation').role,'caption');assert.equal(changed.sourceLinks[0].target,'element:annotation');
  assert.equal(changed.elements.filter(n=>['imageTitle','caption'].includes(n.role)).length,1);
  assert.equal(s.elements.find(n=>n.id==='annotation').role,'imageTitle');
  const legacy={...s,elements:[...s.elements,{id:'duplicate',type:'text',role:'caption',text:'旧的重复图注',parentId:'photo'}],sourceLinks:[...s.sourceLinks,{target:'element:duplicate',materialId:'doc'}]};
  const cleaned=collectElementSlide(dom,legacy);assert.equal(cleaned.elements.filter(n=>n.parentId==='photo').length,1);assert.equal(cleaned.sourceLinks.length,1);
  const deleted=structuredClone(changed);mutateElements(deleted,'remove','photo');assert.doesNotThrow(()=>validateElements(deleted.elements));assert.ok(!deleted.elements.some(n=>n.id==='annotation'));assert.equal(deleted.sourceLinks.length,0);
});
