import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Resvg} from '@resvg/resvg-js';
import {optimizeTextLayout} from '../lib/text-layout.mjs';
import {analyzeVisual} from '../lib/visual-analysis.mjs';
import {visualDiagnosticsPanel} from '../public/visual-ui.js';
fs.mkdirSync(path.resolve('work'),{recursive:true});

const text={key:'text',type:'text',nodeId:'n',text:'准确文案',x:100,y:100,w:200,h:40,size:30,fontFace:'Microsoft YaHei'};
test('文字实测优先扩框，保持文案、字体、原图与其他对象',()=>{
  const original=[text,{key:'image',type:'image',x:900,y:200,w:300,h:200,id:'original'}];
  const r=optimizeTextLayout(original,[{key:'text',boundWidth:190,boundHeight:49,fontSize:30}]);
  assert.equal(r.changes.length,1);assert.equal(r.elements[0].h,51);assert.equal(r.elements[0].size,30);
  assert.equal(r.elements[0].text,text.text);assert.equal(r.elements[0].fontFace,text.fontFace);
  assert.deepEqual(r.elements[1],original[1]);assert.equal(original[0].h,40);
});
test('排版无安全解时不侵入相邻文字，不无限缩字，并尊重修改范围',()=>{
  const near={...text,key:'near',y:141};
  const r=optimizeTextLayout([text,near],[{key:'text',boundWidth:190,boundHeight:90,fontSize:30}]);
  assert.equal(r.changes.length,0);assert.equal(r.issues.length,1);
  const scoped=optimizeTextLayout([text],[{key:'text',boundWidth:190,boundHeight:49,fontSize:30}],{targetKeys:[]});
  assert.equal(scoped.changes.length,0);
  assert.equal(optimizeTextLayout([text],[{key:'text',boundWidth:NaN,boundHeight:49}]).changes.length,0);
});
test('必要时小幅缩字，但不低于设定字号下限',()=>{
  const neighbor={...text,key:'neighbor',y:142.1};
  const r=optimizeTextLayout([text,neighbor],[{key:'text',boundWidth:180,boundHeight:43,fontSize:30}]);
  assert.equal(r.changes.length,1);assert.ok(r.elements[0].size>=27.6-1e-9);assert.ok(r.elements[0].size<30);
  assert.ok(r.elements[0].y+r.elements[0].h<=neighbor.y);assert.deepEqual(r.elements[1],neighbor);
});
test('本地视觉分析失败显式降级，取消则立即传播',async()=>{
  const dir=fs.mkdtempSync(path.resolve('work','analysis-fallback-'));
  const env={root:process.cwd(),run:async()=>{throw Error('missing optional runtime');}};
  assert.equal((await analyzeVisual(env,'python',{operation:'geometry'},dir)).status,'unavailable');
  const controller=new AbortController();controller.abort();
  await assert.rejects(analyzeVisual(env,'python',{},dir,controller.signal));
});
test('真实像素几何提取、SSIM、边缘距离及背景遮罩',()=>{
  const dir=fs.mkdtempSync(path.resolve('work','visual-analysis-'));
  const png=(file,body)=>{const p=path.join(dir,file);fs.writeFileSync(p,new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#e8e6de"/>${body}</svg>`).render().asPng());return p;};
  const background=png('base.png',''),reference=png('ref.png','<rect x="100" y="200" width="300" height="120" fill="#ffdc35"/><ellipse cx="900" cy="400" rx="100" ry="70" fill="#555555"/>');
  const moved=png('moved.png','<rect x="170" y="200" width="300" height="120" fill="#ffdc35"/><ellipse cx="900" cy="400" rx="100" ry="70" fill="#555555"/>');
  const run=(name,spec)=>{
    const input=path.join(dir,name+'.json');fs.writeFileSync(input,JSON.stringify(spec));
    return JSON.parse(execFileSync(path.resolve('.venv/Scripts/python.exe'),['tools/visual_analysis.py',input,path.join(dir,name)],{windowsHide:true,encoding:'utf8'}));
  };
  const g=run('geometry',{operation:'geometry',reference,background});
  assert.ok(g.candidates.some(c=>c.type==='rect'&&Math.abs(c.x-100)<3&&Math.abs(c.w-300)<3));
  assert.ok(g.candidates.some(c=>c.type==='ellipse'));
  const masked=run('protected',{operation:'geometry',reference,background,exclude:[{x:90,y:190,w:330,h:150}]});
  assert.ok(!masked.candidates.some(c=>c.type==='rect'));
  const elements=[{key:'rect',type:'rect',x:90,y:190,w:400,h:150},{key:'ellipse',type:'ellipse',x:790,y:320,w:220,h:160}];
  const same=run('same',{operation:'difference',reference,rendered:reference,background,elements});
  assert.equal(same.global.ssim,1);assert.equal(same.global.edgeDistance,0);
  const changed=run('changed',{operation:'difference',reference,rendered:moved,background,elements});
  assert.ok(changed.global.ssim<.95);assert.ok(changed.global.edgeDistance>0);
  assert.ok(changed.regions.find(r=>r.key==='rect').ssim<changed.regions.find(r=>r.key==='ellipse').ssim);
  assert.ok(changed.hotspots.length>0);assert.ok(fs.existsSync(path.join(dir,'changed','difference.png')));
  const blank=run('blank',{operation:'difference',reference:background,rendered:background,background});
  assert.equal(blank.global.ssim,1);assert.equal(blank.global.samples,0);
  const excluded=run('excluded',{operation:'difference',reference,rendered:moved,background,elements,exclude:[{x:70,y:170,w:430,h:190}]});
  assert.equal(excluded.global.ssim,1);
});
test('05热力图按页收起展示，明确辅助性质，不影响下载',()=>{
  const p={id:'p',candidate:{id:'c',review:{pages:[{diagnostics:{status:'available',global:{ssim:.6,edgeDistance:4},textLayout:{measured:2}}}]}}};
  const html=visualDiagnosticsPanel(p,0);
  assert.match(html,/<details/);assert.match(html,/kind=difference/);assert.match(html,/仅辅助定位/);assert.doesNotMatch(html,/<details[^>]* open/);
});
