import fs from 'node:fs';
import path from 'node:path';

// One configuration for this local installation. Project IDs are used only to
// migrate old vaults; changing/deleting a project cannot change the shared key.
export function sharedCredentials(vault,data){
  let config=null,warning=null,queue=Promise.resolve();
  const legacy=()=>fs.readdirSync(data).filter(id=>/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)).flatMap(id=>{
    try{const dir=path.join(data,id);if(fs.lstatSync(dir).isSymbolicLink())return [];const file=path.join(dir,'.api-credentials.dpapi');return fs.existsSync(file)?[{id,mtime:fs.statSync(file).mtimeMs}]:[];}catch{return [];}
  }).sort((a,b)=>b.mtime-a.mtime||a.id.localeCompare(b.id));
  function retireLegacy(){for(const {id}of legacy())vault.clear(id);}
  function serialized(operation){const next=queue.then(operation);queue=next.catch(()=>{});return next;}
  return {
    get(){return config;},
    get warning(){return warning;},
    async restore(){
      try{
        config=await vault.loadShared();
        if(!config){
          const candidates=legacy();
          for(const {id}of candidates){try{config=await vault.load(id);}catch{}if(config)break;}
          if(config)await vault.saveShared(config);
          else if(candidates.length)throw Error('本机保存的 API 配置无法解密，请重新填写并保存');
        }
        if(config)retireLegacy();
      }catch(error){warning=error.message;}
    },
    update(change){return serialized(async()=>{
      const next=change(structuredClone(config||{}));
      await vault.saveShared(next);config=structuredClone(next);warning=null;
      try{retireLegacy();}catch{warning='通用 API 已保存，旧版项目密钥副本未能全部清理；请检查数据目录权限';}
    });},
    clear(){return serialized(async()=>{
      // Remove legacy copies first, so a subsequent restart cannot restore a
      // forgotten key through the one-time migration path.
      retireLegacy();vault.clearShared();config=null;warning=null;
    });}
  };
}
