import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {normalizeVisualTreatment,visualTreatmentText,visualTreatmentContext,flatTypographyRule,flatBackgroundSubjectRule} from '../lib/visual-treatment.mjs';
import {imageStyle} from '../lib/image-prompts.mjs';
import {preserveReferencedDesign} from '../lib/preset-design.mjs';
import {designRulesFor} from '../lib/design-rules.mjs';
import {themeAssetPrompt,themeAssetsStamp} from '../lib/theme-assets.mjs';
import {slideImagePrompt} from '../lib/slide-image-prompts.mjs';
import {materialStamp} from '../lib/materials.mjs';
import {visualTreatmentOptions,themeAssetsPanel} from '../public/theme-assets.js';
import {workflowManifest} from '../lib/workflow-library.mjs';
import {fixtureRequest,fixtureReply} from './visual-fixture.mjs';

test('03 的两种表现选项互斥，在底图提示词规划前选择',()=>{
  const p={visualTreatment:'realistic',visualTreatmentOptionsEnabled:true,brief:{pages:1,cover:false},slides:[],materials:[],workflowLibrary:{}};
  const options=visualTreatmentOptions(p),html=themeAssetsPanel(p);
  assert.equal((options.match(/type="radio"/g)||[]).length,2);
  assert.match(options,/value="realistic" checked/);assert.doesNotMatch(options,/value="flat" checked/);
  assert.ok(html.indexOf('画面表现')<html.indexOf('data-theme-assets-generate'));
  assert.equal(normalizeVisualTreatment(), 'flat');assert.throws(()=>normalizeVisualTreatment('mixed'));
  assert.match(visualTreatmentOptions({...p,task:{status:'running'}}),/<fieldset[^>]+disabled/);
  assert.match(visualTreatmentOptions({...p,themeAssets:{directions:[{id:'a'}]}}),/data-theme-treatment-replan/);
  assert.doesNotMatch(options,/data-theme-treatment-replan/);
});

test('底图与预览只采用所选表现，风格名不发送，改变类型不使02材料内容过期',()=>{
  const d={id:'a',name:'不要发送这个登记名',coreColor:'#FFFFFF',style:'白与蓝',heroSubject:'修饰肽实体',tocSubject:'修饰肽实体',contentSubject:'修饰肽轮廓',typography:'无衬线',frames:'无框',decoration:'少量曲线'};
  const p={brief:{title:'修饰肽',cover:false,progress:false},materials:[],slides:[{kind:'content',title:'结果',body:['稳定性提高'],sources:[]}],pageDesigns:{0:{plan:{nodes:[],logic:'并列',layoutIntent:'左右对照'}}}};
  const stamp=materialStamp(p),baseStamp=themeAssetsStamp(p);
  for(const value of ['flat','realistic']){
    p.visualTreatment=value;
    const background=themeAssetPrompt(p,d,'content-background'),preview=slideImagePrompt(p,0,d,[]);
    for(const text of [background,preview]){
      assert.ok(text.includes(visualTreatmentText(value)));assert.ok(!text.includes(d.name));
      assert.ok(!text.includes(visualTreatmentText(value==='flat'?'realistic':'flat')));
    }
    assert.equal(materialStamp(p),stamp);assert.notEqual(themeAssetsStamp(p),baseStamp);
  }
});

test('简约字体口径覆盖规划、预览和重建，旧预设与原创书法描述不再带入生图',()=>{
  const original={id:'a',referenceStyleId:'A',typography:'标题采用毛笔书法体，正文手写体',style:'白色与蓝色',coreColor:'#FFFFFF'};
  const preset=preserveReferencedDesign(original),snapshot=structuredClone(preset);
  for(const direction of [original,preset]){
    const flat=imageStyle(direction,{visualTreatment:'flat'});
    assert.ok(flat.includes(flatTypographyRule));assert.doesNotMatch(flat,/标题采用毛笔|正文手写|汉仪尚巍/);
    assert.ok(!imageStyle(direction,{visualTreatment:'realistic'}).includes(flatTypographyRule));
    assert.ok(!imageStyle(direction,{visualTreatment:'flat',background:true}).includes(flatTypographyRule),'无字底图不附排字要求');
  }
  assert.deepEqual(preset,snapshot,'不改写预设原件或快照');
  const p={visualTreatment:'flat',brief:{title:'主题',progress:false},materials:[],slides:[{kind:'content',title:'结论',body:[],sources:[]}]};
  assert.ok(visualTreatmentContext(p).includes(flatTypographyRule));
  assert.match(visualTreatmentContext(p),/含书法字体的预设不整套继承/);
  for(const stage of ['design','rebuild'])assert.ok(designRulesFor(p,0,stage).includes(flatTypographyRule));
  assert.ok(!designRulesFor(p,0,'review').includes(flatTypographyRule),'不新增字体检查否决项');
  assert.ok(!visualTreatmentContext({...p,visualTreatment:'realistic'}).includes(flatTypographyRule));
});

test('简约封面与目录主题明确、视觉区丰满，保留阅读留白且不影响内容背景',()=>{
  const p={visualTreatment:'flat',brief:{title:'生态循环',cover:true,toc:true}},d={id:'a',name:'不发送的名称',coreColor:'#FFFFFF',heroSubject:'层叠叶片环绕的循环意象',tocSubject:'展开叶脉与循环色面的交织意象',contentSubject:'左下低对比叶片轮廓',textArea:'左侧阅读留白',style:'绿色'};
  assert.ok(visualTreatmentContext(p).includes(flatBackgroundSubjectRule));
  for(const use of ['hero-image','toc-image']){
    const prompt=themeAssetPrompt(p,d,use);assert.match(prompt,/平面色块、点阵/);assert.match(prompt,/避免复杂渐变与光影/);
    assert.ok(!prompt.includes(d.name));assert.match(prompt,/不含文字、数字/);
    assert.ok(!themeAssetPrompt({...p,visualTreatment:'realistic'},d,use).includes('大尺度轮廓与适度层次充实视觉区'));
  }
  const content=themeAssetPrompt(p,d,'content-background');assert.match(content,/中央大片留空/);assert.ok(!content.includes('充实视觉区'));
  assert.notEqual(themeAssetPrompt(p,d,'hero-image').split('主体：')[1].split('。')[0],themeAssetPrompt(p,d,'toc-image').split('主体：')[1].split('。')[0]);
});

test('项目规范库不再包含参考PPT联系表，保留文字与几何分块示意',()=>{
  assert.ok(!fs.existsSync('workflow-library/stages/13-design/references/reference-sheets'));
  assert.ok(workflowManifest.files.every(e=>!e.file.includes('reference-sheets/')));
  assert.ok(workflowManifest.files.some(e=>e.file.startsWith('shared/references/splits/')&&/\.(png|jpg)$/.test(e.file)));
  const doc=fs.readFileSync('workflow-library/stages/13-design/references/reference-index.md','utf8');assert.doesNotMatch(doc,/\]\(reference-sheets\//);
  const sync=fs.readFileSync('tools/sync_workflow_library.mjs','utf8');assert.match(sync,/applyLibraryPolicy\(target\)/);
});

test('真实 HTTP：选择先传给规划，切换类型重新规划并持久化，确认后生图使用相同类型',async t=>{
  const requests=[];let rejectPlanning=false;
  const mock=http.createServer(async(req,res)=>{const body=await fixtureRequest(req);requests.push(body);if(rejectPlanning&&body.messages?.at(-1)?.content?.startsWith?.('三方向底图规划：')){res.statusCode=401;res.end('{}');return;}res.setHeader('content-type','application/json');res.end(JSON.stringify((()=>{const reply=fixtureReply(body,{customDirections:true});const prompt=body.messages?.at(-1)?.content;if(typeof prompt==='string'&&prompt.startsWith('三方向底图规划：')&&prompt.includes('当前表现类型：visualTreatment=flat')){const raw=JSON.parse(reply.choices[0].message.content);raw.directions=raw.directions.map((d,i)=>({...d,styleSelection:{matchingPresetIds:[],matchingPaletteIds:[['A','C','E'][i]],reason:'合成测试：配色符合主题，原字体装饰不适合平面设计'}}));reply.choices[0].message.content=JSON.stringify(raw);}return reply;})()));});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const data=path.resolve('work','visual-treatment-'+Date.now());
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:data,PPT_AGENT_TEST:'1'},windowsHide:true,stdio:'ignore'});t.after(()=>app.kill());
  const base='http://127.0.0.1:'+port;
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const call=async(url,body,status=200)=>{const res=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),value=await res.json();assert.equal(res.status,status,JSON.stringify(value));return value;};
  let p=await call('/api/projects',{brief:{title:'合成测试主题',pages:1,cover:false}},201);const prefix='/api/projects/'+p.id,act=(action,b={})=>call(prefix+'/action',{action,...b});
  const wait=async(status='done')=>{for(let i=0;i<400;i++){p=await call(prefix);if(p.task?.status!=='running'){assert.equal(p.task.status,status,p.task.message);return;}await new Promise(r=>setTimeout(r,25));}throw Error('task timeout');};
  const config={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic',model:'synthetic'};
  await act('configure',{text:config,image:config});await act('saveContent',{slides:[{kind:'content',title:'稳定性',body:['保留完整内容'],sources:[]}]});
  const originalSlides=structuredClone((await call(prefix)).slides);
  await act('generateThemeAssets',{visualTreatment:'flat'});await wait();const firstSet=p.themeAssets.id;
  assert.equal(p.visualTreatment,'flat');assert.deepEqual(p.themeAssets.directions.map(d=>d.paletteReferenceId),['A','C','E']);assert.ok(p.themeAssets.directions.every(d=>!d.presetDesign&&d.paletteSource));assert.ok(p.themeAssetPrompts.every(d=>d.prompt.includes(visualTreatmentText('flat'))));
  await act('generateThemeAssets',{visualTreatment:'realistic'});await wait();assert.notEqual(p.themeAssets.id,firstSet);
  assert.equal(p.visualTreatment,'realistic');assert.deepEqual(p.slides,originalSlides);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,p.id,'project.json'),'utf8')).visualTreatment,'realistic');
  assert.ok(p.themeAssetPrompts.every(d=>d.prompt.includes(visualTreatmentText('realistic'))&&!d.prompt.includes(visualTreatmentText('flat'))));
  const planning=requests.filter(b=>b.messages?.at(-1)?.content?.startsWith?.('三方向底图规划：'));assert.equal(planning.length,2);
  assert.match(planning[0].messages.at(-1).content,/当前表现类型：visualTreatment=flat/);assert.match(planning[1].messages.at(-1).content,/当前表现类型：visualTreatment=realistic/);
  await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts.slice(0,1)});await wait();
  const image=requests.find(b=>b.prompt);assert.ok(image.prompt.includes(visualTreatmentText('realistic')));assert.ok(!image.prompt.includes(p.themeAssets.directions[0].name));
  const oldDirection=structuredClone(p.themeAssets.directions[0]),previousSet=p.themeAssets.id;
  await act('regenerateThemePrompts',{visualTreatment:'flat'});await wait();
  assert.equal(p.visualTreatment,'flat');assert.notEqual(p.themeAssets.id,previousSet);
  const history=p.themeAssets.directions[0].revisionHistory.at(-1);
  assert.equal(history.visualTreatment,'realistic');assert.equal(history.reason,'change-visual-treatment');
  assert.deepEqual(history.assets,oldDirection.assets);assert.deepEqual(p.slides,originalSlides);
  assert.ok(p.themeAssetPrompts.every(d=>d.prompt.includes(visualTreatmentText('flat'))));
  await act('generateThemeAssets',{confirmed:true,prompts:p.themeAssetPrompts.slice(0,1)});await wait();const flatImage=requests.filter(b=>b.prompt).at(-1);assert.ok(flatImage.prompt.includes(visualTreatmentText('flat')));assert.equal(p.themeAssets.directions[0].coreColor,'#FFFFFF');
  const preserved=structuredClone(p.themeAssets),registry=structuredClone(p.styleRegistry);
  rejectPlanning=true;await act('generateThemeAssets',{visualTreatment:'realistic'});await wait('failed');
  assert.equal(p.visualTreatment,'flat');assert.deepEqual(p.themeAssets,preserved);assert.deepEqual(p.styleRegistry,registry);
  const saved=JSON.parse(fs.readFileSync(path.join(data,p.id,'project.json'),'utf8'));assert.equal(saved.visualTreatment,'flat');assert.deepEqual(saved.themeAssets,preserved);
  await call(prefix+'/action',{action:'generateThemeAssets',visualTreatment:'invalid'},400);
});

 test('简约与写实底图主体、留白要求一致，只替换绘画表现且不附长段规范',()=>{
  const d={id:'a',name:'测试风格',coreColor:'#FFFFFF',style:'蓝色',heroSubject:'贯穿全篇的生态树冠',tocSubject:'展开的生态叶脉',contentSubject:'叶片轮廓',textArea:'左侧留白'};
  const p={brief:{title:'生态'},visualTreatment:'flat'};
  for(const use of ['hero-image','toc-image','content-background']){
    const flat=themeAssetPrompt(p,d,use),real=themeAssetPrompt({...p,visualTreatment:'realistic'},d,use);
    assert.equal(flat.replace(visualTreatmentText('flat'),'表现'),real.replace(visualTreatmentText('realistic'),'表现'));
    assert.ok(flat.length<320);assert.ok(!flat.includes(flatBackgroundSubjectRule));
  }
  const style=imageStyle({...d,typography:'书法体渐变',frames:'斜切框；蓝色渐变填充',decoration:'复杂光影；点阵'},{visualTreatment:'flat'});
  assert.match(style,/文字无渐变/);assert.match(style,/色块与文本框用平整填充/);assert.doesNotMatch(style,/蓝色渐变填充|复杂光影|书法体渐变/);assert.match(style,/斜切框/);
  assert.match(visualTreatmentContext(p),/主体选取要求|主体均须/);
 });

test('风格规则沿用原有提示词模板分段，不新增规范分栏',()=>{
 const p={brief:{title:'测试'},visualTreatment:'flat'},d={coreColor:'#FFFFFF',heroSubject:'生态树冠',style:'绿色',textArea:'右侧留白'};
 const prompt=themeAssetPrompt(p,d,'hero-image');
 assert.match(prompt,/^用途：.*。表现：.*。主体：.*。画面：/);
 assert.doesNotMatch(prompt,/\n|风格规范|页内元素|主体选取要求/);
 assert.match(visualTreatmentContext(p),/保持现有模板的分段与字段顺序/);
});
