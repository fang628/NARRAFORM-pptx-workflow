import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import JSZip from 'jszip';
import {artifactInventory} from './artifact-storage.mjs';
import {validateSlides} from './scene.mjs';

export const projectPackageLimits={upload:1_000_000_000,file:500_000_000,total:4_000_000_000,files:20000};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const secret=/^(?:\.api-credentials(?:\..*)?|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|project\.tmp|artifact-index\.(?:json|tmp))$/i;
const safeExtensions=new Set(['.json','.png','.jpg','.jpeg','.webp','.gif','.svg','.pdf','.pptx','.docx','.md','.txt','.csv','.xml','.emf','.wmf','.tif','.tiff','.bmp','.bin','.provider','.zip']);
function relativeFile(name){
  if(typeof name!=='string'||!name||name.length>1000||/[\\:\x00-\x1f]/.test(name)||name.startsWith('/')||name.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('工程包包含不安全的文件路径');
  if(name.split('/').some(p=>secret.test(p))||!safeExtensions.has(path.posix.extname(name).toLowerCase()))throw Error('工程包包含密钥、脚本或不支持的文件');
  return name;
}
function cleanRecord(value,{sourceRoot,targetRoot,sourceId,targetId}={}){
  if(typeof value==='string'){
    let text=value;
    if(sourceRoot&&targetRoot){for(const [a,b]of [[sourceRoot,targetRoot],[sourceRoot.replaceAll('\\','/'),targetRoot.replaceAll('\\','/')]])if(text===a||text.startsWith(a+'/')||text.startsWith(a+'\\'))text=b+text.slice(a.length);}
    if(sourceId&&targetId)text=text.replaceAll('/api/projects/'+sourceId+'/', '/api/projects/'+targetId+'/');
    return text;
  }
  if(Array.isArray(value))return value.map(v=>cleanRecord(v,{sourceRoot,targetRoot,sourceId,targetId}));
  if(!value||typeof value!=='object')return value;
  const out={};
  for(const [key,v]of Object.entries(value)){
    if(['__proto__','constructor','prototype','apiKey','api_key','authorization','password','credentials','credentialVault','credentialWarnings'].includes(key))continue;
    if(key==='key'&&(value.baseURL||value.apiBase))continue;
    out[key]=cleanRecord(v,{sourceRoot,targetRoot,sourceId,targetId});
  }
  return out;
}
function portableSnapshot(p){
  const copy=cleanRecord(p);
  delete copy.provider;delete copy.task;delete copy.imageTaskQueue;delete copy.archivedAt;
  if(copy.autoMode)copy.autoMode={...copy.autoMode,enabled:false,status:'paused',message:'工程已迁移，请检查API后继续'};
  return copy;
}
export async function exportProjectPackage(p,data){
  const inventory=artifactInventory(p,data,{persist:false}),root=path.resolve(data,p.id),zip=new JSZip(),files=[];
  const selected=inventory.files.filter(f=>f.category!=='cache'&&f.file!=='project.json'&&!f.file.split('/').some(p=>secret.test(p))&&safeExtensions.has(path.posix.extname(f.file).toLowerCase()));
  if(inventory.blockedLinks.length)throw Error('工程目录存在链接文件，请移除链接后再导出');
  if(inventory.missing.length)throw Error('工程有已登记文件缺失，请先恢复缺失材料再导出');
  let total=0;
  for(const f of selected){
    relativeFile(f.file);total+=f.bytes;
    if(f.bytes>projectPackageLimits.file||total>projectPackageLimits.total||files.length>=projectPackageLimits.files)throw Error('工程超过打包上限（单文件500MB、总计4GB、20000文件）');
    const file=path.join(root,f.file),digest=crypto.createHash('sha256');let bytes=0;
    for await(const chunk of fs.createReadStream(file)){digest.update(chunk);bytes+=chunk.length;}
    if(bytes!==f.bytes)throw Error('工程文件正在变化，请稍后导出');
    files.push({path:f.file,size:bytes,sha256:digest.digest('hex')});
    zip.file('files/'+f.file,Readable.from((async function*(){yield* fs.createReadStream(file);})()),{binary:true});
  }
  const project=portableSnapshot(p),snapshot=JSON.stringify(project),manifest={format:'NARRAFORM-PROJECT',version:1,createdAt:new Date().toISOString(),sourceId:p.id,sourceRoot:root,projectHash:hash(snapshot),files};
  zip.file('manifest.json',JSON.stringify(manifest));zip.file('project.json',snapshot);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'narraform-export-')),file=path.join(temp,'project.narra');
  try{await pipeline(zip.generateNodeStream({streamFiles:true,compression:'DEFLATE',compressionOptions:{level:3}}),fs.createWriteStream(file,{flags:'wx'}));if(fs.statSync(file).size>projectPackageLimits.upload)throw Error('工程包压缩后超过1GB导入上限，请先清理无用文件或拆分项目');return {file,cleanup:()=>{fs.promises.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});}};}
  catch(error){fs.rmSync(temp,{recursive:true,force:true});throw error;}
}
export async function importProjectPackage(file,data){
  const stat=fs.statSync(file);if(stat.size>projectPackageLimits.upload)throw Error('工程包不能超过1GB');
  const zip=await JSZip.loadAsync(fs.readFileSync(file)),entries=Object.values(zip.files).filter(e=>!e.dir);
  if(entries.length>projectPackageLimits.files+2)throw Error('工程包文件过多');
  const names=new Set();let size=0;
  for(const e of entries){
    const original=e.unsafeOriginalName||e.name;
    if(original!==e.name||names.has(original.toLowerCase()))throw Error('工程包路径无效或重名');names.add(original.toLowerCase());
    if(!['manifest.json','project.json'].includes(original)){
      if(!original.startsWith('files/'))throw Error('工程包包含未知条目');relativeFile(original.slice(6));
    }
    if((Number(e.unixPermissions)&0xf000)===0xa000)throw Error('工程包不能包含链接');
    const bytes=e._data?.uncompressedSize??0;size+=bytes;
    if(bytes>projectPackageLimits.file||size>projectPackageLimits.total)throw Error('工程包解压体积超限');
  }
  for(const name of ['manifest.json','project.json'])if(!zip.file(name)||zip.file(name)._data.uncompressedSize>30_000_000)throw Error('缺少有效的工程记录');
  const manifest=JSON.parse(await zip.file('manifest.json').async('string')),snapshot=await zip.file('project.json').async('string');
  if(manifest.format!=='NARRAFORM-PROJECT'||manifest.version!==1||!Array.isArray(manifest.files)||hash(snapshot)!==manifest.projectHash)throw Error('工程包格式、版本或工程记录校验失败');
  const source=JSON.parse(snapshot);if(!/^[a-f0-9-]{36}$/i.test(manifest.sourceId)||typeof manifest.sourceRoot!=='string'||!manifest.sourceRoot||source.id!==manifest.sourceId||!source.brief||!Array.isArray(source.materials)||!Array.isArray(source.slides)||!Array.isArray(source.concepts)||source.materials.length>20000)throw Error('工程记录缺少有效的需求、材料或页面');
  // Imported records are data, not permission to address paths outside the new project.
  function checkPaths(value){
    if(!value||typeof value!=='object')return;
    for(const [key,v]of Object.entries(value)){
      if(typeof v==='string'&&/^(?:file|dir|path|renderFile|sceneFile|previewFile|deck)$/i.test(key)&&v){
        const original=manifest.sourceRoot.replaceAll('\\','/'),raw=v.replaceAll('\\','/'),local=raw.startsWith(original+'/')?raw.slice(original.length+1):raw===original?'':raw;
        if(local&&(local.startsWith('/')||local.split('/').some(p=>p==='..')||/[:\x00-\x1f]/.test(local)))throw Error('工程记录包含项目外文件路径');
      }
      if(typeof v==='object')checkPaths(v);
    }
  }checkPaths(source);
  const planned=new Set();
  for(const f of manifest.files){relativeFile(f.path);if(planned.has(f.path.toLowerCase())||!Number.isSafeInteger(f.size)||f.size<0||f.size>projectPackageLimits.file||!/^[a-f0-9]{64}$/.test(f.sha256)||!zip.file('files/'+f.path)||zip.file('files/'+f.path)._data.uncompressedSize!==f.size)throw Error('工程文件清单无效或缺失');planned.add(f.path.toLowerCase());}
  if(entries.length!==manifest.files.length+2)throw Error('工程包存在未登记文件');
  if(source.slides.length)validateSlides(source.slides,source.brief);
  for(const m of source.materials)if(m.file&&(!planned.has(('assets/'+relativeFile(m.file)).toLowerCase())))throw Error('工程材料文件缺失：'+m.name);
  const id=crypto.randomUUID(),destination=path.resolve(data,id),staging=path.resolve(data,'.import-'+id);
  fs.mkdirSync(staging,{recursive:false});
  try{
    for(const f of manifest.files){
      const bytes=await zip.file('files/'+f.path).async('nodebuffer');if(bytes.length!==f.size||hash(bytes)!==f.sha256)throw Error('工程文件损坏：'+f.path);
      if(f.path.endsWith('.svg')&&/<(?:script|foreignObject)\b|<!DOCTYPE|<!ENTITY|\bon\w+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|javascript:|file:)/i.test(bytes.toString('utf8')))throw Error('工程SVG包含不安全内容：'+f.path);
      const target=path.join(staging,f.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});
    }
    const p=cleanRecord(portableSnapshot(source),{sourceRoot:manifest.sourceRoot,targetRoot:destination,sourceId:source.id,targetId:id});
    p.id=id;p.events=[];p.updatedAt=new Date().toISOString();p.importedFrom={id:source.id,at:p.updatedAt};
    fs.writeFileSync(path.join(staging,'project.json'),JSON.stringify(p,null,2));fs.renameSync(staging,destination);return p;
  }catch(error){if(fs.existsSync(staging)&&path.dirname(staging)===path.resolve(data))fs.rmSync(staging,{recursive:true,force:true});throw error;}
}
