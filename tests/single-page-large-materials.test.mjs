import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import JSZip from 'jszip';
import {fixtureRequest,fixtureReply} from './visual-fixture.mjs';
import {backgroundUsesForBrief,pageStructurePrompt} from '../lib/page-options.mjs';

test('单页结构只保留对应底图，不额外生成目录与致谢',()=>{
  for(const cover of [false,true]){
    assert.deepEqual(backgroundUsesForBrief({pages:1,cover,toc:true}),[cover?'hero-image':'content-background']);
    assert.match(pageStructurePrompt({pages:1,cover,toc:true,thanks:true}),/不添加目录、章节页、致谢页或第二页/);
  }
});

test('真实服务接收大于旧 JSON 上限的文件，支持 200 份材料与单页完整制作',async t=>{
  let contentKind='content',draws=0;const contentPrompts=[];
  const mock=http.createServer(async(req,res)=>{
    const b=await fixtureRequest(req);if(b.prompt)draws++;
    const user=b.messages?.at(-1)?.content,prompt=typeof user==='string'?user:user?.[0]?.text||'';
    let reply=fixtureReply(b);
    if(prompt.startsWith('根据材料写恰好')){contentPrompts.push(prompt);reply={choices:[{message:{content:JSON.stringify({slides:[{kind:contentKind,title:'分子修饰研究',body:contentKind==='cover'?[]:['研究目标与方法'],sources:[]}]})}}]};}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=path.resolve('work','single-large-'+Date.now()),seedId=crypto.randomUUID();
  const seed={id:seedId,brief:{title:'材料容量测试',pages:1,cover:false,toc:false,thanks:false},materials:[
    ...Array.from({length:199},(_,i)=>({id:'source-'+i,name:'材料'+i+'.txt',file:'source-'+i+'.txt',kind:'document',text:'',size:1})),
    ...Array.from({length:40},(_,i)=>({id:'extracted-'+i,name:'分离图'+i+'.png',file:'extracted-'+i+'.png',kind:'image',extracted:true,size:1}))
  ],slides:[],concepts:[],version:1,stage:0,approvals:{},events:[]};
  fs.mkdirSync(path.join(data,seedId),{recursive:true});fs.writeFileSync(path.join(data,seedId,'project.json'),JSON.stringify(seed));
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:data,PPT_AGENT_TEST:'1'},windowsHide:true,stdio:'ignore'});t.after(()=>app.kill());
  const base='http://127.0.0.1:'+port;for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const res=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),json=await res.json();assert.equal(res.status,status,JSON.stringify(json));return json;};
  const health=await call('/api/health');assert.equal(health.materialLimits.fileBytes,500_000_000);assert.equal(health.materialLimits.count,200);assert.equal(health.materialLimits.extractedImages,1000);assert.equal(health.materialStreaming,true);assert.equal(health.pageLimits.min,1);
  // 25 MB becomes > 30 MB in Base64 JSON; raw bytes must bypass that old body cap.
  const bytes=Buffer.alloc(25_000_000,65),query=new URLSearchParams({name:'大材料.txt',sourcePath:'文件夹/大材料.txt'});
  const uploaded=await fetch(base+'/api/projects/'+seedId+'/materials?'+query,{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes});assert.equal(uploaded.status,200);
  const material=(await uploaded.json()).materials.at(-1);assert.equal(material.size,bytes.length);assert.equal(material.sourcePath,'文件夹/大材料.txt');assert.equal(material.text.length,120000);assert.equal(material.truncated,true);
  assert.equal(material.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));assert.equal(fs.statSync(path.join(data,seedId,'assets',material.file)).size,bytes.length);
  const extra=await fetch(base+'/api/projects/'+seedId+'/materials?name=额外.txt',{method:'POST',headers:{'content-type':'application/octet-stream'},body:'正文'});assert.equal(extra.status,400);assert.match((await extra.json()).error,/200/);
  for(const pages of [0,31])await call('/api/projects',{brief:{title:'不合法',pages}},400);
  for(const cover of [false,true]){
    contentKind=cover?'cover':'content';let p=await call('/api/projects',{brief:{title:'分子修饰研究',purpose:'研究目标与方法',pages:1,cover,toc:true,thanks:true,progress:false}},201);
    assert.equal(p.brief.pages,1);assert.equal(p.brief.toc,false);assert.equal(p.brief.thanks,false);
    const prefix='/api/projects/'+p.id,act=(action,extra={})=>call(prefix+'/action',{action,...extra});
    const wait=async()=>{for(let i=0;i<1500;i++){p=await call(prefix);if(p.task?.status!=='running'){assert.equal(p.task.status,'done',p.task.message);return p;}await new Promise(r=>setTimeout(r,30));}throw Error('任务超时');};
    const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'mock-single',key:'synthetic'};
    await act('configure',{text:cfg,image:cfg});await act('requirements',{brief:p.brief});await act('content');await wait();assert.equal(p.slides.length,1);assert.equal(p.slides[0].kind,contentKind);assert.equal(Object.keys(p.pageDesigns).length,1);
    await act('approvePageDesign',{index:0});await act('approveContent');
    await act('generateThemeAssets');await wait();await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts});await wait();assert.ok(p.themeAssets.directions.every(d=>Object.keys(d.assets).join()===(cover?'hero-image':'content-background')));
    await act('concepts');await wait();assert.equal(p.concepts.length,3);assert.ok(p.concepts.every(c=>c.representatives.length===1));
    p=await act('selectTheme',{id:'a'});assert.deepEqual(p.fullPreviewPages,[true]);const before=draws;
    await act('generateFullPreview');await wait();assert.equal(draws,before,'单页直接复用所选风格预览');
    await act('reviewPreviewPage',{index:0,checked:true});await act('approvePreview');
    if(!cover){
      await act('build');await wait();assert.equal(p.candidate.status,'awaiting_review');assert.equal(p.candidate.structure.slides.length,1);assert.equal(p.reconstruction.slides[0].background.use,'content-background');
      await act('reviewReleasePage',{index:0,checks:{visual:true,content:true,photos:true,editability:true,preview_match:true},notes:'合成响应验证单页交付闸门',acceptDeviations:true});p=await act('release');assert.equal(p.releaseCurrent,true);
      const download=await fetch(base+prefix+'/download');assert.equal(download.status,200);const zip=await JSZip.loadAsync(await download.arrayBuffer());assert.deepEqual(Object.keys(zip.files).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n)),['ppt/slides/slide1.xml']);
    }
  }
  assert.equal(contentPrompts.length,2);assert.ok(contentPrompts.every(p=>p.includes('只生成 1 页独立')));
});
