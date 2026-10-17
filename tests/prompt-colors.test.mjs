import test from 'node:test';
import assert from 'node:assert/strict';
import {promptColor,simplifyPromptColors} from '../lib/prompt-colors.mjs';
import {designRulesFor} from '../lib/design-rules.mjs';
import {workflowDocument,workflowPageContext,workflowStyleContext} from '../lib/workflow-library.mjs';

test('配色提示转为大致色名，确认文案中的色号原样保留',()=>{
  assert.equal(promptColor('#14344D'),'深蓝色');
  assert.equal(promptColor('#A9CFD7'),'浅青色');
  const prompt='- **内容要求**：\n  - 正文：示例色号 #14344D。\n- **风格要求**：底色 #14344D，文字 #FFFFFF。';
  const result=simplifyPromptColors(prompt);
  assert.match(result,/正文：示例色号 #14344D/);
  assert.match(result,/底色 深蓝色/);assert.match(result,/页面可用颜色 近白色/);assert.doesNotMatch(result,/文字 近白色/);
  assert.equal(simplifyPromptColors(result),result);
});

test('可用配色合并同色异名，保留深浅区别、底色和正文原文',()=>{
  const source='- **内容要求**：\n  - 正文：蓝、蓝色、深蓝。\n- **风格要求**：底色深蓝色；页面可用颜色 蓝、白、深蓝色、深蓝、近黑、蓝色、青。';
  const next=simplifyPromptColors(source);
  assert.match(next,/正文：蓝、蓝色、深蓝。/);assert.match(next,/底色深蓝色/);
  assert.match(next,/页面可用颜色 蓝色、白色、深蓝色、近黑色、青色。/);
  assert.equal(simplifyPromptColors(next),next);
});

test('旧稿去除通用套话和文字配色分工，内容树文字、位置意见和具体占位比例完整保留',()=>{
  const source='- **比例要求**：16:9。\n- **内容要求**：\n  - 标题：深蓝标题示例\n    - 正文：深色阅读区必须用浅色文字，浅色阅读区用深色文字；按文字所在局部底色（含文本框填充）判断，强调色也须清晰可读。\n  - 图片占位比例：1.55:1。\n- **排版要求**：主标题上移，1.55:1。\n- **图片占位框比例**：1.55:1。\n- **风格要求**：无衬线，深蓝标题与正文；图注用 #334455。无框文字不强制加底。\n  - **简约要求**：承载干净，文字区安静。\n  - **紧密排版要求**：同组紧邻。\n- **进度条要求**：无进度条。\n- **可读性要求**：文字清晰、层级分明、对比充分，科学数字和单位完整。\n- **视觉关系要求**：组内并列。';
  const clean=simplifyPromptColors(source);
  assert.equal([...clean.matchAll(/^- \*\*/gm)].length,7);
  assert.ok(clean.includes(source.split('- **内容要求**：')[1].split('- **排版要求**：')[0]));
  assert.match(clean,/主标题上移/);assert.equal((clean.match(/1\.55:1/g)||[]).length,3);
  assert.doesNotMatch(clean,/\*\*(?:简约要求|紧密排版要求|可读性要求)\*\*/);
  const style=clean.split('- **风格要求**：')[1].split('- **进度条要求**：')[0];
  assert.match(style,/页面可用颜色/);assert.match(style,/无衬线/);assert.doesNotMatch(style,/深蓝标题|图注用|无框文字/);
  assert.equal(simplifyPromptColors(clean),clean);
});

test('深底浅字写入规范库，并进入运行时阶段规范',()=>{
  assert.match(workflowDocument('shared/content-density-and-text-color.md'),/深色阅读区必须使用白色或浅色文字/);
  const p={brief:{title:'演示',progress:false},slides:[{kind:'content',title:'内容'}],materials:[]};
  for(const stage of ['design','review','rebuild'])assert.match(designRulesFor(p,0,stage),/深色阅读区必须用浅色文字/);
});

test('阶段注入使用Agent简化口径，不注入历史九项或强制复述通用规范',()=>{
  const p={brief:{title:'演示',progress:false},slides:[{kind:'content',title:'内容'}],materials:[]};
  const context=workflowPageContext(p,0),styles=workflowStyleContext();
  assert.match(context,/## Agent 七项分点结构/);assert.match(styles,/## Agent 配色与风格/);
  assert.doesNotMatch(context,/必须用 Markdown 顶层列表组织以下九项|必须含“简约要求”和“紧密排版要求”|逐字包含“文本框底色/);
  assert.match(context,/底图是锁定背景层/);assert.match(context,/在内容、排版、配图三处强调各图具体宽高比/);
});
