import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {expandedCutoutRegion,localCutoutTrim,localCutoutVersion} from './cutout-fallback.mjs';
import {rebuildAssetIdentity} from './rebuild-reuse.mjs';

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

// Prepare both registered reference crops before caching. No image-generation
// credentials, prompt checks or provider calls belong to this extraction path.
export async function prepareLocalCutout({env,assetTool,source,backgroundFile,sourceBox,elements=[],targetKey,artistic=false,textIdentity,directory,signal}){
  signal?.throwIfAborted();
  if(!sourceBox||!['x','y','w','h'].every(k=>Number.isFinite(sourceBox[k]))||sourceBox.x<0||sourceBox.y<0||sourceBox.w<=0||sourceBox.h<=0||sourceBox.x+sourceBox.w>1600.1||sourceBox.y+sourceBox.h>900.1||sourceBox.w*sourceBox.h>1600*900*.35)throw Error('本地背景分离需要有效的局部 sourceBox');
  if(!source||!backgroundFile||!fs.existsSync(source)||!fs.existsSync(backgroundFile))throw Error('本地背景分离需要当前预览与登记底图，已保留现有页面');
  fs.mkdirSync(directory,{recursive:true});
  const prefix=path.join(directory,crypto.randomUUID()+'.local-cutout');
  const spec=prefix+'.json',preview=prefix+'.preview.png',background=prefix+'.background.png';
  const dispose=()=>{for(const file of [spec,preview,background])fs.rmSync(file,{force:true});};
  const expanded=expandedCutoutRegion(sourceBox,elements,{targetKey});
  try{
    fs.writeFileSync(spec,JSON.stringify({box:['x','y','w','h'].map(k=>expanded[k])}));
    const foregroundReport=await assetTool(env,'crop',source,preview,signal,[spec]);
    const backgroundReport=await assetTool(env,'crop',backgroundFile,background,signal,[spec]);
    const pixels=foregroundReport.pixelHash||hash(fs.readFileSync(preview));
    const backgroundPixels=backgroundReport.pixelHash||hash(fs.readFileSync(background));
    const relativeFrame={x:(expanded.x-sourceBox.x)/sourceBox.w,y:(expanded.y-sourceBox.y)/sourceBox.h,w:expanded.w/sourceBox.w,h:expanded.h/sourceBox.h};
    const identity=rebuildAssetIdentity({method:'cutout',sourcePixels:pixels,mattePolicy:{version:localCutoutVersion,mode:'registered-background-difference',backgroundPixels,relativeFrame,artistic:!!artistic,...(artistic?{textIdentity}:{} )}});
    return {pixels,identity,referenceFile:preview,backgroundReferenceFile:background,dispose,async extract(target){
      signal?.throwIfAborted();
      const alpha=await assetTool(env,'reference-cutout',preview,target,signal,[background,...(artistic?['artistic']:[])]);
      if(!alpha.hasTransparency||!alpha.hasVisiblePixels)throw Error('本地背景分离未获得可靠透明主体，已保留现有页面');
      return {origin:'local-reference',localCutout:true,localCutoutVersion,localTrim:localCutoutTrim(alpha,{source:sourceBox,expanded}),sourceBox:{...sourceBox},alpha,model:null};
    }};
  }catch(error){dispose();throw error;}
}
