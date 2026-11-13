import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import{execFile}from'node:child_process';import{promisify}from'node:util';
const run=promisify(execFile);
export async function measureTableInk({env,project,index,elements,measurements,rendered,signal}){
  const cells=elements.filter(e=>e.type==='text'&&e.tableAlignment?.version);
  if(!cells.length)return measurements;
  const dir=path.join(env.data,project.id,'geometry-records','table-text',String(index)+'-'+crypto.randomUUID());fs.mkdirSync(dir,{recursive:true});
  const input=path.join(dir,'input.json'),output=path.join(dir,'result.json');fs.writeFileSync(input,JSON.stringify({elements:cells,measurements,rendered}));
  try{
    await(env.run||run)(process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),[path.join(env.root,'tools/table_text_metrics.py'),input,output],{windowsHide:true,signal,timeout:15000,maxBuffer:1000000});
    const byKey=new Map(JSON.parse(fs.readFileSync(output,'utf8')).map(m=>[m.key,m]));
    return measurements.map(m=>byKey.has(m.key)?{...m,...byKey.get(m.key)}:m);
  }catch(error){if(signal?.aborted)throw error;return measurements;}
}
