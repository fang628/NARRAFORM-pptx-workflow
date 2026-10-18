import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {visualStamp,digest,rebuiltCurrent,nativeSVG} from './visual-model.mjs';
import {Resvg} from '@resvg/resvg-js';
import {rebuildPresentationStamp} from './rebuild-progress.mjs';

export function startRebuildLive(p,env){
  p.rebuildLive={id:crypto.randomUUID(),version:p.version,stamp:visualStamp(p),revision:0,round:0,status:'building',pages:[],at:new Date().toISOString()};env.save(p);
}
export function rebuildLiveCurrent(p){return p.rebuildLive?.version===p.version&&p.rebuildLive.stamp===visualStamp(p);}
export function publishRebuildPage(p,env,{index,round,source,bytes}){
  if(!rebuildLiveCurrent(p))return;
  const live=p.rebuildLive,revision=++live.revision,file=path.join('rebuild-live',live.id,`page-${index+1}-${revision}.png`),target=path.join(env.data,p.id,file);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
  live.round=round;live.status=source==='powerpoint'?'reviewing':'editing';live.at=new Date().toISOString();
  live.pages[index]={index,round,source,revision,file,sha256:digest(bytes),at:live.at};env.save(p);
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
  const preview=p.rebuildAssetPreview;preview.pages[index]={index,elements:structuredClone(elements),...structuredClone(details)};preview.materials=[...new Map([...(preview.materials||[]),...assets].map(m=>[m.id,{...m}])).values()];preview.revision++;env.save(p);
}
export function rebuildAssetPages(p){
  if(['extracting','partial','cancelled'].includes(p.rebuildAssetPreview?.status)&&p.rebuildAssetPreview.version===p.version&&p.rebuildAssetPreview.stamp===visualStamp(p))return p.rebuildAssetPreview.pages;
  if(rebuiltCurrent(p))return p.reconstruction.slides;
  return p.rebuildAssetPreview?.version===p.version&&p.rebuildAssetPreview.stamp===visualStamp(p)?p.rebuildAssetPreview.pages:[];
}
export function rebuildAssetInventory(p){
  return (rebuildAssetPages(p)||[]).filter(Boolean).map(page=>({index:page.index,status:page.status||'done',issues:page.issues||[],failedElements:page.failedElements||[],elements:page.elements.filter(e=>e.type!=='text').map(e=>({key:e.key,targetStamp:digest(e),type:e.type,implementation:e.implementation||null,description:e.description||e.key,id:e.id||null,needsAttention:!!e.needsAttention,materialOriginal:e.type==='image'&&!e.implementation})),textStyles:page.elements.filter(e=>e.type==='text').map(e=>({key:e.key,targetStamp:digest(e),text:e.text,fontFace:e.fontFace||'Microsoft YaHei',size:e.size,bold:e.bold,italic:e.italic||false,...(e.outline?{outline:e.outline}:{}),...(e.shadow?{shadow:e.shadow}:{})}))}));
}
export function liveRebuildComparison(p,env,index){
  if(!rebuildLiveCurrent(p))throw Error('当前重建预览已过期');
  const live=p.rebuildLive.pages[index],page=p.visualPages?.[index];if(!live||!page)throw Error('本页重建预览尚未生成');
  const right=fs.readFileSync(path.join(env.data,p.id,live.file));if(digest(right)!==live.sha256)throw Error('本页重建图已变化');
  const left=fs.readFileSync(path.join(env.data,p.id,page.file));if(digest(left)!==page.previewHash)throw Error('批准预览文件已变化');const url=bytes=>'data:image/png;base64,'+bytes.toString('base64');
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="590"><rect width="1920" height="590" fill="#e4e6dd"/><text x="20" y="30" font-size="18" font-family="Microsoft YaHei">批准预览</text><text x="980" y="30" font-size="18" font-family="Microsoft YaHei">${live.source==='powerpoint'?'实际 PowerPoint 渲染':'修改中 · 场景预览'}</text><image href="${url(left)}" x="0" y="50" width="960" height="540"/><image href="${url(right)}" x="960" y="50" width="960" height="540"/></svg>`,{font:{loadSystemFonts:true}}).render().asPng();
}
export function rebuildAssetImage(p,env,index,key){
  const page=rebuildAssetPages(p)?.[index],element=page?.elements.find(e=>e.key===key&&e.type!=='text');if(!element)throw Error('重建素材不存在或已过期');
  const imageURL=id=>{
    const m=p.materials.find(m=>m.id===id)||p.rebuildAssetPreview?.materials.find(m=>m.id===id);if(!m)throw Error('素材登记不存在');
    const file=path.join(env.data,p.id,'assets',m.file),bytes=fs.readFileSync(file);if(digest(bytes)!==m.sha256)throw Error('素材文件已变化');return 'data:'+(m.file.endsWith('.svg')?'image/svg+xml':m.file.endsWith('.png')?'image/png':'image/jpeg')+';base64,'+bytes.toString('base64');
  };
  const pad=5,width=element.w+pad*2,height=element.h+pad*2,scale=Math.min(240/width,160/height),markup=nativeSVG([element],imageURL).replace('width="1920" height="1080" viewBox="0 0 1600 900"',`width="${Math.max(1,Math.ceil(width*scale))}" height="${Math.max(1,Math.ceil(height*scale))}" viewBox="${element.x-pad} ${element.y-pad} ${width} ${height}"`);
  return new Resvg(markup,{font:{loadSystemFonts:true}}).render().asPng();
}
