import {svgFitTree} from './svg-fitting.mjs';
import {serializeSVGTree} from './svg-tree.mjs';
import {vectorPathBounds} from './vector-path.mjs';
import {regularSVGFamily,sameRegularSVGBody} from './svg-regular-shapes.mjs';
import {pathD} from './vector-path.mjs';

const identity=m=>m.every((v,i)=>Math.abs(v-[1,0,0,1,0,0][i])<1e-8);
const rgb=v=>/^#[\da-f]{6}$/i.test(v||'')?v.slice(1).match(/../g).map(v=>parseInt(v,16)):null;

// Proposals may replace a simple internal symbol, never its badge shell or lighting.
export function svgDetailRegion(svg){
 const tree=svgFitTree(svg),view=tree.root.attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
 if(!view||view.length!==4||!view.every(Number.isFinite))return null;
 const [x,y,w,h]=view;if(w<=0||h<=0)return null;
 const eligible=tree.layers.flatMap((l,i)=>{
  if(!identity(l.matrix)||l.parents.some(p=>p.attrs?.filter||p.attrs?.mask||p.attrs?.['clip-path'])||l.node.attrs.filter)return [];
  const color=rgb(l.node.attrs.stroke)||rgb(l.node.attrs.fill),b=vectorPathBounds(l.path);
  if(!color||Math.min(...color)<170||Math.max(...color)-Math.min(...color)>65)return [];
  if(b.x<x+w*.15||b.y<y+h*.15||b.x+b.w>x+w*.85||b.y+b.h>y+h*.85||b.w*b.h>w*h*.5)return [];
  return [i];
 });
 if(!eligible.length)return null;
 return {indices:eligible,view,region:{x:-.12,y:-.12,w:1.24,h:1.85}};
}

export function replaceSVGDetail(svg,detail,proposal){
 if(!proposal?.path||!/^#[\da-f]{6}$/i.test(proposal.color))return null;
 const tree=svgFitTree(svg),targets=new Set(detail.indices.map(i=>tree.layers[i]?.node));
 const first=tree.layers[detail.indices[0]]?.node;let inserted=false;
 const paths=()=> (proposal.paths||[proposal.path]).map(d=>({name:'path',attrs:{d,fill:proposal.color,'fill-rule':'evenodd'},children:[]}));
 const existing=tree.layers[detail.indices[0]]?.parents.find(p=>p.attrs?.id==='nf-reference-symbol');
 if(existing&&detail.indices.every(i=>tree.layers[i]?.parents.includes(existing))){existing.children=paths();return serializeSVGTree(tree.root);}
 const visit=node=>{node.children=node.children.flatMap(child=>{
  if(!targets.has(child)){visit(child);return [child];}
  if(child!==first||inserted)return [];
  inserted=true;return [{name:'g',attrs:{id:'nf-reference-symbol'},children:paths()}];
 });};visit(tree.root);
 return inserted?serializeSVGTree(tree.root):null;
}

export function replaceSVGWholeGeometry(svg,detail,proposal){
 if(!proposal?.shell?.length||!proposal.detail)return null;
 const tree=svgFitTree(svg),shells=tree.layers.filter(l=>regularSVGFamily(l)==='hexagon');
 const anchor=shells.sort((a,b)=>{const x=vectorPathBounds(a.path),y=vectorPathBounds(b.path);return y.w*y.h-x.w*x.h;})[0];
 if(!anchor)return null;
 const a=vectorPathBounds(anchor.path);
 for(const layer of tree.layers.filter(l=>sameRegularSVGBody(anchor,l))){
  const b=vectorPathBounds(layer.path);
  const points=proposal.shell.map(([x,y])=>[x+(b.x+b.w/2-a.x-a.w/2),y+(b.y+b.h/2-a.y-a.h/2)]);
  if(layer.node.name==='polygon')layer.node.attrs.points=points.map(p=>p.join(',')).join(' ');
  else layer.node.attrs.d=pathD([...points.map((p,i)=>({op:i?'L':'M',points:[p]})),{op:'Z',points:[]}]);
 }
 // Both shell and symbol are replaced in this candidate, using the same measured box.
 const rebuilt=replaceSVGDetail(serializeSVGTree(tree.root),detail,proposal.detail);
 if(!rebuilt)return null;
 const combined=svgFitTree(rebuilt).root,definitions=combined.children.filter(n=>n.name==='defs'),body=combined.children.filter(n=>n.name!=='defs');
 combined.children=[...definitions,{name:'g',attrs:{id:'nf-reference-whole'},children:body}];
 return serializeSVGTree(combined);
}

export function svgPaletteColors(svg){
 const colors=[];for(const match of svg.matchAll(/\b(?:fill|stroke|stop-color)="(#[\da-f]{6})"/gi)){
  const color=match[1].toUpperCase();if(!colors.includes(color))colors.push(color);
 }return colors.slice(0,8);
}

export function replaceSVGPalette(svg,changes){
 const colors=new Map(changes.map(c=>[c.from.toUpperCase(),c.to]));
 return svg.replace(/\b(fill|stroke|stop-color)="(#[\da-f]{6})"/gi,(m,field,color)=>colors.has(color.toUpperCase())?field+'="'+colors.get(color.toUpperCase())+'"':m);
}
