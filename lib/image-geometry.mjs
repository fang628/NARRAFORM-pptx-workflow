import imageSize from 'image-size';
import {maxOriginalAspectAdjustment} from './image-placement-policy.mjs';

export function imageMayStretch(e){
  return e.imageFit==='fill'&&Number.isFinite(e.aspect)&&e.aspect>0&&Number.isFinite(e.w)&&Number.isFinite(e.h)&&e.w>0&&e.h>0&&Math.abs(e.w/e.h/e.aspect-1)<=maxOriginalAspectAdjustment+1e-9;
}

export function fittedImagePlans(images){
  return images.map(e=>{
    const aspect=e.aspect;
    if(!Number.isFinite(aspect)||aspect<=0)throw Error('原图比例无效');
    const error=Math.abs(e.w/e.h/aspect-1);
    if(error<=maxOriginalAspectAdjustment+1e-9)return {...e,placeholderBox:{x:e.x,y:e.y,w:e.w,h:e.h},imageFit:'fill',aspectAdjustment:error};
    const w=Math.min(e.w,e.h*aspect),h=w/aspect;
    return {...e,placeholderBox:{x:e.x,y:e.y,w:e.w,h:e.h},imageFit:'contain',aspectAdjustment:0,x:e.x+(e.w-w)/2,y:e.y+(e.h-h)/2,w,h};
  });
}

export function repositionedImagePlans(previous,updates){
  return previous.map(old=>{
    const proposed=updates.find(e=>e.nodeId===old.nodeId);
    const box=old.placeholderBox;
    let bounds={x:proposed.x,y:proposed.y,w:proposed.w,h:proposed.h};
    if(box&&['x','y','w','h'].every(k=>Number.isFinite(box[k]))&&box.w>0&&box.h>0){
      // A local geometry repair must not abandon the measured placeholder or
      // spill over neighboring text. Scale uniformly before clamping position.
      const scale=Math.min(1,box.w/bounds.w,box.h/bounds.h);
      bounds.w*=scale;bounds.h*=scale;
      bounds.x=Math.max(box.x,Math.min(bounds.x,box.x+box.w-bounds.w));
      bounds.y=Math.max(box.y,Math.min(bounds.y,box.y+box.h-bounds.h));
    }
    const [fit]=fittedImagePlans([{...old,...bounds}]);
    return {...fit,...(box?{placeholderBox:{...box}}:{})};
  });
}

// PptxGenJS's Node path does not infer the intrinsic ratio from addImage's
// w/h. Compute the centered contain box explicitly before writing OOXML.
export function containedImageBounds(bytes,bounds,{allowSmallDistortion=false}={}){
  const {width,height}=imageSize(bytes);
  if(![width,height,bounds.x,bounds.y,bounds.w,bounds.h].every(Number.isFinite)||width<=0||height<=0||bounds.w<=0||bounds.h<=0)throw Error('无法确定图片的有效尺寸与放置区域');
  if(allowSmallDistortion&&Math.abs(bounds.w/bounds.h/(width/height)-1)<=maxOriginalAspectAdjustment+1e-9)return {...bounds};
  const scale=Math.min(bounds.w/width,bounds.h/height),w=width*scale,h=height*scale;
  return {...bounds,x:bounds.x+(bounds.w-w)/2,y:bounds.y+(bounds.h-h)/2,w,h};
}
