import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sendFile} from '../lib/file-response.mjs';
import {isAgentLibraryPath} from '../tools/workflow-library-policy.mjs';
import {workflowManifest,workflowFile} from '../lib/workflow-library.mjs';
import {designRulesFor} from '../lib/design-rules.mjs';

test('文件不存在、误传目录或打开失败时返回404，SVG不能执行同源脚本',async t=>{
  const root=fs.mkdtempSync(path.resolve('work/file-response-'));
  const file=path.join(root,'icon.svg');fs.writeFileSync(file,'<svg xmlns="http://www.w3.org/2000/svg"/>');
  const server=http.createServer((req,res)=>sendFile(res,req.url==='/dir'?root:req.url==='/missing'?file+'.missing':file,'image/svg+xml'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base='http://127.0.0.1:'+server.address().port;
  for(const route of ['/dir','/missing'])assert.equal((await fetch(base+route)).status,404);
  const svg=await fetch(base+'/icon');assert.equal(svg.status,200);assert.match(svg.headers.get('content-security-policy'),/sandbox; default-src 'none'/);assert.match(await svg.text(),/<svg/);
  // Deterministically inject the race after stat but before opening the stream.
  const createReadStream=fs.createReadStream;
  fs.createReadStream=(...args)=>createReadStream(args[0]+'.removed',...args.slice(1));
  try{assert.equal((await fetch(base+'/race')).status,404);}
  finally{fs.createReadStream=createReadStream;}
  assert.equal((await fetch(base+'/icon')).status,200);
});

test('分发库只含当前规范与样例，旧状态机和schema不再被同步',()=>{
  for(const entry of workflowManifest.files)assert.ok(isAgentLibraryPath(entry.file),entry.file);
  for(const file of ['SKILL.md','shared/operations.md','shared/schemas/content.schema.json','stages/13-design/assets/layouts.json']){
    assert.equal(isAgentLibraryPath(file),false);assert.equal(workflowFile(file),null);assert.equal(fs.existsSync(path.join('workflow-library',file)),false);
  }
  const rules=designRulesFor({brief:{title:'报告',purpose:'汇报',progress:false},slides:[{kind:'content',title:'发现'}],materials:[]},0);
  assert.doesNotMatch(rules,/严格过半/);assert.match(rules,/不设特殊分块页数配额/);
});

test('PowerPoint渲染跨进程互斥，退出后能再次取得锁',{skip:process.platform!=='win32'},async t=>{
  const script=path.resolve('tools/office_lock.ps1').replaceAll("'","''");
  const options=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command'];
  const holder=spawn('powershell.exe',[...options,`$ErrorActionPreference='Stop'; . '${script}'; $lock=Enter-NarraformOfficeRender 3000; try { [Console]::Out.WriteLine('LOCKED'); [Console]::In.ReadLine() | Out-Null } finally { Exit-NarraformOfficeRender $lock }`],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  t.after(()=>holder.kill());
  await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('锁持有进程启动超时')),10000);holder.on('error',reject);holder.stdout.on('data',data=>{output+=data;if(output.includes('LOCKED')){clearTimeout(timer);resolve();}});});
  const run=promisify(execFile),command=`$ErrorActionPreference='Stop'; . '${script}'; $lock=Enter-NarraformOfficeRender 50; Exit-NarraformOfficeRender $lock`;
  await assert.rejects(run('powershell.exe',[...options,command],{windowsHide:true}),/Command failed/);
  const closed=new Promise(resolve=>holder.once('close',resolve));holder.stdin.end('\n');await closed;
  await run('powershell.exe',[...options,command],{windowsHide:true});
});
