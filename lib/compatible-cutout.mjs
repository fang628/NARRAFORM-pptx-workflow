import fs from 'node:fs';
import crypto from 'node:crypto';
import {generatedImage} from './provider.mjs';
import {prepareLocalCutout} from './local-cutout.mjs';
import {withLocalCutoutFallback} from './cutout-fallback.mjs';
import {extractionLayerContext} from './overlap-layers.mjs';

export const cutoutCompatibilityVersion=4;
export function chromaCutoutPrompt({artistic=false,textIdentity,description,adjustment,matte={hex:'FF00FF',name:'洋红'}}={}){
  const subject=artistic?'书法字/艺术字“'+String(textIdentity?.text||'')+'”，保留准确文字、全部笔画、飞白、字内镂空、颜色与细笔锋':adjustment?'独立主体，保留未要求修改的轮廓、颜色、材质及内部细节':'独立主体，保留轮廓、颜色、材质及内部细节，不添加或改变主体';
  return '从随附局部参考图中精确提取'+subject+'。移除原背景及其他无关对象。'+(description?'目标说明（仅用于识别对象）：'+JSON.stringify(String(description).slice(0,700))+'。':'')+
    (adjustment?'仅按本次修改意见调整当前素材：'+JSON.stringify(String(adjustment).slice(0,3000))+'。':'')+'输出不透明PNG，背景使用均匀纯'+matte.name+'色 #'+matte.hex+'，覆盖全部画布空白、字间及主体内部的真实空隙；保留主体本身的白色笔画和高光。主体完整可见，周围留少量同色空白；不要透明背景、棋盘格、背景渐变、背景纹理、额外投影、边框或新增文字。背景将由本地程序移除。';
}

// The provider always receives a reference image and an opaque chroma-matte
// instruction. Transparent output capability is never requested or retried.
export async function prepareCompatibleCutout({config,imageRequest=generatedImage,onProgress=()=>{},description,referenceImage,adjustment,...options}){
  const local=await prepareLocalCutout(options),files=new Set();
  let referenceFile=local.referenceFile;
  if(referenceImage){referenceFile=local.referenceFile+'.edit.png';files.add(referenceFile);fs.writeFileSync(referenceFile,referenceImage.bytes);}
  let matte;
  try{matte=await options.assetTool(options.env,'choose-matte',referenceFile,referenceFile,options.signal,referenceImage?[]:[local.backgroundReferenceFile]);}
  catch(error){local.dispose();for(const file of files)fs.rmSync(file,{force:true});throw error;}
  const prompt=chromaCutoutPrompt({...options,adjustment,description:(description||'')+(referenceImage?'':extractionLayerContext(options.elements,options.targetKey,options.sourceBox)),matte});
  const identity=crypto.createHash('sha256').update(JSON.stringify([cutoutCompatibilityVersion,'chroma-then-reference',local.identity,referenceImage?crypto.createHash('sha256').update(referenceImage.bytes).digest('hex'):null,config?.baseURL||null,config?.model||null,prompt])).digest('hex');
  return {...local,identity,dispose(){local.dispose();for(const file of files)fs.rmSync(file,{force:true});},async extract(target){
    const provider=target+'.chroma-provider.png';files.add(provider);
    return withLocalCutoutFallback({signal:options.signal,attempt:async()=>{
      options.signal?.throwIfAborted();
      onProgress('纯色底生成与本地去底 · '+matte.name+'底');
      if(!config?.key||!config?.model)throw Object.assign(Error('未配置素材生图模型，直接使用参考底图本地分离'),{cutoutCompatibleFailure:true});
      let bytes;
      try{bytes=await imageRequest(config,prompt,options.signal,{transparentBackground:false,size:'1920x1080',references:[referenceImage||{bytes:fs.readFileSync(local.referenceFile),mime:'image/png'}]});}
      catch(error){if(options.signal?.aborted)throw error;throw Object.assign(new Error(error.message,{cause:error}),{cutoutCompatibleFailure:true});}
      fs.writeFileSync(provider,bytes);
      let alpha;
      try{alpha=await options.assetTool(options.env,'chroma-cutout',provider,target,options.signal,[...(options.artistic?['artistic']:[]),matte.hex]);}
      catch(error){if(options.signal?.aborted)throw error;throw Object.assign(new Error('纯色底去底未通过：'+error.message,{cause:error}),{code:'CUTOUT_ALPHA_INVALID'});}
      if(!alpha.hasTransparency||!alpha.hasVisiblePixels)throw Object.assign(Error('纯色底去底未获得有效透明主体'),{code:'CUTOUT_ALPHA_INVALID'});
      return {origin:'ai-chroma-cutout',cutoutMethod:'chroma-background',cutoutCompatibilityVersion,matte,sourceBox:{...options.sourceBox},prompt,effectivePrompt:prompt,model:config.model,alpha};
    },onFallback:error=>{onProgress('纯色底路径未完成，改用参考底图本地分离');},extractLocal:referenceImage?null:async error=>({
      ...await local.extract(target),cutoutMethod:'local-reference',cutoutCompatibilityVersion,matte,fallbackReason:String(error.message).slice(0,1000),attemptedModel:config?.model||null
    })});
  }};
}
