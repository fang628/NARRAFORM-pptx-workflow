import fs from 'node:fs';
import path from 'node:path';
import imageSize from 'image-size';
import {Resvg} from '@resvg/resvg-js';
import crypto from 'node:crypto';
import {imageEditRegion} from '../public/image-region-model.js';
export {imageEditRegion} from '../public/image-region-model.js';

export function imageEditRegionPrompt(instruction,value){
  const r=imageEditRegion(value);if(!r)return instruction;
  return instruction+'\n【框选定位】原图左上角为原点：左 '+r.x/10+'%、上 '+r.y/10+'%、宽 '+r.w/10+'%、高 '+r.h/10+'%。最后一张参考图的黄色虚线框仅提示目标的大致位置；结合周边识别完整目标，不裁切整图、不把框线当作修改边界。框线不是画面元素，不绘入成品；按本次意见修改，其余内容保持。';
}
export function annotatedEditRegion(bytes,value){
  const r=imageEditRegion(value),size=imageSize(bytes);if(!r)throw Error('请先框选位置');
  const scale=Math.min(1,1920/size.width,1920/size.height),width=Math.max(1,Math.round(size.width*scale)),height=Math.max(1,Math.round(size.height*scale)),stroke=Math.max(2,width/500);
  const mime=size.type==='jpg'?'image/jpeg':'image/'+size.type;
  const box=`x="${r.x/1000*width}" y="${r.y/1000*height}" width="${r.w/1000*width}" height="${r.h/1000*height}"`;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image href="data:${mime};base64,${bytes.toString('base64')}" width="${width}" height="${height}"/><rect ${box} fill="none" stroke="#202020" stroke-width="${stroke+2}"/><rect ${box} fill="none" stroke="#FFF238" stroke-width="${stroke}" stroke-dasharray="${stroke*3} ${stroke*2}"/></svg>`;
  return new Resvg(svg).render().asPng();
}
export function editRegionImage(p,edit,env){
  const root=path.resolve(env.data,p.id),file=path.resolve(root,edit.target.sourceFile);
  if(!file.startsWith(root+path.sep))throw Error('图片定位来源无效');
  return annotatedEditRegion(fs.readFileSync(file),edit.region);
}
export function saveEditRegionReference(p,edit,env,file){
  if(!edit?.region)return null;
  const bytes=editRegionImage(p,edit,env);fs.writeFileSync(file,bytes);
  return {file:path.relative(path.join(env.data,p.id),file),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),purpose:'edit-region-hint'};
}
