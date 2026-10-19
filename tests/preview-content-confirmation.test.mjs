import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {Resvg} from '@resvg/resvg-js';
import {pageDesignStamp} from '../lib/page-design.mjs';
import {pageStamp} from '../lib/visual-model.mjs';
import {confirmPreviewForDelivery} from '../public/preview-confirmation.js';

test('真实HTTP：当前预览经显式组合确认进入05，图片与问题记录不变，无模型调用',{timeout:30000},async t=>{
  const data=fs.mkdtempSync(path.resolve('work/preview-confirmation-')),id=crypto.randomUUID(),root=path.join(data,id);fs.mkdirSync(path.join(root,'visual'),{recursive:true});
  const p={id,version:2,stage:5,brief:{title:'已有预览继续',pages:1,cover:false,toc:false,progress:false},slides:[{kind:'content',title:'原有页面',body:['准确正文'],sources:[],sourceLinks:[]}],materials:[],events:[],approvals:{requirements:2,content:null,preview:null},selectedTheme:'a',visualMode:'ai',concepts:[{id:'a',mode:'ai',style:'简洁',representatives:[]}],pageDesigns:{},visualPages:{}};
  const stamp=pageDesignStamp(p,0);p.pageDesigns[0]={draftStamp:stamp,approvedAt:'confirmed',markdown:'保留已有设计'};
  const png=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#eee"/></svg>').render().asPng(),hash=crypto.createHash('sha256').update(png).digest('hex');fs.writeFileSync(path.join(root,'visual/preview.png'),png);p.visualPages[0]={index:0,file:'visual/preview.png',previewHash:hash,stamp:pageStamp(p,0),images:[],previewReview:{status:'needs_revision',issues:['保留的装饰建议']}};fs.writeFileSync(path.join(root,'project.json'),JSON.stringify(p));
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const base='http://127.0.0.1:'+port,app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PPT_AGENT_DATA:data,PORT:String(port),PPT_AGENT_TEST:'1'},windowsHide:true,stdio:'ignore'});t.after(()=>app.kill());
  let current;for(let n=0;n<100;n++){try{const response=await fetch(base+'/api/projects/'+id);if(response.ok){current=await response.json();break;}}catch{}await new Promise(r=>setTimeout(r,40));}assert.ok(current);assert.equal(current.previewApprovalState.ready,true);assert.equal(current.previewApprovalState.contentConfirmed,false);
  const before=structuredClone(current.visualPages),context={projectId:id,stamp:current.previewApprovalState.stamp,confirmContent:true,acceptIssues:true},calls=[];
  await confirmPreviewForDelivery({getProject:()=>current,context,action:async(action,body={})=>{calls.push(action);const response=await fetch(base+'/api/projects/'+id+'/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...body})});current=await response.json();assert.equal(response.status,200,JSON.stringify(current));return current;}});
  assert.equal(current.stage,6);assert.equal(current.approvals.content,2);assert.equal(current.approvals.preview,2);assert.equal(current.version,2);assert.ok(current.previewApproval.acceptedIssues.some(v=>v.includes('保留的装饰建议')));assert.deepEqual(calls,['approveContent','approvePreview']);assert.equal(current.task,undefined);
  assert.equal(current.visualPages[0].file,before[0].file);assert.equal(current.visualPages[0].previewHash,hash);assert.deepEqual(current.visualPages[0].previewReview,before[0].previewReview);assert.deepEqual(Buffer.from(await (await fetch(base+'/api/projects/'+id+'/preview?slide=0')).arrayBuffer()),png);
});
