import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import{execFile}from'node:child_process';import{promisify}from'node:util';
const run=promisify(execFile);
export async function measureStructuralReference({env,project,index,reference,background,exclude=[],signal}){
  const script=path.join(env.root,'tools/structural_edges.py'),hash=crypto.createHash('sha256').update(fs.readFileSync(script)).update(JSON.stringify(exclude));
  for(const file of [reference,background])if(file)hash.update(fs.readFileSync(file));
  const dir=path.join(env.data,project.id,'geometry-records','structural',String(index)+'-'+hash.digest('hex').slice(0,16)),output=path.join(dir,'result.json');
  fs.mkdirSync(dir,{recursive:true});const input=path.join(dir,'input.json');
  fs.writeFileSync(input,JSON.stringify({reference,background,exclude}));
  try{
    let result;if(fs.existsSync(output))result=JSON.parse(fs.readFileSync(output,'utf8'));
    else{const temporary=path.join(dir,'result-'+crypto.randomUUID()+'.json');
      await(env.run||run)(process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),[script,input,temporary],{windowsHide:true,timeout:20000,signal,maxBuffer:1000000});
      result=JSON.parse(fs.readFileSync(temporary,'utf8'));try{fs.renameSync(temporary,output);}catch{fs.rmSync(temporary,{force:true});}}
    return {...result,record:path.relative(path.join(env.data,project.id),output),candidates:[],diagnostics:{method:'visible-structural-edges'}};
  }catch(error){if(signal?.aborted)throw error;return{status:'unavailable',lines:[],panels:[],candidates:[],error:String(error.message).slice(0,160)};}
}
