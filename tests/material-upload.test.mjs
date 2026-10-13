import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {writeMaterialUpload} from '../lib/material-upload.mjs';
import {selectMaterialFiles,uploadMaterialFile} from '../public/materials.js';
import {materialLimits} from '../public/material-images.js';

test('500 MB 文件筛选边界与流式上传不转 Base64，保留文件夹路径',async()=>{
  const file={name:'材料.pdf',size:500_000_000,lastModified:1};
  assert.equal(materialLimits.fileBytes,file.size);
  assert.equal(selectMaterialFiles([file],[]).added.length,1);
  assert.equal(selectMaterialFiles([{...file,size:file.size+1}],[]).skipped.length,1);
  let called=false;
  await uploadMaterialFile('p',{file,relativePath:'资料/材料.pdf'},async(url,options)=>{
    called=true;assert.equal(options.body,file);assert.equal(options.headers['content-type'],'application/octet-stream');
    assert.equal(new URL(url,'http://local').searchParams.get('sourcePath'),'资料/材料.pdf');
    return {ok:true,json:async()=>({id:'p'})};
  });assert.equal(called,true);
});

test('旧服务仅兼容小文件，500 MB 文件等待后端更新而非转成巨大 JSON',async()=>{
  const file=new File(['正文'],'材料.txt');let count=0;
  await uploadMaterialFile('p',{file},async(url,options)=>{
    count++;assert.equal(options.headers['content-type'],'application/json');
    assert.equal(Buffer.from(JSON.parse(options.body).base64,'base64').toString(),'正文');
    return {ok:true,json:async()=>({id:'p'})};
  },false);
  await assert.rejects(uploadMaterialFile('p',{file:{size:500_000_000}},()=>{count++;},false),/请重启服务/);
  assert.equal(count,1);
});

test('分块上传恰好达到上限成功，返回完整哈希及文件头',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ppt-upload-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const bytes=Buffer.from('0123456789abcdefghij'),target=path.join(dir,'exact');
  const result=await writeMaterialUpload(Readable.from([bytes.subarray(0,5),bytes.subarray(5,13),bytes.subarray(13)]),target,{limit:20});
  assert.equal(result.size,20);assert.deepEqual(result.head,bytes.subarray(0,16));
  assert.equal(result.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));assert.deepEqual(await fs.readFile(target),bytes);
});

test('超限、空文件与中断清理临时文件；声明超 500 MB 在写盘前拒绝',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ppt-upload-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const broken=async function*(){yield Buffer.from('part');throw Error('传输中断');};
  for(const [name,source,pattern] of [
    ['large',Readable.from([Buffer.alloc(7),Buffer.alloc(4)]),/不能超过/],
    ['empty',Readable.from([]),/不能为空/],['broken',Readable.from(broken()),/传输中断/]
  ]){const target=path.join(dir,name);await assert.rejects(writeMaterialUpload(source,target,{limit:10}),pattern);await assert.rejects(fs.stat(target),{code:'ENOENT'});}
  const source=Readable.from([]);source.headers={'content-length':'500000001'};
  await assert.rejects(writeMaterialUpload(source,path.join(dir,'declared')),/500 MB/);assert.deepEqual(await fs.readdir(dir),[]);
});
