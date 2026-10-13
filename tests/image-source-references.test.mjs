import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {validateSlides} from '../lib/scene.mjs';
import {validateSourceReferences} from '../lib/source-references.mjs';
import {contentWithEvidence} from '../lib/content-evidence.mjs';
import {fixtureReply} from './visual-fixture.mjs';

const original='真实研究结论。';
const project=()=>({materials:[{id:'doc',kind:'document',name:'论文.txt',text:original},{id:'a',kind:'image',name:'第一张.png'},{id:'b',kind:'image',name:'第二张.png'},{id:'c',kind:'image',name:'未使用.png'},{id:'ai',kind:'image',name:'生成图.png',generated:true}]});
const nodes=()=>[{id:'title',type:'text',role:'title',text:'研究发现',parentId:null},{id:'body',type:'text',role:'body',text:'研究结论',parentId:'title'},{id:'first',type:'image',materialId:'a',parentId:'body'},{id:'second',type:'image',materialId:'b',parentId:'body'}];
const draft=(sourceLinks,extra={})=>({title:'研究发现',body:['研究结论'],elements:nodes(),sources:[],sourceLinks,...extra});
const validate=(p,raw,generated=true)=>{const slides=validateSlides(raw);validateSourceReferences(p,slides,generated);return slides;};

test('多图页面的旧 image 引用按材料 ID 映射各自节点，不全部指向第一张',()=>{
  const s=validate(project(),[draft([{materialId:'a',target:'image',note:'第一张图'},{materialId:'b',target:'image',note:'第二张图'}])],false)[0];
  assert.equal(s.imageId,'a');assert.deepEqual(s.sourceLinks.map(l=>[l.target,l.materialId]),[['element:first','a'],['element:second','b']]);
});

test('生成阶段按实际配图重建来源，去重补齐；人工冲突和未知图片仍拒绝',()=>{
  const p=project(),raw=draft([{materialId:'b',target:'element:first',note:'错误的第二张图说明'},{materialId:'c',target:'element:first',note:'错误的未用图说明'}],{sources:['b','c']});
  assert.throws(()=>validate(p,[raw],false),/第 1 页第 1 条.*实际使用「第一张.png」.*「第二张.png」/);
  const before=structuredClone(raw),s=validate(p,[raw])[0];
  assert.deepEqual(s.elements.map(n=>[n.id,n.materialId,n.parentId]),validateSlides([before])[0].elements.map(n=>[n.id,n.materialId,n.parentId]));
  assert.deepEqual(s.sourceLinks.map(l=>[l.target,l.materialId]),[['element:first','a'],['element:second','b']]);
  assert.ok(!s.sourceLinks.some(l=>/错误/.test(l.note)));assert.deepEqual(s.sources.sort(),['a','b']);
  const validNote=validate(p,[draft([{materialId:'b',target:'element:second',note:'第二张图的正确用途'}])])[0];assert.equal(validNote.sourceLinks[0].note,'第二张图的正确用途');
  const missing=draft([]);missing.elements[2].materialId='not-uploaded';assert.throws(()=>validate(p,[missing]),/无效的配图编号|图片不存在/);
});

test('文档分离原图保留文档位置，OCR 文本引用仍按真实摘录校验',()=>{
  const p=project();Object.assign(p.materials[1],{extracted:true,sourceMaterialId:'doc',sourceMaterialName:'论文.pdf',sourceLocations:[{page:7}],text:'图中文字。',ocrTextApprovedAt:'confirmed'});
  const s=validate(p,[draft([{materialId:'a',target:'element:body',excerptId:'E0001',quote:''}])])[0];
  assert.equal(s.sourceLinks.find(l=>l.target==='element:body').quote,'图中文字。');
  assert.match(s.sourceLinks.find(l=>l.target==='element:first').note,/论文.pdf.*第 7 页/);
  assert.throws(()=>validate(p,[draft([{materialId:'a',target:'element:body',quote:'并不存在的图中文字'}])]),e=>e.code==='SOURCE_EVIDENCE_MISMATCH');
});

test('图片引用去重或移除后，原文自动修正仍更新正确的文字链接',async t=>{
  process.env.PPT_AGENT_TEST='1';t.after(()=>delete process.env.PPT_AGENT_TEST);let calls=0;
  const raw=draft([{materialId:'doc',target:'element:generated',quote:''},{materialId:'b',target:'element:first',note:'错配'},{materialId:'a',target:'element:first',note:'重复'},{materialId:'doc',target:'element:body',quote:'改写过的结论'}]);
  raw.elements.push({id:'generated',type:'image',materialId:'ai',parentId:'title'});
  const mock=http.createServer(async(req,res)=>{
    let bytes='';for await(const c of req)bytes+=c;const prompt=JSON.parse(bytes).messages.at(-1).content;calls++;
    let result={slides:[raw]};
    if(prompt.startsWith('修正逐页内容的来源编号')){
      const refs=JSON.parse(prompt.split('待修引用：')[1].split('\n原文证据目录：')[0]);assert.equal(refs.length,1);assert.equal(refs[0].linkIndex,1);assert.equal(refs[0].target,'element:body');assert.equal(refs[0].text,'研究结论');
      result={references:[{slideIndex:0,linkIndex:1,excerptId:'E0001'}]};
    }
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
  const p=project(),r=await contentWithEvidence({config:{baseURL:`http://127.0.0.1:${mock.address().port}/v1`,key:'synthetic',model:'mock'},system:'JSON',user:'生成内容',project:p,decode:v=>v.slides,validate:s=>validate(p,s),signal:new AbortController().signal});
  assert.equal(calls,2);assert.equal(r.slides[0].sourceLinks.find(l=>l.target==='element:body').quote,original);assert.equal(r.slides[0].sourceLinks.find(l=>l.target==='element:first').materialId,'a');
  assert.ok(!r.slides[0].sourceLinks.some(l=>l.target==='element:generated'));assert.equal(raw.sourceLinks.length,4);assert.equal(raw.sourceLinks[3].quote,'改写过的结论');
});

test('真实接口：多图逐页生成、单页修改、重复保存与冲突拦截',async t=>{
  let doc,photos=[],contentPrompt='',revisePrompt='';
  const resultSlide=i=>{
    const s=draft([{materialId:photos[1],target:'element:first',note:'错误配图'},{materialId:photos[0],target:'element:first',note:'重复记录'},{materialId:doc,target:'element:body',excerptId:'E0001'}],{kind:'content',sources:[doc,...photos]});
    s.elements[0].text='发现'+i;s.elements[2].materialId=photos[0];s.elements[3].materialId=photos[1];return s;
  };
  const mock=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;const request=JSON.parse(raw),prompt=request.messages.at(-1).content;let result;
    if(prompt.startsWith('根据材料写恰好')){contentPrompt=prompt;result={slides:[1,2,3].map(resultSlide)};}
    else if(prompt.startsWith('只修改这一页')){revisePrompt=prompt;result={slide:resultSlide(4)};}
    res.end(JSON.stringify(result?{choices:[{message:{content:JSON.stringify(result)}}]}:fixtureReply(request)));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=path.resolve('work','image-source-api-'+Date.now()),base=`http://127.0.0.1:${port}`,app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:data,PPT_AGENT_TEST:'1'},windowsHide:true,stdio:'ignore'});
  t.after(()=>{app.kill();mock.close();});for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const r=await fetch(base+url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v;};
  let p=await call('/api/projects',{brief:{title:'多图关系回归',pages:3,cover:false}},201);const prefix='/api/projects/'+p.id,act=(action,extra={},status=200)=>call(prefix+'/action',{action,...extra},status);
  const wait=async()=>{for(let i=0;i<400;i++){p=await call(prefix);if(p.task?.status!=='running')return;await new Promise(r=>setTimeout(r,20));}throw Error('任务超时');};
  p=await call(prefix+'/materials',{name:'论文.txt',base64:Buffer.from(original).toString('base64')});doc=p.materials[0].id;
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  for(const name of ['第一张.png','第二张.png']){p=await call(prefix+'/materials',{name,base64:png});photos.push(p.materials.at(-1).id);}
  await act('configure',{text:{baseURL:`http://127.0.0.1:${mock.address().port}/v1`,key:'synthetic',model:'mock'}});await act('requirements',{brief:p.brief});await act('analyzeMaterials');await wait();assert.equal(p.task.status,'done',p.task.message);
  await act('approveAnalysis');await act('content');await wait();assert.equal(p.task.status,'done',p.task.message);assert.match(contentPrompt,/图片来源索引由程序/);
  for(const s of p.slides){assert.equal(s.sourceLinks.length,3);assert.deepEqual(s.sourceLinks.filter(l=>l.target!=='element:body').map(l=>[l.target,l.materialId]),[['element:first',photos[0]],['element:second',photos[1]]]);}
  p=await act('saveContent',{slides:p.slides});p=await act('saveContent',{slides:p.slides});assert.equal(p.slides[0].sourceLinks.length,3);
  await act('revise',{index:1,instruction:'调整文案'});await wait();assert.equal(p.task.status,'done',p.task.message);assert.match(revisePrompt,/图片来源索引由程序/);assert.equal(p.slides[1].title,'发现4');
  const forged=structuredClone(p.slides);forged[1].sourceLinks.find(l=>l.target==='element:first').materialId=photos[1];const error=await act('saveContent',{slides:forged},400);assert.match(error.error,/第 2 页.*配图对应关系/);assert.equal((await call(prefix)).slides[1].sourceLinks.find(l=>l.target==='element:first').materialId,photos[0]);
});
