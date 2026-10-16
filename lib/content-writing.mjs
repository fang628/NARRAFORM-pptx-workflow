// These instructions apply when writing content, never when rendering confirmed text.
export const contentWritingRules='上屏文案写法：关键结论必须用一句完整的话说明，优先由本页结论型标题或一个正文项承载，不重复写两遍；封面、目录等没有结论的页面不强加结论，不补造材料未支持的判断。其余语段可用短语、短分点，不要求完整句子。数据优先写成“指标/条件 + 数值 + 单位 + 对照或变化”的紧凑标签，例如“转化率 32%（对照 20%）”，不把每个数据写成完整叙述句；示例数值仅说明格式，不得当作任务事实。每个字段只承担一个信息单元：小标题建议6–16字，正文项建议15–45字、尽量不超过60字，图注建议10–35字；主标题不超过28字，副标题不超过40字，关键结论也要简洁。长项在内容生成时去掉赘述，并将论据、条件、对照或补充解释拆成具有真实归属关系的短子项；小标题与正文分开，不切断公式、术语、数值与单位，不遗漏必要限定或来源，每个拆出的材料文本项绑定对应sourceLinks。生成后逐字段自查长度、结论句与数据表达，再交付内容树；用户明确保留的原文、必须完整保留的引用优先。讲稿notes不受上屏短字段建议限制。';

export function longContentFields(nodes){
  return nodes.flatMap(node=>{
    const text=node.type==='group'?node.label:node.type==='text'?node.text:'';
    const limit=node.type==='group'?20:node.role==='title'?28:node.role==='subtitle'?40:node.role==='caption'?50:60;
    const length=Array.from(String(text||'').trim()).length;
    return length>limit?[{id:node.id,role:node.type==='group'?'heading':node.role||'body',length,recommendedMax:limit}]:[];
  });
}
