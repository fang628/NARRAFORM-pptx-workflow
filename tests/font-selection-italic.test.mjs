import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveNativeFonts} from '../lib/native-fonts.mjs';
import {visualTextStyle} from '../lib/visual-text-style.mjs';
import {nativeSVG} from '../lib/visual-model.mjs';

test('自动选字按语言与字形类别匹配，不依赖字体枚举顺序',()=>{
  const fonts=['STXingkai','Consolas','Times New Roman','Arial','SimSun','Microsoft YaHei','Aptos'];
  const examples=[['中文正文','sans','Microsoft YaHei'],['中文结论','serif','SimSun'],['Scientific results','serif','Times New Roman'],['Overview','sans','Aptos'],['x = 12','monospace','Consolas']];
  for(const [text,fontCategory,expected] of examples){
    const elements=[{type:'text',fontFace:'auto',fontCategory,text}];
    for(const available of [fonts,[...fonts].reverse()])assert.equal(resolveNativeFonts(elements,available).elements[0].fontFace,expected);
  }
  assert.equal(resolveNativeFonts([{type:'text',text:'中文',fontCategory:'serif'}],['Times New Roman','Microsoft YaHei']).elements[0].fontFace,'Microsoft YaHei');
});

test('优先保留预览已辨认的可用字体，缺失字体保留替换依据和斜体',()=>{
  const original={type:'text',fontFace:'Arial',text:'Overview',italic:true};
  assert.equal(resolveNativeFonts([original],['Arial','Aptos']).elements[0],original);
  const result=resolveNativeFonts([{type:'text',text:'正文',fontFace:'Missing Serif',italic:true}],['STXingkai','Microsoft YaHei','SimSun']);
  assert.equal(result.elements[0].fontFace,'SimSun');assert.equal(result.elements[0].italic,true);
  assert.equal(result.elements[0].requestedFontFace,'Missing Serif');assert.equal(result.changes.length,1);
});

test('斜体别名、CSS样式和字体名样式后缀归一为独立原生属性',()=>{
  for(const italic of [true,1,'true','1','italic','oblique','oblique 12deg','斜体'])assert.equal(visualTextStyle({italic},'body').italic,true);
  for(const italic of [false,0,'normal','false','正体'])assert.equal(visualTextStyle({italic},'body').italic,false);
  assert.equal(visualTextStyle({fontStyle:'italic'},'body').italic,true);
  const style=visualTextStyle({fontFamily:'"Times New Roman Bold Italic", serif'},'body');
  assert.equal(style.fontFace,'Times New Roman');assert.equal(style.bold,true);assert.equal(style.italic,true);
  const explicit=visualTextStyle({fontFace:'Arial Bold Italic',bold:false,italic:false},'body');
  assert.equal(explicit.fontFace,'Arial');assert.equal(explicit.bold,false);assert.equal(explicit.italic,false);
  assert.equal(visualTextStyle({fontFace:'华文行楷'},'title').italic,undefined);
  assert.throws(()=>visualTextStyle({italic:'maybe'},'body'),/原生文字样式无效/);
  const svg=nativeSVG([{key:'t',type:'text',text:'Scientific result',x:30,y:30,w:400,h:80,color:'222222',...style}],()=> '');
  assert.match(svg,/font-style="italic"/);assert.match(svg,/font-family="Times New Roman"/);
});
