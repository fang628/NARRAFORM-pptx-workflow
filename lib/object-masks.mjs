import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {nativeSVG} from './visual-model.mjs';
import {renderSVG} from './render-pool.mjs';

// Predicted alpha is evidence about visibility, never a reference segmentation.
// Render through the same scene geometry, so holes, outline-only frames,
// gradients, transforms and SVG assets retain their actual support.
export async function buildObjectMasks({elements,directory,getImage,signal,render=renderSVG}){
  if(!elements.length)return [];
  fs.mkdirSync(directory,{recursive:true});
  const entries=[];
  const renderElement=async element=>{
    signal?.throwIfAborted();
    if(!element?.key||element.role==='background'||element.managed)return null;
    if(!['rect','ellipse','shape','line','svg','image','text','formula'].includes(element.type))return null;
    try{
      let inline,object=element;
      if(element.type==='svg'){
        if(typeof element.svg!=='string')return null;
        if(element.svg.length>180000||/<(?:image|script|style|foreignObject|text)\b|<!/i.test(element.svg)||[...element.svg.matchAll(/(?:href|xlink:href)\s*=\s*["']([^"']*)["']/gi)].some(m=>!m[1].startsWith('#'))||[...element.svg.matchAll(/url\(([^)]*)\)/gi)].some(m=>!m[1].trim().replace(/^["']|["']$/g,'').startsWith('#')))throw Error('mask SVG contains non-geometric resources');
        inline='data:image/svg+xml;base64,'+Buffer.from(element.svg).toString('base64');
        object={...element,type:'image',id:'__inline_mask',shadow:undefined};
      }
      const imageURL=id=>{
        if(id==='__inline_mask')return inline;
        const file=getImage?.(id);if(!file)throw Error('mask asset unavailable');
        if(file.startsWith('data:'))return file;
        const bytes=fs.readFileSync(file),mime=path.extname(file).toLowerCase()==='.svg'?'image/svg+xml':'image/png';
        return 'data:'+mime+';base64,'+bytes.toString('base64');
      };
      const svg=nativeSVG([{...object,fill:object.fill||'FFFFFF',color:object.color||'FFFFFF'}],imageURL);
      const digest=crypto.createHash('sha256').update('object-alpha-v2\n'+svg).digest('hex');
      const file=path.join(directory,digest+'.png');
      if(!fs.existsSync(file)){
        const bytes=await render(svg,{fitTo:{mode:'width',value:1600},font:{loadSystemFonts:true}},signal);
        signal?.throwIfAborted();if(!fs.existsSync(file))fs.writeFileSync(file,bytes);
      }
      return {key:element.key,file,hash:digest,predicted:true};
    }catch(error){
      if(signal?.aborted)throw error;
      return {key:element.key,predicted:true,unavailable:true};
    }
  };
  for(let start=0;start<elements.length;start+=4){
    entries.push(...(await Promise.all(elements.slice(start,start+4).map(renderElement))).filter(Boolean));
  }
  return entries;
}
