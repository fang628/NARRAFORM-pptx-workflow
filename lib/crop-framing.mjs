import path from 'node:path';
import {figureBox} from './document-figure-boundaries.mjs';

export const cropFramingVersion=1;
// The candidate is a verified whole figure or independent panel. Trim only its empty
// border, then add a thin background-matched border locally; never rescale source pixels.
export async function cropWithThinBorder(box,{file,target,root,python,run,signal}){
  signal?.throwIfAborted();
  const result=await run(python,[path.join(root,'tools/document_panels.py'),'crop',file,JSON.stringify(box),target],{windowsHide:true,signal,timeout:60000,maxBuffer:2e6});
  signal?.throwIfAborted();
  const data=JSON.parse(result.stdout),sourceBox=figureBox(data.contentBox||data.box);
  // A conservative floor/ceil crop may extend by one source pixel. Compare in physical
  // pixels instead of a fixed normalized tolerance (small embedded originals need more).
  const [width,height]=data.evidence?.sourceSize||[];
  const dx=Number.isFinite(width)&&width>0?1000/width+.02:.1,dy=Number.isFinite(height)&&height>0?1000/height+.02:.1;
  const within=sourceBox&&sourceBox.x>=box.x-dx&&sourceBox.y>=box.y-dy&&sourceBox.x+sourceBox.w<=box.x+box.w+dx&&sourceBox.y+sourceBox.h<=box.y+box.h+dy;
  if(data.error||!within||!Number.isInteger(data.width)||!Number.isInteger(data.height)||data.width<1||data.height<1||data.file!==path.basename(target))throw Error(data.error||'图片边界处理返回无效结果');
  return {width:data.width,height:data.height,file:data.file,cropSourceBox:sourceBox,cropFraming:{...data.evidence,version:cropFramingVersion}};
}

// Map a refined parent-original crop back into the document coordinates. The proven
// per-panel mapping also accounts for PPTX srcRect, without including the new border.
export function framedPanelSourceBox(pageBox,mappedBox,framedBox){
  return figureBox({
    x:pageBox.x+(framedBox.x-mappedBox.x)/mappedBox.w*pageBox.w,
    y:pageBox.y+(framedBox.y-mappedBox.y)/mappedBox.h*pageBox.h,
    w:framedBox.w/mappedBox.w*pageBox.w,
    h:framedBox.h/mappedBox.h*pageBox.h
  })||pageBox;
}
