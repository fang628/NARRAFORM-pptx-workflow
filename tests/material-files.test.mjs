import test from 'node:test';
import assert from 'node:assert/strict';
import {selectMaterialFiles,droppedMaterialFiles} from '../public/materials.js';
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

test('旧格式与结构化页面的进度条均位于页顶，关闭时移除',()=>{
  const base=validateSlides([{kind:'content',title:'进度测试',body:['正文'],sources:[]}])[0];
  for(const s of [base,{...base,elements:[{id:'title',type:'text',role:'title',text:base.title,parentId:null},{id:'body',type:'text',role:'body',text:'正文',parentId:null}]}]){
    const t=themes[0],has=scene(s,t,1,4,{progress:true}).filter(e=>e.type==='rect'&&e.h===4);
    assert.equal(has.length,1);assert.equal(has[0].y,16);assert.equal(has[0].w,710);
    assert.equal(scene(s,t,1,4,{progress:false}).filter(e=>e.type==='rect'&&e.h===4).length,0);assert.equal(scene({...s,kind:'cover'},t,0,4,{progress:true}).filter(e=>e.type==='rect'&&e.h===4).length,0);assert.equal(scene(s,t,1,4,{progress:true,toc:true}).filter(e=>e.type==='rect'&&e.h===4).length,0);
  }
});
