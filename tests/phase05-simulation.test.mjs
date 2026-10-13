import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import JSZip from 'jszip';
import {Resvg} from '@resvg/resvg-js';
import {canonicalTexts} from '../lib/visual-model.mjs';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';

test('05五页故障模拟：异常样式、文案改写、ID遗漏、节点遗漏、截断JSON → 真PPT渲染 → release与下载',async t=>{
  const attempts=new Map(),requests=[],reviewCounts=new Map(),formatCounts=new Map(),toolModels=[],observedLive=[];
  let persistReviewFailure=false;
  const mock=http.createServer(async(req,res)=>{
    try{
      const body=await fixtureRequest(req),content=body.messages?.at(-1)?.content,prompt=typeof content==='string'?content:content?.[0]?.text||'';requests.push({prompt:body.prompt||prompt,image:!!body.prompt,referenceCount:body.referenceImages?.length||0});
      let reply=fixtureReply(body,{customDirections:true});
      if(body.tools){
        toolModels.push(body.model);
        const first=body.messages.find(m=>m.role==='user')?.content?.[0]?.text||'',page=Number(first.match(/第(\d+)页/)?.[1]),round=Number(first.match(/第(\d+)轮/)?.[1]);
        if(body.messages.some(m=>m.role==='tool'))reply={choices:[{message:{content:'{"done":true,"summary":"已调用原生图形、SVG、生图和抠图工具，等待真实PowerPoint渲染复查"}'}}]};
        else{
          const scene=JSON.parse(first.split('当前场景：')[1].split('\n准确文案与层级：')[0]),commands=[
            ['inspect_page',{}],
            ['apply_page_patch',{edits:scene.elements.filter(e=>e.type==='text'&&e.nodeId!=='title'&&!e.nodeId.startsWith('navigation-')).map(e=>({key:e.key,properties:{size:30,color:'272727'}})),remove:scene.elements.filter(e=>/^(native|vector|generated|cutout)-r/.test(e.key)||(first.includes('用户素材增删意见：删除非事实元素「audit-cutout」')&&e.key==='audit-cutout')).map(e=>e.key),add:[{key:'native-r'+round,type:'shape',shape:'hexagon',x:200,y:650,w:250,h:70,fill:'EEEEEE',color:'BBBBBB',strokeWidth:1},...(first.includes('用户素材增删意见：删除非事实元素「audit-cutout」')?[{key:'feedback-line',type:'line',x:200,y:600,w:250,h:1,color:'555555',strokeWidth:2}]:[])]}],
            ['create_visual_asset',{method:'svg',key:'vector-r'+round,x:700,y:650,w:60,h:60,svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M5 5L55 5L55 55L5 55Z" fill="#eeeeee" stroke="#556677"/></svg>',description:'独立矢量几何'}],
            ['create_visual_asset',{method:'cutout',key:'cutout-r'+round,x:900,y:650,w:80,h:80,sourceBox:{x:700,y:750,w:100,h:80},prompt:'抠取随附局部的独立装饰主体，保持细节，移除背景',description:'AI透明抠图'}],
            ['render_page',{}]
          ];reply={choices:[{message:{content:null,tool_calls:commands.map(([name,args],i)=>({id:`p${page}-r${round}-${i}`,type:'function',function:{name,arguments:JSON.stringify(args)}}))}}]};
        }
      }
      if(body.prompt&&(body.prompt.includes('仅独立非事实视觉元素')||body.prompt.includes('对随附局部装饰用图生图抠图')))reply={data:[{b64_json:new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><circle cx="960" cy="540" r="250" fill="#fff238"/></svg>').render().asPng().toString('base64')}]};
      if(prompt.startsWith('渲染对照验收：')){
        const raw=JSON.parse(reply.choices[0].message.content),texts=JSON.parse(prompt.split('准确文字：')[1].split('\n原生对象清单：')[0]),page=Number(texts.find(e=>e.nodeId==='title').text.slice(0,2)),formatCount=(formatCounts.get(page)||0)+1;formatCounts.set(page,formatCount);
        // Exercise actual HTTP/provider/integration recovery before layout repairs.
        if(page===1&&formatCount<=2){res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:formatCount===1?'只有验收说明，没有JSON':'{"checks":{"visual":true},"notes":"缺少验收字段"}'}}]}));return;}
        const count=(reviewCounts.get(page)||0)+1;reviewCounts.set(page,count);
        if(page>1&&count===1){const keys=page===2?['academic_fill']:page===4?['semantic_layout','readability','academic_fill']:['readability'];for(const key of keys)raw.designChecks[key]=false;raw.designChecks.reason='合成故障：文本承载与排版需要修正';}
        if(page===4&&count===2){raw.designChecks.readability=false;raw.designChecks.reason='合成故障：第一次修正后仍需优化间距';}
        raw.visualAssessment={aesthetics:!(page>1&&count===1),layout:!(page>1&&count===1),previewSimilarity:!(page===4&&count<=2),notes:'合成视觉模型对实际渲染进行流程验证'};
        if(persistReviewFailure&&page===4){raw.designChecks.readability=false;raw.designChecks.reason='合成持续故障：四轮修正后仍判正文间距未达要求';raw.visualAssessment.layout=false;}
        reply.choices[0].message.content=JSON.stringify(raw);
      }
      const initial=prompt.startsWith('自由元素审计：'),correction=prompt.startsWith('修正当前页的元素审计JSON');
      if(initial||correction){
        const raw=JSON.parse(reply.choices[0].message.content),texts=raw.elements.filter(e=>e.type==='text'),page=Number(texts.find(e=>e.nodeId==='title').text.slice(0,2)),count=(attempts.get(page)||0)+1;attempts.set(page,count);
        for(const e of texts){e.fontFace=e.nodeId==='title'?'SimSun':'Microsoft YaHei';e.italic=e.nodeId==='caption';}
        if(page===1)raw.elements.push({key:'audit-cutout',type:'cutout',x:1150,y:700,w:120,h:100,sourceBox:{x:700,y:750,w:120,h:100},prompt:'保留随附局部装饰的轮廓和纹理，移除背景',nonFactual:true});
        if(page===3)raw.elements.unshift({key:'body-carrier',type:'shape',shape:'roundRect',x:80,y:190,w:1000,h:80,fill:'EEEEEE',color:'BBBBBB',strokeWidth:1});
        if(page===1&&initial)texts[0].text='模型自行改写的封面';
        if(page===2)for(const e of texts){e.size=String(e.size)+'px';e.bold=e.bold?'700':'400';e.color='rgb(39,39,39)';}
        if(page===3&&initial)delete texts.find(e=>e.nodeId==='body-0').nodeId;
        if(page===4&&initial)raw.elements=raw.elements.filter(e=>e.nodeId!=='group');
        if(page===5&&count===1){reply.choices[0].message.content='{"elements":[';}
        else{
          if(page===5&&count===2)texts[0].bold='不确定';
          reply.choices[0].message.content=JSON.stringify(raw);
        }
      }
      res.setHeader('content-type','application/json');res.end(JSON.stringify(reply||{choices:[{message:{content:'连接成功'}}]}));
    }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const dir=path.resolve('work','phase05-simulation-'+Date.now()),port=4379,base='http://127.0.0.1:'+port;
  fs.mkdirSync(dir,{recursive:true});const logs=fs.openSync(path.join(dir,'server.log'),'a');
  const app=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:dir},stdio:['ignore',logs,logs],windowsHide:true});t.after(()=>{app.kill();mock.closeAllConnections();mock.close();fs.closeSync(logs);});
  for(let i=0;i<200;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const response=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),json=await response.json();assert.equal(response.status,status,JSON.stringify(json));return json;};
  let project=await call('/api/projects',{brief:{title:'05五页故障模拟',pages:5,cover:true,toc:true,progress:true}},201),prefix='/api/projects/'+project.id;
  const act=(action,extra={},status=200)=>call(prefix+'/action',{action,...extra},status);
  const wait=async()=>{for(let i=0;i<4800;i++){project=await call(prefix);if(project.task.status==='running'&&project.rebuildLive?.pages?.some(Boolean)){const live=project.rebuildLive;if(observedLive.at(-1)?.revision!==live.revision)observedLive.push({revision:live.revision,round:live.round,pages:live.pages.filter(Boolean).map(({index,source,round})=>({index,source,round})),candidate:project.candidate?.status});}if(project.task.status!=='running'){assert.equal(project.task.status,'done',project.task.message);return project;}await new Promise(r=>setTimeout(r,50));}throw Error('模拟任务超时');};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'synthetic-05',key:'synthetic-only-key'};
  await act('setConcurrency',{limit:3});await act('configure',{text:cfg,image:cfg,elementImage:cfg});await act('requirements',{brief:project.brief});
  const png=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#596580"/><circle cx="300" cy="200" r="90" fill="#fff238"/></svg>').render().asPng();
  project=await call(prefix+'/materials',{name:'模拟材料原图.png',base64:png.toString('base64')});const imageId=project.materials[0].id;
  await act('requirements',{brief:project.brief});await act('analyzeMaterials',{includeImages:true});await wait();await act('approveAnalysis');
  const slides=[{kind:'cover',title:'01 封面',body:[],sources:[]},{kind:'toc',title:'02 目录',body:['研究目标','实施过程','研究结论'],sources:[]},{kind:'content',title:'03 精确文字',body:['第一行\n第二行','第一行第二行','保留空格 与 标点。'],sources:[],imageId},
    {kind:'content',title:'04 多层内容',body:[],sources:[],elements:[{id:'title',type:'text',role:'title',text:'04 多层内容',parentId:null},{id:'subtitle',type:'text',role:'subtitle',text:'副标题必须保留',parentId:'title'},{id:'group',type:'group',label:'研究发现',parentId:'title'},{id:'detail',type:'text',role:'body',text:'原文依据与关系必须保留。',parentId:'group'},{id:'photo',type:'image',materialId:imageId,parentId:'group'},{id:'caption',type:'text',role:'caption',text:'图1：登记的原始配图。',parentId:'photo'}]},
    {kind:'content',title:'05 结论',body:['要点一','要点二'],sources:[]}];
  await act('saveContent',{slides});await act('generateThemeAssets');await wait();await act('generateThemeAssets',{confirmed:true,prompts:project.themeAssetPrompts});await wait();await act('approveContent');
  for(let i=0;i<5;i++){await act('confirmPageLayout',{index:i});await act('designPage',{index:i});await wait();await act('approvePageDesign',{index:i});}
  await act('concepts');await wait();await act('selectTheme',{id:'a'});await act('generateFullPreview');await wait();
  assert.deepEqual(project.fullPreviewPages,[true,true,true,true,true]);await act('approvePreview',{confirmAllPages:true,acceptIssues:true,approvalStamp:project.previewApprovalState.stamp});
  const imageRequests=requests.filter(r=>r.image).length,previewHashes=project.slides.map((_,i)=>project.visualPages[i].previewHash);
  await act('build');await wait();assert.equal(project.visualReconstructionCurrent,true);assert.equal(project.candidate.status,'awaiting_review');assert.equal(project.candidate.structure.passed,true);assert.equal(project.candidate.renderer,'Microsoft PowerPoint');
  assert.deepEqual([...attempts.entries()].sort((a,b)=>a[0]-b[0]),[[1,1],[2,1],[3,1],[4,2],[5,3]]);
  assert.equal(requests.filter(r=>r.image).length,imageRequests+6,'初次审计抠图1次；修正工具仅抠图：第一轮4页×1，第二轮1页×1');assert.deepEqual(project.slides.map((_,i)=>project.visualPages[i].previewHash),previewHashes,'不重绘已批准预览');
  assert(requests.some(r=>r.prompt.includes('对随附局部装饰用图生图抠图')&&r.referenceCount===1),'初次重建的抠图真实附带局部参考图');
  assert.equal(project.candidate.visualRepair.rounds,2);assert.equal(project.candidate.visualRepair.status,'passed');assert.deepEqual(project.candidate.visualRepair.history.map(r=>r.failed),[[1,2,3,4],[3],[]]);assert.ok(toolModels.every(m=>m==='synthetic-05'),'工具由主模型调用');
  assert(observedLive.some(s=>s.pages.some(p=>p.source==='scene')),'任务未结束时已展示修改场景');assert(observedLive.some(s=>s.pages.some(p=>p.source==='powerpoint')),'任务未结束时已展示实际PPT渲染');assert(observedLive.some(s=>s.round>=1),'能看到后续修正轮次');
  const livePage=project.rebuildLive.pages[0],liveImage=await fetch(base+prefix+'/rebuild-live-image?index=0&run='+project.rebuildLive.id+'&v='+livePage.revision);assert.equal(liveImage.status,200);assert(Buffer.from(await liveImage.arrayBuffer()).length>100);await call(prefix+'/rebuild-live-image?index=0&run=wrong',undefined,400);
  const firstExport=path.join(dir,project.id,project.candidate.visualRepair.history[0].dir),firstReview=JSON.parse(fs.readFileSync(path.join(firstExport,'qa-review.json'),'utf8'));
  assert.equal(firstReview.pages[0].responseValidation.attempts,2);assert.equal(firstReview.pages[0].responseValidation.records.length,3);assert.equal(firstReview.pages[0].passed,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(firstExport,firstReview.pages[0].responseValidation.records[0]),'utf8')).response,'只有验收说明，没有JSON');
  assert.ok(project.reconstruction.slides[3].elements.some(e=>e.type==='shape'&&e.shape==='hexagon'));assert.ok(project.materials.some(m=>m.origin==='ai-cutout'&&m.alpha.hasTransparency));assert.ok(!project.materials.some(m=>m.origin==='generated-rebuild'),'复杂画面只用图生图抠图，不文生图重画');
  assert.equal(project.reconstruction.slides[3].auditValidation.attempts,1);assert.equal(project.reconstruction.slides[4].auditValidation.attempts,2);
  for(const [i,page] of project.reconstruction.slides.entries()){
    assert.deepEqual(page.elements.filter(e=>e.type==='text').map(e=>({nodeId:e.nodeId,text:e.text})),canonicalTexts(project.slides[i],project,i).map(({nodeId,text})=>({nodeId,text})));
    for(const record of page.auditValidation.records)assert.ok(fs.existsSync(path.join(dir,project.id,record)));
  }
  assert.ok(project.task.jobs.flatMap(j=>j.entries||[]).some(e=>e.message.includes('元素审计自动纠正')),'任务分组保留初始纠正记录，公共进度只展示最近100条');
  await call(prefix+'/download',undefined,400);
  const checks={visual:true,content:true,photos:true,editability:true,preview_match:true};
  for(let i=0;i<5;i++)await act('reviewReleasePage',{index:i,checks,notes:'隔离合成案例：验证五页文字、素材、实际PowerPoint渲染及下载闸门。',acceptDeviations:true});
  project=await act('release');assert.equal(project.releaseCurrent,true);
  const download=await fetch(base+prefix+'/download');assert.equal(download.status,200);const bytes=Buffer.from(await download.arrayBuffer()),zip=await JSZip.loadAsync(bytes);assert.equal(Object.keys(zip.files).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n)).length,5);
  const titlePage=await zip.file('ppt/slides/slide1.xml').async('string');assert.match(titlePage,/typeface="SimSun"/,'识别字体写入可编辑PPT文字');assert.match(titlePage,/sz="2400"/,'40逻辑字号转换为24pt');
  assert.match(await zip.file('ppt/slides/slide3.xml').async('string'),/<a:prstGeom prst="roundRect"/,'独立文本承载形状写入PPT，而非遗漏或烘焙成图');
  const imagePage=await zip.file('ppt/slides/slide4.xml').async('string'),photo=(imagePage.match(/<p:pic>[\s\S]*?<\/p:pic>/g)||[]).find(e=>e.includes('name="image-0"')),photoSize=photo?.match(/<a:ext cx="(\d+)" cy="(\d+)"/);assert.ok(photoSize,'登记图片仍为独立原生图片对象');assert.ok(Math.abs(Number(photoSize[1])/Number(photoSize[2])-1.5)<.00001,'图片维持原图600×400比例，而非占位区域比例');assert.match(imagePage,/<a:prstGeom prst="hexagon"/,'原生图形真实写入PPTX');
  const rasterCheck='from PIL import Image;import sys,json;im=Image.open(sys.argv[1]).convert("RGB");points=[(x,y) for y in range(140,380) for x in range(1320,1800) if (lambda c:c[0]>245 and c[1]>235 and c[2]<100)(im.getpixel((x,y)))];print(json.dumps([max(x for x,y in points)-min(x for x,y in points)+1,max(y for x,y in points)-min(y for x,y in points)+1]))';
  const circle=JSON.parse(execFileSync(path.resolve('.venv/Scripts/python.exe'),['-c',rasterCheck,path.join(dir,project.id,project.candidate.dir,'S04.png')],{encoding:'utf8',windowsHide:true}));assert.ok(Math.abs(circle[0]-circle[1])<=2,'实际PowerPoint渲染中的原图圆形仍为圆形');
  const pdf=await fetch(base+prefix+'/download?type=pdf');assert.equal(pdf.status,200);assert.ok(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).equals(Buffer.from('%PDF-')));
  const report=await call(prefix+'/download?type=release');assert.equal(report.pages.length,5);assert.equal(report.checks.visualComparison,true);
  const releasedEvidence={dir,projectId:project.id,candidateDir:path.join(dir,project.id,project.candidate.dir),attempts:Object.fromEntries(attempts),visualRepair:project.candidate.visualRepair,passed:true,renderer:project.candidate.renderer,at:new Date().toISOString()};
  assert(project.rebuildAssets[0].elements.some(e=>e.key==='audit-cutout'),'展示已拆出的图生图抠图素材');
  const materialThumb=await fetch(base+prefix+'/rebuild-asset-image?index=0&key=audit-cutout');assert.equal(materialThumb.status,200);assert(Buffer.from(await materialThumb.arrayBuffer()).length>100);
  await act('reviseRebuildAssets',{index:0,instruction:'删除非事实元素「audit-cutout」。新增一条连接线。'});await wait();
  assert.equal(project.rebuildAssetFeedback[0].status,'applied');assert.equal(project.candidate.visualRepair.rounds,1);assert(!project.reconstruction.slides[0].elements.some(e=>e.key==='audit-cutout'));assert(project.reconstruction.slides[0].elements.some(e=>e.key==='feedback-line'));assert(!project.rebuildAssets[0].elements.some(e=>e.key==='audit-cutout'));releasedEvidence.assetFeedbackApplied=true;
  persistReviewFailure=true;await act('build');await wait();
  assert.equal(project.candidate.visualRepair.rounds,4);assert.equal(project.candidate.visualRepair.status,'exhausted');assert.equal(project.candidate.status,'failed');assert.equal(project.candidateDownload.available,true);assert.equal(project.releaseCurrent,false);
  assert.equal(project.rebuildLive.status,'done');assert(project.rebuildLive.pages.every(p=>p.source==='powerpoint'&&p.round===4),'保留第四轮实际PPT结果');
  const failedURL=base+prefix+'/candidate-download?candidate='+project.candidate.id;
  const lastPPT=await fetch(failedURL+'&type=pptx');assert.equal(lastPPT.status,200);assert.match(lastPPT.headers.get('content-disposition'),/review-required/);const lastZip=await JSZip.loadAsync(await lastPPT.arrayBuffer());assert(lastZip.file('ppt/slides/slide4.xml'));
  const lastPDF=await fetch(failedURL+'&type=pdf');assert.equal(lastPDF.status,200);assert(Buffer.from(await lastPDF.arrayBuffer()).subarray(0,5).equals(Buffer.from('%PDF-')));
  const failedReport=await (await fetch(failedURL+'&type=report')).json();assert.equal(failedReport.releasePassed,false);assert.equal(failedReport.visualRepair.rounds,4);assert(failedReport.pages[3].issues.some(v=>v.includes('readability')));await call(prefix+'/download',undefined,400);
  releasedEvidence.failedDraft={candidateDir:path.join(dir,project.id,project.candidate.dir),rounds:4,downloaded:true,issues:failedReport.pages[3].issues};
  fs.writeFileSync(path.resolve('work','phase05-simulation-latest.json'),JSON.stringify(releasedEvidence,null,2));
});
