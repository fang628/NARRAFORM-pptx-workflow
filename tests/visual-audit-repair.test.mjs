import test from 'node:test';
import assert from 'node:assert/strict';
import {visualTextStyle} from '../lib/visual-text-style.mjs';
import {restoreAuditTexts,auditedElements,auditRepairLimit} from '../lib/visual-audit-repair.mjs';
import {canonicalTexts,validateAudit} from '../lib/visual-model.mjs';

const slide={title:'准确标题',body:['第一行\n第二行','重复文字','重复文字'],sources:[]};
const make=()=>canonicalTexts(slide).map((n,i)=>({...n,key:'text-'+i,type:'text',x:50,y:100+i*100,w:800,h:80,size:30,color:'#272727',bold:i===0}));

test('原生文字兼容数字字符串、单位、字重及缺省样式，非法值明确定位',()=>{
  for(const [input,size,bold] of [[{size:'28',bold:'false'},28,false],[{size:'24px',bold:'true'},24,true],[{size:'24pt',fontWeight:700},40,true],[{fontSize:30,fontWeight:'regular'},30,false],[{size:26,bold:1},26,true],[{},44,true],[{size:8,bold:400},12,false],[{size:140,bold:'600'},110,true]])assert.deepEqual(visualTextStyle({key:'a',...input},'title'),{size,bold});
  for(const input of [{size:'large'},{size:NaN},{size:Infinity},{size:0},{size:true},{size:{}},{bold:'maybe'},{bold:99}])assert.throws(()=>visualTextStyle({key:'bad-node',...input},'body'),e=>e.code==='INVALID_VISUAL_TEXT_STYLE'&&e.message.includes('bad-node'));
  const raw=make();raw[0].size='40';raw[0].bold='bold';assert.equal(validateAudit(raw,slide,[])[0].bold,true);
});

test('逐对象保留字体与斜体，字体别名/CSS家族可归一化，不能注入字体属性',()=>{
  assert.deepEqual(visualTextStyle({key:'font',size:30,bold:false,fontFamily:'"宋体", serif',italic:'true'},'body'),{size:30,bold:false,fontFace:'SimSun',italic:true});
  const raw=make();raw[0].fontFace='Arial';raw[1].fontFace='Microsoft YaHei';raw[1].italic=true;
  const result=validateAudit(raw,slide,[]);assert.equal(result[0].fontFace,'Arial');assert.equal(result[1].italic,true);
  for(const face of ['',12,'<svg>','Arial\nInjected'])assert.throws(()=>visualTextStyle({key:'font',fontFace:face},'body'),/fontFace/);
  assert.throws(()=>visualTextStyle({key:'font',italic:'maybe'},'body'),/italic/);
});

test('审计支持局部图生图抠图，仍禁止捕获文字或登记原图与大块页面',()=>{
  const cutout={key:'cutout',type:'cutout',x:1100,y:700,w:150,h:120,sourceBox:{x:1100,y:650,w:150,h:120},prompt:'保留独立装饰的轮廓纹理并移除背景',nonFactual:true};
  assert.equal(validateAudit([...make(),cutout],slide,[]).at(-1).type,'cutout');
  for(const change of [{nonFactual:false},{sourceBox:{x:0,y:0,w:1600,h:900}},{sourceBox:{x:50,y:100,w:100,h:80}}])assert.throws(()=>validateAudit([...make(),{...cutout,...change}],slide,[]));
});

test('新审计不直接裁图或文生图重画复杂画面，纠正为SVG/图生图抠图',async()=>{
  let calls=0;const prompts=[];
  const result=await auditedElements({slide,images:[],request:async prompt=>{prompts.push(prompt);calls++;return {text:JSON.stringify({elements:[...make(),...(calls===1?[{key:'old-method',type:'generate',x:1000,y:700,w:100,h:100,prompt:'生成全新装饰主体替换参考图中的主体',nonFactual:true}]:[{key:'native',type:'rect',x:1000,y:700,w:100,h:100,fill:'EEEEEE'}])]})};}});
  assert.equal(calls,2);assert.match(prompts[1],/简单色块与线条使用PPTX原生图形/);assert.match(prompts[1],/复杂形状或图标使用SVG重绘/);assert.equal(result.audit.at(-1).type,'rect');
});

test('按明确节点身份回填原文，唯一原文恢复ID，重复和互换映射仍拒绝',()=>{
  const raw={elements:make()};raw.elements[0].text='模型改写标题';delete raw.elements[1].nodeId;
  const fixed=restoreAuditTexts(raw,canonicalTexts(slide));assert.equal(fixed.changes.length,2);assert.equal(fixed.raw.elements[0].text,slide.title);assert.equal(fixed.raw.elements[1].nodeId,'body-0');assert.equal(raw.elements[0].text,'模型改写标题','不覆盖原始返回');validateAudit(fixed.raw.elements,slide,[]);
  const ambiguous={elements:make()};delete ambiguous.elements[2].nodeId;assert.throws(()=>validateAudit(restoreAuditTexts(ambiguous,canonicalTexts(slide)).raw.elements,slide,[]),/节点身份无效/);
  const swapped={elements:make()};swapped.elements[0].text=slide.body[0];assert.throws(()=>validateAudit(restoreAuditTexts(swapped,canonicalTexts(slide)).raw.elements,slide,[]),/文字与准确文案不一致/);
  assert.throws(()=>validateAudit([...make(),{...make()[0],key:'duplicate'}],slide,[]),/节点重复/);
});

test('拆解原文回填与样式兼容不增加模型调用，检查记录保留原返回',async()=>{
  const raw={elements:make()};raw.elements[1].text='模型摘要';raw.elements[0].bold='true';raw.elements[0].size='40';let calls=0;const records=[];
  const result=await auditedElements({slide,images:[],request:async()=>{calls++;return {text:JSON.stringify(raw)};},record:e=>records.push(e)});
  assert.equal(calls,1);assert.equal(result.audit[1].text,slide.body[0]);assert.equal(result.audit[0].size,40);assert.equal(result.auditValidation.attempts,0);assert.match(records[0].response,/模型摘要/);assert.equal(records[0].changes[0].action,'restore-canonical-text');
});

test('截断JSON和遗漏节点在同页内纠正，最多两次，纠正提示不叠加原设计',async()=>{
  const responses=['{"elements":[',JSON.stringify({elements:make().slice(1)}),JSON.stringify({elements:make()})],prompts=[],records=[],progress=[];
  const result=await auditedElements({slide,images:[],request:async prompt=>{prompts.push(prompt);return {text:responses.shift()};},record:e=>records.push(e),progress:e=>progress.push(e)});
  assert.equal(result.auditValidation.attempts,2);assert.equal(result.audit.length,4);assert.deepEqual(records.map(e=>e.status),['needs_revision','needs_revision','passed']);assert.equal(prompts[0],null);assert.match(prompts[2],/title/);assert.match(prompts[2],/参考随附完整预览定位/);assert.ok(!prompts[2].includes('本轮校验问题：模型没有返回'),'只使用上一次错误');assert.equal(progress.length,3);
});

test('持续错误保留全部记录，不伪造成功；传输失败和取消不无限重试',async()=>{
  let calls=0;const records=[];
  await assert.rejects(auditedElements({slide,images:[],request:async()=>{calls++;return {text:JSON.stringify({elements:make().slice(1)})};},record:e=>records.push(e)}),/自动纠正 2 次仍未通过/);assert.equal(calls,auditRepairLimit+1);assert.equal(records.length,3);
  calls=0;await assert.rejects(auditedElements({slide,images:[],request:async()=>{calls++;throw Error('API额度不足');}}),/API额度不足/);assert.equal(calls,1);
  const abort=new AbortController();abort.abort();calls=0;await assert.rejects(auditedElements({slide,images:[],signal:abort.signal,request:async()=>{calls++;}}),/任务已取消/);assert.equal(calls,0);
});

test('纠正不能替换登记原件或越界，并保持页顶导航检查',async()=>{
  const image={nodeId:'img',id:'registered',x:1100,y:300,w:300,h:200},bad=[...make(),{...image,type:'image',key:'img',id:'fake'}];let calls=0;
  await assert.rejects(auditedElements({slide,images:[image],request:async()=>{calls++;return {text:JSON.stringify({elements:bad})};}}),/登记原件/);assert.equal(calls,3);
  const raw=make();raw[0].w=1700;assert.throws(()=>validateAudit(raw,slide,[]),/画布/);
});
