import test from 'node:test';
import assert from 'node:assert/strict';
import {materialImageCatalog,validateGeneratedImageReuse} from '../lib/content-images.mjs';
import {contentWithEvidence} from '../lib/content-evidence.mjs';
import {validateSlides} from '../lib/scene.mjs';
import {validateSourceReferences} from '../lib/source-references.mjs';

test('配图候选包含原图、提取图、裁片和补充图，携带已理解用途与来源，排除重建素材和底图',()=>{
  const materials=[{id:'doc',name:'研究报告.pdf',kind:'document'},
    {id:'original',name:'实验现场.png',kind:'image'},
    {id:'embedded',name:'结果图.png',kind:'image',extracted:true,sourceMaterialId:'doc',sourceMaterialName:'研究报告.pdf',sourceLocations:[{page:2}],width:800,height:600},
    {id:'crop',name:'结果局部.png',kind:'image',extracted:true,sourceMaterialId:'original'},
    {id:'generated',name:'补充流程.png',kind:'image',generated:true,supplementImage:{caption:'样本处理流程',sourceMaterialIds:['doc']}},
    {id:'rebuild',kind:'image',reconstructed:true},{id:'rebuild2',kind:'image',purpose:'reconstruction'},{id:'background',kind:'image',purpose:'workflow-background'}];
  const p={materials,analysis:{readings:[{id:'doc',status:'read',summary:'比较实验结果'},
    {id:'original',status:'read',summary:'实验设备与操作',suggestedUse:'说明实验条件'},
    {id:'crop',status:'skipped',summary:'图片未发送给模型'}]}};
  const catalog=materialImageCatalog(p);
  assert.deepEqual(catalog.map(m=>m.materialId),['original','embedded','crop','generated']);
  assert.equal(catalog[0].imageSummary,'实验设备与操作');assert.equal(catalog[0].suggestedUse,'说明实验条件');
  assert.equal(catalog[1].sourceDocumentSummary,'比较实验结果');assert.deepEqual(catalog[1].sourceLocations,[{page:2}]);
  assert.equal(catalog[2].imageContentUnreviewed,true);assert.equal(catalog[2].imageSummary,undefined);
  assert.equal(catalog[3].description,'样本处理流程');assert.equal(catalog[3].imageContentUnreviewed,undefined);
});

test('同页多张相关图片实际插入所属小标题，全部图片自动建立来源索引而不受单图兼容字段限制',()=>{
  const p={materials:[{id:'a',name:'实验图.png',kind:'image'},{id:'b',name:'结果图.png',kind:'image',extracted:true,sourceMaterialName:'报告.pdf',sourceLocations:[{page:2}]}]};
  const slides=validateSlides([{kind:'content',sources:[],elements:[{id:'title',type:'text',role:'title',text:'实验与结果'},
    {id:'experiment',type:'group',label:'实验方法',parentId:'title'},
    {id:'photo',type:'image',materialId:'a',label:'实验图',parentId:'experiment'},
    {id:'results',type:'group',label:'结果',parentId:'title'},
    {id:'chart',type:'image',materialId:'b',label:'结果图',parentId:'results'}]}]);
  validateSourceReferences(p,slides,true);
  assert.equal(slides[0].imageId,'a');assert.equal(slides[0].elements.filter(n=>n.type==='image').length,2);
  assert.deepEqual(slides[0].sourceLinks.map(l=>[l.target,l.materialId]),[['element:photo','a'],['element:chart','b']]);
  assert.deepEqual(new Set(slides[0].sources),new Set(['a','b']));
});

test('重复文件归为同图，目录携带跨页使用信息；裁片与底图不误判为同一配图',()=>{
  const materials=[{id:'a',kind:'image',sha256:'same'},{id:'alias',kind:'image',sha256:'same'},
    {id:'crop',kind:'image',sha256:'different',sourceMaterialId:'a'},{id:'bg',kind:'image',sha256:'same',purpose:'workflow-background'}];
  const slide=id=>({title:'配图示例',body:[],sources:[],imageId:id});
  const catalog=materialImageCatalog({materials,slides:[slide('a'),slide('alias'),slide('crop')]});
  assert.equal(catalog.length,3);assert.equal(catalog[1].duplicateOf,'a');assert.deepEqual(catalog[0].usedOnPages,[1,2]);assert.deepEqual(catalog[1].usedOnPages,[1,2]);assert.deepEqual(catalog[2].usedOnPages,[3]);assert.equal(catalog[2].duplicateOf,undefined);
  const duplicated={title:'配图示例',elements:[{id:'title',type:'text',role:'title',text:'配图示例'},
    {id:'one',type:'image',materialId:'a',label:'图一',parentId:'title'},{id:'two',type:'image',materialId:'alias',label:'图二',parentId:'title'}]};
  assert.throws(()=>validateGeneratedImageReuse([duplicated],materials),error=>/配图重复/.test(error.message)&&/同一图片只保留一个/.test(error.repairInstruction));
  duplicated.elements[2].materialId='crop';assert.doesNotThrow(()=>validateGeneratedImageReuse([duplicated],materials));
  assert.doesNotThrow(()=>validateGeneratedImageReuse([slide('a'),slide('a')],materials),'跨页必要复用仅作规划约束，不新增硬拦截');
});

test('AI初稿同页重复配图在内容生成结束前自动修正，保留其他正确文本',async()=>{
  const http=await import('node:http'),materials=[{id:'a',kind:'image'},{id:'b',kind:'image'}];let calls=0;
  const mock=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const request=JSON.parse(Buffer.concat(chunks));calls++;
    if(calls===2)assert.match(request.messages[0].content,/同一图片只保留一个/);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({slides:[{title:'准确标题',elements:[{id:'title',type:'text',role:'title',text:'准确标题'},
      {id:'one',type:'image',materialId:'a',parentId:'title'},{id:'two',type:'image',materialId:calls===1?'a':'b',parentId:'title'}]}]})}}]}));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));const old=process.env.PPT_AGENT_TEST;process.env.PPT_AGENT_TEST='1';
  try{
    const result=await contentWithEvidence({config:{key:'synthetic-only',model:'fixture',baseURL:'http://127.0.0.1:'+mock.address().port+'/v1'},system:'只返回JSON',user:'生成内容',project:{materials},decode:raw=>raw.slides,
      validate:slides=>{validateGeneratedImageReuse(slides,materials);return slides;}});
    assert.equal(calls,2);assert.equal(result.slides[0].title,'准确标题');assert.deepEqual(result.slides[0].elements.filter(n=>n.type==='image').map(n=>n.materialId),['a','b']);
  }finally{if(old===undefined)delete process.env.PPT_AGENT_TEST;else process.env.PPT_AGENT_TEST=old;mock.closeAllConnections();await new Promise(r=>mock.close(r));}
});
