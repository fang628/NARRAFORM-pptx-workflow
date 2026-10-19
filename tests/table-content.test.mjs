import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {fixtureReply,fixtureRequest} from './visual-fixture.mjs';
import JSZip from 'jszip';
import {sourceTableCatalog,validateTableContent,tableMarkdown,tablePlanningRule} from '../lib/table-content.js';
import {validateReading} from '../lib/materials.mjs';
import {validateSlides,scene,themes,buildDeck} from '../lib/scene.mjs';
import {bindSources,targetText} from '../lib/sources.mjs';
import {sourceEvidenceCatalog} from '../lib/sources.mjs';
import {canonicalTexts,validateAudit} from '../lib/visual-model.mjs';
import {slideImagePrompt,effectiveSlideImagePrompt} from '../lib/slide-image-prompts.mjs';
import {canonicalDesignTree} from '../lib/page-design.mjs';
import {moveElementBranch,initialElements} from '../lib/elements.mjs';

const table={id:'results',type:'table',label:'编辑用标签不上屏',headers:['分组','响应率','条件'],rows:[['处理组','32%','24 h'],['对照组','20%','24 h']],parentId:'heading'};
const makeSlide=()=>validateSlides([{kind:'content',sources:[],elements:[{id:'title',type:'text',role:'title',text:'处理组响应率更高',parentId:null},{id:'heading',type:'group',label:'组间比较',parentId:'title'},table]}])[0];
async function editor(){const code=fs.readFileSync('public/element-editor.js','utf8').replace("'/elements-model.js'",JSON.stringify(pathToFileURL(path.resolve('lib/elements.mjs')).href)).replace("'./provenance.js'",JSON.stringify(pathToFileURL(path.resolve('public/provenance.js')).href));return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));}

test('Word、PDF、Markdown结构单元格按原文偏移进入表格目录，CSV保留引号、换行与空值',()=>{
  const source='分组\t数值\n处理组\t32%\n',m={text:source,richText:{structures:[{type:'table',start:0,rows:[[{start:0,end:2},{start:3,end:5}],[{start:6,end:9},{start:10,end:13}]]}]}};
  const catalog=sourceTableCatalog(m);assert.deepEqual(catalog[0].rows,[['分组','数值'],['处理组','32%']]);assert.equal(catalog[0].partial,false);
  assert.deepEqual(sourceTableCatalog({name:'原始.csv',text:'项目,说明,值\nA,"含,逗号",0\nB,"两行\n说明",\n'})[0].rows,[['项目','说明','值'],['A','含,逗号','0'],['B','两行\n说明','']]);
  const reading=validateReading({summary:'比较数据',keyPoints:[],facts:[],questions:[],tables:[table,{headers:['错'],rows:[['列数','错误']]}]}, {id:'source',kind:'document'},source);
  assert.equal(reading.tables.length,1);assert.equal(reading.tables[0].rows[0][1],'32%');assert.equal(reading.questions.length,1,'无效表格不丢弃其他正确分析');
});

test('表格字段保存、来源定位、拖动及Markdown生成不丢数据，特殊字符和换行安全转义',()=>{
  const s=makeSlide();assert.deepEqual(s.elements.find(n=>n.type==='table').rows,table.rows);assert.equal(s.body.length,0);
  assert.throws(()=>validateTableContent({headers:['列'],rows:[['不','齐']]}),/列数/);
  const moved=moveElementBranch(s.elements,'results','title','inside');assert.equal(moved.find(n=>n.id==='results').parentId,'title');assert.deepEqual(moved.find(n=>n.id==='results').rows,table.rows);
  s.sourceLinks=[{materialId:'doc',target:'element:results',quote:'处理组32%'}];bindSources({materials:[{id:'doc',kind:'document',text:'处理组32%；对照组20%'}]},[s]);assert.equal(s.sourceLinks[0].stale,false);assert.match(targetText(s,'element:results'),/\| 处理组 \| 32% \|/);
  s.elements.find(n=>n.type==='table').rows[0][1]='33%';bindSources({materials:[{id:'doc',kind:'document',text:'处理组32%；对照组20%'}]},[s]);assert.equal(s.sourceLinks[0].stale,true);
  assert.equal(tableMarkdown({headers:['A|B','路径'],rows:[['第一行\n第二行','C:\\x']]}),'| A\\|B | 路径 |\n| --- | --- |\n| 第一行<br>第二行 | C:\\\\x |');
});

test('表格在内容树逐格编辑、增删行列，保留未编辑页、来源和文字节点',async()=>{
  const {elementEditor,collectElementSlide,mutateElements}=await editor(),s=makeSlide(),snapshot=structuredClone(s);
  const html=elementEditor({id:'test',tableContentEnabled:true,materials:[]},s,0);assert.match(html,/data-element-type="table"/);assert.match(html,/data-table-cell="1" data-table-row="0"/);assert.match(html,/可编辑表格/);assert.doesNotMatch(html,/tree-shape-preview/);
  const field={dataset:{tableCell:'1',tableRow:'0'},value:'35%'};
  const dom={querySelector(selector){return selector.includes('"results"')?{querySelectorAll:q=>q==='[data-table-cell]'?[field]:[]}:null;},querySelectorAll:()=>[]};
  const edited=collectElementSlide(dom,s);assert.equal(edited.elements.find(n=>n.id==='results').rows[0][1],'35%');assert.deepEqual(s,snapshot);
  mutateElements(edited,'table-add-row','results');mutateElements(edited,'table-add-column','results');let n=edited.elements.find(n=>n.id==='results');assert.equal(n.rows.length,3);assert.ok(n.rows.every(row=>row.length===4));
  mutateElements(edited,'table-remove-row','results','2');mutateElements(edited,'table-remove-column','results','3');assert.deepEqual(validateSlides([edited])[0].elements.find(n=>n.id==='results').rows,[['处理组','35%','24 h'],table.rows[1]]);
  mutateElements(edited,'add',null,'table');assert.equal(edited.elements.filter(n=>n.type==='table').length,2);assert.doesNotThrow(()=>validateSlides([edited]));
});

test('预览提示词的内容分项和设计稿使用嵌套Markdown表格，不重复标签或把表格当配图',()=>{
  const s=makeSlide(),p={brief:{title:'比较',progress:false},materials:[],slides:[s],pageDesigns:{0:{plan:{nodes:s.elements.map(n=>({id:n.id,position:'中部',relativeSize:'适中',alignment:'对齐',carrier:'表格',relation:'所属主题'}))}}}},d={id:'a',coreColor:'FFFFFF',style:'清晰',styleSummary:'简洁'};
  const prompt=slideImagePrompt(p,0,d,[]),content=prompt.split('- **内容要求**：')[1].split('- **排版要求**：')[0];assert.match(content,/\| 分组 \| 响应率 \| 条件 \|/);assert.match(content,/\| --- \| --- \| --- \|/);assert.match(content,/\| 对照组 \| 20% \| 24 h \|/);assert.doesNotMatch(content,/编辑用标签不上屏/);assert.match(prompt,/本页没有登记图片/);assert.match(effectiveSlideImagePrompt(p,0,d,[],'full',prompt),/\| 处理组 \| 32% \| 24 h \|/);
  assert.match(canonicalDesignTree(p,0,p.pageDesigns[0].plan),/\| 处理组 \| 32% \| 24 h \|/);
});

test('表格单元格进入05准确文字清单和原生PPTX；重复数值按单元格身份分别保留',async()=>{
  const s=makeSlide(),texts=canonicalTexts(s),cells=texts.filter(t=>t.tableId==='results');assert.equal(cells.length,9);assert.equal(cells.filter(c=>c.text==='24 h').length,2);assert.equal(new Set(cells.map(c=>c.nodeId)).size,9);
  const audit=texts.map((t,i)=>({...t,key:'text'+i,type:'text',x:50+i%3*350,y:100+Math.floor(i/3)*100,w:300,h:60,size:28,color:'222222'}));assert.doesNotThrow(()=>validateAudit(audit,s,[],{brief:{progress:false},slides:[s]},0));assert.throws(()=>validateAudit(audit.filter(t=>t.nodeId!=='results-cell-2-2'),s,[]),/遗漏/);
  assert.ok(scene(s,themes[1],0,1,{progress:false}).some(e=>e.text==='32%'));
  const dir=fs.mkdtempSync(path.resolve('work/table-content-')),file=path.join(dir,'table.pptx');await buildDeck({brief:{title:'表格',progress:false},slides:[s],concepts:themes,selectedTheme:'b'},file,()=>null);
  const zip=await JSZip.loadAsync(fs.readFileSync(file)),xml=await zip.file('ppt/slides/slide1.xml').async('string');assert.match(xml,/>32%</);assert.equal((xml.match(/>24 h</g)||[]).length,2);assert.doesNotMatch(xml,/<p:pic>/);
});

test('实际Markdown提取的表格结构可直接送入分析，无需重识别为长段正文',()=>{
  const dir=fs.mkdtempSync(path.resolve('work/table-extract-')),file=path.join(dir,'material.md');fs.writeFileSync(file,'## 对比\n\n| 组别 | 响应率 |\n| --- | --- |\n| 处理组 | **32%** |\n| 对照组 | 20% |\n');
  const result=JSON.parse(execFileSync(path.resolve('.venv/Scripts/python.exe'),[path.resolve('tools/extract.py'),file],{encoding:'utf8',windowsHide:true}));assert.deepEqual(sourceTableCatalog(result)[0].rows,[['组别','响应率'],['处理组','32%'],['对照组','20%']]);
});

test('真实HTTP材料分析→表格规划→编辑保存→重载：表格与证据保持同步',{timeout:30000},async t=>{
  let materialId,excerptId;const prompts=[];
  const mock=http.createServer(async(req,res)=>{try{const body=await fixtureRequest(req),prompt=body.messages?.at(-1)?.content||'';prompts.push(prompt);let reply=fixtureReply(body);
    if(prompt.includes('识别与理解单份材料'))reply={choices:[{message:{content:JSON.stringify({category:'数据材料',summary:'处理与对照比较',keyPoints:['响应率'],facts:[],questions:[],tables:[{...table,tableId:'T1',suggestedUse:'单页比较'}]})}}]};
    if(prompt.startsWith('根据材料写恰好'))reply={choices:[{message:{content:JSON.stringify({slides:[{...makeSlide(),sources:[materialId],sourceLinks:[{materialId,target:'element:results',excerptId}]}]})}}]};
    res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));}catch(error){res.statusCode=500;res.end(JSON.stringify({error:{message:error.message}}));}});await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const listener=http.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const data=fs.mkdtempSync(path.resolve('work/table-http-')),base='http://127.0.0.1:'+port,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:data,PPT_AGENT_TEST:'1'},windowsHide:true,stdio:'ignore'});t.after(()=>server.kill());
  const until=async(fn)=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error('HTTP表格通路等待超时');};await until(async()=>{try{return (await fetch(base+'/api/health')).ok;}catch{return false;}});
  const call=async(url,body)=>{const r=await fetch(base+url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;};
  let p=await call('/api/projects',{brief:{title:'表格对比',audience:'评审',pages:1,cover:false,toc:false,progress:false}}),prefix='/api/projects/'+p.id;const act=(action,extra={})=>call(prefix+'/action',{action,...extra}),wait=()=>until(async()=>{p=await call(prefix);if(p.task?.status==='failed')throw Error(p.task.message);return p.task?.status!=='running';});
  p=await call(prefix+'/materials',{name:'比较.md',base64:Buffer.from('| 分组 | 响应率 | 条件 |\n| --- | --- | --- |\n| 处理组 | 32% | 24 h |\n| 对照组 | 20% | 24 h |\n').toString('base64')});const material=p.materials[0];materialId=material.id;excerptId=sourceEvidenceCatalog(material).find(e=>e.text.includes('32%')).id;
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',key:'synthetic-only',model:'table-fixture'};await act('configure',{text:cfg});await act('requirements',{brief:p.brief});await act('analyzeMaterials');await wait();assert.equal(p.analysis.readings[0].tables[0].rows[0][1],'32%');assert.ok(prompts.some(prompt=>prompt.includes('提取的表格结构')&&prompt.includes('T1')));
  await act('approveAnalysis');await act('content');await wait();assert.ok(p.tableContentEnabled);assert.deepEqual(p.slides[0].elements.find(n=>n.type==='table').rows,table.rows);assert.match(p.pageDesigns[0].markdown,/\| 处理组 \| 32% \| 24 h \|/);assert.ok(prompts.some(prompt=>prompt.includes('根据材料写恰好')&&prompt.includes('type=table')));
  p.slides[0].elements.find(n=>n.type==='table').rows[0][1]='33%';await act('saveContent',{slides:p.slides});p=await call(prefix);assert.equal(p.slides[0].elements.find(n=>n.type==='table').rows[0][1],'33%');assert.equal(p.slides[0].sourceLinks[0].stale,true);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data,p.id,'project.json'))).slides,p.slides);
  assert.equal((await fetch(base+'/table-content.js')).status,200);
});

test('原材料纯文字结论可组织为表格，保留来源及单元格文字，不要求数值或原表',()=>{
 const content={headers:['方案','适用条件','结论'],rows:[['方案甲','材料充分时','方案甲适合直接复用材料。'],['方案乙','材料缺少时','方案乙需要补充说明。']]};
 const source='方案甲适合直接复用材料。方案乙需要补充说明。',reading=validateReading({summary:'两种方案的适用结论',keyPoints:[],facts:[],questions:[],tables:[{tableId:null,...content,suggestedUse:'按条件对照结论'}]},{id:'doc',kind:'document'},source);
 assert.equal(reading.tables.length,1);assert.deepEqual(reading.tables[0].rows,content.rows);
 const slide=validateSlides([{kind:'content',sources:['doc'],elements:[{id:'title',type:'text',role:'title',text:'方案适用结论',parentId:null},{id:'conclusions',type:'table',label:'编辑用表格',...content,parentId:'title'}]}])[0];
 slide.sourceLinks=[{materialId:'doc',target:'element:conclusions',quote:source}];bindSources({materials:[{id:'doc',kind:'document',text:source}]},[slide]);assert.equal(slide.sourceLinks[0].stale,false);
 assert.match(tableMarkdown(slide.elements.find(e=>e.id==='conclusions')),/方案甲适合直接复用材料。/);
 assert.ok(canonicalTexts(slide).some(e=>e.text==='方案乙需要补充说明。'));assert.equal(slide.elements.filter(e=>e.type==='text'&&e.role==='body').length,0);
 assert.match(tablePlanningRule,/不限定数值数据/);assert.match(tablePlanningRule,/不要求材料中已有原表/);
});
