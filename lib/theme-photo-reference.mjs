import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {themePhotoEligible,themePhotoCandidates,selectedThemePhotoId,validateThemePhotoReferences,photoIdentity,photoThemePrompt} from '../public/theme-photo-policy.js';
export {themePhotoEligible,themePhotoCandidates,selectedThemePhotoId,validateThemePhotoReferences,photoIdentity,photoThemePrompt};
export const themePhotoPlanningRule='照片主体仅作最后兜底：只有themeClarity=unclear且backgroundSubjectUnresolved=true，即主题实在不明确、也无法从需求与全篇材料确定合适的艺术主体时，才可使用候选现实照片图生图；普通项目、答辩、手动修改同样遵守，不因材料中有照片就使用。主题明确或已有合适主体时photoReferences均填null。候选必须经实际看图明确确认为现实拍摄的单张照片，不能仅凭文件名或分类；不确定、未识别、截图、图表、示意图、插画、渲染、AI生成图及组合图不选。同一方向封面和目录不得使用同一张照片（副本也算同图），可仅一页使用；A/B/C同用途可复用。photoReferences可选 {"hero-image":"候选照片id或null","toc-image":"另一张候选照片id或null"}；选中时heroSubject/tocSubject简短描述该照片的实际主体，保留所选风格、配色和阅读留白。无符合条件的照片时继续艺术化选题，不强行启用照片路径。';

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
