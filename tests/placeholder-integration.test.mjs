import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {Resvg} from '@resvg/resvg-js';
import JSZip from 'jszip';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';
import {buildVisualDeck} from '../lib/visual-build.mjs';
import {slideBackground} from '../lib/slide-background.mjs';
import {validateAudit} from '../lib/visual-model.mjs';

test('真实HTTP接入：三方向与全篇预览精定位后本地贴图，PPTX逐像素复用同一图片坐标',async t=>{
  const boxes=[{x:850,y:170,w:400,h:203},{x:850,y:450,w:220,h:220}],coarse=[{x:842,y:163,w:415,h:218},{x:844,y:443,w:232,h:232}];
  const png=(w,h,body)=>new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1600 900">${body}</svg>`).render().asPng();
  const preview=png(1920,1080,'<rect width="1600" height="900" fill="#333"/>'+boxes.map(b=>`<rect x="${b.x-3}" y="${b.y-3}" width="${b.w+6}" height="${b.h+6}" fill="#111"/><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#ddd"/>`).join(''));
  let imageCalls=0,locateCalls=0,countSequence=null;const imageRequests=[];
  const mock=http.createServer(async(req,res)=>{
    const b=await fixtureRequest(req),content=b.messages?.at(-1)?.content,text=typeof content==='string'?content:content?.[0]?.text||'';
    let reply;
    if(b.prompt){imageCalls++;imageRequests.push(b);if(b.prompt.includes('**内容要求**')){assert.equal((b.prompt.match(/占位框尺寸约 \d+×\d+ px/g)||[]).length,2);assert.match(b.prompt,/1920×1080画布/);assert.doesNotMatch(b.prompt,/比例误差不超过2%/);}reply={data:[{b64_json:preview.toString('base64')}]};}
    else if(text.startsWith('图片计划：')||text.startsWith('定位图片预留区：')){
      if(text.startsWith('定位图片预留区：')){locateCalls++;assert.match(text,/节点身份、所属内容分组和图文位置/);assert.match(text,/不按原图宽高比匹配/);}
      const images=JSON.parse(text.split('登记图片：')[1].split('\n视觉方向：')[0]);
      const rendered=text.startsWith('定位图片预留区：'),count=rendered&&countSequence?.length?countSequence.shift():images.length;
      reply={choices:[{message:{content:JSON.stringify({...(rendered?{placeholderCount:count,countEvidence:'实际可见 '+count+' 个图片预留框'}:{}),images:rendered&&count!==images.length?[]:images.map((im,i)=>({...im,...coarse[i]}))})}}]};
    }else reply=fixtureReply(b);
    res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=fs.mkdtempSync(path.resolve('work','placeholder-http-')),base='http://127.0.0.1:'+port;
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:data},stdio:'ignore',windowsHide:true});t.after(()=>app.kill());
  for(let i=0;i<200;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,25));}
  const call=async(url,body)=>{const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),j=await r.json();assert.ok(r.ok,JSON.stringify(j));return j;};
  let p=await call('/api/projects',{brief:{title:'精定位通路验证',pages:1,cover:false,toc:false,progress:false}}),prefix='/api/projects/'+p.id;
  const act=(action,b={})=>call(prefix+'/action',{action,...b}),wait=async()=>{for(let i=0;i<1600;i++){p=await call(prefix);if(p.task.status!=='running'){assert.equal(p.task.status,'done',p.task.message);return;}await new Promise(r=>setTimeout(r,30));}throw Error('任务超时');};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic-only',model:'fixture'};await act('configure',{text:cfg,image:cfg});
  for(const [w,h,color] of [[600,300,'#ce3355'],[300,300,'#3366cc']])p=await call(prefix+'/materials',{name:`original-${w}.png`,base64:png(w,h,`<rect width="1600" height="900" fill="${color}"/>`).toString('base64')});
  const originals=p.materials.map(m=>m.id);await act('requirements',{brief:p.brief});await act('analyzeMaterials',{includeImages:true});await wait();await act('approveAnalysis');
  await act('saveContent',{slides:[{kind:'content',title:'精定位验证',body:[],sources:[],elements:[{id:'title',type:'text',role:'title',text:'精定位验证',label:'标题',parentId:null},...originals.map((materialId,i)=>({id:'image-'+i,type:'image',label:'配图'+i,materialId,parentId:'title'}))]}],confirm:true});
  await act('generateThemeAssets');await wait();await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts});await wait();
  await act('confirmPageLayout',{index:0});await act('designPage',{index:0});await wait();await act('approvePageDesign',{index:0});await act('concepts');await wait();
  for(const direction of p.concepts){const page=direction.representatives[0];assert.equal(page.placeholderLocalization.refined,2);assert.equal(page.placeholderReview.attempts,0);assert.equal(page.placeholderReview.status,'passed');
    page.images.forEach((im,i)=>{assert.equal(im.id,originals[i]);for(const k of ['x','y','w','h'])assert.ok(Math.abs(im[k]-boxes[i][k])<1.5,`${direction.id}/${i}/${k}`);assert.ok(im.placeholderBox);});
    const ledger=JSON.parse(fs.readFileSync(path.join(data,p.id,page.jobFile),'utf8'));assert.equal(ledger.placeholderLocalization.refined,2);assert.equal(ledger.record.placeholderLocalization.refined,2);
  }
  assert.ok(locateCalls>=3);const before=imageCalls;await act('selectTheme',{id:'a'});await act('generateFullPreview');await wait();assert.equal(imageCalls,before,'已生成代表页直接复用精定位结果');
  const page=p.visualPages[0],text={key:'title',type:'text',nodeId:'title',text:'精定位验证',x:100,y:100,w:500,h:80,size:40,color:'FFFFFF'};
  const raster=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><image href="data:image/png;base64,'+fs.readFileSync(path.join(data,p.id,page.file)).toString('base64')+'" width="1920" height="1080"/></svg>').render().pixels;
  page.images.forEach((im,i)=>{
    const x=Math.round((im.x+im.w/2)*1.2),y=Math.round((im.y+im.h/2)*1.2),offset=(y*1920+x)*4;
    assert.deepEqual([...raster.slice(offset,offset+4)],i?[51,102,204,255]:[206,51,85,255],'实际成品在精定位框内已贴回对应原图');
    assert.ok(Math.abs(im.w/im.h/(i?1:2)-1)<=.05,'比例调整在5%以内');assert.equal(im.imageFit,'fill');
    if(!i){assert.ok(im.aspectAdjustment>.01);assert.equal(im.h,im.placeholderBox.h,'小幅调整后完全贴合占位框');const edgeY=Math.floor((im.y+im.h-1)*1.2),edge=(edgeY*1920+x)*4;assert.deepEqual([...raster.slice(edge,edge+4)],[206,51,85,255],'占位框内沿也被原图填满，没有等比居中留下的灰边');}
  });
  const audit=validateAudit([text,...page.images.map((e,i)=>({...e,type:'image',key:'image-'+i,x:e.x+.25,y:e.y+.25}))],p.slides[0],page.images,p,0);
  audit.filter(e=>e.type==='image').forEach((e,i)=>{for(const k of ['x','y','w','h'])assert.equal(e[k],page.images[i][k],'审计舍弃模型四舍五入坐标，复用批准的图片坐标');assert.equal(e.imageFit,'fill');assert.equal(e.aspect,page.images[i].aspect);});
  p.reconstruction={slides:[{background:slideBackground(p,0),elements:audit}]};const deck=path.join(data,'verified.pptx');
  await buildVisualDeck(p,deck,(_,id)=>path.join(data,p.id,'assets',p.materials.find(m=>m.id===id).file));
  const zip=await JSZip.loadAsync(fs.readFileSync(deck)),xml=await zip.file('ppt/slides/slide1.xml').async('string');
  for(const [i,im] of page.images.entries()){
    const pic=(xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g)||[]).find(v=>v.includes(`name="image-${i}"`));assert.ok(pic);
    const off=pic.match(/<a:off x="(\d+)" y="(\d+)"/),ext=pic.match(/<a:ext cx="(\d+)" cy="(\d+)"/);
    [im.x,im.y,im.w,im.h].forEach((v,k)=>assert.ok(Math.abs(Number([off[1],off[2],ext[1],ext[2]][k])-v/120*914400)<=1,'PPTX坐标与预览一致，误差不超过1 EMU'));
  }
  for(const actual of [1,3]){
    countSequence=[actual,2];const before=imageRequests.length;
    await act('generateFullPreview',{index:0});await wait();
    const regenerated=p.visualPages[0],draws=imageRequests.slice(before);
    assert.equal(draws.length,2,'数量错误只需一次重生成');
    assert.equal(draws[1].prompt,draws[0].prompt,'严格复用实际发送的原提示词，不附加数量修正或旧图');
    assert.deepEqual(draws[1].referenceImages,draws[0].referenceImages,'沿用初次参考底图，不使用数量错误的生成图');
    assert.equal(regenerated.generationAttempts[1].retryReason,'placeholder-count');
    assert.equal(regenerated.placeholderReview.countAttempts,1);
    assert.equal(regenerated.placeholderReview.countReport.passed,true);
    assert.equal(regenerated.placeholderReview.history[0].countReport.observed,actual);
    assert.equal(regenerated.images.length,2);assert.equal(regenerated.placeholderReview.status,'passed');
    const ledger=JSON.parse(fs.readFileSync(path.join(data,p.id,regenerated.jobFile),'utf8'));
    assert.equal(ledger.generationAttempts[0].placeholderCount.passed,false);
    assert.equal(ledger.generationAttempts[1].placeholderCount.passed,true);
  }
  countSequence=[3,3,3];const beforeExhausted=imageRequests.length;
  await act('generateFullPreview',{index:0});await wait();
  const exhausted=p.visualPages[0],draws=imageRequests.slice(beforeExhausted);
  assert.equal(draws.length,3);assert.ok(draws.every(r=>r.prompt===draws[0].prompt));
  assert.equal(exhausted.placeholderReview.status,'count_exhausted');assert.equal(exhausted.placeholderReview.countAttempts,2);
  assert.equal(exhausted.images.length,0,'数量持续错误时不猜测位置贴图');
  assert.equal(exhausted.previewReview.status,'needs_revision');assert.ok(exhausted.previewReview.issues.some(v=>v.includes('占位框数量')));
  assert.ok(fs.existsSync(path.join(data,p.id,exhausted.file)),'最后生成结果仍可查看和选用');

});
