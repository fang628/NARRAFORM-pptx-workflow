import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {validateStyleDefinition} from './style-registry.mjs';

// Store design rules only: no project materials, paths, API settings or images.
const filename=data=>path.join(data,'_style-favorites.json');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function portableDefinition(record){
  return validateStyleDefinition({...record.definition,referenceStyleId:null});
}
export function readStyleFavorites(data){
  if(!data||!fs.existsSync(filename(data)))return [];
  const value=JSON.parse(fs.readFileSync(filename(data),'utf8'));
  if(value.version!==1||!Array.isArray(value.styles))throw Error('收藏风格库格式无效');
  return value.styles.map(item=>{
    const definition=validateStyleDefinition(item.definition);
    if(definition.referenceStyleId!==null||hash(definition)!==item.fingerprint||item.id!=='FAVORITE-'+item.fingerprint.slice(0,16))throw Error('收藏风格定义校验失败');
    return {...item,definition};
  });
}
function writeFavorites(data,styles){
  if(!data)throw Error('未配置风格库保存位置');
  fs.mkdirSync(data,{recursive:true});
  const target=filename(data),temporary=target+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify({version:1,styles},null,2));fs.renameSync(temporary,target);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
export function favoriteStyle(p,data,styleId){
  const record=p.styleRegistry?.find(r=>r.id===styleId&&!r.deletedAt&&r.origin!=='preset');
  if(!record)throw Error('请选择有效的自定义登记风格');
  const definition=portableDefinition(record),fingerprint=hash(definition),styles=readStyleFavorites(data);
  const existing=styles.find(r=>r.fingerprint===fingerprint);if(existing)return existing;
  const item={id:'FAVORITE-'+fingerprint.slice(0,16),fingerprint,definition,starredAt:new Date().toISOString(),libraryVersion:record.libraryVersion,
    ...(p.visualTreatment?{visualTreatment:p.visualTreatment}:{}),
    ...(record.paletteSource?{paletteSource:structuredClone(record.paletteSource)}:{})};
  styles.push(item);writeFavorites(data,styles);return item;
}
export function removeFavoriteStyle(data,id){
  const styles=readStyleFavorites(data),remaining=styles.filter(r=>r.id!==id);
  if(remaining.length===styles.length)throw Error('收藏风格不存在或已取消');
  writeFavorites(data,remaining);
}
export function importFavoriteStyle(p,data,id){
  const favorite=readStyleFavorites(data).find(r=>r.id===id);
  if(!favorite)throw Error('收藏风格不存在或已取消，请刷新后重选');
  p.styleRegistry??=[];
  const existing=p.styleRegistry.find(r=>r.fingerprint===favorite.fingerprint&&!r.deletedAt);
  if(existing)return existing.id;
  const base='STYLE-'+favorite.fingerprint.slice(0,16);
  const record={id:p.styleRegistry.some(r=>r.id===base)?base+'-'+crypto.randomUUID().slice(0,8):base,fingerprint:favorite.fingerprint,
    definition:structuredClone(favorite.definition),origin:'favorite-reuse',favoriteSourceId:id,
    libraryVersion:favorite.libraryVersion,registeredAt:new Date().toISOString(),stage:'favorite-import',
    ...(favorite.paletteSource?{paletteSource:structuredClone(favorite.paletteSource)}:{})};
  p.styleRegistry.push(record);return record.id;
}
export function styleFavoritesPublic(p,data){
  try{
    const styles=readStyleFavorites(data),starredStyleIds=Object.fromEntries((p.styleRegistry||[]).filter(r=>!r.deletedAt&&r.origin!=='preset').flatMap(r=>{
      const match=styles.find(f=>f.fingerprint===hash(portableDefinition(r)));return match?[[r.id,match.id]]:[];
    }));
    return {styleFavoritesEnabled:true,styleFavorites:styles,starredStyleIds};
  }catch(error){return {styleFavoritesEnabled:true,styleFavorites:[],starredStyleIds:{},styleFavoritesWarning:'收藏风格库读取失败：'+error.message};}
}
