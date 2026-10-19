import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {spawn} from 'node:child_process';
import JSZip from 'jszip';
import {Resvg} from '@resvg/resvg-js';
import {slideBackground} from '../lib/slide-background.mjs';
import {previewFoundationReference} from '../lib/preview-foundation.mjs';
import {themeAssetsStamp} from '../lib/theme-assets.mjs';
import {pageStamp,fullPageCurrent,digest} from '../lib/visual-model.mjs';
import {pageDesignStamp,renderPageDesign,validatePageDesign} from '../lib/page-design.mjs';
import {initialElements} from '../lib/elements.mjs';
import {captureReusableResults,reuseDownstream} from '../lib/downstream-reuse.mjs';
import {buildVisualDeck} from '../lib/visual-build.mjs';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';

function project(){
  const p={id:crypto.randomUUID(),brief:{title:'底图索引恢复',pages:3,cover:true,toc:true,progress:false},materials:[],slides:['cover','toc','content'].map((kind,i)=>({kind,title:'标题'+i,body:['正文'+i],sources:[],sourceLinks:[]})),version:1,approvals:{requirements:1,content:1,preview:1},stage:6,visualMode:'ai',selectedTheme:'a',concepts:[{id:'a',style:'平面配色',representatives:[]}],pageDesigns:{},visualPages:{},events:[],themeAssets:{directions:[]}};
  const uses=['hero-image','toc-image','content-background'];
  for(let i=0;i<3;i++){
    const id='base-'+i,sha256='hash-'+i;
    p.materials.push({id,file:id+'.png',kind:'image',generated:true,purpose:'workflow-background',styleId:'a',intendedUse:uses[i],sha256});
    const nodes=initialElements(p.slides[i]);
    const plan=validatePageDesign({purpose:'说明',conclusion:'标题',logic:'并列',layoutIntent:'上下排版',style:'灰底',readingOrder:nodes.map(n=>n.id),nodes:nodes.map(n=>({id:n.id,position:'中部',relativeSize:'中等',alignment:'左对齐',carrier:'无框',relation:'附属标题'})),differences:'清晰',missingMaterials:[]},nodes);
    const stamp=pageDesignStamp(p,i);p.pageDesigns[i]={plan,markdown:renderPageDesign(p,i,plan),draftStamp:stamp,layoutStamp:stamp,approvedAt:'confirmed',layoutApprovedAt:'confirmed'};
    p.visualPages[i]={index:i,theme:'a',file:'visual/page-'+i+'.png',previewHash:'preview-'+i,images:[],references:[{materialId:id,sha256,purpose:uses[i]}],manualReview:{previewHash:'preview-'+i,at:'confirmed'}};
  }
  p.themeAssets.stamp=themeAssetsStamp(p);
  for(let i=0;i<3;i++)p.visualPages[i].stamp=pageStamp(p,i);
  return p;
}

test('空底图索引从每页的精确引用恢复，保留预览和确认，不选择较新的同名底图',()=>{
  const p=project(),before=structuredClone(p);
  p.materials.push({...p.materials[2],id:'newer',sha256:'new-hash',createdAt:'2099-01-01'});
  for(let i=0;i<3;i++){assert.equal(slideBackground(p,i).id,'base-'+i);assert.equal(fullPageCurrent(p,i),true);}
  assert.deepEqual(p.visualPages,before.visualPages);assert.deepEqual(p.approvals,before.approvals);assert.deepEqual(p.themeAssets,before.themeAssets);
});

test('占位框修正图不是底图；保留的底图引用仍可还原对应关系',()=>{
  const p=project();p.visualPages[2].reference={file:'ratio-normalized.png',purpose:'placeholder-repair-source',sha256:'repair'};
  p.visualPages[2].references.unshift(p.visualPages[2].reference);
  assert.equal(slideBackground(p,2).id,'base-2');
  p.visualPages[2].generationAttempts=[{references:p.visualPages[2].references}];delete p.visualPages[2].references;
  assert.equal(slideBackground(p,2).id,'base-2');
});

test('后续图片小修改可用保存的foundation，不把整页图或其他用途当底图',()=>{
  const p=project(),page=p.visualPages[1];page.foundation=page.references[0];page.references=[{file:'previous-preview.png',purpose:'edit-source'}];
  assert.equal(slideBackground(p,1).id,'base-1');delete page.foundation;
  assert.equal(previewFoundationReference(p,1),null);assert.throws(()=>slideBackground(p,1),/需要对应/);
  page.references=p.visualPages[0].references;assert.equal(previewFoundationReference(p,1),null);
});

test('篡改哈希、错误方向、素材类型和歧义底图不允许回退猜测',()=>{
  for(const mutate of [p=>p.materials[2].sha256='changed',p=>p.materials[2].styleId='b',p=>p.materials[2].purpose='reconstruction',p=>p.visualPages[2].references.push({materialId:'another',sha256:'another',purpose:'content-background'})]){
    const p=project();mutate(p);assert.throws(()=>slideBackground(p,2),/不一致|多个不同/);
  }
  const p=project();p.visualPages[2].theme='b';assert.throws(()=>slideBackground(p,2),/需要对应/);
});

test('有效当前索引仍参与失效检查，历史引用不能覆盖用户新选底图',()=>{
  const p=project();p.themeAssets.directions=[{id:'a',assets:{'content-background':{materialId:'base-2',normalized:'assets/base-2.png',previewHash:'hash-2'}}}];
  assert.equal(slideBackground(p,2).id,'base-2');assert.equal(fullPageCurrent(p,2),false);
});

test('复用不以空快照覆盖仍存在的底图登记，空当前索引也不覆盖历史登记',()=>{
  const p=project();captureReusableResults(p);
  p.themeAssets={directions:[{id:'a',assets:{'content-background':{materialId:'base-2',normalized:'assets/base-2.png',previewHash:'hash-2'}}}],stamp:'old-policy'};
  p.pageDesigns[0].draftStamp='old-policy';reuseDownstream(p);assert.equal(p.themeAssets.directions[0].assets['content-background'].materialId,'base-2');
  captureReusableResults(p);p.themeAssets={directions:[],stamp:themeAssetsStamp(p)};captureReusableResults(p);
  assert.equal(p.reuseCheckpoint.source.themeAssets.directions.length,1);
});

test('缺失索引的已确认项目可经真实05接口完成三页拆解并组装原生PPT',{timeout:90000},async t=>{
  const p=project(),data=fs.mkdtempSync(path.resolve('work/preview-foundation-')),dir=path.join(data,p.id);fs.mkdirSync(path.join(dir,'assets'),{recursive:true});fs.mkdirSync(path.join(dir,'visual'));
  const hashes=[];
  for(let i=0;i<3;i++){
    const png=new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="${['#eeeeee','#dddddd','#cccccc'][i]}"/></svg>`).render().asPng();
    hashes.push(digest(png));fs.writeFileSync(path.join(dir,'assets',p.materials[i].file),png);fs.writeFileSync(path.join(dir,p.visualPages[i].file),png);p.materials[i].sha256=hashes[i];p.visualPages[i].references[0].sha256=hashes[i];p.visualPages[i].previewHash=hashes[i];p.visualPages[i].manualReview.previewHash=hashes[i];
  }
  fs.writeFileSync(path.join(dir,'project.json'),JSON.stringify(p));
  let audits=0;const mock=http.createServer(async(req,res)=>{try{const body=await fixtureRequest(req),prompt=body.messages?.at(-1)?.content?.[0]?.text||'';if(prompt.startsWith('自由元素审计：')){audits++;assert.equal(body.messages.at(-1).content.length,3,'审计同时收到预览与真正底图');}res.setHeader('content-type','application/json');res.end(JSON.stringify(fixtureReply(body)));}catch(e){res.statusCode=500;res.end(JSON.stringify({error:{message:e.message}}));}});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:data,PPT_AGENT_TEST:'1'},stdio:'ignore',windowsHide:true});t.after(()=>app.kill());
  const base='http://127.0.0.1:'+port,prefix='/api/projects/'+p.id;
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,40));}
  const act=async(action,extra={})=>{const response=await fetch(base+prefix+'/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...extra})}),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic-only',model:'mock'};await act('configure',{text:cfg,image:cfg});await act('reconstructPreview');
  let result;
  for(let i=0;i<1600;i++){result=await(await fetch(base+prefix)).json();if(result.task.status!=='running')break;await new Promise(r=>setTimeout(r,40));}
  assert.equal(result.task.status,'done',result.task.message);assert.equal(audits,3);assert.equal(result.reconstruction.slides.length,3);
  assert.deepEqual(result.reconstruction.slides.map(s=>s.background.id),['base-0','base-1','base-2']);assert.ok(result.reconstruction.slides.every(s=>s.elements.some(e=>e.type==='text')));
  assert.deepEqual(result.fullPreviewPages,[true,true,true]);assert.equal(result.approvals.preview,1);
  const deck=path.join(dir,'rebuilt.pptx');await buildVisualDeck(result,deck,(p,id)=>path.join(dir,'assets',p.materials.find(m=>m.id===id).file));
  const zip=await JSZip.loadAsync(fs.readFileSync(deck));assert.equal(Object.keys(zip.files).filter(f=>/^ppt\/slides\/slide\d+\.xml$/.test(f)).length,3);
  assert.ok((await zip.file('ppt/slides/slide1.xml').async('string')).includes('<p:bg>'));
});
