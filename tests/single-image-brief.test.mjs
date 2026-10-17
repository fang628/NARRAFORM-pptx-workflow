import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {prepareAIImageEdit} from '../lib/ai-image-edit.mjs';
import {validateSingleThemePrompt} from '../lib/theme-image-prompts.mjs';
import {imagePromptCheck} from '../lib/image-prompt-check.mjs';

const batch='封面底图提示词：主体靠右，左侧标题留白。\n目录底图提示词：主体右下，左侧条目留白。\n内容页背景提示词：主题轮廓在边角，中央留白。';
const inlineBatch='用途：“演示主题”无字底图三张，均16:9。风格：深蓝。封面底图：主体充满左半区，右侧留标题区。目录底图：主体右下，左上留列表区。内容页底图：同一主体的低对比轮廓置于左下，中央留白。三张底图均无字。';
test('只识别独立绘图任务头，不误删普通说明；多页提示词给出定向修正要求',()=>{
  assert.throws(()=>validateSingleThemePrompt(batch),e=>e.repairInstruction.includes('仅保留当前用途'));
  assert.throws(()=>validateSingleThemePrompt(inlineBatch),/多个独立页面/);
  assert.throws(()=>validateSingleThemePrompt(inlineBatch.replace('底图三张','底图').replace('三张底图均无字','无字')),/多个独立页面/,'未声明三张时也识别同段中的不同页型任务');
  assert.throws(()=>validateSingleThemePrompt('用途：封面底图。\n用途：目录底图。'));
  assert.equal(validateSingleThemePrompt('内容页背景：右下主体，封面和目录沿用本风格。'),'内容页背景：右下主体，封面和目录沿用本风格。');
});

test('底图重绘AI助手只接收当前用途；若返回三页稿先主动修正为单页稿',async t=>{
  const old=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';const requests=[];let mode='edit';
  const server=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));requests.push(body);
    const raw=mode==='edit'?{prompt:requests.length===1?batch:'内容页背景：浅蓝底，右下主体轮廓，中央图文区留白，无字，16:9。'}:
      requests.length===1?{passed:false,issues:['布局冲突'],correctedPrompt:inlineBatch}:{passed:true,issues:[],correctedPrompt:null};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(raw)}}]}));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();if(old===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=old;});
  const config={baseURL:'http://127.0.0.1:'+server.address().port+'/v1',key:'synthetic',model:'mock'},signal=new AbortController().signal;
  const p={id:'p',slides:[],materials:[],themeAssets:{directions:[{id:'a',assets:{'content-background':{normalized:'fixture.png',previewHash:'hash',prompt:'当前单张内容背景提示词',materialId:'fixture'}}}]}};
  const result=await prepareAIImageEdit(p,{targetType:'theme',theme:'a',use:'content-background',sourceHash:'hash',imageEditMode:'redraw',instruction:'淡一点'}, {credentials:new Map([['p',{text:config}]]),system:'JSON'},signal);
  assert.equal(requests.length,2);assert.match(requests[0].messages.at(-1).content,/当前用途：内容页背景/);
  assert.doesNotMatch(requests[0].messages.at(-1).content,/封面和目录保留|内容背景保留/);
  assert.match(requests[1].messages[0].content,/仅保留当前用途/);assert.doesNotMatch(result.draft.prompt,/目录|封面/);
  mode='check';requests.length=0;
  const original='用途：当前内容页背景，浅蓝底，右下主体轮廓，中央留白，无字。';
  const checked=await imagePromptCheck({config,system:'JSON',stage:'三方向底图',context:{use:'content-background'}},signal)(original);
  assert.equal(checked.prompt,original);assert.equal(checked.history[0].discarded,true,'检查模型不能把单页稿改成三页稿');
  assert.equal(requests.length,2);
  assert.match(requests[0].messages.at(-1).content,/用途：内容页背景/);
  assert.doesNotMatch(requests[0].messages.at(-1).content,/用途：三方向底图/);
  assert.match(requests[1].messages.at(-1).content,/多个独立页面任务/);
});
