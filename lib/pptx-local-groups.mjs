import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {componentBounds} from './local-components.mjs';
const P='http://schemas.openxmlformats.org/presentationml/2006/main';
const A='http://schemas.openxmlformats.org/drawingml/2006/main';
const shapes=new Set(['sp','pic','cxnSp','graphicFrame','grpSp']);
const elements=node=>Array.from(node.childNodes||[]).filter(n=>n.nodeType===1);
const key=node=>node.getElementsByTagNameNS(P,'cNvPr')[0]?.getAttribute('name')?.replace(/^!!nf-page-\d+--/,'');
const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;

// Preserve child IDs and page-space coordinates via an identity child transform.
// An outside object may be crossed only when its paint box is disjoint from members.
export function groupSlideComponents(xml,scene,components){
 const doc=new DOMParser().parseFromString(xml,'application/xml'),tree=doc.getElementsByTagNameNS(P,'spTree')[0];
 if(!tree)throw Error('Missing slide shape tree');
 const byKey=new Map(scene.map(e=>[e.key,e])),records=[];
 let nextId=Math.max(1,...Array.from(doc.getElementsByTagNameNS(P,'cNvPr')).map(n=>Number(n.getAttribute('id'))||0))+1;
 const make=(ns,name,attrs={})=>{const n=doc.createElementNS(ns,name);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,String(v));return n;};
 for(const c of components){
  const top=elements(tree).filter(n=>n.namespaceURI===P&&shapes.has(n.localName));
  const members=top.filter(n=>c.members.includes(key(n)));
  if(members.length!==c.members.length){records.push({...c,status:'skipped',reason:'missing-or-nested-member'});continue;}
  if(members.some(n=>n.localName==='graphicFrame')){records.push({...c,status:'skipped',reason:'native-graphic-frame'});continue;}
  const first=Math.min(...members.map(n=>top.indexOf(n))),last=Math.max(...members.map(n=>top.indexOf(n)));
  const outsiders=top.slice(first,last+1).filter(n=>!members.includes(n));
  const unsafe=outsiders.some(n=>{const other=byKey.get(key(n));return !other||c.members.some(k=>{
   const e=byKey.get(k);if(!e)return true;
   const pad=Math.max(4,e.strokeWidth||0,e.shadow?.blur||0,other.strokeWidth||0,other.shadow?.blur||0);
   return overlap({x:e.x-pad,y:e.y-pad,w:e.w+pad*2,h:e.h+pad*2},other);
  });});
  if(unsafe){records.push({...c,status:'skipped',reason:'interleaved-overlapping-object'});continue;}
  const b=componentBounds(scene,c),scale=7620; // 1600 logical units = 13 1/3 inches.
  const x=Math.round(b.x*scale),y=Math.round(b.y*scale),w=Math.max(1,Math.round(b.w*scale)),h=Math.max(1,Math.round(b.h*scale));
  const group=make(P,'p:grpSp'),nv=make(P,'p:nvGrpSpPr');
  nv.appendChild(make(P,'p:cNvPr',{id:nextId++,name:c.id}));nv.appendChild(make(P,'p:cNvGrpSpPr'));nv.appendChild(make(P,'p:nvPr'));
  group.appendChild(nv);
  const props=make(P,'p:grpSpPr'),transform=make(A,'a:xfrm');
  for(const [name,attrs]of [['a:off',{x,y}],['a:ext',{cx:w,cy:h}],['a:chOff',{x,y}],['a:chExt',{cx:w,cy:h}]])transform.appendChild(make(A,name,attrs));
  props.appendChild(transform);group.appendChild(props);tree.insertBefore(group,members[0]);
  for(const node of members)group.appendChild(node);
  records.push({...c,status:'grouped',bounds:b});
 }
 return {xml:new XMLSerializer().serializeToString(doc),records};
}
