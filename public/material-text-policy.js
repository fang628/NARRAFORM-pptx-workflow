// Match the document extractor's existing capacity across reading and source references.
export const materialTextLimit=120_000;
export const materialText=material=>String(material?.text||'').slice(0,materialTextLimit);
export function readingCoversMaterial(reading,material){
  if(reading.status!=='read'||reading.coverage==='image')return true;
  return Number(reading.readChars)>=materialText(material).length;
}
