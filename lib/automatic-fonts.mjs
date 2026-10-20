import {unifyTitleFonts} from './title-fonts.mjs';
import {availableNativeFonts,neededOpenFonts,resolveNativeFonts} from './native-fonts.mjs';
import {installOpenFonts} from './open-fonts.mjs';
import {reportTask} from './task-progress.mjs';

// Share attempts across concurrent pages and repair rounds of one task. A new
// task may retry failures; a failed download never blocks the remaining deck.
const sessions=new WeakMap();
export async function prepareElementFonts(p,env,elements,signal,{inventory=availableNativeFonts,installer=installOpenFonts}={}){
  signal?.throwIfAborted();
  let session=signal&&sessions.get(signal);
  if(!session){session={attempted:new Set(),tail:Promise.resolve()};if(signal)sessions.set(signal,session);}
  const job=session.tail.catch(()=>{}).then(async()=>{
    signal?.throwIfAborted();
    let fonts=await inventory();
    const needed=neededOpenFonts(elements,fonts).filter(f=>!session.attempted.has(f.id));
    if(needed.length&&env.data&&env.root){
      needed.forEach(f=>session.attempted.add(f.id));
      const result=await installer(env,{signal,catalog:needed,inventory,onProgress:message=>reportTask(signal,{kind:'step',message:'自动补齐字体：'+message})});
      const merged=new Map((p.openFontSupport?.mode==='automatic'?p.openFontSupport.fonts:[]).map(f=>[f.id,f]));
      result.fonts.forEach(f=>merged.set(f.id,f));
      p.openFontSupport={...result,mode:'automatic',fonts:[...merged.values()]};
      p.openFontSupport.status=p.openFontSupport.fonts.some(f=>f.status==='failed')?'partial':'done';
      env.save?.(p);
      fonts=await inventory({refresh:true});
    }
    const resolved=resolveNativeFonts(elements,fonts),unified=unifyTitleFonts(p,resolved.elements,fonts);
    return {elements:unified.elements,changes:[...resolved.changes,...unified.changes],fonts};
  });
  session.tail=job;return job;
}
