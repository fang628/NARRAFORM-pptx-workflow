import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {imagePromptCheck,preservePromptText,preservePlaceholderRatios,validImagePrompt} from '../lib/image-prompt-check.mjs';
import {generatedImage} from '../lib/provider.mjs';
import {roughLayoutImageGuidance} from '../lib/layout-guidance.mjs';

test('整页发送前清理模板重复，局部调整稿与底图稿保持独立路径',async()=>{
  const prompt='- **内容要求**：\n  - 标题：导航示例\n  - 页顶导航（独立于正文结构）：\n    - 页顶导航：研究背景\n- **排版要求**：保持分组，1.5:1。\n- **图片占位框比例**：每张登记原图仅画一个等比、平坦无字占位块。\n  - “结果图”：右侧，宽高比必须为 1.5:1，平坦无字占位块。\n- **进度条要求**：页顶且仅一条粗分段进度条，逐段写“研究背景”。';
  const signal=new AbortController().signal;
  const cleaned=await imagePromptCheck({stage:'整页预览'},signal)(prompt);
  assert.doesNotMatch(cleaned.prompt,/页顶导航（独立于正文结构）/);
  assert.equal((cleaned.prompt.match(/平坦无字占位块/g)||[]).length,1);
  assert.equal((cleaned.prompt.match(/1\.5:1/g)||[]).length,2);
  for(const options of [{stage:'整页预览',mode:'adjust'},{stage:'三方向底图'}]){
    assert.equal((await imagePromptCheck(options,signal)(prompt)).prompt,prompt);
  }
});

test('清理旧创意套话及重复排版指令，保留相同正文、不同节点和跨分项比例',async()=>{
  const prompt='- **内容要求**：\n  - 标题：规划示例\n    - 正文：'+roughLayoutImageGuidance+'\n    - 正文：保留相同文案\n    - 正文：保留相同文案\n  - 图片比例：1.55:1。\n- **排版要求**：'+roughLayoutImageGuidance+'实际排版要有创意，保留合理的组合与局部构图发挥空间。两组结果左右对照，图片紧邻对应观点。两组结果左右对照，图片紧邻对应观点。\n  - 两组结果左右对照，图片紧邻对应观点。\n  - “组甲”：同组图文上下排列。\n  - “组乙”：同组图文上下排列。\n  - 占位框宽高比1.55:1。\n- **图片占位框比例**：1.55:1。\n- **风格要求**：采用医学期刊风格，页面可用蓝白灰。采用医学期刊风格，页面可用蓝白灰。';
  const options={stage:'整页预览'},signal=new AbortController().signal;
  const {prompt:next}=await imagePromptCheck(options,signal)(prompt);
  const content=next.split('- **内容要求**：')[1].split('- **排版要求**：')[0];
  assert.ok(content.includes(roughLayoutImageGuidance),'即使正文恰好与规则同文，也不能删除真实节点');
  assert.equal((content.match(/保留相同文案/g)||[]).length,2);
  const layout=next.split('- **排版要求**：')[1].split('- **图片占位框比例**：')[0];
  assert.doesNotMatch(layout,/实际排版要有创意|只给粗略创意方向/);
  assert.equal((layout.match(/两组结果左右对照，图片紧邻对应观点。/g)||[]).length,1);
  assert.match(layout,/“组甲”：同组图文上下排列/);assert.match(layout,/“组乙”：同组图文上下排列/);
  assert.equal((next.match(/1\.55:1/g)||[]).length,3);
  assert.equal((next.match(/采用医学期刊风格，页面可用蓝白灰。/g)||[]).length,1);
  assert.equal((await imagePromptCheck(options,signal)(next)).prompt,next,'重复处理不继续变化');
});

test('发送前只整理冲突规范，保持确认文案及不同节点的重复文字',()=>{
  assert.equal(validImagePrompt('  标题\n正文  '),'  标题\n正文  ');
  for(const value of ['',null,'x'.repeat(30001),'含\0控制字符'])assert.throws(()=>validImagePrompt(value));
  assert.doesNotThrow(()=>preservePromptText('目录：目录\n- 目录','目录\n- 目录',['目录']));
  assert.throws(()=>preservePromptText('- 相同文案\n- 相同文案','- 相同文案',['相同文案','相同文案']),/已停止发送/);
  assert.throws(()=>preservePromptText('标题：准确内容','标题：改写内容',['准确内容']),/已停止发送/);
  const ratio='1.55:1',original=ratio+'；'+ratio+'；'+ratio;
  assert.throws(()=>preservePlaceholderRatios(original,ratio,[{aspect:1.55}]),/重点占位框比例/);
  assert.throws(()=>preservePlaceholderRatios(original,original.replaceAll(ratio,'2:1'),[{aspect:1.55}]),/重点占位框比例/);
  assert.doesNotThrow(()=>preservePlaceholderRatios(original,original,[{aspect:1.55}]));
});

test('实际生图接口之前检查并复查整理稿，局部修改不附完整旧稿，失败保留原确认稿',async t=>{
  const previous=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';t.after(()=>{if(previous===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=previous;});
  const calls=[];let checkCount=0,mode='repair';
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());calls.push({url:req.url,body});res.setHeader('content-type','application/json');
    if(req.url.endsWith('/images/generations')){res.end(JSON.stringify({data:[{b64_json:bytes.toString('base64')}]}));return;}
    checkCount++;
    if(mode==='invalid'||mode==='repair_then_invalid'&&checkCount>1){res.end(JSON.stringify({choices:[{message:{content:'不是有效JSON'}}]}));return;}
    const result=mode==='corrupt'?{passed:false,issues:['重复规范'],correctedPrompt:'标题：错误改写内容。'}:mode==='repair_then_invalid'?{passed:false,issues:['重复规范'],correctedPrompt:'标题：准确内容。已整理布局。'}:mode==='twice'&&checkCount<3?{passed:false,issues:['布局冲突'],correctedPrompt:'标题：准确内容。第'+checkCount+'轮整理布局。'}:mode==='reject'?{passed:false,issues:['主体偏题'],correctedPrompt:null}:mode==='repair'&&checkCount===1?{passed:false,issues:['重复规范'],correctedPrompt:'标题：准确内容。主体靠右，保留其余画面。'}:{passed:true,issues:[],correctedPrompt:null};
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const config={baseURL:'http://127.0.0.1:'+server.address().port+'/v1',key:'synthetic-check-key',model:'mock'},signal=new AbortController().signal;
  let record;
  const check=()=>imagePromptCheck({config,system:'测试系统',stage:'底图自动修正',mode:'adjust',context:{subject:'材料核心对象'},protectedTexts:['准确内容']},signal);
  await generatedImage(config,'标题：准确内容。主体靠右；主体靠右。',signal,{checkPrompt:check(),onPromptChecked:r=>{record=r;}});
  assert.deepEqual(calls.map(c=>c.url),['/v1/chat/completions','/v1/chat/completions','/v1/images/generations']);
  assert.equal(calls.at(-1).body.prompt,'标题：准确内容。主体靠右，保留其余画面。');assert.equal(record.status,'repaired');
  assert.match(calls[0].body.messages.at(-1).content,/不补原提示词、完整设计或整页文案/);
  mode='passed';calls.length=0;const manual='  人工确认稿\n保留空格  ';
  await generatedImage(config,manual,signal,{checkPrompt:check()});assert.equal(calls.at(-1).body.prompt,manual);
  mode='reject';calls.length=0;await generatedImage(config,manual,signal,{checkPrompt:check(),onPromptChecked:r=>{record=r;}});assert.equal(record.status,'inconclusive');assert.equal(record.repairAttempts,2);assert.equal(calls.filter(c=>c.url.includes('/chat/')).length,3);assert.equal(calls.at(-1).body.prompt,manual);
  mode='twice';calls.length=0;checkCount=0;await generatedImage(config,'标题：准确内容。',signal,{checkPrompt:check(),onPromptChecked:r=>{record=r;}});assert.equal(record.status,'repaired');assert.equal(record.repairAttempts,2);assert.equal(calls.at(-1).body.prompt,'标题：准确内容。第2轮整理布局。');
  mode='corrupt';calls.length=0;checkCount=0;await generatedImage(config,'标题：准确内容。',signal,{checkPrompt:check(),onPromptChecked:r=>{record=r;}});assert.equal(record.status,'inconclusive');assert.equal(calls.at(-1).body.prompt,'标题：准确内容。');assert.ok(record.history.every(r=>r.discarded||r.round===3));
  mode='repair_then_invalid';calls.length=0;checkCount=0;await generatedImage(config,'标题：准确内容。',signal,{checkPrompt:check(),onPromptChecked:r=>{record=r;}});assert.equal(record.status,'inconclusive');assert.equal(calls.at(-1).body.prompt,'标题：准确内容。已整理布局。');
  mode='invalid';calls.length=0;
  await generatedImage(config,manual,signal,{checkPrompt:check(),onPromptChecked:r=>{record=r;}});assert.equal(record.status,'inconclusive');assert.equal(calls.at(-1).body.prompt,manual);
});
