import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {Resvg} from '@resvg/resvg-js';
import {visualPreview,hasSavedPreview} from '../public/visual-ui.js';
import {captureReusableResults,downstreamReuseState,reuseDownstream} from '../lib/downstream-reuse.mjs';
import {pageDesignStamp,validatePageDesign,renderPageDesign} from '../lib/page-design.mjs';
import {pageStamp,fullPageCurrent} from '../lib/visual-model.mjs';
import {initialElements} from '../lib/elements.mjs';

function project(){
  const p={id:crypto.randomUUID(),brief:{title:'隔离预览测试',cover:false,progress:false,pages:1},version:1,stage:5,approvals:{content:1,requirements:1},materials:[],slides:[{kind:'content',title:'完整内容',body:['准确正文'],sources:[],sourceLinks:[]}],concepts:[{id:'a',mode:'ai',style:'简约平面',representatives:[]}],selectedTheme:'a',visualMode:'ai',events:[],pageDesigns:{},visualPages:{}};
  const nodes=initialElements(p.slides[0]),plan=validatePageDesign({purpose:'说明',conclusion:'完整内容',logic:'并列不加箭头',layoutIntent:'常规布局便于短文阅读',style:'灰白配色',readingOrder:nodes.map(n=>n.id),nodes:nodes.map(n=>({id:n.id,position:'中部',relativeSize:'适中',alignment:'左对齐',carrier:'无框',relation:'从属于页面标题'})),differences:'清楚',missingMaterials:[]},nodes);
  const stamp=pageDesignStamp(p,0);p.pageDesigns[0]={plan,markdown:renderPageDesign(p,0,plan),draftStamp:stamp,layoutStamp:stamp,approvedAt:'confirmed',layoutApprovedAt:'confirmed'};
  p.visualPages[0]={index:0,theme:'a',file:'visual/preview.png',previewHash:'original',stamp:pageStamp(p,0),images:[]};return p;
}

test('规范变化也可显式复用，保留快照后新生成的最新图片，不回退旧图',()=>{
  const p=project();captureReusableResults(p);p.reuseCheckpoint.acceptedInputs=p.reuseCheckpoint.inputs;
  p.visualPages[0].file='visual/latest.png';p.visualPages[0].previewHash='latest';
  p.pageDesigns[0].draftStamp='previous-library';p.visualPages[0].stamp='previous-library';
  assert.equal(downstreamReuseState(p).pending,true);
  const result=reuseDownstream(p);assert.equal(result.previews,1);assert.equal(p.visualPages[0].file,'visual/latest.png');assert.equal(p.visualPages[0].previewHash,'latest');
  assert.equal(fullPageCurrent(p,0),true);assert.equal(downstreamReuseState(p).pending,false);assert.equal(p.approvals.preview,null);
});

test('刷新和服务重载仍能查看已保存的过期预览，不能由查看绕过确认与导出',{timeout:30000},async t=>{
  const p=project(),data=fs.mkdtempSync(path.resolve('work/saved-preview-')),root=path.join(data,p.id);
  fs.mkdirSync(path.join(root,'visual'),{recursive:true});
  const png=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#f0da50"/></svg>').render().asPng();
  fs.writeFileSync(path.join(root,p.visualPages[0].file),png);p.visualPages[0].previewHash=crypto.createHash('sha256').update(png).digest('hex');
  p.pageDesigns[0].draftStamp='previous-library';p.visualPages[0].stamp='previous-library';fs.writeFileSync(path.join(root,'project.json'),JSON.stringify(p));
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  let app;const stop=async()=>{if(!app||app.exitCode!==null||app.signalCode!==null)return;const closed=new Promise(r=>app.once('exit',r));app.kill();await closed;};t.after(stop);
  const base='http://127.0.0.1:'+port,prefix='/api/projects/'+p.id;
  for(let run=0;run<2;run++){
    app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PPT_AGENT_DATA:data,PORT:String(port),PPT_AGENT_TEST:'1'},stdio:'ignore',windowsHide:true});
    for(let n=0;n<100;n++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,40));}
    for(let refresh=0;refresh<2;refresh++){
      const view=await (await fetch(base+prefix)).json();assert.deepEqual(view.fullPreviewPages,[false]);assert.equal(hasSavedPreview(view,0),true);
      const html=visualPreview(view,(a,b,c)=>[a,b,c].join(''),()=>'',()=>'<span>来源</span>');assert.match(html,/已有预览 · 待同步确认/);assert.match(html,/图片仍可查看/);
      const image=await fetch(base+prefix+'/preview?slide=0');assert.equal(image.headers.get('content-type'),'image/png');assert.equal(image.headers.get('x-preview-status'),'stale');assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
      assert.equal((await fetch(base+prefix+'/download')).status,400);
      assert.equal((await fetch(base+prefix+'/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'approvePreview',confirmAllPages:true,acceptIssues:true})})).status,400);
    }
    await stop();
  }
});
