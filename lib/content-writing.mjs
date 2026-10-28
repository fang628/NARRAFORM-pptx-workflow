import {parallelContentRule,contentNodeMeaningRule,initialElements} from './elements.mjs';
import {contentEmphasisRule} from './content-planning-policy.mjs';
export {contentEmphasisRule} from './content-planning-policy.mjs';
export const contentTextLimits=Object.freeze({page:300,body:50,title:28,subtitle:40,heading:20,imageTitle:28,caption:35,tableCell:50});
export const contentDensityRule='02上屏文字预算：正文每个独立文本项最多50字，不把多个段落塞进同一个字段；每页通常180–260字、最多300字，不设凑字数下限。统计主副标题、小标题、正文、图片标题或图注及表格全部单元格，不重复统计兼容body，不含内部标签、导航与讲稿notes。超量先去重复、套话和过细解释，改为准确短语，必要时在用户要求的总页数内重新分配内容；保留关键结论、独立分点、数据、单位、条件和来源，不机械截字、不拆断术语公式、不靠缩小字号塞字。辅助解释可以放入notes，但必要上屏信息不得仅藏在讲稿。图片多不直接减少分点，表格也不能成为塞入长文的规避方式。用户要求完整保留的原文、引文或必要公式优先，无法精简时保留内容并在02提示，而不在后续阶段阻断。';
// These instructions apply when writing content, never when rendering confirmed text.
export const contentWritingRules=contentEmphasisRule+'\n'+contentDensityRule+'\n'+'上屏文案写法：信息完整优先于可读性，不能因图片数量或占地删减信息与分点。未采用表格的各段、各分点使用独立文字节点，同级观点优先并列，避免把多段正文集中到同一文本框；真实附属说明保持归属。关键结论必须用一句完整的话说明，可由本页结论型标题、一个正文项或表格中的准确结论承载，不重复写两遍；封面、目录等没有结论的页面不强加结论，不补造材料未支持的判断。其余语段可用短语、短分点，不要求完整句子。数据优先写成“指标/条件 + 数值 + 单位 + 对照或变化”的紧凑标签，例如“转化率 32%（对照 20%）”，不把每个数据写成完整叙述句；只有共同维度对照比短分点更清楚时才组织表格，单项数据与少量结论不强制制表；示例数值仅说明格式，不得当作任务事实。每个字段只承担一个信息单元：小标题建议6–16字，正文项建议15–40字、最多50字，图注建议10–35字；主标题不超过28字，副标题不超过40字，关键结论也要简洁。长项仅去掉不承载信息的赘述，并将不同论据、条件、对照或补充解释拆成具有真实归属关系的独立短项；小标题与正文分开，不切断公式、术语、数值与单位，不遗漏必要限定或来源，每个拆出的材料文本项绑定对应sourceLinks。生成后逐字段自查长度、整页总字数、结论句与数据表达，再交付内容树；用户明确保留的原文、必须完整保留的引用优先。讲稿notes不受上屏短字段建议限制。'+parallelContentRule+contentNodeMeaningRule;

const visibleLength=value=>Array.from(String(value||'').replace(/\s/g,'')).length;
export function pageContentDensity(slide){
  const nodes=initialElements(slide),longFields=longContentFields(nodes);
  const characters=nodes.reduce((sum,n)=>sum+(n.type==='text'?visibleLength(n.text):n.type==='group'?visibleLength(n.label):n.type==='table'?[...(n.headers||[]),...(n.rows||[]).flat()].reduce((total,cell)=>total+visibleLength(cell),0):0),0);
  return {characters,maxCharacters:contentTextLimits.page,longFields,score:Math.max(0,characters-contentTextLimits.page)+longFields.reduce((sum,f)=>sum+f.length-f.recommendedMax,0)};
}

export function longContentFields(nodes){
  return nodes.flatMap(node=>{
    const role=node.type==='group'?'heading':node.role||'body';
    const fields=node.type==='table'?[...(node.headers||[]).map((text,i)=>({id:node.id+':header:'+i,text})),...(node.rows||[]).flatMap((row,r)=>row.map((text,c)=>({id:node.id+':'+r+':'+c,text})))].map(f=>({...f,role:'tableCell'})):[{id:node.id,text:node.type==='group'?node.label:node.type==='text'?node.text:'',role}];
    return fields.flatMap(f=>{const limit=contentTextLimits[f.role]||contentTextLimits.body,length=visibleLength(f.text);return length>limit?[{id:f.id,role:f.role,length,recommendedMax:limit}]:[];});
  });
}
