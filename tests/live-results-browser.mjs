// Controlled local-only AI responses for verifying progressive browser updates.
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fixtureRequest,fixtureReply} from './visual-fixture.mjs';
let releaseContent,releaseDesign;
const contentGate=new Promise(r=>releaseContent=r),designGate=new Promise(r=>releaseDesign=r);
let app;
const mock=http.createServer(async(req,res)=>{
  if(req.url==='/release/content'){releaseContent();res.end('ok');return;}
  if(req.url==='/release/design'){releaseDesign();res.end('ok');return;}
  if(req.url==='/stop'){releaseContent();releaseDesign();res.end('ok');app?.kill();mock.close();setTimeout(()=>process.exit(0),100);return;}
  const b=await fixtureRequest(req),user=b.messages?.at(-1)?.content,prompt=typeof user==='string'?user:user?.[0]?.text||'';let reply;
  if(prompt.startsWith('根据材料写恰好')){
    await contentGate;reply={choices:[{message:{content:JSON.stringify({slides:[1,2].map(n=>({kind:'content',title:'实时同步测试 '+n,body:['AI 已生成第 '+n+' 页内容。'],sources:[]}))})}}]};
  }else{
    if(prompt.startsWith('按照 pptx-workflow')&&JSON.parse(prompt.split('本页：')[1].split('\n')[0]).title.endsWith('2'))await designGate;
    reply=fixtureReply(b);
  }
  res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const reserved=http.createServer();await new Promise(r=>reserved.listen(0,'127.0.0.1',r));const port=reserved.address().port;await new Promise(r=>reserved.close(r));
const base='http://127.0.0.1:'+port,control='http://127.0.0.1:'+mock.address().port;
app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:path.resolve('work','live-browser-'+Date.now()),PPT_AGENT_TEST:'1'},windowsHide:true,stdio:'ignore'});
for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
async function post(url,body){const res=await fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),json=await res.json();if(!res.ok)throw Error(JSON.stringify(json));return json;}
const p=await post('/api/projects',{brief:{title:'同步界面测试',pages:2,cover:false,toc:false,progress:false}}),prefix='/api/projects/'+p.id;
await post(prefix+'/action',{action:'configure',text:{baseURL:control+'/v1',key:'synthetic-local-only',model:'mock'}});
await post(prefix+'/action',{action:'requirements',brief:p.brief});await post(prefix+'/action',{action:'content'});
console.log(JSON.stringify({base,control,projectId:p.id}));
process.on('SIGINT',()=>{app.kill();mock.close();process.exit(0);});
