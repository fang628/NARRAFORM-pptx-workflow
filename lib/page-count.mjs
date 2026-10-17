import {optionalPageCount} from '../public/page-count.js';
export {optionalPageCount};

// Recommendation is advisory: missing or malformed model output must not discard material analysis.
export function suggestPageCount(raw,{brief={},readings=[],outline=[]}={}){
  try{
    const pages=optionalPageCount(raw?.pages);
    if(pages)return {pages,source:'model'};
  }catch{}
  const points=readings.reduce((sum,r)=>sum+(r.keyPoints?.length||0)+(r.facts?.length||0),0);
  const chars=readings.reduce((sum,r)=>sum+(r.readChars||r.summary?.length||0),0);
  const images=readings.filter(r=>r.coverage==='image').length;
  const content=Math.max(1,outline.length,Math.ceil(points/4),Math.ceil(chars/1600),Math.ceil(images/2),readings.length?0:Math.ceil((brief.purpose?.length||0)/1000));
  const extras=Number(brief.cover!==false)+Number(!!brief.toc)+Number(!!brief.thanks);
  return {pages:Math.min(30,content+extras),source:'estimate'};
}
