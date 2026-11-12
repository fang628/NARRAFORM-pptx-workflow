import crypto from 'node:crypto';

export function needsPageTranscript(page){
  const chars=String(page.text||'').replace(/\s/g,'').length;
  if(!chars)return true;
  const raster=(page.images||[]).some(image=>{
    const b=image.box||image;return Number(b.w)*Number(b.h)>=350000;
  });
  const rasterObject=(page.objects||[]).some(o=>['image','picture','pic'].includes(o.type)&&o.box?.w*o.box?.h>=1600*900*.35);
  return chars<120&&(raster||rasterObject);
}

export function pageTranscript(raw,page){
  if(!needsPageTranscript(page))return null;
  const value=raw?.transcript;
  if(!value||typeof value.text!=='string'||typeof value.hasText!=='boolean'||value.text.length>100000
    ||value.hasText&&!value.text.trim()||!value.hasText&&value.text.trim())return {status:'unavailable',text:'',page:page.number};
  return {status:value.uncertain||/\[无法辨认\]/.test(value.text)?'uncertain':'read',text:value.text,
    hasText:value.hasText,page:page.number,source:'page-vision-ocr'};
}

// Append recovered pages without rewriting the native source or its offsets.
// OCR provenance stays explicit and is never marked human-approved.
export function applyPageTranscripts(material,pages){
  if(material.ocrTextApprovedAt||material.ocr?.approvedAt)return false;
  const recovered=pages.filter(p=>['read','uncertain'].includes(p.transcript?.status));
  const replacements=recovered.filter(p=>p.transcript.text.trim());
  if(!replacements.length){material.needsOCR=pages.some(p=>p.status!=='done'||['unavailable','uncertain'].includes(p.transcript?.status));return false;}
  const previous=material.textRecovery?.sourceHash===material.sha256?material.textRecovery:null;
  const base=previous?previous.originalText:String(material.text||''),rich=previous?previous.originalRichText:material.richText;
  let text=base;const ranges=[];
  for(const p of replacements.sort((a,b)=>a.number-b.number)){
    const prefix='\n[第 '+p.number+' 页]\n',start=text.length+prefix.length;
    text+=prefix+p.transcript.text+'\n';ranges.push({page:p.number,start,end:start+p.transcript.text.length});
  }
  const hash=crypto.createHash('sha256').update(JSON.stringify([material.sha256,text,recovered.map(p=>p.transcript)])).digest('hex');
  material.text=text;
  if(rich)material.richText=rich;
  material.textRecovery={version:1,hash,sourceHash:material.sha256,nativeTextEnd:base.length,originalText:base,originalRichText:rich,
    pages:recovered.map(p=>({page:p.number,status:p.transcript.status,source:p.transcript.source,reference:p.reference,...ranges.find(r=>r.page===p.number)}))};
  material.needsOCR=pages.some(p=>['unavailable','uncertain'].includes(p.transcript?.status));
  delete material.documentView;
  return true;
}
