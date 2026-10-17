import fs from 'node:fs';
import path from 'node:path';

export const placeholderGeometryVersion='placeholder-geometry-v3';
const overlap=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
const validBox=e=>['x','y','w','h'].every(k=>typeof e?.[k]==='number'&&Number.isFinite(e[k]))&&e.x>=0&&e.y>=0&&e.w>0&&e.h>0&&e.x+e.w<=1600.001&&e.y+e.h<=900.001;

export function applyPlaceholderGeometry(images,raw){
  if(raw?.status!=='available'||!Array.isArray(raw.images)||raw.images.length!==images.length)throw Error('本地占位框定位结果格式无效');
  const items=images.map(original=>{
    const matches=raw.images.filter(e=>e?.nodeId===original.nodeId&&e.id===original.id),found=matches[0];
    const accepted=matches.length===1&&found.localization?.status==='refined'&&validBox(found)&&Number.isFinite(found.localization.confidence)&&found.localization.confidence>=.8;
    return {original,accepted,box:accepted?Object.fromEntries(['x','y','w','h'].map(k=>[k,found[k]])):original,
      localization:accepted?found.localization:{status:'fallback',reason:found?.localization?.reason||'本地结果不可靠，保留AI定位'}};
  });
  // Distinct candidate IDs can still describe overlapping rectangles. Roll back
  // involved refinements, including collisions with another image's fallback.
  for(let pass=0;pass<items.length;pass++){
    let changed=false;
    for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++)if(overlap(items[i].box,items[j].box)>1e-5){
      for(const item of [items[i],items[j]])if(item.accepted){item.accepted=false;item.box=item.original;item.localization={status:'fallback',reason:'精定位区域与其他图片重叠，保留AI定位'};changed=true;}
    }
    if(!changed)break;
  }
  const result=items.map(({original,box,localization})=>({...original,...Object.fromEntries(['x','y','w','h'].map(k=>[k,box[k]])),localization}));
  return {images:result,report:{version:placeholderGeometryVersion,status:'available',method:raw.method,matchingBasis:raw.matchingBasis,width:raw.width,height:raw.height,
    refined:items.filter(e=>e.accepted).length,total:images.length,candidateCount:raw.candidateCount,
    items:result.map(e=>({nodeId:e.nodeId,id:e.id,...e.localization}))}};
}

export async function refinePlaceholderGeometry(env,python,image,images,signal){
  if(!images.length)return {images,report:{version:placeholderGeometryVersion,status:'not_needed',refined:0,total:0}};
  const input=image.replace(/\.[^.]+$/,'.placeholder-input.json'),output=image.replace(/\.[^.]+$/,'.placeholder-geometry.json');
  try{
    signal?.throwIfAborted();fs.writeFileSync(input,JSON.stringify({image,images}));
    const result=await env.run(python,[path.join(env.root,'tools','placeholder_geometry.py'),input,output],{windowsHide:true,maxBuffer:1000000,timeout:45000,signal});
    signal?.throwIfAborted();return applyPlaceholderGeometry(images,JSON.parse(result.stdout));
  }catch(error){
    if(signal?.aborted)throw error;
    return {images,report:{version:placeholderGeometryVersion,status:'unavailable',refined:0,total:images.length,
      error:String(error.stderr||error.message).slice(-1000)}};
  }
}
