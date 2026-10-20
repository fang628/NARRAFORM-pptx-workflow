import test from 'node:test';
import assert from 'node:assert/strict';
import {withLocalCutoutFallback,opaqueCutoutPrompt} from '../lib/cutout-fallback.mjs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
test('透明参数不支持时生成不透明纯色底提示词，保留准确文字且无透明/纯色冲突',()=>{
 const prompt=opaqueCutoutPrompt('抠出书法字“山河”，透明背景，输出透明主体，保留笔触');
 assert.match(prompt,/山河/);assert.match(prompt,/纯洋红/);assert.doesNotMatch(prompt,/透明背景|透明主体/);
});
test('抠图通道不支持或503时走本地替换路径，取消与权限错误不触发备用请求',async()=>{
 for(const error of [Object.assign(Error('不支持图生图'),{httpStatus:404}),Object.assign(Error('503已重试'),{httpStatus:503}),Object.assign(Error('无透明主体'),{code:'CUTOUT_ALPHA_INVALID'})]){
  let calls=0;const result=await withLocalCutoutFallback({attempt:async()=>{throw error;},extractLocal:async()=>{calls++;return {mode:'local'};}});assert.equal(calls,1);assert.equal(result.mode,'local');
 }
 let called=false;await assert.rejects(withLocalCutoutFallback({attempt:async()=>{throw Object.assign(Error('权限不足'),{httpStatus:403});},extractLocal:async()=>{called=true;}}),/权限/);assert(!called);
 const controller=new AbortController();controller.abort();await assert.rejects(withLocalCutoutFallback({signal:controller.signal,attempt:async()=>{throw Error('cancelled');},extractLocal:async()=>{called=true;}}),/cancelled/);assert(!called);
 await assert.rejects(withLocalCutoutFallback({attempt:async()=>{throw Object.assign(Error('503'),{httpStatus:503});},extractLocal:async()=>{throw Error('背景漂移过大');}}),e=>e.httpStatus===503&&/503.*背景漂移/.test(e.message));
});
test('本地背景差分保留原字形像素、镂空和断开的笔画，纯色去底不吞白字；复杂漂移安全拒绝',()=>{
 const script=`
import sys
sys.path.insert(0,'tools')
from PIL import Image,ImageDraw
import numpy as np
from reference_cutout import reference_cutout
from cutout_alpha import prepare_cutout
bg=Image.new('RGBA',(400,200),(12,30,70,255));im=bg.copy();d=ImageDraw.Draw(im)
d.rectangle((60,40,160,160),fill='white');d.rectangle((85,65,135,110),fill=(12,30,70,255));d.rectangle((210,70,230,150),fill=(40,220,255,255));d.rectangle((290,30,298,38),fill='white')
out,r=reference_cutout(im,bg);a=np.asarray(out);left,top,_,_=r['trimBox']
assert r['mode']=='registered-background-difference' and r['hasTransparency']
assert a[50-top,70-left,:3].tolist()==[255,255,255]
assert a[80-top,100-left,3]==0
assert a[34-top,294-left,3]>200
art=im.copy();ad=ImageDraw.Draw(art);ad.line((360,170,399,199),fill='white',width=2)
art_out,art_report=reference_cutout(art,bg,True);aa=np.asarray(art_out);al,at,ar,ab=art_report['trimBox'];assert aa[34-at,294-al,3]>200 and ar<350
matte=Image.new('RGBA',(200,200),(255,0,255,255));d=ImageDraw.Draw(matte);d.rectangle((40,40,160,160),fill='white');d.rectangle((80,80,120,120),fill=(255,0,255,255))
out,r=prepare_cutout(matte);arr=np.asarray(out);left,top,_,_=r['trimBox'];assert r['mode']=='chroma-background-matte' and arr[100-top,100-left,3]==0 and arr[50-top,50-left,3]==255
for source,base in [(bg,bg),(Image.new('RGBA',(400,200),'white'),bg)]:
 try:reference_cutout(source,base)
 except ValueError:pass
 else:raise AssertionError('unsafe separation accepted')
print('OK')
`;
 assert.match(execFileSync(path.resolve('.venv/Scripts/python.exe'),['-c',script],{encoding:'utf8'}),/OK/);
});

test('本地素材复用时按各实例框位恢复裁边，不能沿用第一次出现的绝对位置',async()=>{
 const {localCutoutTrim,localCutoutPlacement}=await import('../lib/cutout-fallback.mjs');
 const asset={localTrim:localCutoutTrim({trimBox:[10,20,80,90],sourceWidth:100,sourceHeight:100})};
 assert.deepEqual(localCutoutPlacement({x:0,y:0,w:100,h:100},asset),{x:10,y:20,w:70,h:70});
 assert.deepEqual(localCutoutPlacement({x:400,y:200,w:200,h:300},asset),{x:420,y:260,w:140,h:210});
});

test('本地抠图向外恢复字迹边界，避开邻近分隔线，裁边位置可以超出原提示框',async()=>{
 const {expandedCutoutRegion,localCutoutTrim,localCutoutPlacement}=await import('../lib/cutout-fallback.mjs');
 const source={x:145,y:118,w:1010,h:262};const expanded=expandedCutoutRegion(source,[{key:'title',type:'text',...source},{key:'line',type:'line',x:128,y:392,w:650,h:0}],{targetKey:'title'});
 assert(expanded.x<source.x);assert(expanded.y<source.y);assert(expanded.y+expanded.h<=389);assert(expanded.w*expanded.h<=1600*900*.35);
 const asset={localTrim:localCutoutTrim({trimBox:[74,59,1335,388],sourceWidth:1628,sourceHeight:388},{source,expanded})};const placed=localCutoutPlacement({artisticText:true,sourceBox:source,x:180,y:138,w:960,h:215},asset);
 assert(placed.x<source.x);assert(placed.w>1000);assert(placed.x>=0);assert(placed.x+placed.w<=1600);
});
