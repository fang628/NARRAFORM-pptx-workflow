import {imageCaptionRule} from './image-caption-rules.mjs';
import {isTOCPage} from './page-options.mjs';
export const rebuildHeadingBodyRule='小标题与其下正文必须是两个独立的原生文字对象，分别保留各自nodeId、位置、字号、字重与对齐；从属或同组只表示内容关系，不得把小标题拼到正文开头、合成同一段文本或放入同一文本框。视觉检查须核对这一点；可以放在同一承载色块内，但文字对象仍分别独立。'+imageCaptionRule+'重建时保持预览中已确定的图注上下位置，作为独立可编辑文字保留。';
export const rebuildAppearanceRule='重建检查须对照实际字体、字号与字重、文字原本有无可见文本框、文本框形状、底图未包含的新增色块以及复杂视觉元素；不能仅按文案齐全判通过。目录页标号和小标题前的数字必须是独立的原生文字对象，与对应标题文字分离，不放在同一文本框或同一段文本中。'+rebuildHeadingBodyRule;
export const rebuildNumberRule='带编号的小标题或目录项，准确文案中的编号与标题拆成两个text对象：保留同一nodeId，分别part:"number"和part:"label"，text分别复制编号（含原标点）和标题；仅忽略两者间的排版空白，其他文字不变。没有正文编号但预览有目录序号时，可另外输出text {nodeId:"toc-number-原节点id",forNodeId:"对应目录项节点id",role:"toc-number",text:"01"}，值与目录顺序一致。主标题、正文中的年份和数值不按此规则拆分。';
export function splitHeadingNumber(text){
  const m=String(text).match(/^(\s*\d{1,3}(?:[.．]\d{1,3})*[.．、)）]?)(\s*)(\S[\s\S]*)$/);
  return m&&(m[2]||/[.．、)）]$/.test(m[1]))?{number:m[1].trim(),label:m[3]}:null;
}
const isTOC=(p,index)=>!!p&&isTOCPage(p.slides[index],index,p.brief);
const eligible=(n,p,index)=>n.role==='heading'||isTOC(p,index)&&!['title','subtitle','caption','navigation'].includes(n.role);
export function expectedRebuildText(e,texts,p,index,{requireSeparatedNumbers=true}={}){
  const n=texts.find(n=>n.nodeId===e.nodeId);
  if(n){
    const split=eligible(n,p,index)?splitHeadingNumber(n.text):null;
    if(split){if(!['number','label'].includes(e.part)){if(!requireSeparatedNumbers&&e.part===undefined)return {node:n,text:n.text,part:'whole'};throw Error('目录标号或小标题数字必须与标题拆成独立文字对象（同nodeId，part为number/label）');}return {node:n,text:split[e.part],part:e.part};}
    if(e.part!==undefined)throw Error('此文字不需要编号拆分，不得改变正文数值或主标题');
    return {node:n,text:n.text,part:'whole'};
  }
  if(isTOC(p,index)&&e.role==='toc-number'&&e.nodeId==='toc-number-'+e.forNodeId){
    const items=texts.filter(n=>!['title','subtitle','caption','navigation'].includes(n.role)),ordinal=items.findIndex(n=>n.nodeId===e.forNodeId)+1;
    if(ordinal>0&&/^\d{1,3}[.．、)）]?$/.test(e.text)&&Number(e.text.replace(/[.．、)）]/g,''))===ordinal)return {node:{nodeId:e.nodeId,text:e.text,role:'toc-number',parentId:e.forNodeId},text:e.text,part:'whole',synthetic:true};
  }
  throw Error('节点身份无效');
}
