import test from 'node:test';
import assert from 'node:assert/strict';
import {Resvg} from '@resvg/resvg-js';
import {containedImageBounds} from '../lib/image-geometry.mjs';

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
