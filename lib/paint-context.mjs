import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
  for(const file of [reference,...masks.map(mask=>mask.file).filter(Boolean),...Object.values(underlays)])if(file)hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}
export const paintVisibilitySignature=elements=>JSON.stringify(elements.map(source=>{
  const element=source.strokeWidth===0&&source.type!=='line'?{...source,colorOpacity:undefined,strokeGradient:undefined}:source;
  return Object.fromEntries([
  'key','type','shape','x','y','w','h','rotate','flipH','flipV','shapeGeometry','customGeometry','id','svg','text','latex','size','fontFace','bold','italic',
  'opacity','fillOpacity','colorOpacity','strokeWidth','shadow','glow','parentKey',
  'charSpacing','lineSpacing','align','valign','textColorRuns','boldRuns','outline',
].map(key=>[key,element[key]]).concat([['fillAlpha',alphaFunction(element.gradient)],['strokeAlpha',alphaFunction(element.strokeGradient)]]));
}));
export async function preparePaintContext({env,project,index,preview,elements,background,signal}){
  const digest=crypto.createHash('sha256').update(JSON.stringify(elements));
  for(const file of [preview,background])if(file)digest.update(fs.readFileSync(file));
  for(const element of elements)if(element.type==='image'){
    const file=env.getImage?.(project,element.id);if(file)digest.update(fs.readFileSync(file));
  }
  const key=env.data+'|'+project.id+'|'+digest.digest('hex'),existing=cache.get(key);if(existing)return existing;
  const directory=path.join(env.data,project.id,'geometry-records','paint-context','page-'+(index+1),key.split('|').at(-1));
  fs.mkdirSync(directory,{recursive:true});
  const masks=await buildObjectMasks({elements,directory:path.join(directory,'masks'),getImage:id=>env.getImage?.(project,id),signal});
  const underlays={};
  for(const [position,element]of elements.entries()){
    if(!['shape','rect','ellipse'].includes(element.type)||element.managed)continue;
    const transparent=(element.opacity??1)*(element.fillOpacity??1)<.98||element.gradient?.stops?.some(stop=>(stop.opacity??1)<.98)
      ||element.strokeWidth>0&&((element.opacity??1)*(element.colorOpacity??1)<.98||element.strokeGradient?.stops?.some(stop=>(stop.opacity??1)<.98));
    if(!transparent)continue;
    const overlaps=other=>other.x<element.x+element.w&&other.x+other.w>element.x&&other.y<element.y+element.h&&other.y+other.h>element.y;
    const prior=elements.slice(0,position).filter(other=>!other.managed);
    if(prior.some(other=>overlaps(other)&&!['rect','ellipse','shape','line','image','text','formula'].includes(other.type)))continue;
    const lower=prior.filter(other=>['rect','ellipse','shape','line','image','text','formula'].includes(other.type));
    const resolve=id=>id==='__background'?dataURL(background):env.getImage?.(project,id)?dataURL(env.getImage(project,id)):'';
    if(lower.some(other=>other.type==='image'&&overlaps(other)&&!env.getImage?.(project,other.id)))continue;
    const markup=nativeSVG(lower,resolve,background?{id:'__background'}:null);
    const prefix=crypto.createHash('sha256').update(markup).digest('hex');
    const prefixDirectory=path.join(env.data,project.id,'geometry-records','paint-underlays');
    fs.mkdirSync(prefixDirectory,{recursive:true});
    const file=path.join(prefixDirectory,prefix+'.png');
    if(!fs.existsSync(file))fs.writeFileSync(file,await renderSVG(markup,{fitTo:{mode:'width',value:1600}},signal));
    underlays[element.key]=file;
  }
  const result={masks,underlays};cache.set(key,result);if(cache.size>12)cache.delete(cache.keys().next().value);
  return result;
}
