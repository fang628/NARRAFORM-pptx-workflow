// Per-request budget and stored addressable source have separate limits.
export const materialTextLimit=120_000;
export const materialSourceLimit=2_000_000;
export const materialText=material=>String(material?.text||'').slice(0,materialSourceLimit);
export function readingCoversMaterial(reading,material){
  if(reading.status!=='read')return false;
  if(reading.coverage==='image')return material?.kind==='image';
  if(materialText(material).length>materialTextLimit&&reading.informationIndex?.version!==1)return false;
  if(reading.sourceRecoveryHash!==(material?.textRecovery?.hash||undefined))return false;
  return Number(reading.readChars)>=materialText(material).length;
}
