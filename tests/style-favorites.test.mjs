import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fixtureDirections} from './visual-fixture.mjs';
import {registerStyleDirections,requireStyleRegistration,deleteRegisteredStyle} from '../lib/style-registry.mjs';
import {favoriteStyle,removeFavoriteStyle,readStyleFavorites,importFavoriteStyle,styleFavoritesPublic} from '../lib/style-favorites.mjs';
import {visualAction} from '../lib/visual-pipeline.mjs';
import {themeDirectionOptions,styleRegistryPanel} from '../public/theme-assets.js';
import {favoriteStyleButton,styleFavoritesPanel} from '../public/style-favorites.js';

const temp=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'narraform-styles-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
function source(){const p={id:'source',visualTreatment:'flat',materials:[{id:'secret',text:'private source'}],styleRegistry:[]};const [direction]=registerStyleDirections(p,[{...fixtureDirections()[0],referenceStyleId:null}],'theme-assets');return {p,direction};}

test('加星持久化完整设计，重复收藏去重且不修改项目，不携带原材料或密钥',t=>{
  const data=temp(t),{p,direction}=source(),before=structuredClone(p);
  p.credentials={key:'private-key'};before.credentials=structuredClone(p.credentials);
  const first=favoriteStyle(p,data,direction.styleRegistrationId),again=favoriteStyle(p,data,direction.styleRegistrationId);
  assert.equal(again.id,first.id);assert.equal(readStyleFavorites(data).length,1);assert.deepEqual(p,before);
  assert.deepEqual(readStyleFavorites(data)[0].definition,p.styleRegistry[0].definition);
  const disk=fs.readFileSync(path.join(data,'_style-favorites.json'),'utf8');assert.doesNotMatch(disk,/private-key|private source|materials|credentials/);
  assert.equal(styleFavoritesPublic(p,data).starredStyleIds[direction.styleRegistrationId],first.id);
});

test('跨项目导入不依赖来源项目，复用完整设计并走原有登记校验路径',t=>{
  const data=temp(t),{p,direction}=source(),favorite=favoriteStyle(p,data,direction.styleRegistrationId);
  deleteRegisteredStyle(p,direction.styleRegistrationId);
  const target={id:'new-project',styleRegistry:[]},id=importFavoriteStyle(target,data,favorite.id);
  assert.equal(importFavoriteStyle(target,data,favorite.id),id);assert.equal(target.styleRegistry.length,1);
  const [adopted]=registerStyleDirections(target,[{...fixtureDirections()[1],referenceStyleId:id}],'theme-style-change');
  const record=requireStyleRegistration(target,adopted);
  for(const field of ['name','style','coreColor','typography','frames','decoration','layoutLanguage'])assert.equal(record.definition[field],favorite.definition[field]);
  assert.equal(styleFavoritesPublic(target,data).starredStyleIds[adopted.styleRegistrationId],favorite.id);
  removeFavoriteStyle(data,favorite.id);assert.deepEqual(readStyleFavorites(data),[]);
  assert.equal(requireStyleRegistration(target,adopted).id,record.id,'取消收藏不破坏已采用风格');
  assert.throws(()=>importFavoriteStyle({},data,favorite.id),/已取消/);
});

test('收藏引用风格时展开定义，避免跨项目悬空引用；已删除导入记录不复活',t=>{
  const data=temp(t),{p,direction}=source();
  const [reuse]=registerStyleDirections(p,[{...fixtureDirections()[1],referenceStyleId:direction.styleRegistrationId}],'theme-assets');
  const favorite=favoriteStyle(p,data,reuse.styleRegistrationId);assert.equal(favorite.definition.referenceStyleId,null);
  const target={},id=importFavoriteStyle(target,data,favorite.id);deleteRegisteredStyle(target,id);
  const fresh=importFavoriteStyle(target,data,favorite.id);assert.notEqual(fresh,id);assert.ok(target.styleRegistry[0].deletedAt);
});

test('收藏入口与选择器显示星标，文字转义，预设不出现收藏按钮',t=>{
  const data=temp(t),{p,direction}=source();
  const favorite=favoriteStyle(p,data,direction.styleRegistrationId),view={...p,...styleFavoritesPublic(p,data),styleRegistryDeletion:true};
  assert.match(favoriteStyleButton(view,direction.styleRegistrationId),/aria-pressed="true"/);
  assert.match(styleRegistryPanel(view),/data-unfavorite-style/);
  assert.match(themeDirectionOptions(view),/跨项目收藏/);assert.ok(themeDirectionOptions(view).includes(favorite.id));
  assert.equal(favoriteStyleButton({...view,styleRegistry:[{id:'A',origin:'preset'}]},'A'),'');
  const hostile={...view,styleFavorites:[{...favorite,definition:{...favorite.definition,name:'<img onerror="bad">',description:'<script>bad</script>'}}]};
  assert.doesNotMatch(styleFavoritesPanel(hostile),/<img|<script/);assert.match(styleFavoritesPanel(hostile),/&lt;img/);
});

test('后端收藏与取消动作仅操作共享库，不使当前设计过期',async t=>{
  const data=temp(t),{p,direction}=source(),before=structuredClone(p),events=[],env={data,event:(_p,message)=>events.push(message)};
  assert.equal(await visualAction(p,{action:'favoriteStyle',styleId:direction.styleRegistrationId},env),true);
  const favorite=readStyleFavorites(data)[0];assert.deepEqual(p,before);
  await visualAction(p,{action:'removeFavoriteStyle',favoriteId:favorite.id},env);
  assert.deepEqual(p,before);assert.equal(events.length,2);assert.deepEqual(readStyleFavorites(data),[]);
});

test('损坏收藏库提供可见提示并拒绝覆盖；非法或预设风格不可收藏',t=>{
  const data=temp(t),{p,direction}=source();assert.throws(()=>favoriteStyle(p,data,'A'),/自定义/);
  fs.writeFileSync(path.join(data,'_style-favorites.json'),'invalid');
  assert.match(styleFavoritesPublic(p,data).styleFavoritesWarning,/读取失败/);
  assert.throws(()=>favoriteStyle(p,data,direction.styleRegistrationId));
  assert.equal(fs.readFileSync(path.join(data,'_style-favorites.json'),'utf8'),'invalid');
});

test('真实HTTP接口收藏后新项目可见，重启后保留，取消收藏全局生效',async t=>{
  const data=temp(t),{p,direction}=source();
  p.id='11111111-1111-4111-8111-111111111111';
  Object.assign(p,{brief:{title:'合成测试',pages:1,cover:false,progress:false},slides:[],concepts:[],approvals:{},version:1,stage:0,events:[]});
  fs.mkdirSync(path.join(data,p.id));fs.writeFileSync(path.join(data,p.id,'project.json'),JSON.stringify(p));
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  let child;const stop=async()=>{if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}};
  t.after(stop);
  const base='http://127.0.0.1:'+port,start=async()=>{
    child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:data,PPT_AGENT_TEST:'1'},windowsHide:true,stdio:'ignore'});
    for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,30));}throw Error('隔离服务未就绪');
  };
  const call=async(route,body,status=200)=>{const r=await fetch(base+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;};
  await start();
  const starred=await call('/api/projects/'+p.id+'/action',{action:'favoriteStyle',styleId:direction.styleRegistrationId});
  assert.equal(starred.styleFavorites.length,1);assert.ok(starred.starredStyleIds[direction.styleRegistrationId]);
  const target=await call('/api/projects',{brief:{title:'跨项目测试',pages:1}},201);assert.equal(target.styleFavorites.length,1);
  await stop();await start();
  const restored=await call('/api/projects/'+target.id);assert.deepEqual(restored.styleFavorites,starred.styleFavorites);
  const removed=await call('/api/projects/'+target.id+'/action',{action:'removeFavoriteStyle',favoriteId:restored.styleFavorites[0].id});assert.equal(removed.styleFavorites.length,0);
  assert.deepEqual((await call('/api/projects/'+p.id)).starredStyleIds,{});
  await stop();
});
