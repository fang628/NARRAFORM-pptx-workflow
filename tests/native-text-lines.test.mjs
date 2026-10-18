import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeTextLines} from '../lib/native-text-lines.mjs';
import {nativeSVG} from '../lib/visual-model.mjs';

test('场景文字按文本框宽度换行，保留原文和显式换行，避免与PowerPoint自动换行矛盾',()=>{
  const text='一二三四五六七八九';assert.deepEqual(nativeTextLines(text,60,20),['一二三','四五六','七八九']);
  assert.deepEqual(nativeTextLines('A\n\nB\n',100,20),['A','','B','']);assert.equal(nativeTextLines('  data 42',40,20).join(''),'  data 42');
  const svg=nativeSVG([{type:'text',key:'body',x:10,y:20,w:60,h:80,text,size:20,color:'272727'}],()=>{});
  assert.equal((svg.match(/<tspan\b/g)||[]).length,3);assert(svg.includes('一二三</tspan>'));assert(!svg.includes(text+'</tspan>'));
});
