import test from 'node:test';
import assert from 'node:assert/strict';
import {materialImageCatalog} from '../lib/content-images.mjs';
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
