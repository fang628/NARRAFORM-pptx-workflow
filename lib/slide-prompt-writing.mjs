import {visualTreatmentText} from './visual-treatment.mjs';
import {nestedPromptStructureRule,slidePromptConcisenessRule} from './prompt-structure.mjs';
import {placeholderAspectRewriteRule} from './image-placeholder-rules.mjs';
import {promptColorRule} from './prompt-colors.mjs';
import {creativePromptWritingRule} from './layout-guidance.mjs';

export function rewriteSlidePromptRequest(p,prompt,instruction){
  return `按用户要求修改以下整页生图提示词，返回一份可独立使用的完整稿。沿用七项Markdown顶层列表：比例、内容、排版、底图与配图/图片占位框比例、风格、进度条、视觉关系。
${nestedPromptStructureRule}
${slidePromptConcisenessRule}
${placeholderAspectRewriteRule}
${creativePromptWritingRule}
${promptColorRule}
当前表现：${visualTreatmentText(p.visualTreatment)||'沿用原稿'}。保持所选预设的字体、效果与框形语言，当前表现类型及用户明确要求优先。随附底图保持颜色、结构、装饰与排布，不再描述底图布局或列举装饰目录。
文案、公式、表格、图片身份与页顶导航原样保留；只改用户指定部分，保留其余有效设计。不写内部编号、精确文字坐标、字号或验收条文。排版项保留原有通用表述，仅合并重复指令；用户未要求时，不压缩改写，也不追加逐组方位。具体创意集中在风格项，不扩写口号。不设置凑字数的下限，完整科学内容及必要设计可合理加长。输出 {prompt:"完整新提示词"}。
用户要求：${instruction}
原提示词：${prompt}`;
}
