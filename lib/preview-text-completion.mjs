import {plainInlineText} from '../public/inline-text.js';

export const previewTextCompletionRule='complete_preview_text仅在三个条件同时满足时补全文字：第一张批准预览中清晰可见该整段文字；05尚未登记对应的文字元素，且整页任何位置均没有这段文字（包括拆成多个文字对象的情况）；其原本位置及周围在实际PPTX重建页中没有文字。内容树中已有但漏还原的文字也走此入口，提供nodeId并复用准确原文，不按预览错字改写；内容树也没有时才逐字登记清晰预览原文。先登记完整文字sourceBox，不能缩小框选避开周围文字。位置及四周至少12逻辑单位或半行高范围内有文字时拒绝补全。不推断模糊字、不扩写、不补造说明，不提取登记原图或固定底图内已有文字。表格成员不通过此工具单独添加，只补文字，不自动补框。';
const normalized=text=>plainInlineText(text).replace(/\s/g,'');
const overlap=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
function bounds(value){
  if(!value||!['x','y','w','h'].every(k=>Number.isFinite(value[k]))||value.x<0||value.y<0||value.w<=0||value.h<=0||value.x+value.w>1600.1||value.y+value.h>900.1)throw Error('补全文字须给出1600×900画布内的完整文字区域');
  return Object.fromEntries(['x','y','w','h'].map(k=>[k,value[k]]));
}
export function registeredPreviewTexts(p,index){
  const hash=p?.visualPages?.[index]?.previewHash;
  if(!hash)return [];
  return (p?.reconstruction?.slides?.[index]?.previewTexts||[]).filter(n=>n.previewHash===hash);
}
export function preparePreviewText(args,{elements,texts,previewHash,registrations=[],measurements=[]}){
  if(!previewHash)throw Error('补全文字需要有效的批准预览版本');
  if(typeof args.key!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(args.key)||elements.some(e=>e.key===args.key))throw Error('补全文字须使用尚未占用的有效key');
  if(typeof args.text!=='string'||!args.text.trim()||args.text.length>2500)throw Error('补全文字须为预览中清晰可读的非空原文');
  const sourceBox=bounds(args.sourceBox),placement=bounds(args);
  if(overlap(sourceBox,placement)<.6*Math.min(sourceBox.w*sourceBox.h,placement.w*placement.h))throw Error('补全文字须放回预览原位置，不能转移到其他空白区域');
  const value=normalized(args.text);
  if(!value)throw Error('补全文字须包含可见字符');
  const pageText=elements.filter(e=>e.type==='text'||e.type==='formula'||e.artisticText===true).map(e=>normalized(e.text||e.latex||'')).join('');
  if(pageText.includes(value))throw Error('整页已有这段文字，不能在其他空白位置重复补全');
  const candidates=texts.filter(n=>n.role!=='navigation'&&n.role!=='formula'&&normalized(n.text)===value);
  const missing=candidates.filter(n=>!elements.some(e=>e.nodeId===n.nodeId));
  if(args.nodeId&&!missing.some(n=>n.nodeId===args.nodeId))throw Error('指定文字节点已还原或与准确原文不一致');
  if(!args.nodeId&&missing.length>1)throw Error('存在多个相同的遗漏节点，请指定nodeId');
  const owner=args.nodeId?missing.find(n=>n.nodeId===args.nodeId):missing[0];
  if(!owner&&texts.some(n=>normalized(n.text).includes(value)))throw Error('该段文字已经登记，不能通过补全文字重复添加');
  if(owner?.role?.startsWith('table-'))throw Error('表格文字只能随整张表处理，不能单独补全成员');
  const margin=Math.max(12,Math.min(sourceBox.h,args.size||28)*.5);
  const neighborhood=b=>({x:b.x-margin,y:b.y-margin,w:b.w+2*margin,h:b.h+2*margin});
  const hasText=e=>['text','formula'].includes(e.type)||e.artisticText===true;
  if(elements.some(e=>hasText(e)&&(overlap(e,neighborhood(sourceBox))>0||overlap(e,neighborhood(placement))>0)))throw Error('文字原位置或周围已有文字，不满足补全条件');
  if(measurements.some(m=>elements.some(e=>e.key===m.key&&hasText(e))&&[m.boundLeft,m.boundTop,m.boundWidth,m.boundHeight].every(Number.isFinite)
    &&overlap({x:m.boundLeft,y:m.boundTop,w:m.boundWidth,h:m.boundHeight},neighborhood(sourceBox))>0))throw Error('实际PPTX字形边界在原位置周围已有文字，不满足补全条件');
  if(elements.some(e=>e.type==='image'&&!e.implementation&&overlap(e,sourceBox)>.5*sourceBox.w*sourceBox.h))throw Error('登记原图内的文字无需重复重建');
  if(registrations.some(n=>overlap(n.sourceBox,sourceBox)>.55*Math.min(n.sourceBox.w*n.sourceBox.h,sourceBox.w*sourceBox.h)))throw Error('此预览区域已经登记文字，不能重复补全');
  const role=owner?.role||(['body','heading','subtitle','caption','imageTitle'].includes(args.role)?args.role:'body');
  const nodeId=owner?.nodeId||'preview-text-'+args.key,text=owner?.text||args.text;
  const registration=owner?null:{nodeId,text,role,parentId:null,sourceBox,previewHash,previewText:true};
  const element={key:args.key,type:'text',nodeId,text,role,...placement,size:args.size||28,fontFace:args.fontFace||'Microsoft YaHei',color:args.color||'272727',bold:args.bold===true,italic:args.italic===true,align:args.align||'left'};
  return {element,registration};
}
