import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {materialTextLimit,materialText,readingCoversMaterial} from '../public/material-text-policy.js';
import {sourceEvidenceCatalog,bindSources} from '../lib/sources.mjs';
import {materialPanel} from '../public/materials.js';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';

test('理解、证据索引与提示共用12万字符上限，旧的2万字缓存不再算完整读取',()=>{
  assert.equal(materialTextLimit,120000);
  const m={id:'doc',kind:'document',text:'前文。'.repeat(37000)+'尾部可用证据。'+'余文。'.repeat(5000)};
  assert.equal(materialText(m).length,120000);
  const catalog=sourceEvidenceCatalog(m),tail=catalog.find(e=>e.text.includes('尾部可用证据'));
  assert(tail.start>20000);assert.equal(catalog.at(-1).end,120000);
  const slides=[{title:'尾部内容',body:['尾部结论'],sources:['doc'],sourceLinks:[{materialId:'doc',target:'body:0',excerptId:tail.id,quote:'尾部可用证据。'}]}];
  bindSources({materials:[m]},slides,{requireLinks:true});assert(slides[0].sourceLinks[0].location.start>110000);
  assert.equal(readingCoversMaterial({status:'read',coverage:'text',readChars:20000},m),false);
  assert.equal(readingCoversMaterial({status:'read',coverage:'text',readChars:120000},m),true);
  assert.equal(readingCoversMaterial({status:'read',readChars:3},{text:'短文本'}),true);
  assert.equal(readingCoversMaterial({status:'read',coverage:'image'},m),true);
  const html=materialPanel({id:'p',materials:[{...m,name:'材料.txt'}]},()=>'',[],'');assert.match(html,/每份文档前 120,000 字/);assert.doesNotMatch(html,/每份文档前 20,000/);
  const rich={...m,richText:{version:1,structures:[{type:'formula',start:111000,end:111008}]}};assert(sourceEvidenceCatalog(rich).some(e=>e.start===111000&&e.end===111008));
});

test('真实接口读取11万字之后的内容，规划可引用尾部证据，重启后的旧短缓存会重新分析',async t=>{
  let reads=0,tailEntry,materialId,contentPrompt='';
  const mock=http.createServer(async(req,res)=>{
    try{
      const b=await fixtureRequest(req),prompt=b.messages?.at(-1)?.content||'';let reply=fixtureReply(b);
      if(typeof prompt==='string'&&prompt.includes('识别与理解单份材料')){
        reads++;assert.match(prompt,/最多前120000字/);
        const entries=JSON.parse(prompt.split('按证据编号分段）：\n')[1]);tailEntry=entries.find(e=>e.text.includes('尾部可用证据'));assert(tailEntry);
        materialId=prompt.split('材料id：')[1].split('\n')[0];
        reply={choices:[{message:{content:JSON.stringify({category:'报告',summary:'包含尾部依据',keyPoints:['尾部信息'],facts:[{claim:'尾部结论',excerptId:tailEntry.id}],suggestedUse:'正文',questions:[]})}}]};
      }else if(typeof prompt==='string'&&prompt.includes('输出 {slides:')){
        contentPrompt=prompt;
        reply={choices:[{message:{content:JSON.stringify({slides:[{kind:'content',title:'尾部内容',body:['尾部结论'],notes:'',sources:[materialId],sourceLinks:[{materialId,target:'body:0',excerptId:tailEntry.id,quote:'尾部可用证据。'}]}]})}}]};
      }
      res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
    }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=fs.mkdtempSync(path.resolve('work','material-text-limit-')),base='http://127.0.0.1:'+port;
  const start=()=>spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_TEST:'1',PPT_AGENT_DATA:data},stdio:'ignore',windowsHide:true});
  let app=start();t.after(()=>app.kill());
  const ready=async()=>{for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,30));}throw Error('服务未启动');};await ready();
  const call=async(url,body,status=200)=>{const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;};
  let p=await call('/api/projects',{brief:{title:'长文档分析',pages:1,cover:false,toc:false,progress:false}},201);const prefix='/api/projects/'+p.id,act=(action,extra={})=>call(prefix+'/action',{action,...extra});
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'synthetic',key:'fixture'};
  await act('configure',{text:cfg});p=await call(prefix+'/materials',{name:'长材料.txt',base64:Buffer.from('前文。'.repeat(37000)+'尾部可用证据。'+'余文。'.repeat(5000)).toString('base64')});await act('requirements',{brief:p.brief});
  const wait=async()=>{for(let i=0;i<600;i++){p=await call(prefix);if(p.task?.status!=='running'){assert.equal(p.task?.status,'done',p.task?.message);return;}await new Promise(r=>setTimeout(r,30));}throw Error('任务超时');};
  await act('analyzeMaterials');await wait();assert.equal(reads,1);assert.equal(p.analysis.readings[0].readChars,120000);assert(p.analysis.readings[0].facts[0].location.start>110000);
  await act('approveAnalysis');await act('content');await wait();assert(contentPrompt.includes('尾部可用证据'));assert(p.slides[0].sourceLinks.some(l=>l.location?.start>110000));
  const stopped=new Promise(r=>app.once('exit',r));app.kill();await stopped;
  const file=path.join(data,p.id,'project.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  saved.analysisDraft={stamp:saved.analysis.stamp,includeImages:false,reviewNotes:'',readings:saved.analysis.readings.map(r=>({...r,readChars:20000,partial:true}))};fs.writeFileSync(file,JSON.stringify(saved));
  app=start();await ready();p=await call(prefix);assert.equal(p.analysisResumeCount,0);
  await act('configure',{text:cfg});await act('analyzeMaterials');await wait();assert.equal(reads,2,'不能复用只读了前2万字的旧缓存');assert.equal(p.analysis.readings[0].readChars,120000);
});
