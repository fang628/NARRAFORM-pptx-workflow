import crypto from 'node:crypto';
import {scene,themes} from './scene.mjs';
import {initialElements} from './elements.mjs';
import {reportTask} from './task-progress.mjs';

const version='content-check-2026-10-12-v1';
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
function stamp(p,index){return crypto.createHash('sha256').update(JSON.stringify(stable({version,slide:p.slides[index],brief:p.brief}))).digest('hex');}
export function contentCheckState(p,index){const c=p.contentChecks?.[index];return c?.stamp===stamp(p,index)?c:null;}

// This is a content-stage estimate, not an approval of the final rendered page.
// The native fallback stacks a semantic tree; AI designs can use other layouts.
export function checkContentPages(p,{indices=p.slides.map((s,i)=>i),signal}={}){
  p.contentChecks||={};let complex=0;
  for(const index of indices){
    const slide=p.slides[index],nodes=initialElements(slide);let nativeEstimate='fits';
    try{for(const theme of themes)scene(slide,theme,index,p.slides.length,p.brief);}
    catch(error){if(error.code!=='NATIVE_LAYOUT_CAPACITY')throw error;nativeEstimate='needs-layout';complex++;}
    const warnings=nativeEstimate==='needs-layout'?['本页内容结构较复杂，设计稿需优化图文分区与空间分配；可读性在本页实际预览生成结束时检查。']:[];
    p.contentChecks[index]={stage:'content',version,stamp:stamp(p,index),checkedAt:new Date().toISOString(),structure:'validated',nativeEstimate,warnings,metrics:{nodes:nodes.length,textCharacters:nodes.reduce((n,e)=>n+(e.type==='text'?e.text.length:e.type==='group'?e.label.length:0),0),images:nodes.filter(n=>n.type==='image'&&n.materialId).length}};
  }
  for(const key of Object.keys(p.contentChecks))if(!p.slides[Number(key)])delete p.contentChecks[key];
  if(signal)reportTask(signal,{kind:'step',message:`${indices.length} 页内容结构与来源检查已完成${complex?`；${complex} 页由设计稿优化分区，保留全部文字与配图`:''}；实际可读性在预览生成结束时检查`});
  return {pages:indices.length,complex};
}

export function contentLayoutAdvice(p,index){
  const c=contentCheckState(p,index);if(c?.nativeEstimate!=='needs-layout')return '';
  return '本页内容结束检查：内容与来源已校验，多层/多图结构超出固定纵向模板的承载估计，不代表实际 PPT 放不下。请在当前设计稿优化分区、图文并排、相对大小和阅读顺序，保留内容树语义、准确文字、证据条件与全部登记配图。不把内容树直接纵向堆叠成画面，不靠缩小字号解决；实际可读性在该页预览生成结束时检查。';
}
