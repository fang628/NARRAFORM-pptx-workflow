import test from 'node:test';
import assert from 'node:assert/strict';
import {Resvg} from '@resvg/resvg-js';
import {containedImageBounds,fittedImagePlans,imageMayStretch,repositionedImagePlans} from '../lib/image-geometry.mjs';
import {nativeSVG,validateAudit} from '../lib/visual-model.mjs';

test('PPT原图与独立SVG在预留区等比居中，宽图和竖图不拉伸、不裁切',()=>{
  const bytes=(w,h)=>new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}"/></svg>`).render().asPng();
  const box={x:10,y:20,w:400,h:200,objectName:'original'};
  assert.deepEqual(containedImageBounds(bytes(600,400),box),{x:60,y:20,w:300,h:200,objectName:'original'});
  assert.deepEqual(containedImageBounds(bytes(100,200),box),{x:160,y:20,w:100,h:200,objectName:'original'});
  assert.deepEqual(containedImageBounds(bytes(800,200),box),{x:10,y:70,w:400,h:100,objectName:'original'});
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="50" height="100" viewBox="0 0 50 100"><rect width="50" height="100"/></svg>');assert.equal(containedImageBounds(svg,box).w,100);
  assert.deepEqual(box,{x:10,y:20,w:400,h:200,objectName:'original'});
  assert.throws(()=>containedImageBounds(bytes(50,50),{...box,w:0}),/有效尺寸/);
});

test('5%以内允许小幅改变显示比例，边界外回退等比，原件字节不变',()=>{
  const original=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300"/></svg>').render().asPng(),copy=Buffer.from(original);
  for(const aspect of [1.9,1.95,2,2.05,2.1]){
    const box={x:50,y:60,w:aspect*200,h:200},[plan]=fittedImagePlans([{...box,aspect:2}]);
    assert.equal(plan.imageFit,'fill');assert.equal(imageMayStretch(plan),true);assert.equal(plan.w,box.w);assert.equal(plan.h,box.h);
    assert.deepEqual(containedImageBounds(original,box,{allowSmallDistortion:true}),box);
  }
  for(const aspect of [1.89,2.11,3]){
    const box={x:50,y:60,w:aspect*200,h:200},[plan]=fittedImagePlans([{...box,aspect:2}]);
    assert.equal(plan.imageFit,'contain');assert.equal(plan.w/plan.h,2);assert.equal(imageMayStretch(plan),false);
    const actual=containedImageBounds(original,box,{allowSmallDistortion:true});assert.equal(actual.w/actual.h,2);
  }
  assert.deepEqual(original,copy);
});

test('重建只接受本地确认的微调参数，模型不能开启额外拉伸，原生SVG遵循同一规则',()=>{
  const slide={title:'标题',body:[],sources:[],elements:[{id:'title',type:'text',role:'title',text:'标题',parentId:null},{id:'photo',type:'image',materialId:'source',parentId:'title'}]},title={key:'title',type:'text',nodeId:'title',text:'标题',x:50,y:50,w:500,h:80,size:40,color:'222222'},plan={nodeId:'photo',id:'source',x:800,y:200,w:400,h:208,aspect:2,imageFit:'fill'};
  const [_,photo]=validateAudit([title,{...plan,type:'image',key:'photo',imageFit:'contain',aspect:100}],slide,[plan]);
  assert.equal(photo.imageFit,'fill');assert.equal(photo.aspect,2);
  assert.match(nativeSVG([photo],()=>'/image.png'),/preserveAspectRatio="none"/);
  const legacy=validateAudit([title,{...plan,type:'image',key:'photo',imageFit:'fill'}],slide,[{...plan,imageFit:undefined}])[1];assert.equal(legacy.imageFit,undefined);assert.match(nativeSVG([legacy],()=>'/image.png'),/xMidYMid meet/);
  assert.equal(imageMayStretch({...photo,w:600}),false);
});

test('贴回后的自动移动缩放限制在真实占位区，重复修改保留框边界',()=>{
  const box={x:900,y:300,w:600,h:400},old={nodeId:'a',id:'photo',aspect:2,x:900,y:350,w:600,h:300,placeholderBox:box};
  let [next]=repositionedImagePlans([old],[{nodeId:'a',id:'photo',x:748,y:258,w:1000,h:500,crop:true}]);
  assert.deepEqual(next.placeholderBox,box);assert.equal(next.id,'photo');assert.equal(next.crop,undefined);
  assert.equal(next.x,900);assert.equal(next.y,300);assert.equal(next.w,600);assert.equal(next.h,300);
  [next]=repositionedImagePlans([next],[{nodeId:'a',x:1490,y:690,w:300,h:150}]);
  assert.equal(next.x,1200);assert.equal(next.y,550);assert.equal(next.w,300);assert.equal(next.h,150);assert.deepEqual(next.placeholderBox,box);
  assert.deepEqual(old.placeholderBox,box);assert.equal(old.x,900);
});
