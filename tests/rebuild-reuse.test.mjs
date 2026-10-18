import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Resvg} from '@resvg/resvg-js';
import {createRebuildAssetStore,rebuildAssetIdentity,deduplicateAuditElements} from '../lib/rebuild-reuse.mjs';
import {canonicalTexts,digest} from '../lib/visual-model.mjs';
import {auditedElements} from '../lib/visual-audit-repair.mjs';
import {repairRebuiltPage} from '../lib/rebuild-tools.mjs';

const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M5 5L55 30L5 55Z" fill="#123456"/></svg>';
const temp=()=>fs.mkdtempSync(path.resolve('work','rebuild-reuse-'));

test('同位置同内容去重，不合并不同节点文字、不同位置实例或不同外观',()=>{
  const icon={key:'a',type:'svg',svg,x:100,y:500,w:60,h:60};
  const text={key:'t',type:'text',nodeId:'first',text:'重复文字',x:100,y:100,w:300,h:50};
  const raw={elements:[icon,{...icon,key:'duplicate',description:'另一个名称'},{...icon,key:'second',x:500},{...icon,key:'different',svg:svg.replace('123456','654321')},text,{...text,key:'text-duplicate'},{...text,key:'other-node',nodeId:'second'}]};
  const result=deduplicateAuditElements(raw);
  assert.deepEqual(result.raw.elements.map(e=>e.key),['a','second','different','t','other-node']);
  assert.equal(result.changes.length,2);assert.equal(raw.elements.length,7);
  const sameKey=deduplicateAuditElements({elements:[icon,{...icon,svg:svg.replace('123456','654321')}]});assert.equal(sameKey.raw.elements.length,2,'冲突编号仍交给审计校验，不能静默隐藏');
});

test('同位置重复识别在审计结束即去重，不触发重复模型调用',async()=>{
  const slide={title:'标题',body:['正文'],sources:[]},texts=canonicalTexts(slide).map((n,i)=>({...n,key:n.nodeId,type:'text',x:50,y:100+i*100,w:500,h:60,size:30,color:'272727'})),icon={key:'icon',type:'svg',svg,x:1000,y:700,w:60,h:60};let calls=0;
  const result=await auditedElements({slide,images:[],request:async()=>{calls++;return {text:JSON.stringify({elements:[...texts,icon,{...icon,key:'extra'}]})};}});
  assert.equal(calls,1);assert.equal(result.audit.length,3);assert(result.auditValidation.localChanges.some(v=>v.action==='reuse-identical-occurrence'));
});

test('素材内容身份不依赖位置和名称，颜色、方法、源像素或修改意见不同则不混用',()=>{
  const a=rebuildAssetIdentity({method:'svg',svg});
  assert.equal(a,rebuildAssetIdentity({method:'svg',svg,x:800,w:200,description:'另一页'}));
  assert.notEqual(a,rebuildAssetIdentity({method:'svg',svg:svg.replace('123456','654321')}));
  assert.notEqual(rebuildAssetIdentity({method:'cutout',sourcePixels:'a'}),rebuildAssetIdentity({method:'cutout',sourcePixels:'b'}));
  assert.notEqual(rebuildAssetIdentity({method:'cutout',parentAssetHash:'a',prompt:'变黄'}),rebuildAssetIdentity({method:'cutout',parentAssetHash:'a',prompt:'变蓝'}));
  assert.equal(rebuildAssetIdentity({method:'cutout',prompt:'同名但无可靠来源'}),null);
});

test('相同素材的并发请求只执行一次，跨次复用验证文件哈希，失败后可重试',async()=>{
  const dir=temp(),file=path.join(dir,'asset.svg');let calls=0;
  const identity=rebuildAssetIdentity({method:'svg',svg}),store=createRebuildAssetStore({getFile:m=>path.join(dir,m.file)});
  const create=async()=>{calls++;await new Promise(r=>setImmediate(r));fs.writeFileSync(file,svg);return {id:'shared',file:'asset.svg',sha256:digest(svg),reconstructed:true};};
  const results=await Promise.all([store.getOrCreate(identity,create),store.getOrCreate(identity,create),store.getOrCreate(identity,create)]);
  assert.equal(calls,1);assert.equal(results.filter(r=>!r.reused).length,1);assert.equal(new Set(results.map(r=>r.asset.id)).size,1);
  const persisted=createRebuildAssetStore({materials:[results[0].asset],getFile:m=>path.join(dir,m.file)});
  assert.equal((await persisted.getOrCreate(identity,create)).reused,true);assert.equal(calls,1);
  fs.writeFileSync(file,'changed');assert.equal((await persisted.getOrCreate(identity,create)).reused,false);assert.equal(calls,2);
  const failed=createRebuildAssetStore({getFile:m=>path.join(dir,m.file)});let attempts=0;
  await assert.rejects(failed.getOrCreate(identity,async()=>{attempts++;throw Error('供应商失败');}),/供应商失败/);
  await failed.getOrCreate(identity,async()=>{attempts++;return create();});assert.equal(attempts,2);
});

test('抠图复用比较局部解码像素，不依赖页面、坐标或文件编码',()=>{
  const dir=temp(),source=path.join(dir,'page.png');
  fs.writeFileSync(source,new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#ddd"/><path d="M110 110h80v80h-80zM510 110h80v80h-80z" fill="#abc"/><path d="M910 110h80v80h-80z" fill="#def"/></svg>').render().asPng());
  const crop=x=>{const spec=path.join(dir,x+'.json'),out=path.join(dir,x+'.png');fs.writeFileSync(spec,JSON.stringify({box:[x,100,100,100]}));return JSON.parse(execFileSync(path.resolve('.venv/Scripts/python.exe'),[path.resolve('tools/visual_assets.py'),'crop',source,out,spec],{encoding:'utf8',windowsHide:true}));};
  const a=crop(100),b=crop(500),c=crop(900);assert.equal(a.pixelHash,b.pixelHash);assert.notEqual(a.pixelHash,c.pixelHash);
});

test('工具可复用已有素材，重复位置不重复加入，新位置保留独立实例且其他页不变',async()=>{
  const dir=temp(),file=path.join(dir,'asset.svg');fs.writeFileSync(file,svg);
  const slide={title:'标题',body:[],sources:[]},texts=canonicalTexts(slide).map(n=>({...n,key:n.nodeId,type:'text',x:50,y:80,w:500,h:60,size:30,color:'272727'}));
  const asset={id:'shared',kind:'image',reconstructed:true,svg:true,file:'asset.svg',sha256:digest(svg),name:'三角图标'},instance={key:'existing',type:'image',implementation:'svg',id:asset.id,x:1000,y:700,w:60,h:60};
  const p={id:'p',brief:{progress:false},slides:[slide,slide],materials:[asset],visualPages:[{images:[]}],reconstruction:{slides:[{elements:[...texts,instance]},{elements:[instance]}],assets:['shared']}};
  const other=structuredClone(p.reconstruction.slides[1]);let turns=0,creates=0;const bodies=[];
  const result=await repairRebuiltPage({p,index:0,round:1,review:{issues:[]},env:{credentials:new Map([['p',{text:{key:'fixture',model:'main'}}]]),getImage:()=>file},reference:'ref',rendered:'render',background:'bg',createAsset:async()=>{creates++;throw Error('不可生成');},renderScene:async()=>'',record:()=>{},requestModel:async(c,e,b)=>{
    bodies.push(b);return {choices:[{message:turns++===0?{tool_calls:[['inspect_page',{}],['reuse_visual_asset',{assetId:'shared',key:'duplicate',x:1000,y:700,w:60,h:60}],['reuse_visual_asset',{assetId:'shared',key:'second',x:1100,y:700,w:100,h:100}]].map(([name,args],i)=>({id:'t'+i,type:'function',function:{name,arguments:JSON.stringify(args)}}))}:{content:'{"done":true}'}}]};
  }});
  assert.equal(creates,0);assert.equal(result.changed,true);assert.equal(p.materials.length,1);assert.deepEqual(p.reconstruction.assets,['shared']);assert.deepEqual(p.reconstruction.slides[1],other);
  assert.deepEqual(p.reconstruction.slides[0].elements.filter(e=>e.type==='image').map(e=>[e.key,e.id,e.w]),[['existing','shared',60],['second','shared',100]]);
  assert.match(JSON.stringify(bodies[1].messages),/reusableAssets/);
});
