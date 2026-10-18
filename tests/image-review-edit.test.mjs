import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {imageReviewIssues,imageReviewKey} from '../public/image-review-edit.js';
import {aiImageTarget,prepareAIImageEdit} from '../lib/ai-image-edit.mjs';

test('审查修改建议仅取当前画面的实际问题，排除历史、提示词检查和接口失败',()=>{
  const image={previewReview:{status:'needs_revision',issues:['正文太小','正文太小','标题与图片重叠'],warnings:['图注对比偏弱']},promptCheck:{issues:['原提示词过长']},repairHistory:[{previewReview:{issues:['历史问题']}}]};
  assert.deepEqual(imageReviewIssues(image),['正文太小','标题与图片重叠','图注对比偏弱']);
  assert.equal(imageReviewKey(image),JSON.stringify(imageReviewIssues(image)));
  for(const status of ['pending','failed','cancelled','not_required'])assert.deepEqual(imageReviewIssues({...image,previewReview:{...image.previewReview,status}}),[]);
  assert.deepEqual(imageReviewIssues({previewReview:{status:'inconclusive',issues:['标题被遮挡','整页检查暂未完成，图片已保留。模型没有返回完整有效的 JSON','getaddrinfo ENOTFOUND example.com','请求已取消或超过 180 秒']}}),['标题被遮挡']);
  assert.deepEqual(imageReviewIssues({review:{issues:['配图过大'],warnings:[]}}),['配图过大']);
  assert.deepEqual(imageReviewIssues({previewReview:{status:'passed',issues:[],warnings:[]},review:{issues:['旧问题']}}),[]);
  assert.deepEqual(imageReviewIssues({previewReview:{issues:'损坏的格式',warnings:{}}}),[]);
});

test('从实际审查生成可编辑的图生图指令，不发送原设计、不调用生图、拒绝过期建议',async t=>{
  const old=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';
  t.after(()=>{if(old===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=old;});
  const requests=[];let change=null;
  const mock=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    requests.push({endpoint:req.url,...JSON.parse(text)});change?.();
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({instruction:'放大正文并增加段间距；保留标题和底图。'})}}]}));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close();});
  const cfg={baseURL:'http://127.0.0.1:'+mock.address().port+'/v1',model:'test',key:'synthetic'};
  const env={credentials:new Map([['p',{text:cfg}]]),system:'只返回 JSON'};
  const image={previewHash:'hash',file:'preview.png',prompt:'不得发给模型的完整旧设计',previewReview:{status:'needs_revision',issues:['正文太小','行距过紧']}},p={id:'p',selectedTheme:'a',visualPages:[image]};
  const target={targetType:'visual',kind:'full',index:0},b={...target,imageEditMode:'adjust',sourceHash:'hash',fromReview:true,reviewKey:imageReviewKey(image)};
  const prepare=extra=>prepareAIImageEdit(p,{...b,...extra},env,new AbortController().signal);
  const result=await prepare({issues:['客户端伪造的问题']});
  assert.equal(result.key,aiImageTarget(p,target).key);assert.equal(result.draft.instruction,'放大正文并增加段间距；保留标题和底图。');
  assert.equal(result.draft.previousText,'');assert.equal(result.draft.fromReview,true);assert.equal(result.draft.reviewKey,b.reviewKey);
  assert.equal(requests.length,1);assert.equal(requests[0].endpoint,'/v1/chat/completions');
  const prompt=requests[0].messages.at(-1).content;
  assert.match(prompt,/正文太小/);assert.match(prompt,/行距过紧/);assert.doesNotMatch(prompt,/不得发给模型的完整旧设计|客户端伪造/);
  await prepare({instruction:'标题不要动'});assert.match(requests[1].messages.at(-1).content,/用户修改意见：标题不要动/);
  const count=requests.length;
  await assert.rejects(prepare({sourceHash:'stale'}),/图片已变化/);
  await assert.rejects(prepare({reviewKey:'stale'}),/审查结果已变化/);
  await assert.rejects(prepare({imageEditMode:'redraw'}),/仅用于图生图/);
  image.previewReview={status:'pending',issues:[]};await assert.rejects(prepare({}),/没有可用于修改/);assert.equal(requests.length,count);
  image.previewReview={status:'needs_revision',issues:['正文太小','行距过紧']};
  const saved=p.aiImageEditDrafts[result.key];
  change=()=>{image.previewHash='new-hash';};await assert.rejects(prepare({}),/图片已变化/);assert.equal(p.aiImageEditDrafts[result.key],saved);
  image.previewHash='hash';change=()=>{image.previewReview.issues=['图片遮挡标题'];};await assert.rejects(prepare({}),/审查结果已变化/);assert.equal(p.aiImageEditDrafts[result.key],saved);
  assert.ok(requests.every(r=>r.endpoint==='/v1/chat/completions'));
});
