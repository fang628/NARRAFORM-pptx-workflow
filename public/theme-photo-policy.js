const uses=['hero-image','toc-image'];
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o||{},k);
const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function themePhotoEligible(p){
  if(p?.analysis?.themeClarity==='unclear')return true;
  const brief=[p?.brief?.title,p?.brief?.purpose,p?.brief?.audience].join(' ');
  if(/答辩|defen[sc]e/i.test(brief))return true;
  if(/创新创业|商业计划|路演|融资/.test(brief))return true;
  return !/学术|科研|学位|论文|博士|硕士|毕业|实验研究|研究汇报|组会|academic\s+(?:report|presentation)|research\s+(?:report|presentation)/i.test(brief);
}
export function fallbackThemePhotoReferences(p,references){
  if(p?.analysis?.themeClarity!=='unclear')return references;
  const photos=themePhotoCandidates(p,{automatic:true});if(!photos.length)return references;
  const next={...references},uses=[...(p.brief?.cover!==false?['hero-image']:[]),...(p.brief?.toc&&Number(p.brief?.pages)!==1?['toc-image']:[])];
  for(const use of uses){if(next[use])continue;const other=use==='hero-image'?'toc-image':'hero-image';const photo=photos.find(m=>!next[other]||photoIdentity(p,m.id)!==photoIdentity(p,next[other]));if(photo)next[use]=photo.id;}
  return next;
}
export function themePhotoCandidates(p,{automatic=false}={}){
  if(!themePhotoEligible(p))return [];
  return (p.materials||[]).filter(m=>m.kind==='image'&&typeof m.file==='string'&&!m.generated&&!m.reconstructed&&(m.size===undefined||m.size<=20_000_000)&&!/\.svg$/i.test(m.file)).flatMap(m=>{
    const reading=p.analysis?.readings?.find(r=>r.id===m.id),photo=!!reading&&/照片|摄影|实拍|photo(?:graph)?/i.test(reading.category||'');
    if(automatic&&!photo||!photo&&/图表|流程图|机理图|示意图|截图|插画|diagram|chart|screenshot/i.test(reading?.category||''))return [];
    return [{id:m.id,name:m.name,sha256:m.sha256||'',description:photo?String(reading.keyPoints?.[0]||reading.summary||'主要主体').split(/[。；;\n]/)[0].slice(0,60):'主要主体',recognized:photo}];
  });
}
export function selectedThemePhotoId(d,use){
  if(own(d?.promptDrafts?.[use],'photoMaterialId'))return d.promptDrafts[use].photoMaterialId||null;
  if(own(d?.photoReferences,use))return d.photoReferences[use]||null;
  return d?.assets?.[use]?.photoReference?.materialId||null;
}
export const photoIdentity=(p,id)=>id?(p.materials?.find(m=>m.id===id)?.sha256||id):null;
export function validateThemePhotoReferences(p,references,{automatic=false}={}){
  const refs={};
  for(const [use,id]of Object.entries(references||{})){
    if(!uses.includes(use)){if(id)throw Error('仅封面与目录可选照片主体');continue;}
    if(id!==null&&id!==undefined&&(typeof id!=='string'||!themePhotoCandidates(p,{automatic}).some(m=>m.id===id)))throw Error(themePhotoEligible(p)?'请选择材料中的有效照片；自动规划仅可选已识别为照片的材料':'当前为学术汇报，不采用材料照片生成底图');
    refs[use]=id||null;
  }
  if(refs['hero-image']&&photoIdentity(p,refs['hero-image'])===photoIdentity(p,refs['toc-image']))throw Error('同一方向的封面与目录不能使用同一张照片，请换一张或不使用照片');
  return refs;
}

const photoHint='仅借用照片主体，背景与色调按本方案重建。';
export function photoThemePrompt(prompt,photo,fallbackSubject='符合全篇主题的艺术主视觉'){
  let value=String(prompt||'').replaceAll(photoHint,'');
  if(!photo)return value.replace(/主体[:：]参考照片中的[^。\n]*/g,'主体：'+fallbackSubject);
  const subject='主体：参考照片中的'+(photo.description||'主要主体')+'，保留主体形状与识别特征';
  value=/主体[:：][^。\n]*/.test(value)?value.replace(/主体[:：][^。\n]*/g,subject):subject+'。'+value;
  return value.replace(/[。\s]+$/,'')+'。'+photoHint;
}

export function themePhotoSelector(p,{theme,use,photoMaterialId,attribute='data-theme-photo-reference',emptyLabel='不使用材料照片 · 艺术化生成'}={}){
  if(!p.themePhotoReferenceEnabled||!themePhotoEligible(p)||!uses.includes(use))return '';
  const d=p.themeAssets?.directions?.find(d=>d.id===theme),selected=photoMaterialId===undefined?selectedThemePhotoId(d,use):photoMaterialId,photos=themePhotoCandidates(p);
  if(!photos.length)return '';
  return `<section class="theme-photo-choice"><label>照片主体${emptyLabel==='不使用材料照片 · 艺术化生成'?'（可选）':''}<select ${attribute} data-theme="${h(theme)}" data-use="${h(use)}"><option value="">${h(emptyLabel)}</option>${photos.map(m=>`<option value="${h(m.id)}" data-photo-hash="${h(m.sha256)}" ${m.id===selected?'selected':''}>${h(m.name)}${m.recognized?'':'（请确认是照片）'}</option>`).join('')}</select></label><div class="theme-photo-preview" data-theme-photo-preview>${selected?`<img src="/api/projects/${h(p.id)}/assets/${h(selected)}" alt="照片主体参考"><span>${h(photos.find(m=>m.id===selected)?.name||'参考照片')}</span>`:''}</div><p class="subtle">普通项目和答辩可选照片；材料无明确主题时优先借用已识别照片主体。封面与目录须使用不同照片，原图保留。</p></section>`;
}
