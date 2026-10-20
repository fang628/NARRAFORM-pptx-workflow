import {curvedArrowRule} from './curved-arrows.mjs';
import {directionalGeometryRule} from './directional-geometry.mjs';
import {nativeEffectsRule} from './native-effects.mjs';
import {imageCaptionRule} from './image-caption-rules.mjs';
import {isTOCPage} from './page-options.mjs';
export const rebuildHeadingBodyRule='各段正文与各分点须按内容树分别重建为独立的原生文字对象，同级观点优先并列，不得将多个正文节点或多段文字拼入一个文本框；真实层级仍保持。小标题与其下正文必须是两个独立的原生文字对象，分别保留各自nodeId、位置、字号、字重与对齐；从属或同组只表示内容关系，不得把小标题拼到正文开头、合成同一段文本或放入同一文本框。视觉检查须核对这一点；可以放在同一承载色块内，但文字对象仍分别独立。'+imageCaptionRule+'重建时保持预览中已确定的图片标题或图注及其上下位置，作为独立可编辑文字保留；图片标题与分组小标题在字号、字重或承载上可区分，不补另一种说明。';
export const rebuildAppearanceRule=curvedArrowRule+directionalGeometryRule+nativeEffectsRule+'重建检查须对照实际字体、字号与字重、文字原本有无可见文本框、文本框形状、底图未包含的新增色块以及复杂视觉元素；不能仅按文案齐全判通过。文字与简单色块的渐变核对原生gradient色标、方向与透明度，保留可编辑填充，不简化为纯色或图片。目录页标号和小标题前的数字必须是独立的原生文字对象，与对应标题文字分离，不放在同一文本框或同一段文本中。'+rebuildHeadingBodyRule;
export const rebuildNumberRule='先扫遍预览并输出numberInventory数字清点表，再输出elements，逐项核对清点表中的数字是否有对应独立文字；不能只从已拆出的元素倒抄清点表。数字须单独清点：检查目录序号、步骤编号、色块内及圆形徽章内数字，不把数字误当图形纹理而跳过，数字与承载分别重建。带编号的小标题或目录项，准确文案中的编号与标题拆成两个text对象：保留同一nodeId，分别part:"number"和part:"label"，text分别复制编号（含原标点）和标题；仅忽略两者间的排版空白，其他文字不变。没有正文编号但预览有目录序号时，可另外输出text {nodeId:"toc-number-原节点id",forNodeId:"对应目录项节点id",role:"toc-number",text:"01"}，值与目录顺序一致。非目录页预览额外显示的步骤或分组序号，可用独立text {key:"step-num-1",nodeId:"visual-number-step-num-1",forNodeId:"对应准确内容节点id",role:"visual-number",numberKind:"ordinal",text:"01",sourceBox:{x,y,w,h},x,y,w,h,size}，逐字保留原图前导零或圈号；只限预览确实可见的序号，不用于编造统计量、年份、百分比或其他事实数据。主标题、正文中的年份和数值不按此规则拆分。所有独立数字文字同时列入numberInventory:[{key,text}]，复核每个位置，不因素材复用减少数字实例。';
export function splitHeadingNumber(text){
  const m=String(text).match(/^(\s*\d{1,3}(?:[.．]\d{1,3})*[.．、)）]?)(\s*)(\S[\s\S]*)$/);
  return m&&(m[2]||/[.．、)）]$/.test(m[1]))?{number:m[1].trim(),label:m[3]}:null;
}
const isTOC=(p,index)=>!!p&&isTOCPage(p.slides[index],index,p.brief);
const eligible=(n,p,index)=>n.role==='heading'||isTOC(p,index)&&!['title','subtitle','imageTitle','caption','navigation'].includes(n.role);
export function expectedRebuildText(e,texts,p,index,{requireSeparatedNumbers=true}={}){
  const n=texts.find(n=>n.nodeId===e.nodeId);
  if(n){
    const split=eligible(n,p,index)?splitHeadingNumber(n.text):null;
    if(split){if(!['number','label'].includes(e.part)){if(!requireSeparatedNumbers&&e.part===undefined)return {node:n,text:n.text,part:'whole'};throw Error('目录标号或小标题数字必须与标题拆成独立文字对象（同nodeId，part为number/label）');}return {node:n,text:split[e.part],part:e.part};}
    if(e.part!==undefined)throw Error('此文字不需要编号拆分，不得改变正文数值或主标题');
    return {node:n,text:n.text,part:'whole'};
  }
  if(e.role==='visual-number'&&e.numberKind==='ordinal'&&e.nodeId==='visual-number-'+e.key&&texts.some(n=>n.nodeId===e.forNodeId&&n.role!=='navigation')){
    if(!/^(?:\d{1,3}|[①-⑳])[.．、)）]?$/.test(e.text)||!e.sourceBox)throw Error('预览序号须保留实际数字并登记sourceBox，不能新增事实数据');
    return {node:{nodeId:e.nodeId,text:e.text,role:'visual-number',parentId:e.forNodeId},text:e.text,part:'whole',synthetic:true};
  }
  if(isTOC(p,index)&&e.role==='toc-number'&&e.nodeId==='toc-number-'+e.forNodeId){
    const items=texts.filter(n=>!['title','subtitle','imageTitle','caption','navigation'].includes(n.role)),ordinal=items.findIndex(n=>n.nodeId===e.forNodeId)+1;
    if(ordinal>0&&/^\d{1,3}[.．、)）]?$/.test(e.text)&&Number(e.text.replace(/[.．、)）]/g,''))===ordinal)return {node:{nodeId:e.nodeId,text:e.text,role:'toc-number',parentId:e.forNodeId},text:e.text,part:'whole',synthetic:true};
  }
  throw Error('节点身份无效');
}

export function auditNumberInventory(raw,previous=[]){
  const entries=raw?.numberInventory??[];
  if(!Array.isArray(entries)||entries.length>220)throw Error('数字清点表格式无效');
  const inventory=new Map(previous.map(e=>[e.key,e]));
  for(const e of entries){
    if(!e||typeof e.key!=='string'||typeof e.text!=='string'||!/[\d①-⑳]/.test(e.text))throw Error('数字清点表须登记元素key与原样文字');
    if(inventory.has(e.key)&&inventory.get(e.key).text!==e.text)throw Error('数字清点表不能改写已识别数字：'+e.key);
    inventory.set(e.key,{key:e.key,text:e.text});
  }
  const missing=[...inventory.values()].filter(n=>!raw.elements?.some(e=>e.key===n.key&&e.type==='text'&&e.text===n.text));
  if(missing.length)throw Object.assign(Error('审计遗漏已清点数字：'+missing.map(e=>e.key+'='+e.text).join('、')),{numberInventory:[...inventory.values()]});
  return [...inventory.values()];
}
