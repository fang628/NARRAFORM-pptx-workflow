import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {renderSVG} from './render-pool.mjs';
export const svgViewportVersion=2;
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const number=v=>String(Math.round(v*100000)/100000);
const attr=(root,key)=>root.match(new RegExp('\\b'+key+'\\s*=\\s*["\']([^"\']*)["\']'))?.[1];
function rootAttrs(svg,values){return svg.replace(/<svg\b[^>]*>/,root=>{for(const [key,value]of Object.entries(values)){const pattern=new RegExp('\\s'+key+'\\s*=\\s*["\'][^"\']*["\']');root=pattern.test(root)?root.replace(pattern,' '+key+'="'+value+'"'):root.replace(/>$/,' '+key+'="'+value+'">');}return root;});}
export async function preserveSVGViewport(svg,element,signal){
 const root=svg.match(/<svg\b[^>]*>/)?.[0],view=attr(root||'','viewBox')?.split(/[\s,]+/).filter(Boolean).map(Number);
 if(!view||view.length!==4||view.some(v=>!Number.isFinite(v))||view[2]<=0||view[3]<=0||/\bslice\b/.test(attr(root,'preserveAspectRatio')||''))return {svg,element,changed:false};
 const [vx,vy,vw,vh]=view,ratio=attr(root,'preserveAspectRatio')||'xMidYMid meet',none=ratio==='none',scale= Math.min(element.w/vw,element.h/vh),sx=none?element.w/vw:scale,sy=none?element.h/vh:scale;
 const blankX=none?0:element.w-vw*scale,blankY=none?0:element.h-vh*scale,ox=/xMin/.test(ratio)?0:/xMax/.test(ratio)?blankX:blankX/2,oy=/YMin/.test(ratio)?0:/YMax/.test(ratio)?blankY:blankY/2;
 const base={x:vx-ox/sx,y:vy-oy/sy,w:element.w/sx,h:element.h/sy};
 const geometry=(await renderSVG(svg,{font:{loadSystemFonts:false},__measurePaint:'geometry'},signal)).bounds;if(!geometry)return {svg,element,changed:false};
 const effects=/<filter\b/.test(svg)?Math.min(Math.max(vw,vh)*.5,Math.max(0,...[...svg.matchAll(/\bstdDeviation=["']([\d.]+)/g)].map(m=>Number(m[1])))*3+Math.max(0,...[...svg.matchAll(/\b(?:dx|dy)=["'](-?[\d.]+)/g)].map(m=>Math.abs(Number(m[1]))))+2):0;
 const left=Math.min(base.x,geometry.x-effects),top=Math.min(base.y,geometry.y-effects),right=Math.max(base.x+base.w,geometry.x+geometry.w+effects),bottom=Math.max(base.y+base.h,geometry.y+geometry.h+effects);
 if(right-left>base.w*4||bottom-top>base.h*4)return {svg,element,changed:false,status:'excessive-overflow'};
 if(left>=base.x-.01&&top>=base.y-.01&&right<=base.x+base.w+.01&&bottom<=base.y+base.h+.01)return {svg,element,changed:false};
 const overscan={x:left-1,y:top-1,w:right-left+2,h:bottom-top+2},renderScale=Math.min(2,800/Math.max(overscan.w,overscan.h));
 const probe=rootAttrs(svg,{viewBox:[overscan.x,overscan.y,overscan.w,overscan.h].map(number).join(' '),width:String(Math.max(1,Math.round(overscan.w*renderScale))),height:String(Math.max(1,Math.round(overscan.h*renderScale))),preserveAspectRatio:'none'});
 const measured=await renderSVG(probe,{font:{loadSystemFonts:false},__measurePaint:'paint'},signal);if(!measured.paint)return {svg,element,changed:false};
 const p=measured.paint,px=overscan.w/measured.width,py=overscan.h/measured.height;
 const x=Math.min(base.x,overscan.x+p.x*px-px),y=Math.min(base.y,overscan.y+p.y*py-py),r=Math.max(base.x+base.w,overscan.x+(p.x+p.w)*px+px),b=Math.max(base.y+base.h,overscan.y+(p.y+p.h)*py+py);
 if(base.x-x<.01&&base.y-y<.01&&r-base.x-base.w<.01&&b-base.y-base.h<.01)return {svg,element,changed:false};
 const box={x:element.x+(x-base.x)*sx,y:element.y+(y-base.y)*sy,w:(r-x)*sx,h:(b-y)*sy};
 // Preserve the complete asset and off-slide coordinates; only the slide's
 // visible render is bounded. Do not clip its path or shrink the artwork.
 const next=rootAttrs(svg,{viewBox:[x,y,r-x,b-y].map(number).join(' '),width:String(Math.max(1,Math.ceil(box.w*1.2))),height:String(Math.max(1,Math.ceil(box.h*1.2))),preserveAspectRatio:'none'});
 return {svg:next,element:{...element,...box},changed:true,padding:{left:(base.x-x)*sx,top:(base.y-y)*sy,right:(r-base.x-base.w)*sx,bottom:(b-base.y-base.h)*sy},originalBox:{x:element.x,y:element.y,w:element.w,h:element.h}};
}
export async function ensureSVGViewports(project,env,pages,signal){
 const changes=[];
 for(const [index,page]of pages){
  for(const [position,e]of page.elements.entries()){
   if(e.type!=='image'||e.implementation!=='svg'||e.svgViewportAsset===e.id)continue;
   const material=project.materials.find(m=>m.id===e.id),file=material&&env.getImage(project,e.id);if(!file||!fs.existsSync(file))continue;
   const source=fs.readFileSync(file,'utf8'),result=await preserveSVGViewport(source,e,signal);
   if(!result.changed){page.elements[position]={...e,svgViewportAsset:e.id};continue;}
   const sha256=hash(result.svg),existing=project.materials.find(m=>m.sha256===sha256&&m.svg),id=existing?.id||crypto.randomUUID();
   if(!existing){const name=id+'.svg',target=path.join(env.data,project.id,'assets',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,result.svg);project.materials.push({...material,id,file:name,sha256,size:Buffer.byteLength(result.svg),rebuildIdentity:undefined,parentAssetId:e.id,origin:'svg-viewport-preserved',svgViewportVersion,svg:true,generated:true,reconstructed:true,purpose:'reconstruction'});}
   page.elements[position]={...result.element,id,svgViewportAsset:id};changes.push({index,key:e.key,padding:result.padding,originalBox:result.originalBox});
  }
 }
 return changes;
}
