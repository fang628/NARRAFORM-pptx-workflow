import {parallelContentRule,contentNodeMeaningRule} from './elements.mjs';
// These instructions apply when writing content, never when rendering confirmed text.
export const contentEmphasisRule='内容规划默认侧重主题价值、主要成果、优势与解决思路，减少缺点、劣势、不足等消极内容的篇幅；非核心问题不单独扩成整页，不在多页重复渲染或擅自新增批评。必要的局限、风险、适用条件与材料中的关键负面结论简洁、准确保留，不曲解为正面结论；用户明确要求风险分析、优劣比较或问题复盘时，按其要求充分呈现。';
export const contentWritingRules=contentEmphasisRule+'\n'+'上屏文案写法：信息完整优先于可读性，不能因图片数量或占地删减信息与分点。未采用表格的各段、各分点使用独立文字节点，同级观点优先并列，避免把多段正文集中到同一文本框；真实附属说明保持归属。关键结论必须用一句完整的话说明，可由本页结论型标题、一个正文项或表格中的准确结论承载，不重复写两遍；封面、目录等没有结论的页面不强加结论，不补造材料未支持的判断。其余语段可用短语、短分点，不要求完整句子。数据优先写成“指标/条件 + 数值 + 单位 + 对照或变化”的紧凑标签，例如“转化率 32%（对照 20%）”，不把每个数据写成完整叙述句；适合共同维度比较的结论、指标与数据可直接组织为表格，不局限于原有小表；示例数值仅说明格式，不得当作任务事实。每个字段只承担一个信息单元：小标题建议6–16字，正文项建议15–45字、尽量不超过60字，图注建议10–35字；主标题不超过28字，副标题不超过40字，关键结论也要简洁。长度建议服从信息完整，长项仅去掉不承载信息的赘述，并将不同论据、条件、对照或补充解释拆成具有真实归属关系的独立短项；小标题与正文分开，不切断公式、术语、数值与单位，不遗漏必要限定或来源，每个拆出的材料文本项绑定对应sourceLinks。生成后逐字段自查长度、结论句与数据表达，再交付内容树；用户明确保留的原文、必须完整保留的引用优先。讲稿notes不受上屏短字段建议限制。'+parallelContentRule+contentNodeMeaningRule;

export function longContentFields(nodes){
  return nodes.flatMap(node=>{
    const text=node.type==='group'?node.label:node.type==='text'?node.text:'';
    const limit=node.type==='group'?20:node.role==='title'?28:node.role==='subtitle'?40:node.role==='imageTitle'?28:node.role==='caption'?50:60;
    const length=Array.from(String(text||'').trim()).length;
    return length>limit?[{id:node.id,role:node.type==='group'?'heading':node.role||'body',length,recommendedMax:limit}]:[];
  });
}
