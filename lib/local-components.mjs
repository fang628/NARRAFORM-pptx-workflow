// Component identity is independent of the mutable measured shape/paint fields.
import {registerNativePolylines,connectNativePolylines} from './native-polylines.mjs';
export const localComponentVersion=2;
const box=e=>Object.fromEntries(['x','y','w','h'].map(k=>[k,e[k]]));
const valid=e=>e&&['x','y','w','h'].every(k=>Number.isFinite(e[k]))&&e.w>0&&e.h>0;
const inside=(a,b,pad=4)=>a.x-pad<=b.x&&a.y-pad<=b.y&&a.x+a.w+pad>=b.x+b.w&&a.y+a.h+pad>=b.y+b.h;
const native=e=>['shape','rect','ellipse'].includes(e.type)&&!e.managed&&!e.effectOf;
const area=e=>e.w*e.h;
const union=es=>{const x=Math.min(...es.map(e=>e.x)),y=Math.min(...es.map(e=>e.y));return {x,y,w:Math.max(...es.map(e=>e.x+e.w))-x,h:Math.max(...es.map(e=>e.y+e.h))-y};};

export function registerLocalComponents(elements,{nodes=[],previous=[]}={}){
 const old=new Map(previous.map(e=>[e.key,e.objectIdentity])),byNode=new Map(nodes.map(n=>[n.id,n]));
 const out=elements.map(e=>({...e,objectIdentity:structuredClone(e.objectIdentity||old.get(e.key)||{
  version:localComponentVersion,key:e.key,type:e.type,role:e.role||null,nodeId:e.nodeId||null,materialId:e.type==='image'?e.id||null:null,
  expectedShape:e.shape||e.type,sourceBox:box(e),
 })}));
 const byKey=new Map(out.map(e=>[e.key,e]));
 const assign=(kind,anchor,members)=>{
  const id='lc-'+kind+'-'+anchor.key;
  for(const e of members){
   if(e.managed||e.role==='effect'||e.effectOf)continue;
   const existing=e.objectIdentity.component;
   if(existing&&existing.id!==id)continue;
   e.objectIdentity={...e.objectIdentity,component:existing||{id,kind,anchor:anchor.key,
    referenceAnchor:box(anchor),reference:box(e)}};
  }
 };
 // Existing relations own membership even after a local fit moves a child outside its host.
 const unbound=e=>!e.objectIdentity.component&&!e.managed&&!e.effectOf&&e.role!=='effect';
 const tables=new Map();
 for(const e of out)if(e.tableId&&!e.managed){const list=tables.get(e.tableId)||[];list.push(e);tables.set(e.tableId,list);}
 for(const members of tables.values())if(members.length>=2){
  const anchor=members.find(e=>e.tableObject)||members.find(e=>['base','outer','container'].includes(e.tableRole))||members[0];
  assign('table',anchor,members);
 }
 for(const text of out.filter(e=>e.type==='text'&&(e.role==='visual-number'||e.role==='toc-number'||e.part==='number')&&unbound(e))){
  const source=text.objectIdentity.sourceBox;
  const explicit=byKey.get(text.carrierId)||byKey.get(text.parentKey);
  const candidates=out.filter(e=>e.type==='ellipse'&&unbound(e)&&inside(e,{x:source.x+source.w/2,y:source.y+source.h/2,w:0,h:0},0));
  const anchor=explicit?.type==='ellipse'&&unbound(explicit)?explicit:candidates.length===1?candidates[0]:null;
  if(anchor)assign('number-badge',anchor,[anchor,text]);
 }
 for(const formula of out.filter(e=>e.type==='formula'&&unbound(e))){
  const explicit=byKey.get(formula.carrierId)||byKey.get(formula.parentKey);
  const available=e=>unbound(e)||e.objectIdentity.component?.kind==='formula-frame'&&e.objectIdentity.component.anchor===e.key;
  const candidates=out.filter(e=>native(e)&&e.type!=='ellipse'&&available(e)&&inside(e,formula)).sort((a,b)=>area(a)-area(b));
  const anchor=explicit&&native(explicit)&&available(explicit)?explicit:candidates[0];
  if(anchor&&area(anchor)<area(formula)*5)assign('formula-frame',anchor,[anchor,formula]);
 }
 for(const image of out.filter(e=>e.type==='image'&&!e.implementation&&unbound(e))){
  const captions=out.filter(e=>e.type==='text'&&e.role==='caption'&&unbound(e)
   &&(image.nodeId&&byNode.get(e.nodeId)?.parentId===image.nodeId||e.carrierId===image.key||e.parentKey===image.key));
  if(captions.length)assign('image-caption',image,[image,...captions]);
 }
 return registerNativePolylines(out);
}

export function localComponentInventory(elements){
 const groups=new Map();
 for(const e of elements){const c=e.objectIdentity?.component;if(!c)continue;
  if(!groups.has(c.id))groups.set(c.id,{id:c.id,kind:c.kind,anchor:c.anchor,members:[]});
  groups.get(c.id).members.push(e.key);
 }
 return [...groups.values()].filter(c=>c.members.length>=2&&c.members.includes(c.anchor));
}

export function localComponentSnapshot(elements,{measurements=[]}={}){
 const measured=new Map(measurements.map(m=>[m.key,m]));
 return {version:localComponentVersion,objects:Object.fromEntries(elements.map(e=>[e.key,structuredClone(e.objectIdentity)])),
  components:localComponentInventory(elements),parameters:Object.fromEntries(elements.map(e=>[e.key,{
   geometry:{...box(e),shape:e.shape,shapeGeometry:e.shapeGeometry,customGeometry:e.customGeometry,flipH:e.flipH,flipV:e.flipV},
   paint:{fill:e.fill,gradient:e.gradient,color:e.color,strokeGradient:e.strokeGradient,strokeWidth:e.strokeWidth},
   text:{text:e.text,latex:e.latex,fontFace:e.fontFace,size:e.size,align:e.align,valign:e.valign,bold:e.bold,italic:e.italic},
   assetId:e.type==='image'?e.id:undefined,measurement:measured.get(e.key),
   evidence:{geometry:e.geometryEvidence,parameters:e.parameterEvidence},
  }]))};
}

// Apply only component-relative placement. Table anchors stay owned by table-text-layout.
export function placeLocalComponents(elements,{measurements=[],targetKeys=null}={}){
 const connected=connectNativePolylines(elements,{targetKeys});
 const out=connected.elements,byKey=new Map(out.map(e=>[e.key,e])),metrics=new Map(measurements.map(m=>[m.key,m]));
 const targets=targetKeys?new Set(targetKeys):null,changes=[...connected.changes],issues=[...connected.issues];
 for(const c of localComponentInventory(out)){
  if(c.kind==='table'||c.kind==='native-polyline')continue;
  const anchor=byKey.get(c.anchor);if(!valid(anchor)||anchor.rotate||anchor.flipH||anchor.flipV)continue;
  for(const key of c.members){
   const child=byKey.get(key);if(key===c.anchor||targets&&!targets.has(key))continue;
   const relation=child.objectIdentity.component,r=relation.reference,a=relation.referenceAnchor;
   if(!valid(r)||!valid(a))continue;
   const before=box(child),m=metrics.get(key),ink=m&&[m.boundLeft,m.boundTop,m.boundWidth,m.boundHeight].every(Number.isFinite);
   let x,y;
   if(c.kind==='number-badge'){
    const ox=(r.x+r.w/2-a.x-a.w/2)/a.w,oy=(r.y+r.h/2-a.y-a.h/2)/a.h;
    x=anchor.x+anchor.w*(.5+ox)-(ink?m.boundWidth:child.w)/2;
    y=anchor.y+anchor.h*(.5+oy)-(ink?m.boundHeight:child.h)/2;
    if(ink){x-=m.boundLeft-child.x;y-=m.boundTop-child.y;}
   }else if(c.kind==='image-caption'){
    const top=r.y+r.h<=a.y+4;
    const bottom=r.y>=a.y+a.h-4;
    if(!top&&!bottom){issues.push({component:c.id,key,reason:'caption-side-unresolved'});continue;}
    const gap=top?a.y-r.y-r.h:r.y-a.y-a.h;
    x=child.align==='center'?anchor.x+anchor.w/2+(r.x+r.w/2-a.x-a.w/2)-child.w/2:
      child.align==='right'?anchor.x+anchor.w-(a.x+a.w-r.x-r.w)-child.w:anchor.x+(r.x-a.x);
    y=top?anchor.y-gap-child.h:anchor.y+anchor.h+gap;
   }else if(c.kind==='formula-frame'){
    const inset={left:r.x-a.x,right:a.x+a.w-r.x-r.w,top:r.y-a.y,bottom:a.y+a.h-r.y-r.h};
    if(Object.values(inset).some(v=>v< -4)){issues.push({component:c.id,key,reason:'reference-formula-outside-frame'});continue;}
    const width=ink?m.boundWidth:child.w,height=ink?m.boundHeight:child.h;
    if(width>anchor.w-inset.left-inset.right+2||height>anchor.h-inset.top-inset.bottom+2){issues.push({component:c.id,key,reason:'formula-does-not-fit-frame'});continue;}
    const cx=anchor.x+inset.left+(anchor.w-inset.left-inset.right)/2;
    const cy=anchor.y+inset.top+(anchor.h-inset.top-inset.bottom)/2;
    x=cx-width/2-(ink?m.boundLeft-child.x:0);y=cy-height/2-(ink?m.boundTop-child.y:0);
   }
   if(!Number.isFinite(x)||!Number.isFinite(y))continue;
   if(Math.abs(x-child.x)<.75&&Math.abs(y-child.y)<.75)continue;
   // Keep placement in its host neighbourhood; do not globally lay out the page.
   const trial={...child,x,y};
   const hit=out.some(e=>!c.members.includes(e.key)&&['text','formula','image'].includes(e.type)
    &&Math.max(0,Math.min(x+child.w,e.x+e.w)-Math.max(x,e.x))*Math.max(0,Math.min(y+child.h,e.y+e.h)-Math.max(y,e.y))>
      Math.max(0,Math.min(child.x+child.w,e.x+e.w)-Math.max(child.x,e.x))*Math.max(0,Math.min(child.y+child.h,e.y+e.h)-Math.max(child.y,e.y))+2);
   if(hit){issues.push({component:c.id,key,reason:'component-placement-overlap'});continue;}
   Object.assign(child,trial);changes.push({key,component:c.id,before,after:box(child),method:'local-component-anchor'});
  }
 }
 return {elements:out,changes,issues};
}

export function componentBounds(elements,component){return union(elements.filter(e=>component.members.includes(e.key)));}

// Explicit child edits define a new local relation; anchor-only edits keep the prior relation.
export function rebaseLocalComponentRelations(before,after){
 const old=new Map(before.map(e=>[e.key,e])),byKey=new Map(after.map(e=>[e.key,e]));
 return after.map(e=>{
  const c=e.objectIdentity?.component,prior=old.get(e.key),anchor=c&&byKey.get(c.anchor);
  if(!c||c.kind==='table'||c.kind==='native-polyline'||e.key===c.anchor||!prior||!valid(anchor)
   ||['x','y','w','h'].every(k=>e[k]===prior[k]))return e;
  return {...e,objectIdentity:{...e.objectIdentity,component:{...c,reference:box(e),referenceAnchor:box(anchor)}}};
 });
}
