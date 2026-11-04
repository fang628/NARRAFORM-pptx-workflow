import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {mathjax} from 'mathjax-full/js/mathjax.js';
import {TeX} from 'mathjax-full/js/input/tex.js';
import {SVG} from 'mathjax-full/js/output/svg.js';
import {liteAdaptor} from 'mathjax-full/js/adaptors/liteAdaptor.js';
import {RegisterHTMLHandler} from 'mathjax-full/js/handlers/html.js';
import {AllPackages} from 'mathjax-full/js/input/tex/AllPackages.js';
import {formulaLatex} from './formula-content.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const adaptor=liteAdaptor();RegisterHTMLHandler(adaptor);
const doc=mathjax.document('',{InputJax:new TeX({packages:AllPackages.filter(p=>!['html','require','autoload','newcommand','configmacros'].includes(p)),maxBuffer:8000,maxMacros:1000}),OutputJax:new SVG({fontCache:'none'})});
const cache=new Map();
export function formulaVector(value){
  const latex=formulaLatex(value);if(cache.has(latex))return cache.get(latex);
  const node=doc.convert(latex,{display:true}),svg=adaptor.outerHTML(adaptor.firstChild(node));
  if(/data-mjx-error|merror/.test(svg))throw Error('公式语法无法解析，请检查LaTeX');
  const view=svg.match(/viewBox="([^"]+)"/);if(!view)throw Error('公式没有有效的数学结构');
  const result={svg,viewBox:view[1],ratio:Number(view[1].split(' ')[2])/Number(view[1].split(' ')[3])};
  if(cache.size>=128)cache.delete(cache.keys().next().value);cache.set(latex,result);return result;
}
export function formulaSVG(e){
  const v=formulaVector(e.latex),height=Math.min(e.h,e.size*1.65),width=Math.min(e.w,height*v.ratio),actualHeight=width/v.ratio,x=e.x+(e.align==='center'?(e.w-width)/2:e.align==='right'?e.w-width:0);
  return v.svg.replace(/<svg\b[^>]*>/,`<svg xmlns="http://www.w3.org/2000/svg" x="${x}" y="${e.y+(e.h-actualHeight)/2}" width="${width}" height="${actualHeight}" viewBox="${v.viewBox}" color="#${e.color||'272727'}" fill="#${e.color||'272727'}">`);
}
export async function formulaOMML(latex){
  if(!latex.length)return [];
  const values=latex.map(formulaLatex),venv=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  return new Promise((resolve,reject)=>{
    const child=spawn(process.env.PPT_AGENT_PYTHON||(fs.existsSync(venv)?venv:'python'),[path.join(root,'tools','formula_omml.py')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='',err='',ended=false;const timer=setTimeout(()=>{child.kill();finish(Error('公式转换超时'));},30000);
    function finish(error,value){if(ended)return;ended=true;clearTimeout(timer);error?reject(error):resolve(value);}
    child.on('error',finish);child.stdin.on('error',()=>{});child.stdout.on('data',d=>{out+=d;if(out.length>10_000_000){child.kill();finish(Error('公式转换输出过大'));}});child.stderr.on('data',d=>err=(err+d).slice(-2000));
    child.on('close',code=>{if(code)return finish(Error('原生公式转换失败：'+err));try{const result=JSON.parse(out);if(result.length!==values.length)throw Error('公式转换结果不完整');finish(null,result);}catch(error){finish(error);}});child.stdin.end(JSON.stringify(values));
  });
}
const xml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export async function patchNativeFormulas(zip,pages){
  const formulas=pages.flatMap((elements,index)=>elements.filter(e=>e.type==='formula').map(e=>({e,index}))),converted=await formulaOMML(formulas.map(({e})=>e.latex));
  for(const [j,{e,index}]of formulas.entries()){
    const name=`ppt/slides/slide${index+1}.xml`;let source=await zip.file(name).async('string'),found=false;
    source=source.replace(/<p:sp\b[\s\S]*?<\/p:sp>/g,shape=>{
      if(!shape.includes('name="'+xml(e.key)+'"'))return shape;
      found=true;
      const size=Math.round(e.size*.6*100),color=e.color||'272727';
      // a14:m lives inside the DrawingML paragraph, not an OLE object or image.
      const math=converted[j].replace(/<m:r>/g,`<m:r><w:rPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/><w:sz w:val="${Math.round(e.size*.6*2)}"/><w:color w:val="${color}"/></w:rPr>`);
      const paragraph=`<a:p><a:pPr algn="${e.align==='center'?'ctr':e.align==='right'?'r':'l'}"><a:defRPr sz="${size}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Cambria Math"/></a:defRPr></a:pPr><a14:m xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:oMathParaPr><m:jc m:val="${e.align==='center'?'center':e.align==='right'?'right':'left'}"/></m:oMathParaPr>${math}</m:oMathPara></a14:m><a:endParaRPr lang="zh-CN" sz="${size}"/></a:p>`;
      return shape.replace(/<a:p>[\s\S]*?<\/a:p>/,paragraph);
    });
    if(!found)throw Error('未找到原生公式框：'+e.key);zip.file(name,source);
  }
}
