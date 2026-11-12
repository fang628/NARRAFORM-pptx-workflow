import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const differenceCache=new Map();
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export async function analyzeVisual(env,python,spec,directory,signal){
  fs.mkdirSync(directory,{recursive:true});const input=path.join(directory,'input.json');
  fs.writeFileSync(input,JSON.stringify(spec));
  let cacheKey;
  if(spec.operation==='difference'){
    const hash=crypto.createHash('sha256').update(JSON.stringify(stable(spec)));
    for(const file of [spec.reference,spec.rendered,spec.background,path.join(env.root,'tools','visual_analysis.py')])if(file&&fs.existsSync(file))hash.update(fs.readFileSync(file));
    cacheKey=env.data+'|'+hash.digest('hex');
    const cached=differenceCache.get(cacheKey);
    if(cached&&fs.existsSync(cached.image)){
      signal?.throwIfAborted();
      const image=path.join(directory,'difference.png');if(path.resolve(image)!==path.resolve(cached.image))fs.copyFileSync(cached.image,image);
      fs.writeFileSync(path.join(directory,'analysis.json'),JSON.stringify(cached.result));
      return structuredClone(cached.result);
    }
  }
  try{
    const result=JSON.parse((await env.run(python,[path.join(env.root,'tools','visual_analysis.py'),input,directory],{windowsHide:true,maxBuffer:1000000,timeout:60000,signal})).stdout);
    if(cacheKey&&result.status==='available'){
      differenceCache.set(cacheKey,{result:structuredClone(result),image:path.join(directory,'difference.png')});
      if(differenceCache.size>32)differenceCache.delete(differenceCache.keys().next().value);
    }
    return result;
  }catch(error){
    if(signal?.aborted)throw error;
    const result={status:'unavailable',advisoryOnly:true,error:String(error.stderr||error.message).slice(-1200)};
    fs.writeFileSync(path.join(directory,'analysis.json'),JSON.stringify(result));return result;
  }
}
