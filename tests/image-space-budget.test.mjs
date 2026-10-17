import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Resvg} from '@resvg/resvg-js';
import {minimumImageSize,pageImageBudget,plannedImageGeometry,prepareImageReadability,imageSizeText,preserveImageSizes} from '../lib/image-space-budget.mjs';
import {slideImagePrompt,effectiveSlideImagePrompt} from '../lib/slide-image-prompts.mjs';
import {pageDesignPrompt} from '../lib/page-design.mjs';
import {materialImageCatalog} from '../lib/content-images.mjs';
import http from 'node:http';
import {contentWithEvidence} from '../lib/content-evidence.mjs';
import {validateSlides} from '../lib/scene.mjs';

const slide=(count=1,points=8)=>({kind:'content',title:'处理方案',body:[],notes:'',sources:[],elements:[
  {id:'title',type:'text',role:'title',text:'处理方案',parentId:null},
  {id:'group',type:'group',label:'实验结果',parentId:'title'},
  ...Array.from({length:points},(_,i)=>({id:'body-'+i,type:'text',role:'body',text:`组${i+1}：处理${i+1}小时，观察结果与对照存在差异。`,parentId:'group'})),
  ...Array.from({length:count},(_,i)=>({id:'img-'+i,type:'image',materialId:'m-'+i,label:'结果图'+i,parentId:'group'}))]});
const project=(count=1)=>({brief:{title:'研究汇报',cover:false,progress:false},slides:[slide(count)],materials:Array.from({length:count},(_,i)=>({id:'m-'+i,file:'m.png',name:'质谱结果图',kind:'image',width:1200,height:600,imageReadability:{detailHeightPx:24}}))});

test('按原图关键细节计算最小可读尺寸，缩小源图细节会提高占地需求',()=>{
  const m={width:1200,height:600,imageReadability:{detailHeightPx:24}},a=minimumImageSize(m),b=minimumImageSize({...m,imageReadability:{detailHeightPx:12}});
  assert.equal(a.w,1200);assert.equal(a.h,600);assert.equal(b.w,2400);assert.equal(b.h,1200);
  assert.equal(a.w/a.h,2);assert.equal(b.w/b.h,2);
  assert.ok(minimumImageSize({width:600,height:1200,name:'照片'}).h>minimumImageSize({width:600,height:1200,name:'照片'}).w);
});

test('图片数量与大小不减少文字或分点，图片框仍不越界、不重叠且保留原始比例',()=>{
  const p=project(),small=pageImageBudget(p,p.slides[0]);
  p.materials[0].imageReadability.detailHeightPx=10;const large=pageImageBudget(p,p.slides[0]);
  const many=project(4),crowded=pageImageBudget(many,many.slides[0]);
  assert.equal(large.textCharacters,small.textCharacters);assert.equal(crowded.textCharacters,small.textCharacters);
  assert.equal(crowded.textPoints,8);assert.equal(large.textPoints,small.textPoints);assert.equal(crowded.maxBodyPoints,undefined);assert.equal(crowded.maxBodyCharacters,undefined);assert.equal(crowded.minimumsFit,false);
  const input=many.slides[0].elements.filter(e=>e.type==='image').map(e=>({nodeId:e.id,id:e.materialId,x:1300,y:700,w:30,h:20,aspect:2})),plans=plannedImageGeometry(many,0,input);
  for(const e of plans){assert.ok(e.x>=0&&e.y>=0&&e.x+e.w<=1600.001&&e.y+e.h<=900.001);assert.ok(Math.abs(e.w/e.h-2)<1e-10);assert.equal(imageSizeText(e),`${e.plannedSize.w}×${e.plannedSize.h} px`);}
  for(let i=0;i<plans.length;i++)for(const b of plans.slice(i+1)){const a=plans[i];assert.ok(Math.min(a.x+a.w,b.x+b.w)<=Math.max(a.x,b.x)+.01||Math.min(a.y+a.h,b.y+b.h)<=Math.max(a.y,b.y)+.01);}
  assert.equal(input[0].w,30,'不修改模型原始定位输入');
});

test('正文空间按既有完整信息估算，文字多时调整图片占地，不倒过来删正文',()=>{
  const p=project(),s=p.slides[0],before=structuredClone(s),short=pageImageBudget(p,s);
  for(const n of s.elements.filter(n=>n.type==='text'&&n.role==='body'))n.text=n.text.repeat(5);
  const full=structuredClone(s),budget=pageImageBudget(p,s);
  assert.equal(budget.textPoints,short.textPoints);assert.ok(budget.textCharacters>short.textCharacters);
  assert.ok(budget.textAreaFraction>short.textAreaFraction);assert.ok(budget.imageAreaFraction<short.imageAreaFraction);
  assert.deepEqual(s,full);assert.equal(s.elements.length,before.elements.length);
});

test('本地测量支持图内小文字，源图不改动，按文件版本缓存且运行失败不阻断',async()=>{
  const data=fs.mkdtempSync(path.resolve('work','readability-')),folder=path.join(data,'p','assets');fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,'m.png');
  execFileSync(path.resolve('.venv/Scripts/python.exe'),['-c','from PIL import Image,ImageDraw,ImageFont;import sys;im=Image.new("RGB",(1200,600),"white");d=ImageDraw.Draw(im);f=ImageFont.truetype("C:/Windows/Fonts/arial.ttf",18);[d.text((40,50+i*65),"Control 12h Treatment 24h Result 50%",fill="black",font=f) for i in range(7)];im.save(sys.argv[1])',file],{windowsHide:true});
  const bytes=fs.readFileSync(file),hash=crypto.createHash('sha256').update(bytes).digest('hex'),p={id:'p',materials:[{id:'m',file:'m.png',kind:'image',sha256:hash}]};
  let calls=0;const run=async(...args)=>{calls++;return promisify(execFile)(...args);};
  await prepareImageReadability(p,{root:process.cwd(),data,run});
  assert.equal(p.materials[0].width,1200);assert.equal(p.materials[0].height,600);
  assert.ok(p.materials[0].imageReadability.detailHeightPx>0);assert.ok(p.materials[0].imageReadability.detailHeightPx<24);
  assert.deepEqual(fs.readFileSync(file),bytes);await prepareImageReadability(p,{root:process.cwd(),data,run});assert.equal(calls,1);
  delete p.materials[0].imageReadability;await assert.doesNotReject(prepareImageReadability(p,{root:process.cwd(),data,run:async()=>{throw Error('optional runtime unavailable');}}));
  const c=new AbortController();c.abort();await assert.rejects(prepareImageReadability(p,{root:process.cwd(),data,run},c.signal));
});

test('内部预算进入内容候选与设计上下文，生图仅展示尺寸一次，旧稿补全不叠加',()=>{
  const p=project(),s=p.slides[0],direction={id:'a',coreColor:'#ffffff',style:'蓝白灰',styleSummary:'蓝白灰'};
  p.pageDesigns={0:{plan:{layoutIntent:'左文右图',logic:'证据支撑结论',nodes:s.elements.map(n=>({id:n.id,position:'右侧',relativeSize:'中等',alignment:'左对齐',carrier:'无框',relation:'附属'}))}}};
  const images=plannedImageGeometry(p,0,[{nodeId:'img-0',id:'m-0',aspect:2}]),size=imageSizeText(images[0]);
  assert.ok(materialImageCatalog(p)[0].minimumReadableSize);assert.match(pageDesignPrompt(p,0),/内部图片空间预算/);
  const prompt=slideImagePrompt(p,0,direction,images);assert.ok(prompt.includes('占位框尺寸约 '+size));assert.equal(prompt.split('占位框尺寸约').length,2);assert.doesNotMatch(prompt,/maxBodyCharacters|minimumsFit|最小可读尺寸|2%/);
  const legacy=prompt.replace(/，占位框尺寸约 \d+×\d+ px（1920×1080画布）/,'');
  const fixed=effectiveSlideImagePrompt(p,0,direction,images,'full',legacy);assert.ok(fixed.includes(size));assert.equal(effectiveSlideImagePrompt(p,0,direction,images,'full',fixed),fixed);
  assert.doesNotThrow(()=>preserveImageSizes(prompt,prompt));assert.throws(()=>preserveImageSizes(prompt,legacy),/占位框尺寸/);
  assert.throws(()=>preserveImageSizes('图甲900×500 px；图乙900×500 px','图甲900×500 px；图乙比例不变'),/占位框尺寸/);
});

test('真实文字API对多图页不再额外压缩，全部正文与独立分点原样保留',async t=>{
  const previous=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';t.after(()=>{if(previous===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=previous;});
  const p=project(2);p.slides=validateSlides(p.slides);const original=structuredClone(p.slides),calls=[];
  const mock=http.createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;const input=JSON.parse(data),text=input.messages.at(-1).content;calls.push(text);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({slides:original})}}]}));});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const result=await contentWithEvidence({config:{baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic-only',model:'fixture'},system:'JSON',user:'规划1页内容，使用登记图片。',project:p,decode:raw=>raw.slides,expectedPages:1,validate:validateSlides,signal:new AbortController().signal});
  assert.equal(calls.length,1);assert.equal(result.slides.length,1);assert.equal(result.slides[0].elements.filter(n=>n.role==='body'&&n.type==='text').length,8);assert.equal(result.slides[0].elements.filter(n=>n.type==='image').length,2);assert.deepEqual(result.slides,original);assert.deepEqual(p.slides,original);
});
