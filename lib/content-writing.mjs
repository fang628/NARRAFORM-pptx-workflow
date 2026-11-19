import {plainInlineText} from '../public/inline-text.js';
import {parallelContentRule,initialElements} from './elements.mjs';
import {contentEmphasisRule,pageExpressionRule} from './content-planning-policy.mjs';
import {contentPhrasingRule,phrasingIssues} from './content-phrasing.mjs';
import {topicCopyRule,naturalCopyRule} from './content-copy-policy.mjs';
export {contentEmphasisRule} from './content-planning-policy.mjs';
export {contentPhrasingRule,isNarrativeSentence,phrasingIssues} from './content-phrasing.mjs';
export const contentTextLimits=Object.freeze({page:300,body:50,title:28,subtitle:40,heading:20,imageTitle:28,caption:35,tableCell:50});
export const contentDensityRule='02上屏文字预算：正文每个独立文本项最多50字，不把多个段落塞进同一个字段；每页最多300字，只设上限，不设目标区间或凑字数下限，所需信息说清即可停止。统计主副标题、小标题、正文、图片标题或图注及表格全部单元格，不重复统计兼容body，不含内部标签、导航与讲稿notes。超量先去重复、套话和过细解释，改为准确短语，必要时在用户要求的总页数内重新分配内容；保留关键结论、独立分点、数据、单位、条件和来源，不机械截字、不拆断术语公式、不靠缩小字号塞字。辅助解释可以放入notes，但必要上屏信息不得仅藏在讲稿。图片多不直接减少分点，表格也不能成为塞入长文的规避方式。用户要求完整保留的原文、引文或必要公式优先，无法精简时保留内容并在02提示，而不在后续阶段阻断。';
// These instructions apply when writing content, never when rendering confirmed text.
export const contentWritingRules=[pageExpressionRule,contentEmphasisRule,topicCopyRule,naturalCopyRule,contentDensityRule,contentPhrasingRule,
  '上屏文案写法：完整保留本页选用事实的必要信息，不等于复述整份材料；用简洁表达保证准确，不因图片数量或占地删减必要信息与分点。未采用表格的各段、各分点使用独立文字节点，同级观点优先并列，真实附属说明保持归属。本页确需呈现关键结论时，用一句完整准确的话说明，可由结论型标题、正文项或表格承载，不重复写两遍；概念、流程、比较及功能页不强加结论。其余语段可用短语、短分点，不要求完整句子。数据用“指标/条件 + 数值 + 单位 + 对照或变化”的紧凑标签，例如“转化率 32%（对照 20%）”，不把每个数据写成完整叙述句；示例仅说明格式，不得当作任务事实。只有共同维度对照比短分点更清楚时才制表，单项数据与少量结论不强制制表。每个字段只承担一个信息单元，小标题、正文项和图注只写所需长度，不补齐建议字数；正文最多50字，副标题最多40字。小标题仅在确有分组时建立，不能将正文换词再作小标题。长项先去赘述，不切断术语、公式、数值与单位，不遗漏必要限定或来源；不同独立信息用有真实归属的短项承载，各项绑定sourceLinks。用户明确保留的原文和引用优先。讲稿notes不受上屏短字段建议限制。',parallelContentRule].join('\n');

const visibleLength=value=>Array.from(plainInlineText(value).replace(/\s/g,'')).length;
export function pageContentDensity(slide){
  const nodes=initialElements(slide),longFields=longContentFields(nodes),phrasing=phrasingIssues(slide);
  const characters=nodes.reduce((sum,n)=>sum+(n.type==='formula'?Math.min(60,visibleLength(n.latex)):n.type==='text'?visibleLength(n.text):n.type==='group'?visibleLength(n.label):n.type==='table'?[...(n.headers||[]),...(n.rows||[]).flat()].reduce((total,cell)=>total+visibleLength(cell),0):0),0);
  return {characters,maxCharacters:contentTextLimits.page,longFields,phrasing,score:Math.max(0,characters-contentTextLimits.page)+longFields.reduce((sum,f)=>sum+f.length-f.recommendedMax,0)};
}

export function longContentFields(nodes){
  return nodes.flatMap(node=>{
    const role=node.type==='group'?'heading':node.role||'body';
    const fields=node.type==='table'?[...(node.headers||[]).map((text,i)=>({id:node.id+':header:'+i,text})),...(node.rows||[]).flatMap((row,r)=>row.map((text,c)=>({id:node.id+':'+r+':'+c,text})))].map(f=>({...f,role:'tableCell'})):[{id:node.id,text:node.type==='group'?node.label:node.type==='text'?node.text:'',role}];
    return fields.flatMap(f=>{const limit=contentTextLimits[f.role]||contentTextLimits.body,length=visibleLength(f.text);return length>limit?[{id:f.id,role:f.role,length,recommendedMax:limit}]:[];});
  });
}
