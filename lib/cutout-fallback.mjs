export const localCutoutVersion=2;
import {assetServiceUnavailable,wrapError} from './errors.mjs';
export function opaqueCutoutPrompt(prompt){
  return String(prompt).replace(/透明背景/g,'均匀纯洋红背景').replace(/透明主体/g,'完整主体').replace(/透明独立/g,'独立').replace('字间、字内镂空与飞白空隙同样透明','字间、字内镂空与飞白空隙也填充同一纯洋红底色')+'\n输出不透明PNG，背景必须是均匀纯洋红色，与主体清楚分离，不要棋盘格、背景光影或背景渐变；主体的颜色、完整轮廓和字迹不变，背景由本地程序移除。';
}
export function canRecoverCutout(error){
  return error?.code==='CUTOUT_ALPHA_INVALID'||error?.backgroundRejected||[404,405,415,501].includes(error?.httpStatus)||assetServiceUnavailable(error);
}
export async function withLocalCutoutFallback({attempt,extractLocal,signal,onFallback=()=>{}}){
  try{return await attempt();}catch(error){
    if(signal?.aborted)throw error;
    if(!extractLocal||!canRecoverCutout(error))throw error;
    await onFallback(error);
    try{return await extractLocal(error);}catch(localError){
      if(signal?.aborted)throw localError;
      throw wrapError(error,String(error.message)+'；备用本地抠图未通过：'+String(localError.message));
    }
  }
}

export function localCutoutTrim(alpha,frame){
  const [left,top,right,bottom]=alpha.trimBox;
  const trim={left:left/alpha.sourceWidth,top:top/alpha.sourceHeight,width:(right-left)/alpha.sourceWidth,height:(bottom-top)/alpha.sourceHeight};
  if(!frame)return trim;
  const {source,expanded}=frame;
  return {left:(expanded.x-source.x+trim.left*expanded.w)/source.w,top:(expanded.y-source.y+trim.top*expanded.h)/source.h,width:trim.width*expanded.w/source.w,height:trim.height*expanded.h/source.h};
}
export function localCutoutPlacement(bounds,asset){
  const t=asset.localTrim;
  const frame=bounds.artisticText&&bounds.sourceBox?bounds.sourceBox:bounds;
  return t?{x:frame.x+t.left*frame.w,y:frame.y+t.top*frame.h,w:t.width*frame.w,h:t.height*frame.h}:bounds;
}

// The model's source box is a hint; recover strokes outside a tight crop while
// stopping expansion at already separated neighbouring objects.
export function expandedCutoutRegion(source,elements,{targetKey}={}){
 let px=Math.max(24,source.w*.2),py=Math.max(16,source.h*.2),result;
 for(let attempt=0;attempt<8;attempt++){
  let left=Math.max(0,source.x-px),top=Math.max(0,source.y-py),right=Math.min(1600,source.x+source.w+px),bottom=Math.min(900,source.y+source.h+py);
  for(const e of elements){
   if(e.key===targetKey)continue;
   const gap=Math.max(3,e.strokeWidth||0),x=e.x-gap,y=e.y-gap,r=e.x+e.w+gap,b=e.y+e.h+gap;
   const overlapSource=Math.min(source.x+source.w,r)>Math.max(source.x,x)&&Math.min(source.y+source.h,b)>Math.max(source.y,y);
   if(overlapSource)continue;
   if(Math.min(right,r)>Math.max(left,x)){
    if(y>=source.y+source.h)bottom=Math.min(bottom,y);
    if(b<=source.y)top=Math.max(top,b);
   }
   if(Math.min(bottom,b)>Math.max(top,y)){
    if(x>=source.x+source.w)right=Math.min(right,x);
    if(r<=source.x)left=Math.max(left,r);
   }
  }
  result={x:left,y:top,w:right-left,h:bottom-top};
  if(result.w*result.h<=1600*900*.35)return result;
  px/=2;py/=2;
 }
 return {...source};
}
