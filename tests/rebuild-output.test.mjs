import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startRebuildLive,publishRebuildPage,rebuildLiveCurrent,draftDownloadState,draftReviewReport,publishRebuildAssets,rebuildAssetInventory,rebuildAssetImage,recoverRebuildScenes,liveRebuildComparison} from '../lib/rebuild-output.mjs';
import {visualStamp,digest} from '../lib/visual-model.mjs';
import {rebuildLivePanel,candidateDownloadPanel,rebuildAssetsPanel,visualDelivery} from '../public/visual-ui.js';
import {Resvg} from '@resvg/resvg-js';
import {projectResultKey} from '../public/task-progress.js';

const project=()=>({id:'test',version:1,slides:[],concepts:[],approvals:{preview:1},task:{status:'running'}});

test('素材页完成即发布场景；单页失败仍展示其他页和部分元素，刷新可恢复',t=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'rebuild-scene-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
  const dir=path.join(data,'test','assets');fs.mkdirSync(dir,{recursive:true});
  const bytes=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#eeeeee"/></svg>').render().asPng();fs.writeFileSync(path.join(dir,'bg.png'),bytes);
  const p=project();p.task.status='failed';p.materials=[{id:'bg',file:'bg.png',sha256:digest(bytes)}];
  const env={data,save:()=>{}},background={id:'bg'},elements=[{key:'box',type:'rect',x:100,y:100,w:300,h:200,fill:'EEEE00'}];
  publishRebuildAssets(p,env,0,elements,[],{background,status:'done'});
  assert.equal(p.rebuildLive.pages[0].source,'scene');assert.ok(fs.existsSync(path.join(data,p.id,p.rebuildLive.pages[0].file)));
  publishRebuildAssets(p,env,1,elements,[],{background,status:'partial',issues:['一个素材失败']});p.rebuildAssetPreview.status='partial';
  assert.equal(p.rebuildLive.pages[1].status,'partial');assert.equal(p.candidate,undefined);assert.equal(draftDownloadState(p).available,false);
  delete p.rebuildLive;recoverRebuildScenes(p,env);assert.equal(p.rebuildLive.pages.filter(Boolean).length,2);assert.equal(p.rebuildLive.status,'partial');
  const revision=p.rebuildLive.revision;recoverRebuildScenes(p,env);assert.equal(p.rebuildLive.revision,revision,'刷新不重复渲染已保存场景');
  p.visualPages={0:{file:'assets/bg.png',previewHash:digest(bytes)}};
  assert.ok(liveRebuildComparison(p,env,0).length>100);
});

test('失败后场景仍显示真实来源，有旧候选时优先展示新场景而非旧图',()=>{
  const p={id:'p',version:1,visualMode:'ai',approvals:{preview:1},fullPreviewPages:[true],slides:[{title:'准确标题'}],task:{status:'failed'},rebuildLive:{pages:[{index:0,source:'scene',status:'partial',revision:2,at:'2026-10-19T12:00:00Z'}]},rebuildAssets:[],rebuildUndo:{pages:[]}};
  let html=visualDelivery(p,()=>'',()=>'',()=> '');assert.match(html,/部分元素场景预览/);assert.match(html,/rebuild-live-compare/);assert.doesNotMatch(html,/右侧：实际 PPT 渲染/);
  p.candidate={id:'old',at:'2026-10-19T11:00:00Z',review:{pages:[]}};html=visualDelivery(p,()=>'',()=>'',()=> '');assert.match(html,/rebuild-live-compare/);
});
test('重建过程逐次发布新图片，场景/真实渲染来源明确，刷新键随修改变化',t=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'rebuild-live-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
  let saves=0;const p=project(),env={data,save:()=>saves++};startRebuildLive(p,env);const first=projectResultKey(p);
  publishRebuildPage(p,env,{index:0,round:1,source:'scene',bytes:Buffer.from('scene bytes')});const scene=p.rebuildLive.pages[0],sceneKey=projectResultKey(p);
  assert.notEqual(first,sceneKey);assert.equal(fs.readFileSync(path.join(data,p.id,scene.file),'utf8'),'scene bytes');
  publishRebuildPage(p,env,{index:0,round:1,source:'powerpoint',bytes:Buffer.from('actual bytes')});
  assert.notEqual(projectResultKey(p),sceneKey);assert.notEqual(p.rebuildLive.pages[0].file,scene.file);assert.equal(p.rebuildLive.pages[0].source,'powerpoint');assert.equal(saves,3);
  const preserved=structuredClone(p.rebuildLive.pages);startRebuildLive(p,env);assert.deepEqual(p.rebuildLive.pages,preserved,'开始新一轮构建仍显示已有页面');
  p.version++;assert.equal(rebuildLiveCurrent(p),false);const before=saves;publishRebuildPage(p,env,{index:0,round:2,source:'scene',bytes:Buffer.from('stale')});assert.equal(saves,before);
});
test('最后候选不依赖质量通过可供下载，仍受任务完成、版本和预览确认约束',()=>{
  const p=project();p.candidate={id:'last',version:1,stamp:visualStamp(p),status:'failed',structure:{passed:true},review:{pages:[{passed:false,issues:['readability']}]}};
  assert.equal(draftDownloadState(p).available,false);p.task.status='done';assert.equal(draftDownloadState(p).available,true);
  const report=draftReviewReport(p);assert.equal(report.releasePassed,false);assert.deepEqual(report.pages[0].issues,['readability']);
  p.approvals.preview=null;assert.equal(draftDownloadState(p).available,false);p.approvals.preview=1;p.version++;assert.equal(draftDownloadState(p).available,false);
});
test('05实时视图和下载清楚区分修改中场景与最终待验收文件',()=>{
  const p={id:'p',slides:[{title:'<准确标题>'}],task:{status:'running'},rebuildLive:{id:'run',round:2,pages:[{index:0,round:2,revision:3,source:'scene'}]}};
  const html=rebuildLivePanel(p);assert.match(html,/修改中 · 场景预览/);assert.match(html,/&lt;准确标题&gt;/);assert.match(html,/v=3/);
  p.rebuildLive.pages[0].source='powerpoint';assert.match(rebuildLivePanel(p),/实际 PPT 渲染/);
  p.task.status='done';assert.equal(rebuildLivePanel(p),'');p.candidate={id:'last'};p.candidateDownload={available:true};
  const download=candidateDownloadPanel(p);assert.match(download,/下载 PPTX/);assert(download.includes('type=pptx'));assert(!download.includes('type=pdf'));assert(!download.includes('type=report'));assert(!download.includes('运行 release'));
  p.releaseCurrent=true;assert.match(candidateDownloadPanel(p),/href="\/api\/projects\/p\/download"/);
});

test('重建完成前可查看每页素材、原生图形缩略图，意见字段在执行中仍可展示',t=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'rebuild-assets-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));const p=project(),env={data,save:()=>{}};
  publishRebuildAssets(p,env,0,[{key:'carrier',type:'shape',shape:'roundRect',x:50,y:100,w:500,h:200,fill:'EEEEEE',color:'333333'},{key:'title',type:'text',text:'准确标题',fontFace:'SimSun',size:40,bold:true}],[]);
  const first=rebuildAssetImage(p,env,0,'carrier');assert.equal(rebuildAssetImage(p,env,0,'carrier'),first,'相同元素复用已渲染PNG');
  p.rebuildAssetPreview.pages[0].elements[0].fill='FFCC00';assert.notEqual(rebuildAssetImage(p,env,0,'carrier'),first,'本元素变化后重新渲染');
  const inventory=rebuildAssetInventory(p);assert.equal(inventory[0].elements.length,1);assert.equal(inventory[0].textStyles[0].fontFace,'SimSun');assert(rebuildAssetImage(p,env,0,'carrier').length>100);
  p.rebuildAssets=inventory;p.slides=[{title:'<标题>'}];const html=rebuildAssetsPanel(p);assert.match(html,/建议删除/);assert.match(html,/data-rebuild-asset-instruction="0"/);assert.match(html,/SimSun · 24.0 pt/);assert.match(html,/rebuild-assets-scroll/);assert.match(html,/data-revise-rebuild-assets="0" disabled/);
});
