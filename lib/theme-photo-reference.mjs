import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {themePhotoEligible,themePhotoCandidates,selectedThemePhotoId,validateThemePhotoReferences,photoIdentity,photoThemePrompt} from '../public/theme-photo-policy.js';
export {themePhotoEligible,themePhotoCandidates,selectedThemePhotoId,validateThemePhotoReferences,photoIdentity,photoThemePrompt};
export const themePhotoPlanningRule='通常照片主体是可选分支；若材料综合分析themeClarity=unclear且有实际照片，底图阶段优先走照片主体图生图路径，不强行杜撰材料主题。普通项目和答辩可从已理解且适合全篇主题的原始照片中选择主体，用图生图生成封面或目录底图；有明确主题的其他学术汇报不选照片；无明确主题时允许照片兜底。不能将图表、截图、示意图或AI生成图当作材料照片。同一方向的封面和目录不得使用同一张照片（相同文件副本也算同图）；可以仅一页使用照片。A/B/C比较风格时可复用各自相同用途的照片。photoReferences 可选 {"hero-image":"候选照片id或null","toc-image":"另一张候选照片id或null"}；选中照片时对应heroSubject/tocSubject简短描述该照片的实际主体，不再另外虚构主体；有明确主题时主体适合全篇主线，无明确主题时以照片中的实际对象建立视觉锚点；所选风格、配色、阅读留白保持。用户在修改时也可自行选一张材料照片作为新主体参考。';

export function themePhotoReference(p,use,id,env,{expectedHash}={}){
  if(!id)return null;
  validateThemePhotoReferences(p,{[use]:id});
  const material=p.materials.find(m=>m.id===id),candidate=themePhotoCandidates(p).find(m=>m.id===id),root=path.resolve(env.data,p.id),file=path.resolve(root,'assets',material.file);
  if(!file.startsWith(path.join(root,'assets')+path.sep))throw Error('照片路径无效');
  if(fs.statSync(file).size>20_000_000)throw Error('参考照片超过20 MB，请先裁切或压缩；原始照片已保留');
  const bytes=fs.readFileSync(file),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  if(!material.sha256||sha256!==material.sha256||expectedHash&&expectedHash!==sha256)throw Error('参考照片已变化，请重新选择照片');
  if(bytes.length>20_000_000)throw Error('参考照片超过20 MB，请先裁切或压缩；原始照片已保留');
  return {materialId:id,sha256,file:path.relative(root,file),purpose:'theme-photo-subject',description:candidate.description};
}

// Proposals are checked together so that two-photo swaps are valid as a batch.
export function validatePhotoSubmissions(p,jobs,imageEdit){
  const groups=new Map();
  for(const job of jobs){
    let id=Object.prototype.hasOwnProperty.call(job,'photoMaterialId')?job.photoMaterialId:selectedThemePhotoId(job.d,job.use);
    if(imageEdit){
      if(imageEdit.crossStyle)id=imageEdit.photoReference?.materialId||null;
      else if(imageEdit.mode==='adjust')id=imageEdit.target.image?.photoReference?.materialId||null;
    }
    job.photoMaterialId=id||null;
    if(id)validateThemePhotoReferences(p,{[job.use]:id});
    if(!groups.has(job.d.id))groups.set(job.d.id,{d:job.d,refs:Object.fromEntries(['hero-image','toc-image'].map(use=>[use,job.d.assets?.[use]?.photoReference?.materialId||selectedThemePhotoId(job.d,use)]))});
    if(['hero-image','toc-image'].includes(job.use))groups.get(job.d.id).refs[job.use]=id||null;
  }
  for(const {refs}of groups.values())validateThemePhotoReferences(p,refs);
  return jobs;
}
