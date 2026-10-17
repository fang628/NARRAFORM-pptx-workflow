import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Resvg} from '@resvg/resvg-js';
import {applyPlaceholderGeometry,refinePlaceholderGeometry} from '../lib/placeholder-geometry.mjs';
import {fittedImagePlans,containedImageBounds} from '../lib/image-geometry.mjs';
import {pageCheckPanel} from '../public/visual-ui.js';

const image=(id,box,aspect=2)=>({nodeId:id,id:'source-'+id,...box,aspect,pixelWidth:600,pixelHeight:300});
const run=(body,images,width=1920,height=1080)=>{
  const dir=fs.mkdtempSync(path.resolve('work','placeholder-geometry-')),file=path.join(dir,'page.png'),input=path.join(dir,'input.json'),output=path.join(dir,'output.json');
  fs.writeFileSync(file,new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#333333"/>${body}</svg>`).render().asPng());
  fs.writeFileSync(input,JSON.stringify({image:file,images}));
  return JSON.parse(execFileSync(path.resolve('.venv/Scripts/python.exe'),['tools/placeholder_geometry.py',input,output],{windowsHide:true,encoding:'utf8'}));
};
const near=(actual,expected,tolerance=1.7)=>{for(const k of ['x','y','w','h'])assert.ok(Math.abs(actual[k]-expected[k])<=tolerance,`${k}: ${actual[k]} vs ${expected[k]}`);};

test('原生像素测量内框，排除描边与阴影；任意16:9分辨率映射到相同场景',()=>{
  const actual={x:800,y:250,w:400,h:200},coarse=[image('a',{x:789,y:243,w:425,h:219})];
  for(const [width,height] of [[1920,1080],[1280,720]]){
    const raw=run('<rect x="806" y="256" width="400" height="200" fill="#555555"/><rect x="796" y="246" width="408" height="208" fill="#111111"/><rect x="800" y="250" width="400" height="200" fill="#dedede"/>',coarse,width,height);
    const result=applyPlaceholderGeometry(coarse,raw);assert.equal(result.report.refined,1);near(result.images[0],actual);assert.equal(raw.width,width);assert.equal(raw.height,height);
    assert.deepEqual(coarse[0],image('a',{x:789,y:243,w:425,h:219}));
  }
});

test('多个同色占位框一一匹配，并保留真实的比例偏差供已有修框流程检查',()=>{
  const coarse=[image('wide',{x:90,y:195,w:420,h:210},2),image('square',{x:895,y:195,w:210,h:210},1)];
  const raw=run('<rect x="100" y="200" width="400" height="200" fill="#dddddd"/><rect x="900" y="200" width="200" height="200" fill="#dddddd"/>',coarse);
  const r=applyPlaceholderGeometry(coarse,raw);assert.equal(r.report.refined,2);near(r.images[0],{x:100,y:200,w:400,h:200});near(r.images[1],{x:900,y:200,w:200,h:200});
  const wrong=[image('a',{x:795,y:245,w:412,h:212},3)];
  const measured=applyPlaceholderGeometry(wrong,run('<rect x="800" y="250" width="400" height="200" fill="#ddd"/>',wrong));
  assert.equal(measured.report.refined,1);near(measured.images[0],{x:800,y:250,w:400,h:200});assert.ok(Math.abs(measured.images[0].w/measured.images[0].h-2)<.02,'不把测量结果强改为期望比例3:1');
});

test('原图宽高比和像素尺寸改变不影响对应关系、检测结果或匹配评分',()=>{
  const coarse=[image('wide',{x:90,y:195,w:420,h:210},2),image('square',{x:895,y:195,w:210,h:210},1)],body='<rect x="100" y="200" width="400" height="200" fill="#ddd"/><rect x="900" y="200" width="200" height="200" fill="#ddd"/>';
  const baseline=run(body,coarse),altered=run(body,coarse.map((e,i)=>({...e,aspect:i?100:.01,pixelWidth:i?1:100000,pixelHeight:i?100000:1})));
  assert.deepEqual(altered.images.map(e=>e.localization),baseline.images.map(e=>e.localization),'连匹配评分也不受原图比例影响');
  for(let i=0;i<coarse.length;i++){assert.equal(altered.images[i].nodeId,coarse[i].nodeId);assert.equal(altered.images[i].id,coarse[i].id);near(altered.images[i],baseline.images[i],0);}
  assert.match(altered.matchingBasis,/AI-node-identity.*spatial-overlap/);assert.doesNotMatch(altered.method,/aspect/);
});

test('弱边界、无占位框、渐变内容与远处装饰不强行吸附',()=>{
  const coarse=[image('a',{x:800,y:250,w:400,h:200})];
  for(const body of ['', '<rect x="100" y="100" width="400" height="200" fill="#ddd"/>', '<defs><linearGradient id="g"><stop stop-color="#888"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect x="800" y="250" width="400" height="200" fill="url(#g)"/>']){
    const r=applyPlaceholderGeometry(coarse,run(body,coarse));assert.equal(r.report.refined,0);near(r.images[0],coarse[0],0);
  }
});

test('圆角渐变占位框超出AI局部窗口时仍按真实边界定位，不吸附带文字的面板',()=>{
  const coarse=[image('a',{x:748,y:258,w:548,h:330})];
  const body='<defs><linearGradient id="quiet"><stop stop-color="#526588"/><stop offset="1" stop-color="#57698d"/></linearGradient></defs><rect x="889" y="296" width="614" height="408" rx="14" fill="url(#quiet)" stroke="#eeeeff" stroke-width="2"/>';
  const result=applyPlaceholderGeometry(coarse,run(body,coarse));
  assert.equal(result.report.refined,1);near(result.images[0],{x:889,y:296,w:614,h:408},3);
  assert.equal(result.images[0].nodeId,'a');assert.equal(result.images[0].id,'source-a');
  const text=Array.from({length:10},(_,i)=>`<text x="950" y="${340+i*30}" fill="white" font-size="20">NOT AN EMPTY IMAGE SLOT</text>`).join('');
  const occupied=applyPlaceholderGeometry(coarse,run(body+text,coarse));assert.equal(occupied.report.refined,0);
});

test('全局匹配避开贪心错误；单一候选不能分给两图',()=>{
  const optimal=JSON.parse(execFileSync(path.resolve('.venv/Scripts/python.exe'),['-c','import sys,json,numpy as np;sys.path.insert(0,"tools");from placeholder_geometry import assignment;print(json.dumps(assignment(np.array([[1.,2.],[1.1,10.]]))))'],{windowsHide:true,encoding:'utf8'}));
  assert.deepEqual(optimal,[1,0]);
  const coarse=[image('a',{x:700,y:250,w:200,h:200},2),image('b',{x:700,y:250,w:200,h:200},.5)];
  // The native matcher is tested directly with overlapping coarse hints; real AI
  // plans reject overlaps before this stage. Ratios do not resolve equal hints.
  const raw=run('<rect x="700" y="250" width="200" height="200" fill="#ddd"/>',coarse);
  const selected=raw.images.filter(e=>e.localization.status==='refined');
  assert.equal(selected.length,1);
  assert.equal(new Set(selected.map(e=>JSON.stringify(e.localization.box))).size,selected.length);
});

test('与背景同色的占位区可用断续边线定位；两个同样可信的候选不武断选择',()=>{
  const coarse=[image('a',{x:790,y:240,w:420,h:220})];
  const border='<path d="M810 250H1190 M1200 260V440 M1190 450H810 M800 440V260" stroke="#ddd" stroke-width="2" fill="none"/>';
  const raw=run(border,coarse),r=applyPlaceholderGeometry(coarse,raw);assert.equal(r.report.refined,1);near(r.images[0],{x:801,y:251,w:398,h:198},3);assert.equal(r.images[0].localization.method,'hough-lines');
  const ambiguous=[image('a',{x:100,y:200,w:410,h:200},1)];
  const uncertain=applyPlaceholderGeometry(ambiguous,run('<rect x="100" y="200" width="200" height="200" fill="#ddd"/><rect x="310" y="200" width="200" height="200" fill="#ddd"/>',ambiguous));assert.equal(uncertain.report.refined,0);
});

test('损坏或重叠结果局部回退，运行环境缺失不中断，取消立即传播',async()=>{
  const images=[image('a',{x:100,y:100,w:200,h:100}),image('b',{x:400,y:100,w:200,h:100})];
  const raw={status:'available',images:images.map(e=>({...e,x:300,localization:{status:'refined',confidence:1}}))};
  const r=applyPlaceholderGeometry(images,raw);assert.equal(r.report.refined,0);for(let i=0;i<2;i++)near(r.images[i],images[i],0);
  raw.images[0].x=NaN;raw.images[1].x=401;const partial=applyPlaceholderGeometry(images,raw);assert.equal(partial.report.refined,1);assert.equal(partial.images[0].x,100);assert.equal(partial.images[1].x,401);
  raw.images[0]=null;assert.equal(applyPlaceholderGeometry(images,raw).report.refined,1,'单项损坏不丢弃其他正确精定位结果');
  const dir=fs.mkdtempSync(path.resolve('work','placeholder-fallback-')),env={root:process.cwd(),run:async()=>{throw Error('missing cv2');}};
  const unavailable=await refinePlaceholderGeometry(env,'python',path.join(dir,'page.png'),images);assert.equal(unavailable.report.status,'unavailable');assert.deepEqual(unavailable.images,images);
  const c=new AbortController();c.abort();await assert.rejects(refinePlaceholderGeometry(env,'python',path.join(dir,'page.png'),images,c.signal));
});

test('轻微比例偏差贴满占位框，预览和PPT一致；检查面板说明精定位和回退',()=>{
  const measured=image('a',{x:100,y:100,w:400,h:210}),[fitted]=fittedImagePlans([measured]);
  assert.deepEqual(fitted.placeholderBox,{x:100,y:100,w:400,h:210});near(fitted,{x:100,y:100,w:400,h:210},0);assert.equal(fitted.imageFit,'fill');
  const png=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"/>').render().asPng();near(containedImageBounds(png,fitted,{allowSmallDistortion:true}),fitted,0);
  const html=pageCheckPanel({id:'p'},{index:0,previewReview:{status:'pending'},placeholderLocalization:{refined:1,total:2}},'concept','a');assert.match(html,/本地边界精定位 1\/2 张.*其余沿用 AI 定位/);
});
