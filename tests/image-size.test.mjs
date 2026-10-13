import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const testPNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
import {generatedImage} from '../lib/provider.mjs';

test('整页接受较小的 16:9，等比规范化；其他比例拒绝',()=>{
  const dir=path.resolve('work','preview-sizes-'+Date.now()),python=path.resolve('.venv/Scripts/python.exe');fs.mkdirSync(dir,{recursive:true});
  const create='from PIL import Image;import sys;Image.new("RGB",(int(sys.argv[2]),int(sys.argv[3])),(255,242,56)).save(sys.argv[1])';
  for(const [w,h] of [[320,180],[1280,720],[1920,1080],[2560,1440]]){
    const source=path.join(dir,`${w}.png`),target=path.join(dir,`${w}-normalized.png`);execFileSync(python,['-c',create,source,String(w),String(h)],{windowsHide:true});
    const result=JSON.parse(execFileSync(python,['tools/visual_assets.py','normalize',source,target],{encoding:'utf8',windowsHide:true}));assert.equal(result.sourceWidth,w);assert.equal(result.sourceHeight,h);assert.equal(result.width,1920);assert.equal(result.height,1080);assert.equal(result.upscaled,w<1920);
  }
  const square=path.join(dir,'square.png');execFileSync(python,['-c',create,square,'1024','1024'],{windowsHide:true});assert.throws(()=>execFileSync(python,['tools/visual_assets.py','normalize',square,path.join(dir,'bad.png')],{windowsHide:true,stdio:'pipe'}),/16:9/);assert.equal(fs.existsSync(path.join(dir,'bad.png')),false);
});
test('仅明确拒绝尺寸时降为 auto；权限与普通错误不重试，服务器异常有界重试',async t=>{
  const previous=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';let mode='size',requests=[];
  const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);requests.push(b);res.setHeader('content-type','application/json');
    if(mode==='size'&&b.size==='1920x1080'){res.statusCode=400;res.end(JSON.stringify({error:{param:'size',message:'Unsupported size'}}));return;}
    if(mode==='size'){res.end(JSON.stringify({data:[{b64_json:testPNG.toString('base64')}]}));return;}
    res.statusCode=mode==='auth'?401:mode==='server'?500:400;res.end(JSON.stringify({error:{message:'Request failed'}}));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.close();if(previous===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=previous;});
  const cfg={baseURL:'http://127.0.0.1:'+server.address().port+'/v1',key:'synthetic',model:'gpt-image-2'},options={size:'1920x1080',allowAutoSize:true};let fallback;
  const image=await generatedImage(cfg,'整页16:9，1920×1080优先，允许较小尺寸',undefined,{...options,onSizeFallback:size=>fallback=size});assert.deepEqual(image,testPNG);assert.deepEqual(requests.map(r=>r.size),['1920x1080','auto']);assert.equal(fallback,'auto');assert.equal(requests[1].prompt,requests[0].prompt);
  for(mode of ['auth','server','ordinary']){requests=[];await assert.rejects(generatedImage(cfg,'16:9',undefined,options),/HTTP/);assert.equal(requests.length,mode==='server'?3:1);}
  mode='size';requests=[];await assert.rejects(generatedImage(cfg,'16:9',undefined,{size:'1920x1080'}),/HTTP 400/);assert.equal(requests.length,1);
});

test('参考图编辑发送multipart并保留原图，编辑协议失败不降为文生图',async t=>{
  const previous=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';const requests=[];let fail=false;
  const server=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const form=await new Request('http://127.0.0.1',{method:'POST',headers:{'content-type':req.headers['content-type']},body:Buffer.concat(chunks)}).formData();requests.push({url:req.url,model:form.get('model'),size:form.get('size'),prompt:form.get('prompt'),bytes:Buffer.from(await form.get('image').arrayBuffer())});res.setHeader('content-type','application/json');if(fail){res.statusCode=404;res.end('{}');return;}res.end(JSON.stringify({data:[{b64_json:testPNG.toString('base64')}]}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.close();if(previous===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=previous;});
  const config={baseURL:`http://127.0.0.1:${server.address().port}/v1`,key:'synthetic',model:'gpt-image-2'},source=Buffer.from('original-generated-background'),options={size:'1920x1080',allowAutoSize:true,references:[{bytes:source}]};
  const result=await generatedImage(config,'在原底图上加入标题',undefined,options);assert.deepEqual(result,testPNG);assert.equal(requests[0].url,'/v1/images/edits');assert.equal(requests[0].model,'gpt-image-2');assert.equal(requests[0].size,'1920x1080');assert.deepEqual(requests[0].bytes,source);
  fail=true;await assert.rejects(generatedImage(config,'仅局部修改',undefined,options),/HTTP 404/);assert.equal(requests.length,2);assert.ok(requests.every(r=>r.url.endsWith('images/edits')));
});
