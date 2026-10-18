import test from 'node:test';
import assert from 'node:assert/strict';
import {Resvg} from '@resvg/resvg-js';
import {imageSize} from 'image-size';
import {imageEditRegion,imageEditRegionPrompt,annotatedEditRegion} from '../lib/image-edit-region.mjs';
import {initImageEditRegion} from '../public/image-edit-region.js';
import {imageEditExecution} from '../lib/ai-image-edit.mjs';
import {imageTaskRequest} from '../lib/image-task-queue.mjs';

test('框选限定有效坐标，队列隔离请求，旧图片与文生图不能误用定位',()=>{
  const region={x:100,y:200,w:300,h:400};
  assert.equal(imageEditRegion(undefined),null);
  assert.deepEqual(imageEditRegion({...region,x:100.123,ignored:true}),{...region,x:100.12});
  for(const bad of [[],42,{...region,x:'100'},{...region,x:NaN},{...region,w:0},{...region,x:-1},{...region,h:900}])assert.throws(()=>imageEditRegion(bad),/框选/);
  const p={materials:[{id:'m',kind:'image',generated:true,file:'original.png',sha256:'current',prompt:'旧的完整设计'}]},b={action:'image',sourceImageId:'m',sourceHash:'current',imageEditMode:'adjust',instruction:'放大这个图标',editRegion:region};
  const queued=imageTaskRequest(b);region.x=150;assert.equal(queued.editRegion.x,100);
  const result=imageEditExecution(p,queued);assert.match(result.prompt,/左 10%、上 20%、宽 30%、高 40%/);assert.match(result.prompt,/不裁切整图、不把框线当作修改边界/);assert.doesNotMatch(result.prompt,/旧的完整设计/);
  assert.equal(imageEditRegionPrompt(b.instruction,null),b.instruction);
  assert.throws(()=>imageEditExecution(p,{...queued,sourceHash:'stale'}),/图片已变化/);
  assert.throws(()=>imageEditExecution(p,{...queued,imageEditMode:'redraw',prompt:'新设计'}),/仅用于图生图/);
});

test('定位附件保留完整画面，仅添加标记，不改原文件且限制两个维度',()=>{
  const original=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#eeeeee"/><circle cx="240" cy="90" r="20" fill="#e03131"/></svg>').render().asPng(),copy=Buffer.from(original);
  const marked=annotatedEditRegion(original,{x:100,y:200,w:300,h:400});
  assert.deepEqual(original,copy);assert.notDeepEqual(marked,original);
  assert.equal(imageSize(marked).width,320);assert.equal(imageSize(marked).height,180);
  const pixels=bytes=>new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><image href="data:image/png;base64,'+bytes.toString('base64')+'" width="320" height="180"/></svg>').render().pixels;
  const a=pixels(original),b=pixels(marked),pixel=(v,x,y)=>[...v.slice((y*320+x)*4,(y*320+x)*4+4)];
  for(const [x,y] of [[0,0],[240,90],[319,179]])assert.deepEqual(pixel(b,x,y),pixel(a,x,y),'框外画面和主体保留');
  assert.notDeepEqual(pixel(a,32,40),pixel(b,32,40),'框线真实写入参考图');
  const tall=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="4000"/>').render().asPng(),size=imageSize(annotatedEditRegion(tall,{x:0,y:0,w:500,h:500}));
  assert.equal(size.height,1920);assert.equal(size.width,48);
});

test('缩放显示后的框选、移动、缩放、取消与清除都按原图比例定位',()=>{
  const node=()=>({handlers:{},style:{},classList:{toggle(){}},setAttribute(){},addEventListener(n,fn){this.handlers[n]=fn;}}),stage=node(),image={complete:true,naturalWidth:1600,getBoundingClientRect:()=>({left:100,top:50,width:800,height:450})},overlay=node(),toggle=node(),clear=node(),status=node(),changes=[];
  stage.setPointerCapture=()=>{};stage.hasPointerCapture=()=>true;stage.releasePointerCapture=()=>{};
  const editor=initImageEditRegion({stage,image,overlay,toggle,clear,status,onChange:r=>changes.push(r)});
  const target={closest:()=>null},inside={closest:s=>s==='#aiEditRegionSelection'?overlay:null},handle={closest:s=>s==='[data-edit-region-handle]'?{dataset:{editRegionHandle:'se'}}:null};
  const event=(x,y,t=target)=>({pointerId:1,button:0,clientX:x,clientY:y,target:t,preventDefault(){}}),drag=(a,b,t=target,cancel=false)=>{stage.handlers.pointerdown(event(...a,t));stage.handlers.pointermove(event(...b,t));stage.handlers[cancel?'pointercancel':'pointerup'](event(...b,t));};
  editor.setEnabled(true);toggle.handlers.click();drag([180,140],[420,320]);
  assert.deepEqual(editor.value,{x:100,y:200,w:300,h:400});assert.equal(overlay.style.left,'10%');assert.equal(overlay.style.height,'40%');
  drag([200,160],[280,205],inside);assert.deepEqual(editor.value,{x:200,y:300,w:300,h:400});
  drag([500,350],[580,395],handle);assert.deepEqual(editor.value,{x:200,y:300,w:400,h:500});
  drag([100,50],[900,500],target,true);assert.deepEqual(editor.value,{x:200,y:300,w:400,h:500});
  editor.setEnabled(false);drag([100,50],[900,500]);assert.equal(changes.length,4);assert.equal(overlay.hidden,true);
  editor.setEnabled(true);clear.handlers.click();assert.equal(editor.value,null);assert.equal(overlay.hidden,true);
});
