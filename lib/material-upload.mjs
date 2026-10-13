import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {materialLimits} from '../public/material-images.js';

// Write each chunk before reading the next: large uploads never become a JSON string.
export async function writeMaterialUpload(source,target,{limit=materialLimits.fileBytes}={}){
  const declared=source.headers?.['content-length'];
  if(declared!==undefined&&Number(declared)>limit)throw Error(`单个文件不能超过 ${limit/1_000_000} MB`);
  const handle=await fs.open(target,'wx'),hash=crypto.createHash('sha256');let size=0,head=Buffer.alloc(0),complete=false;
  try{
    const stream=source.iterator?source.iterator({destroyOnReturn:false}):source;
    for await(const chunk of stream){
      size+=chunk.length;if(size>limit)throw Error(`单个文件不能超过 ${limit/1_000_000} MB`);
      if(head.length<16)head=Buffer.concat([head,chunk.subarray(0,16-head.length)]);
      hash.update(chunk);await handle.writeFile(chunk);
    }
    if(!size)throw Error('文件不能为空');
    complete=true;return {size,sha256:hash.digest('hex'),head};
  }finally{await handle.close();if(!complete)await fs.unlink(target).catch(()=>{});}
}
