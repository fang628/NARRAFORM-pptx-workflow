import crypto from 'node:crypto';
import fs from 'node:fs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,stable(value[k])])):value;
const svgSource=svg=>String(svg||'').trim().replace(/>\s+</g,'><');
export const rebuildReuseRule='相同元素只重建一份素材，多页或多处出现时复用同一素材ID，各实例单独保留位置、大小和叠放顺序。先检查已有对象与可复用素材，不重复拆解同一位置的元素；不能只因名称相同就合并，颜色、形状或细节不同须分开。相同文字属于不同内容节点时仍独立保留。已有素材需要修改时创建新版本，只替换当前实例，不连带修改其他页。';

export function deduplicateAuditElements(raw){
  if(!Array.isArray(raw?.elements))return {raw,changes:[]};
  const seen=new Map(),changes=[],elements=[];
  for(const e of raw.elements){
    if(!e||typeof e.key!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(e.key)){elements.push(e);continue;}
    const {key,description,...identity}=e;
    if(identity.type==='svg')identity.svg=svgSource(identity.svg);
    // Cutout instructions describe extracting this same source, not editing its appearance.
    if(identity.type==='cutout')delete identity.prompt;
    const fingerprint=JSON.stringify(stable(identity)),prior=seen.get(fingerprint);
    if(prior){changes.push({key,keptKey:prior,action:'reuse-identical-occurrence'});continue;}
    seen.set(fingerprint,key);elements.push(e);
  }
  return {raw:{...raw,elements},changes};
}

export function rebuildAssetIdentity({method,svg,sourcePixels,prompt,parentAssetHash}){
  let content;
  if(method==='svg')content={svg:svgSource(svg)};
  else if(parentAssetHash)content={parentAssetHash,prompt:String(prompt||'').trim()};
  else if(sourcePixels)content={sourcePixels};
  else return null;
  return hash(JSON.stringify(stable({version:1,method,...content})));
}

// Share both successful assets and in-flight jobs. Failed jobs are never cached.
export function createRebuildAssetStore({materials=[],getFile}){
  const known=new Map(),pending=new Map();
  for(const m of materials)if(m.reconstructed&&m.rebuildIdentity)known.set(m.rebuildIdentity,m);
  function valid(asset){try{const file=getFile(asset);return !!file&&hash(fs.readFileSync(file))===asset.sha256;}catch{return false;}}
  return {async getOrCreate(identity,create){
    if(identity){
      const asset=known.get(identity);
      if(asset&&valid(asset))return {asset,reused:true};
      known.delete(identity);
      if(pending.has(identity))return {asset:await pending.get(identity),reused:true};
    }
    const job=Promise.resolve().then(create).then(asset=>{
      if(identity){asset={...asset,rebuildIdentity:identity};known.set(identity,asset);}
      return asset;
    });
    if(identity)pending.set(identity,job);
    try{return {asset:await job,reused:false};}
    finally{if(identity)pending.delete(identity);}
  }};
}
