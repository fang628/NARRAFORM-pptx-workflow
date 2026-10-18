import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Resvg} from '@resvg/resvg-js';
import {visualAction} from '../lib/visual-pipeline.mjs';
import {pageDesignStamp} from '../lib/page-design.mjs';
import {pageStamp,visualStamp,digest} from '../lib/visual-model.mjs';
import {themeAssetsStamp} from '../lib/theme-assets.mjs';
import {fixtureRequest} from './visual-fixture.mjs';
import {generatedImage} from '../lib/provider.mjs';

test('素材失败的单页重试复用有效审计，抠图实际提交透明PNG参数并验证alpha',async t=>{
  const previous=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';t.after(()=>{if(previous===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=previous;});
  const calls=[],png=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><circle cx="1100" cy="650" r="30" fill="#88aaff"/></svg>').render().asPng();
  const mock=http.createServer(async(req,res)=>{const b=await fixtureRequest(req);calls.push({url:req.url,...b});res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.endsWith('/images/edits')?{data:[{b64_json:png.toString('base64')}]}:{choices:[{message:{content:JSON.stringify({passed:true,issues:[],correctedPrompt:null})}}]}));});await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const root=path.resolve('.'),data=fs.mkdtempSync(path.join(root,'work/transparent-retry-')),id='test',folder=path.join(data,id);fs.mkdirSync(path.join(folder,'assets'),{recursive:true});fs.writeFileSync(path.join(folder,'assets/bg.png'),png);fs.writeFileSync(path.join(folder,'preview.png'),png);
  const p={id,version:1,brief:{title:'素材重试',pages:1,cover:false,toc:false,progress:false},slides:[{kind:'content',title:'素材重试',body:[],sources:[]}],concepts:[{id:'a',style:'浅蓝'}],selectedTheme:'a',approvals:{preview:1},visualMode:'ai',materials:[{id:'bg',file:'bg.png',generated:true,kind:'image',purpose:'workflow-background',sha256:digest(png)}]};
  p.themeAssets={stamp:themeAssetsStamp(p),directions:[{id:'a',assets:{'content-background':{materialId:'bg',normalized:'assets/bg.png',previewHash:digest(png)}}}]};const stamp=pageDesignStamp(p,0);p.pageDesigns={0:{layoutStamp:stamp,draftStamp:stamp,layoutApprovedAt:'now',approvedAt:'now',markdown:'单页素材测试'}};p.visualPages={0:{file:'preview.png',previewHash:digest(png),stamp:pageStamp(p,0),images:[]}};
  const title={key:'title',type:'text',nodeId:'title',text:'素材重试',x:50,y:100,w:800,h:80,size:40,color:'272727',bold:true},icon={key:'icon',type:'cutout',x:1000,y:600,w:180,h:140,sourceBox:{x:1000,y:600,w:180,h:140},prompt:'提取当前图标，保留主体形状并移除背景',nonFactual:true};
  p.rebuildAssetPreview={stamp:visualStamp(p),version:1,status:'partial',materials:[],pages:[{index:0,status:'partial',background:{id:'bg',sha256:digest(png)},elements:[title],audit:[title,icon],auditValidation:{status:'passed',records:[]},failedElements:[{key:'icon',error:'旧的透明度错误'}],issues:['旧的透明度错误']}]};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic-only',model:'gpt-image-test'};let completion;
  await visualAction(p,{action:'retryRebuildPage',index:0},{root,data,credentials:new Map([[id,{text:cfg,image:cfg}]]),system:'只输出JSON',run:promisify(execFile),save(){},event(){},ensure(_,valid,message){if(!valid)throw Error(message);},getImage(_,assetId){return path.join(folder,'assets',p.materials.find(m=>m.id===assetId).file);},launch(_,name,fn){p.task={status:'running',message:name};completion=fn(new AbortController().signal);}});await completion;
  assert.equal(calls.filter(c=>c.messages?.at(-1)?.content?.[0]?.text?.startsWith('自由元素审计：')).length,0);
  const imageCall=calls.find(c=>c.url.endsWith('/images/edits'));assert(imageCall);assert.equal(imageCall.background,'transparent');assert.equal(imageCall.output_format,'png');assert.equal(imageCall.referenceImages.length,1);
  assert.equal(p.reconstruction.slides[0].auditValidation.reused,true);assert.equal(p.rebuildAssetPreview.status,'done');const asset=p.materials.find(m=>m.origin==='ai-cutout');assert(asset.alpha.hasTransparency);assert(asset.alpha.hasVisiblePixels);
});

test('仅透明能力被明确拒绝时去掉参数重试；参考图和最终指令保持不变',async t=>{
  const previous=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';t.after(()=>{if(previous===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=previous;});
  const calls=[],png=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="10" fill="blue"/></svg>').render().asPng();
  const mock=http.createServer(async(req,res)=>{const b=await fixtureRequest(req);calls.push(b);res.setHeader('content-type','application/json');if(b.background){res.statusCode=422;res.end(JSON.stringify({error:{code:'image_request_capability_not_supported',message:'No eligible upstream provider supports the requested background mode'}}));}else res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));});await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  let fallbacks=0;const output=await generatedImage({baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic-only',model:'gpt-image-test'},'提取当前主体，不改变形状',new AbortController().signal,{transparentBackground:true,onTransparencyFallback:()=>fallbacks++,references:[{bytes:png}]});
  assert.deepEqual(output,png);assert.equal(calls.length,2);assert.equal(fallbacks,1);assert.equal(calls[0].background,'transparent');assert.equal(calls[1].background,undefined);assert.equal(calls[1].prompt,calls[0].prompt);assert.deepEqual(calls[1].referenceImages,calls[0].referenceImages);
});
