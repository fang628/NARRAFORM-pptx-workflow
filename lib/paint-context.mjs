import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileDigest} from './file-digest.mjs';
import {buildObjectMasks} from './object-masks.mjs';
import {nativeSVG} from './visual-model.mjs';
import {renderSVG} from './render-pool.mjs';

const cache=new Map();
const dataURL=file=>'data:'+(file.endsWith('.svg')?'image/svg+xml':'image/png')+';base64,'+fs.readFileSync(file).toString('base64');
const alphaFunction=gradient=>!gradient?.stops?.some(stop=>(stop.opacity??1)<.999)?1:
  {type:gradient.type,angle:gradient.angle,center:gradient.center,stops:gradient.stops.map(stop=>[stop.position,stop.opacity??1])};
export const paintCompositeSignature=elements=>JSON.stringify(elements.map(e=>[e.key,e.fill,e.gradient,e.color,e.strokeGradient,e.strokeWidth,e.opacity,e.fillOpacity,e.colorOpacity]));
export function paintSampleHash(reference,{masks=[],underlays={}}){
  const hash=crypto.createHash('sha256');
  for(const file of [reference,...masks.map(mask=>mask.file).filter(Boolean),...Object.values(underlays)])if(file)hash.update(fileDigest(file));
  return hash.digest('hex');
}
export const paintVisibilitySignature=elements=>JSON.stringify(elements.map(source=>{
  const element=source.strokeWidth===0&&source.type!=='line'?{...source,colorOpacity:undefined,strokeGradient:undefined}:source;
  return Object.fromEntries([
  'key','type','shape','x','y','w','h','rotate','flipH','flipV','shapeGeometry','customGeometry','linePath','id','svg','text','latex','size','fontFace','bold','italic',
  'opacity','fillOpacity','colorOpacity','strokeWidth','shadow','parentKey',
  'charSpacing','lineSpacing','align','valign','textColorRuns','boldRuns','outline','beginArrowType','endArrowType','beginArrowSize','endArrowSize',
].map(key=>[key,key==='shadow'?element[key]??undefined:element[key]]).concat([['fillAlpha',alphaFunction(element.gradient)],['strokeAlpha',alphaFunction(element.strokeGradient)]]));
}));
export async function preparePaintContext({env,project,index,preview,elements,background,signal}){
  const digest=crypto.createHash('sha256').update(JSON.stringify(elements));
  for(const file of [preview,background])if(file)digest.update(fileDigest(file));
  for(const element of elements)if(element.type==='image'){
    const file=env.getImage?.(project,element.id);if(file)digest.update(file.startsWith('data:')?file:fileDigest(file));
  }
  const directory=path.join(env.data,project.id,'geometry-records','paint-context','page-'+(index+1));
  const key=directory+'|'+digest.digest('hex'),existing=cache.get(key);if(existing)return existing;
  const urls=new Map(),prefixes=new Map();
  const resolve=id=>{
    if(!urls.has(id)){
      const file=id==='__background'?background:env.getImage?.(project,id);
      urls.set(id,file?(file.startsWith('data:')?file:dataURL(file)):'');
    }
    return urls.get(id);
  };
  const masks=await buildObjectMasks({elements,directory:path.join(directory,'masks'),getImage:resolve,signal});
  const underlays={};
  for(const [position,element]of elements.entries()){
    if(!['shape','rect','ellipse','line'].includes(element.type)||element.managed)continue;
    // Exterior effects also need the true lower composite, including opaque
    // nested shapes. Prefix PNGs are shared/cached across targets.
    const overlaps=other=>other.x<element.x+element.w+30&&other.x+other.w>element.x-30&&other.y<element.y+element.h+30&&other.y+other.h>element.y-30;
    const lower=elements.slice(0,position).filter(other=>!other.managed&&overlaps(other));
    if(lower.some(other=>!['rect','ellipse','shape','line','image','text','formula'].includes(other.type)))continue;
    if(!lower.length&&background){underlays[element.key]=background;continue;}
    if(!background)continue;
    const sequence=JSON.stringify(lower.map(other=>other.key));
    if(prefixes.has(sequence)){underlays[element.key]=prefixes.get(sequence);continue;}
    if(lower.some(other=>other.type==='image'&&!resolve(other.id)))continue;
    const markup=nativeSVG(lower,resolve,background?{id:'__background'}:null);
    const prefix=crypto.createHash('sha256').update(markup).digest('hex');
    const prefixDirectory=path.join(env.data,project.id,'geometry-records','paint-underlays');
    fs.mkdirSync(prefixDirectory,{recursive:true});
    const file=path.join(prefixDirectory,prefix+'.png');
    if(!fs.existsSync(file))fs.writeFileSync(file,await renderSVG(markup,{fitTo:{mode:'width',value:1600}},signal));
    prefixes.set(sequence,file);
    underlays[element.key]=file;
  }
  const result={masks,underlays};cache.set(key,result);if(cache.size>12)cache.delete(cache.keys().next().value);
  return result;
}
