import imageSize from 'image-size';

// PptxGenJS's Node path does not infer the intrinsic ratio from addImage's
// w/h. Compute the centered contain box explicitly before writing OOXML.
export function containedImageBounds(bytes,bounds){
  const {width,height}=imageSize(bytes);
  if(![width,height,bounds.x,bounds.y,bounds.w,bounds.h].every(Number.isFinite)||width<=0||height<=0||bounds.w<=0||bounds.h<=0)throw Error('无法确定图片的有效尺寸与放置区域');
  const scale=Math.min(bounds.w/width,bounds.h/height),w=width*scale,h=height*scale;
  return {...bounds,x:bounds.x+(bounds.w-w)/2,y:bounds.y+(bounds.h-h)/2,w,h};
}
