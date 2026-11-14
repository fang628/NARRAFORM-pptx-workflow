// Normalize identities before representation routing. Inventories describe the
// current objects; they must never turn a corrected connector back into a frame.
import {retainParameterEvidence} from './parameter-confidence.mjs';
export function normalizeAuditIdentities(raw,previous){
  if(!Array.isArray(raw?.elements))return raw;
  const elements=raw.elements.map(e=>{
    const next=e?.type==='text'&&e.role==='visual-number'&&e.numberKind==='ordinal'
      ?{...e,nodeId:'visual-number-'+e.key,...(!e.sourceBox&&['x','y','w','h'].every(k=>Number.isFinite(e[k]))?{sourceBox:{x:e.x,y:e.y,w:e.w,h:e.h}}:{})}:{...e};
    if(Array.isArray(next.shapeGeometry?.corners)&&next.shapeGeometry.corners.length===0){const {corners,...geometry}=next.shapeGeometry;next.shapeGeometry=geometry;}
    // A single sharp-corner token is a redundant preset hint when a complete
    // custom path already owns every vertex, not a one-vertex contour.
    if(next.customGeometry&&next.shapeGeometry?.corners?.length===1&&next.shapeGeometry.corners[0]?.type==='sharp')delete next.shapeGeometry;
    if(next.type==='text'&&next.part==='lead')next.part='label';
    const prior=previous?.elements?.find(old=>old.key===next.key);
    if(prior?.objectIdentity)next.objectIdentity=structuredClone(prior.objectIdentity);
    return retainParameterEvidence(prior,next);
  });
  const byKey=new Map(elements.map(e=>[e.key,e])),old=previous?.elements||[];
  const renamed=new Map();
  for(const e of old)if(!byKey.has(e.key)&&e.role==='visual-number'){
    const matches=elements.filter(n=>n.role==='visual-number'&&n.forNodeId===e.forNodeId&&n.text===e.text);
    if(matches.length===1)renamed.set(e.key,matches[0].key);
  }
  const resolve=key=>renamed.get(key)||key;
  const frame=e=>e&&e.type!=='line'&&e.arrowRole!=='connector'&&e.role!=='effect'&&!e.effectOf&&e.visualKind!=='light-effect';
  const next={...raw,elements:elements.map(e=>{
    if(frame(e))return e;
    const {frameKind,nativeRequired,isFrame,...rest}=e;return rest;
  })};
  if(raw.frameInventory)next.frameInventory=raw.frameInventory.filter(f=>!byKey.has(f.key)||frame(byKey.get(f.key)));
  if(raw.numberInventory)next.numberInventory=raw.numberInventory.map(n=>({...n,key:resolve(n.key)}));
  if(raw.layerInventory)next.layerInventory=raw.layerInventory.map(n=>({...n,key:resolve(n.key),frontOf:Array.isArray(n.frontOf)?n.frontOf.map(resolve):n.frontOf}));
  for(const e of next.elements)for(const field of ['carrierId','parentKey','effectOf'])if(e[field])e[field]=resolve(e[field]);
  return next;
}
