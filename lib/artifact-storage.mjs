import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const historyKeys=new Set(['editHistory','repairHistory','rebuildEditHistory','reuseCheckpoint']);
const cacheRoots=new Set(['assets','visual','theme-assets','exports','rebuild-live','geometry-records','audit-records','visual-diagnostics','rebuild-repairs','ocr-pages','document-views','material-images','image-extraction','speaker-script','speaker-scripts','supplement-images']);
const metadata=new Set(['project.json','project.tmp','artifact-index.json','artifact-index.tmp','.api-credentials.dpapi']);
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const slash=value=>value.split(path.sep).join('/');
const within=(root,file)=>file.startsWith(root+path.sep);

function projectDirectory(data,id){
  if(!/^[a-f0-9-]{36}$/i.test(id))throw Error('项目编号无效');
  const root=path.resolve(data,id);
  if(!within(path.resolve(data),root)||fs.lstatSync(root).isSymbolicLink())throw Error('项目目录不可为链接');
  return root;
}

// Reachability is computed from saved application records, never from file age.
// Unknown files and all supplied/supplementary materials are conservatively kept.
export function artifactInventory(p,data,{persist=true}={}){
  const root=projectDirectory(data,p.id),files=new Map(),blocked=[];
  function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const absolute=path.join(dir,e.name),relative=slash(path.relative(root,absolute));
    if(e.isSymbolicLink()){blocked.push(relative);continue;}
    if(e.isDirectory())walk(absolute);
    else if(e.isFile()){const s=fs.statSync(absolute);files.set(relative,{file:relative,bytes:s.size,mtime:s.mtimeMs,category:null,references:[]});}
  }}walk(root);
  const directories=new Map();
  for(const f of files.values())for(let dir=path.posix.dirname(f.file);dir!=='.';dir=path.posix.dirname(dir)){if(!directories.has(dir))directories.set(dir,[]);directories.get(dir).push(f);}
  const materialById=new Map((p.materials||[]).map(m=>[m.id,m]));
  for(const m of p.rebuildAssetPreview?.materials||[])materialById.set(m.id,m);
  function collectMaterials(value){
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){value.forEach(collectMaterials);return;}
    for(const [key,v]of Object.entries(value)){
      if(key==='materials'&&Array.isArray(v)){for(const m of v)if(m?.id&&!materialById.has(m.id))materialById.set(m.id,m);}
      else collectMaterials(v);
    }
  }collectMaterials(p);
  const visited=new Set(),queue=[],edges=[],missing=new Set();
  function reference(raw,category,owner,base=''){
    if(typeof raw!=='string'||!raw||raw.length>1500||/^https?:|^data:/i.test(raw))return;
    const value=raw.replaceAll('\\','/');
    const candidates=path.isAbsolute(raw)?[slash(path.relative(root,raw))]:[base?path.posix.join(base,value):value,value,'assets/'+value];
    for(const candidate of candidates){
      const normalized=path.posix.normalize(candidate);
      if(normalized.startsWith('../')||normalized==='..'||path.posix.isAbsolute(normalized))continue;
      const matches=files.has(normalized)?[files.get(normalized)]:directories.get(normalized)||[];
      if(!matches.length)continue;
      for(const f of matches){
        if(f.category!=='current'&&(category==='current'||!f.category))f.category=category;
        if(!f.references.some(r=>r.owner===owner&&r.category===category))f.references.push({owner,category});
        edges.push({from:owner,to:f.file,category});
        if(f.file.endsWith('.json')&&f.bytes<5_000_000){const key=category+':'+f.file;if(!visited.has(key)){visited.add(key);queue.push({file:f.file,category});}}
      }
      return;
    }
  }
  const materialVisits=new Set();
  function material(id,category,owner){
    const m=materialById.get(id);if(!m)return;
    const key=category+':'+id;if(materialVisits.has(key))return;materialVisits.add(key);
    edges.push({from:owner,to:'material:'+id,category});
    reference('assets/'+m.file,category,'material:'+id);
    if(m.file&&!files.has('assets/'+m.file.replaceAll('\\','/')))missing.add('material:'+id);
    visit(m,category,'material:'+id,'assets');
  }
  function visit(value,category,owner,base=''){
    if(typeof value==='string'){material(value,category,owner);reference(value,category,owner,base);return;}
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){value.forEach((v,i)=>visit(v,category,owner+'['+i+']',base));return;}
    const dir=typeof value.dir==='string'?value.dir.replaceAll('\\','/'):base;
    for(const [key,v]of Object.entries(value)){
      if(key==='materials')continue;
      visit(v,category==='history'||historyKeys.has(key)||key==='parentImageId'?'history':'current',owner+'.'+key,dir);
    }
  }
  // Immutable user materials, edited originals and generated supplements are never caches.
  for(const m of p.materials||[])if(!m.reconstructed&&m.purpose!=='workflow-background')material(m.id,'current','materials');
  for(const [key,value]of Object.entries(p))if(!['materials','artifactStorage'].includes(key))visit(value,historyKeys.has(key)?'history':'current','project.'+key);
  while(queue.length){const item=queue.shift();try{visit(JSON.parse(fs.readFileSync(path.join(root,item.file),'utf8')),item.category,item.file,path.posix.dirname(item.file));}catch{}}
  for(const f of files.values()){
    if(metadata.has(f.file)||f.file.startsWith('.api-credentials.'))f.category='protected';
    if(!f.category)f.category=cacheRoots.has(f.file.split('/')[0])?'cache':'protected';
  }
  const summary=Object.fromEntries(['current','history','cache','protected'].map(k=>[k,{files:0,bytes:0}]));
  for(const f of files.values()){summary[f.category].files++;summary[f.category].bytes+=f.bytes;}
  const ordered=[...files.values()].sort((a,b)=>a.file.localeCompare(b.file));
  const token=hash(ordered.filter(f=>!metadata.has(f.file)).map(f=>[f.file,f.bytes,f.mtime,f.category]));
  const report={version:1,projectId:p.id,at:new Date().toISOString(),token,summary,total:{files:ordered.length,bytes:ordered.reduce((n,f)=>n+f.bytes,0)},blockedLinks:blocked,missing:[...missing],files:ordered,edges};
  if(persist){const temp=path.join(root,'artifact-index.tmp');fs.writeFileSync(temp,JSON.stringify(report,null,2));fs.renameSync(temp,path.join(root,'artifact-index.json'));}
  return report;
}

export function cleanArtifactCache(p,data,token){
  if(p.task?.status==='running'||p.imageTaskQueue?.some(t=>['running','queued'].includes(t.status)))throw Error('任务执行或排队期间不能清理缓存');
  const report=artifactInventory(p,data,{persist:false});
  if(typeof token!=='string'||token!==report.token)throw Error('工件引用或文件已变化，请刷新统计后重新清理');
  const root=projectDirectory(data,p.id),targets=report.files.filter(f=>f.category==='cache');let bytes=0,count=0;
  for(const f of targets){
    const target=path.resolve(root,f.file);
    if(!within(root,target)||!cacheRoots.has(f.file.split('/')[0]))throw Error('清理目标超出缓存目录');
    // Recheck every ancestor; junctions and symlinks must never escape the project.
    for(let dir=path.dirname(target);dir!==root;dir=path.dirname(dir))if(fs.lstatSync(dir).isSymbolicLink())throw Error('缓存路径包含链接，已停止清理');
    const stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==f.bytes||stat.mtimeMs!==f.mtime)throw Error('缓存文件已变化，请刷新统计');
  }
  for(const f of targets){fs.unlinkSync(path.join(root,f.file));bytes+=f.bytes;count++;}
  const deleted=new Set(targets.map(f=>f.file));
  p.materials=(p.materials||[]).filter(m=>!deleted.has('assets/'+m.file));
  if(p.rebuildAssetPreview?.materials)p.rebuildAssetPreview.materials=p.rebuildAssetPreview.materials.filter(m=>!deleted.has('assets/'+m.file));
  return {deleted:{files:count,bytes},report:artifactInventory(p,data)};
}

export function publicArtifactReport(report){
  const {files,edges,...summary}=report;
  return {...summary,samples:files.filter(f=>f.category==='cache').slice(0,30).map(({file,bytes})=>({file,bytes})),referenceCount:edges.length};
}
