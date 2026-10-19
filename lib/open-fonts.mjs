import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {availableNativeFonts} from './native-fonts.mjs';

// Immutable upstream revisions and hashes: never download a whole font library.
export {openFontCatalog} from './open-font-catalog.mjs';
import {openFontCatalog} from './open-font-catalog.mjs';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const key=face=>face.replace(/[\s_-]/g,'').toLowerCase();
const url=(font,file)=>`https://raw.githubusercontent.com/google/fonts/${font.revision}/ofl/${font.id}/${file}`;
const locks=new Map();

async function cachedDownload(file,url,expected,maxBytes,fetcher,signal){
  if(fs.existsSync(file)&&hash(fs.readFileSync(file))===expected)return;
  const timeout=AbortSignal.timeout(45000),response=await fetcher(url,{signal:signal?AbortSignal.any([signal,timeout]):timeout,redirect:'error'});
  if(!response.ok)throw Error('字体下载失败（HTTP '+response.status+'），请稍后重试');
  if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();throw Error('字体文件大小异常，未安装');}
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw Error('字体文件大小异常，未安装');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);if(hash(bytes)!==expected)throw Error('字体文件校验未通过，未安装；请重试下载');
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',bytes);fs.renameSync(file+'.tmp',file);
}

export async function registerOpenFont(font,file,{root,run,signal,platform=process.platform}){
  if(platform==='win32'){
    await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'tools/install_open_font.ps1'),'-FontPath',file,'-ExpectedHash',font.sha256],{windowsHide:true,timeout:20000,maxBuffer:100000,signal});
    return;
  }
  const directory=platform==='linux'?path.join(os.homedir(),'.local/share/fonts/narraform'):platform==='darwin'?path.join(os.homedir(),'Library/Fonts'):null;
  if(!directory)throw Error('当前系统不支持自动安装字体');
  fs.mkdirSync(directory,{recursive:true});fs.copyFileSync(file,path.join(directory,'NARRAFORM-'+font.sha256+'.ttf'));
  if(platform==='linux')await run('fc-cache',['-f',directory],{timeout:20000,signal});
}

// Serialize shared font-cache/user-font writes across projects. A failed attempt
// releases the queue and preserves successfully installed families for retry.
export function installOpenFonts(env,{signal,onProgress=()=>{},fetcher=fetch,inventory=availableNativeFonts,install=registerOpenFont,catalog=openFontCatalog}={}){
  const cache=path.resolve(env.data,'font-cache'),previous=locks.get(cache)||Promise.resolve();
  const job=previous.catch(()=>{}).then(async()=>{
    const results=[];
    for(const font of catalog){
      signal?.throwIfAborted();
      try{
        const fonts=await inventory({refresh:true});
        if(fonts.some(f=>key(f)===key(font.family))){results.push({id:font.id,family:font.family,label:font.label,category:font.category,status:'already_installed'});onProgress(font.label+'已可用，跳过下载');continue;}
        onProgress('下载并校验'+font.label);
        const folder=path.join(cache,font.id,font.revision),file=path.join(folder,font.file);
        // Keep OFL with the exact cached font rather than silently discarding it.
        await cachedDownload(path.join(folder,'OFL.txt'),url(font,'OFL.txt'),font.licenseHash,20000,fetcher,signal);
        await cachedDownload(file,url(font,font.file),font.sha256,font.bytes,fetcher,signal);
        signal?.throwIfAborted();onProgress('安装'+font.label+'到当前用户字体目录');
        await install(font,file,{...env,signal});
        const refreshed=await inventory({refresh:true});
        if(!refreshed.some(f=>key(f)===key(font.family)))throw Error('字体已写入，但系统尚未识别；将暂用可用字体，下次重建时自动重试');
        results.push({id:font.id,family:font.family,label:font.label,category:font.category,status:'installed',license:'SIL OFL 1.1',sha256:font.sha256});
      }catch(error){if(signal?.aborted)throw error;results.push({id:font.id,family:font.family,label:font.label,category:font.category,status:'failed',error:error.name==='TimeoutError'?'字体下载超时，请稍后重试':String(error.message).slice(0,500)});onProgress(font.label+'未完成，已保留其他字体');}
    }
    return {status:results.every(f=>f.status!=='failed')?'done':'partial',fonts:results,at:new Date().toISOString()};
  });
  locks.set(cache,job);job.finally(()=>{if(locks.get(cache)===job)locks.delete(cache);}).catch(()=>{});return job;
}
