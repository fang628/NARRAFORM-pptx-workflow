export const photoAssessmentRule='实际收到图片时额外输出photoAssessment:{kind:"real_photo|screenshot|diagram|illustration|render|mixed|unknown",certain:是否能明确判断,evidence:"一句可见画面依据"}。real_photo仅用于现实拍摄的单张照片，包括真实显微摄影；截图、图表、示意图、插画、AI生成或三维渲染、照片与文字图表混排的组合图均不算。不凭文件名、用途或用户称其为照片判断；无法明确确认真实摄影时certain=false、kind=unknown，不猜测。';
export function normalizePhotoAssessment(raw,material){
  if(material.kind!=='image')return null;
  const kinds=['real_photo','screenshot','diagram','illustration','render','mixed','unknown'];
  const kind=kinds.includes(raw?.kind)?raw.kind:'unknown',evidence=typeof raw?.evidence==='string'?raw.evidence.trim().slice(0,300):'';
  return {version:1,kind,certain:raw?.certain===true&&!!evidence&&kind!=='unknown',evidence,sourceHash:material.sha256||null};
}
