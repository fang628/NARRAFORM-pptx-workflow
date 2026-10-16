import test from 'node:test';
import assert from 'node:assert/strict';
import {selectMaterialFiles,droppedMaterialFiles,directoryMaterialFiles,bindMaterialPickers,materialUploadControls,materialPanel} from '../public/materials.js';
import {materialLimits} from '../public/material-images.js';
import {scene,themes,validateSlides} from '../lib/scene.mjs';

test('文件夹筛选保留相对路径，同名不同目录保留，重选去重并明确容量和格式限制',()=>{
  const file=(name,webkitRelativePath,size=10)=>({name,webkitRelativePath,size,lastModified:1});
  const files=[file('同名.txt','资料/A/同名.txt'),file('同名.txt','资料/B/同名.txt'),file('隐藏.exe','资料/隐藏.exe'),file('空.txt','资料/空.txt',0),file('过大.pdf','资料/过大.pdf',materialLimits.fileBytes+1)];
  const r=selectMaterialFiles(files,[]);assert.equal(r.added.length,2);assert.equal(r.skipped.length,3);assert.equal(r.added[1].relativePath,'资料/B/同名.txt');
  assert.equal(selectMaterialFiles(files,r.added).duplicates,2);
  const limited=selectMaterialFiles(files,[],materialLimits.count-1);assert.equal(limited.added.length,1);assert.match(limited.skipped[0].reason,/200/);
});

test('拖入文件夹递归读取全部 readEntries 批次与子文件夹',async()=>{
  const file=name=>({name,isFile:true,file:resolve=>resolve({name,size:1})});
  const dir=(name,batches)=>({name,isDirectory:true,createReader(){let i=0;return {readEntries(resolve){resolve(batches[i++]||[]);}};}});
  const root=dir('材料',[[file('第一份.txt')],[dir('子目录',[[file('第二份.md')]])]]);
  const r=await droppedMaterialFiles({items:[{kind:'file',webkitGetAsEntry:()=>root}]});
  assert.deepEqual(r.map(e=>e.relativePath),['材料/第一份.txt','材料/子目录/第二份.md']);
});
const folderFile=name=>({kind:'file',name,getFile:async()=>({name,size:10,lastModified:1})});
const folderHandle=(name,children)=>({kind:'directory',name,async *entries(){for(const child of children)yield [child.name,child];}});
test('现代拖入目录递归保留层级与同名文件，空目录可返回',async()=>{
  const root=folderHandle('材料',[folderHandle('A',[folderFile('说明.md')]),folderHandle('B',[folderFile('说明.md')])]);
  const files=await directoryMaterialFiles(root);
  assert.deepEqual(files.map(f=>f.relativePath),['材料/A/说明.md','材料/B/说明.md']);
  assert.equal(selectMaterialFiles(files,[]).added.length,2);
  assert.deepEqual(await directoryMaterialFiles(folderHandle('空目录',[])),[]);
});
test('选择文件与拖入文件夹共用待发送队列，取消和忙碌不上传',async()=>{
  let clicks=0,allowed=true;const queue=[];
  const file={name:'报告.txt',size:10,lastModified:1},nested={...file,webkitRelativePath:'材料/子目录/报告.txt'};
  const fileInput={files:[file],value:'selected',click(){clicks++;}},fileButton={};
  const map={'#fileInput':fileInput,'[data-select-material-files]':fileButton};
  const enqueue=files=>queue.push(...selectMaterialFiles(files,queue).added);
  bindMaterialPickers({querySelector:s=>map[s]},{enqueue,canSelect:()=>allowed});
  fileButton.onclick();assert.equal(clicks,1);assert.equal(queue.length,0);
  fileInput.onchange();
  enqueue(await droppedMaterialFiles({items:[{kind:'file',getAsFileSystemHandle:()=>Promise.resolve(folderHandle('材料',[folderHandle('子目录',[{kind:'file',name:'报告.txt',getFile:async()=>nested}])]))}]}));
  assert.equal(queue.length,2);
  assert.deepEqual(queue.map(q=>q.status),['queued','queued']);assert.equal(queue[1].relativePath,'材料/子目录/报告.txt');
  assert.equal(fileInput.value,'');
  fileInput.files=[];fileInput.onchange();assert.equal(queue.length,2);
  allowed=false;fileButton.onclick();fileInput.files=[file];fileInput.onchange();assert.equal(clicks,1);assert.equal(queue.length,2);
});
test('混合拖入文件夹与无目录条目的普通文件不会丢失，现代拖放保留目录',async()=>{
  const old={name:'目录',isDirectory:true,createReader(){let count=0;return {readEntries(resolve){resolve(count++?[]:[{name:'A.txt',isFile:true,file:resolve=>resolve({name:'A.txt',size:10})}]);}};}};
  const loose={name:'B.txt',size:10};
  const mixed=await droppedMaterialFiles({items:[{kind:'file',webkitGetAsEntry:()=>old},{kind:'file',webkitGetAsEntry:()=>null,getAsFile:()=>loose}],files:[loose]});
  assert.equal(mixed.length,2);assert.equal(mixed[0].relativePath,'目录/A.txt');assert.equal(mixed[1],loose);
  const modern=await droppedMaterialFiles({items:[{kind:'file',getAsFileSystemHandle:()=>Promise.resolve(folderHandle('现代目录',[folderFile('C.txt')]))}]});
  assert.equal(modern[0].relativePath,'现代目录/C.txt');
  assert.deepEqual(await droppedMaterialFiles({items:[],files:[loose]}),[loose]);
});
test('上传区只保留一个添加材料入口，同时说明可拖入文件夹',()=>{
  const html=materialUploadControls(()=>'<svg/>');
  assert.equal((html.match(/<button\b/g)||[]).length,1);
  assert.doesNotMatch(html,/data-select-material-folder|folderInput/);
  assert.match(html,/<button[^>]+data-select-material-files/);
  assert.match(html,/文件夹拖到这里/);assert.match(html,/包含全部子目录/);
  assert.doesNotMatch(html,/<label/);
  assert.ok(materialPanel(null,()=>'',[],'').includes('data-select-material-files'));
});

test('旧格式与结构化页面的进度条均位于页顶，关闭时移除',()=>{
  const base=validateSlides([{kind:'content',title:'进度测试',body:['正文'],sources:[]}])[0];
  for(const s of [base,{...base,elements:[{id:'title',type:'text',role:'title',text:base.title,parentId:null},{id:'body',type:'text',role:'body',text:'正文',parentId:null}]}]){
    const t=themes[0],has=scene(s,t,1,4,{progress:true}).filter(e=>e.type==='rect'&&e.h===4);
    assert.equal(has.length,1);assert.equal(has[0].y,16);assert.equal(has[0].w,710);
    assert.equal(scene(s,t,1,4,{progress:false}).filter(e=>e.type==='rect'&&e.h===4).length,0);assert.equal(scene({...s,kind:'cover'},t,0,4,{progress:true}).filter(e=>e.type==='rect'&&e.h===4).length,0);assert.equal(scene(s,t,1,4,{progress:true,toc:true}).filter(e=>e.type==='rect'&&e.h===4).length,0);
  }
});

test('已收到材料保留原始、编辑裁片和AI补充图，隐藏重建素材且不修改登记',()=>{
  const p={id:'inbox-project',materials:[
    {id:'original',name:'原始报告.pdf',kind:'document',file:'original.pdf',text:'材料正文'},
    {id:'crop',name:'人工裁切图片.png',kind:'image',file:'crop.png',extracted:true,extractionMethod:'manual-crop',sourceMaterialName:'原始图片'},
    {id:'embedded',name:'文档提取图片.png',kind:'image',file:'embedded.png',extracted:true,sourceMaterialName:'原始报告.pdf',sourceLocations:[{page:1}]},
    {id:'supplement',name:'AI补充图片.png',kind:'image',file:'supplement.png',generated:true,purpose:'element'},
    {id:'edited',name:'修改后的补充图片.png',kind:'image',file:'edited.png',generated:true,parentImageId:'supplement',purpose:'illustration'},
    {id:'rebuild-svg',name:'重建SVG图形',kind:'image',file:'vector.svg',generated:true,reconstructed:true,purpose:'reconstruction'},
    {id:'rebuild-flag',name:'旧重建图片',kind:'image',file:'legacy.png',generated:true,reconstructed:true},
    {id:'rebuild-purpose',name:'重建抠图',kind:'image',file:'cutout.png',generated:true,purpose:'reconstruction'},
    {id:'foundation',name:'方向底图',kind:'image',file:'background.png',generated:true,purpose:'workflow-background'}
  ]};
  const before=structuredClone(p.materials),html=materialPanel(p,()=>'',[],'');
  assert.deepEqual([...html.matchAll(/data-read-material="([^"]+)"/g)].map(m=>m[1]),['original','crop','embedded','supplement','edited']);
  assert(!html.includes('data-remove-material="rebuild-svg"'));assert(!html.includes('data-remove-material="rebuild-purpose"'));
  assert.deepEqual(p.materials,before,'过滤仅作用于收件列表，原始登记和05素材引用仍保留');
});

test('仅有重建素材或底图时不显示空的已收到材料列表',()=>{
  const p={id:'internal-only',materials:[{id:'asset',name:'内部素材',kind:'image',file:'asset.png',generated:true,reconstructed:true,purpose:'reconstruction'},{id:'background',name:'内部底图',kind:'image',file:'background.png',generated:true,purpose:'workflow-background'}]};
  const html=materialPanel(p,()=>'',[],'');assert(!html.includes('已收到的材料'));assert(!html.includes('received-material'));
});
