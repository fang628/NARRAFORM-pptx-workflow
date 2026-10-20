import test from 'node:test';
import assert from 'node:assert/strict';
import {artisticCutoutPrompt} from '../lib/artistic-text.mjs';
import {safeDecorationCrop} from '../lib/rebuild-tools.mjs';
import {rebuildRegionDialog} from '../public/visual-ui.js';
test('书法字使用透明图生图提示词，统一弹窗不要求指定类型或文字',()=>{
 const prompt=artisticCutoutPrompt({prompt:'保留金色笔触',text:'山河'});
 assert.match(prompt,/山河/);assert.match(prompt,/透明背景/);assert.match(prompt,/全部笔画/);assert.doesNotMatch(prompt,/禁止文字/);
 assert.match(rebuildRegionDialog,/自动识别图形或书法字/);assert.doesNotMatch(rebuildRegionDialog,/rebuildRegionTextKey|rebuildRegionKind/);assert.match(rebuildRegionDialog,/选填/);
});
test('书法字抠图只豁免对应文字，仍保护其他文字和原图，框选提示不限制完整字迹',()=>{
 const title={type:'text',key:'title',nodeId:'title',text:'山河',x:50,y:50,w:300,h:80},a={key:'title',nodeId:'title',text:'山河'};
 assert.throws(()=>safeDecorationCrop(title,{elements:[title]}),/文字/);
 assert.doesNotThrow(()=>safeDecorationCrop(title,{elements:[title]},a));
 for(const other of [{...title,key:'body',nodeId:'body',text:'正文'},{...title,type:'image',id:'fact'}])assert.throws(()=>safeDecorationCrop(title,{elements:[title,other]},a),/文字/);
});

test('统一弹窗只框选即可提交，无需描述、类型或文字编号',async()=>{
 const {initRebuildRegionEditor}=await import('../public/visual-ui.js');
 const ids=['rebuildRegionDialog','rebuildRegionBoard','rebuildRegionImage','rebuildRegionSelection','rebuildRegionDescription','rebuildRegionState','resetRebuildRegion','submitRebuildRegion'];
 const nodes=Object.fromEntries(ids.map(id=>[id,{style:{},listeners:{},value:'',addEventListener(name,fn){this.listeners[name]=fn;},showModal(){},close(){},setPointerCapture(){},complete:true,getBoundingClientRect(){return {left:0,top:0,width:1600,height:900};}}]));
 const prior=globalThis.document;globalThis.document={getElementById:id=>{assert(ids.includes(id),'不访问旧选择器');return nodes[id];}};
 try{
  let sent;const editor=initRebuildRegionEditor({getProject:()=>({id:'p',visualPages:[{previewHash:'hash'}]}),busy:()=>false,act:async(action,payload)=>{sent={action,payload};},onError:message=>{throw Error(message);}});
  editor.open(0);
  const event={button:0,pointerId:1,clientX:50,clientY:50,preventDefault(){}};
  nodes.rebuildRegionBoard.listeners.pointerdown(event);nodes.rebuildRegionBoard.listeners.pointerup({...event,clientX:400,clientY:150});
  await nodes.submitRebuildRegion.onclick();assert.equal(sent.action,'extractRebuildRegion');assert(!('artisticTextKey' in sent.payload));assert.equal(sent.payload.instruction,'');assert.equal(sent.payload.previewHash,'hash');assert.equal(sent.payload.region.w,350);
  editor.open(0);assert.equal(nodes.rebuildRegionDescription.value,'');
 }finally{globalThis.document=prior;}
});

test('PPTX导出以透明图片保存书法字，普通正文保持原生文字且无重复标题',async()=>{
 const fs=await import('node:fs'),path=await import('node:path');
 const {Resvg}=await import('@resvg/resvg-js'),{default:JSZip}=await import('jszip');
 const {buildVisualDeck}=await import('../lib/visual-build.mjs');
 const {digest}=await import('../lib/visual-model.mjs'),{themeAssetsStamp}=await import('../lib/theme-assets.mjs');
 const dir=fs.mkdtempSync(path.resolve('work','artistic-text-')),bg=path.join(dir,'bg.png'),glyph=path.join(dir,'glyph.png');
 const background=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#eee"/></svg>').render().asPng();
 fs.writeFileSync(bg,background);fs.writeFileSync(glyph,new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><path d="M20 20L380 80M50 90L300 10" stroke="#222" stroke-width="8"/></svg>').render().asPng());
 const p={brief:{title:'书法补拆',progress:false},slides:[{kind:'content',title:'山河',body:['准确正文'],sources:[]}],selectedTheme:'a',concepts:[{id:'a',coreColor:'EEEEEE'}],materials:[{id:'bg',file:bg,kind:'image',purpose:'workflow-background',sha256:digest(background)}]};
 p.themeAssets={stamp:themeAssetsStamp(p),directions:[{id:'a',assets:{'content-background':{materialId:'bg',previewHash:digest(background),normalized:bg}}}]};
 p.reconstruction={slides:[{background:{id:'bg',sha256:digest(background)},elements:[{key:'title',type:'image',id:'glyph',implementation:'cutout',artisticText:true,text:'山河',nodeId:'title',x:80,y:100,w:800,h:200},{key:'body',type:'text',text:'准确正文',nodeId:'body-0',x:80,y:400,w:800,h:90,size:32,color:'222222'}]}]};
 const deck=path.join(dir,'artistic.pptx');await buildVisualDeck(p,deck,(_,id)=>id==='bg'?bg:glyph);
 const zip=await JSZip.loadAsync(fs.readFileSync(deck)),xml=await zip.file('ppt/slides/slide1.xml').async('string');
 assert.equal((xml.match(/<p:pic>/g)||[]).length,1);assert.match(xml,/descr="书法字：山河"/);assert.match(xml,/<a:t>准确正文<\/a:t>/);assert.doesNotMatch(xml,/<a:t>山河<\/a:t>/);
});

test('自然语言可自动定位唯一文字，歧义交给模型识别而非要求用户选择',async()=>{
 const {resolveArtisticTextKey}=await import('../lib/artistic-text.mjs');
 const nodes=[{type:'text',key:'title',nodeId:'title',text:'山河',x:10,y:10,w:400,h:80},{type:'text',key:'body',nodeId:'body',text:'正文',x:10,y:200,w:400,h:80}];
 assert.equal(resolveArtisticTextKey(nodes,{x:20,y:20,w:40,h:40},'拆出框中的书法字'),'title');
 assert.equal(resolveArtisticTextKey(nodes,{x:0,y:0,w:450,h:400},'抠出山河书法字'),'title');
 assert.equal(resolveArtisticTextKey(nodes,{x:0,y:0,w:450,h:400},'提取书法字'),undefined);
 assert.equal(resolveArtisticTextKey(nodes,{},'提取图标'),undefined);
});

test('模型自动匹配候选文字，歧义要求工具自行定位，普通图形不获得文字替换权限',async()=>{
 const {artisticTextCandidates,automaticArtisticTarget}=await import('../lib/artistic-text.mjs');
 const scope={automaticTarget:true,artisticCandidates:artisticTextCandidates([{key:'title',type:'text',nodeId:'title',text:'标题',x:50,y:50,w:500,h:70},{key:'body',type:'text',nodeId:'body-0',text:'正文',x:50,y:200,w:500,h:70},{key:'nav',type:'text',nodeId:'navigation-a',role:'navigation',text:'章节'}])};
 assert.equal(scope.artisticCandidates.length,2);
 const args={method:'cutout',key:'new-glyph',contentType:'artistic_text',sourceBox:{x:60,y:60,w:100,h:40}};
 assert.deepEqual(automaticArtisticTarget(scope,args),{key:'title',nodeId:'title',text:'标题'});
 assert.equal(automaticArtisticTarget(scope,{...args,textKey:'body'}).key,'body');
 assert.throws(()=>automaticArtisticTarget(scope,{...args,textKey:'nav'}),/候选/);
 assert.throws(()=>automaticArtisticTarget(scope,{...args,sourceBox:{x:0,y:0,w:600,h:300}}),/无需用户指定/);
 assert.equal(automaticArtisticTarget(scope,{...args,contentType:'visual'}),null);
 assert.equal(automaticArtisticTarget(scope,{...args,contentType:undefined,prompt:'抠出完整毛笔字并保留笔触'}).key,'title');
});
