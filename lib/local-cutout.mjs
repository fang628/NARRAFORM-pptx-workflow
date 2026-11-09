import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {expandedCutoutRegion,localCutoutTrim,localCutoutVersion} from './cutout-fallback.mjs';
import {rebuildAssetIdentity} from './rebuild-reuse.mjs';
import {buildObjectMasks} from './object-masks.mjs';

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

// Prepare both registered reference crops before caching. No image-generation
// credentials, prompt checks or provider calls belong to this extraction path.
export async function prepareLocalCutout({env,assetTool,source,backgroundFile,sourceBox,elements=[],targetKey,artistic=false,textIdentity,directory,signal,getImage}){
  signal?.throwIfAborted();
  if(!sourceBox||!['x','y','w','h'].every(k=>Number.isFinite(sourceBox[k]))||sourceBox.x<0||sourceBox.y<0||sourceBox.w<=0||sourceBox.h<=0||sourceBox.x+sourceBox.w>1600.1||sourceBox.y+sourceBox.h>900.1||sourceBox.w*sourceBox.h>1600*900*.35)throw Error('本地背景分离需要有效的局部 sourceBox');
  if(!source||!backgroundFile||!fs.existsSync(source)||!fs.existsSync(backgroundFile))throw Error('本地背景分离需要当前预览与登记底图，已保留现有页面');
  fs.mkdirSync(directory,{recursive:true});
  const prefix=path.join(directory,crypto.randomUUID()+'.local-cutout');
  const spec=prefix+'.json',preview=prefix+'.preview.png',background=prefix+'.background.png';
  const dispose=()=>{for(const file of [spec,preview,background])fs.rmSync(file,{force:true});};
  const expanded=expandedCutoutRegion(sourceBox,elements,{targetKey});
  try{
    const neighbors=elements.filter(e=>e.key!==targetKey&&e.role!=='background'&&Math.min(e.x+e.w,expanded.x+expanded.w)>Math.max(e.x,expanded.x)&&Math.min(e.y+e.h,expanded.y+expanded.h)>Math.max(e.y,expanded.y));
    const maskDirectory=path.basename(directory)==='assets'?path.join(path.dirname(directory),'geometry-records','object-masks'):path.join(directory,'object-mask-cache');
    const masks=await buildObjectMasks({elements:neighbors,directory:maskDirectory,getImage,signal});
    const isolation={box:['x','y','w','h'].map(k=>expanded[k]),region:expanded,sourceBox,targetKey,elements:neighbors,objectMasks:masks};
    fs.writeFileSync(spec,JSON.stringify(isolation));
    const foregroundReport=await assetTool(env,'crop',source,preview,signal,[spec]);
    const backgroundReport=await assetTool(env,'crop',backgroundFile,background,signal,[spec]);
    const pixels=foregroundReport.pixelHash||hash(fs.readFileSync(preview));
    const backgroundPixels=backgroundReport.pixelHash||hash(fs.readFileSync(background));
    const relativeFrame={x:(expanded.x-sourceBox.x)/sourceBox.w,y:(expanded.y-sourceBox.y)/sourceBox.h,w:expanded.w/sourceBox.w,h:expanded.h/sourceBox.h};
    const identity=rebuildAssetIdentity({method:'cutout',sourcePixels:pixels,mattePolicy:{version:localCutoutVersion,mode:'registered-background-difference',backgroundPixels,relativeFrame,neighbors:masks.map(m=>({key:m.key,hash:m.hash,unavailable:m.unavailable})),artistic:!!artistic,...(artistic?{textIdentity}:{} )}});
    return {pixels,identity,referenceFile:preview,backgroundReferenceFile:background,dispose,async extract(target){
      signal?.throwIfAborted();
      const alpha=await assetTool(env,'reference-cutout',preview,target,signal,[background,...(artistic?['artistic']:[]),spec]);
      if(!alpha.hasTransparency||!alpha.hasVisiblePixels)throw Error('本地背景分离未获得可靠透明主体，已保留现有页面');
      return {origin:'local-reference',localCutout:true,localCutoutVersion,localTrim:localCutoutTrim(alpha,{source:sourceBox,expanded}),sourceBox:{...sourceBox},alpha,model:null};
    }};
  }catch(error){dispose();throw error;}
}
