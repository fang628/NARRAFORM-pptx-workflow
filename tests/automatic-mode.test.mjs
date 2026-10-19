import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {startAutomaticMode,stopAutomaticMode,interruptAutomaticMode,automaticModePublic,nextAutomaticStep,createAutomaticRunner} from '../lib/automatic-mode.mjs';
import {automaticModePanel,automaticModeButton,automaticViewTab} from '../public/automatic-mode.js';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const project=()=>({id:'test',brief:{title:'自动制作',cover:false,progress:false,pages:4},approvals:{},materials:[],slides:[],concepts:[],pageDesigns:{},version:1});
async function until(check,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await pause(10);}throw Error('状态等待超时');}

test('自动执行去重，运行中退出只停止后续步骤，当前结果保留',async t=>{
  const p=project();let calls=0,release;
  const gate=new Promise(r=>release=r);
  const runner=createAutomaticRunner({save(){},isBusy:()=>false,delay:1,execute:async()=>{calls++;await gate;p.approvals.requirements=1;}});t.after(()=>runner.dispose());
  startAutomaticMode(p);runner.wake(p);runner.wake(p);await until(()=>calls===1);
  stopAutomaticMode(p);release();await pause(40);
  assert.equal(calls,1);assert.equal(p.autoMode.enabled,false);assert.equal(p.approvals.requirements,1);
  assert.equal(p.autoMode.status,'paused');assert.ok(!('attempts' in automaticModePublic(p).autoMode));
});

test('失败不盲目重跑，无进展最多尝试两次；交付哈希验证失败不能标为完成',async t=>{
  for(const kind of ['error','no-progress','delivery']){
    const p=project();let calls=0;startAutomaticMode(p);
    const runner=createAutomaticRunner({save(){},isBusy:()=>false,delay:1,...(kind==='delivery'?{nextStep:()=>({kind:'complete',label:'完成',tab:4}),verifyDelivery(){throw Error('工件哈希不一致');}}:{}),execute:async()=>{calls++;if(kind==='error')throw Error('接口失败');}});t.after(()=>runner.dispose());
    runner.wake(p);await until(()=>!p.autoMode.enabled);
    assert.equal(p.autoMode.status,'failed');assert.equal(calls,kind==='error'?1:kind==='no-progress'?2:0);
  }
});

test('等待任务时不并发推进，重启暂停自动执行；文档先提取原图且不重复提取',async t=>{
  const p=project();let busy=true,calls=0;startAutomaticMode(p);
  const runner=createAutomaticRunner({save(){},isBusy:()=>busy,delay:1,execute:async()=>{calls++;stopAutomaticMode(p);}});t.after(()=>runner.dispose());
  runner.wake(p);await pause(30);assert.equal(calls,0);busy=false;runner.wake(p);await until(()=>calls===1);
  startAutomaticMode(p);interruptAutomaticMode(p);runner.wake(p);await pause(20);assert.equal(calls,1);assert.equal(p.autoMode.status,'interrupted');
  p.materials=[{id:'doc',file:'source.docx',kind:'document'}];assert.equal(nextAutomaticStep(p).request.action,'extractMaterialImages');p.materials[0].imageExtraction={at:'done'};assert.equal(nextAutomaticStep(p).request.action,'requirements');
});

test('界面始终提供退出入口，风格只由用户选择，记录转义且不会反复抢走当前页面',()=>{
  const p={automaticModeEnabled:true,autoMode:{enabled:true,status:'waiting_style',choice:'treatment',tab:2,message:'<script>test</script>',history:[{message:'<img onerror=x>',at:new Date().toISOString()}]}};
  const html=automaticModePanel(p);assert.match(html,/data-auto-treatment="flat"/);assert.match(html,/data-auto-treatment="realistic"/);assert.match(html,/data-automatic-toggle/);assert.doesNotMatch(html,/<script>|<img/);assert.equal(automaticModeButton(p).label,'退出自动模式');
  assert.equal(automaticViewTab({autoMode:{tab:1,status:'running'}},p,1),2);assert.equal(automaticViewTab(p,p,0),0);
});

test('真实HTTP：中途退出、自动材料与内容确认、两次人工风格选择、图生图预览至可下载PPT',{skip:process.platform!=='win32',timeout:180000},async t=>{
  let doc,contentCalls=0,imageCalls=0,hold=true,release,entered;
  const arrived=new Promise(r=>entered=r),gate=new Promise(r=>release=r),requests=[];
  const mock=http.createServer(async(req,res)=>{
    try{
      const body=await fixtureRequest(req),user=body.messages?.at(-1)?.content,prompt=typeof user==='string'?user:user?.[0]?.text||'';requests.push({prompt:body.prompt||prompt,image:!!body.prompt});
      if(prompt.includes('识别与理解单份材料')&&hold){entered();await gate;hold=false;}
      let reply=fixtureReply(body);
      if(prompt.startsWith('根据材料写恰好')){contentCalls++;reply={choices:[{message:{content:JSON.stringify({slides:[0,1,2,3].map(i=>({kind:'content',title:'自动页面'+(i+1),body:['自动化测试依据。'],sources:[doc],sourceLinks:[{materialId:doc,target:'body:0',excerptId:'E0001'}]}))})}}]};}
      if(body.prompt)imageCalls++;
      // Advisory visual failures must remain visible; automatic confirmation is explicit.
      if(prompt.startsWith('检查生图整页成品：')){const value=JSON.parse(reply.choices[0].message.content);value.issues=['合成测试：轻微装饰建议'];value.passed=false;reply.choices[0].message.content=JSON.stringify(value);}
      if(prompt.startsWith('撰写逐页演讲稿。'))reply={choices:[{message:{content:JSON.stringify({opening:'下面说明本页的主要内容。',paragraphs:['依据自动化测试材料，按照已确认的页面规划展开讲述。'],transition:'以上为本页说明。',evidence:[doc]})}}]};
      res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
    }catch(error){res.statusCode=500;res.end(JSON.stringify({error:{message:error.message}}));}
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{release();mock.closeAllConnections();mock.close();});
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=fs.mkdtempSync(path.resolve('work/automatic-mode-')),base='http://127.0.0.1:'+port;
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:data,PPT_AGENT_TEST:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});for(const stream of [app.stdout,app.stderr])stream.on('data',chunk=>fs.appendFileSync(path.join(data,'server.log'),chunk));t.after(()=>app.kill());
  await until(async()=>{try{return (await fetch(base+'/api/health')).ok;}catch{return false;}},10000);
  const call=async(url,body,status=200)=>{let response;try{response=await fetch(base+url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}catch(error){if(body!==undefined||error.cause?.code!=='ECONNRESET')throw error;response=await fetch(base+url);}const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;};
  let p=await call('/api/projects',{brief:project().brief},201);const prefix='/api/projects/'+p.id,act=(action,extra={})=>call(prefix+'/action',{action,...extra});
  p=await call(prefix+'/materials',{name:'依据.txt',base64:Buffer.from('自动化测试依据。').toString('base64')});doc=p.materials[0].id;
  const config={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'synthetic-auto',key:'synthetic-only'};await act('configure',{text:config,image:config});
  await act('setAutomaticMode',{enabled:true});await arrived;
  p=await act('setAutomaticMode',{enabled:false});assert.equal(p.autoMode.enabled,false);assert.equal(p.task.status,'running');release();
  await until(async()=>{p=await call(prefix);return p.task.status!=='running';});await pause(100);assert.equal(contentCalls,0);assert.ok(p.analysis);
  await act('setAutomaticMode',{enabled:true});
  const waitState=async check=>until(async()=>{p=await call(prefix);assert.notEqual(p.autoMode.status,'failed',JSON.stringify({auto:p.autoMode,task:p.task?.message}));return check(p);},120000);
  await waitState(p=>p.autoMode.status==='waiting_style'&&p.autoMode.choice==='treatment');assert.equal(contentCalls,1);assert.equal(imageCalls,0);assert.equal(p.approvals.content,p.version);assert.ok(p.analysis.approvalMethod.mode==='automatic');assert.ok(Object.values(p.pageDesigns).every(d=>d.approvedCurrent&&d.approvalMethod.mode==='automatic'));
  await act('generateThemeAssets',{visualTreatment:'flat'});
  await waitState(p=>p.autoMode.status==='waiting_style'&&p.autoMode.choice==='direction');const waitingCalls=imageCalls;await pause(150);assert.equal(imageCalls,waitingCalls);assert.equal(p.selectedTheme,null);assert.ok(p.themeAssetsReady);assert.ok(p.concepts.every(c=>c.representatives.length>0));
  p=await act('setConcurrency',{limit:2});assert.equal(p.autoMode.enabled,true);
  p=await act('saveContent',{slides:p.slides});assert.equal(p.autoMode.enabled,false);assert.equal(p.autoMode.status,'paused');
  await act('setAutomaticMode',{enabled:true});await waitState(p=>p.autoMode.status==='waiting_style');
  await act('selectTheme',{id:'b'});await waitState(p=>p.autoMode.status==='completed');
  assert.equal(p.selectedTheme,'b');assert.equal(p.autoMode.enabled,false);assert.ok(p.candidateDownload.available);assert.equal(p.candidate.structure.passed,true);assert.equal(p.previewApproval.approvalMethod.mode,'automatic');assert.ok(Object.values(p.visualPages).every(r=>r.manualReview.confirmedVia==='automatic-mode'));
  assert.ok(p.autoMode.history.some(e=>e.action==='generateFullPreview'));assert.ok(p.autoMode.history.some(e=>e.action==='build'));assert.ok(!('attempts' in p.autoMode));
  assert.ok(p.previewApproval.acceptedIssues.length>0,'自动接受问题有明确记录，不将检查失败伪装为通过');
  const download=await fetch(base+prefix+'/candidate-download?candidate='+p.candidate.id+'&type=pptx');assert.equal(download.status,200);assert.ok((await download.arrayBuffer()).byteLength>10000);
  await act('setSpeakerScriptOption',{enabled:true});await act('setAutomaticMode',{enabled:true});await waitState(p=>p.autoMode.status==='completed');
  assert.equal(p.speakerScriptCurrent,true);const pdf=await fetch(base+prefix+'/speaker-script?type=pdf');assert.equal(pdf.status,200);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
});
