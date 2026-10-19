import test from 'node:test';
import assert from 'node:assert/strict';
import {groupRebuildAssets} from '../public/rebuild-asset-groups.js';
import {rebuildAssetsPanel,rebuildFeedbackRequest,bindRebuildMentions} from '../public/visual-ui.js';

function project(elements){
  const page={index:0,elements:elements.map(e=>({key:e.key,type:e.type,id:e.id||null,implementation:e.implementation||null,description:e.description||e.key,targetStamp:'stamp-'+e.key})),textStyles:[]};
  return {id:'fixture',version:1,task:{status:'running'},rebuildAssets:[page],rebuildAssetPreview:{version:1,status:'extracting',pages:[{elements}],materials:[]},materials:[]};
}
const dot=(key,x)=>({key,type:'ellipse',x,y:200,w:10,h:10,fill:'123456',opacity:1});

test('同款原生元素仅展示一组，保留所有位置的独立实例与@目标，不改实际元素清单',()=>{
  const p=project([dot('dot-1',10),dot('dot-2',100),dot('dot-3',200)]),before=structuredClone(p),groups=groupRebuildAssets(p,p.rebuildAssets[0]);
  assert.equal(groups.length,1);assert.equal(groups[0].count,3);assert.deepEqual(groups[0].instances.map(i=>i.key),['dot-1','dot-2','dot-3']);assert.deepEqual(p,before);
  const html=rebuildAssetsPanel(p,0);assert.equal((html.match(/class="rebuild-asset-card"/g)||[]).length,1);assert.match(html,/使用 3 处/);assert.match(html,/查看各处元素/);assert.match(html,/data-rebuild-mention-key="dot-3"/);
  assert.doesNotMatch(html.match(/<article\b[^>]*>/)[0],/data-rebuild-mention-key/,'展开实例时不能被父卡片抢先引用首项');
  assert.deepEqual(rebuildFeedbackRequest(p,0,'@dot-3 放大'),{action:'reviseRebuildElement',payload:{index:0,key:'dot-3',targetStamp:'stamp-dot-3',instruction:'放大'}});
});

test('展开分组后选择第三处会填入该处编号，不会误改首个或整组',()=>{
  const p=project([dot('dot-1',10),dot('dot-2',100),dot('dot-3',200)]),events=new Map();
  const field={value:'@',selectionStart:1,dataset:{rebuildAssetInstruction:'0'},closest:()=>({classList:{toggle(){}}}),addEventListener:(name,fn)=>events.set(name,fn),setRangeText(text,start,end){this.value=this.value.slice(0,start)+text+this.value.slice(end);this.selectionStart=start+text.length;},focus(){},dispatchEvent(event){events.get(event.type)?.(event);}};
  const targets=['dot-1','dot-2','dot-3'].map(key=>({dataset:{rebuildMentionKey:key},events:new Map(),setAttribute(){},removeAttribute(){},addEventListener(name,fn){this.events.set(name,fn);}}));
  bindRebuildMentions({querySelectorAll:selector=>selector==='[data-rebuild-asset-instruction]'?[field]:targets},()=>p);
  targets[2].events.get('click')({preventDefault(){},stopPropagation(){}});assert.equal(field.value,'@dot-3 ');
  assert.equal(rebuildFeedbackRequest(p,0,field.value+'向右移动').payload.key,'dot-3');
});

test('同一素材不同位置大小及复用标记只占一张卡，不同ID相同文件哈希也合并展示',()=>{
  const p=project([{key:'a',type:'image',id:'one',implementation:'svg',x:20,y:100,w:50,h:50},{key:'b',type:'image',id:'one',implementation:'svg',reusedAsset:true,x:200,y:100,w:100,h:100},{key:'c',type:'image',id:'two',implementation:'svg',x:500,y:100,w:50,h:50}]);
  p.materials=[{id:'one',sha256:'same'},{id:'two',sha256:'same'}];const groups=groupRebuildAssets(p,p.rebuildAssets[0]);assert.equal(groups.length,1);assert.equal(groups[0].count,3);
});

test('颜色、箭头方向、形状、阴影或渐变不同均独立展示，不能按同名合并',()=>{
  const base={...dot('a',10),type:'shape',shape:'chevron',description:'同名'};
  const p=project([base,{...base,key:'b',fill:'654321'},{...base,key:'c',flipH:true},{...base,key:'d',shape:'roundRect'},{...base,key:'e',shadow:{color:'000000',opacity:.3}},{...base,key:'f',gradient:{stops:[{color:'ff0000'},{color:'000000'}]}}]);
  assert.equal(groupRebuildAssets(p,p.rebuildAssets[0]).length,6);
  const lines=project([{...dot('a',10),type:'line',beginArrowType:'oval'},{...dot('b',100),type:'line',endArrowType:'arrow'}]);assert.equal(groupRebuildAssets(lines,lines.rebuildAssets[0]).length,2);
});

test('不混用旧版本原生样式；没有可靠外观时分别展示；失败候选与正常素材分开',()=>{
  const p=project([dot('a',10),dot('b',100)]);p.rebuildAssetPreview.version=0;assert.equal(groupRebuildAssets(p,p.rebuildAssets[0]).length,2);
  const q=project([{key:'a',type:'image',id:'same'},{key:'b',type:'image',id:'same'}]);q.rebuildAssets[0].elements[1].needsAttention=true;assert.equal(groupRebuildAssets(q,q.rebuildAssets[0]).length,2);
});

test('实时刷新采用当前批次，完成后采用当前重建；各页独立分组',()=>{
  const p=project([dot('a',10),{...dot('b',100),fill:'abcdef'}]);p.reconstruction={slides:[{elements:[dot('a',10),dot('b',100)]}]};p.visualReconstructionCurrent=true;
  assert.equal(groupRebuildAssets(p,p.rebuildAssets[0]).length,2);p.rebuildAssetPreview.status='done';assert.equal(groupRebuildAssets(p,p.rebuildAssets[0]).length,1);
  const page={index:1,elements:[{key:'c',type:'ellipse',description:'另一页'}]};assert.equal(groupRebuildAssets(p,page).length,1);
});

test('分组元数据始终转义，文字与失败元素仍可查看',()=>{
  const p=project([dot('a',10),dot('b',100)]);p.rebuildAssets[0].elements[1].description='<img onerror=bad>';
  p.rebuildAssets[0].textStyles=[{key:'text',text:'正文',fontFace:'Microsoft YaHei',size:30}];p.rebuildAssets[0].failedElements=[{key:'failed',description:'尚未完成'}];
  const html=rebuildAssetsPanel(p,0);assert.match(html,/&lt;img onerror=bad&gt;/);assert.doesNotMatch(html,/<img onerror=bad>/);assert.match(html,/文字样式 · 1 项/);assert.match(html,/@failed/);
});
