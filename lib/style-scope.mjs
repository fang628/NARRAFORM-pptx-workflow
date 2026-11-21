// Presentation styling is independent of the tool's frontend appearance.
export const presentationStylePolicyVersion='workflow-style-scope-v2';
export const presentationStyleScope=`风格作用域：网页前端的工业风、终末地美学、黑白黄、亮黄色、点阵、等高线与电路线阵仅用于工具界面，不构成 PPT 需求，不从界面、示例或旧设计推断用户的 PPT 配色偏好。PPT 依据 pptx-workflow 风格库与规范库，按材料主题、用途和受众选型；只有当前 PPT 需求明确指定的视觉偏好才作为例外。工业题材本身也不等于必须使用工业风。`;
export function presentationDirectionStyle(direction){
  return `${presentationStyleScope}\n本页采用的 PPT 方向：${direction.style}。本方向统一控制核心底色、强调色、字体气质、框形填充描边与装饰语言；单页设计稿仅提供内容、关系、布局与可读性意图，若其旧配色或装饰描述冲突，以本方向为准，不混入其他方向的风格。`;
}
