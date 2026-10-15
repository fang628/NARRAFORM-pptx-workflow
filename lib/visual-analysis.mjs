import fs from 'node:fs';
import path from 'node:path';
export async function analyzeVisual(env,python,spec,directory,signal){
  fs.mkdirSync(directory,{recursive:true});const input=path.join(directory,'input.json');
  fs.writeFileSync(input,JSON.stringify(spec));
  try{
    const result=JSON.parse((await env.run(python,[path.join(env.root,'tools','visual_analysis.py'),input,directory],{windowsHide:true,maxBuffer:1000000,timeout:60000,signal})).stdout);
    return result;
  }catch(error){
    if(signal?.aborted)throw error;
    const result={status:'unavailable',advisoryOnly:true,error:String(error.stderr||error.message).slice(-1200)};
    fs.writeFileSync(path.join(directory,'analysis.json'),JSON.stringify(result));return result;
  }
}
