import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {sourceTextView,sourcePanel,sourceMathHTML,groupSourceLinks} from '../public/provenance.js';
import {bindSources,sourceEvidenceCatalog} from '../lib/sources.mjs';
import {materialStamp} from '../lib/materials.mjs';
const python=path.resolve('.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const fixture=path.resolve('work','document-format-'+Date.now());
execFileSync(python,['tests/document-format-fixture.py',fixture],{windowsHide:true});
const extract=ext=>JSON.parse(execFileSync(python,['tools/extract.py',path.join(fixture,'formatted.'+ext)],{encoding:'utf8',windowsHide:true,maxBuffer:32_000_000}));
const spanAt=(m,text)=>m.richText.spans.find(s=>s.start<=m.text.indexOf(text)&&s.end>=m.text.indexOf(text)+text.length);
test('DOCX 保留样式继承、连续行内文字、显式换行、表格和 OMML 公式，UTF16 坐标准确',()=>{
  const m=extract('docx');assert.equal(m.richText.format,'docx');assert.match(m.text,/普通😀文本 加粗内容 斜体\n换行后\t制表后/);
  assert.equal(spanAt(m,'报告标题').fontSize,24);assert.equal(spanAt(m,'报告标题').bold,true);
  assert.equal(spanAt(m,'加粗内容').fontSize,16);assert.equal(spanAt(m,'加粗内容').bold,true);
  assert.equal(spanAt(m,'继承斜体').italic,true);assert.equal(spanAt(m,'不斜体').italic,false);
  const table=m.richText.structures.find(s=>s.type==='table');assert.equal(table.rows.length,2);assert.equal(table.rows[1].length,2);assert.equal(m.text.slice(table.rows[1][1].start,table.rows[1][1].end).trim(),'42');
  const formula=m.richText.structures.find(s=>s.type==='formula');assert.equal(m.text.slice(formula.start,formula.end),'(a)/(b)=x^{2}');
  const view=sourceTextView(m,{quote:'加粗内容 斜体'});assert.equal(view.missing,false);assert.match(view.html,/font-size:16pt;font-weight:700/);assert.match(view.html,/<table class="source-document-table"/);assert.match(view.html,/<mfrac>/);assert.match(view.html,/<msup>/);assert.equal((view.html.match(/id="sourceQuoteMark"/g)||[]).length,1);
});
test('Markdown 标题、加粗斜体、换行、表格及 TeX 数学式在索引中渲染且禁止 HTML 执行',()=>{
  const m=extract('md'),view=sourceTextView(m);assert.equal(spanAt(m,'项目报告').fontSize,28);assert.equal(spanAt(m,'加粗内容').bold,true);assert.equal(spanAt(m,'斜体内容').italic,true);assert.match(m.text,/换行后一行。\n强制换行/);
  assert.match(view.html,/<table /);assert.match(view.html,/<th /);assert.match(view.html,/<msup>/);assert.match(view.html,/<mfrac>/);assert.match(view.html,/<msqrt>/);assert.doesNotMatch(view.html,/<script>/);assert.match(view.html,/&lt;script&gt;/);
  assert.equal(sourceMathHTML({tag:'script',text:'alert(1)'}),'');assert.doesNotMatch(sourceMathHTML({tag:'math',attributes:{onclick:'x'},children:[{tag:'mi',text:'<img>'}]}),/onclick|<img>/);
});
test('PDF 提取字号、粗体斜体、换行及表格行列，不重复表格内容',()=>{
  const m=extract('pdf');assert.equal(m.pageCount,1);assert.equal(m.needsOCR,false);assert.equal(spanAt(m,'Report title').fontSize,24);assert.equal(spanAt(m,'Report title').bold,true);assert.equal(spanAt(m,'Italic text').italic,true);
  assert.match(m.text,/Regular text\nItalic text/);const table=m.richText.structures.find(s=>s.type==='table');assert.equal(table.rows.length,2);assert.equal(table.rows[0].length,2);assert.equal((m.text.match(/Sample A/g)||[]).length,1);assert.match(sourceTextView(m).html,/<table /);
});
test('细分证据定位到单元格和最短原句，同段多字段仅显示一次并保留各项操作',()=>{
  const m={...extract('docx'),id:'m',kind:'document',name:'报告.docx'},p={id:'p',materials:[m]},catalog=sourceEvidenceCatalog(m);
  const cell=m.richText.structures.find(s=>s.type==='table').rows[1][1],entry=catalog.find(e=>e.start===cell.start);assert.ok(entry);assert.equal(entry.text.trim(),'42');
  const slide={title:'标题',body:['数值','加粗','斜体'],sources:['m'],sourceLinks:[{id:'c',materialId:'m',target:'body:0',excerptId:entry.id,quote:'42'},{id:'b',materialId:'m',target:'body:1',quote:'加粗内容'},{id:'i',materialId:'m',target:'body:2',quote:'斜体'}]};bindSources(p,[slide],{resolveExcerptIds:true});assert.equal(slide.sourceLinks[0].location.row,2);assert.equal(slide.sourceLinks[0].location.column,2);
  const groups=groupSourceLinks(p,slide.sourceLinks);assert.equal(groups.length,2);assert.equal(groups[1].links.length,2);
  const html=sourcePanel(p,slide,0);assert.equal((html.match(/<article class="source-link /g)||[]).length,2);assert.equal((html.match(/<blockquote>/g)||[]).length,2);assert.match(html,/第 2 行第 2 列/);assert.match(html,/font-weight:700/);for(const id of ['b','i','c'])assert.match(html,new RegExp('data-link-id="'+id+'"'));
  // Identical text at distinct source positions must stay distinct.
  const repeated={id:'r',text:'相同文字\n相同文字',kind:'document'},rp={materials:[repeated]};assert.equal(groupSourceLinks(rp,[{materialId:'r',quote:'相同文字',location:{start:0,end:4}},{materialId:'r',quote:'相同文字',location:{start:5,end:9}}]).length,2);
});
test('旧项目补读格式不改正文、引用与批准，HTTP 上传保存格式，独立 OCR 入口移除',async t=>{
  const data=path.join(fixture,'data'),id='3bb35c44-85ed-4c91-939f-06528dcc5f77',assets=path.join(data,id,'assets');fs.mkdirSync(assets,{recursive:true});fs.copyFileSync(path.join(fixture,'formatted.docx'),path.join(assets,'old.docx'));
  const m={id:'old',file:'old.docx',name:'原有材料.docx',kind:'document',sha256:'original',text:'报告标题\n普通😀文本 \n加粗内容\n 斜体\n换行后\n制表后\n'},p={id,name:'原有项目',brief:{title:'格式测试',pages:1},materials:[m],slides:[],concepts:[],version:1,approvals:{content:1},stage:1};p.analysis={stamp:materialStamp(p),approvedAt:'kept',readings:[]};fs.writeFileSync(path.join(data,id,'project.json'),JSON.stringify(p));
  const http=await import('node:http'),reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),PPT_AGENT_DATA:data,PPT_AGENT_TEST:'1'},stdio:'ignore',windowsHide:true});t.after(()=>app.kill());const base='http://127.0.0.1:'+port;
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const response=await fetch(base+'/api/projects/'+id+'/materials/old/document');assert.equal(response.status,200);const view=await response.json();assert.ok(view.richText);assert.ok(view.sourceMap.length);
  const updated=await(await fetch(base+'/api/projects/'+id)).json();assert.equal(updated.materials[0].text,m.text);assert.equal(updated.analysis.approvedAt,'kept');assert.equal(updated.analysisCurrent,true);assert.equal(updated.approvals.content,1);
  const linked=sourceTextView({...m,documentView:view},{quote:'加粗内容\n 斜体',location:{start:m.text.indexOf('加粗内容'),end:m.text.indexOf('换行后')-1}});assert.equal(linked.missing,false);assert.match(linked.html,/id="sourceQuoteMark"/);
  for(const ext of ['md','pdf','docx']){const r=await fetch(base+'/api/projects/'+id+'/materials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'材料.'+ext,base64:fs.readFileSync(path.join(fixture,'formatted.'+ext)).toString('base64')})});assert.equal(r.status,200,await r.clone().text());const result=await r.json();assert.equal(result.materials.at(-1).richText.format,ext);}
  assert.doesNotMatch(fs.readFileSync('public/app.js','utf8'),/function ocrEditor|data\.ocrMaterial|data\.acceptOcr/);assert.doesNotMatch(fs.readFileSync('public/index.html','utf8'),/data-test-api="ocr"/);
  assert.match(fs.readFileSync('public/style.css','utf8'),/\.preview-grid\{align-items:start\}/);
});
