import {frameInventoryRule} from './frame-inventory.mjs';
import {curvedArrowRule} from './curved-arrows.mjs';
import {directionalGeometryRule} from './directional-geometry.mjs';
import {nativeEffectsRule} from './native-effects.mjs';
import {imageCaptionRule} from './image-caption-rules.mjs';
import {isTOCPage} from './page-options.mjs';
import {originalPage} from './ppt-visual-optimization.mjs';
import {tableTypographyRule} from './table-typography.mjs';
export const inlineRebuildRule='内容文字中的轻量上下标标记 <sup>…</sup>、<sub>…</sub> 必须原样保留在对应原生文字对象中：逐字保留标记与标记内文字，不删除标记、不改写成普通字符、不新增或合并上下标；Unicode 上下标字符（如 m²、H₂O）保持原字符不增删。'+tableTypographyRule;
export const rebuildHeadingBodyRule='各段正文与各分点须按内容树分别重建为独立的原生文字对象，同级观点优先并列，不得将多个正文节点或多段文字拼入一个文本框；真实层级仍保持。小标题与其下正文必须是两个独立的原生文字对象，分别保留各自nodeId、位置、字号、字重与对齐；正文原文以“标签：正文”开头且预览分框时，可保留同nodeId的part:"label"与part:"body"，两段须完整逐字覆盖原文，不合成同一文本框。从属或同组只表示内容关系；可以放在同一承载色块内，文字对象仍分别独立。'+imageCaptionRule+'重建时保持预览中已确定的图片标题或图注及其上下位置，作为独立可编辑文字保留；图片标题与分组小标题在字号、字重或承载上可区分，不补另一种说明。'+inlineRebuildRule;
export const rebuildAppearanceRule=frameInventoryRule+curvedArrowRule+directionalGeometryRule+nativeEffectsRule+'拆解与实际渲染检查逐条对照线宽、描边、透明度与渐变色标；1920×1080测量值除以1.2换成逻辑单位。原生色块和箭头禁止glow；实际阴影用shadow且与描边互斥；线条不带光影，光条用SVG。箭形和六边形核对尖端、凹口与顶点，不用平行四边形代替。检查字体、字号、字重、承载框形、底图未含色块及复杂视觉，不仅按文案齐全判通过。普通原生图形渐变保留实际方向；主标题和副标题按文字政策。目录标号及小标题前数字使用独立原生文字。'+rebuildHeadingBodyRule;
export const rebuildNumberRule='先扫遍预览并输出numberInventory数字清点表，再输出elements，逐项核对清点表中的数字是否有对应独立文字；不能只从已拆出的元素倒抄清点表。数字须单独清点：检查目录序号、步骤编号、色块内及圆形徽章内数字，不把数字误当图形纹理而跳过，数字与承载分别重建。带编号的小标题或目录项，准确文案中的编号与标题拆成两个text对象：保留同一nodeId，分别part:"number"和part:"label"，text分别复制编号（含原标点）和标题；仅忽略两者间的排版空白，其他文字不变。没有正文编号但预览有目录序号时，可另外输出text {nodeId:"toc-number-原节点id",forNodeId:"对应目录项节点id",role:"toc-number",text:"01"}，值与目录顺序一致。非目录页预览额外显示的步骤或分组序号，可用独立text {key:"step-num-1",nodeId:"visual-number-step-num-1",forNodeId:"对应准确内容节点id",role:"visual-number",numberKind:"ordinal",text:"01",sourceBox:{x,y,w,h},x,y,w,h,size}，逐字保留原图前导零或圈号；只限预览确实可见的序号，不用于编造统计量、年份、百分比或其他事实数据。主标题、正文中的年份和数值不按此规则拆分。表格单元格中的编号名称（如“1. 需求与材料”）可整格保留，也可用同nodeId的number/label分别还原；两种形式都必须逐字保留，不能将小数、年份、百分比或计量值按序号拆开。所有独立数字文字同时列入numberInventory:[{key,text}]，复核每个位置，不因素材复用减少数字实例。';
export function splitHeadingNumber(text){
  const m=String(text).match(/^(\s*\d{1,3}(?:[.．]\d{1,3})*[.．、)）]?)(\s*)(\S[\s\S]*)$/);
  return m&&(m[2]||/[.．、)）]$/.test(m[1]))?{number:m[1].trim(),label:m[3]}:null;
}
const isTOC=(p,index)=>!!p&&isTOCPage(p.slides[index],index,p.brief);
const eligible=(n,p,index)=>n.role==='heading'||isTOC(p,index)&&!['title','subtitle','imageTitle','caption','navigation'].includes(n.role);
export function tableOrdinalParts(n){
  if(n?.role!=='table-cell')return null;
  const split=splitHeadingNumber(n.text);
  // A table's numbered label may be split or kept in one editable cell. Decimal
  // measurements, years, percentages and bare numbers are never ordinal labels.
  return split&&/^\d{1,3}[.．、)）]?$/.test(split.number)&&/^[^\d\s.%％]/.test(split.label)?split:null;
}
export function bodyLabelParts(node){
  if(node?.role!=='body')return null;
  const match=String(node.text).match(/^([^\n：:]{1,32}[：:])([\s\S]+)$/);
  return match?{label:match[1],body:match[2]}:null;
}
export function expectedRebuildText(e,texts,p,index,{requireSeparatedNumbers=true}={}){
  const n=texts.find(n=>n.nodeId===e.nodeId);
  if(n){
    if(p&&originalPage(p,index)){
      if(e.part!==undefined)throw Error('原稿视觉优化须保留原文本框，不能将同一原框的编号与标题重新拆分');
      return {node:n,text:n.text,part:'whole'};
    }
    const paragraph=e.part!==undefined?bodyLabelParts(n):null;
    if(paragraph&&['label','body'].includes(e.part))return {node:{...n,role:e.part==='label'?'heading':'body'},text:paragraph[e.part],part:e.part};
    const optional=tableOrdinalParts(n),split=eligible(n,p,index)?splitHeadingNumber(n.text):e.part!==undefined?optional:null;
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
export const rebuildNumbersFor=(p,index)=>p&&originalPage(p,index)?'沿用原稿独立文本框：原稿同框的编号与标题保持同框，不重新拆分；原稿已有独立数字框仍逐个清点并原生重建，保留每次出现的位置与数量。':rebuildNumberRule+'numberInventory只登记独立编号文字；正文句内的数量、时长、年份、型号等仍在所属完整文字对象中，不另建数字对象，不登记为缺失的独立编号。';

export function auditNumberInventory(raw,previous=[],{texts=[]}={}){
  const entries=raw?.numberInventory??[];
  if(!Array.isArray(entries)||entries.length>220)throw Error('数字清点表格式无效');
  const inventory=new Map(previous.map(e=>[e.key,e]));
  for(const e of entries){
    if(!e||typeof e.key!=='string'||typeof e.text!=='string'||!/[\d①-⑳]/.test(e.text))throw Error('数字清点表须登记元素key与原样文字');
    if(inventory.has(e.key)&&inventory.get(e.key).text!==e.text)throw Error('数字清点表不能改写已识别数字：'+e.key);
    const element=raw.elements?.find(n=>n.key===e.key&&n.type==='text'&&n.part==='number'&&n.text===e.text),node=texts.find(n=>n.nodeId===element?.nodeId),split=tableOrdinalParts(node);
    // A model may also count factual values already present in a complete body
    // node. They are not ordinal labels and must not force a duplicate text box.
    // Require a declared owner (or the model's explicit num-<nodeId>-<value> key),
    // rather than accepting an identical digit found elsewhere on the slide.
    const inline=texts.find(n=>n.role==='body'&&(e.nodeId===n.nodeId||e.key===`num-${n.nodeId}-${e.text}`)&&
      /^\d+(?:[.,]\d+)?$/.test(e.text)&&String(n.text).split(/[^\dA-Za-z.,]+/).includes(e.text));
    inventory.set(e.key,{key:e.key,text:e.text,...(inline?{nodeId:inline.nodeId,inline:true}:split?.number===e.text?{nodeId:node.nodeId}:inventory.get(e.key)?.nodeId?{nodeId:inventory.get(e.key).nodeId,...(inventory.get(e.key).inline?{inline:true}:{})}:{})});
  }
  const missing=[...inventory.values()].filter(n=>!raw.elements?.some(e=>e.key===n.key&&e.type==='text'&&e.text===n.text)&&!raw.elements?.some(e=>{
    const node=texts.find(t=>t.nodeId===n.nodeId),split=tableOrdinalParts(node);
    return (split?.number===n.text||n.inline&&node?.role==='body'&&String(node.text).split(/[^\dA-Za-z.,]+/).includes(n.text))&&e.type==='text'&&e.nodeId===node?.nodeId&&e.part===undefined&&e.text===node.text;
  }));
  if(missing.length)throw Object.assign(Error('审计遗漏已清点数字：'+missing.map(e=>e.key+'='+e.text).join('、')),{numberInventory:[...inventory.values()]});
  return [...inventory.values()];
}
