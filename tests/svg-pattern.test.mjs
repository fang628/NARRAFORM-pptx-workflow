import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Resvg} from '@resvg/resvg-js';
import {assetTool} from '../lib/visual-pipeline.mjs';
const run=promisify(execFile),root=process.cwd();
const env={root,run};
const svg=body=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 50">${body}</svg>`;
const dots=svg('<defs><pattern id="p" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="1.4" cy="1.4" r="1.05" fill="#3D9DD8" opacity="0.7"/></pattern></defs><rect width="80" height="50" fill="url(#p)" opacity="0.75"/>');
function files(source){const dir=fs.mkdtempSync(path.resolve('work','svg-pattern-')),src=path.join(dir,'draft.svg'),dest=path.join(dir,'final.svg');fs.writeFileSync(src,source);return {src,dest};}

test('目录点阵pattern按实际96×60尺寸验证并渲染，透明与蓝色点阵均保留',async()=>{
  const {src,dest}=files(dots);assert.deepEqual(await assetTool(env,'svg',src,dest,undefined,['96','60']),{valid:true});
  const validated=fs.readFileSync(dest,'utf8');assert.match(validated,/patternUnits="userSpaceOnUse"/);
  const result=new Resvg(validated).render(),pixels=result.pixels;assert.equal(result.width,96);assert.equal(result.height,60);
  let clear=0,blue=0;for(let i=0;i<pixels.length;i+=4){if(pixels[i+3]===0)clear++;if(pixels[i+3]>0&&pixels[i+2]>pixels[i])blue++;}
  assert.ok(clear>100);assert.ok(blue>100);
});

test('pattern局部引用不放开脚本、外链、文字、外来命名空间或声明',async()=>{
  for(const source of [svg('<script>alert(1)</script>'),svg('<pattern id="p" width="5" height="5" href="https://bad.example/x"/>'),svg('<rect width="80" height="50" fill="url(https://bad.example/x)"/>'),svg('<text>不可栅格化文字</text>'),svg('<g xmlns="urn:foreign"><circle r="2"/></g>'),'<!DOCTYPE svg>'+dots]){
    const {src,dest}=files(source);await assert.rejects(assetTool(env,'svg',src,dest,undefined,['96','60']),error=>error.code==='ASSET_VALIDATION_FAILED'&&!error.message.includes('Traceback'));
    assert.equal(fs.existsSync(dest),false);
  }
});

test('仅精简已知Python校验错误，保留原因；取消与进程错误不误报为SVG校验',async()=>{
  const original=Object.assign(Error('Command failed'),{stderr:'Traceback ...\r\nValueError: unsupported tag: script\r\n'});
  await assert.rejects(assetTool({...env,run:async()=>{throw original;}},'svg','a','b'),error=>error.message==='素材处理失败（svg）：unsupported tag: script'&&error.cause===original);
  const missing=Object.assign(Error('not found'),{code:'ENOENT'});await assert.rejects(assetTool({...env,run:async()=>{throw missing;}},'svg','a','b'),error=>error===missing);
  const aborted=Object.assign(Error('aborted'),{name:'AbortError',stderr:'ValueError: bad'});await assert.rejects(assetTool({...env,run:async()=>{throw aborted;}},'svg','a','b'),error=>error===aborted);
});
