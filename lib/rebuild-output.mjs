import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {visualStamp,digest,rebuiltCurrent,nativeSVG} from './visual-model.mjs';
import {Resvg} from '@resvg/resvg-js';
import {rebuildPresentationStamp} from './rebuild-progress.mjs';
import {insertedInstanceManifest,canonicalRebuildSVG} from './rebuild-reuse.mjs';

const pngCache=new Map(),maxCachedBytes=24*1024*1024;let cachedBytes=0;
const pageInventoryCache=new WeakMap();
const svgDisplayHashes=new Map();
function assetDisplayHash(p,material,env){
  if(!material?.sha256)return null;
  if(!material.svg&&!/\.svg$/i.test(material.file||''))return material.sha256;
  if(!env?.data)return material.sha256;
  if(svgDisplayHashes.has(material.sha256))return svgDisplayHashes.get(material.sha256);
  try{
    const root=path.resolve(env.data,p.id,'assets'),file=path.resolve(root,material.file||'');
    if(!file.startsWith(root+path.sep))return material.sha256;
    const bytes=fs.readFileSync(file);
    if(digest(bytes)!==material.sha256)return material.sha256;
    const hash=digest(canonicalRebuildSVG(bytes.toString('utf8')));
    if(svgDisplayHashes.size>=512)svgDisplayHashes.delete(svgDisplayHashes.keys().next().value);
    svgDisplayHashes.set(material.sha256,hash);return hash;
  }catch{return material.sha256;}
}
function cachedPNG(key,render){
  if(pngCache.has(key)){const bytes=pngCache.get(key);pngCache.delete(key);pngCache.set(key,bytes);return bytes;}
  const bytes=render();if(bytes.length>maxCachedBytes)return bytes;
  while(pngCache.size&&(cachedBytes+bytes.length>maxCachedBytes||pngCache.size>=160)){const oldest=pngCache.keys().next().value;cachedBytes-=pngCache.get(oldest).length;pngCache.delete(oldest);}
  pngCache.set(key,bytes);cachedBytes+=bytes.length;return bytes;
}

export function startRebuildLive(p,env){
  const previous=rebuildLiveCurrent(p)?p.rebuildLive:null;
  p.rebuildLive={id:crypto.randomUUID(),version:p.version,stamp:visualStamp(p),revision:(previous?.revision||0)+1,round:0,status:'building',pages:structuredClone(previous?.pages||[]),at:new Date().toISOString()};env.save(p);
}
export function rebuildLiveCurrent(p){return p.rebuildLive?.version===p.version&&p.rebuildLive.stamp===visualStamp(p);}
export function publishRebuildPage(p,env,{index,round,source,bytes,status,elementStamp}){
  if(!rebuildLiveCurrent(p))return;
  const live=p.rebuildLive,revision=++live.revision,file=path.join('rebuild-live',live.id,`page-${index+1}-${revision}.png`),target=path.join(env.data,p.id,file);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
  live.round=round;live.status=source==='powerpoint'?'reviewing':'editing';live.at=new Date().toISOString();
  live.pages[index]={index,round,source,revision,file,sha256:digest(bytes),at:live.at,...(status?{status}:{}),...(elementStamp?{elementStamp}:{})};env.save(p);
}
export function publishRebuildScene(p,env,page,{replace=false}={}){
  if(!page?.background||!page.elements?.length||!env?.data)return false;
  if(!rebuildLiveCurrent(p))startRebuildLive(p,env);
  const previous=p.rebuildLive.pages[page.index];
  if(!replace&&previous?.file&&fs.existsSync(path.join(env.data,p.id,previous.file)))return false;
  const materials=new Map([...(p.materials||[]),...(p.rebuildAssetPreview?.materials||[])].map(m=>[m.id,m]));
  const imageURL=id=>{
    const m=materials.get(id),file=m?path.join(env.data,p.id,'assets',m.file):env.getImage?.(p,id);
    if(!file)throw Error('场景预览缺少素材：'+id);
    const bytes=fs.readFileSync(file);if(m?.sha256&&digest(bytes)!==m.sha256)throw Error('场景预览素材哈希不一致：'+id);
    return 'data:'+(file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':'image/jpeg')+';base64,'+bytes.toString('base64');
  };
  const bytes=new Resvg(nativeSVG(page.elements,imageURL,page.background),{font:{loadSystemFonts:true}}).render().asPng();
  publishRebuildPage(p,env,{index:page.index,round:p.rebuildLive.round||0,source:'scene',status:page.status||'done',elementStamp:digest({elements:page.elements,background:page.background}),bytes});
  return true;
}
export function recoverRebuildScenes(p,env){
  const preview=p.rebuildAssetPreview;
  if(!env||preview?.version!==p.version||preview.stamp!==visualStamp(p))return;
  const liveCurrent=rebuildLiveCurrent(p);
  for(const page of preview.pages||[]){
    if(!page||page.scenePreviewError)continue;
    const live=liveCurrent&&p.rebuildLive.pages[page.index];
    if(live?.file&&fs.existsSync(path.join(env.data,p.id,live.file)))continue;
    try{publishRebuildScene(p,env,page);}catch(error){page.scenePreviewError=error.message;env.save(p);}
  }
  if(p.task?.status!=='running'&&rebuildLiveCurrent(p))p.rebuildLive.status=preview.status==='partial'?'partial':'ready';
}
export function draftDownloadState(p){
  const c=p.candidate,current=!!c&&c.version===p.version&&c.stamp===visualStamp(p)&&p.approvals.preview===p.version&&(!p.rebuildPresentation||c.presentationStamp===rebuildPresentationStamp(p));
  return {available:current&&p.task?.status!=='running',candidateId:current?c.id:null,status:'review-required'};
}
export function draftReviewReport(p){
  const c=p.candidate;
  return {status:'review-required',releasePassed:false,notice:'当前为待验收版本；请核对下列未解决问题与实际渲染结果。',candidateId:c.id,version:c.version,renderer:c.renderer,rendererVersion:c.rendererVersion,structure:c.structure,designStandards:c.designStandards,visualRepair:c.visualRepair||null,pages:c.review.pages,at:new Date().toISOString()};
}
export function publishRebuildAssets(p,env,index,elements,assets,details={}){
  const stamp=visualStamp(p);
  if(p.rebuildAssetPreview?.stamp!==stamp)p.rebuildAssetPreview={stamp,version:p.version,revision:0,pages:[],materials:[],status:'extracting'};
  const preview=p.rebuildAssetPreview;preview.pages[index]={index,elements:structuredClone(elements),...structuredClone(details),instanceManifest:insertedInstanceManifest(elements)};preview.materials=[...new Map([...(preview.materials||[]),...assets].map(m=>[m.id,{...m}])).values()];preview.revision++;
  try{publishRebuildScene(p,env,preview.pages[index],{replace:true});}catch(error){preview.pages[index].scenePreviewError=error.message;}
  env.save(p);
}
export function rebuildAssetPages(p){
  // The server updates updatedAt on every saved mutation. Share validity checks
  // across the many thumbnails requested for one saved project revision.
  const key=JSON.stringify([p.updatedAt,p.version,p.selectedTheme,p.rebuildAssetPreview?.revision,p.rebuildAssetPreview?.status]),cached=pageInventoryCache.get(p);
  if(p.updatedAt&&cached?.key===key)return cached.pages;
  let pages;
  if(['extracting','partial','cancelled'].includes(p.rebuildAssetPreview?.status)&&p.rebuildAssetPreview.version===p.version&&p.rebuildAssetPreview.stamp===visualStamp(p))pages=p.rebuildAssetPreview.pages;
  else if(rebuiltCurrent(p))pages=p.reconstruction.slides;
  else pages=p.rebuildAssetPreview?.version===p.version&&p.rebuildAssetPreview.stamp===visualStamp(p)?p.rebuildAssetPreview.pages:[];
  if(p.updatedAt)pageInventoryCache.set(p,{key,pages});return pages;
}
export function rebuildAssetInventory(p,env){
  const materials=new Map([...(p.materials||[]),...(p.rebuildAssetPreview?.materials||[])].map(m=>[m.id,m]));
  return (rebuildAssetPages(p)||[]).filter(Boolean).map(page=>({index:page.index,status:page.status||'done',issues:page.issues||[],failedElements:page.failedElements||[],elements:page.elements.filter(e=>e.type!=='text').map(e=>({key:e.key,targetStamp:digest(e),type:e.type,implementation:e.implementation||null,artisticText:!!e.artisticText,cutoutMethod:e.cutoutMethod||null,description:e.description||e.key,id:e.id||null,...(e.type==='image'?{assetAppearanceHash:assetDisplayHash(p,materials.get(e.id),env)}:{}),needsAttention:!!e.needsAttention,materialOriginal:e.type==='image'&&!e.implementation})),textStyles:page.elements.filter(e=>e.type==='text').map(e=>({key:e.key,nodeId:e.nodeId,part:e.part,targetStamp:digest(e),text:e.text,fontFace:e.fontFace||'Microsoft YaHei',size:e.size,bold:e.bold,italic:e.italic||false,...(e.outline?{outline:e.outline}:{}),...(e.shadow?{shadow:e.shadow}:{})}))}));
}
export function liveRebuildComparison(p,env,index){
  if(!rebuildLiveCurrent(p))throw Error('当前重建预览已过期');
  const live=p.rebuildLive.pages[index],page=p.visualPages?.[index];if(!live||!page)throw Error('本页重建预览尚未生成');
  const right=fs.readFileSync(path.join(env.data,p.id,live.file));if(digest(right)!==live.sha256)throw Error('本页重建图已变化');
  const left=fs.readFileSync(path.join(env.data,p.id,page.file));if(digest(left)!==page.previewHash)throw Error('批准预览文件已变化');const url=bytes=>'data:image/png;base64,'+bytes.toString('base64');
  return cachedPNG('compare:'+digest([p.id,index,live.sha256,page.previewHash,live.source]),()=>new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="590"><rect width="1920" height="590" fill="#e4e6dd"/><text x="20" y="30" font-size="18" font-family="Microsoft YaHei">批准预览</text><text x="980" y="30" font-size="18" font-family="Microsoft YaHei">${live.source==='powerpoint'?'实际 PowerPoint 渲染':'修改中 · 场景预览'}</text><image href="${url(left)}" x="0" y="50" width="960" height="540"/><image href="${url(right)}" x="960" y="50" width="960" height="540"/></svg>`,{font:{loadSystemFonts:true}}).render().asPng());
}
export function rebuildAssetImage(p,env,index,key){
  const page=rebuildAssetPages(p)?.[index],element=page?.elements.find(e=>e.key===key&&e.type!=='text');if(!element)throw Error('重建素材不存在或已过期');
  const urls=new Map();
  const imageURL=id=>{
    if(urls.has(id))return urls.get(id);
    const m=p.materials.find(m=>m.id===id)||p.rebuildAssetPreview?.materials.find(m=>m.id===id);if(!m)throw Error('素材登记不存在');
    const file=path.join(env.data,p.id,'assets',m.file),bytes=fs.readFileSync(file);if(digest(bytes)!==m.sha256)throw Error('素材文件已变化');const url='data:'+(m.file.endsWith('.svg')?'image/svg+xml':m.file.endsWith('.png')?'image/png':'image/jpeg')+';base64,'+bytes.toString('base64');urls.set(id,url);return url;
  };
  const pad=5,width=element.w+pad*2,height=element.h+pad*2,scale=Math.min(240/width,160/height),markup=nativeSVG([element],imageURL).replace('width="1920" height="1080" viewBox="0 0 1600 900"',`width="${Math.max(1,Math.ceil(width*scale))}" height="${Math.max(1,Math.ceil(height*scale))}" viewBox="${element.x-pad} ${element.y-pad} ${width} ${height}"`);
  return cachedPNG('asset:'+digest([p.id,index,element,element.type==='image'?imageURL(element.id):null]),()=>new Resvg(markup,{font:{loadSystemFonts:false}}).render().asPng());
}
