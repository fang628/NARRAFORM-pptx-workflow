import crypto from 'node:crypto';
import fs from 'node:fs';
import {normalizeSVGColors} from './svg-colors.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,stable(value[k])])):value;
// Internal paint-server IDs carry no visual meaning. Models often rename them
// for each occurrence (f1/p1 -> f2/p2); compare the references, not those names.
export function canonicalRebuildSVG(svg){
  const source=normalizeSVGColors(svg||'').trim().replace(/>\s+</g,'><');
  // CSS selectors/embedded documents need a full parser; keep those conservative.
  if(/<(?:style|script|foreignObject)\b/i.test(source))return source;
  const ids=new Map();let duplicate=false;
  for(const match of source.matchAll(/\s+id\s*=\s*(["'])(.*?)\1/g)){
    if(ids.has(match[2]))duplicate=true;
    else ids.set(match[2],'rebuild-ref-'+ids.size);
  }
  if(duplicate||!ids.size)return source;
  return source.replace(/(\s+id\s*=\s*)(["'])(.*?)\2/g,(_,prefix,quote,id)=>prefix+quote+ids.get(id)+quote)
    .replace(/url\(\s*(["']?)#([^\s)'"<>]+)\1\s*\)/g,(match,quote,id)=>ids.has(id)?'url(#'+ids.get(id)+')':match)
    .replace(/(\s+(?:xlink:)?href\s*=\s*)(["'])#([^"']+)\2/g,(match,prefix,quote,id)=>ids.has(id)?prefix+quote+'#'+ids.get(id)+quote:match);
}
const svgSource=canonicalRebuildSVG;
export const rebuildReuseRule='相同元素只重建一份素材，多页或多处出现时复用同一素材ID，各实例单独保留位置、大小和叠放顺序。先逐处清点出现数量，每个位置使用独立key，repeatedElements记录相同元素的总数count及所有实例keys；素材去重不得减少插入实例，也不能把同一素材ID当成只插入一次。先检查已有对象与可复用素材，不重复拆解同一位置的元素；不能只因名称相同就合并，颜色、形状或细节不同须分开。相同文字属于不同内容节点时仍独立保留。已有素材需要修改时创建新版本，只替换当前实例，不连带修改其他页。';

export function auditInstanceGroups(raw){
  if(raw?.repeatedElements===undefined)return [];
  if(!Array.isArray(raw.repeatedElements)||raw.repeatedElements.length>110)throw Error('相同元素实例清单格式无效');
  return raw.repeatedElements.map(group=>{
    if(!group||!Number.isInteger(group.count)||group.count<2||!Array.isArray(group.keys)||group.keys.length!==group.count||new Set(group.keys).size!==group.count)throw Error('相同元素出现数量与实例编号不一致，请逐处补齐所有位置');
    const instances=group.keys.map(key=>{const matches=raw.elements.filter(e=>e.key===key);if(matches.length!==1)throw Error('相同元素实例遗漏或编号重复：'+key);const e=matches[0];return {key,x:e.x,y:e.y,w:e.w,h:e.h,z:raw.elements.indexOf(e)};});
    return {label:String(group.label||'相同元素').slice(0,100),count:group.count,keys:group.keys,instances};
  });
}
export function insertedInstanceManifest(elements){
  const groups=new Map();elements.forEach((e,z)=>{const id=e.type==='image'?'asset:'+e.id:'element:'+e.key;if(!groups.has(id))groups.set(id,{id,assetId:e.type==='image'?e.id:null,count:0,instances:[]});const group=groups.get(id);group.count++;group.instances.push({key:e.key,x:e.x,y:e.y,w:e.w,h:e.h,z});});
  return {count:elements.length,groups:[...groups.values()]};
}

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
    const declared=raw.repeatedElements?.some(g=>g.keys?.includes(key))||raw.frameInventory?.some(f=>f.key===key);
    if(prior&&!declared){changes.push({key,keptKey:prior,action:'reuse-identical-occurrence'});continue;}
    seen.set(fingerprint,key);elements.push(e);
  }
  return {raw:{...raw,elements},changes};
}

export function rebuildAssetIdentity({method,svg,sourcePixels,prompt,parentAssetHash,geometry={},mattePolicy}){
  let content;
  if(method==='svg')content={svg:svgSource(svg),geometryMode:geometry.arrowRole||/arrow|chevron|箭形|箭头/i.test((geometry.frameKind||'')+' '+(geometry.contourKind||''))?'arrow':/hexagon|六边形/i.test((geometry.frameKind||'')+' '+(geometry.contourKind||''))?'hexagon':'auto'};
  else if(parentAssetHash)content={parentAssetHash,prompt:String(prompt||'').trim()};
  else if(sourcePixels)content={sourcePixels};
  else return null;
  return hash(JSON.stringify(stable({version:method==='svg'?3:1,method,...content,...(mattePolicy?{mattePolicy}:{})})));
}

// Share both successful assets and in-flight jobs. Failed jobs are never cached.
export function createRebuildAssetStore({materials=[],getFile,accept=()=>true}){
  const known=new Map(),pending=new Map();
  for(const m of materials)if(m.reconstructed&&m.rebuildIdentity)known.set(m.rebuildIdentity,m);
  function valid(asset){try{const file=getFile(asset);return !!file&&hash(fs.readFileSync(file))===asset.sha256;}catch{return false;}}
  return {async getOrCreate(identity,create){
    if(identity){
      const asset=known.get(identity);
      if(asset&&accept(asset)&&valid(asset))return {asset,reused:true};
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
